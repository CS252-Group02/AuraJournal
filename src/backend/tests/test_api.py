import asyncio

import httpx
from sqlalchemy.exc import OperationalError

from app.main import Base, create_app


def make_client(database_url):
    app = create_app(database_url)
    Base.metadata.create_all(app.state.engine)
    return app


async def _request(app, method, path, **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, **kwargs)


def request(app, method, path, **kwargs):
    return asyncio.run(_request(app, method, path, **kwargs))


def test_create_and_list_entry(tmp_path):
    database_url = f"sqlite:///{tmp_path / 'journal.db'}"
    app = make_client(database_url)
    created = request(app, "POST", "/api/entries", json={"content": "A test entry"})
    assert created.status_code == 201
    entry = created.json()
    assert entry["content"] == "A test entry"
    assert entry["id"] == 1

    listed = request(app, "GET", "/api/entries")
    assert listed.status_code == 200
    assert listed.json() == [entry]
    app.state.engine.dispose()


def test_entry_survives_app_restart(tmp_path):
    database_url = f"sqlite:///{tmp_path / 'journal.db'}"
    first_app = make_client(database_url)
    assert request(first_app, "POST", "/api/entries", json={"content": "Persist me"}).status_code == 201
    first_app.state.engine.dispose()

    restarted_app = make_client(database_url)
    response = request(restarted_app, "GET", "/api/entries")
    assert response.status_code == 200
    assert response.json()[0]["content"] == "Persist me"
    restarted_app.state.engine.dispose()


def test_invalid_entries_are_rejected():
    app = make_client("sqlite://")
    assert request(app, "POST", "/api/entries", json={"content": ""}).status_code == 422
    assert request(app, "POST", "/api/entries", json={}).status_code == 422
    assert request(app, "POST", "/api/entries", json={"content": " "}).status_code == 422
    assert request(app, "GET", "/api/entries").json() == []
    app.state.engine.dispose()


def test_health_checks_database():
    app = make_client("sqlite://")
    assert request(app, "GET", "/api/health").json() == {"status": "ok", "database": "connected"}
    app.state.engine.dispose()


def test_database_error_returns_controlled_response():
    app = make_client("sqlite://")
    health_route = next(route for route in app.routes if getattr(route, "path", None) == "/api/health")
    get_session = health_route.dependant.dependencies[0].call

    async def unavailable_session():
        raise OperationalError("database down", {}, RuntimeError("connection refused"))
        yield

    app.dependency_overrides[get_session] = unavailable_session
    response = request(app, "GET", "/api/health")
    assert response.status_code == 503
    assert response.json() == {"detail": "Database is unavailable. Please try again later."}
    app.state.engine.dispose()
