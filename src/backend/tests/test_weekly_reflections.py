from datetime import date, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import DEVELOPMENT_USER_ID
from app.models import User, WeeklyReflection


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
