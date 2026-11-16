import asyncio
from datetime import date, datetime, timedelta, timezone
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import JournalEntry, User, WeeklyReflection
from app.services import AIInvalidResponseError, AIServiceNotConfiguredError, AIServiceUnavailableError
from app.services.weekly_reflection import WeeklyReflectionTooLarge
from test_api import app, application_for, request  # noqa: F401 - authenticated database fixture

PATH = "/api/weekly-reflections"
START = date(2026, 11, 12)
PAYLOAD = {"period_start": START.isoformat()}
OUTPUT = {"summary": "You completed an exam.",
          "questions": ["What helped you prepare?", "What would you try next time?"]}


@pytest.fixture
def generator(app):
    generator = Mock()
    generator.generate.return_value = OUTPUT
    app.state.weekly_reflection_generator = generator
    return generator


def call(app, payload=PAYLOAD, **kwargs):
    return asyncio.run(request(app, "POST", PATH, json=payload, **kwargs))


def insert_entry(app, **fields):
    with Session(app.state.engine) as session:
        entry = JournalEntry(user_id=app.user_id, journal_date=START, content="Completed an exam.",
                             created_at=datetime(2026, 12, 1, tzinfo=timezone.utc))
        for key, value in fields.items():
            setattr(entry, key, value)
        session.add(entry)
        session.commit()
        return entry.id


def test_selected_calendar_dates_owner_order_and_generation(app, generator):
    first = insert_entry(app, id=UUID(int=1), ai_summary="DO NOT SEND STORED AI TEXT")
    tied = insert_entry(app, id=UUID(int=2))
    last = insert_entry(app, journal_date=START + timedelta(days=6))
    insert_entry(app, journal_date=START - timedelta(days=1), content="Outside before")
    insert_entry(app, journal_date=START + timedelta(days=7), content="Outside after")
    with Session(app.state.engine) as session:
        other = User(email="other-reflection@example.test", password_hash="!disabled")
        session.add(JournalEntry(user=other, journal_date=START, content="PRIVATE OTHER OWNER"))
        session.commit()

    def generate(records):
        assert app.state.engine.pool.checkedout() == 0
        assert [r["id"] for r in records] == [str(first), str(tied), str(last)]
        assert [r["journal_date"] for r in records] == [START.isoformat()] * 2 + ["2026-11-18"]
        assert all(set(r) == {"id", "journal_date", "content"} for r in records)
        assert all(r["content"] == "Completed an exam." for r in records)
        return OUTPUT

    generator.generate.side_effect = generate
    response = call(app)
    assert response.status_code == 200
    assert response.json() == {"period_start": "2026-11-12", "period_end": "2026-11-18",
                               "entry_count": 3, **OUTPUT}
    assert response.headers["cache-control"] == "no-store"
    generator.generate.assert_called_once()
    with Session(app.state.engine) as session:
        assert session.scalar(select(WeeklyReflection)) is None
        assert session.get(JournalEntry, first).ai_summary == "DO NOT SEND STORED AI TEXT"


@pytest.mark.parametrize("configured", [False, True])
def test_empty_period_skips_generation_even_without_a_provider(app, generator, configured):
    if not configured:
        app.state.weekly_reflection_generator = None
    response = call(app)
    assert response.status_code == 200
    assert response.json() == {"period_start": "2026-11-12", "period_end": "2026-11-18",
                               "entry_count": 0, "summary": None, "questions": []}
    generator.generate.assert_not_called()


@pytest.mark.parametrize("payload", [
    {}, {"period_start": None}, {"period_start": 0}, {"period_start": True},
    {"period_start": "2026-02-30"}, {"period_start": "2026-1-01"},
    {"period_start": "2026-W01-1"}, {"period_start": "2026-11-12T00:00:00Z"},
    {"period_start": "9999-12-26"}, {**PAYLOAD, "user_id": str(UUID(int=1))},
])
def test_invalid_requests_do_not_call_generator(app, generator, payload):
    assert call(app, payload).status_code == 422
    generator.generate.assert_not_called()


@pytest.mark.parametrize("result", [
    None, {**OUTPUT, "summary": " "}, {**OUTPUT, "questions": ["Only one?"]},
    {**OUTPUT, "questions": ["One?", "Two?", "Three?"]},
    {**OUTPUT, "questions": ["One?", " \n "]}, {**OUTPUT, "questions": ["One?", 2]},
    {**OUTPUT, "highlights": ["Unexpected field"]},
])
def test_invalid_generator_output_returns_safe_error(app, generator, result):
    insert_entry(app)
    generator.generate.return_value = result
    response = call(app)
    assert response.status_code == 502
    assert response.json() == {"detail": "AI service returned an invalid weekly reflection."}


@pytest.mark.parametrize("error,status", [
    (AIInvalidResponseError("private detail"), 502),
    (AIServiceNotConfiguredError("private key"), 503),
    (AIServiceUnavailableError("private provider detail"), 503),
    (WeeklyReflectionTooLarge("private content"), 413),
])
def test_service_errors_are_controlled(app, generator, error, status):
    insert_entry(app)
    generator.generate.side_effect = error
    response = call(app)
    assert response.status_code == status
    assert "private" not in response.text


def test_missing_generator_and_input_budget(app, generator):
    insert_entry(app)
    app.state.weekly_reflection_generator = None
    assert call(app).status_code == 503
    app.state.weekly_reflection_generator = generator
    for _ in range(12):
        insert_entry(app, content="x" * 5000)
    response = call(app)
    assert response.status_code == 413
    generator.generate.assert_not_called()


@pytest.mark.parametrize("mutation", ["edit", "delete", "insert", "move_out", "move_in"])
def test_changed_sources_are_not_returned(app, generator, mutation):
    entry_id = insert_entry(app, journal_date=START - timedelta(days=1) if mutation == "move_in" else START)
    insert_entry(app)

    def generate(records):
        with Session(app.state.engine) as session:
            entry = session.get(JournalEntry, entry_id)
            if mutation == "edit":
                entry.content = "Revised content"
            elif mutation == "delete":
                session.delete(entry)
            elif mutation == "insert":
                session.add(JournalEntry(user_id=app.user_id, journal_date=START, content="New entry"))
            else:
                entry.journal_date = START if mutation == "move_in" else START - timedelta(days=1)
            session.commit()
        return OUTPUT

    generator.generate.side_effect = generate
    assert call(app).status_code == 409


def test_outside_changes_do_not_invalidate_selected_period(app, generator):
    insert_entry(app)
    outside = insert_entry(app, journal_date=START - timedelta(days=1))

    def generate(records):
        with Session(app.state.engine) as session:
            session.get(JournalEntry, outside).content = "Updated outside period"
            session.commit()
        return OUTPUT

    generator.generate.side_effect = generate
    assert call(app).status_code == 200


def test_session_origin_csrf_and_json_are_required(app, generator):
    insert_entry(app)
    assert call(application_for(app.state.engine)).status_code == 401
    assert call(app, headers={}).status_code == 403
    assert call(app, headers={"Origin": "https://evil.example", "X-AuraJournal-CSRF": "1"}).status_code == 403
    assert call(app, headers={"Origin": "http://localhost:5173", "X-AuraJournal-CSRF": "1",
                              "Content-Type": "text/plain"}).status_code == 415
    generator.generate.assert_not_called()
