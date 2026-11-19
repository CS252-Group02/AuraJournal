import asyncio
from datetime import date
import json
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.models import JournalEntry, User
from app.routers import journal_qa
from app.schemas.journal_qa import JournalAnswerResponse
from app.services import AIInvalidResponseError, AIServiceNotConfiguredError, AIServiceUnavailableError
from app.services.journal_qa import GroqJournalQuestionAnswerer, JournalQuestionTooLarge
from test_api import app, application_for, request  # noqa: F401
from test_ai_service import FakeCompletions, client_for

PATH = "/api/entries/ask"
QUESTION = {"question": "Where did I have coffee?"}
OUTPUT = {"status": "answered", "answer": "You had coffee at the riverside cafe.", "source_dates": ["2026-11-18"]}


def ask(app, payload=QUESTION, **kwargs):
    return asyncio.run(request(app, "POST", PATH, json=payload, **kwargs))


def insert(app, *, owner=None, content="I had coffee at the riverside cafe."):
    with Session(app.state.engine) as session:
        entry = JournalEntry(user_id=owner or app.user_id, journal_date=date(2026, 11, 18), content=content)
        session.add(entry)
        session.commit()
        return entry.id


@pytest.fixture
def answerer(app):
    fake = Mock()
    fake.answer.return_value = OUTPUT
    app.state.journal_question_answerer = fake
    return fake


def test_question_retrieves_only_owned_sources_and_returns_validated_dates(app):
    owned = insert(app)
    with Session(app.state.engine) as session:
        other = User(email="qa-other@example.test", password_hash="!disabled")
        session.add(other)
        session.flush()
        session.add(JournalEntry(user_id=other.id, journal_date=date(2026, 11, 18), content="Coffee PRIVATE OTHER OWNER"))
        session.commit()
    completions = FakeCompletions(json.dumps(OUTPUT))
    original = completions.create

    def complete(**kwargs):
        assert app.state.engine.pool.checkedout() == 0
        body = json.loads(kwargs["messages"][1]["content"])
        assert [source["id"] for source in body["entries"]] == [str(owned)]
        assert "PRIVATE OTHER OWNER" not in json.dumps(body)
        return original(**kwargs)

    completions.create = complete
    app.state.journal_question_answerer = GroqJournalQuestionAnswerer(client=client_for(completions))
    response = ask(app)
    assert response.status_code == 200 and response.json() == OUTPUT
    assert response.headers["cache-control"] == "no-store"
    assert len(completions.calls) == 1
    with Session(app.state.engine) as session:
        assert session.get(JournalEntry, owned).content == "I had coffee at the riverside cafe."


def test_empty_unrelated_and_other_owner_histories_skip_ai_and_budget(app, answerer):
    assert ask(app).json()["status"] == "insufficient_evidence"
    insert(app, content="I studied in the library.")
    with Session(app.state.engine) as session:
        other = User(email="only-other-match@example.test", password_hash="!disabled")
        session.add(other)
        session.flush()
        session.add(JournalEntry(user_id=other.id, journal_date=date(2026, 11, 18), content="Coffee PRIVATE OTHER OWNER"))
        session.commit()
    assert ask(app).json()["source_dates"] == []
    assert ask(app, {"question": "What did I do?"}).json()["status"] == "insufficient_evidence"
    answerer.answer.assert_not_called()


@pytest.mark.parametrize("payload", [{}, {"question": None}, {"question": " "}, {"question": "x" * 1001},
    {"question": "coffee\x00"}, {**QUESTION, "user_id": "other"}, {**QUESTION, "entries": []}, {**QUESTION, "source_dates": []}])
def test_invalid_questions_and_client_context_are_rejected(app, answerer, payload):
    assert ask(app, payload).status_code == 422
    answerer.answer.assert_not_called()


def test_authentication_origin_csrf_and_json_are_required(app, answerer):
    assert ask(application_for(app.state.engine)).status_code == 401
    insert(app)
    assert ask(app, headers={}).status_code == 403
    assert ask(app, headers={"Origin": "https://evil.example", "X-AuraJournal-CSRF": "1"}).status_code == 403
    assert ask(app, headers={"Origin": "http://localhost:5173", "X-AuraJournal-CSRF": "1", "Content-Type": "text/plain"}).status_code == 415
    answerer.answer.assert_not_called()


