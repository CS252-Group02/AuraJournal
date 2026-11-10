import asyncio
from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import JournalEntry, JournalImage, MoodRecord, User
from test_api import app, application_for, request  # noqa: F401 - shared authenticated fixture


def create_entry(app):
    response = asyncio.run(request(app, "POST", "/api/entries", json={"content": "Original"}))
    assert response.status_code == 201
    return response.json()


@pytest.mark.parametrize("method", ["PATCH", "DELETE"])
def test_browser_preflight_allows_mutations(app, method):
    path = f"/api/entries/{uuid4()}"
    response = asyncio.run(request(app, "OPTIONS", path, headers={
        "Origin": "http://localhost:5173",
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": "content-type,x-aurajournal-csrf",
    }))
    assert response.status_code == 200
    assert method in response.headers["access-control-allow-methods"]
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert response.headers["access-control-allow-credentials"] == "true"
    rejected = asyncio.run(request(app, "OPTIONS", path, headers={
        "Origin": "https://evil.example", "Access-Control-Request-Method": method,
    }))
    assert rejected.status_code == 400


def test_edit_persists_and_invalidates_previous_summary(app):
    original = create_entry(app)
    old_time = datetime(2020, 1, 1, tzinfo=timezone.utc)
    with Session(app.state.engine) as session:
        entry = session.get(JournalEntry, UUID(original["id"]))
        entry.ai_summary = "Old summary"
        entry.ai_reflection_question = "Old question?"
        entry.ai_summarized_at = old_time
        entry.updated_at = old_time
        session.commit()
    response = asyncio.run(request(app, "PATCH", f"/api/entries/{original['id']}", json={"content": "  Updated  "}))
    assert response.status_code == 200
    entry = response.json()
    assert entry["content"] == "Updated"
    assert entry["id"] == original["id"]
    assert entry["created_at"] == original["created_at"]
    assert datetime.fromisoformat(entry["updated_at"].replace("Z", "+00:00")) > old_time
    assert all(entry[key] is None for key in ("ai_summary", "ai_reflection_question", "ai_summarized_at"))
    restarted = application_for(app.state.engine)
    restarted.auth_cookies = app.auth_cookies
    assert asyncio.run(request(restarted, "GET", "/api/entries")).json() == [entry]


def test_unchanged_edit_keeps_summary(app):
    original = create_entry(app)
    with Session(app.state.engine) as session:
        entry = session.get(JournalEntry, UUID(original["id"]))
        entry.ai_summary = "Still accurate"
        session.commit()
    response = asyncio.run(request(app, "PATCH", f"/api/entries/{original['id']}", json={"content": " Original "}))
    assert response.status_code == 200
    assert response.json()["ai_summary"] == "Still accurate"


@pytest.mark.parametrize("payload", [{}, {"content": ""}, {"content": "  "},
                                      {"content": "a" * 5001}, {"content": "New", "user_id": str(uuid4())}])
def test_invalid_edit_leaves_content_unchanged(app, payload):
    entry = create_entry(app)
    response = asyncio.run(request(app, "PATCH", f"/api/entries/{entry['id']}", json=payload))
    assert response.status_code == 422
    assert asyncio.run(request(app, "GET", "/api/entries")).json() == [entry]


def test_edit_accepts_maximum_length(app):
    entry = create_entry(app)
    response = asyncio.run(request(app, "PATCH", f"/api/entries/{entry['id']}", json={"content": "a" * 5000}))
    assert response.status_code == 200
    assert len(response.json()["content"]) == 5000


@pytest.mark.parametrize("method", ["PATCH", "DELETE"])
def test_mutations_hide_foreign_and_missing_entries(app, method):
    with Session(app.state.engine) as session:
        other = User(email="foreign@example.com", password_hash="!disabled")
        entry = JournalEntry(user=other, content="Private")
        session.add(entry)
        session.commit()
        foreign_id = entry.id
    responses = [asyncio.run(request(app, method, f"/api/entries/{entry_id}", json={"content": "Spoof"}))
                 for entry_id in (foreign_id, uuid4())]
    assert all(response.status_code == 404 for response in responses)
    assert responses[0].json() == responses[1].json()
    with Session(app.state.engine) as session:
        assert session.get(JournalEntry, foreign_id).content == "Private"


@pytest.mark.parametrize("method", ["PATCH", "DELETE"])
def test_mutations_require_login_and_csrf(app, method):
    entry = create_entry(app)
    path = f"/api/entries/{entry['id']}"
    anonymous = application_for(app.state.engine)
    assert asyncio.run(request(anonymous, method, path, json={"content": "New"})).status_code == 401
    assert asyncio.run(request(app, method, path, json={"content": "New"},
                               headers={"Origin": "http://localhost:5173"})).status_code == 403
    assert asyncio.run(request(app, method, path, json={"content": "New"}, headers={
        "Origin": "https://evil.example", "X-AuraJournal-CSRF": "1",
    })).status_code == 403
    assert asyncio.run(request(app, "GET", "/api/entries")).json() == [entry]


def test_delete_removes_entry_and_related_records(app):
    entry = create_entry(app)
    entry_id = UUID(entry["id"])
    with Session(app.state.engine) as session:
        session.add(MoodRecord(entry_id=entry_id, valence=0, arousal=0))
        session.add(JournalImage(entry_id=entry_id, image_url="https://example.test/image.png"))
        session.commit()
    # Matches the frontend: JSON content-type header, but no request body.
    response = asyncio.run(request(app, "DELETE", f"/api/entries/{entry_id}", headers={
        "Origin": "http://localhost:5173", "X-AuraJournal-CSRF": "1", "Content-Type": "application/json",
    }))
    assert response.status_code == 204
    assert response.content == b""
    assert asyncio.run(request(app, "GET", "/api/entries")).json() == []
    with Session(app.state.engine) as session:
        assert session.get(JournalEntry, entry_id) is None
        assert session.scalar(select(MoodRecord).where(MoodRecord.entry_id == entry_id)) is None
        assert session.scalar(select(JournalImage).where(JournalImage.entry_id == entry_id)) is None
    assert asyncio.run(request(app, "DELETE", f"/api/entries/{entry_id}", json={})).status_code == 404
