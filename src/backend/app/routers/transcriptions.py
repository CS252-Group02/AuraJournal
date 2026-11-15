"""Browser WebSocket bridge for the speech-to-text services."""

import asyncio
from contextlib import aclosing, suppress
import json
from time import monotonic
from uuid import uuid4

from anyio import CancelScope
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool

from app.auth import COOKIE_NAME, authenticated_session, utcnow
from app.config import frontend_origin
from app.services import DeepgramError, DeepgramInvalidAudioError, DeepgramTimeoutError, transcribe_audio
from app.services.deepgram import SUPPORTED_MIME_TYPES

router = APIRouter(prefix="/api/transcriptions", tags=["transcription"])
START_TIMEOUT = 60  # Allow time for the browser's microphone permission prompt.
MAX_RECORDING_SECONDS = 300
MAX_AUDIO_BYTES = 10 * 1024 * 1024
MAX_CHUNK_BYTES = 1024 * 1024
MAX_CONTROL_BYTES = 4096
MAX_MESSAGES_PER_SECOND = 64
AUTH_RECHECK_SECONDS = 30
SEND_TIMEOUT = 5
CLOSE_TIMEOUT = 2
WEBM_SIGNATURE = b"\x1a\x45\xdf\xa3"


class ProtocolError(DeepgramError):
    code = "invalid_request"
    public_message = "Invalid recording message. Reset the recording and try again."


class RecordingLimitError(DeepgramError):
    code = "limit_exceeded"
    public_message = "Recording limit reached. Start a shorter recording."


class SessionExpiredError(DeepgramError):
    code = "auth_expired"
    public_message = "Your session expired. Please log in again."


def _identity(application, token):
    # Short-lived DB work runs off the event loop; no connection is held while
    # recording or waiting for Deepgram. Reuse the HTTP account/session rules.
    with application.state.session_factory() as session:
        user, record = authenticated_session(session, token)
        return user.id, record.expires_at


async def _verify_owner(websocket, token, owner):
    try:
        current_owner, expires = await run_in_threadpool(_identity, websocket.app, token)
    except HTTPException:
        raise SessionExpiredError() from None
    if current_owner != owner:
        raise SessionExpiredError()
    return expires


async def _message(websocket):
    message = await websocket.receive()
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))
    return message


async def _send(websocket, event):
    try:
        await asyncio.wait_for(websocket.send_json(event), SEND_TIMEOUT)
    except (TimeoutError, asyncio.TimeoutError):
        raise DeepgramTimeoutError("Recording response timed out.") from None


def _close_code(code):
    return 1008 if code in {"invalid_request", "invalid_audio", "limit_exceeded", "auth_expired"} else 1011


def _unique_object(pairs):
    data = {}
    for key, value in pairs:
        if key in data:
            raise ValueError
        data[key] = value
    return data


def _reject_constant(value):
    raise ValueError


