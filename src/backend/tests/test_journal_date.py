from datetime import date, datetime, timezone
from uuid import uuid4

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import DEVELOPMENT_USER_ID
from app.models import JournalEntry
from conftest import migrate


@pytest.mark.parametrize("created_at, expected_date", [
    (datetime(2026, 11, 11, 16, 59, tzinfo=timezone.utc), date(2026, 11, 11)),
    (datetime(2026, 11, 11, 17, 0, tzinfo=timezone.utc), date(2026, 11, 12)),
])
def test_journal_date_backfill_preserves_existing_data(
    isolated_engine, created_at, expected_date
):
    migrate(isolated_engine, "0004")
    entry_id = uuid4()
    updated_at = datetime(2026, 11, 12, 8, tzinfo=timezone.utc)
    with isolated_engine.begin() as connection:
        connection.execute(text("""
            INSERT INTO journal_entries (
                id, user_id, content, created_at, updated_at,
                ai_summary, ai_reflection_question, ai_summarized_at
            ) VALUES (
                :id, :user_id, 'Before journal dates', :created_at, :updated_at,
                'Existing summary', 'Existing question?', :updated_at
            )
        """), {
            "id": entry_id, "user_id": DEVELOPMENT_USER_ID,
            "created_at": created_at, "updated_at": updated_at,
        })
    migrate(isolated_engine)

    with Session(isolated_engine) as session:
        entry = session.get(JournalEntry, entry_id)
        assert entry.user_id == DEVELOPMENT_USER_ID
        assert entry.content == "Before journal dates"
        assert entry.journal_date == expected_date
        assert entry.created_at == created_at
        assert entry.updated_at == updated_at
        assert entry.ai_summary == "Existing summary"
        assert entry.ai_reflection_question == "Existing question?"
        assert entry.ai_summarized_at == updated_at
        # Re-running upgrade must not recompute a subsequently selected date.
        entry.journal_date = date(2025, 12, 31)
        session.commit()
        selected_updated_at = entry.updated_at

    migrate(isolated_engine)
    with Session(isolated_engine) as session:
        entry = session.get(JournalEntry, entry_id)
        assert entry.journal_date == date(2025, 12, 31)
        assert entry.created_at == created_at
        assert entry.updated_at == selected_updated_at


@pytest.mark.parametrize("session_timezone", ["Pacific/Honolulu", "Pacific/Kiritimati"])
def test_sql_default_uses_utc_plus_seven(migrated_engine, session_timezone):
    with migrated_engine.begin() as connection:
        connection.execute(text("SELECT set_config('TimeZone', :zone, true)"), {
            "zone": session_timezone,
        })
        expected = connection.scalar(text(
            "SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date"
        ))
        actual = connection.scalar(text("""
            INSERT INTO journal_entries (id, user_id, content)
            VALUES (:id, :user_id, 'Default date')
            RETURNING journal_date
        """), {"id": uuid4(), "user_id": DEVELOPMENT_USER_ID})
        assert actual == expected


def test_orm_date_edit_preserves_creation_timestamp(migrated_engine):
    old_time = datetime(2020, 1, 1, tzinfo=timezone.utc)
    with Session(migrated_engine) as session:
        entry = JournalEntry(
            user_id=DEVELOPMENT_USER_ID, content="A selected day",
            journal_date=date(2026, 11, 11), updated_at=old_time,
        )
        session.add(entry)
        session.commit()
        entry_id = entry.id
        created_at = entry.created_at
        assert entry.journal_date == date(2026, 11, 11)
        entry.journal_date = date(2026, 11, 10)
        session.commit()

    with Session(migrated_engine) as session:
        saved = session.get(JournalEntry, entry_id)
        assert saved.journal_date == date(2026, 11, 10)
        assert saved.created_at == created_at
        assert saved.updated_at > old_time
        assert saved.created_at.tzinfo is not None
        assert saved.updated_at.tzinfo is not None


def test_explicit_null_journal_date_is_rejected(migrated_engine):
    with pytest.raises(IntegrityError):
        with migrated_engine.begin() as connection:
            connection.execute(text("""
                INSERT INTO journal_entries (id, user_id, content, journal_date)
                VALUES (:id, :user_id, 'Invalid date', NULL)
            """), {"id": uuid4(), "user_id": DEVELOPMENT_USER_ID})


def test_journal_date_revision_can_be_downgraded_and_reapplied(isolated_engine):
    migrate(isolated_engine)
    entry_id = uuid4()
    with isolated_engine.begin() as connection:
        created_at = connection.scalar(text("""
            INSERT INTO journal_entries (id, user_id, content, journal_date)
            VALUES (:id, :user_id, 'Round trip', '2000-01-01')
            RETURNING created_at
        """), {"id": entry_id, "user_id": DEVELOPMENT_USER_ID})

    migrate(isolated_engine, "0004", downgrade=True)
    assert "journal_date" not in {
        column["name"] for column in inspect(isolated_engine).get_columns("journal_entries")
    }
    with isolated_engine.connect() as connection:
        assert connection.scalar(text(
            "SELECT content FROM journal_entries WHERE id = :id"
        ), {"id": entry_id}) == "Round trip"

    migrate(isolated_engine)
    with isolated_engine.connect() as connection:
        # Dropping the column loses selected dates; re-upgrade uses created_at.
        expected = connection.scalar(text(
            "SELECT (CAST(:created_at AS timestamptz) AT TIME ZONE 'Asia/Bangkok')::date"
        ), {"created_at": created_at})
        assert connection.scalar(text(
            "SELECT journal_date FROM journal_entries WHERE id = :id"
        ), {"id": entry_id}) == expected
