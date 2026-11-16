import asyncio
from contextlib import contextmanager
from datetime import timedelta
import json
from threading import Event
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from starlette.websockets import WebSocketDisconnect

from app.auth import COOKIE_NAME, digest, utcnow
from app.main import create_app
from app.models import AuthSession, User
from app.services import DeepgramStreamingClient
from app.routers import transcriptions
from test_deepgram_service import FakeConnector, FakeSocket
from test_transcription import result

PATH = "/api/transcriptions/live"
ORIGIN = {"Origin": "http://localhost:5173"}
WEBM_HEADER = b"\x1a\x45\xdf\xa3"


@pytest.fixture
def setup():
    app = create_app()
    user = User(id=uuid4(), email="transcription@example.test", password_hash="enabled")
    record = AuthSession(token_hash=digest("test-cookie"), user_id=user.id,
                         expires_at=utcnow() + timedelta(hours=1))
    rows = {AuthSession: record, User: user}
    active_sessions = []

    @contextmanager
    def sessions():
        class Session:
            def get(self, model, key):
                value = rows.get(model)
                expected = record.token_hash if model is AuthSession else user.id
                return value if key == expected else None

        active_sessions.append(True)
        try:
            yield Session()
        finally:
            active_sessions.pop()

    provider = FakeSocket(final_events=[result("Hôm nay.", final=True), {"type": "Metadata"}])
    connector = FakeConnector(provider)
    app.state.session_factory = sessions
    app.state.deepgram_streaming_client = DeepgramStreamingClient("key", connector=connector)
    with TestClient(app) as client:
        client.cookies.set(COOKIE_NAME, "test-cookie")
        yield client, provider, connector, rows, active_sessions


def start(ws, ready, **changes):
    message = {"type": "start", "session_id": ready["session_id"],
               "mime_type": "audio/webm;codecs=opus", "language": "multi"}
    ws.send_json(message | changes)


@pytest.mark.parametrize("language", ["multi", "vi"])
def test_cookie_authenticated_stream_negotiates_and_returns_final_transcript(setup, language):
    client, provider, connector, _, sessions = setup
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        ready = ws.receive_json()
        assert ready["type"] == "ready" and ready["accepted_mime_types"] == ["audio/webm;codecs=opus"]
        assert not connector.calls  # Microphone permission/start does not yet incur a provider call.
        start(ws, ready, language=language)
        assert ws.receive_json() == {"type": "started", "session_id": ready["session_id"]}
        assert not sessions  # No database connection is held while recording.
        ws.send_bytes(WEBM_HEADER)
        ws.send_bytes(b"last audio")
        ws.send_json({"type": "finish", "session_id": ready["session_id"]})
        final, complete = ws.receive_json(), ws.receive_json()
        assert final["text"] == "Hôm nay." and final["is_final"] is True
        assert complete == {"type": "complete", "session_id": ready["session_id"],
                            "final_count": 1, "outcome": "transcribed"}
    assert provider.sent == [WEBM_HEADER, b"last audio", json.dumps({"type": "CloseStream"})]
    assert provider.close_calls == 1 and len(connector.calls) == 1


def test_live_interims_replace_one_segment_before_the_final_flush(setup):
    client, provider, _, _, _ = setup
    original_send = provider.send

    async def send(message):
        await original_send(message)
        if message == WEBM_HEADER:
            for event in [result("Hôm", end=1), result("Hôm nay", end=2)]:
                provider.incoming.put_nowait(json.dumps(event))

    provider.send = send
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        ready = ws.receive_json()
        start(ws, ready)
        assert ws.receive_json()["type"] == "started"
        ws.send_bytes(WEBM_HEADER)
        first, second = ws.receive_json(), ws.receive_json()
        ws.send_bytes(b"tail")
        ws.send_json({"type": "finish", "session_id": ready["session_id"]})
        final, complete = ws.receive_json(), ws.receive_json()
        assert [event["text"] for event in (first, second, final)] == ["Hôm", "Hôm nay", "Hôm nay."]
        assert [event["revision"] for event in (first, second, final)] == [0, 1, 2]
        assert [event["is_final"] for event in (first, second, final)] == [False, False, True]
        for event in (first, second, final):
            assert event["session_id"] == ready["session_id"]
            assert event["segment_id"] == "segment-1" and event["order"] == 0
        assert complete == {"type": "complete", "session_id": ready["session_id"],
                            "final_count": 1, "outcome": "transcribed"}
    assert provider.sent == [WEBM_HEADER, b"tail", json.dumps({"type": "CloseStream"})]
    assert provider.close_calls == 1


@pytest.mark.parametrize("kind", ["silence", "retracted", "incomplete"])
def test_route_completion_distinguishes_silence_retractions_and_unconfirmed_text(setup, kind):
    client, provider, _, _, _ = setup
    if kind == "silence":
        provider.final_events = [result("", final=True), {"type": "Metadata"}]
        count, outcome = 0, "no_speech"
    elif kind == "retracted":
        provider.final_events = [result("A guess"), result("", final=True), {"type": "Metadata"}]
        count, outcome = 0, "no_speech"
    else:
        provider.final_events = [result("Confirmed.", final=True),
                                 result("Unconfirmed tail", start=3, end=5), {"type": "Metadata"}]
        count, outcome = 1, "incomplete"
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        ready = ws.receive_json()
        start(ws, ready)
        assert ws.receive_json()["type"] == "started"
        ws.send_bytes(WEBM_HEADER)
        ws.send_json({"type": "finish", "session_id": ready["session_id"]})
        segments = []
        while (event := ws.receive_json())["type"] == "segment":
            segments.append(event)
        assert event == {"type": "complete", "session_id": ready["session_id"],
                         "final_count": count, "outcome": outcome}
        assert sum(segment["is_final"] for segment in segments) == count
        if kind == "retracted":
            assert [segment["text"] for segment in segments] == ["A guess", ""]
        elif kind == "incomplete":
            assert segments[-1]["text"] == "Unconfirmed tail" and not segments[-1]["is_final"]
        assert ws.receive()["code"] == 1000
    assert provider.close_calls == 1


