import asyncio
from datetime import date, datetime, timedelta, timezone
from uuid import UUID

import pytest
from sqlalchemy.orm import Session

from app.models import JournalEntry, User
from app.routers import calendar as calendar_routes, entries as entries_routes
from app.routers.calendar import today
from test_api import app, request, application_for  # noqa: F401


def get(app, path):
    return asyncio.run(request(app, 'GET', path))


@pytest.mark.parametrize('year,month,length', [(2024, 2, 29), (2026, 2, 28), (9999, 12, 31), (1, 1, 31)])
def test_empty_month(app, year, month, length):
    response = get(app, f'/api/calendar?year={year}&month={month}')
    assert response.status_code == 200
    days = response.json()['days']
    assert len(days) == length
    assert all(day['count'] == 0 for day in days)


def test_calendar_streak_day_and_dashboard_isolate_users(app):
    app.dependency_overrides[today] = lambda: date(2026, 11, 2)
    with Session(app.state.engine) as session:
        other = User(email='calendar-other@example.com', password_hash='!disabled')
        session.add(other)
        session.flush()
        for owner, day in [(app.user_id, 30), (app.user_id, 31), (app.user_id, 31)]:
            session.add(JournalEntry(user_id=owner, content='Mine', journal_date=date(2026, 10, day)))
        session.add(JournalEntry(user_id=app.user_id, content='Mine', journal_date=date(2026, 11, 1)))
        session.add(JournalEntry(user_id=other.id, content='Private', journal_date=date(2026, 11, 2)))
        session.commit()
    assert get(app, '/api/stats/streak').json()['current_streak'] == 3
    assert get(app, '/api/calendar?year=2026&month=11').json()['days'][:2] == [
        {'date': '2026-11-01', 'count': 1}, {'date': '2026-11-02', 'count': 0}]
    assert len(get(app, '/api/entries/by-date?date=2026-10-31').json()) == 2
    assert get(app, '/api/entries/by-date?date=2026-11-02').json() == []
    result = get(app, '/api/dashboard?year=2026&month=10').json()
    assert (result['entry_count'], result['active_days'], result['current_streak']) == (3, 2, 3)
    app.dependency_overrides[today] = lambda: date(2026, 11, 3)
    assert get(app, '/api/stats/streak').json()['current_streak'] == 0


@pytest.mark.parametrize('path', ['/api/calendar?year=2026&month=13', '/api/calendar?month=1',
    '/api/dashboard?year=0&month=1', '/api/entries/by-date?date=2026-02-30'])
def test_invalid_parameters(app, path):
    assert get(app, path).status_code == 422


@pytest.mark.parametrize('path', ['/api/calendar?year=2026&month=11', '/api/stats/streak',
    '/api/dashboard?year=2026&month=11', '/api/entries/by-date?date=2026-11-01'])
def test_login_required(app, path):
    assert get(application_for(app.state.engine), path).status_code == 401


def test_backdated_edits_and_deletes_refresh_calendar_and_streak(app):
    app.dependency_overrides[today] = lambda: date(2024, 3, 1)
    ids = []
    for day in ['2024-02-28', '2024-02-29', '2024-03-01']:
        response = asyncio.run(request(app, 'POST', '/api/entries',
                                       json={'content': 'Backdated', 'journal_date': day}))
        assert response.status_code == 201
        ids.append(response.json()['id'])
    assert get(app, '/api/stats/streak').json()['current_streak'] == 3
    assert get(app, '/api/calendar?year=2024&month=2').json()['days'][-2:] == [
        {'date': '2024-02-28', 'count': 1}, {'date': '2024-02-29', 'count': 1}]
    moved = asyncio.run(request(app, 'PATCH', f'/api/entries/{ids[1]}',
                                json={'journal_date': '2024-03-01'}))
    assert moved.status_code == 200
    assert get(app, '/api/stats/streak').json()['current_streak'] == 1
    assert get(app, '/api/calendar?year=2024&month=2').json()['days'][-1]['count'] == 0
    assert get(app, '/api/calendar?year=2024&month=3').json()['days'][0]['count'] == 2
    for entry_id in ids[1:]:
        assert asyncio.run(request(app, 'DELETE', f'/api/entries/{entry_id}', json={})).status_code == 204
    assert get(app, '/api/stats/streak').json()['current_streak'] == 0



