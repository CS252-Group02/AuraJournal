"""A02 transport; A03 application mapping lives in services.transcription.

Read events concurrently with sending audio and calling finish(). Each context
owns one provider connection, with no automatic retries or audio persistence.
"""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
import json
import math
from typing import Protocol
from urllib.parse import urlencode

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus, WebSocketException

from app.config import deepgram_api_key


DEEPGRAM_STREAM_URL = "wss://api.deepgram.com/v1/listen?" + urlencode([
    ("model", "nova-3"), ("language", "multi"),
    ("language_hint", "vi"), ("language_hint", "en"),
    ("interim_results", "true"), ("endpointing", "300"),
])
SUPPORTED_MIME_TYPES = ("audio/webm;codecs=opus",)


class DeepgramError(RuntimeError):
    """Safe service error; never includes provider details or journal content."""

    code = "provider_unavailable"
    public_message = "Speech service is unavailable. Please try again later."

    def to_event(self, session_id: str) -> dict:
        # Never serialize str(self): a caller could have supplied private details.
        return {"type": "error", "session_id": session_id,
                "code": self.code, "message": self.public_message}


class DeepgramConfigurationError(DeepgramError):
    code = "not_configured"
    public_message = "Speech service is not configured correctly."


class DeepgramUnavailableError(DeepgramError):
    pass


class DeepgramInvalidResponseError(DeepgramError):
    code = "invalid_response"
    public_message = "Speech service returned an invalid transcript. Please try again."


class DeepgramTimeoutError(DeepgramError):
    code = "timeout"
    public_message = "Transcription timed out. Review your recording before trying again."


class DeepgramInvalidAudioError(DeepgramError, ValueError):
    code = "invalid_audio"
    public_message = "Audio is empty, unsupported, or could not be decoded. Please record again."


class DeepgramRateLimitedError(DeepgramUnavailableError):
    code = "rate_limited"
    public_message = "Speech service is busy. Please try again later."


def provider_stream_error(code: str) -> DeepgramError:
    """Map only known provider codes; never return the raw reason/description."""
    if code.startswith("DATA-0000"):
        return DeepgramInvalidAudioError("Audio could not be decoded.")
    if code.startswith(("NET-0000", "NET-0001", "NET-0002")):
        return DeepgramTimeoutError("Speech service timed out.")
    return DeepgramUnavailableError("Speech service connection failed.")


class _Socket(Protocol):
    async def send(self, message: str | bytes) -> None: ...
    async def recv(self) -> str | bytes: ...
    async def close(self) -> None: ...


class DeepgramStream:
    """One stream. Use events() once, in a concurrent receiver task.

    send_audio() accepts the original ordered container bytes. finish() sends
    CloseStream and waits for events() to consume the terminal Metadata event.
    Exiting the client's context without finish() aborts the take.
    """

    def __init__(self, socket: _Socket, *, send_timeout: float, finish_timeout: float):
        self._socket = socket
        self._send_timeout = send_timeout
        self._finish_timeout = finish_timeout
        self._writes = asyncio.Lock()
        self._done = asyncio.Event()
        self._finishing = False
        self._closed = False
        self._reading_started = False
        self._completed = False
        self._receive_error: DeepgramError | None = None
        self._close_task: asyncio.Task | None = None

    async def _send(self, message: str | bytes) -> None:
        try:
            await asyncio.wait_for(self._socket.send(message), self._send_timeout)
        except (TimeoutError, asyncio.TimeoutError):
            error = DeepgramTimeoutError("Speech service send timed out.")
        except ConnectionClosed as closed:
            error = provider_stream_error(closed.rcvd.reason if closed.rcvd else "")
        except (OSError, WebSocketException):
            error = DeepgramUnavailableError("Speech service connection failed.")
        else:
            return
        self._receive_error = error
        self._done.set()
        raise error from None

    async def send_audio(self, audio: bytes) -> None:
        """Send one nonempty chunk unchanged, without retries or conversion."""
        if not isinstance(audio, bytes) or not audio:
            raise DeepgramInvalidAudioError("Audio must be nonempty bytes.")
        async with self._writes:
            if self._closed or self._finishing or self._done.is_set():
                raise RuntimeError("This speech stream no longer accepts audio.")
            await self._send(audio)

    async def events(self) -> AsyncIterator[dict]:
        """Yield provider JSON objects, including empty transcripts and Metadata.

        These are internal provider events, not the frontend segment contract.
        There is deliberately no ordinary receive timeout: silence can produce
        no events. finish() has a separate bounded completion deadline.
        """
        if self._reading_started or self._closed:
            raise RuntimeError("Speech events can only be read once per stream.")
        self._reading_started = True
        try:
            while True:
                try:
                    raw = await self._socket.recv()
                except ConnectionClosed as closed:
                    if self._closed:
                        if self._receive_error is not None:
                            raise self._receive_error from None
                        raise asyncio.CancelledError
                    raise provider_stream_error(closed.rcvd.reason if closed.rcvd else "") from None
                except OSError:
                    raise DeepgramUnavailableError("Speech service connection failed.") from None
                except WebSocketException:
                    raise DeepgramInvalidResponseError("Speech service returned an invalid response.") from None
                try:
                    if not isinstance(raw, str):
                        raise ValueError
                    event = json.loads(raw)
                    if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                        raise ValueError
                except (ValueError, TypeError):
                    raise DeepgramInvalidResponseError("Speech service returned an invalid response.") from None
                if event["type"] == "Error":
                    code = event.get("code", event.get("err_code", ""))
                    raise provider_stream_error(code if isinstance(code, str) else "")
                terminal = self._finishing and event["type"] == "Metadata"
                if terminal:
                    self._completed = True
                yield event
                if terminal:
                    return
        except DeepgramError as error:
            self._receive_error = error
            raise
        finally:
            if not self._completed and self._receive_error is None:
                self._receive_error = DeepgramUnavailableError("Speech stream ended before completion.")
            self._done.set()

    async def finish(self) -> None:
        """Flush the last audio and wait for the concurrent reader to finish.

        Repeated calls do not resend CloseStream. A successful send alone is
        never treated as proof that the final transcript was received.
        """
        try:
            await asyncio.wait_for(self._finish(), self._finish_timeout)
        except (TimeoutError, asyncio.TimeoutError):
            self._receive_error = DeepgramTimeoutError("Speech service completion timed out.")
            await self.aclose()
            raise self._receive_error from None

    async def _finish(self) -> None:
        async with self._writes:
            if self._closed:
                raise RuntimeError("This speech stream is closed.")
            if not self._finishing:
                if self._done.is_set():
                    raise self._receive_error or DeepgramUnavailableError("Speech stream ended before completion.")
                self._finishing = True
                await self._send(json.dumps({"type": "CloseStream"}))
        await self._done.wait()
        if not self._completed:
            raise self._receive_error or DeepgramUnavailableError("Speech stream ended before completion.")

    async def aclose(self) -> None:
        """Release the connection; safe after success, errors, and cancellation."""
        if self._close_task is None:
            self._closed = True
            self._done.set()
            self._close_task = asyncio.create_task(self._close_socket())
        # Concurrent closes share cleanup; cancelling one waiter cannot cancel it.
        await asyncio.shield(self._close_task)

    async def _close_socket(self) -> None:
        try:
            await asyncio.wait_for(self._socket.close(), 3)
        except (TimeoutError, asyncio.TimeoutError, OSError, WebSocketException):
            # A failed close handshake must not leave a live TCP transport behind.
            transport = getattr(self._socket, "transport", None)
            if transport is not None:
                transport.abort()


