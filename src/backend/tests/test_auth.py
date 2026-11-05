from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.auth import COOKIE_NAME, digest, password_hasher, utcnow
from app.config import DEVELOPMENT_USER_ID
from app.models import AuthSession, JournalEntry, LoginAttempt, User
from conftest import migrate
from test_api import application_for

HEADERS = {"Origin": "http://localhost:5173", "X-AuraJournal-CSRF": "1", "Content-Type": "application/json"}
PASSWORD = "correct-password"


@pytest.fixture
def application(migrated_engine):
    return application_for(migrated_engine)


def client_for(application):
    return TestClient(application, headers=HEADERS)


def register(client, email="alice@example.com"):
    return client.post("/api/auth/register", json={"email": email, "password": PASSWORD})


def test_register_normalizes_and_hashes(application):
    with client_for(application) as client:
        created = register(client, "  Alice@EXAMPLE.COM  ")
        assert created.status_code == 201
        assert set(created.json()) == {"id", "email"}
        assert created.json()["email"] == "alice@example.com"
        assert client.get("/api/auth/me").json() == created.json()
        cookie = created.headers["set-cookie"].lower()
        assert "httponly" in cookie and "samesite=lax" in cookie
        assert "max-age=604800" in cookie and "path=/api" in cookie
        with Session(application.state.engine) as session:
            user = session.get(User, UUID(created.json()["id"]))
            assert user.password_hash.startswith("$argon2id$")
            assert password_hasher.verify(user.password_hash, PASSWORD)
            token = client.cookies.get(COOKIE_NAME)
            record = session.get(AuthSession, digest(token))
            assert record and record.token_hash != token
        assert register(client, "ALICE@example.com").status_code == 409


@pytest.mark.parametrize("email,password", [
    ("invalid", PASSWORD), ("alice@example.com", "tiny!"),
    ("alice@example.com", "x" * 129),
])
def test_registration_validation_does_not_echo_password(application, email, password):
    with client_for(application) as client:
        response = client.post("/api/auth/register", json={"email": email, "password": password})
        assert response.status_code == 422
        assert password not in response.text


def test_login_logout_and_session_revocation(application):
    with client_for(application) as client:
        register(client)
        original = client.cookies.get(COOKIE_NAME)
        assert client.post("/api/auth/logout", json={}).status_code == 204
        assert client.get("/api/auth/me").status_code == 401
        assert client.get("/api/auth/me", headers={"Cookie": f"{COOKIE_NAME}={original}"}).status_code == 401
        assert client.post("/api/auth/logout", json={}).status_code == 204
        login = client.post("/api/auth/login", json={"email": "ALICE@example.com", "password": PASSWORD})
        assert login.status_code == 200
        assert client.cookies.get(COOKIE_NAME) != original


def test_duplicate_registration_race_is_controlled(application):
    def attempt():
        with client_for(application) as client:
            return register(client).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: attempt(), range(2))) == [201, 409]


def test_logout_only_revokes_current_browser_session(application):
    with client_for(application) as a, client_for(application) as b:
        register(a)
        assert b.post("/api/auth/login", json={"email": "alice@example.com", "password": PASSWORD}).status_code == 200
        assert a.post("/api/auth/logout", json={}).status_code == 204
        assert a.get("/api/auth/me").status_code == 401
        assert b.get("/api/auth/me").status_code == 200


def test_invalid_expired_and_restart_sessions(application):
    with client_for(application) as client:
        assert client.get("/api/entries").status_code == 401
        assert client.post("/api/entries", json={"content": "anonymous"}).status_code == 401
        client.cookies.set(COOKIE_NAME, "invalid")
        assert client.get("/api/auth/me").status_code == 401
        client.cookies.clear()
        register(client)
        cookies = dict(client.cookies)
        restarted = application_for(application.state.engine)
        with client_for(restarted) as other:
            other.cookies.update(cookies)
            assert other.get("/api/auth/me").status_code == 200
        with Session(application.state.engine) as session:
            record = session.get(AuthSession, digest(cookies[COOKIE_NAME]))
            record.expires_at = utcnow() - timedelta(seconds=1)
            session.commit()
        assert client.get("/api/entries").status_code == 401


