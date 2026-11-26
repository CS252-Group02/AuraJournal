"""One bounded Deepgram prerecorded request for a completed WebM/Opus file.

No streaming reconstruction, reference-text prompting, persistence or retries.
"""
from contextlib import AsyncExitStack
import json
import math
from typing import Protocol

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from app.config import deepgram_api_key
from app.services.async_deadline import deadline
from app.services.deepgram import (
    DeepgramConfigurationError, DeepgramInvalidAudioError, DeepgramInvalidResponseError,
    DeepgramRateLimitedError, DeepgramTimeoutError, DeepgramUnavailableError,
    _json_object, _invalid_json_constant,
)
from app.services.transcription import RecordedTranscript

URL = "https://api.deepgram.com/v1/listen"
PARAMS = (("model", "nova-3"), ("language", "multi"),
          ("language_hint", "vi"), ("language_hint", "en"))
MAX_AUDIO_BYTES = 10 * 1024 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
RECOGNITION_TIMEOUT = 60


class RecordedTranscriber(Protocol):
    async def transcribe(self, audio: bytes) -> RecordedTranscript: ...


class _ProviderModel(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True, allow_inf_nan=False)


class _Metadata(_ProviderModel):
    duration: float = Field(ge=0)
    channels: int = Field(ge=1)


class _Alternative(_ProviderModel):
    transcript: str
    words: list[dict] | None = None

    @model_validator(mode="after")
    def no_words_without_text(self):
        if self.words and not self.transcript.strip():
            raise ValueError("Words require a transcript.")
        return self


class _Channel(_ProviderModel):
    alternatives: list[_Alternative] = Field(min_length=1)


class _Results(_ProviderModel):
    channels: list[_Channel] = Field(min_length=1, max_length=1)


class _Response(_ProviderModel):
    metadata: _Metadata
    results: _Results


def parse_recorded_response(raw: bytes) -> RecordedTranscript:
    try:
        payload = json.loads(raw, object_pairs_hook=_json_object, parse_constant=_invalid_json_constant)
        pending = [(payload, 0)]
        while pending:
            value, depth = pending.pop()
            if depth > 32 or (isinstance(value, float) and not math.isfinite(value)):
                raise ValueError("Invalid provider JSON")
            if isinstance(value, dict): pending.extend((v, depth + 1) for v in value.values())
            elif isinstance(value, list): pending.extend((v, depth + 1) for v in value)
        result = _Response.model_validate(payload)
        text = result.results.channels[0].alternatives[0].transcript.strip()
        if text and result.metadata.duration <= 0: raise ValueError("Invalid audio duration")
        return RecordedTranscript(text, "transcribed" if text else "no_speech")
    except (ValueError, TypeError, RecursionError, ValidationError):
        raise DeepgramInvalidResponseError("Speech service returned an invalid transcript.") from None


class DeepgramRecordedClient:
    def __init__(self, api_key: str | None = None, *, client: httpx.AsyncClient | None = None):
        self._api_key, self._client = api_key, client

    async def transcribe(self, audio: bytes) -> RecordedTranscript:
        if not isinstance(audio, bytes) or not audio.startswith(bytes.fromhex("1a45dfa3")) or len(audio) > MAX_AUDIO_BYTES:
            raise DeepgramInvalidAudioError("Use a completed WebM recording of at most 10 MiB.")
        key = deepgram_api_key() if self._api_key is None else self._api_key
        if not isinstance(key, str) or not key.strip() or "\r" in key or "\n" in key:
            raise DeepgramConfigurationError("Speech service is not configured correctly.")
        try:
            return await deadline(self._request(audio, key.strip()), RECOGNITION_TIMEOUT)
        except (TimeoutError, httpx.TimeoutException):
            raise DeepgramTimeoutError("Transcription timed out.") from None
        except httpx.HTTPError:
            raise DeepgramUnavailableError("Speech service is unavailable.") from None

    async def _request(self, audio: bytes, key: str) -> RecordedTranscript:
        async with AsyncExitStack() as stack:
            client = self._client or await stack.enter_async_context(httpx.AsyncClient(
                timeout=httpx.Timeout(45, connect=8, write=10, pool=5),
                follow_redirects=False, trust_env=False,
            ))
            async with client.stream("POST", URL, params=PARAMS, content=audio, headers={
                "Authorization": "Token " + key, "Content-Type": "audio/webm;codecs=opus", "Accept": "application/json",
            }) as response:
                if response.status_code in {401, 403}: raise DeepgramConfigurationError()
                if response.status_code == 429: raise DeepgramRateLimitedError()
                if response.status_code in {408, 504}: raise DeepgramTimeoutError()
                if response.status_code in {400, 415, 422}: raise DeepgramInvalidAudioError()
                if response.status_code >= 500 or response.status_code == 402: raise DeepgramUnavailableError()
                if response.status_code != 200 or response.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
                    raise DeepgramInvalidResponseError()
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(raw) + len(chunk) > MAX_RESPONSE_BYTES: raise DeepgramInvalidResponseError()
                    raw.extend(chunk)
                return parse_recorded_response(bytes(raw))
