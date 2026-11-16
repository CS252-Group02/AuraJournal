from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_session
from app.auth import current_user
from app.models import JournalEntry, User
from app.schemas.entries import EntryCreate, EntryResponse, EntryUpdate

router = APIRouter(prefix="/api/entries", tags=["entries"])


@router.post("", response_model=EntryResponse, status_code=201)
def create_entry(payload: EntryCreate, session: Session = Depends(get_session), user: User = Depends(current_user)):
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=422, detail="Entry content cannot be blank.")
    dates = payload.model_dump(include={"journal_date"}, exclude_unset=True)
    entry = JournalEntry(content=content, user_id=user.id, **dates)
    session.add(entry)
    session.commit()
    session.refresh(entry)
    return entry


@router.get("", response_model=list[EntryResponse])
def list_entries(session: Session = Depends(get_session), user: User = Depends(current_user)):
    return list(session.scalars(
        select(JournalEntry)
        .where(JournalEntry.user_id == user.id)
        .order_by(JournalEntry.created_at.desc(), JournalEntry.id.desc())
    ))


@router.get("/by-date", response_model=list[EntryResponse])
def entries_by_date(date: date, session: Session = Depends(get_session), user: User = Depends(current_user)):
    from app.services.journal_history import entries_in_range
    return entries_in_range(session, user.id, date, date)


def owned_entry(entry_id: UUID, session: Session, user: User) -> JournalEntry:
    entry = session.scalar(select(JournalEntry).where(
        JournalEntry.id == entry_id, JournalEntry.user_id == user.id,
    ).with_for_update())
    if entry is None:
        raise HTTPException(404, "Journal entry was not found.")
    return entry


@router.get("/{entry_id}", response_model=EntryResponse)
def get_entry(entry_id: UUID, session: Session = Depends(get_session), user: User = Depends(current_user)):
    return owned_entry(entry_id, session, user)


@router.patch("/{entry_id}", response_model=EntryResponse)
def update_entry(entry_id: UUID, payload: EntryUpdate, request: Request,
                 session: Session = Depends(get_session), user: User = Depends(current_user)):
    entry = owned_entry(entry_id, session, user)
    old_image_key = None
    updates = payload.model_dump(exclude_unset=True)
    if "content" in updates:
        content = updates["content"].strip()
        if not content:
            raise HTTPException(422, "Entry content cannot be blank.")
        if entry.content != content:
            entry.content = content
            # Saved AI output describes the previous content and must be regenerated.
            entry.ai_summary = None
            entry.ai_reflection_question = None
            entry.ai_summarized_at = None
            if entry.image is not None:
                old_image_key = entry.image.image_url
                session.delete(entry.image)
    if "journal_date" in updates:
        entry.journal_date = updates["journal_date"]
    session.commit()
    session.refresh(entry)
    if old_image_key is not None:
        request.app.state.image_storage.delete(old_image_key)
    return entry


@router.delete("/{entry_id}", status_code=204)
def delete_entry(entry_id: UUID, request: Request, session: Session = Depends(get_session), user: User = Depends(current_user)):
    entry = owned_entry(entry_id, session, user)
    old_image_key = entry.image.image_url if entry.image is not None else None
    session.delete(entry)
    session.commit()
    if old_image_key is not None:
        request.app.state.image_storage.delete(old_image_key)
    return Response(status_code=204)
