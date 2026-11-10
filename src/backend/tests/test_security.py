from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from types import SimpleNamespace
from uuid import UUID

from argon2 import PasswordHasher
from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.auth import password_hasher, utcnow
from app.deployment import validate_settings
from app.limits import consume
from app.models import LoginAttempt, RateLimitBucket, User
from test_api import application_for
from test_auth import HEADERS, PASSWORD, register


@pytest.fixture
def application(migrated_engine):
    return application_for(migrated_engine)


def client(application, ip="192.0.2.1"):
    return TestClient(application, headers=HEADERS, client=(ip, 50000))


def login(c, email="alice@example.com", password="wrong-password"):
    return c.post("/api/auth/login", json={"email": email, "password": password})


def test_account_limit_survives_ip_rotation_and_forwarded_header(application):
    # Model trusted-proxy processing explicitly: even if IP changes, the account
    # budget remains shared. The direct launcher additionally disables proxies.
    proxied = ProxyHeadersMiddleware(application, trusted_hosts="*")
    with client(proxied) as c:
        register(c)
        for i in range(5):
            c.headers["X-Forwarded-For"] = f"192.0.2.{i+10}"
            assert login(c).status_code == 401
        c.headers["X-Forwarded-For"] = "192.0.2.99"
        response = login(c, password=PASSWORD)
        assert response.status_code == 429
        assert int(response.headers["retry-after"]) > 0


def test_ip_budget_blocks_password_spraying_across_accounts(application):
    with Session(application.state.engine) as s:
        s.add_all([LoginAttempt(email=f"other{i}@example.com", ip="192.0.2.1") for i in range(30)])
        s.commit()
    with client(application) as c:
        assert login(c, "fresh@example.com").status_code == 429
    with client(application, "192.0.2.2") as c:
        assert login(c, "fresh@example.com").status_code == 401


def test_registration_limit_precedes_hashing_and_survives_restart(application, monkeypatch):
    import app.routers.auth as auth_router
    with client(application) as c:
        for i in range(5):
            # Invalid credentials still consume the registration budget.
            assert c.post("/api/auth/register", json={"email": "invalid", "password": "short"}).status_code == 422
    def forbidden(*args):
        raise AssertionError("Throttled registration must not hash")
    monkeypatch.setattr(auth_router, "password_hasher", SimpleNamespace(hash=forbidden))
    restarted = application_for(application.state.engine)
    with client(restarted) as c:
        assert register(c).status_code == 429


@pytest.mark.parametrize("password", ["password", "passwordpassword", "x"*20, "short-pass"])
def test_new_password_policy(application, password):
    with client(application) as c:
        response = c.post("/api/auth/register", json={"email": "a@example.com", "password": password})
        assert response.status_code == 422
        assert all(set(item) == {"loc", "msg", "type"} for item in response.json()["detail"])
        if password != "password":
            assert password not in response.text


def test_legacy_password_login_and_rehash(application):
    old = PasswordHasher(time_cost=1, memory_cost=8192, parallelism=1).hash("legacy12")
    with Session(application.state.engine) as s:
        s.add(User(email="legacy@example.com", password_hash=old))
        s.commit()
    with client(application) as c:
        assert login(c, "legacy@example.com", "legacy12").status_code == 200
    with Session(application.state.engine) as s:
        stored = s.scalar(select(User.password_hash).where(User.email == "legacy@example.com"))
        assert stored != old and password_hasher.verify(stored, "legacy12")
        assert not password_hasher.check_needs_rehash(stored)


def test_atomic_shared_budget_under_concurrency_and_expiry(application):
    def attempt(_):
        with Session(application.state.engine) as s:
            try:
                consume(s, [("test:shared", 3, 60)])
                return 200
            except HTTPException as error:
                return error.status_code
    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(attempt, range(6)))
    assert sorted(codes) == [200, 200, 200, 429, 429, 429]
    with Session(application.state.engine) as s:
        for bucket in s.scalars(select(RateLimitBucket)):
            bucket.expires_at = utcnow() - timedelta(seconds=1)
        s.commit()
    assert attempt(None) == 200


