from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.models import JournalEntry, JournalImage, MoodRecord, WeeklyReflection
from app.config import DEVELOPMENT_USER_ID
from conftest import migrate
from scripts.setup_data import setup
from scripts.explain_journal_queries import benchmark


def test_setup_migrates_empty_database_and_is_repeatable(isolated_engine):
    first = setup(isolated_engine)
    assert setup(isolated_engine) == first
    with Session(isolated_engine) as session:
        assert session.scalar(select(func.count()).select_from(JournalEntry)) == 12


def test_query_measurement_rolls_back_synthetic_data(migrated_engine):
    result = benchmark(migrated_engine, rows=200)
    assert set(result['plans']) == {'day_lookup', 'month_counts'}
    with Session(migrated_engine) as session:
        assert session.scalar(select(func.count()).select_from(JournalEntry)) == 0


def test_security_upgrade_preserves_owned_ai_and_child_records(isolated_engine):
    from datetime import date
    migrate(isolated_engine, '0007')
    with Session(isolated_engine) as session:
        entry = JournalEntry(user_id=DEVELOPMENT_USER_ID, content='Keep my journal',
                             journal_date=date(2026, 11, 16), ai_summary='Saved AI summary',
                             ai_reflection_question='What helped?')
        entry.image = JournalImage(image_url='pixel-art/legacy-reference.png')
        entry.mood_record = MoodRecord(valence=0.5, arousal=0.25)
        session.add(entry)
        # Seed the historical schema without the source_dates column added in 0009.
        session.execute(text("""
            INSERT INTO weekly_reflections (user_id, period_start, summary, questions)
            VALUES (:owner, '2026-11-16', 'Saved week',
                    '["What helped?", "What next?"]'::jsonb)
        """), {'owner': DEVELOPMENT_USER_ID})
        session.commit()
        entry_id, created = entry.id, entry.created_at
    migrate(isolated_engine)
    migrate(isolated_engine)
    with Session(isolated_engine) as session:
        saved = session.get(JournalEntry, entry_id)
        assert (saved.content, saved.journal_date, saved.created_at) == (
            'Keep my journal', date(2026, 11, 16), created)
        assert saved.ai_summary == 'Saved AI summary'
        assert saved.ai_reflection_question == 'What helped?'
        assert saved.image.image_url == 'pixel-art/legacy-reference.png'
        assert (saved.mood_record.valence, saved.mood_record.arousal) == (0.5, 0.25)
        reflection = session.get(WeeklyReflection, (DEVELOPMENT_USER_ID, date(2026, 11, 16)))
        assert reflection.summary == 'Saved week'
        assert reflection.questions == ['What helped?', 'What next?']
        assert reflection.source_dates is None
