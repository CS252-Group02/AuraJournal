"""Seed and demonstrate per-user queries on TEST_DATABASE_URL."""

import json
import os
from datetime import date, datetime, timezone
from uuid import uuid5

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.database import make_engine
from app.models import JournalEntry
from app.services.journal_history import current_streak, daily_entry_counts
from scripts.seed_week7 import ALICE, BOB, seed_week7


def seed_calendar_samples(session: Session) -> None:
    """Add repeatable leap-day/backdated examples in the caller's transaction."""
    seed_week7(session)
    for owner, day in [(ALICE, "2024-02-28"), (ALICE, "2024-02-29"),
                       (ALICE, "2024-03-01"), (BOB, "2024-02-29")]:
        entry_id = uuid5(owner, f"calendar/{day}")
        content = "Backdated calendar sample"
        session.execute(insert(JournalEntry).values(
            id=entry_id, user_id=owner, journal_date=date.fromisoformat(day),
            content=content, created_at=datetime(2026, 11, 4, tzinfo=timezone.utc),
            updated_at=datetime(2026, 11, 4, tzinfo=timezone.utc),
        ).on_conflict_do_nothing(index_elements=[JournalEntry.id]))
        saved = session.get(JournalEntry, entry_id)
        if (saved.user_id, saved.journal_date, saved.content) != (
                owner, date.fromisoformat(day), content):
            raise ValueError("A calendar sample entry ID has conflicting data.")


def calendar_report(session: Session) -> dict:
    report = {}
    for name, owner in [("Alice", ALICE), ("Bob", BOB)]:
        counts = daily_entry_counts(session, owner, date(2026, 10, 30), date(2026, 11, 3))
        report[name] = {
            "counts": {day.isoformat(): count for day, count in counts.items()},
            "streaks": {f"2026-11-{day:02d}": current_streak(session, owner, date(2026, 11, day))
                        for day in [1, 2, 3, 5]},
            "leap_day_streak": current_streak(session, owner, date(2024, 3, 1)),
        }
    return report


def main():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        raise SystemExit("Set TEST_DATABASE_URL to a disposable PostgreSQL database migrated to head.")
    engine = make_engine(url)
    try:
        with Session(engine) as session:
            with session.begin():
                seed_calendar_samples(session)
            print(json.dumps(calendar_report(session), indent=2))
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
