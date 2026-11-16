import asyncio
from datetime import date, datetime, timezone
from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from app.auth import COOKIE_NAME, digest, utcnow
from app.models import AuthSession, JournalEntry, User
from test_api import app, request  # noqa: F401 - shared authenticated fixture


def test_owner_can_read_one_entry_with_the_same_public_fields_as_list(app):
    created = asyncio.run(request(app, "POST", "/api/entries", json={"content": "An owner's entry"}))
    assert created.status_code == 201
    entry = created.json()
    response = asyncio.run(request(app, "GET", f"/api/entries/{entry['id']}"))
    assert response.status_code == 200
    assert response.json() == entry
    assert response.headers["cache-control"] == "no-store"
    assert "user_id" not in response.json()
    assert "password_hash" not in response.json()


def test_foreign_and_missing_reads_are_indistinguishable(app):
    with Session(app.state.engine) as session:
        other = User(email="read-other@example.com", password_hash="!disabled")
        entry = JournalEntry(user=other, content="Private to another account")
        session.add(entry)
        session.commit()
        entry_id = entry.id
    responses = [asyncio.run(request(app, "GET", f"/api/entries/{candidate}"))
                 for candidate in (entry_id, uuid4())]
    assert all(response.status_code == 404 for response in responses)
    assert responses[0].json() == responses[1].json() == {"detail": "Journal entry was not found."}
    assert asyncio.run(request(app, "GET", "/api/entries")).json() == []


@pytest.mark.parametrize("state", ["anonymous", "invalid", "expired", "revoked", "disabled"])
def test_detail_requires_a_valid_live_account_session(app, state):
    created = asyncio.run(request(app, "POST", "/api/entries", json={"content": "Protected entry"})).json()
    if state == "anonymous":
        app.auth_cookies = {}
    elif state == "invalid":
        app.auth_cookies = {COOKIE_NAME: "not-a-session"}
    else:
        with Session(app.state.engine) as session:
            record = session.get(AuthSession, digest(app.auth_cookies[COOKIE_NAME]))
            if state == "expired":
                record.expires_at = utcnow()
            elif state == "revoked":
                session.delete(record)
            else:
                session.get(User, app.user_id).password_hash = "!disabled"
            session.commit()
    response = asyncio.run(request(app, "GET", f"/api/entries/{created['id']}"))
    assert response.status_code == 401
    assert response.json() == {"detail": "Please log in."}


def test_malformed_detail_id_is_rejected(app):
    response = asyncio.run(request(app, "GET", "/api/entries/not-a-uuid"))
    assert response.status_code == 422


def test_list_preserves_creation_order_and_hides_other_accounts(app):
    early = datetime(2026, 10, 1, tzinfo=timezone.utc)
    late = datetime(2026, 10, 2, tzinfo=timezone.utc)
    with Session(app.state.engine) as session:
        other = User(email="list-other@example.com", password_hash="!disabled")
        session.add_all([
            JournalEntry(id=UUID(int=1), user_id=app.user_id, content="Older creation, later journal date",
                         created_at=early, journal_date=date(2026, 12, 1)),
            JournalEntry(id=UUID(int=2), user_id=app.user_id, content="Newer creation",
                         created_at=late, journal_date=date(2026, 1, 1)),
            JournalEntry(id=UUID(int=3), user_id=app.user_id, content="Tie broken by ID",
                         created_at=late, journal_date=date(2026, 1, 1)),
            JournalEntry(user=other, content="Invisible", created_at=late),
        ])
        session.commit()
    response = asyncio.run(request(app, "GET", "/api/entries"))
    assert response.status_code == 200
    assert [entry["id"] for entry in response.json()] == [str(UUID(int=value)) for value in (3, 2, 1)]
