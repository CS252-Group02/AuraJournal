from datetime import date, datetime, timezone
import json
import unicodedata
from uuid import UUID

import pytest
from sqlalchemy.orm import Session

from app.models import JournalEntry, User
from app.schemas.journal_qa import MAX_EXCERPT_CHARS, MAX_QA_CONTEXT_CHARS, MAX_QA_SOURCES
from app.services.journal_retrieval import fold_text, retrieve_journals, sources_unchanged
from test_api import app  # noqa: F401


def add(session, owner, text, *, day=date(2026, 11, 18), identifier=None):
    entry = JournalEntry(user_id=owner, journal_date=day, content=text,
                         created_at=datetime(2026, 11, 20, tzinfo=timezone.utc))
    if identifier is not None:
        entry.id = UUID(int=identifier)
    session.add(entry)
    session.flush()
    return entry


def test_retrieval_finds_old_relevant_entries_without_leaking_other_owners(app):
    with Session(app.state.engine) as session:
        old = add(session, app.user_id, "Coffee at the riverside cafe.", day=date(2020, 1, 1))
        for index in range(70):
            add(session, app.user_id, "An unrelated recent journal.")
        other = User(email="retrieval-other@example.test", password_hash="!disabled")
        session.add(other)
        session.flush()
        add(session, other.id, "Coffee PRIVATE OTHER OWNER")
        session.commit()
        context = retrieve_journals(session, app.user_id, "Where did I have coffee?")
        assert [source["id"] for source in context.sources] == [str(old.id)]
        assert context.sources[0]["journal_date"] == "2020-01-01"
        assert "PRIVATE" not in json.dumps(context.sources)


def test_ranking_uses_matches_then_journal_date_and_stable_uuid_ties(app):
    with Session(app.state.engine) as session:
        add(session, app.user_id, "Coffee alone", identifier=500)
        best = add(session, app.user_id, "Coffee project meeting", identifier=10)
        older_best = add(session, app.user_id, "Coffee project notes", day=date(2020, 1, 1), identifier=20)
        session.commit()
        context = retrieve_journals(session, app.user_id, "What about the coffee project?")
        assert [source["id"] for source in context.sources][:2] == [str(best.id), str(older_best.id)]
        for identifier in range(100, 108):
            add(session, app.user_id, "Library exercise", identifier=identifier)
        session.commit()
        context = retrieve_journals(session, app.user_id, "Library?")
        assert [source["id"] for source in context.sources] == [str(UUID(int=value)) for value in range(107, 102, -1)]
        assert len(context.sources) == MAX_QA_SOURCES


@pytest.mark.parametrize("question", ["Khi n\u00e0o m\u00ecnh u\u1ed1ng c\u00e0 ph\u00ea?", "minh uong ca phe o dau?"])
def test_vietnamese_diacritics_and_decomposed_text_keep_the_original_excerpt(app, question):
    original = "x " * 1900 + unicodedata.normalize("NFD", "T\u00f4i u\u1ed1ng c\u00e0 ph\u00ea \u1edf qu\u00e1n nh\u1ecf.")
    with Session(app.state.engine) as session:
        entry = add(session, app.user_id, original)
        session.commit()
        context = retrieve_journals(session, app.user_id, question)
        assert context.sources[0]["id"] == str(entry.id)
        excerpt = context.sources[0]["content"]
        assert excerpt in original and "ca phe" in fold_text(excerpt)
        assert len(excerpt) <= MAX_EXCERPT_CHARS


def test_explicit_calendar_date_selects_only_that_day_and_invalid_dates_do_not_match(app):
    with Session(app.state.engine) as session:
        selected = add(session, app.user_id, "Visited the library", day=date(2024, 2, 29))
        add(session, app.user_id, "Library coffee", day=date(2026, 11, 18))
        session.commit()
        context = retrieve_journals(session, app.user_id, "What happened on 2024-02-29?")
        assert [source["id"] for source in context.sources] == [str(selected.id)]
        assert retrieve_journals(session, app.user_id, "Coffee on 2026-02-30?").sources == []


@pytest.mark.parametrize("question", ["What did I do?", "% _ .*", "quantum spaceship"])
def test_no_relevant_match_does_not_fall_back_to_latest_entries(app, question):
    with Session(app.state.engine) as session:
        add(session, app.user_id, "I studied at the library.")
        session.commit()
        assert retrieve_journals(session, app.user_id, question).sources == []


def test_full_word_matching_does_not_match_unrelated_substrings(app):
    with Session(app.state.engine) as session:
        add(session, app.user_id, "Started writing.")
        session.commit()
        assert retrieve_journals(session, app.user_id, "art?").sources == []


def test_serialized_context_budget_accounts_for_json_escaping(app):
    question = "coffee " + '"' * 900
    original = "coffee " + "\x01" * 4900
    with Session(app.state.engine) as session:
        for index in range(8):
            add(session, app.user_id, original)
        session.commit()
        context = retrieve_journals(session, app.user_id, question)
        assert 0 < len(context.sources) <= MAX_QA_SOURCES
        assert len(json.dumps({"question": question, "entries": context.sources}, ensure_ascii=False)) <= MAX_QA_CONTEXT_CHARS
        assert all(source["content"] in original and "coffee" in source["content"] for source in context.sources)
        assert all(len(source["content"]) <= MAX_EXCERPT_CHARS for source in context.sources)


@pytest.mark.parametrize("change", ["content", "date", "delete", "owner"])
def test_source_snapshot_detects_edits_deletions_and_ownership_changes(app, change):
    with Session(app.state.engine) as session:
        entry = add(session, app.user_id, "Coffee at the library")
        session.commit()
        context = retrieve_journals(session, app.user_id, "Coffee?")
        assert sources_unchanged(session, app.user_id, context)
        if change == "content": entry.content = "Revised experience"
        elif change == "date": entry.journal_date = date(2020, 1, 1)
        elif change == "delete": session.delete(entry)
        else:
            other = User(email="moved-owner@example.test", password_hash="!disabled")
            session.add(other)
            session.flush()
            entry.user_id = other.id
        session.commit()
        assert not sources_unchanged(session, app.user_id, context)
