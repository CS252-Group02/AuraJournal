import asyncio
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.routers import transcription_upload as upload
from app.services.deepgram import (
    DeepgramConfigurationError, DeepgramInvalidAudioError, DeepgramInvalidResponseError,
    DeepgramRateLimitedError, DeepgramStreamingClient, DeepgramTimeoutError, DeepgramUnavailableError,
)
from test_deepgram_service import FakeConnector, FakeSocket
from test_transcription import result

PATH = "/api/transcriptions"
HEADERS = {"Origin": "http://localhost:5173", "X-AuraJournal-CSRF": "1",
           "Content-Type": "audio/webm;codecs=opus"}
AUDIO = upload.WEBM_SIGNATURE + b"fictional-audio"


class RecordedFixtureClient:
    """RecordedTranscriber stub reusing the existing adversarial stream fixtures.

    Production uploads use DeepgramRecordedClient; its HTTP transport is tested
    separately below and in test_deepgram_recorded.py.
    """
    def __init__(self, streaming): self.streaming = streaming

    async def transcribe(self, audio):
        from app.services import collect_recorded_transcript, transcribe_audio
        async def chunks():
            for offset in range(0, len(audio), upload.CHUNK_BYTES):
                yield bytes(audio[offset:offset + upload.CHUNK_BYTES])
        return await collect_recorded_transcript(transcribe_audio(
            chunks(), session_id="fixture", client=self.streaming))


@pytest.fixture
def setup(monkeypatch):
    app = create_app()
    app.dependency_overrides[upload.upload_owner] = lambda: uuid4()
    monkeypatch.setattr(upload, "verify_owner", lambda *args: None)
    socket = FakeSocket(final_events=[result("Hôm nay I finished homework.", final=True), {"type": "Metadata"}])
    connector = FakeConnector(socket)
    app.state.deepgram_recording_client = RecordedFixtureClient(DeepgramStreamingClient("key", connector=connector))
    with TestClient(app) as client:
        yield SimpleNamespace(app=app, client=client, socket=socket, connector=connector)


@pytest.mark.parametrize("mime", ['audio/webm;codecs=opus', 'Audio/WebM; Codecs="Opus"', 'audio/webm; codecs = opus'])
def test_upload_reuses_real_helper_and_returns_one_private_transcript(setup, mime):
    response = setup.client.post(PATH, content=AUDIO, headers=HEADERS | {"Content-Type": mime})
    assert response.status_code == 200
    assert response.json() == {"transcript": "Hôm nay I finished homework.", "outcome": "transcribed"}
    assert response.headers["cache-control"] == "no-store"
    assert setup.socket.sent[0] == AUDIO
    assert setup.socket.close_calls == len(setup.connector.calls) == 1


@pytest.mark.parametrize("mime", ["", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/wav", "application/json",
                                   "multipart/form-data", "audio/webm;codecs=vorbis", "audio/webm;codecs=opus;codecs=opus"])
def test_unsupported_format_never_opens_provider(setup, mime):
    response = setup.client.post(PATH, content=AUDIO, headers=HEADERS | {"Content-Type": mime})
    assert response.status_code == 415
    assert not setup.connector.calls


@pytest.mark.parametrize("audio", [b"", b"\x1a", b"\x1a\x45\xdf", b"RIFFnot-a-webm"])
def test_empty_and_invalid_container_never_open_provider(setup, audio):
    assert setup.client.post(PATH, content=audio, headers=HEADERS).status_code == 422
    assert not setup.connector.calls


def test_silence_is_success_but_unconfirmed_text_is_not(setup):
    setup.socket.final_events = [{"type": "Metadata"}]
    response = setup.client.post(PATH, content=AUDIO, headers=HEADERS)
    assert response.status_code == 200
    assert response.json() == {"transcript": "", "outcome": "no_speech"}
    setup.connector.socket = FakeSocket(final_events=[result("Unconfirmed draft"), {"type": "Metadata"}])
    response = setup.client.post(PATH, content=AUDIO, headers=HEADERS)
    assert response.status_code == 502
    assert "Unconfirmed" not in response.text


