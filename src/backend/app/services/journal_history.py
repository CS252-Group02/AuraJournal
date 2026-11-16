"""Database queries for journal history. Pass the authenticated owner's ID."""

from datetime import date
from uuid import UUID

from sqlalchemy import and_, func, select, text
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


def current_streak(session: Session, user_id: UUID, as_of: date) -> int:
    """Count consecutive journal days through as_of, allowing today to be unfinished."""
    # Each step tests one earlier calendar day using the owner/date index.
    # EXISTS counts a day once even when multiple entries share it.
    query = text("""
        WITH RECURSIVE streak(day) AS (
            (SELECT journal_date
             FROM journal_entries
             WHERE user_id = :owner
               AND journal_date BETWEEN CAST(:as_of AS date) - 1 AND CAST(:as_of AS date)
             ORDER BY journal_date DESC
             LIMIT 1)
            UNION ALL
            SELECT streak.day - 1
            FROM streak
            WHERE EXISTS (
                SELECT 1 FROM journal_entries
                WHERE user_id = :owner AND journal_date = streak.day - 1
            )
        )
        SELECT count(*) FROM streak
    """)
    return session.execute(query, {"owner": user_id, "as_of": as_of}).scalar_one()
