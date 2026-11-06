import asyncio
from datetime import datetime, timezone
import uuid

import httpx
import pytest
from sqlalchemy import delete, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.main import create_app
from app.database import get_session
from app.models import JournalEntry, User
from app.services import (
    AIInvalidResponseError,
    AIServiceNotConfiguredError,
    AIServiceUnavailableError,
    EmptyJournalError,
    JournalSummary,
)


class FakeSummarizer:
    def __init__(self, *results):
        self.results = iter(results)
        self.calls = []

    def summarize(self, text):
        self.calls.append(text)
        result = next(self.results)
        if isinstance(result, Exception):
            raise result
        return result


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


def test_generate_and_overwrite_journal_summary(app):
    created = asyncio.run(request(app, "POST", "/api/entries", json={
        "content": "Today I finished an important assignment.",
    })).json()
    first = JournalSummary(
        summary="The writer completed an important assignment.",
        reflection_question="What helped you finish it?",
    )
    second = JournalSummary(
        summary="An important assignment was completed today.",
        reflection_question="How do you feel after completing it?",
    )
    summarizer = FakeSummarizer(first, second)
    app.state.journal_summarizer = summarizer

    first_response = asyncio.run(request(
        app, "POST", f"/api/entries/{created['id']}/summary", json={},
    ))
    second_response = asyncio.run(request(
        app, "POST", f"/api/entries/{created['id']}/summary", json={},
    ))

    assert first_response.status_code == 200
    assert first_response.json()["summary"] == first.summary
    assert second_response.status_code == 200
    assert second_response.json()["summary"] == second.summary
    assert summarizer.calls == [created["content"], created["content"]]

    listed = asyncio.run(request(app, "GET", "/api/entries")).json()
    assert listed[0]["ai_summary"] == second.summary
    assert listed[0]["ai_reflection_question"] == second.reflection_question
    listed_at = datetime.fromisoformat(listed[0]["ai_summarized_at"].replace("Z", "+00:00"))
    response_at = datetime.fromisoformat(
        second_response.json()["summarized_at"].replace("Z", "+00:00")
    )
    assert listed_at == response_at
    with Session(app.state.engine) as session:
        entry = session.get(JournalEntry, uuid.UUID(created["id"]))
        assert entry.ai_summary == second.summary
        assert entry.ai_reflection_question == second.reflection_question
        assert entry.ai_summarized_at is not None


def test_summary_hides_missing_and_other_users_entries(app):
    missing_id = uuid.uuid4()
    summarizer = FakeSummarizer()
    app.state.journal_summarizer = summarizer
    missing = asyncio.run(request(
        app, "POST", f"/api/entries/{missing_id}/summary", json={},
    ))

    with Session(app.state.engine) as session:
        other = User(email="summary-other@example.test", password_hash="!disabled")
        entry = JournalEntry(user=other, content="Private journal")
        session.add(entry)
        session.commit()
        other_entry_id = entry.id
    forbidden = asyncio.run(request(
        app, "POST", f"/api/entries/{other_entry_id}/summary", json={},
    ))

    assert missing.status_code == 404
    assert forbidden.status_code == 404
    assert missing.json() == forbidden.json() == {"detail": "Journal entry was not found."}
    assert summarizer.calls == []


@pytest.mark.parametrize("error,status_code,detail", [
    (EmptyJournalError("empty"), 422, "Journal entry cannot be empty."),
    (AIInvalidResponseError("invalid"), 502, "AI service returned an invalid response."),
    (AIServiceNotConfiguredError("missing key"), 503,
     "AI summary service is unavailable. Please try again later."),
    (AIServiceUnavailableError("offline"), 503,
     "AI summary service is unavailable. Please try again later."),
])
def test_summary_errors_preserve_previous_result(app, error, status_code, detail):
    old_time = datetime(2020, 1, 1, tzinfo=timezone.utc)
    with Session(app.state.engine) as session:
        entry = JournalEntry(
            user_id=app.user_id,
            content="Keep my previous summary",
            ai_summary="Previous summary",
            ai_reflection_question="Previous question?",
            ai_summarized_at=old_time,
        )
        session.add(entry)
        session.commit()
        entry_id = entry.id
    app.state.journal_summarizer = FakeSummarizer(error)

    response = asyncio.run(request(
        app, "POST", f"/api/entries/{entry_id}/summary", json={},
    ))

    assert response.status_code == status_code
    assert response.json() == {"detail": detail}
    with Session(app.state.engine) as session:
        entry = session.get(JournalEntry, entry_id)
        assert entry.ai_summary == "Previous summary"
        assert entry.ai_reflection_question == "Previous question?"
        assert entry.ai_summarized_at == old_time


def test_summary_requires_login(app):
    anonymous = application_for(app.state.engine)
    response = asyncio.run(request(
        anonymous, "POST", f"/api/entries/{uuid.uuid4()}/summary", json={},
    ))
    assert response.status_code == 401
    assert response.json() == {"detail": "Please log in."}
    anonymous.state.engine.dispose()