@pytest.mark.parametrize("result", [None, {**OUTPUT, "source_dates": ["2026-11-19"]}, {**OUTPUT, "source_dates": []},
    {**OUTPUT, "status": "insufficient_evidence"}, {**OUTPUT, "answer": " "}, {**OUTPUT, "answer": "x" * 2401},
    JournalAnswerResponse.model_construct(status="answered", answer="Claim", source_dates=[])])
def test_invalid_helper_results_return_safe_bad_gateway(app, answerer, result):
    insert(app)
    answerer.answer.return_value = result
    response = ask(app)
    assert response.status_code == 502 and response.json() == {"detail": "AI service returned an invalid journal answer."}


@pytest.mark.parametrize("error, status", [(AIInvalidResponseError("private detail"), 502),
    (AIServiceNotConfiguredError("private key"), 503), (AIServiceUnavailableError("private provider"), 503),
    (JournalQuestionTooLarge("private context"), 413)])
def test_service_errors_are_safe_and_do_not_retry(app, answerer, error, status):
    insert(app)
    answerer.answer.side_effect = error
    response = ask(app)
    assert response.status_code == status and "private" not in response.text
    answerer.answer.assert_called_once()


def test_shared_ai_budget_is_committed_before_generation(app, answerer):
    from app.limits import consume
    with Session(app.state.engine) as session:
        for _ in range(10): consume(session, [(f"ai:user:minute:{app.user_id}", 10, 60)])
    assert ask(app).status_code == 200  # No history: no AI quota is consumed.
    insert(app)
    response = ask(app)
    assert response.status_code == 429 and int(response.headers["retry-after"]) > 0
    answerer.answer.assert_not_called()


@pytest.mark.parametrize("change", ["content", "date", "delete", "owner"])
def test_source_changes_during_provider_call_do_not_return_stale_answers(app, answerer, change):
    identifier = insert(app)

    def answer(question, sources):
        with Session(app.state.engine) as session:
            entry = session.get(JournalEntry, identifier)
            if change == "content": entry.content = "Changed experience"
            elif change == "date": entry.journal_date = date(2020, 1, 1)
            elif change == "delete": session.delete(entry)
            else:
                other = User(email="qa-moved@example.test", password_hash="!disabled")
                session.add(other)
                session.flush()
                entry.user_id = other.id
            session.commit()
        return OUTPUT

    answerer.answer.side_effect = answer
    assert ask(app).status_code == 409


@pytest.mark.parametrize("action", ["logout", "disable"])
def test_session_is_revalidated_after_generation(app, answerer, action):
    insert(app)

    def answer(question, sources):
        if action == "logout":
            assert asyncio.run(request(app, "POST", "/api/auth/logout", json={})).status_code == 204
        else:
            with Session(app.state.engine) as session:
                session.get(User, app.user_id).password_hash = "!disabled"
                session.commit()
        return OUTPUT

    answerer.answer.side_effect = answer
    assert ask(app).status_code == 401


def test_helper_cannot_change_the_original_sources_to_authorize_unknown_dates(app, answerer):
    insert(app)

    def answer(question, sources):
        sources[0]["journal_date"] = "2000-01-01"
        return {**OUTPUT, "source_dates": ["2000-01-01"]}

    answerer.answer.side_effect = answer
    assert ask(app).status_code == 502


def test_no_evidence_from_helper_is_canonical_and_has_no_dates(app, answerer):
    insert(app)
    answerer.answer.return_value = {"status": "insufficient_evidence", "answer": "Unverified claims", "source_dates": []}
    response = ask(app)
    assert response.status_code == 200 and response.json()["source_dates"] == []
    assert "Unverified" not in response.text


def test_missing_configuration_returns_unavailable_only_when_sources_exist(app, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    app.state.journal_question_answerer = GroqJournalQuestionAnswerer()
    assert ask(app).status_code == 200
    insert(app)
    assert ask(app).status_code == 503


def test_database_error_is_safe(app, monkeypatch):
    def unavailable(*args):
        raise OperationalError("private SQL", {}, Exception("private credentials"))

    monkeypatch.setattr(journal_qa, "retrieve_journals", unavailable)
    response = ask(app)
    assert response.status_code == 503 and "private" not in response.text
