"""Database queries for journal history. Pass the authenticated owner's ID."""

from datetime import date
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import JournalEntry


def entries_in_range(
    session: Session, user_id: UUID, start: date, end: date
) -> list[JournalEntry]:
    """Return both boundary dates, newest first with stable ties."""
    if start > end:
        raise ValueError("The start date must be on or before the end date.")
    query = (
        select(JournalEntry)
        .where(JournalEntry.user_id == user_id, JournalEntry.journal_date.between(start, end))
        .order_by(JournalEntry.journal_date.desc(), JournalEntry.created_at.desc(),
                  JournalEntry.id.desc())
    )
    return list(session.scalars(query))
