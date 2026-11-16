import asyncio
from datetime import date

import pytest
from sqlalchemy.orm import Session

from app.models import JournalEntry, User
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
