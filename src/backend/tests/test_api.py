import asyncio
import os
import uuid

import httpx
import pytest
from sqlalchemy import delete
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.main import Base, JournalEntry, create_app


@pytest.fixture
def database_url():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.fail("TEST_DATABASE_URL must point to a disposable PostgreSQL test database.")
    return url


@pytest.fixture
def app(database_url):
    application = create_app(database_url)
    Base.metadata.create_all(application.state.engine)
    with Session(application.state.engine) as session:
        session.execute(delete(JournalEntry))
        session.commit()
    yield application
    application.state.engine.dispose()


async def request(app, method, path, **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, **kwargs)


def test_create_and_list_entry(app):
    created = asyncio.run(request(app, "POST", "/api/entries", json={"content": "A test entry"}))
    assert created.status_code == 201
    entry = created.json()
    assert entry["content"] == "A test entry"
    assert entry["id"]

    listed = asyncio.run(request(app, "GET", "/api/entries"))
    assert listed.status_code == 200
    assert listed.json() == [entry]


def test_entry_survives_app_restart(database_url, app):
    content = f"Persist me {uuid.uuid4()}"
    created = asyncio.run(request(app, "POST", "/api/entries", json={"content": content}))
    assert created.status_code == 201
    entry_id = created.json()["id"]
    app.state.engine.dispose()

    restarted_app = create_app(database_url)
    Base.metadata.create_all(restarted_app.state.engine)
    response = asyncio.run(request(restarted_app, "GET", "/api/entries"))
    assert response.status_code == 200
    assert any(entry["id"] == entry_id and entry["content"] == content for entry in response.json())
    with Session(restarted_app.state.engine) as session:
        session.execute(delete(JournalEntry).where(JournalEntry.id == entry_id))
        session.commit()
    restarted_app.state.engine.dispose()


def test_invalid_entries_are_rejected(app):
    assert asyncio.run(request(app, "POST", "/api/entries", json={"content": ""})).status_code == 422
    assert asyncio.run(request(app, "POST", "/api/entries", json={})).status_code == 422
    assert asyncio.run(request(app, "POST", "/api/entries", json={"content": " "})).status_code == 422
    assert asyncio.run(request(app, "GET", "/api/entries")).json() == []


def test_database_error_returns_controlled_response(app):
    entries_route = next(
        route for route in app.routes
        if getattr(route, "path", None) == "/api/entries" and "GET" in route.methods
    )
    get_session = entries_route.dependant.dependencies[0].call

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
