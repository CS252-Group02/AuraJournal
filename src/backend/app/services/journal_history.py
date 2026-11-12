"""Database queries for journal history. Pass the authenticated owner's ID."""

from datetime import date
from uuid import UUID

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.models import JournalEntry


def _owner_date_range(user_id: UUID, start: date, end: date):
    if start > end:
        raise ValueError("The start date must be on or before the end date.")
    return and_(JournalEntry.user_id == user_id, JournalEntry.journal_date.between(start, end))


def entries_in_range(
    session: Session, user_id: UUID, start: date, end: date
) -> list[JournalEntry]:
    """Return both boundary dates, newest first with stable ties."""
    query = (
        select(JournalEntry)
        .where(_owner_date_range(user_id, start, end))
        .order_by(JournalEntry.journal_date.desc(), JournalEntry.created_at.desc(),
                  JournalEntry.id.desc())
    )
    return list(session.scalars(query))


def daily_entry_counts(
    session: Session, user_id: UUID, start: date, end: date
) -> dict[date, int]:
    """Return occupied days in ascending order. A missing date has count zero."""
    day = JournalEntry.journal_date
    query = (
        select(day, func.count())
        .where(_owner_date_range(user_id, start, end))
        .group_by(day)
        .order_by(day)
    )
    return {journal_day: count for journal_day, count in session.execute(query)}
