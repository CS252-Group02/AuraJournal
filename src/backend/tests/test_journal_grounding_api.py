"""Database -> concrete adapters -> saved/API evidence contracts, no model-quality claims."""
import asyncio
from datetime import date, datetime, timezone
import json
from pathlib import Path
import runpy
from uuid import UUID

import pytest
from sqlalchemy.orm import Session

from app.models import JournalEntry, User, WeeklyReflection
from app.services.weekly_reflection import GroqWeeklyReflectionGenerator
from app.services.journal_qa import GroqJournalQuestionAnswerer
from test_api import app, request  # noqa: F401 - authenticated database fixture
from test_ai_service import FakeCompletions, client_for

EVAL = runpy.run_path(str(Path(__file__).resolve().parents[3] / "scripts/evaluate-journal-grounding.py"))
CASES = EVAL["load_cases"]()


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_dated_fixture_round_trip_uses_current_owned_text_and_real_adapter(app, case):
    with Session(app.state.engine) as session:
        entries = [JournalEntry(user_id=app.user_id, journal_date=date.fromisoformat(e["journal_date"]),
                    content=e["content"], ai_summary="STORED AI TEXT MUST NOT BECOME EVIDENCE",
                    created_at=datetime(2026, 12, 1, tzinfo=timezone.utc)) for e in case["entries"]]
        session.add_all(entries)
        other = User(email="grounding-other@example.test", password_hash="!disabled")
        session.add(JournalEntry(user=other, journal_date=entries[0].journal_date,
                                 content="PRIVATE OTHER OWNER " + case["entries"][0]["content"]))
        session.add(JournalEntry(user_id=app.user_id, journal_date=date(2026, 11, 23),
                                 content="OUTSIDE SELECTED DATES"))
        session.commit()
        expected = {str(e.id): {"id": str(e.id), "journal_date": e.journal_date.isoformat(), "content": e.content} for e in entries}
    completions = FakeCompletions(json.dumps(case["example_output"], ensure_ascii=False))
    original = completions.create

    def complete(**kwargs):
        assert app.state.engine.pool.checkedout() == 0
        supplied = json.loads(kwargs["messages"][1]["content"])["entries"]
        assert {e["id"] for e in supplied} == set(expected)
        assert all(e == expected[e["id"]] for e in supplied)
        return original(**kwargs)

    completions.create = complete
    if case["kind"] == "reflection":
        app.state.weekly_reflection_generator = GroqWeeklyReflectionGenerator(client=client_for(completions))
        response = asyncio.run(request(app, "POST", "/api/weekly-reflections", json={"period_start": case["period_start"]}))
    else:
        app.state.journal_question_answerer = GroqJournalQuestionAnswerer(client=client_for(completions))
        response = asyncio.run(request(app, "POST", "/api/entries/ask", json={"question": case["question"]}))
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    result = {k: body[k] for k in case["example_output"]}
    EVAL["check_result"](case, result)
    assert len(completions.calls) == 1
    if case["kind"] == "reflection":
        saved = asyncio.run(request(app, "GET", "/api/weekly-reflections/" + case["period_start"])).json()
        assert {k: saved[k] for k in case["example_output"]} == result
        assert body["entry_count"] == len(expected)
    with Session(app.state.engine) as session:
        for identifier, source in expected.items():
            assert session.get(JournalEntry, UUID(identifier)).content == source["content"]


def test_empty_week_and_no_match_skip_both_concrete_adapters(app):
    completions = FakeCompletions("not called")
    app.state.weekly_reflection_generator = GroqWeeklyReflectionGenerator(client=client_for(completions))
    app.state.journal_question_answerer = GroqJournalQuestionAnswerer(client=client_for(completions))
    reflection = asyncio.run(request(app, "POST", "/api/weekly-reflections", json={"period_start": "2026-11-16"}))
    answer = asyncio.run(request(app, "POST", "/api/entries/ask", json={"question": "Where did I travel?"}))
    assert reflection.json()["summary"] is None and reflection.json()["questions"] == []
    assert answer.json()["status"] == "insufficient_evidence" and answer.json()["source_dates"] == []
    assert completions.calls == []
    with Session(app.state.engine) as session:
        assert session.query(WeeklyReflection).count() == 0


def test_provider_input_limit_returns_413_and_preserves_saved_result_and_journals(app):
    import httpx
    from groq import APIStatusError
    case = CASES[0]
    with Session(app.state.engine) as session:
        journal = JournalEntry(user_id=app.user_id, journal_date=date(2026, 11, 16), content=case["entries"][0]["content"])
        session.add(journal)
        session.add(WeeklyReflection(user_id=app.user_id, period_start=date(2026, 11, 16), **case["example_output"]))
        session.commit()
        identifier = journal.id
    previous = asyncio.run(request(app, "GET", "/api/weekly-reflections/2026-11-16")).json()
    cause = APIStatusError("PRIVATE PROVIDER TOKEN DETAILS", response=httpx.Response(413, request=httpx.Request("POST", "https://provider.invalid")), body=None)
    completions = FakeCompletions(error=cause)
    app.state.weekly_reflection_generator = GroqWeeklyReflectionGenerator(client=client_for(completions))
    response = asyncio.run(request(app, "POST", "/api/weekly-reflections", json={"period_start": "2026-11-16"}))
    assert response.status_code == 413 and "PRIVATE" not in response.text
    assert len(completions.calls) == 1
    assert asyncio.run(request(app, "GET", "/api/weekly-reflections/2026-11-16")).json() == previous
    with Session(app.state.engine) as session:
        assert session.get(JournalEntry, identifier).content == case["entries"][0]["content"]