def _control(message, session_id, kind):
    text = message.get("text")
    try:
        if not isinstance(text, str):
            raise ValueError
        if len(text.encode("utf-8")) > MAX_CONTROL_BYTES:
            raise RecordingLimitError()
        data = json.loads(text, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
        fields = {"type", "session_id", "mime_type", "language"} if kind == "start" else {"type", "session_id"}
        if (not isinstance(data, dict) or set(data) != fields
                or any(not isinstance(value, str) for value in data.values())
                or data["type"] != kind or data["session_id"] != session_id):
            raise ValueError
        return data
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise ProtocolError() from None


async def _record(websocket, session_id, owner, token):
    try:
        start = _control(await asyncio.wait_for(_message(websocket), START_TIMEOUT), session_id, "start")
    except (TimeoutError, asyncio.TimeoutError):
        raise DeepgramTimeoutError("Recording did not start in time.") from None
    if start["mime_type"] not in SUPPORTED_MIME_TYPES:
        raise DeepgramInvalidAudioError("Unsupported streaming audio format.")
    # Compatibility with the existing frontend's fixed 'vi' value. Both select
    # the agreed Vietnamese/English multilingual provider configuration.
    if start["language"] not in ("multi", "vi"):
        raise ProtocolError()
    await _verify_owner(websocket, token, owner)
    finished_input = asyncio.Event()
    upstream_ready, reader_handoff = asyncio.Event(), asyncio.Event()

    async def chunks():
        total = 0
        prefix, buffered = bytearray(), []
        window_start, messages = monotonic(), 0
        while True:
            message = await _message(websocket)
            now = monotonic()
            if now - window_start >= 1:
                window_start, messages = now, 0
            messages += 1
            if messages > MAX_MESSAGES_PER_SECOND:
                raise RecordingLimitError()
            data = message.get("bytes")
            if data is None:
                _control(message, session_id, "finish")
                if prefix and len(prefix) < len(WEBM_SIGNATURE):
                    raise DeepgramInvalidAudioError("Recording header is incomplete.")
                finished_input.set()
                return
            if not isinstance(data, bytes) or not data:
                raise DeepgramInvalidAudioError("Audio must be nonempty bytes.")
            if len(data) > MAX_CHUNK_BYTES or total + len(data) > MAX_AUDIO_BYTES:
                raise RecordingLimitError()
            total += len(data)
            if len(prefix) < len(WEBM_SIGNATURE):
                buffered.append(data)
                prefix.extend(data[:len(WEBM_SIGNATURE) - len(prefix)])
                if not WEBM_SIGNATURE.startswith(prefix):
                    raise DeepgramInvalidAudioError("Recording header is not supported.")
                if len(prefix) < len(WEBM_SIGNATURE):
                    continue
                # The container header may span multiple chunks. Preserve all
                # original bytes and ordering once the signature is confirmed.
                for chunk in buffered:
                    yield chunk
                buffered.clear()
            else:
                yield data

    async def started():
        upstream_ready.set()
        await reader_handoff.wait()
        await _send(websocket, {"type": "started", "session_id": session_id})

    async def relay():
        async with aclosing(transcribe_audio(
            chunks(), session_id=session_id, client=websocket.app.state.deepgram_streaming_client,
            on_connected=started,
        )) as events:
            async for event in events:
                if event["type"] == "complete":
                    await _verify_owner(websocket, token, owner)
                await _send(websocket, event)
                if event["type"] == "error":
                    return _close_code(event["code"])
        return 1000

    async def watch_disconnect():
        # Observe disconnect while the provider handshake is pending. Hand over
        # the sole browser reader before sending started, so no audio is lost.
        pending = [asyncio.create_task(_message(websocket)), asyncio.create_task(upstream_ready.wait())]
        try:
            done, _ = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            if pending[0] in done:
                pending[0].result()
                raise ProtocolError()  # Audio is valid only after started.
        finally:
            with CancelScope(shield=True):
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
        reader_handoff.set()
        # Once finish ends the input iterator, keep observing the browser while
        # Deepgram flushes its final results. There is only one socket reader.
        await finished_input.wait()
        await _message(websocket)
        raise ProtocolError()  # No audio or control messages are valid after finish.

    tasks = [asyncio.create_task(relay()), asyncio.create_task(watch_disconnect())]
    try:
        done, _ = await asyncio.wait(tasks, timeout=MAX_RECORDING_SECONDS, return_when=asyncio.FIRST_COMPLETED)
        if not done:
            raise RecordingLimitError()
        if tasks[1] in done:
            tasks[1].result()
        return tasks[0].result()
    finally:
        with CancelScope(shield=True):
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


@router.websocket("/live")
async def live_transcription(websocket: WebSocket):
    if websocket.headers.get("origin") != frontend_origin():
        await websocket.close(code=1008)
        return
    token = websocket.cookies.get(COOKIE_NAME, "")
    try:
        owner, expires = await run_in_threadpool(_identity, websocket.app, token)
    except HTTPException:
        await websocket.close(code=1008)
        return
    except SQLAlchemyError:
        await websocket.close(code=1011)
        return

    session_id = str(uuid4())
    await websocket.accept()

    async def watch_auth():
        deadline = expires
        while True:
            await asyncio.sleep(min(AUTH_RECHECK_SECONDS, max(0, (deadline - utcnow()).total_seconds())))
            deadline = await _verify_owner(websocket, token, owner)

    code, tasks, error_event = 1000, [], None
    try:
        await _send(websocket, {"type": "ready", "session_id": session_id,
                               "accepted_mime_types": list(SUPPORTED_MIME_TYPES)})
        tasks = [asyncio.create_task(_record(websocket, session_id, owner, token)), asyncio.create_task(watch_auth())]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        if tasks[1] in done:
            tasks[1].result()
        code = tasks[0].result()
    except WebSocketDisconnect:
        pass
    except DeepgramError as error:
        code = _close_code(error.code)
        error_event = error.to_event(session_id)
    except SQLAlchemyError:
        code = 1011
        error_event = {"type": "error", "session_id": session_id,
                       "code": "database_unavailable", "message": "Session verification is unavailable."}
    finally:
        # ASGI/test servers can cancel a disconnected handler at every await.
        # Shield cleanup so provider and socket-reader tasks are still joined.
        with CancelScope(shield=True):
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if error_event is not None:
                with suppress(WebSocketDisconnect, RuntimeError, OSError):
                    await _send(websocket, error_event)
            with suppress(WebSocketDisconnect, RuntimeError, OSError, TimeoutError, asyncio.TimeoutError):
                await asyncio.wait_for(websocket.close(code=code), CLOSE_TIMEOUT)
