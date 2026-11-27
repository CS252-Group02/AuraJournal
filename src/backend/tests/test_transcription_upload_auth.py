import asyncio
from datetime import timedelta

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import COOKIE_NAME, digest, utcnow
from app.models import AuthSession, JournalEntry, User
from app.services.deepgram import DeepgramStreamingClient
from test_api import app, request  # noqa: F401 - real migrated DB and session cookies
from test_deepgram_service import FakeConnector, FakeSocket
from test_transcription import result
from test_transcription_upload import RecordedFixtureClient, AUDIO, HEADERS, PATH


@pytest.fixture
def provider(app):
    socket = FakeSocket(final_events=[result("A private fictional day.", final=True), {"type": "Metadata"}])
    connector = FakeConnector(socket)
    app.state.deepgram_recording_client = RecordedFixtureClient(DeepgramStreamingClient("key", connector=connector))
    return socket, connector


@pytest.mark.parametrize("state", ["anonymous", "invalid", "expired", "revoked", "disabled"])
def test_invalid_account_sessions_cannot_open_provider(app, provider, state):
    if state == "anonymous":
        app.auth_cookies = {}
    elif state == "invalid":
        app.auth_cookies = {COOKIE_NAME: "invalid-token"}
    else:
        with Session(app.state.engine) as session:
            stored = session.get(AuthSession, digest(app.auth_cookies[COOKIE_NAME]))
            if state == "expired":
                stored.expires_at = utcnow() - timedelta(seconds=1)
            elif state == "revoked":
                session.delete(stored)
            else:
                session.get(User, app.user_id).password_hash = "!disabled"
            session.commit()
    response = asyncio.run(request(app, "POST", PATH, headers=HEADERS, content=AUDIO))
    assert response.status_code == 401
    assert not provider[1].calls


def test_two_accounts_upload_independently_without_journal_writes_or_held_db_connections(app, provider):
    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as other:
            registered = await other.post("/api/auth/register", json={
                "email": "other-upload@example.com", "password": "fictional-test-password",
            }, headers={"Origin": HEADERS["Origin"], "X-AuraJournal-CSRF": "1"})
            assert registered.status_code == 201
            original_send = provider[0].send
            async def send(message):
                assert app.state.engine.pool.checkedout() == 0
                await original_send(message)
            provider[0].send = send
            first = await request(app, "POST", PATH, headers=HEADERS, content=AUDIO)
            assert first.status_code == 200
            provider[1].socket = FakeSocket(final_events=[result("Another fictional day.", final=True), {"type": "Metadata"}])
            second = await other.post(PATH, headers=HEADERS, content=AUDIO)
            assert second.status_code == 200
            assert first.json()["transcript"] == "A private fictional day."
            assert second.json()["transcript"] == "Another fictional day."
            assert (await other.get("/api/entries")).json() == []
            assert (await request(app, "GET", "/api/entries")).json() == []
    asyncio.run(run())
    with Session(app.state.engine) as session:
        assert session.scalar(select(func.count()).select_from(JournalEntry)) == 0


def test_uploads_share_existing_ai_budgets(app, provider):
    from app.limits import consume
    with Session(app.state.engine) as session:
        for _ in range(10):
            consume(session, [(f"ai:user:minute:{app.user_id}", 10, 60)])
    response = asyncio.run(request(app, "POST", PATH, headers=HEADERS, content=AUDIO))
    assert response.status_code == 429
    assert int(response.headers["retry-after"]) > 0
    assert not provider[1].calls
