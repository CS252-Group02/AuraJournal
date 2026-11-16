from datetime import date, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import DEVELOPMENT_USER_ID
from app.models import JournalEntry, JournalImage, User
from app.services.journal_images import attach_image, recent_journal_images


def test_attach_checks_owner_key_and_duplicate_and_cascades(migrated_engine):
    owner = DEVELOPMENT_USER_ID
    with Session(migrated_engine) as session:
        entry = JournalEntry(user_id=owner, content="A memory")
        session.add(entry)
        session.flush()
        image_id = uuid4()
        key = f"pixel-art/{entry.id}/{image_id}.png"
        with pytest.raises(LookupError):
            attach_image(session, uuid4(), entry.id, image_id, key)
        with pytest.raises(ValueError):
            attach_image(session, owner, entry.id, image_id, "https://example.test/image.png")
        image = attach_image(session, owner, entry.id, image_id, key)
        session.commit()
        assert session.get(JournalImage, image_id).entry_id == entry.id
        with pytest.raises(FileExistsError):
            attach_image(session, owner, entry.id, image_id, key)
        session.execute(delete(JournalEntry).where(JournalEntry.id == entry.id))
        session.commit()
        assert session.scalar(select(JournalImage.id)) is None


def test_seven_distinct_days_include_gaps_missing_art_and_multiple_images(migrated_engine):
    owner = DEVELOPMENT_USER_ID
    as_of = date(2027, 1, 3)
    with Session(migrated_engine) as session:
        foreign = User(email="art@example.test", password_hash="!disabled")
        session.add(foreign)
        session.flush()
        # Eight occupied days spread over a month. Day zero has two images.
        expected = []
        for offset in range(8):
            day = as_of - timedelta(days=offset * 4)
            entry = JournalEntry(user_id=owner, journal_date=day, content="Memory")
            session.add(entry)
            session.flush()
            if offset == 2:
                continue
            image_id = uuid4()
            attach_image(session, owner, entry.id, image_id, f"pixel-art/{entry.id}/{image_id}.png")
            if offset < 7:
                expected.append(image_id)
        for user_id, day in [(owner, as_of), (owner, as_of + timedelta(days=1)), (foreign.id, as_of)]:
            entry = JournalEntry(user_id=user_id, journal_date=day, content="Extra")
            session.add(entry)
            session.flush()
            image_id = uuid4()
            attach_image(session, user_id, entry.id, image_id, f"pixel-art/{entry.id}/{image_id}.png")
            if user_id == owner and day == as_of:
                expected.append(image_id)
        session.commit()
        result = recent_journal_images(session, owner, as_of)
        assert {image.id for _, image in result} == set(expected)
        assert [day for day, _ in result] == sorted((day for day, _ in result), reverse=True)
        assert recent_journal_images(session, uuid4(), as_of) == []
