import asyncio
from datetime import date, datetime, timezone
from uuid import UUID

import pytest
from sqlalchemy.orm import Session

from app.models import JournalEntry, User
from app.services.journal_history import search_entries
from test_api import app, application_for, request  # noqa: F401


@pytest.fixture
def searchable(app):
    with Session(app.state.engine) as session:
        other = User(email="search-other@example.test", password_hash="!disabled")
        session.add(other)
        session.flush()
        for number, day, content in [
            (1, "2026-12-31", "Hôm nay học Python và SQL"),
            (2, "2027-01-01", "I saved 50% on item_A / sale"),
            (3, "2027-01-02", "I saved 500 on itemXA / sale"),
        ]:
            session.add(JournalEntry(
                id=UUID(int=number), user_id=app.user_id, content=content,
                journal_date=date.fromisoformat(day),
                created_at=datetime(2027, 1, 3, tzinfo=timezone.utc),
            ))
        session.add(JournalEntry(user_id=other.id, journal_date=date(2027, 1, 1),
                                 content="Hôm nay học Python 50% item_A / sale"))
        session.commit()
    return app


@pytest.mark.parametrize(("keyword", "expected"), [
    ("PYTHON", [1]), (" học ", [1]), ("hoc", []),
    ("50%", [2]), ("item_A", [2]), ("/ sale", [3, 2]),
    ("' OR 1=1 --", []), ("absent", []), ("  ", [3, 2, 1]),
])
def test_literal_keywords_and_owner_isolation(searchable, keyword, expected):
    with Session(searchable.state.engine) as session:
        results = search_entries(session, searchable.user_id, keyword)
        assert [entry.id.int for entry in results] == expected


def test_optional_inclusive_dates_and_invalid_range(searchable):
    with Session(searchable.state.engine) as session:
        owner = searchable.user_id
        start, end = date(2026, 12, 31), date(2027, 1, 1)
        assert [e.id.int for e in search_entries(session, owner, start=start, end=end)] == [2, 1]
        assert [e.id.int for e in search_entries(session, owner, end=start)] == [1]
        assert [e.id.int for e in search_entries(session, owner, start=end)] == [3, 2]
        assert [e.id.int for e in search_entries(session, owner, "sale", start=end, end=end)] == [2]
        with pytest.raises(ValueError):
            search_entries(session, owner, start=end, end=start)


def test_api_combines_filters_and_uses_journal_date_order(searchable):
    app = searchable
    response = asyncio.run(request(app, "GET", "/api/entries", params={
        "q": "sale", "start": "2027-01-01", "end": "2027-01-01",
    }))
    assert response.status_code == 200
    assert [UUID(e["id"]).int for e in response.json()] == [2]
    assert response.headers["cache-control"] == "no-store"
    assert asyncio.run(request(application_for(app.state.engine), "GET", "/api/entries?q=sale")).status_code == 401
    # Creation timestamps are equal, so the original list uses ID as the tie-breaker.
    result = asyncio.run(request(app, "GET", "/api/entries"))
    assert [UUID(e["id"]).int for e in result.json()] == [3, 2, 1]
    with Session(app.state.engine) as session:
        session.get(JournalEntry, UUID(int=1)).journal_date = date(2027, 2, 1)
        session.commit()
    original = asyncio.run(request(app, "GET", "/api/entries")).json()
    filtered = asyncio.run(request(app, "GET", "/api/entries?q=")).json()
    assert [UUID(e["id"]).int for e in original] == [3, 2, 1]
    assert [UUID(e["id"]).int for e in filtered] == [1, 3, 2]


def test_api_sort_and_limit_are_applied_after_filters(searchable):
    app = searchable
    newest = asyncio.run(request(app, "GET", "/api/entries", params={
        "sort": "newest", "limit": 2,
    }))
    oldest = asyncio.run(request(app, "GET", "/api/entries", params={
        "sort": "oldest", "limit": 2,
    }))
    default_limited = asyncio.run(request(app, "GET", "/api/entries", params={
        "limit": 2,
    }))
    combined = asyncio.run(request(app, "GET", "/api/entries", params={
        "q": "sale", "start": "2027-01-01", "end": "2027-01-02",
        "sort": "oldest", "limit": 1,
    }))

    assert [UUID(entry["id"]).int for entry in newest.json()] == [3, 2]
    assert [UUID(entry["id"]).int for entry in oldest.json()] == [1, 2]
    assert [UUID(entry["id"]).int for entry in default_limited.json()] == [3, 2]
    assert [UUID(entry["id"]).int for entry in combined.json()] == [2]


def test_api_sort_ties_are_deterministic(searchable):
    with Session(searchable.state.engine) as session:
        session.add(JournalEntry(
            id=UUID(int=4), user_id=searchable.user_id, content="Same day",
            journal_date=date(2027, 1, 2),
            created_at=datetime(2027, 1, 3, tzinfo=timezone.utc),
        ))
        session.commit()

    newest = asyncio.run(request(searchable, "GET", "/api/entries", params={"sort": "newest"}))
    oldest = asyncio.run(request(searchable, "GET", "/api/entries", params={"sort": "oldest"}))
    assert [UUID(entry["id"]).int for entry in newest.json()] == [4, 3, 2, 1]
    assert [UUID(entry["id"]).int for entry in oldest.json()] == [1, 2, 3, 4]


@pytest.mark.parametrize("params", [
    {"start": "invalid"}, {"start": "2027-01-02", "end": "2027-01-01"},
    {"q": chr(0)}, {"q": "a" * 5001}, {"sort": "random"}, {"limit": "0"},
])
def test_api_rejects_invalid_filters(searchable, params):
    assert asyncio.run(request(searchable, "GET", "/api/entries", params=params)).status_code == 422


@pytest.mark.parametrize("params,expected", [
    ({"offset": 1, "limit": 1}, [2]),
    ({"offset": 1}, [2, 1]),
    ({"sort": "oldest", "offset": 1, "limit": 1}, [2]),
    ({"q": "sale", "offset": 1, "limit": 1}, [2]),
    ({"q": "sale", "start": "2027-01-01", "end": "2027-01-01", "offset": 1}, []),
    ({"offset": 100}, []),
])
def test_optional_pagination_is_applied_after_owned_filters(searchable, params, expected):
    result = asyncio.run(request(searchable, "GET", "/api/entries", params=params))
    assert result.status_code == 200
    assert [UUID(entry["id"]).int for entry in result.json()] == expected


@pytest.mark.parametrize("params", [
    {"offset": -1}, {"offset": "no"}, {"limit": 0},
    {"start": "2027-1-01"}, {"end": "2027-01-01T00:00:00Z"},
    {"start": "0"}, {"end": "2027-W01-1"}, {"start": "2027-02-29"},
])
def test_pagination_and_dates_have_strict_validation(searchable, params):
    response = asyncio.run(request(searchable, "GET", "/api/entries", params=params))
    assert response.status_code == 422
    assert all(set(error) == {"loc", "msg", "type"} for error in response.json()["detail"])


def test_service_rejects_negative_offset(searchable):
    with Session(searchable.state.engine) as session:
        with pytest.raises(ValueError):
            search_entries(session, searchable.user_id, offset=-1)


def test_pagination_ties_do_not_duplicate_entries(searchable):
    pages = [asyncio.run(request(searchable, "GET", "/api/entries", params={
        "sort": "newest", "offset": offset, "limit": 1,
    })).json() for offset in range(3)]
    assert [UUID(page[0]["id"]).int for page in pages] == [3, 2, 1]
