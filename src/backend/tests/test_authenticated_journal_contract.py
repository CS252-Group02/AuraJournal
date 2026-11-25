"""Browser contracts exercised against real isolated PostgreSQL, fake AI only."""
import asyncio
from datetime import timedelta
from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session

from app.models import AuthSession, User
from app.auth import digest, COOKIE_NAME, utcnow
from test_api import app, application_for, request  # noqa: F401

DAY = "2024-02-29"
START = "2024-02-26"


def call(application, method, path, **kwargs):
    result = asyncio.run(request(application, method, path, **kwargs))
    assert result.headers["cache-control"] == "no-store"
    return result


def test_one_login_supports_private_crud_search_calendar_and_both_reflections(app):
    original_cookie = dict(app.auth_cookies)
    reflection = {"summary": "You visited the library.", "questions": ["What did you read?", "What would you revisit?"],
                  "source_dates": [DAY]}
    app.state.weekly_reflection_generator = Mock(generate=Mock(return_value=reflection))
    other = application_for(app.state.engine)
    registered = call(other, "POST", "/api/auth/register", json={
        "email": "contract-other@example.com", "password": "test-password-long"})
    assert registered.status_code == 201
    other.auth_cookies = dict(registered.cookies)
    created = call(app, "POST", "/api/entries", json={"content": "Visited the library.", "journal_date": DAY})
    assert created.status_code == 201
    entry = created.json()
    path = f"/api/entries/{entry['id']}"
    assert set(entry) == {"id", "content", "journal_date", "ai_summary", "ai_summarized_at", "created_at", "updated_at"}
    assert call(app, "GET", path).json() == entry
    for method, kwargs in [("GET", {}), ("PATCH", {"json": {"content": "Stolen"}}), ("DELETE", {"json": {}})]:
        assert call(other, method, path, **kwargs).status_code == 404
    assert call(other, "GET", "/api/entries?q=library&offset=0&limit=1").json() == []
    assert call(other, "GET", f"/api/entries/by-date?date={DAY}").json() == []
    assert all(day["count"] == 0 for day in call(other, "GET", "/api/calendar?year=2024&month=2").json()["days"])
    assert call(other, "POST", "/api/weekly-reflections", json={"period_start": START}).json()["entry_count"] == 0
    assert call(other, "GET", f"/api/weekly-reflections/{START}").status_code == 404
    updated = call(app, "PATCH", path, json={"content": "Visited the library and read a book."})
    assert updated.status_code == 200
    assert call(app, "GET", f"/api/entries/by-date?date={DAY}").json() == [updated.json()]
    assert call(app, "GET", "/api/entries?q=book&start=2024-02-29&end=2024-02-29&limit=1&offset=0").json() == [updated.json()]
    calendar = call(app, "GET", "/api/calendar?year=2024&month=2").json()
    assert len(calendar["days"]) == 29
    assert calendar["days"][-1] == {"date": DAY, "count": 1}
    dashboard = call(app, "GET", "/api/dashboard?year=2024&month=2&timezone=Asia/Ho_Chi_Minh").json()
    assert (dashboard["entry_count"], dashboard["active_days"]) == (1, 1)
    assert call(app, "GET", "/api/stats/streak?timezone=Asia/Ho_Chi_Minh").status_code == 200
    assert call(app, "POST", "/api/weekly-reflections", json={"period_start": START}).json()["source_dates"] == [DAY]
    assert call(app, "GET", f"/api/weekly-reflections/{START}").json()["summary"] == reflection["summary"]
    app.state.weekly_recap_generator = Mock(generate=Mock(return_value={
        "summary": "You read a book.", "highlights": [{"text": "A library visit.", "entry_ids": [entry["id"]]}]}))
    from app.schemas.weekly import WeeklyRecap
    app.state.weekly_recap_generator.generate.return_value = WeeklyRecap.model_validate(
        app.state.weekly_recap_generator.generate.return_value)
    recap = call(app, "POST", "/api/reflections/weekly", json={"start": START, "timezone": "UTC", "date_basis": "journal"})
    assert recap.status_code == 200 and recap.json()["entry_count"] == 1
    assert "highlights" in recap.json() and "questions" not in recap.json()
    restarted = application_for(app.state.engine)
    restarted.auth_cookies = original_cookie
    assert call(restarted, "GET", path).json() == updated.json()
    assert call(app, "DELETE", path, json={}).status_code == 204
    assert call(app, "GET", path).status_code == 404
    assert call(app, "GET", "/api/entries").json() == []
    assert call(app, "GET", f"/api/weekly-reflections/{START}").status_code == 200
    assert app.auth_cookies == original_cookie


@pytest.mark.parametrize("value", ["2024-2-26", "2024-02-26T00:00:00Z", 1708905600, None, "2024-W09-1", "2024-02-30"])
def test_both_weekly_contracts_reject_non_calendar_dates(app, value):
    for path, body in [("/api/weekly-reflections", {"period_start": value}),
                       ("/api/reflections/weekly", {"start": value, "timezone": "UTC"})]:
        result = call(app, "POST", path, json=body)
        assert result.status_code == 422
        assert all(set(error) == {"loc", "msg", "type"} for error in result.json()["detail"])


@pytest.mark.parametrize("state", ["anonymous", "expired", "revoked", "disabled"])
def test_private_read_endpoints_share_session_rules(app, state):
    with Session(app.state.engine) as session:
        record = session.get(AuthSession, digest(app.auth_cookies[COOKIE_NAME]))
        if state == "expired": record.expires_at = utcnow() - timedelta(seconds=1)
        if state == "revoked": session.delete(record)
        if state == "disabled": session.get(User, app.user_id).password_hash = "!disabled"
        session.commit()
    if state == "anonymous": app.auth_cookies = {}
    for path in ["/api/entries", f"/api/entries/by-date?date={DAY}", "/api/calendar?year=2024&month=2",
                 "/api/dashboard?year=2024&month=2", "/api/stats/streak", f"/api/weekly-reflections/{START}"]:
        assert call(app, "GET", path).status_code == 401
