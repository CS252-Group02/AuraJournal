"""Provider-independent weekly boundaries must enforce privacy and validation."""
import asyncio
from datetime import date, datetime, timedelta, timezone
from unittest.mock import Mock
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from app.auth import COOKIE_NAME, digest, utcnow
from app.limits import consume
from app.models import AuthSession, JournalEntry, User, WeeklyReflection
from app.schemas.weekly import WeeklyRecap, WeeklyEvent
from test_api import app, request  # noqa: F401

START = "2026-11-09"
REFLECTION = {"summary": "You visited the library.", "questions": ["What did you read?", "What would you revisit?"],
              "source_dates": [START]}


@pytest.fixture(params=["recap", "reflection"])
def weekly(app, request):
    kind = request.param
    with Session(app.state.engine) as session:
        entry = JournalEntry(user_id=app.user_id, journal_date=date.fromisoformat(START), content="Visited the library.",
                             created_at=datetime(2026, 11, 10, tzinfo=timezone.utc))
        session.add(entry)
        session.add(WeeklyReflection(user_id=app.user_id, period_start=date.fromisoformat(START),
                                    summary="Previously saved", questions=REFLECTION["questions"], source_dates=[START]))
        session.commit()
        identifier = entry.id
    fake = Mock()
    fake.generate.return_value = REFLECTION if kind == "reflection" else {
        "summary": "You visited the library.", "highlights": [{"text": "A library visit.", "entry_ids": [str(identifier)]}]}
    attribute = "weekly_reflection_generator" if kind == "reflection" else "weekly_recap_generator"
    setattr(app.state, attribute, fake)
    path = "/api/weekly-reflections" if kind == "reflection" else "/api/reflections/weekly"
    payload = {"period_start": START} if kind == "reflection" else {"start": START, "timezone": "UTC"}
    return kind, identifier, fake, path, payload, attribute


def generate(app, weekly):
    return asyncio.run(request(app, "POST", weekly[3], json=weekly[4]))


def assert_saved_unchanged(app):
    with Session(app.state.engine) as session:
        assert session.get(WeeklyReflection, (app.user_id, date.fromisoformat(START))).summary == "Previously saved"


@pytest.mark.parametrize("action", ["logout", "disable", "expire"])
def test_session_changes_during_generation_are_rejected(app, weekly, action):
    output = weekly[2].generate.return_value
    def complete(sources):
        assert app.state.engine.pool.checkedout() == 0
        if action == "logout":
            assert asyncio.run(request(app, "POST", "/api/auth/logout", json={})).status_code == 204
        else:
            with Session(app.state.engine) as session:
                if action == "disable": session.get(User, app.user_id).password_hash = "!disabled"
                else: session.get(AuthSession, digest(app.auth_cookies[COOKIE_NAME])).expires_at = utcnow() - timedelta(seconds=1)
                session.commit()
        return output
    weekly[2].generate.side_effect = complete
    assert generate(app, weekly).status_code == 401
    assert_saved_unchanged(app)


@pytest.mark.parametrize("action", ["edit", "delete", "insert", "move_date", "move_owner"])
def test_source_changes_reject_result_without_overwriting_saved_output(app, weekly, action):
    output = weekly[2].generate.return_value
    def complete(sources):
        with Session(app.state.engine) as session:
            entry = session.get(JournalEntry, weekly[1])
            if action == "edit": entry.content = "Changed experience"
            elif action == "delete": session.delete(entry)
            elif action == "insert": session.add(JournalEntry(user_id=app.user_id, journal_date=entry.journal_date,
                created_at=entry.created_at, content="Additional experience"))
            elif action == "move_date": entry.journal_date = date(2000, 1, 1)
            else:
                user = User(email="moved-weekly@example.com", password_hash="!disabled")
                session.add(user); session.flush(); entry.user_id = user.id
            session.commit()
        return output
    weekly[2].generate.side_effect = complete
    assert generate(app, weekly).status_code == 409
    assert_saved_unchanged(app)


@pytest.mark.parametrize("bad", [None, {}, {"summary": " "}, "private invalid output"])
def test_malformed_helper_outputs_are_safe(app, weekly, bad):
    weekly[2].generate.return_value = bad
    result = generate(app, weekly)
    assert result.status_code == 502 and "private" not in result.text
    assert_saved_unchanged(app)


def test_helper_cannot_mutate_input_to_authorize_fake_evidence(app, weekly):
    def complete(sources):
        sources[0]["id"] = str(uuid4())
        sources[0]["journal_date"] = "2026-11-11"
        if weekly[0] == "reflection": return {**REFLECTION, "source_dates": ["2026-11-11"]}
        return {"summary": "Invented", "highlights": [{"text": "Invented", "entry_ids": [sources[0]["id"]]}]}
    weekly[2].generate.side_effect = complete
    assert generate(app, weekly).status_code == 502
    assert_saved_unchanged(app)


def test_quota_prevents_provider_and_empty_periods_do_not_consume_it(app, weekly):
    with Session(app.state.engine) as session:
        for _ in range(10): consume(session, [(f"ai:user:minute:{app.user_id}", 10, 60)])
    result = generate(app, weekly)
    assert result.status_code == 429 and int(result.headers["retry-after"]) > 0
    weekly[2].generate.assert_not_called()
    assert_saved_unchanged(app)
    with Session(app.state.engine) as session:
        session.delete(session.get(JournalEntry, weekly[1])); session.commit()
    assert generate(app, weekly).json()["entry_count"] == 0
    weekly[2].generate.assert_not_called()


def test_missing_helper_is_unavailable(app, weekly):
    setattr(app.state, weekly[5], None)
    assert generate(app, weekly).status_code == 503
    assert_saved_unchanged(app)


def test_constructed_model_and_nested_source_bypasses_are_revalidated(app, weekly):
    if weekly[0] == "reflection":
        from app.schemas.weekly import WeeklyReflectionContent
        weekly[2].generate.return_value = WeeklyReflectionContent.model_construct(**{**REFLECTION, "summary": " "})
    else:
        weekly[2].generate.return_value = WeeklyRecap.model_construct(summary="A visit", highlights=[
            WeeklyEvent.model_construct(text=" ", entry_ids=[weekly[1]])])
    assert generate(app, weekly).status_code == 502
    assert_saved_unchanged(app)


def test_provider_runs_after_quota_commit_without_checked_out_connection(app, weekly):
    output = weekly[2].generate.return_value
    def complete(sources):
        assert app.state.engine.pool.checkedout() == 0
        return output
    weekly[2].generate.side_effect = complete
    assert generate(app, weekly).status_code == 200
