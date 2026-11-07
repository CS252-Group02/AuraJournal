from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_session
from app.auth import current_user
from app.models import JournalEntry, User
from app.schemas.entries import EntryCreate, EntryResponse

router = APIRouter(prefix="/api/entries", tags=["entries"])


@router.post("", response_model=EntryResponse, status_code=201)
def create_entry(payload: EntryCreate, session: Session = Depends(get_session), user: User = Depends(current_user)):
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=422, detail="Entry content cannot be blank.")
    entry = JournalEntry(content=content, user_id=user.id)
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