def test_accounts_only_see_their_own_entries(application):
    with client_for(application) as a, client_for(application) as b:
        account_a = register(a).json()
        register(b, "bob@example.com")
        entry_a = a.post("/api/entries", json={"content": "Alice private"}).json()
        entry_b = b.post("/api/entries", json={"content": "Bob private"}).json()
        assert a.get("/api/entries").json() == [entry_a]
        assert b.get("/api/entries").json() == [entry_b]
        assert b.post("/api/entries", json={"content": "spoof", "user_id": account_a["id"]}).status_code == 422
        with Session(application.state.engine) as session:
            session.add(JournalEntry(content="Legacy private", user_id=DEVELOPMENT_USER_ID))
            session.commit()
        assert a.get("/api/entries").json() == [entry_a]
        assert b.get("/api/entries").json() == [entry_b]


def test_invalid_and_disabled_users_get_same_login_error(application):
    with Session(application.state.engine) as session:
        session.add(User(email="disabled@example.com", password_hash="!disabled"))
        session.commit()
    with client_for(application) as client:
        responses = [client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
                     for email in ("unknown@example.com", "disabled@example.com")]
        assert all(response.status_code == 401 for response in responses)
        assert responses[0].json() == responses[1].json()


def test_login_throttle_persists_and_recovers(application):
    with client_for(application) as client:
        register(client)
        for _ in range(5):
            assert client.post("/api/auth/login", json={"email": "alice@example.com", "password": "incorrect-password"}).status_code == 401
        restarted = application_for(application.state.engine)
        with client_for(restarted) as other:
            blocked = other.post("/api/auth/login", json={"email": "alice@example.com", "password": PASSWORD})
            assert blocked.status_code == 429
            assert int(blocked.headers["retry-after"]) > 0
        with Session(application.state.engine) as session:
            for attempt in session.scalars(select(LoginAttempt)):
                attempt.created_at = utcnow() - timedelta(minutes=16)
            session.commit()
        assert client.post("/api/auth/login", json={"email": "alice@example.com", "password": PASSWORD}).status_code == 200


def test_csrf_cors_and_secure_cookie(application, monkeypatch):
    with TestClient(application) as client:
        assert register(client).status_code == 403
        assert client.post("/api/auth/register", json={"email": "a@example.com", "password": PASSWORD},
                           headers={**HEADERS, "Origin": "https://evil.example"}).status_code == 403
        assert client.post("/api/auth/login", json={}, headers={"Origin": HEADERS["Origin"]}).status_code == 403
        assert client.post("/api/auth/logout", content="{}", headers={**HEADERS, "Content-Type": "text/plain"}).status_code == 415
        preflight = client.options("/api/auth/login", headers={
            "Origin": HEADERS["Origin"], "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-aurajournal-csrf",
        })
        assert preflight.status_code == 200
        assert preflight.headers["access-control-allow-credentials"] == "true"
        assert preflight.headers["access-control-allow-origin"] == HEADERS["Origin"]
    monkeypatch.setenv("AUTH_COOKIE_SECURE", "true")
    with client_for(application) as client:
        response = register(client)
        assert "Secure" in response.headers["set-cookie"]


def test_auth_migration_preserves_data_and_session_cascades(isolated_engine):
    migrate(isolated_engine, "0002")
    with Session(isolated_engine) as session:
        user = User(email="Mixed@Example.com", password_hash="!disabled")
        entry = JournalEntry(content="Preserve", user=user)
        session.add(entry)
        session.commit()
        user_id, entry_id = user.id, entry.id
    migrate(isolated_engine)
    with Session(isolated_engine) as session:
        assert session.get(User, user_id).email == "mixed@example.com"
        assert session.get(JournalEntry, entry_id).content == "Preserve"
        session.add(AuthSession(token_hash="a" * 64, user_id=user_id, expires_at=utcnow() + timedelta(days=1)))
        session.commit()
        session.delete(session.get(User, user_id))
        session.commit()
        assert session.scalar(select(func.count()).select_from(AuthSession)) == 0


def test_auth_migration_refuses_colliding_emails(isolated_engine):
    migrate(isolated_engine, "0002")
    with Session(isolated_engine) as session:
        session.add_all([User(email=email, password_hash="!disabled")
                         for email in ("alice@example.com", "ALICE@example.com")])
        session.commit()
    with pytest.raises(RuntimeError, match="collide"):
        migrate(isolated_engine)
    with isolated_engine.connect() as conn:
        assert conn.scalar(text("SELECT version_num FROM alembic_version")) == "0002"
