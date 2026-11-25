"""A10 regressions at direct-service and replaceable-helper boundaries."""
import asyncio
import json
from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.auth import COOKIE_NAME, digest, utcnow
from app.models import AuthSession, JournalEntry, User
from app.services import JournalSummarizer, JournalSummary, JournalTitle, JournalTitleGenerator
from app.services._groq import EmptyJournalError
from app.services.pixel_art import MomentExtractor
from app.services.weekly_recap import WeeklyRecapGenerator
from app.services.weekly_recap import MAX_WEEKLY_INPUT, WeeklyRecapTooLarge
from test_ai_service import FakeCompletions, client_for
from test_api import app, request  # noqa: F401


@pytest.mark.parametrize("service,method,output", [
    (JournalSummarizer, "summarize", {"summary": "A fictional day."}),
    (JournalTitleGenerator, "generate", {"suggested_title": "A Fictional Day"}),
    (MomentExtractor, "extract", {"kind": "symbolic", "moment": "No subject", "evidence": None, "scene": None}),
])
def test_direct_journal_services_apply_existing_budget_and_keep_multiline_unicode(service, method, output):
    provider = FakeCompletions(json.dumps(output))
    generate = getattr(service(client=client_for(provider)), method)
    for invalid in ["x" * 5001, "x" * 5000 + " ", "Private\x00text", "Private\x1btext"]:
        with pytest.raises(ValidationError):
            generate(invalid)
    assert provider.calls == []
    for valid in ["x" * 5000, "Hôm nay ở nhà.\nTomorrow I will read.\t😀"]:
        generate(valid)
        assert provider.calls[-1]["messages"][1]["content"] == valid


SOURCE = {"id": "00000000-0000-4000-8000-000000000001", "journal_date": "2026-11-09", "content": "A fictional day."}


@pytest.mark.parametrize("sources,error", [
    (None, ValueError), ({}, ValueError), ([], EmptyJournalError),
    ([None], ValidationError), ([{}], ValidationError),
    ([{**SOURCE, "id": "invalid"}], ValidationError),
    ([{**SOURCE, "journal_date": "2026-02-30"}], ValidationError),
    ([{**SOURCE, "journal_date": 1794182400}], ValidationError),
    ([{**SOURCE, "content": 1}], ValidationError),
    ([{**SOURCE, "content": " \n\t "}], EmptyJournalError),
    ([{**SOURCE, "owner_id": "private"}], ValidationError),
    ([{**SOURCE, "recorded_at": "2026-11-09T12:00:00Z"}], ValidationError),
    ([{"id": SOURCE["id"], "content": SOURCE["content"]}], ValidationError),
    ([{"id": SOURCE["id"], "content": SOURCE["content"], "recorded_at": "2026-11-09T12:00:00"}], ValidationError),
    ([{"id": SOURCE["id"], "content": SOURCE["content"], "recorded_at": 1794182400}], ValidationError),
])
def test_direct_recap_rejects_bad_sources_before_provider(sources, error):
    provider = FakeCompletions("{}")
    with pytest.raises(error):
        WeeklyRecapGenerator(client=client_for(provider)).generate(sources)
    assert provider.calls == []


def test_recap_checks_exact_serialized_budget_without_omitting_or_truncating_sources():
    source = {**SOURCE, "content": "Hôm nay\nTomorrow\t"}
    overhead = len(json.dumps({"entries": [source]}, ensure_ascii=False))
    source["content"] += "x" * (MAX_WEEKLY_INPUT - overhead)
    provider = FakeCompletions('{"summary":"A fictional day.","highlights":[]}')
    generator = WeeklyRecapGenerator(client=client_for(provider))
    generator.generate([source])
    assert len(provider.calls[0]["messages"][1]["content"]) == MAX_WEEKLY_INPUT
    assert json.loads(provider.calls[0]["messages"][1]["content"])["entries"] == [source]
    with pytest.raises(WeeklyRecapTooLarge):
        generator.generate([{**source, "content": source["content"] + "x"}])
    assert len(provider.calls) == 1


