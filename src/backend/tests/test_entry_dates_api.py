import asyncio
from datetime import date, datetime, timezone
from uuid import UUID
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy.orm import Session

from app.models import JournalEntry
from test_api import app, application_for, request  # noqa: F401 - shared authenticated fixture


def create_entry(app, **fields):
    response = asyncio.run(request(app, "POST", "/api/entries", json={"content": "Original", **fields}))
    assert response.status_code == 201
    return response.json()


def test_default_date_uses_the_database_bangkok_creation_day(app):
    entry = create_entry(app)
    created_at = datetime.fromisoformat(entry["created_at"].replace("Z", "+00:00"))
    assert entry["journal_date"] == created_at.astimezone(ZoneInfo("Asia/Bangkok")).date().isoformat()
    assert asyncio.run(request(app, "GET", f"/api/entries/{entry['id']}")).json() == entry
    assert asyncio.run(request(app, "GET", "/api/entries")).json() == [entry]


def test_creation_accepts_explicit_calendar_date_and_trims_content(app):
    entry = create_entry(app, content="  Historical entry  ", journal_date="2024-02-29")
    assert entry["journal_date"] == "2024-02-29"
    assert entry["content"] == "Historical entry"
    assert datetime.fromisoformat(entry["created_at"].replace("Z", "+00:00")).date() != date(2024, 2, 29)


def test_date_only_edit_preserves_text_summary_and_creation_timestamp(app):
    entry = create_entry(app, journal_date="2026-11-01")
    old_time = datetime(2000, 1, 1, tzinfo=timezone.utc)
    with Session(app.state.engine) as session:
        stored = session.get(JournalEntry, UUID(entry["id"]))
        stored.ai_summary = "Still describes the text"
        stored.ai_reflection_question = "What was useful?"
        stored.ai_summarized_at = old_time
        stored.updated_at = old_time
        session.commit()
    response = asyncio.run(request(app, "PATCH", f"/api/entries/{entry['id']}", json={"journal_date": "2026-10-31"}))
    assert response.status_code == 200
    updated = response.json()
    assert updated["journal_date"] == "2026-10-31"
    assert updated["content"] == entry["content"]
    assert updated["created_at"] == entry["created_at"]
    assert updated["ai_summary"] == "Still describes the text"
    assert updated["ai_reflection_question"] == "What was useful?"
    assert datetime.fromisoformat(updated["ai_summarized_at"].replace("Z", "+00:00")) == old_time
    assert datetime.fromisoformat(updated["updated_at"].replace("Z", "+00:00")) > old_time
    restarted = application_for(app.state.engine)
    restarted.auth_cookies = app.auth_cookies
    assert asyncio.run(request(restarted, "GET", f"/api/entries/{entry['id']}")).json() == updated


def test_combined_update_changes_date_and_invalidates_old_ai_output(app):
    entry = create_entry(app, journal_date="2026-11-01")
    with Session(app.state.engine) as session:
        stored = session.get(JournalEntry, UUID(entry["id"]))
        stored.ai_summary = "An outdated summary"
        stored.ai_reflection_question = "An outdated question?"
        stored.ai_summarized_at = datetime(2020, 1, 1, tzinfo=timezone.utc)
        session.commit()
    response = asyncio.run(request(app, "PATCH", f"/api/entries/{entry['id']}", json={
        "content": "  Revised  ", "journal_date": "2025-12-31",
    }))
    assert response.status_code == 200
    updated = response.json()
    assert updated["content"] == "Revised"
    assert updated["journal_date"] == "2025-12-31"
    assert updated["created_at"] == entry["created_at"]
    assert all(updated[key] is None for key in ("ai_summary", "ai_reflection_question", "ai_summarized_at"))
    with Session(app.state.engine) as session:
        assert session.get(JournalEntry, UUID(entry["id"])).user_id == app.user_id


def test_text_only_and_unchanged_updates_preserve_omitted_date_and_noop_timestamp(app):
    entry = create_entry(app, journal_date="2024-02-29")
    updated = asyncio.run(request(app, "PATCH", f"/api/entries/{entry['id']}", json={"content": "Revised"})).json()
    assert updated["journal_date"] == "2024-02-29"
    unchanged = asyncio.run(request(app, "PATCH", f"/api/entries/{entry['id']}", json={
        "content": " Revised ", "journal_date": "2024-02-29",
    }))
    assert unchanged.status_code == 200
    assert unchanged.json() == updated


@pytest.mark.parametrize("value", [None, "2025-02-29", "2026-02-30", "2026-13-01", "2026-1-01",
                                  "20261101", "2026-11-01T00:00:00Z", 0, 1.5, True, ""])
def test_invalid_dates_are_rejected_for_creation_and_edit_without_mutating(app, value):
    entry = create_entry(app, journal_date="2026-11-01")
    bad_create = asyncio.run(request(app, "POST", "/api/entries", json={"content": "Wrong date", "journal_date": value}))
    bad_edit = asyncio.run(request(app, "PATCH", f"/api/entries/{entry['id']}", json={"journal_date": value}))
    assert bad_create.status_code == bad_edit.status_code == 422
    assert asyncio.run(request(app, "GET", "/api/entries")).json() == [entry]


@pytest.mark.parametrize("payload", [{}, {"content": None}, {"content": " "}, {"content": "a" * 5001},
                                      {"journal_date": "2026-10-01", "created_at": "2020-01-01"},
                                      {"journal_date": "2026-10-01", "updated_at": "2020-01-01"},
                                      {"journal_date": "2026-10-01", "user_id": "another-owner"}])
def test_invalid_partial_update_leaves_all_stored_values_unchanged(app, payload):
    entry = create_entry(app, journal_date="2026-11-01")
    response = asyncio.run(request(app, "PATCH", f"/api/entries/{entry['id']}", json=payload))
    assert response.status_code == 422
    assert asyncio.run(request(app, "GET", f"/api/entries/{entry['id']}")).json() == entry
