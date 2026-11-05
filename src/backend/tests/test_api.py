import asyncio
import uuid

import httpx
import pytest
from sqlalchemy import delete, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.main import create_app
from app.database import get_session
from app.models import JournalEntry, User


def application_for(engine):
    application = create_app(engine.url.render_as_string(hide_password=False))
    application.state.engine.dispose()
    application.state.engine = engine
    application.state.session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    return application


@pytest.fixture
def app(migrated_engine):
    application = application_for(migrated_engine)
    response = asyncio.run(request(application, "POST", "/api/auth/register", json={
        "email": "api@example.com", "password": "test-password",
    }))
    assert response.status_code == 201
    application.auth_cookies = dict(response.cookies)
    application.user_id = uuid.UUID(response.json()["id"])
    return application


async def request(app, method, path, **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.update(getattr(app, "auth_cookies", {}))
        kwargs.setdefault("headers", {"Origin": "http://localhost:5173", "X-AuraJournal-CSRF": "1"})
        return await client.request(method, path, **kwargs)


def test_create_and_list_entry(app):
    created = asyncio.run(request(app, "POST", "/api/entries", json={"content": "A test entry"}))
    assert created.status_code == 201
    entry = created.json()
    assert entry["content"] == "A test entry"
    assert uuid.UUID(entry["id"]).version == 4
    assert entry["created_at"] == entry["updated_at"]

    listed = asyncio.run(request(app, "GET", "/api/entries"))
    assert listed.status_code == 200
    assert listed.json() == [entry]


def test_entry_survives_app_restart(app):
    content = f"Persist me {uuid.uuid4()}"
    created = asyncio.run(request(app, "POST", "/api/entries", json={"content": content}))
    assert created.status_code == 201
    entry_id = created.json()["id"]
    app.state.engine.dispose()

    restarted_app = application_for(app.state.engine)
    restarted_app.auth_cookies = app.auth_cookies
    response = asyncio.run(request(restarted_app, "GET", "/api/entries"))
    assert response.status_code == 200
    assert any(entry["id"] == entry_id and entry["content"] == content for entry in response.json())
    with Session(restarted_app.state.engine) as session:
        session.execute(delete(JournalEntry).where(JournalEntry.id == uuid.UUID(entry_id)))
        session.commit()
    restarted_app.state.engine.dispose()


def test_invalid_entries_are_rejected(app):
    assert asyncio.run(request(app, "POST", "/api/entries", json={"content": ""})).status_code == 422
    assert asyncio.run(request(app, "POST", "/api/entries", json={})).status_code == 422
    assert asyncio.run(request(app, "POST", "/api/entries", json={"content": " "})).status_code == 422
    assert asyncio.run(request(app, "GET", "/api/entries")).json() == []


def test_database_error_returns_controlled_response(app):
    async def unavailable_session():
        raise OperationalError("database down", {}, RuntimeError("connection refused"))
        yield

    app.dependency_overrides[get_session] = unavailable_session
    response = asyncio.run(request(app, "GET", "/api/entries"))
    assert response.status_code == 503
    assert response.json() == {"detail": "Database is unavailable. Please try again later."}


def test_non_postgresql_url_is_rejected():
    with pytest.raises(ValueError, match="requires a PostgreSQL DATABASE_URL"):
        create_app("mysql://user:password@localhost/database")


def test_entry_owner_is_server_controlled(app):
    with Session(app.state.engine) as session:
        other = User(email="other@example.test", password_hash="!disabled")
        session.add(other)
        session.flush()
        session.add(JournalEntry(user_id=other.id, content="Private to another owner"))
        session.commit()
        other_id = str(other.id)

    rejected = asyncio.run(request(app, "POST", "/api/entries", json={
        "content": "Cannot choose owner", "user_id": other_id,
    }))
    assert rejected.status_code == 422
    created = asyncio.run(request(app, "POST", "/api/entries", json={"content": "  Local entry  "}))
    assert created.status_code == 201
    assert created.json()["content"] == "Local entry"
    listed = asyncio.run(request(app, "GET", "/api/entries"))
    assert listed.json() == [created.json()]
    with Session(app.state.engine) as session:
        assert session.scalar(select(JournalEntry.user_id).where(
            JournalEntry.id == uuid.UUID(created.json()["id"])
        )) == app.user_id


def test_entry_length_limit(app):
    assert asyncio.run(request(app, "POST", "/api/entries", json={
        "content": "a" * 5000,
    })).status_code == 201
    assert asyncio.run(request(app, "POST", "/api/entries", json={
        "content": "a" * 5001,
    })).status_code == 422


def test_entries_sorted_by_creation_time(app):
    from datetime import datetime, timezone

    with Session(app.state.engine) as session:
        session.add_all([
            JournalEntry(id=uuid.UUID(int=2), user_id=app.user_id,
                         content="Older", created_at=datetime(2020, 1, 1, tzinfo=timezone.utc)),
            JournalEntry(id=uuid.UUID(int=1), user_id=app.user_id,
                         content="Newer", created_at=datetime(2021, 1, 1, tzinfo=timezone.utc)),
        ])
        session.commit()
    listed = asyncio.run(request(app, "GET", "/api/entries"))
    assert [entry["content"] for entry in listed.json()] == ["Newer", "Older"]
