import asyncio
import json

import httpx
import pytest

from app.services.deepgram import (
    DeepgramConfigurationError, DeepgramInvalidAudioError, DeepgramInvalidResponseError,
    DeepgramRateLimitedError, DeepgramTimeoutError, DeepgramUnavailableError,
)
from app.services.deepgram_recorded import DeepgramRecordedClient, parse_recorded_response

AUDIO = bytes.fromhex("1a45dfa3") + b"fictional Opus audio"


def response(text="Vietnamese. We tested login. Vietnamese again."):
    return {"metadata": {"duration": 15.42, "channels": 1},
            "results": {"channels": [{"alternatives": [{"transcript": text, "words": []}]}]}}


def run(handler, audio=AUDIO, key="test-key"):
    async def invoke():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await DeepgramRecordedClient(key, client=client).transcribe(audio)
    return asyncio.run(invoke())


def test_completed_file_is_sent_once_with_only_audio_and_multilingual_options():
    calls = []
    def handler(request):
        calls.append(request)
        assert request.method == "POST" and request.url.host == "api.deepgram.com"
        assert request.url.params.multi_items() == [("model", "nova-3"), ("language", "multi"),
            ("language_hint", "vi"), ("language_hint", "en")]
        assert request.headers["authorization"] == "Token test-key"
        assert request.headers["content-type"] == "audio/webm;codecs=opus"
        assert request.content == AUDIO
        return httpx.Response(200, json=response())
    result = run(handler)
    assert result.transcript == response()["results"]["channels"][0]["alternatives"][0]["transcript"]
    assert result.outcome == "transcribed" and len(calls) == 1
    assert "Vietnamese" not in repr(result)


def test_prerecorded_silence_has_empty_text_and_no_speech():
    result = run(lambda request: httpx.Response(200, json=response("")))
    assert result.transcript == "" and result.outcome == "no_speech"


@pytest.mark.parametrize("status,error", [(401, DeepgramConfigurationError), (403, DeepgramConfigurationError),
    (429, DeepgramRateLimitedError), (408, DeepgramTimeoutError), (504, DeepgramTimeoutError),
    (400, DeepgramInvalidAudioError), (415, DeepgramInvalidAudioError), (422, DeepgramInvalidAudioError),
    (500, DeepgramUnavailableError), (402, DeepgramUnavailableError), (302, DeepgramInvalidResponseError)])
def test_status_failures_are_safe_and_never_retried(status, error):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, json={"error": "PRIVATE credential or provider input"},
                              headers={"Location": "https://evil.example"})
    with pytest.raises(error) as caught: run(handler)
    assert len(calls) == 1 and "PRIVATE" not in str(caught.value)


@pytest.mark.parametrize("body", [None, {}, {"results": {}}, response(123),
    {**response(), "metadata": {"duration": -1, "channels": 1}},
    {**response(), "results": {"channels": []}},
    {**response(), "results": {"channels": [{"alternatives": []}]}},
    {**response(), "metadata": {"duration": 0, "channels": 1}}])
def test_missing_or_invalid_results_are_not_transcripts(body):
    with pytest.raises(DeepgramInvalidResponseError):
        run(lambda request: httpx.Response(200, json=body))


@pytest.mark.parametrize("raw", [b'{"results":{},"results":{}}', b'{"value":NaN}',
                                 b'['*40+b'0'+b']'*40, b'not json', b'{"ignored":1e999}'])
def test_invalid_json_has_safe_failure(raw):
    with pytest.raises(DeepgramInvalidResponseError): parse_recorded_response(raw)


@pytest.mark.parametrize("audio,key,error", [(b"RIFFdata", "key", DeepgramInvalidAudioError),
    (b"", "key", DeepgramInvalidAudioError), (AUDIO, "", DeepgramConfigurationError),
    (AUDIO, "bad\nkey", DeepgramConfigurationError)])
def test_input_or_missing_configuration_precedes_provider(audio, key, error):
    with pytest.raises(error): run(lambda request: pytest.fail("must not access provider"), audio, key)


def test_network_timeout_maps_safely_without_retry():
    calls = []
    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout("PRIVATE", request=request)
    with pytest.raises(DeepgramTimeoutError) as caught: run(handler)
    assert "PRIVATE" not in str(caught.value) and len(calls) == 1


def test_response_limit_and_wrong_content_type_are_rejected(monkeypatch):
    from app.services import deepgram_recorded
    monkeypatch.setattr(deepgram_recorded, "MAX_RESPONSE_BYTES", 5)
    with pytest.raises(DeepgramInvalidResponseError): run(lambda request: httpx.Response(200, json=response()))
    with pytest.raises(DeepgramInvalidResponseError): run(lambda request: httpx.Response(200, text="not JSON"))



def test_total_deadline_cancels_stalled_http_without_another_attempt(monkeypatch):
    from app.services import deepgram_recorded
    closed, calls = [], []
    async def handler(request):
        calls.append(request)
        try:
            await asyncio.Event().wait()
        finally:
            closed.append(True)
    monkeypatch.setattr(deepgram_recorded, "RECOGNITION_TIMEOUT", 0.02)
    with pytest.raises(DeepgramTimeoutError): run(handler)
    assert len(calls) == 1 and closed == [True]


def test_caller_cancellation_propagates_and_releases_http_work():
    closed, started = [], asyncio.Event()
    async def handler(request):
        try:
            started.set()
            await asyncio.Event().wait()
        finally:
            closed.append(True)
    async def invoke():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            task = asyncio.create_task(DeepgramRecordedClient("key", client=client).transcribe(AUDIO))
            await started.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError): await task
    asyncio.run(invoke())
    assert closed == [True]