def test_ai_daily_quota_shared_by_endpoints_and_does_not_call_provider(application):
    with client(application) as c:
        user_id = register(c).json()["id"]
        entry_id = c.post("/api/entries", json={"content": "private"}).json()["id"]
        with Session(application.state.engine) as s:
            # Seed a consumed daily budget without spending external API calls.
            for _ in range(100):
                consume(s, [(f"ai:user:day:{user_id}", 100, 86400)])
        def forbidden(*args):
            raise AssertionError("Quota must block provider access")
        application.state.journal_summarizer = SimpleNamespace(summarize=forbidden)
        application.state.journal_title_generator = SimpleNamespace(generate=forbidden)
        for path, body in [(f"/api/entries/{entry_id}/summary", {}),
                           ("/api/ai/suggest-title", {"content": "private"})]:
            assert c.post(path, json=body).status_code == 429


def test_ai_concurrency_guard_releases_after_request(application):
    from sqlalchemy import text
    with client(application) as c:
        uid = register(c).json()["id"]
        application.state.journal_title_generator = SimpleNamespace(
            generate=lambda _: SimpleNamespace(suggested_title="A calm day"))
        with Session(application.state.engine) as held:
            held.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))"),
                         {"key": f"ai:active:{uid}"})
            assert c.post("/api/ai/suggest-title", json={"content": "test"}).status_code == 429
            held.rollback()
        assert c.post("/api/ai/suggest-title", json={"content": "test"}).status_code == 200


def test_request_size_cap_including_streamed_body(application):
    with client(application) as c:
        assert c.post("/api/auth/register", content=b"x"*65537).status_code == 413
        assert c.post("/api/auth/register", content=iter([b"x"*40000, b"y"*40000])).status_code == 413
        assert c.get("/api/auth/me").status_code == 401


def test_production_settings_fail_closed(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("AUTH_COOKIE_SECURE", "true")
    url = "postgresql+psycopg://runtime:unique-example-secret@db.example/app?sslmode=verify-full"
    validate_settings(url, "https://journal.example")
    for origin in ["http://journal.example", "https://journal.example/path", "https://user@journal.example"]:
        with pytest.raises(ValueError): validate_settings(url, origin)
    with pytest.raises(ValueError): validate_settings(url.replace("verify-full", "require"), "https://journal.example")
    monkeypatch.setenv("AUTH_COOKIE_SECURE", "false")
    with pytest.raises(ValueError): validate_settings(url, "https://journal.example")


@pytest.mark.parametrize("failure,expected", [(None, False), ("password", True), ("network", False)])
def test_database_password_probe_distinguishes_authentication_from_network_failure(monkeypatch, failure, expected):
    from app.deployment import password_authentication_enforced
    class Connection:
        def __enter__(self):
            if failure:
                error = RuntimeError("probe failure")
                error.orig = SimpleNamespace(sqlstate="28P01" if failure == "password" else "08001")
                raise error
            return self
        def __exit__(self, *args): pass
        def execute(self, *args): pass
    disposed = []
    monkeypatch.setattr("app.deployment.create_engine", lambda *a, **kw: SimpleNamespace(
        connect=lambda: Connection(), dispose=lambda: disposed.append(True)))
    assert password_authentication_enforced("postgresql://user:real-password@db/app") is expected
    assert disposed == [True]


def test_parallel_failed_logins_do_not_exceed_account_budget(application):
    def attempt(i):
        with client(application, f"192.0.2.{i+20}") as c:
            return login(c).status_code
    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(attempt, range(6)))
    assert sorted(codes) == [401]*5 + [429]


def test_development_database_owner_fails_production_posture(application):
    from app.deployment import validate_database
    with pytest.raises(RuntimeError, match="restricted"):
        validate_database(application.state.engine)
