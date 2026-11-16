from datetime import date

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import JournalEntry
from scripts.demo_calendar import calendar_report, seed_calendar_samples
from scripts.seed_week7 import ALICE, BOB
from app.services.journal_history import current_streak, daily_entry_counts


def test_repeatable_calendar_samples_and_expected_results(migrated_engine):
    with Session(migrated_engine) as session:
        with session.begin():
            seed_calendar_samples(session)
        first = calendar_report(session)
        session.rollback()
        with session.begin():
            seed_calendar_samples(session)
        assert calendar_report(session) == first
        assert session.scalar(select(func.count()).select_from(JournalEntry)) == 12
        assert list(first['Alice']['streaks'].values()) == [3, 3, 1, 0]
        assert list(first['Bob']['streaks'].values()) == [1, 1, 2, 0]
        assert first['Alice']['counts']['2026-10-31'] == 2
        assert '2026-11-02' not in first['Alice']['counts']
        assert first['Bob']['counts']['2026-11-02'] == 1
        assert first['Alice']['leap_day_streak'] == 3
        assert first['Bob']['leap_day_streak'] == 1
        assert daily_entry_counts(session, ALICE, date(2024, 2, 28), date(2024, 3, 1)) == {
            date(2024, 2, 28): 1, date(2024, 2, 29): 1, date(2024, 3, 1): 1}


@pytest.mark.parametrize('start,end', [(date(2023, 12, 31), date(2024, 1, 1)),
                                     (date(2024, 2, 28), date(2024, 3, 1))])
def test_streak_crosses_year_and_leap_day_boundaries(migrated_engine, start, end):
    from datetime import timedelta
    with Session(migrated_engine) as session:
        seed_calendar_samples(session)
        day = start
        while day <= end:
            session.add(JournalEntry(user_id=BOB, journal_date=day, content='Boundary'))
            day += timedelta(days=1)
        session.flush()
        assert current_streak(session, BOB, end) == (end - start).days + 1
