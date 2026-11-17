import asyncio
from datetime import date, datetime, timedelta, timezone
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.models import JournalEntry, User, WeeklyReflection
from app.services import AIInvalidResponseError, AIServiceNotConfiguredError, AIServiceUnavailableError, EmptyJournalError
from app.services.weekly_reflection import WeeklyReflectionTooLarge
from test_api import app, application_for, request  # noqa: F401 - authenticated database fixture

PATH = "/api/weekly-reflections"
START = date(2026, 11, 12)
PAYLOAD = {"period_start": START.isoformat()}
OUTPUT = {"summary": "You completed an exam.",
          "questions": ["What helped you prepare?", "What would you try next time?"],
          "source_dates": [START.isoformat()]}


@pytest.fixture
def generator(app):
    generator = Mock()
    generator.generate.return_value = OUTPUT
    app.state.weekly_reflection_generator = generator
    return generator


def call(app, payload=PAYLOAD, **kwargs):
    return asyncio.run(request(app, "POST", PATH, json=payload, **kwargs))


def read(app, start=START):
    return asyncio.run(request(app, "GET", f"{PATH}/{start}"))


@pytest.fixture
def saved_reflection(app):
    with Session(app.state.engine) as session:
        session.add(WeeklyReflection(
            user_id=app.user_id, period_start=START, summary="Previously saved summary",
            questions=OUTPUT["questions"],
            created_at=datetime(2000, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2000, 1, 1, tzinfo=timezone.utc),
        ))
        session.commit()
    return read(app).json()


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
        saved = session.get(WeeklyReflection, (app.user_id, START))
        assert saved.summary == OUTPUT["summary"] and saved.questions == OUTPUT["questions"]
        assert saved.source_dates == OUTPUT["source_dates"]
        assert session.get(JournalEntry, first).ai_summary == "DO NOT SEND STORED AI TEXT"


@pytest.mark.parametrize("configured", [False, True])
def test_empty_period_skips_generation_even_without_a_provider(app, generator, configured, saved_reflection):
    if not configured:
        app.state.weekly_reflection_generator = None
    response = call(app)
    assert response.status_code == 200
    assert response.json() == {"period_start": "2026-11-12", "period_end": "2026-11-18",
                               "entry_count": 0, "summary": None, "questions": [], "source_dates": []}
    generator.generate.assert_not_called()
    assert read(app).json() == saved_reflection


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
def test_invalid_generator_output_returns_safe_error(app, generator, result, saved_reflection):
    insert_entry(app)
    generator.generate.return_value = result
    response = call(app)
    assert response.status_code == 502
    assert response.json() == {"detail": "AI service returned an invalid weekly reflection."}
    assert read(app).json() == saved_reflection


@pytest.mark.parametrize("error,status", [
    (AIInvalidResponseError("private detail"), 502),
    (AIServiceNotConfiguredError("private key"), 503),
    (AIServiceUnavailableError("private provider detail"), 503),
    (WeeklyReflectionTooLarge("private content"), 413),
    (EmptyJournalError("private content"), 422),
])
def test_service_errors_are_controlled(app, generator, error, status, saved_reflection):
    insert_entry(app)
    generator.generate.side_effect = error
    response = call(app)
    assert response.status_code == status
    assert "private" not in response.text
    assert read(app).json() == saved_reflection


def test_missing_generator_and_input_budget(app, generator, saved_reflection):
    insert_entry(app)
    app.state.weekly_reflection_generator = None
    assert call(app).status_code == 503
    assert read(app).json() == saved_reflection
    app.state.weekly_reflection_generator = generator
    for _ in range(12):
        insert_entry(app, content="x" * 5000)
    response = call(app)
    assert response.status_code == 413
    generator.generate.assert_not_called()
    assert read(app).json() == saved_reflection


@pytest.mark.parametrize("mutation", ["edit", "delete", "insert", "move_out", "move_in"])
def test_changed_sources_are_not_returned(app, generator, mutation, saved_reflection):
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
    assert read(app).json() == saved_reflection


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


def test_regeneration_updates_one_record_and_survives_restart(app, generator, saved_reflection):
    insert_entry(app)
    assert call(app).status_code == 200
    first = read(app).json()
    assert first == {**OUTPUT, "period_start": START.isoformat(), "period_end": "2026-11-18",
                     "created_at": saved_reflection["created_at"], "updated_at": first["updated_at"]}
    assert first["updated_at"] > saved_reflection["updated_at"]
    generator.generate.return_value = {**OUTPUT, "summary": "A regenerated summary"}
    assert call(app).status_code == 200
    second = read(app).json()
    assert second["summary"] == "A regenerated summary"
    assert second["created_at"] == first["created_at"]
    assert second["updated_at"] > first["updated_at"]
    with Session(app.state.engine) as session:
        assert session.scalar(select(func.count()).select_from(WeeklyReflection)) == 1
    restarted = application_for(app.state.engine)
    restarted.auth_cookies = app.auth_cookies
    restarted.state.weekly_reflection_generator = None
    assert read(restarted).json() == second
    assert generator.generate.call_count == 2


