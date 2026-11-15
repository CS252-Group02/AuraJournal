import asyncio
import json
from types import SimpleNamespace

import pytest
from sqlalchemy.exc import SQLAlchemyError

from app.routers import transcriptions
from app.services import DeepgramTimeoutError
from test_transcriptions_api import ORIGIN, PATH, WEBM_HEADER, setup, start  # noqa: F401 - shared fixture


def terminal(ws, code, close_code=1008):
    event = ws.receive_json()
    assert event["type"] == "error" and event["code"] == code
    assert set(event) == {"type", "session_id", "code", "message"}
    assert "private" not in json.dumps(event)
    assert ws.receive() == {"type": "websocket.close", "code": close_code, "reason": ""}


@pytest.mark.parametrize("kind", ["broken", "array", "nested", "duplicate", "nonfinite", "wrong_type", "oversized"])
def test_bad_control_json_has_one_safe_error_before_provider_access(setup, kind):
    client, _, connector, _, _ = setup
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        ready = ws.receive_json()
        data = {"type": "start", "session_id": ready["session_id"],
                "mime_type": "audio/webm;codecs=opus", "language": "multi"}
        payload = json.dumps(data)
        if kind == "broken":
            payload = "{private"
        elif kind == "array":
            payload = "[]"
        elif kind == "nested":
            payload = "[" * 1100 + "0" + "]" * 1100
        elif kind == "duplicate":
            payload = payload.replace('"type": "start"', '"type":"finish","type":"start"')
        elif kind == "nonfinite":
            payload = json.dumps(data | {"language": float("nan")})
        elif kind == "wrong_type":
            payload = json.dumps(data | {"language": ["multi"]})
        else:
            payload = json.dumps(data | {"language": "😀" * 1025}, ensure_ascii=False)
        ws.send_text(payload)
        terminal(ws, "limit_exceeded" if kind == "oversized" else "invalid_request")
    assert not connector.calls


@pytest.mark.parametrize("chunks", [[], [b""], [b"RIFFprivate"], [WEBM_HEADER[:2]], [WEBM_HEADER, b""]])
def test_empty_wrong_or_incomplete_audio_is_not_forwarded_as_valid_audio(setup, chunks):
    client, provider, _, _, _ = setup
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        ready = ws.receive_json()
        start(ws, ready)
        assert ws.receive_json()["type"] == "started"
        for chunk in chunks:
            ws.send_bytes(chunk)
        if not chunks or chunks == [WEBM_HEADER[:2]]:
            ws.send_json({"type": "finish", "session_id": ready["session_id"]})
        terminal(ws, "invalid_audio")
    assert provider.sent == ([WEBM_HEADER] if chunks == [WEBM_HEADER, b""] else [])
    assert provider.close_calls == 1


def test_split_header_preserves_all_original_chunks_at_total_size_boundary(setup, monkeypatch):
    client, provider, _, _, _ = setup
    chunks = [WEBM_HEADER[:1], WEBM_HEADER[1:2], WEBM_HEADER[2:] + b"body", b"tail"]
    monkeypatch.setattr(transcriptions, "MAX_AUDIO_BYTES", sum(map(len, chunks)))
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        ready = ws.receive_json()
        start(ws, ready)
        assert ws.receive_json()["type"] == "started"
        for chunk in chunks:
            ws.send_bytes(chunk)
        ws.send_json({"type": "finish", "session_id": ready["session_id"]})
        assert ws.receive_json()["type"] == "segment"
        assert ws.receive_json()["type"] == "complete"
    assert provider.sent == chunks + [json.dumps({"type": "CloseStream"})]


@pytest.mark.parametrize("limit", ["total", "messages"])
def test_excess_audio_or_tiny_message_flood_closes_and_releases_provider(setup, monkeypatch, limit):
    client, provider, _, _, _ = setup
    if limit == "total":
        monkeypatch.setattr(transcriptions, "MAX_AUDIO_BYTES", len(WEBM_HEADER))
    else:
        monkeypatch.setattr(transcriptions, "MAX_MESSAGES_PER_SECOND", 1)
        monkeypatch.setattr(transcriptions, "monotonic", lambda: 0)
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        start(ws, ws.receive_json())
        assert ws.receive_json()["type"] == "started"
        ws.send_bytes(WEBM_HEADER)
        ws.send_bytes(b"x")
        terminal(ws, "limit_exceeded")
    assert provider.sent == [WEBM_HEADER] and provider.close_calls == 1


@pytest.mark.parametrize("phase", ["before_start", "duplicate_start", "after_finish"])
def test_messages_in_wrong_protocol_phase_never_complete(setup, phase):
    client, provider, connector, _, _ = setup
    provider.final_events = []
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        ready = ws.receive_json()
        if phase == "before_start":
            ws.send_bytes(WEBM_HEADER)
        else:
            start(ws, ready)
            assert ws.receive_json()["type"] == "started"
            if phase == "duplicate_start":
                start(ws, ready)
            else:
                ws.send_bytes(WEBM_HEADER)
                ws.send_json({"type": "finish", "session_id": ready["session_id"]})
                ws.send_bytes(b"private late audio")
        terminal(ws, "invalid_request")
    assert len(connector.calls) == (0 if phase == "before_start" else 1)
    assert provider.close_calls == (0 if phase == "before_start" else 1)


@pytest.mark.parametrize("phase,code", [("start", "timeout"), ("recording", "limit_exceeded")])
def test_start_and_recording_deadlines_are_bounded(setup, monkeypatch, phase, code):
    client, provider, connector, _, _ = setup
    monkeypatch.setattr(transcriptions, "START_TIMEOUT" if phase == "start" else "MAX_RECORDING_SECONDS", 0.02)
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        ready = ws.receive_json()
        if phase == "recording":
            start(ws, ready)
            assert ws.receive_json()["type"] == "started"
        terminal(ws, code, 1011 if phase == "start" else 1008)
    assert len(connector.calls) == provider.close_calls == (0 if phase == "start" else 1)


def test_database_failure_returns_no_internal_details_or_provider_call(setup):
    client, _, connector, _, _ = setup
    def unavailable():
        raise SQLAlchemyError("private database credentials")
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        ready = ws.receive_json()
        client.app.state.session_factory = unavailable
        start(ws, ready)
        terminal(ws, "database_unavailable", 1011)
    assert not connector.calls


def test_slow_browser_response_is_cancelled_at_deadline(monkeypatch):
    closed = []
    async def stalled(event):
        try:
            await asyncio.Event().wait()
        finally:
            closed.append(True)
    monkeypatch.setattr(transcriptions, "SEND_TIMEOUT", 0.01)
    with pytest.raises(DeepgramTimeoutError):
        asyncio.run(transcriptions._send(SimpleNamespace(send_json=stalled), {"type": "segment"}))
    assert closed == [True]