def test_requested_timezone_changes_today_without_moving_journal_dates(app):
    app.dependency_overrides[calendar_routes.utc_now] = lambda: datetime(2026, 11, 20, 0, 30, tzinfo=timezone.utc)
    with Session(app.state.engine) as session:
        other = User(email="timezone-other@example.test", password_hash="!disabled")
        session.add(other)
        session.flush()
        for day in [17, 18, 20]:
            session.add(JournalEntry(user_id=app.user_id, content="Mine", journal_date=date(2026, 11, day)))
        session.add(JournalEntry(user_id=other.id, content="Other owner", journal_date=date(2026, 11, 19)))
        session.commit()
    assert get(app, "/api/stats/streak?timezone=America/New_York").json() == {
        "as_of": "2026-11-19", "timezone": "America/New_York", "current_streak": 2,
    }
    assert get(app, "/api/stats/streak?timezone=Asia/Ho_Chi_Minh").json() == {
        "as_of": "2026-11-20", "timezone": "Asia/Ho_Chi_Minh", "current_streak": 1,
    }
    default = get(app, "/api/stats/streak").json()
    assert default == {"as_of": "2026-11-20", "timezone": "Asia/Bangkok", "current_streak": 1}
    counts = get(app, "/api/calendar?year=2026&month=11").json()["days"]
    assert {day["date"]: day["count"] for day in counts if day["count"]} == {
        "2026-11-17": 1, "2026-11-18": 1, "2026-11-20": 1,
    }
    for zone, expected_day, expected_streak in [("America/New_York", "2026-11-19", 2),
                                                ("Asia/Ho_Chi_Minh", "2026-11-20", 1)]:
        result = get(app, f"/api/dashboard?year=2026&month=11&timezone={zone}").json()
        assert (result["as_of"], result["timezone"], result["current_streak"]) == (expected_day, zone, expected_streak)
        assert (result["entry_count"], result["active_days"]) == (3, 3)
    old_month = get(app, "/api/dashboard?year=1900&month=1&timezone=Asia/Ho_Chi_Minh").json()
    assert (old_month["entry_count"], old_month["active_days"], old_month["current_streak"]) == (0, 0, 1)


@pytest.mark.parametrize("instant, expected_day", [
    ("2026-03-08T06:59:00+00:00", date(2026, 3, 8)),
    ("2026-03-08T07:01:00+00:00", date(2026, 3, 8)),
    ("2026-11-01T05:30:00+00:00", date(2026, 11, 1)),
    ("2026-11-01T06:30:00+00:00", date(2026, 11, 1)),
])
def test_streak_uses_calendar_days_across_dst_transitions(app, instant, expected_day):
    app.dependency_overrides[calendar_routes.utc_now] = lambda: datetime.fromisoformat(instant)
    with Session(app.state.engine) as session:
        for day in [expected_day - timedelta(days=1), expected_day]:
            session.add(JournalEntry(user_id=app.user_id, content="DST sample", journal_date=day))
        session.commit()
    response = get(app, "/api/stats/streak?timezone=America/New_York")
    assert response.status_code == 200
    assert response.json() == {"as_of": expected_day.isoformat(), "timezone": "America/New_York", "current_streak": 2}


