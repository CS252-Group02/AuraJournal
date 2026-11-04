from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_session
from app.config import DEVELOPMENT_USER_ID
from app.models import JournalEntry
from app.schemas.entries import EntryCreate, EntryResponse

router = APIRouter(prefix="/api/entries", tags=["entries"])


@router.post("", response_model=EntryResponse, status_code=201)
def create_entry(payload: EntryCreate, session: Session = Depends(get_session)):
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=422, detail="Entry content cannot be blank.")
    entry = JournalEntry(content=content, user_id=DEVELOPMENT_USER_ID)
    session.add(entry)
    session.commit()
    session.refresh(entry)
    return entry


@router.get("", response_model=list[EntryResponse])
def list_entries(session: Session = Depends(get_session)):
    return list(session.scalars(
        select(JournalEntry)
        .where(JournalEntry.user_id == DEVELOPMENT_USER_ID)
        .order_by(JournalEntry.created_at.desc(), JournalEntry.id.desc())
    ))
