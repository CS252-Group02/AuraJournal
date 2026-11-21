from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import current_user
from app.database import get_session
from app.models import JournalEntry, JournalImage, PixelArtJob, User
from app.schemas.entries import JournalDate
from app.schemas.pixel_art import (
    DatedPixelArt, PixelArtMetadata, PixelArtRequest, PixelArtResponse,
    PixelMemoryDay, PixelMemoryEntry, PixelMemoryFeed, PixelArtStatusResponse,
)
from app.services.journal_images import (
    has_owned_image_reference, recent_journal_images, recent_journal_memories,
)
from app.services.pixel_status import generation_status
from app.services.pixellab import PixelArtError

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
    if not has_owned_image_reference(image):
        raise HTTPException(404, "Journal image was not found.")
    return PixelArtResponse(entry_id=image.entry_id, image=PixelArtMetadata(
        id=image.id, created_at=image.created_at,
        content_url=f"/api/entries/{image.entry_id}/pixel-art/content",
    ))


@router.post("/{entry_id}/pixel-art", response_model=PixelArtResponse,
             response_model_exclude_none=True, deprecated=True,
             responses={409: {"description": "Automatic job pending or processing"},
                        503: {"description": "Generation unavailable or terminal"}})
def generate_pixel_art(entry_id: UUID, payload: PixelArtRequest,
                       user: User = Depends(current_user), session: Session = Depends(get_session)):
    """Deprecated compatibility check. It never schedules or submits AI work."""
    entry = owned(session, entry_id, user.id)
    if entry.image is not None:
        return metadata(entry.image)
    job = session.scalar(select(PixelArtJob).where(
        PixelArtJob.entry_id == entry_id, PixelArtJob.source_version == entry.content_version,
    ))
    if job is not None and job.status in {"pending", "processing"}:
        raise HTTPException(409, "Automatic image generation is queued or running. Check for a saved image.",
                            headers={"Retry-After": "5"})
    raise HTTPException(503, "Automatic image generation is unavailable. Your journal is saved.")


@router.get("/pixel-art/recent", response_model=list[DatedPixelArt])
def recent_pixel_art(as_of: JournalDate, user: User = Depends(current_user),
                     session: Session = Depends(get_session)):
    return [
        DatedPixelArt(journal_date=day, entry_id=image.entry_id, image=metadata(image).image)
        for day, image in recent_journal_images(session, user.id, as_of)
        if has_owned_image_reference(image)
    ]


@router.get("/pixel-art/memories", response_model=PixelMemoryFeed)
def pixel_memories(as_of: JournalDate, request: Request, user: User = Depends(current_user),
                   session: Session = Depends(get_session)):
    groups = {}
    for day, entry_id, image, job in recent_journal_memories(session, user.id, as_of, include_jobs=True):
        available = image is not None and has_owned_image_reference(image)
        groups.setdefault(day, []).append(PixelMemoryEntry(
            entry_id=entry_id, image=metadata(image).image if available else None,
            generation=generation_status(request.app.state.image_storage, image, job),
        ))
    return PixelMemoryFeed(as_of=as_of, days=[
        PixelMemoryDay(journal_date=day, entries=entries) for day, entries in groups.items()
    ])


@router.get("/{entry_id}/pixel-art/status", response_model=PixelArtStatusResponse)
def get_pixel_art_status(entry_id: UUID, request: Request, user: User = Depends(current_user),
                         session: Session = Depends(get_session)):
    entry = owned(session, entry_id, user.id)
    job = session.scalar(select(PixelArtJob).where(
        PixelArtJob.entry_id == entry_id, PixelArtJob.source_version == entry.content_version,
    ))
    available = entry.image is not None and has_owned_image_reference(entry.image)
    return PixelArtStatusResponse(
        entry_id=entry.id, journal_date=entry.journal_date,
        image=metadata(entry.image).image if available else None,
        generation=generation_status(request.app.state.image_storage, entry.image, job),
    )


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
    if entry.image is None or not has_owned_image_reference(entry.image):
        raise HTTPException(404, "Journal image was not found.")
    try:
        data = request.app.state.image_storage.read(entry.image.image_url)
    except PixelArtError as error:
        raise service_error(error) from error
    if data is None:
        raise HTTPException(404, "Journal image was not found.")
    return Response(data, media_type="image/png", headers={"X-Content-Type-Options": "nosniff"})
