"""Use the actual Groq SDK and adapters, with an in-memory HTTP transport."""
import asyncio
from datetime import date, datetime, timezone

from groq import Groq
import httpx
import pytest
from sqlalchemy.orm import Session

from app.models import JournalEntry, WeeklyReflection
from app.services import _groq, JournalSummarizer, JournalTitleGenerator
from app.services.journal_qa import GroqJournalQuestionAnswerer
from app.services.weekly_recap import WeeklyRecapGenerator
from app.services.weekly_reflection import GroqWeeklyReflectionGenerator
from test_api import app, request  # noqa: F401

PRIVATE = "SENSITIVE-key-prompt-journal-provider-message"
START = "2026-11-09"


@pytest.mark.parametrize("kind", ["qa", "recap", "reflection", "title", "summary"])
@pytest.mark.parametrize("failure,status", [("timeout", 503), ("quota", 503), ("credentials", 503),
                                            ("permission", 503), ("network", 503),
                                            ("downtime", 503), ("malformed", 502), ("missing", 502)])
def test_sdk_failures_are_safe_and_never_retried(app, monkeypatch, caplog, kind, failure, status):
    with Session(app.state.engine) as session:
        entry = JournalEntry(user_id=app.user_id, journal_date=date.fromisoformat(START),
            created_at=datetime(2026, 11, 10, tzinfo=timezone.utc), content="Coffee at the library. " + PRIVATE)
        session.add(entry)
        session.add(WeeklyReflection(user_id=app.user_id, period_start=date.fromisoformat(START),
            summary="Previous result", questions=["What did you read?", "What would you revisit?"], source_dates=[START]))
        session.commit()
        entry_id = entry.id
    calls, clients, settings = [], [], []
    def respond(req):
        calls.append(req)
        if failure == "timeout": raise httpx.ReadTimeout(PRIVATE, request=req)
        if failure == "network": raise httpx.ConnectError(PRIVATE, request=req)
        if failure in {"quota", "credentials", "permission", "downtime"}:
            return httpx.Response({"quota": 429, "credentials": 401, "permission": 403, "downtime": 503}[failure],
                                  json={"error": {"message": PRIVATE, "type": "test"}})
        choices = [] if failure == "missing" else [{"index": 0, "message": {"role": "assistant", "content": PRIVATE}}]
        return httpx.Response(200, json={"id": "test", "object": "chat.completion", "created": 1,
                                         "model": "test-model", "choices": choices})
    def configured_client(**kwargs):
        settings.append(kwargs)
        sdk = Groq(http_client=httpx.Client(transport=httpx.MockTransport(respond)), **kwargs)
        clients.append(sdk)
        return sdk
    monkeypatch.setenv("GROQ_API_KEY", "fake-test-key")
    monkeypatch.setattr(_groq, "Groq", configured_client)
    if kind == "qa":
        app.state.journal_question_answerer = GroqJournalQuestionAnswerer()
        path, body = "/api/entries/ask", {"question": "Where did I have coffee?"}
    elif kind == "recap":
        app.state.weekly_recap_generator = WeeklyRecapGenerator()
        path, body = "/api/reflections/weekly", {"start": START, "timezone": "UTC"}
    elif kind == "reflection":
        app.state.weekly_reflection_generator = GroqWeeklyReflectionGenerator()
        path, body = "/api/weekly-reflections", {"period_start": START}
    elif kind == "title":
        app.state.journal_title_generator = JournalTitleGenerator()
        path, body = "/api/ai/suggest-title", {"content": "A fictional journal."}
    else:
        app.state.journal_summarizer = JournalSummarizer()
        path, body = f"/api/entries/{entry_id}/summary", {}
    try:
        response = asyncio.run(request(app, "POST", path, json=body))
        assert response.status_code == status
        assert isinstance(response.json()["detail"], str)
        assert response.headers["cache-control"] == "no-store"
        assert PRIVATE not in response.text and PRIVATE not in caplog.text
        assert "fake-test-key" not in response.text and "fake-test-key" not in caplog.text
        assert len(calls) == 1
        assert settings == [{"api_key": "fake-test-key", "timeout": 20.0, "max_retries": 0}]
        with Session(app.state.engine) as session:
            assert session.get(WeeklyReflection, (app.user_id, date.fromisoformat(START))).summary == "Previous result"
            assert session.get(JournalEntry, entry_id).content == "Coffee at the library. " + PRIVATE
    finally:
        for sdk in clients: sdk.close()
