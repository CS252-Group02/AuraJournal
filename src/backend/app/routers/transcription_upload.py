"""Authenticated, transient WebM/Opus uploads using prerecorded recognition."""

import asyncio
from email.message import Message
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from app.auth import COOKIE_NAME, authenticated_session, current_user
from app.database import get_session
from app.limits import consume_ai_budget
from app.models import User
from app.schemas.transcription_upload import UploadedTranscript
from app.services import DeepgramError
from app.services.async_deadline import deadline
from app.upload_policy import AUDIO_UPLOAD_PATH

router = APIRouter(tags=["transcription"])
MAX_AUDIO_BYTES = 10 * 1024 * 1024
UPLOAD_TIMEOUT = 30
TRANSCRIPTION_TIMEOUT = 60
CHUNK_BYTES = 64 * 1024
WEBM_SIGNATURE = b"\x1a\x45\xdf\xa3"


def upload_owner(request: Request, user: User = Depends(current_user), session: Session = Depends(get_session)) -> UUID:
    owner = user.id
    consume_ai_budget(request, user, session)
    session.rollback()  # No DB connection is held during upload or recognition.
    return owner


def verify_owner(request: Request, owner: UUID):
    with request.app.state.session_factory() as session:
        user, _ = authenticated_session(session, request.cookies.get(COOKIE_NAME, ""))
        if user.id != owner:
            raise HTTPException(401, "Please log in.")


def validate_mime(value: str):
    message = Message()
    message["content-type"] = value
    params = message.get_params() or []
    if (message.get_content_type().lower() != "audio/webm" or len(params) != 2
            or params[1][0].lower() != "codecs" or str(params[1][1]).lower() != "opus"):
        raise HTTPException(415, "Use a WebM recording with the Opus codec.")


async def read_audio(request: Request) -> bytearray:
    declared = request.headers.get("content-length")
    if declared is not None:
        if not declared.isascii() or not declared.isdecimal():
            raise HTTPException(400, "Invalid recording length.")
        if len(declared) > 20 or int(declared) > MAX_AUDIO_BYTES:
            raise HTTPException(413, "Recording exceeds the 10 MiB limit.")
    audio = bytearray()
    async for chunk in request.stream():
        if len(audio) + len(chunk) > MAX_AUDIO_BYTES:
            raise HTTPException(413, "Recording exceeds the 10 MiB limit.")
        audio.extend(chunk)
    if not audio or not audio.startswith(WEBM_SIGNATURE):
        raise HTTPException(422, "Audio is empty, unsupported, or could not be decoded. Please record again.")
    return audio


def provider_error(event):
    code = event.get("code")
    status = {"invalid_audio": 422, "invalid_response": 502, "timeout": 504, "rate_limited": 429}.get(code, 503)
    detail = {
        422: "Audio is empty, unsupported, or could not be decoded. Please record again.",
        502: "Speech service returned an invalid transcript. Please try again.",
        504: "Transcription timed out. Please try again.",
        429: "Speech service is busy. Please try again later.",
        503: "Speech service is unavailable. Please try again later.",
    }[status]
    raise HTTPException(status, detail, headers={"Retry-After": "5"} if status == 429 else None)


async def recognize(request: Request, audio: bytearray) -> UploadedTranscript:
    try:
        result = await request.app.state.deepgram_recording_client.transcribe(bytes(audio))
    except DeepgramError as error:
        provider_error({"code": error.code})
    return UploadedTranscript(transcript=result.transcript, outcome=result.outcome)


async def recognize_connected(request: Request, audio: bytearray):
    async def disconnected():
        while (await request.receive())["type"] != "http.disconnect":
            pass

    work = asyncio.create_task(recognize(request, audio))
    disconnect = asyncio.create_task(disconnected())
    try:
        done, _ = await asyncio.wait((work, disconnect), return_when=asyncio.FIRST_COMPLETED)
        if disconnect in done:
            disconnect.result()
            raise ClientDisconnect()
        return work.result()
    finally:
        work.cancel()
        disconnect.cancel()
        await asyncio.gather(work, disconnect, return_exceptions=True)


@router.post(AUDIO_UPLOAD_PATH, response_model=UploadedTranscript, responses={
    status: {"description": description} for status, description in {
        400: "Invalid recording length or interrupted upload", 401: "Invalid account session",
        403: "Origin or CSRF rejected", 413: "Recording too large", 415: "Unsupported recording format",
        422: "Empty or invalid audio", 429: "Request budget exceeded", 502: "Invalid or incomplete transcript",
        503: "Speech service or database unavailable", 504: "Upload or transcription timed out",
    }.items()
}, openapi_extra={
    "requestBody": {"required": True, "content": {
        "audio/webm;codecs=opus": {"schema": {"type": "string", "format": "binary"}},
    }},
})
async def upload_transcription(request: Request, owner: UUID = Depends(upload_owner)):
    """Transcribe raw WebM/Opus bytes without storing audio or creating a journal."""
    validate_mime(request.headers.get("content-type", ""))
    try:
        audio = await deadline(read_audio(request), UPLOAD_TIMEOUT)
        await run_in_threadpool(verify_owner, request, owner)
        result = await deadline(recognize_connected(request, audio), TRANSCRIPTION_TIMEOUT)
        await run_in_threadpool(verify_owner, request, owner)
        return result
    except ClientDisconnect:
        raise HTTPException(400, "Recording upload was interrupted.") from None
    except (TimeoutError, asyncio.TimeoutError):
        raise HTTPException(504, "Recording upload or transcription timed out. Please try again.") from None