@pytest.mark.parametrize("failure", ["origin", "missing_cookie", "expired", "disabled", "revoked"])
def test_invalid_origin_or_account_is_rejected_before_provider_access(setup, failure):
    client, _, connector, rows, _ = setup
    headers = ORIGIN.copy()
    if failure == "origin":
        headers = {"Origin": "https://foreign.example"}
    elif failure == "missing_cookie":
        client.cookies.clear()
    elif failure == "expired":
        rows[AuthSession].expires_at = utcnow() - timedelta(seconds=1)
    elif failure == "disabled":
        rows[User].password_hash = "!disabled"
    else:
        rows.pop(AuthSession)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(PATH, headers=headers):
            pytest.fail("Unauthorized socket must not be accepted.")
    assert not connector.calls


@pytest.mark.parametrize("change,code", [({"session_id": "wrong"}, "invalid_request"),
                                       ({"mime_type": "audio/wav"}, "invalid_audio"),
                                       ({"user_id": "spoof"}, "invalid_request")])
def test_invalid_start_returns_safe_error_without_calling_deepgram(setup, change, code):
    client, _, connector, _, _ = setup
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        start(ws, ws.receive_json(), **change)
        error = ws.receive_json()
        assert error["type"] == "error" and error["code"] == code
    assert not connector.calls


def test_provider_failure_and_disconnect_release_connection(setup):
    client, provider, _, _, _ = setup
    provider.incoming.put_nowait(json.dumps({"type": "Error", "code": "DATA-0000", "description": "private"}))
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        start(ws, ws.receive_json())
        assert ws.receive_json()["type"] == "started"
        error = ws.receive_json()
        assert error["code"] == "invalid_audio" and "private" not in json.dumps(error)
    assert provider.close_calls == 1


def test_browser_disconnect_cancels_provider(setup):
    client, provider, _, _, _ = setup
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        start(ws, ws.receive_json())
        assert ws.receive_json()["type"] == "started"
    assert provider.close_calls == 1


def test_session_revocation_during_recording_stops_stream(setup, monkeypatch):
    client, provider, _, rows, _ = setup
    monkeypatch.setattr(transcriptions, "AUTH_RECHECK_SECONDS", 0.01)
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        start(ws, ws.receive_json())
        assert ws.receive_json()["type"] == "started"
        rows.pop(AuthSession)
        assert ws.receive_json()["code"] == "auth_expired"
    assert provider.close_calls == 1


def test_http_json_and_csrf_rules_remain_enforced(setup):
    client, _, _, _, _ = setup
    assert client.post("/api/ai/suggest-title", json={"content": "test"}).status_code == 403
    headers = {"Origin": "http://localhost:5173", "X-AuraJournal-CSRF": "1", "Content-Type": "text/plain"}
    assert client.post("/api/ai/suggest-title", headers=headers, content="not JSON").status_code == 415


@pytest.mark.parametrize("phase", ["connecting", "finishing"])
def test_disconnect_cancels_handshake_or_final_flush(setup, phase):
    client, provider, _, _, _ = setup
    reached, cancelled = Event(), Event()
    if phase == "connecting":
        async def connect(*args, **kwargs):
            reached.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        client.app.state.deepgram_streaming_client = DeepgramStreamingClient("key", connector=connect)
    else:
        provider.final_events = []
        original_send = provider.send
        async def send(message):
            await original_send(message)
            if isinstance(message, str):
                reached.set()
        provider.send = send
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        ready = ws.receive_json()
        start(ws, ready)
        if phase == "finishing":
            assert ws.receive_json()["type"] == "started"
            ws.send_bytes(WEBM_HEADER)
            ws.send_json({"type": "finish", "session_id": ready["session_id"]})
        assert reached.wait(2)
    assert cancelled.is_set() if phase == "connecting" else provider.close_calls == 1


def test_revoked_session_cannot_start_a_paid_provider_connection(setup):
    client, _, connector, rows, _ = setup
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        ready = ws.receive_json()
        rows.pop(AuthSession)
        start(ws, ready)
        assert ws.receive_json()["code"] == "auth_expired"
    assert not connector.calls


def test_audio_chunk_limit_stops_the_provider_without_forwarding_bad_chunk(setup, monkeypatch):
    client, provider, _, _, _ = setup
    monkeypatch.setattr(transcriptions, "MAX_CHUNK_BYTES", 3)
    with client.websocket_connect(PATH, headers=ORIGIN.copy()) as ws:
        start(ws, ws.receive_json())
        assert ws.receive_json()["type"] == "started"
        ws.send_bytes(b"too large")
        assert ws.receive_json()["code"] == "limit_exceeded"
    assert provider.sent == [] and provider.close_calls == 1
