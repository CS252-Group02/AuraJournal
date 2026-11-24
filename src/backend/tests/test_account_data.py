import asyncio
from datetime import date, timedelta
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
import httpx
import pytest
from sqlalchemy import event, insert, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.auth import COOKIE_NAME
from app.models import (
    AuthSession, JournalEntry, JournalImage, LoginAttempt, MoodRecord, PixelArtJob, User,
    WeeklyReflection,
)
from app.services.image_lifecycle import reconcile_images
from app.services.image_storage import ImageStorage
from app.services.journal_images import attach_image
from test_api import application_for


HEADERS = {"Origin": "http://localhost:5173", "X-AuraJournal-CSRF": "1"}
CONFIRMATION = {"confirmation": "DELETE"}
DAY = date(2024, 2, 29)


@pytest.fixture
def application(migrated_engine, tmp_path):
    app = application_for(migrated_engine)
    app.state.image_storage = ImageStorage(tmp_path)
    return app


def register(client, name):
    credentials = {"email": f"{name}@example.com", "password": "test-password-long"}
    response = client.post("/api/auth/register", json=credentials)
    assert response.status_code == 201
    return UUID(response.json()["id"]), credentials


def test_export_is_private_complete_and_ordered(application, migrated_engine):
    with TestClient(application, headers=HEADERS) as alice, TestClient(application, headers=HEADERS) as bob:
        assert alice.get("/api/entries/export").status_code == 401
        alice_id, _ = register(alice, "alice")
        bob_id, _ = register(bob, "bob")
        assert alice.get("/api/entries/export").json() == []
        unicode_content = 'Một ngày vui! Hôm nay tôi đi bộ.\n"Notes" 🌿'
        large_content = "word " * 990 + "continued"
        count = 1025
        with Session(migrated_engine) as session:
            session.execute(insert(JournalEntry), [
                {"user_id": bob_id, "journal_date": DAY, "content": "Bob's private text"},
                *[{"user_id": alice_id, "journal_date": DAY, "content": large_content}] * count,
                {"user_id": alice_id, "journal_date": DAY - timedelta(days=1), "content": unicode_content},
                {"user_id": alice_id, "journal_date": DAY + timedelta(days=1), "content": "Legacy title.\nMore"},
            ])
            session.commit()
        response = alice.get("/api/entries/export", params={"user_id": str(bob_id), "limit": 1})
        assert response.status_code == 200
        assert response.headers["content-disposition"] == 'attachment; filename="aurajournal-export.json"'
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["content-type"] == "application/json"
        export = response.json()
        assert export[0] == {"journal_date": "2024-02-28", "title": "Một ngày vui!", "content": unicode_content}
        assert export[-1] == {"journal_date": "2024-03-01", "title": "Legacy title", "content": "Legacy title.\nMore"}
        assert export[1:-1] == [{
            "journal_date": DAY.isoformat(), "title": "word " * 11 + "word…", "content": large_content,
        }] * count
        assert bob.get("/api/entries/export").json() == [{
            "journal_date": DAY.isoformat(), "title": "Bob's private text", "content": "Bob's private text",
        }]


def seed_account_data(app, client, owner):
    response = client.post("/api/entries", json={"content": "A private walk", "journal_date": DAY.isoformat()})
    assert response.status_code == 201
    entry_id = UUID(response.json()["id"])
    image_id = uuid4()
    key = app.state.image_storage.save(entry_id, image_id, b"owned test file")
    with app.state.session_factory() as session:
        attach_image(session, owner, entry_id, image_id, key)
        session.add(MoodRecord(entry_id=entry_id, valence=0.2, arousal=0.3))
        session.add(WeeklyReflection(user_id=owner, period_start=DAY, summary="A walk",
                                     questions=["Where did you go?", "What did you notice?"]))
        session.add(LoginAttempt(email=session.get(User, owner).email, ip="192.0.2.1"))
        job = session.scalar(select(PixelArtJob).where(PixelArtJob.entry_id == entry_id))
        job.status, job.error_code = "pending", None
        session.commit()
    return entry_id, image_id, key