def test_revisions_and_real_repetition_are_not_duplicated_or_lost(setup):
    setup.socket.final_events = [result("Hôm", end=1), result("Hôm nay", end=1),
                                result("Hôm nay.", final=True, end=1),
                                result("Again.", final=True, start=1, end=2),
                                result("Again.", final=True, start=2, end=3), {"type": "Metadata"}]
    response = setup.client.post(PATH, content=AUDIO, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["transcript"] == "Hôm nay. Again. Again."


@pytest.mark.parametrize("error,status", [(DeepgramConfigurationError, 503), (DeepgramUnavailableError, 503),
    (DeepgramInvalidAudioError, 422), (DeepgramInvalidResponseError, 502),
    (DeepgramTimeoutError, 504), (DeepgramRateLimitedError, 429)])
def test_provider_errors_are_safe_and_never_retried(setup, error, status):
    setup.connector.error = error("secret-key private provider message")
    response = setup.client.post(PATH, content=AUDIO, headers=HEADERS)
    assert response.status_code == status
    assert "secret" not in response.text and "private provider" not in response.text
    assert len(setup.connector.calls) == 1


def test_byte_limit_is_checked_without_content_length_and_preserves_chunk_order(setup, monkeypatch):
    monkeypatch.setattr(upload, "MAX_AUDIO_BYTES", len(AUDIO))
    response = setup.client.post(PATH, content=iter([AUDIO[:2], AUDIO[2:]]), headers=HEADERS)
    assert response.status_code == 200
    assert b"".join(s for s in setup.socket.sent if isinstance(s, bytes)) == AUDIO
    setup.connector.calls.clear()
    response = setup.client.post(PATH, content=iter([AUDIO, b"x"]), headers=HEADERS)
    assert response.status_code == 413
    assert not setup.connector.calls


def test_audio_above_old_json_limit_is_chunked_and_exact_audio_limit_succeeds(setup):
    audio = upload.WEBM_SIGNATURE + b"x" * (upload.MAX_AUDIO_BYTES - 4)
    response = setup.client.post(PATH, content=audio, headers=HEADERS)
    assert response.status_code == 200
    sent = [s for s in setup.socket.sent if isinstance(s, bytes)]
    assert max(map(len, sent)) <= upload.CHUNK_BYTES
    assert b"".join(sent) == audio
    setup.connector.calls.clear()
    assert setup.client.post(PATH, content=audio + b"x", headers=HEADERS).status_code == 413
    assert not setup.connector.calls


@pytest.mark.parametrize("headers", [{"Origin": "https://evil.example", "X-AuraJournal-CSRF": "1"},
                                      {"Origin": HEADERS["Origin"]}])
def test_raw_upload_keeps_origin_and_csrf_checks(setup, headers):
    response = setup.client.post(PATH, content=AUDIO, headers=headers | {"Content-Type": HEADERS["Content-Type"]})
    assert response.status_code == 403
    assert not setup.connector.calls


def test_json_and_body_limits_remain_on_other_routes(setup):
    assert setup.client.post("/api/entries", content=AUDIO, headers=HEADERS).status_code == 415
    assert setup.client.post("/api/entries", content=b"x" * 65537,
                             headers=HEADERS | {"Content-Type": "application/json"}).status_code == 413


def test_transcription_deadline_cancels_and_closes_helper(setup, monkeypatch):
    closed = []
    async def stalled(*args, **kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            closed.append(True)
    setup.app.state.deepgram_recording_client = SimpleNamespace(transcribe=stalled)
    monkeypatch.setattr(upload, "TRANSCRIPTION_TIMEOUT", 0.02)
    response = setup.client.post(PATH, content=AUDIO, headers=HEADERS)
    assert response.status_code == 504
    assert closed == [True]


def test_upload_deadline_does_not_open_provider(setup, monkeypatch):
    async def run():
        async def slow():
            yield AUDIO[:2]
            await asyncio.Event().wait()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=setup.app), base_url="http://test") as client:
            return await client.post(PATH, content=slow(), headers=HEADERS)
    monkeypatch.setattr(upload, "UPLOAD_TIMEOUT", 0.02)
    assert asyncio.run(run()).status_code == 504
    assert not setup.connector.calls


