import asyncio
import os
import uuid

import httpx
import pytest
from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.main import Base, JournalEntry, create_app


async def _request(app, method, path, **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, **kwargs)


def test_postgresql_create_read_and_restart_persistence():
    database_url = os.environ.get("TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("Set TEST_DATABASE_URL to run the PostgreSQL integration test.")

    first_app = create_app(database_url)
    Base.metadata.create_all(first_app.state.engine)
    content = f"PostgreSQL integration test {uuid.uuid4()}"
    created = asyncio.run(_request(first_app, "POST", "/api/entries", json={"content": content}))
    assert created.status_code == 201
    entry_id = created.json()["id"]
    first_app.state.engine.dispose()

    restarted_app = create_app(database_url)
    Base.metadata.create_all(restarted_app.state.engine)
    response = asyncio.run(_request(restarted_app, "GET", "/api/entries"))
    assert response.status_code == 200
    assert any(entry["id"] == entry_id and entry["content"] == content for entry in response.json())

    with Session(restarted_app.state.engine) as session:
        session.execute(delete(JournalEntry).where(JournalEntry.id == entry_id))
        session.commit()
    restarted_app.state.engine.dispose()
