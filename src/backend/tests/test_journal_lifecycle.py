"""Exercise private journal CRUD with two real accounts and separate cookies."""

import asyncio
from uuid import uuid4

import httpx
import pytest

from test_api import application_for


HEADERS = {
    "Origin": "http://localhost:5173",
    "X-AuraJournal-CSRF": "1",
    "Content-Type": "application/json",
}


@pytest.mark.parametrize("owner_index", [0, 1])
def test_two_registered_users_have_independent_persistent_journal_lifecycles(migrated_engine, owner_index):
    async def lifecycle():
        application = application_for(migrated_engine)
        transport = httpx.ASGITransport(app=application)
        async with (
            httpx.AsyncClient(transport=transport, base_url="http://test", headers=HEADERS) as alice,
            httpx.AsyncClient(transport=transport, base_url="http://test", headers=HEADERS) as bob,
        ):
            clients = [alice, bob]
            users, entries = [], []
            for index, client in enumerate(clients):
                credentials = {"email": f"person{index}@example.com", "password": "test-password"}
                registered = await client.post("/api/auth/register", json=credentials)
                assert registered.status_code == 201
                users.append(registered.json())
                assert (await client.get("/api/entries")).json() == []

                # Use the real login flow as well as registration's initial session.
                assert (await client.post("/api/auth/logout", json={})).status_code == 204
                assert (await client.get("/api/entries")).status_code == 401
                logged_in = await client.post("/api/auth/login", json=credentials)
                assert logged_in.status_code == 200
                assert logged_in.json() == registered.json()

                created = await client.post("/api/entries", json={
                    "content": f"Private experience {index}", "journal_date": "2024-02-29",
                })
                assert created.status_code == 201
                entries.append(created.json())

            owner, other = clients[owner_index], clients[1 - owner_index]
            original, other_entry = entries[owner_index], entries[1 - owner_index]
            path = f"/api/entries/{original['id']}"
            assert (await owner.get("/api/auth/me")).json() == users[owner_index]
            assert (await other.get("/api/auth/me")).json() == users[1 - owner_index]
            assert (await owner.get("/api/entries")).json() == [original]
            assert (await other.get("/api/entries")).json() == [other_entry]
            detail = await owner.get(path)
            assert detail.status_code == 200
            assert detail.json() == original
            assert detail.headers["cache-control"] == "no-store"
            assert "user_id" not in detail.json()

            # Every valid foreign-ID operation is indistinguishable from a missing ID.
            missing_path = f"/api/entries/{uuid4()}"
            for method, body in [("GET", None), ("PATCH", {
                "content": "Intrusion", "journal_date": "2026-01-01",
            }), ("DELETE", None)]:
                kwargs = {"json": body} if body is not None else {}
                forbidden = await other.request(method, path, **kwargs)
                missing = await other.request(method, missing_path, **kwargs)
                assert forbidden.status_code == missing.status_code == 404
                assert forbidden.json() == missing.json() == {"detail": "Journal entry was not found."}
                assert forbidden.headers["cache-control"] == "no-store"
            assert (await owner.get(path)).json() == original

            # Ownership is assigned by the session and cannot be supplied or transferred.
            spoofed = {"content": "Spoof", "user_id": users[1 - owner_index]["id"]}
            assert (await owner.post("/api/entries", json=spoofed)).status_code == 422
            assert (await owner.patch(path, json=spoofed)).status_code == 422
            assert (await owner.get("/api/entries")).json() == [original]

            edited = await owner.patch(path, json={
                "content": "  Revised private experience  ", "journal_date": "2025-12-31",
            })
            assert edited.status_code == 200
            updated = edited.json()
            assert updated["content"] == "Revised private experience"
            assert updated["journal_date"] == "2025-12-31"
            assert updated["id"] == original["id"]
            assert updated["created_at"] == original["created_at"]
            assert updated["updated_at"] != original["updated_at"]
            assert (await owner.get(path)).json() == updated
            assert (await owner.get("/api/entries")).json() == [updated]
            assert (await other.get("/api/entries")).json() == [other_entry]

            # A new app instance must read committed changes using the same session.
            restarted = application_for(migrated_engine)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=restarted), base_url="http://test",
                headers=HEADERS, cookies=owner.cookies,
            ) as reconnected:
                assert (await reconnected.get(path)).json() == updated
                deleted = await reconnected.delete(path)
                assert deleted.status_code == 204
                assert deleted.content == b""
                assert (await reconnected.get(path)).status_code == 404
                assert (await reconnected.delete(path)).status_code == 404
                assert (await reconnected.get("/api/entries")).json() == []

            assert (await owner.get("/api/entries")).json() == []
            assert (await other.get("/api/entries")).json() == [other_entry]
            assert (await other.get(f"/api/entries/{other_entry['id']}")).json() == other_entry
            assert (await other.delete(f"/api/entries/{other_entry['id']}")).status_code == 204
            assert (await other.get("/api/entries")).json() == []

    asyncio.run(lifecycle())
