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
    from uuid import uuid4
    migrate(isolated_engine, '0007')
    with Session(isolated_engine) as session:
        # Seed the historical schema explicitly: current ORM models also include
        # content_version, which did not exist before migration 0010.
        entry_id = uuid4()
        created = session.scalar(text("""
            INSERT INTO journal_entries
                (id,user_id,content,journal_date,ai_summary,ai_reflection_question)
            VALUES (:id,:owner,'Keep my journal','2026-11-16','Saved AI summary','What helped?')
            RETURNING created_at
        """), {"id": entry_id, "owner": DEVELOPMENT_USER_ID})
        session.execute(text("""
            INSERT INTO journal_images (id,entry_id,image_url,file_format)
            VALUES (:id,:entry,'pixel-art/legacy-reference.png','png')
        """), {"id": uuid4(), "entry": entry_id})
        session.execute(text("""
            INSERT INTO mood_records (id,entry_id,valence,arousal)
            VALUES (:id,:entry,0.5,0.25)
        """), {"id": uuid4(), "entry": entry_id})
        # Seed the historical schema without the source_dates column added in 0009.
        session.execute(text("""
            INSERT INTO weekly_reflections (user_id, period_start, summary, questions)
            VALUES (:owner, '2026-11-16', 'Saved week',
                    '["What helped?", "What next?"]'::jsonb)
        """), {'owner': DEVELOPMENT_USER_ID})
        session.commit()
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