@pytest.mark.parametrize("storage_failure", [False, True])
def test_account_deletion_preserves_other_accounts_and_removes_linked_data(application, monkeypatch, storage_failure):
    with (TestClient(application, headers=HEADERS) as alice,
          TestClient(application, headers=HEADERS) as second_session,
          TestClient(application, headers=HEADERS) as bob):
        assert alice.request("DELETE", "/api/auth/me", json=CONFIRMATION).status_code == 401
        alice_id, credentials = register(alice, "alice")
        bob_id, _ = register(bob, "bob")
        assert second_session.post("/api/auth/login", json=credentials).status_code == 200
        entry, image, key = seed_account_data(application, alice, alice_id)
        other_entry, other_image, other_key = seed_account_data(application, bob, bob_id)
        storage = application.state.image_storage

        # An unsafe legacy reference can point at somebody else's real file.
        with application.state.session_factory() as session:
            legacy = JournalEntry(user_id=alice_id, content="Legacy")
            legacy.image = JournalImage(image_url=other_key, file_format="png")
            session.add(legacy)
            session.commit()

        for payload in ({}, {"confirmation": "delete"}, {**CONFIRMATION, "user_id": str(bob_id)}):
            assert alice.request("DELETE", "/api/auth/me", json=payload).status_code == 422
        assert alice.request("DELETE", "/api/auth/me", json=CONFIRMATION,
                             headers={"X-AuraJournal-CSRF": "0"}).status_code == 403
        assert alice.get("/api/auth/me").status_code == 200

        with monkeypatch.context() as patch:
            if storage_failure:
                patch.setattr(storage, "delete", lambda _: False)
            response = alice.request("DELETE", "/api/auth/me", json=CONFIRMATION)
        assert response.status_code == 204
        assert response.content == b""
        assert "Max-Age=0" in response.headers["set-cookie"]
        assert alice.get("/api/auth/me").status_code == 401
        assert second_session.get("/api/auth/me").status_code == 401
        assert bob.get(f"/api/entries/{other_entry}").status_code == 200

        with application.state.session_factory() as session:
            assert session.get(User, alice_id) is None
            assert session.scalar(select(AuthSession).where(AuthSession.user_id == alice_id)) is None
            assert session.scalar(select(LoginAttempt).where(LoginAttempt.email == credentials["email"])) is None
            assert session.scalar(select(JournalEntry).where(JournalEntry.user_id == alice_id)) is None
            assert session.get(WeeklyReflection, (alice_id, DAY)) is None
            assert session.get(JournalImage, image) is None
            assert session.scalar(select(PixelArtJob).where(PixelArtJob.entry_id == entry)) is None
            assert session.scalar(select(MoodRecord).where(MoodRecord.entry_id == entry)) is None
            assert session.get(WeeklyReflection, (bob_id, DAY)) is not None
            assert session.get(JournalImage, other_image) is not None

        assert storage.path(other_key).exists()
        assert storage.path(key).exists() == storage_failure
        if storage_failure:
            assert reconcile_images(application.state.engine, storage) == 1
            assert not storage.path(key).exists()
            assert storage.path(other_key).exists()


def test_account_deletion_rolls_back_before_touching_files(application):
    with TestClient(application, headers=HEADERS) as client:
        owner, _ = register(client, "rollback")
        entry, _, key = seed_account_data(application, client, owner)

        def reject_commit(session):
            if any(isinstance(record, User) for record in session.deleted):
                session.flush()
                raise OperationalError(None, None, RuntimeError("forced rollback"))

        factory = application.state.session_factory
        event.listen(factory, "before_commit", reject_commit)
        try:
            response = client.request("DELETE", "/api/auth/me", json=CONFIRMATION)
        finally:
            event.remove(factory, "before_commit", reject_commit)
        assert response.status_code == 503
        assert "set-cookie" not in response.headers
        assert client.get(f"/api/entries/{entry}").status_code == 200
        assert application.state.image_storage.path(key).exists()


def test_concurrent_deletions_of_empty_account(application):
    with TestClient(application, headers=HEADERS) as client:
        _, credentials = register(client, "empty")
        token = client.cookies[COOKIE_NAME]

    async def delete(cookie):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application),
                                    base_url="http://test", headers=HEADERS, cookies={COOKIE_NAME: cookie}) as client:
            return (await client.request("DELETE", "/api/auth/me", json=CONFIRMATION)).status_code

    async def race():
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://test", headers=HEADERS) as client:
            assert (await client.post("/api/auth/login", json=credentials)).status_code == 200
            return await asyncio.gather(delete(token), delete(client.cookies[COOKIE_NAME]))

    assert sorted(asyncio.run(race())) == [204, 401]