def test_extreme_timezones_and_future_entries_use_each_local_date(app):
    app.dependency_overrides[calendar_routes.utc_now] = lambda: datetime(2026, 11, 20, 10, 30, tzinfo=timezone.utc)
    with Session(app.state.engine) as session:
        for day in [20, 21]:
            session.add(JournalEntry(user_id=app.user_id, content="Date sample", journal_date=date(2026, 11, day)))
        session.commit()
    west = get(app, "/api/stats/streak?timezone=Pacific/Honolulu").json()
    east = get(app, "/api/stats/streak?timezone=Pacific/Kiritimati").json()
    assert (west["as_of"], west["current_streak"]) == ("2026-11-20", 1)
    assert (east["as_of"], east["current_streak"]) == ("2026-11-21", 2)


@pytest.mark.parametrize("path", ["/api/stats/streak", "/api/dashboard?year=2026&month=11"])
@pytest.mark.parametrize("zone", ["", "Not/AZone", "../UTC", "/etc/passwd", "%00", "x" * 101])
def test_invalid_timezones_are_rejected(app, path, zone):
    separator = "&" if "?" in path else "?"
    assert get(app, f"{path}{separator}timezone={zone}").status_code == 422


@pytest.mark.parametrize("day", ["0", "1700000000", "20261120", "2026-11-20T00:00:00Z", "2026-W47-5", "2026-2-01", "2026-11-20%20"])
def test_selected_day_requires_exact_calendar_date(app, day):
    assert get(app, f"/api/entries/by-date?date={day}").status_code == 422


@pytest.mark.parametrize("day", ["0001-01-01", "9999-12-31"])
def test_selected_day_accepts_supported_date_boundaries(app, day):
    response = get(app, f"/api/entries/by-date?date={day}")
    assert response.status_code == 200 and response.json() == []


def test_selected_day_is_private_backdated_and_stably_ordered(app):
    selected = date(2024, 2, 29)
    same_time = datetime(2026, 11, 20, tzinfo=timezone.utc)
    ids = [UUID(int=201), UUID(int=202), UUID(int=203)]
    with Session(app.state.engine) as session:
        for entry_id, created in [(ids[0], same_time), (ids[1], same_time),
                                  (ids[2], datetime(2020, 1, 1, tzinfo=timezone.utc))]:
            session.add(JournalEntry(id=entry_id, user_id=app.user_id, content="Backdated", journal_date=selected, created_at=created))
        other = User(email="selected-day-other@example.test", password_hash="!disabled")
        session.add(other)
        session.flush()
        other_id = other.id
        session.add(JournalEntry(user_id=other_id, content="Other private text", journal_date=selected))
        session.add(JournalEntry(user_id=app.user_id, content="Wrong date", journal_date=date(2024, 3, 1)))
        session.commit()
    path = f"/api/entries/by-date?date=2024-02-29&user_id={other_id}"
    entries = get(app, path).json()
    assert [entry["id"] for entry in entries] == [str(ids[1]), str(ids[0]), str(ids[2])]
    assert all(entry["journal_date"] == "2024-02-29" and entry["content"] == "Backdated" for entry in entries)
    counts = get(app, f"/api/calendar?year=2024&month=2&user_id={other_id}").json()["days"]
    assert counts[-1] == {"date": "2024-02-29", "count": 3}


@pytest.mark.parametrize("path, module, helper", [
    ("/api/calendar?year=2026&month=11", calendar_routes, "daily_entry_counts"),
    ("/api/stats/streak", calendar_routes, "current_streak"),
    ("/api/dashboard?year=2026&month=11", calendar_routes, "daily_entry_counts"),
    ("/api/entries/by-date?date=2026-11-20", entries_routes, "entries_in_range"),
])
def test_calendar_query_failures_return_safe_unavailable_responses(app, monkeypatch, path, module, helper):
    from sqlalchemy.exc import OperationalError

    def unavailable(*args, **kwargs):
        raise OperationalError("private SQL", {}, Exception("private credentials"))

    monkeypatch.setattr(module, helper, unavailable)
    response = get(app, path)
    assert response.status_code == 503
    assert response.json() == {"detail": "Database is unavailable. Please try again later."}
    assert response.headers["cache-control"] == "no-store"