def test_saved_reads_are_private_and_period_specific(app, generator, saved_reflection):
    assert read(app, START + timedelta(days=7)).status_code == 404
    other = application_for(app.state.engine)
    assert read(other).status_code == 401
    registered = asyncio.run(request(other, "POST", "/api/auth/register", json={
        "email": "saved-other@example.com", "password": "test-password-long",
    }))
    assert registered.status_code == 201
    other.auth_cookies = dict(registered.cookies)
    assert read(other).json() == {"detail": "Weekly reflection was not found."}
    with Session(app.state.engine) as session:
        session.add(WeeklyReflection(user_id=UUID(registered.json()["id"]), period_start=START,
                                     summary="Other account summary", questions=OUTPUT["questions"]))
        session.commit()
    assert read(other).json()["summary"] == "Other account summary"
    assert read(app).json() == saved_reflection
    generator.generate.assert_not_called()


@pytest.mark.parametrize("start", ["2026-02-30", "2026-1-01", "0", "2026-W01-1",
                                  "2026-11-12T00:00:00Z", "9999-12-26"])
def test_saved_read_rejects_invalid_periods(app, start):
    assert read(app, start).status_code == 422


def test_empty_generation_does_not_create_a_record(app, generator):
    assert call(app).status_code == 200
    assert read(app).status_code == 404
    generator.generate.assert_not_called()


def test_failed_commit_rolls_back_generated_changes(app, generator, saved_reflection, monkeypatch):
    insert_entry(app)
    with monkeypatch.context() as patch:
        patch.setattr(Session, "commit", Mock(side_effect=OperationalError("private SQL", {}, Exception())))
        response = call(app)
    assert response.status_code == 503
    assert response.json() == {"detail": "Database is unavailable. Please try again later."}
    assert read(app).json() == saved_reflection


@pytest.mark.parametrize("dates", [None, [], ["2026-11-13"], ["2026-11-11"], ["2026-11-19"],
                                   [0], [True], ["2026-11-12T00:00:00Z"]])
def test_invalid_or_unsupplied_source_dates_do_not_replace_saved_results(app, generator, dates, saved_reflection):
    insert_entry(app)
    generator.generate.return_value = {**OUTPUT, "source_dates": dates}
    response = call(app)
    assert response.status_code == 502
    assert read(app).json() == saved_reflection


def test_missing_source_dates_are_rejected_at_the_generator_boundary(app, generator, saved_reflection):
    insert_entry(app)
    generator.generate.return_value = {key: value for key, value in OUTPUT.items() if key != "source_dates"}
    assert call(app).status_code == 502
    assert read(app).json() == saved_reflection


def test_regeneration_updates_evidence_and_saved_reads_keep_the_snapshot(app, generator):
    insert_entry(app)
    assert call(app).json()["source_dates"] == [START.isoformat()]
    next_day = START + timedelta(days=1)
    entry_id = insert_entry(app, journal_date=next_day)
    generator.generate.return_value = {**OUTPUT, "source_dates": [next_day.isoformat()]}
    assert call(app).json()["source_dates"] == [next_day.isoformat()]
    with Session(app.state.engine) as session:
        session.delete(session.get(JournalEntry, entry_id))
        session.commit()
    assert read(app).json()["source_dates"] == [next_day.isoformat()]


def test_legacy_saved_results_explicitly_report_unknown_sources(app, generator, saved_reflection):
    assert saved_reflection["source_dates"] is None
    assert read(app).json()["source_dates"] is None
    generator.generate.assert_not_called()


def test_real_generator_is_connected_to_queries_and_persistence(app):
    import json
    from app.services.weekly_reflection import GroqWeeklyReflectionGenerator
    from test_ai_service import FakeCompletions, client_for
    insert_entry(app)
    completions = FakeCompletions(json.dumps(OUTPUT))
    app.state.weekly_reflection_generator = GroqWeeklyReflectionGenerator(client=client_for(completions))
    assert call(app).json()["source_dates"] == OUTPUT["source_dates"]
    assert read(app).json()["source_dates"] == OUTPUT["source_dates"]
    assert len(completions.calls) == 1
    assert json.loads(completions.calls[0]["messages"][1]["content"])["entries"][0]["journal_date"] == START.isoformat()
