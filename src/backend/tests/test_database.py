from datetime import datetime, timezone
from uuid import UUID, uuid4

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Base
from app.config import DEVELOPMENT_USER_ID
from app.models import JournalEntry, JournalImage, MoodRecord, User
from conftest import migrate


def test_fresh_migration_matches_models(migrated_engine):
    with migrated_engine.connect() as connection:
        assert compare_metadata(MigrationContext.configure(connection), Base.metadata) == []
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0003"
    # Reapplying head must leave the seed intact and avoid duplicate insertion.
    migrate(migrated_engine)
    with Session(migrated_engine) as session:
        user = session.get(User, DEVELOPMENT_USER_ID)
        assert user.password_hash == "!disabled"
        assert session.scalar(select(func.count()).select_from(User)) == 1


def test_legacy_upgrade_preserves_entries(isolated_engine):
    # Simulate a database created by the app before Alembic was introduced.
    with isolated_engine.begin() as connection:
        connection.execute(text("""
            CREATE TABLE journal_entries (
                id SERIAL PRIMARY KEY,
                content VARCHAR(5000) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """))
        connection.execute(text("""
            INSERT INTO journal_entries (content, created_at) VALUES
            ('First entry', '2020-01-01T01:02:03Z'),
            ('Second entry', '2021-02-03T04:05:06Z')
        """))
    migrate(isolated_engine, "0001", stamp=True)
    migrate(isolated_engine)
    # A database already at head should keep its entries when upgraded again.
    with Session(isolated_engine) as session:
        original_ids = set(session.scalars(select(JournalEntry.id)))
    migrate(isolated_engine)
    with Session(isolated_engine) as session:
        entries = session.scalars(select(JournalEntry).order_by(JournalEntry.created_at)).all()
        assert [entry.content for entry in entries] == ["First entry", "Second entry"]
        assert len(original_ids) == 2
        assert {entry.id for entry in entries} == original_ids
        assert all(isinstance(entry.id, UUID) and entry.id.version == 4 for entry in entries)
        assert all(entry.user_id == DEVELOPMENT_USER_ID for entry in entries)
        assert all(entry.created_at == entry.updated_at for entry in entries)
        assert entries[0].created_at == datetime(2020, 1, 1, 1, 2, 3, tzinfo=timezone.utc)
        assert entries[1].created_at == datetime(2021, 2, 3, 4, 5, 6, tzinfo=timezone.utc)


def test_initial_revision_and_downgrade_guard(isolated_engine):
    migrate(isolated_engine, "0001")
    with isolated_engine.begin() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0001"
        assert connection.scalar(text(
            "INSERT INTO journal_entries (content) VALUES ('Initial schema entry') RETURNING id"
        )) == 1
    migrate(isolated_engine)
    with pytest.raises(RuntimeError, match="cannot recover original numeric IDs"):
        migrate(isolated_engine, "0001", downgrade=True)
    with Session(isolated_engine) as session:
        assert session.scalar(select(JournalEntry.content)) == "Initial schema entry"
    with isolated_engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0003"


@pytest.mark.parametrize("model, fields", [
    (MoodRecord, {"valence": 0.2, "arousal": 0.8}),
    (JournalImage, {"image_url": "https://example.test/image.png"}),
])
def test_child_unique_and_foreign_key_constraints(migrated_engine, model, fields):
    with Session(migrated_engine) as session:
        entry = JournalEntry(content="With child", user_id=DEVELOPMENT_USER_ID)
        session.add(entry)
        session.commit()
        entry_id = entry.id
        session.add(model(entry_id=entry_id, **fields))
        session.commit()
        session.add(model(entry_id=entry_id, **fields))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
        session.add(model(entry_id=uuid4(), **fields))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()


def test_user_constraints(migrated_engine):
    with Session(migrated_engine) as session:
        session.add(User(email="development@aurajournal.local", password_hash="!disabled"))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
        session.add(JournalEntry(user_id=uuid4(), content="Invalid owner"))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
        session.add(JournalEntry(content="Missing owner"))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()


@pytest.mark.parametrize("delete_user", [False, True])
def test_database_cascades(migrated_engine, delete_user):
    with Session(migrated_engine) as session:
        user = User(email="cascade@example.test", password_hash="!disabled")
        entry = JournalEntry(content="Cascade", user=user)
        entry.mood_record = MoodRecord(valence=0, arousal=0)
        entry.image = JournalImage(image_url="https://example.test/image.png")
        session.add(entry)
        session.commit()
        assert entry.image.file_format == "png"
        assert entry.created_at.tzinfo is not None
        assert user.updated_at.tzinfo is not None
        if delete_user:
            session.execute(delete(User).where(User.id == user.id))
        else:
            session.execute(delete(JournalEntry).where(JournalEntry.id == entry.id))
        session.commit()
        for model in (JournalEntry, MoodRecord, JournalImage):
            assert session.scalar(select(func.count()).select_from(model)) == 0


def test_updated_at_changes_on_orm_updates(migrated_engine):
    old_time = datetime(2000, 1, 1, tzinfo=timezone.utc)
    with Session(migrated_engine) as session:
        user = User(email="update@example.test", password_hash="!disabled", updated_at=old_time)
        entry = JournalEntry(content="Before", user=user, updated_at=old_time)
        session.add(entry)
        session.commit()
        user.email = "updated@example.test"
        entry.content = "After"
        session.commit()
        assert entry.updated_at > old_time
        assert user.updated_at > old_time
