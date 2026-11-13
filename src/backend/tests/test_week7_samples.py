import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import JournalEntry, User
from scripts.seed_week7 import ALICE, BOB, seed_week7


def test_seed_can_be_repeated_without_changing_entries(migrated_engine):
    def snapshot(session):
        return session.execute(select(JournalEntry.id, JournalEntry.updated_at)).all()

    with Session(migrated_engine) as session:
        with session.begin():
            seed_week7(session)
            original = set(snapshot(session))
        with session.begin():
            seed_week7(session)
            assert len(original) == 8
            assert set(snapshot(session)) == original
            assert dict(session.execute(
                select(JournalEntry.user_id, func.count()).group_by(JournalEntry.user_id)
            ).all()) == {ALICE: 5, BOB: 3}


def test_seed_rolls_back_on_owner_conflict(migrated_engine):
    with Session(migrated_engine) as session:
        with session.begin():
            session.add(User(id=BOB, email="other@example.test", password_hash="!disabled"))
        with pytest.raises(ValueError, match="already in use"), session.begin():
            seed_week7(session)
        assert session.get(User, ALICE) is None
        assert session.get(User, BOB).email == "other@example.test"
