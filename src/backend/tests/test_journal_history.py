from datetime import date, datetime, timezone
from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from app.models import JournalEntry
from app.services.journal_history import current_streak, daily_entry_counts, entries_in_range
from scripts.seed_week7 import ALICE, BOB, seed_week7


@pytest.fixture
def history_session(migrated_engine):
    with Session(migrated_engine) as session:
        seed_week7(session)
        session.commit()
        yield session


def test_range_includes_both_dates_and_only_the_owner(history_session):
    start, end = date(2026, 10, 31), date(2026, 11, 1)
    entries = entries_in_range(history_session, ALICE, start, end)
    assert [e.content for e in entries] == [
        "I reviewed my notes.", "An evening walk helped me focus.", "I finished the first exercise.",
    ]
    assert all(e.user_id == ALICE for e in entries)
    assert [e.content for e in entries_in_range(history_session, BOB, start, start)] == [
        "I tried a new recipe."
    ]
    assert entries_in_range(history_session, uuid4(), start, end) == []


def test_range_uses_selected_day_and_sorts_equal_timestamps(history_session):
    day = date(2020, 2, 29)
    created = datetime(2026, 11, 1, tzinfo=timezone.utc)
    ids = [UUID(int=7), UUID(int=8)]
    for entry_id in ids:
        history_session.add(JournalEntry(id=entry_id, user_id=ALICE, journal_date=day,
                                         content="Backdated", created_at=created))
    history_session.flush()
    assert [e.id for e in entries_in_range(history_session, ALICE, day, day)] == ids[::-1]


def test_range_rejects_reversed_dates(history_session):
    with pytest.raises(ValueError, match="start date"):
        entries_in_range(history_session, ALICE, date(2026, 11, 1), date(2026, 10, 31))


def test_calendar_counts_entries_per_owner_and_day(history_session):
    start, end = date(2026, 10, 31), date(2026, 11, 2)
    counts = daily_entry_counts(history_session, ALICE, start, end)
    assert list(counts.items()) == [(start, 2), (date(2026, 11, 1), 1)]
    assert counts.get(end, 0) == 0
    assert daily_entry_counts(history_session, BOB, start, end) == {start: 1, end: 1}
    assert daily_entry_counts(history_session, ALICE, end, end) == {}
    with pytest.raises(ValueError, match="start date"):
        daily_entry_counts(history_session, ALICE, end, start)


@pytest.mark.parametrize(("owner", "as_of", "expected"), [
    (ALICE, date(2026, 10, 29), 0),  # All entries are in the future.
    (ALICE, date(2026, 10, 31), 2),  # Two entries on Oct 31 count as one day.
    (ALICE, date(2026, 11, 1), 3),   # Oct 30, Oct 31, Nov 1.
    (ALICE, date(2026, 11, 2), 3),   # Today is still open.
    (ALICE, date(2026, 11, 3), 1),   # Bob's Nov 2 entry cannot bridge Alice's gap.
    (ALICE, date(2026, 11, 5), 0),   # Neither today nor yesterday has an entry.
    (BOB, date(2026, 11, 3), 2),
    (uuid4(), date(2026, 11, 1), 0),
])
def test_current_streak(history_session, owner, as_of, expected):
    assert current_streak(history_session, owner, as_of) == expected
