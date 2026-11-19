from datetime import date, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, insert, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import DEVELOPMENT_USER_ID
from app.models import User, WeeklyReflection
from conftest import migrate


START = date(2026, 10, 29)
QUESTIONS = ["What helped this week?", "What would you repeat?"]


def test_reflections_are_keyed_by_owner_and_selected_period(migrated_engine):
    second_user = uuid4()
    with Session(migrated_engine) as session:
        session.add(User(id=second_user, email="weekly@example.test", password_hash="!disabled"))
        session.flush()
        for user_id, start, summary in [
            (DEVELOPMENT_USER_ID, START, "First week"),
            (DEVELOPMENT_USER_ID, START + timedelta(days=7), "Second week"),
            (second_user, START, "Separate owner"),
        ]:
            session.add(WeeklyReflection(user_id=user_id, period_start=start,
                                         summary=summary, questions=QUESTIONS))
        session.commit()
        reflection = session.get(WeeklyReflection, (DEVELOPMENT_USER_ID, START))
        assert reflection.summary == "First week"
        assert reflection.questions == QUESTIONS
        assert reflection.created_at.tzinfo is not None
        session.execute(delete(User).where(User.id == second_user))
        session.commit()
        assert session.get(WeeklyReflection, (second_user, START)) is None
        assert session.get(WeeklyReflection, (DEVELOPMENT_USER_ID, START)).summary == "First week"


@pytest.mark.parametrize("changes", [
    {"user_id": uuid4()}, {"summary": " "}, {"questions": []},
    {"questions": ["Only one"]}, {"questions": ["A?", "B?", "C?"]},
    {"questions": ["A?", " "]}, {"questions": [3, "Why?"]}, {"questions": {}},
    {"questions": None},
])
def test_reflection_rejects_invalid_storage(migrated_engine, changes):
    values = dict(user_id=DEVELOPMENT_USER_ID, period_start=START,
                  summary="Weekly summary", questions=QUESTIONS)
    with pytest.raises(IntegrityError), migrated_engine.begin() as conn:
        conn.execute(insert(WeeklyReflection).values(values | changes))


def test_a_user_has_one_reflection_per_start_date(migrated_engine):
    values = dict(user_id=DEVELOPMENT_USER_ID, period_start=START,
                  summary="Weekly summary", questions=QUESTIONS)
    with migrated_engine.begin() as conn:
        conn.execute(insert(WeeklyReflection).values(values))
    with pytest.raises(IntegrityError), migrated_engine.begin() as conn:
        conn.execute(insert(WeeklyReflection).values(values))


def test_reflection_migration_round_trip_preserves_journals(isolated_engine):
    migrate(isolated_engine, "0005")
    entry_id = uuid4()
    with isolated_engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO journal_entries (id, user_id, content, journal_date)
            VALUES (:id, :owner, 'Preserved journal', :day)
        """), {"id": entry_id, "owner": DEVELOPMENT_USER_ID, "day": START})
        original = conn.execute(text("SELECT * FROM journal_entries WHERE id = :id"),
                                {"id": entry_id}).mappings().one()

    migrate(isolated_engine, "0006")
    with isolated_engine.begin() as conn:
        conn.execute(insert(WeeklyReflection).values(
            user_id=DEVELOPMENT_USER_ID, period_start=START,
            summary="Saved reflection", questions=QUESTIONS,
        ))
    migrate(isolated_engine)
    migrate(isolated_engine)
    with Session(isolated_engine) as session:
        saved = session.get(WeeklyReflection, (DEVELOPMENT_USER_ID, START))
        assert saved.summary == "Saved reflection"
        assert saved.questions == QUESTIONS

    migrate(isolated_engine, "0005", downgrade=True)
    assert "weekly_reflections" not in inspect(isolated_engine).get_table_names()
    with isolated_engine.connect() as conn:
        assert conn.execute(text("SELECT * FROM journal_entries WHERE id = :id"),
                            {"id": entry_id}).mappings().one() == original

    migrate(isolated_engine)
    with Session(isolated_engine) as session:
        # Downgrade intentionally drops saved reflections; re-upgrade cannot recover them.
        assert session.get(WeeklyReflection, (DEVELOPMENT_USER_ID, START)) is None


@pytest.mark.parametrize("dates", [[], {}, [1], [None], ["2026-11-01"] * 8])
def test_source_date_storage_rejects_invalid_shapes(migrated_engine, dates):
    values = dict(user_id=DEVELOPMENT_USER_ID, period_start=START,
                  summary="Weekly summary", questions=QUESTIONS, source_dates=dates)
    with pytest.raises(IntegrityError), migrated_engine.begin() as connection:
        connection.execute(insert(WeeklyReflection).values(values))


def test_evidence_migration_preserves_old_results_and_downgrade_preserves_content(isolated_engine):
    import json
    migrate(isolated_engine, "0008")
    with isolated_engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO weekly_reflections (user_id, period_start, summary, questions) "
            "VALUES (:owner, :start, :summary, CAST(:questions AS jsonb))"
        ), {"owner": DEVELOPMENT_USER_ID, "start": START, "summary": "Legacy reflection",
            "questions": json.dumps(QUESTIONS)})
    migrate(isolated_engine)
    with Session(isolated_engine) as session:
        saved = session.get(WeeklyReflection, (DEVELOPMENT_USER_ID, START))
        assert saved.summary == "Legacy reflection" and saved.questions == QUESTIONS
        assert saved.source_dates is None
        saved.source_dates = [START.isoformat()]
        session.commit()
    migrate(isolated_engine, "0008", downgrade=True)
    with isolated_engine.connect() as connection:
        assert "source_dates" not in {c["name"] for c in inspect(connection).get_columns("weekly_reflections")}
        assert connection.scalar(text("SELECT summary FROM weekly_reflections")) == "Legacy reflection"
    migrate(isolated_engine)
    with Session(isolated_engine) as session:
        saved = session.get(WeeklyReflection, (DEVELOPMENT_USER_ID, START))
        assert saved.questions == QUESTIONS and saved.source_dates is None