def test_openapi_documents_binary_audio_and_simple_response(setup):
    operation = setup.app.openapi()["paths"][PATH]["post"]
    assert operation["requestBody"]["content"][HEADERS["Content-Type"]]["schema"]["format"] == "binary"
    assert operation["responses"]["200"]["content"]["application/json"]


def test_disconnect_cancels_recognition_and_closes_helper(monkeypatch):
    async def run():
        started = asyncio.Event()
        closed = []
        async def stalled(*args, **kwargs):
            try:
                started.set()
                await asyncio.Event().wait()
            finally:
                closed.append(True)
        async def receive():
            await started.wait()
            return {"type": "http.disconnect"}
        request = SimpleNamespace(receive=receive, app=SimpleNamespace(state=SimpleNamespace(
            deepgram_recording_client=SimpleNamespace(transcribe=stalled))))
        from starlette.requests import ClientDisconnect
        with pytest.raises(ClientDisconnect):
            await upload.recognize_connected(request, bytearray(AUDIO))
        assert closed == [True]
    asyncio.run(run())


def test_real_helper_provider_completion_timeout_closes_socket(setup):
    setup.socket.final_events = []
    setup.app.state.deepgram_recording_client = RecordedFixtureClient(DeepgramStreamingClient(
        "key", connector=setup.connector, finish_timeout=0.01,
    ))
    response = setup.client.post(PATH, content=AUDIO, headers=HEADERS)
    assert response.status_code == 504
    assert setup.socket.close_calls == 1


def test_empty_provider_credentials_are_safe_and_do_not_connect(setup):
    setup.app.state.deepgram_recording_client = RecordedFixtureClient(DeepgramStreamingClient("", connector=setup.connector))
    assert setup.client.post(PATH, content=AUDIO, headers=HEADERS).status_code == 503
    assert not setup.connector.calls


@pytest.mark.parametrize("expired_on_check", [1, 2])
def test_expired_session_is_rejected_before_provider_or_before_return(setup, monkeypatch, expired_on_check):
    from fastapi import HTTPException
    checks = []
    def verify(*args):
        checks.append(True)
        if len(checks) == expired_on_check:
            raise HTTPException(401, "Please log in.")
    monkeypatch.setattr(upload, "verify_owner", verify)
    response = setup.client.post(PATH, content=AUDIO, headers=HEADERS)
    assert response.status_code == 401
    assert len(setup.connector.calls) == expired_on_check - 1
    assert "homework" not in response.text



def test_completed_upload_uses_its_own_client_without_affecting_live_streaming(setup):
    # A live session can keep its short flush budget; uploaded audio uses the
    # independently injectable recording client and the outer 60-second deadline.
    def forbidden():
        raise AssertionError("Upload must not use the live client")
    setup.app.state.deepgram_streaming_client = SimpleNamespace(connect=forbidden)
    response = setup.client.post(PATH, content=AUDIO, headers=HEADERS)
    assert response.status_code == 200
    assert len(setup.connector.calls) == 1



def test_real_prerecorded_adapter_sends_audio_once_and_returns_both_languages(setup):
    from app.services.deepgram_recorded import DeepgramRecordedClient
    from test_deepgram_recorded import response
    calls = []
    def handle(req):
        calls.append(req)
        assert req.content == AUDIO
        assert "cookie" not in req.headers and "x-aurajournal-csrf" not in req.headers
        return httpx.Response(200, json=response("Vietnamese. We tested the login flow. Vietnamese again."))
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as provider:
            setup.app.state.deepgram_recording_client = DeepgramRecordedClient("key", client=provider)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=setup.app), base_url="http://test") as client:
                return await client.post(PATH, content=AUDIO, headers=HEADERS)
    output = asyncio.run(run())
    assert output.status_code == 200
    assert "We tested the login flow" in output.json()["transcript"]
    assert len(calls) == 1 and not setup.connector.calls
