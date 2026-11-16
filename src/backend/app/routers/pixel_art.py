from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth import current_user
from app.database import get_session
from app.models import JournalEntry, JournalImage, User
from app.schemas.pixel_art import PixelArtMetadata, PixelArtRequest, PixelArtResponse
from app.services._groq import (
    AIInvalidResponseError, AIServiceNotConfiguredError, AIServiceUnavailableError, EmptyJournalError,
)
from app.services.image_lifecycle import generation_locks
from app.services.pixel_art import build_pixel_art_prompt
from app.services.pixellab import PixelArtError, PixelArtRateLimited

router = APIRouter(prefix="/api/entries", tags=["pixel art"])


def service_error(error: PixelArtError) -> HTTPException:
    headers = {"Retry-After": "30"} if error.status_code == 429 else None
    return HTTPException(error.status_code, error.detail, headers=headers)


def owned(session, entry_id, user_id, *, lock=False):
    statement = select(JournalEntry).where(JournalEntry.id == entry_id, JournalEntry.user_id == user_id)
    if lock:
        statement = statement.with_for_update()
    entry = session.scalar(statement)
    if entry is None:
        raise HTTPException(404, "Journal entry was not found.")
    return entry


def metadata(image: JournalImage) -> PixelArtResponse:
    return PixelArtResponse(entry_id=image.entry_id, image=PixelArtMetadata(
        id=image.id, created_at=image.created_at,
        content_url=f"/api/entries/{image.entry_id}/pixel-art/content",
    ))


@router.post("/{entry_id}/pixel-art", response_model=PixelArtResponse,
             response_model_exclude_none=True, status_code=201,
             responses={200: {"model": PixelArtResponse, "description": "Previously generated image"}})
def generate_pixel_art(entry_id: UUID, payload: PixelArtRequest, request: Request, response: Response,
                       user: User = Depends(current_user), session: Session = Depends(get_session)):
    user_id = user.id
    entry = owned(session, entry_id, user_id)
    # Do not keep the authentication/read transaction open during provider calls.
    session.rollback()
    state = request.app.state
    try:
        with generation_locks(state.engine, entry_id, user_id):
            with state.session_factory() as read_session:
                entry = owned(read_session, entry_id, user_id)
                if entry.image is not None:
                    response.status_code = 200
                    return metadata(entry.image)
                content, updated_at = entry.content, entry.updated_at
            if not state.pixel_art_enabled:
                raise PixelArtError()
            if not state.pixel_art_capacity.acquire(blocking=False):
                raise PixelArtRateLimited()
            try:
                moment = state.moment_extractor.extract(content)
                prompt = build_pixel_art_prompt(moment)
                data = state.pixellab_client.generate(prompt)
                image_id = uuid4()
                key = None
                try:
                    with state.session_factory() as write_session:
                        entry = owned(write_session, entry_id, user_id, lock=True)
                        if entry.content != content or entry.updated_at != updated_at:
                            raise HTTPException(409, "Journal entry changed during generation. Please retry.")
                        if entry.image is not None:
                            raise HTTPException(409, "Journal entry already has an image.")
                        key = state.image_storage.save(entry_id, image_id, data)
                        image = JournalImage(id=image_id, entry_id=entry_id, image_url=key, file_format="png")
                        write_session.add(image)
                        write_session.flush()
                        result = metadata(image)
                        result.representation = moment.kind
                        write_session.commit()
                except Exception:
                    if key is not None:
                        # A lost connection during COMMIT has an uncertain outcome.
                        # Keep a possibly referenced file until DB reconciliation
                        # can establish whether it is safe to delete.
                        try:
                            with state.session_factory() as recovery_session:
                                referenced = recovery_session.scalar(select(JournalImage.id).where(
                                    JournalImage.image_url == key,
                                ))
                            if referenced is None:
                                state.image_storage.delete(key)
                        except SQLAlchemyError:
                            pass
                    raise
                return result
            finally:
                state.pixel_art_capacity.release()
    except EmptyJournalError as error:
        raise HTTPException(422, "Journal entry cannot be empty.") from error
    except AIInvalidResponseError as error:
        raise HTTPException(502, "AI service returned an invalid response.") from error
    except (AIServiceNotConfiguredError, AIServiceUnavailableError) as error:
        raise HTTPException(503, "AI image service is unavailable. Please try again later.") from error
    except PixelArtError as error:
        raise service_error(error) from error


@router.get("/{entry_id}/pixel-art", response_model=PixelArtResponse, response_model_exclude_none=True)
def get_pixel_art(entry_id: UUID, user: User = Depends(current_user), session: Session = Depends(get_session)):
    entry = owned(session, entry_id, user.id)
    if entry.image is None:
        raise HTTPException(404, "Journal image was not found.")
    return metadata(entry.image)


@router.get("/{entry_id}/pixel-art/content")
def get_pixel_art_content(entry_id: UUID, request: Request,
                          user: User = Depends(current_user), session: Session = Depends(get_session)):
    entry = owned(session, entry_id, user.id, lock=True)
    if entry.image is None:
        raise HTTPException(404, "Journal image was not found.")
    try:
        data = request.app.state.image_storage.read(entry.image.image_url)
    except PixelArtError as error:
        raise service_error(error) from error
    if data is None:
        raise HTTPException(404, "Journal image was not found.")
    return Response(data, media_type="image/png", headers={"X-Content-Type-Options": "nosniff"})
