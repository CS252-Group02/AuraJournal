"""Load the Week 7 examples into the database named by TEST_DATABASE_URL."""

import os
from datetime import date, datetime, timezone
from pathlib import Path
from uuid import UUID, uuid5

from dotenv import load_dotenv
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.database import make_engine
from app.models import JournalEntry, User


ALICE = UUID("00000000-0000-4000-8000-0000000000a7")
BOB = UUID("00000000-0000-4000-8000-0000000000b7")
OWNERS = {ALICE: "week7.alice@example.test", BOB: "week7.bob@example.test"}
# A second entry on the same day, a month boundary and gaps with a different owner.
SAMPLES = [
    (ALICE, "2026-10-30", 2, "I planned my study week."),
    (ALICE, "2026-10-31", 2, "I finished the first exercise."),
    (ALICE, "2026-10-31", 8, "An evening walk helped me focus."),
    (ALICE, "2026-11-01", 2, "I reviewed my notes."),
    (ALICE, "2026-11-03", 2, "I returned after a day off."),
    (BOB, "2026-10-31", 4, "I tried a new recipe."),
    (BOB, "2026-11-02", 4, "I shared lunch with a friend."),
    (BOB, "2026-11-03", 4, "I went for a short run."),
]


def seed_week7(session: Session) -> None:
    """Insert missing fixtures in the caller's transaction. Reject ID collisions."""
    for owner, email in OWNERS.items():
        session.execute(insert(User).values(id=owner, email=email, password_hash="!disabled")
                        .on_conflict_do_nothing(index_elements=[User.id]))
        user = session.get(User, owner)
        if user.email != email or user.password_hash != "!disabled":
            raise ValueError("A Week 7 sample user ID is already in use.")

    for owner, day, hour, content in SAMPLES:
        journal_date = date.fromisoformat(day)
        timestamp = datetime.fromisoformat(day).replace(hour=hour, tzinfo=timezone.utc)
        entry_id = uuid5(owner, f"{day}/{hour}")
        session.execute(insert(JournalEntry).values(
            id=entry_id, user_id=owner, journal_date=journal_date, content=content,
            created_at=timestamp, updated_at=timestamp,
        ).on_conflict_do_nothing(index_elements=[JournalEntry.id]))
        entry = session.get(JournalEntry, entry_id)
        if (entry.user_id, entry.journal_date, entry.content) != (owner, journal_date, content):
            raise ValueError("A Week 7 sample entry ID has conflicting data.")


if __name__ == "__main__":
    load_dotenv(Path(__file__).resolve().parents[3] / ".env")
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        raise SystemExit("Set TEST_DATABASE_URL to the disposable PostgreSQL database first.")
    engine = make_engine(url)
    try:
        with Session(engine) as session, session.begin():
            seed_week7(session)
    finally:
        engine.dispose()
    print(f"Week 7 samples ready: {len(OWNERS)} users, {len(SAMPLES)} journals.")