@pytest.fixture(params=["title", "summary"])
def journal_helper(app, request):
    kind = request.param
    with Session(app.state.engine) as session:
        entry = JournalEntry(user_id=app.user_id, content="A fictional day.", ai_summary="Previous valid summary")
        session.add(entry)
        session.commit()
        entry_id = entry.id
    helper = Mock()
    if kind == "title":
        helper.generate.return_value = {"suggested_title": "A Fictional Day"}
        app.state.journal_title_generator = helper
        path, body = "/api/ai/suggest-title", {"content": "A fictional day."}
    else:
        helper.summarize.return_value = {"summary": "A fictional day."}
        app.state.journal_summarizer = helper
        path, body = f"/api/entries/{entry_id}/summary", {}
    return kind, helper, path, body, entry_id


def generate(app, fixture):
    return asyncio.run(request(app, "POST", fixture[2], json=fixture[3]))


@pytest.mark.parametrize("bad", [None, {}, "PRIVATE-output", 3, {"extra": "PRIVATE-output"}, "constructed", "mutated", "null_character"])
def test_journal_routes_revalidate_injected_outputs_before_return_or_save(app, journal_helper, bad, caplog):
    kind, helper, _, _, entry_id = journal_helper
    schema, field = (JournalTitle, "suggested_title") if kind == "title" else (JournalSummary, "summary")
    if bad == "constructed":
        bad = schema.model_construct(**{field: " "})
    elif bad == "mutated":
        bad = schema(**{field: "Previously valid"})
        setattr(bad, field, "x" * 501)
    elif bad == "null_character":
        bad = {field: "PRIVATE\x00output"}
    getattr(helper, "generate" if kind == "title" else "summarize").return_value = bad
    response = generate(app, journal_helper)
    assert response.status_code == 502
    assert response.json() == {"detail": "AI service returned an invalid response."}
    assert "PRIVATE" not in response.text + caplog.text
    with Session(app.state.engine) as session:
        entry = session.get(JournalEntry, entry_id)
        assert entry.content == "A fictional day." and entry.ai_summary == "Previous valid summary"


def test_journal_routes_accept_valid_dictionary_helpers(app, journal_helper):
    assert generate(app, journal_helper).status_code == 200


def test_unexpected_helper_bug_is_not_a_provider_failure(app, journal_helper):
    getattr(journal_helper[1], "generate" if journal_helper[0] == "title" else "summarize").side_effect = RuntimeError("programming bug")
    with pytest.raises(RuntimeError, match="programming bug"):
        generate(app, journal_helper)


@pytest.mark.parametrize("action,status", [("edit", 409), ("delete", 409), ("date", 409), ("owner", 409),
                                          ("logout", 401), ("expire", 401), ("disable", 401)])
def test_summary_rechecks_session_and_source_before_persistence(app, action, status):
    with Session(app.state.engine) as session:
        entry = JournalEntry(user_id=app.user_id, content="A fictional day.", ai_summary="Previous valid summary")
        session.add(entry)
        session.commit()
        entry_id = entry.id

    def summarize(text):
        if action == "logout":
            assert asyncio.run(request(app, "POST", "/api/auth/logout", json={})).status_code == 204
        else:
            with Session(app.state.engine) as session:
                entry = session.get(JournalEntry, entry_id)
                if action == "edit": entry.content = "Revised fictional day."
                elif action == "delete": session.delete(entry)
                elif action == "date": entry.journal_date = date(2000, 1, 1)
                elif action == "owner":
                    other = User(email="other-summary@example.test", password_hash="!disabled")
                    session.add(other)
                    session.flush()
                    entry.user_id = other.id
                elif action == "expire": session.get(AuthSession, digest(app.auth_cookies[COOKIE_NAME])).expires_at = utcnow() - timedelta(seconds=1)
                else: session.get(User, app.user_id).password_hash = "!disabled"
                session.commit()
        return JournalSummary(summary="New generated result")

    app.state.journal_summarizer = SimpleNamespace(summarize=Mock(side_effect=summarize))
    response = asyncio.run(request(app, "POST", f"/api/entries/{entry_id}/summary", json={}))
    assert response.status_code == status
    assert "New generated result" not in response.text
    app.state.journal_summarizer.summarize.assert_called_once_with("A fictional day.")
    with Session(app.state.engine) as session:
        entry = session.get(JournalEntry, entry_id)
        if action != "delete": assert entry.ai_summary == "Previous valid summary"