class DeepgramStreamingClient:
    """Reusable client factory; every connect() creates an independent take."""

    def __init__(
        self, api_key: str | None = None, *,
        connector: Callable[..., Awaitable[_Socket]] | None = None,
        open_timeout: float = 10, send_timeout: float = 10, finish_timeout: float = 12,
    ):
        self._api_key = api_key
        self._connector = connector
        if any(not math.isfinite(value) or value <= 0 for value in (open_timeout, send_timeout, finish_timeout)):
            raise ValueError("Speech service timeouts must be positive and finite.")
        self._open_timeout = open_timeout
        self._send_timeout = send_timeout
        self._finish_timeout = finish_timeout

    @asynccontextmanager
    async def connect(self, *, mime_type: str = SUPPORTED_MIME_TYPES[0]) -> AsyncIterator[DeepgramStream]:
        """Open one WebM/Opus stream. Missing credentials never open a socket."""
        if mime_type not in SUPPORTED_MIME_TYPES:
            raise DeepgramInvalidAudioError("Unsupported streaming audio format.")
        key = deepgram_api_key() if self._api_key is None else self._api_key
        if not isinstance(key, str) or not key.strip() or "\r" in key or "\n" in key:
            raise DeepgramConfigurationError("DEEPGRAM_API_KEY is not configured correctly.")
        try:
            socket = await asyncio.wait_for((self._connector or connect)(
                DEEPGRAM_STREAM_URL,
                additional_headers={"Authorization": f"Token {key.strip()}"},
                open_timeout=self._open_timeout, close_timeout=2,
                max_size=1024 * 1024, max_queue=16,
                compression=None, proxy=None,
            ), self._open_timeout)
        except (TimeoutError, asyncio.TimeoutError):
            raise DeepgramTimeoutError("Speech service connection timed out.") from None
        except InvalidStatus as error:
            if error.response.status_code in {400, 401, 403}:
                raise DeepgramConfigurationError("Speech service credentials or settings were rejected.") from None
            if error.response.status_code == 429:
                raise DeepgramRateLimitedError("Speech service rate limit reached.") from None
            if error.response.status_code in {408, 504}:
                raise DeepgramTimeoutError("Speech service connection timed out.") from None
            raise DeepgramUnavailableError("Speech service is unavailable.") from None
        except (OSError, WebSocketException):
            raise DeepgramUnavailableError("Speech service is unavailable.") from None
        stream = DeepgramStream(socket, send_timeout=self._send_timeout, finish_timeout=self._finish_timeout)
        try:
            yield stream
        finally:
            await stream.aclose()
