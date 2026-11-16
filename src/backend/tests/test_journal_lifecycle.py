"""Exercise private journal CRUD with two real accounts and separate cookies."""

import asyncio
from datetime import date
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy.orm import Session

from app.models import JournalEntry, WeeklyReflection
from test_api import application_for


HEADERS = {
    "Origin": "http://localhost:5173",
    "X-AuraJournal-CSRF": "1",
    "Content-Type": "application/json",
}
REFLECTION_START = date(2024, 2, 26)


async def entries_on(client, day):
    response = await client.get("/api/entries/by-date", params={"date": day})
    assert response.status_code == 200
    return response.json()


async def saved_reflection(client):
    response = await client.get(f"/api/weekly-reflections/{REFLECTION_START}")
    assert response.status_code == 200
    return response.json()


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

            # Existing saved reflections coexist with CRUD without an AI dependency.
            with Session(migrated_engine) as session:
                session.add_all([
                    WeeklyReflection(
                        user_id=UUID(user["id"]), period_start=REFLECTION_START,
                        summary=f"Private saved week for person {index}.",
                        questions=[f"What helped person {index}?", f"What next for person {index}?"],
                    )
                    for index, user in enumerate(users)
                ])
                session.commit()
            snapshots = [await saved_reflection(client) for client in clients]
            for index, snapshot in enumerate(snapshots):
                assert snapshot["summary"] == f"Private saved week for person {index}."
                assert snapshot["questions"] == [
                    f"What helped person {index}?", f"What next for person {index}?",
                ]

            owner, other = clients[owner_index], clients[1 - owner_index]
            original, other_entry = entries[owner_index], entries[1 - owner_index]
            path = f"/api/entries/{original['id']}"
            assert (await owner.get("/api/auth/me")).json() == users[owner_index]
            assert (await other.get("/api/auth/me")).json() == users[1 - owner_index]
            assert (await owner.get("/api/entries")).json() == [original]
            assert (await other.get("/api/entries")).json() == [other_entry]
            assert await entries_on(owner, "2024-02-29") == [original]
            assert await entries_on(other, "2024-02-29") == [other_entry]
            detail = await owner.get(path)
            assert detail.status_code == 200
            assert detail.json() == original
            assert detail.headers["cache-control"] == "no-store"
            assert "user_id" not in detail.json()

            # Every valid foreign-ID operation is indistinguishable from a missing ID.
            missing_path = f"/api/entries/{uuid4()}"
            for method, body in [("GET", None), ("PATCH", {
                "content": "Intrusion", "journal_date": "2026-01-01",
            }), ("PATCH", {"journal_date": "2024-03-01"}), ("DELETE", None)]:
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

            # Moving leap day into a different month must update date-based reads,
            # without changing text, ownership, or the other account's same-day entry.
            moved_response = await owner.patch(path, json={"journal_date": "2024-03-01"})
            assert moved_response.status_code == 200
            moved = moved_response.json()
            assert moved["journal_date"] == "2024-03-01"
            assert moved["updated_at"] != original["updated_at"]
            assert {key: value for key, value in moved.items() if key not in {"journal_date", "updated_at"}} == {
                key: value for key, value in original.items() if key not in {"journal_date", "updated_at"}
            }
            assert (await owner.get(path)).json() == moved
            assert (await owner.get("/api/entries")).json() == [moved]
            assert await entries_on(owner, "2024-02-29") == []
            assert await entries_on(owner, "2024-03-01") == [moved]
            assert await entries_on(other, "2024-02-29") == [other_entry]
            assert await entries_on(other, "2024-03-01") == []
            with Session(migrated_engine) as session:
                assert session.get(JournalEntry, UUID(original["id"])).user_id == UUID(users[owner_index]["id"])
            for client, snapshot in zip(clients, snapshots):
                assert await saved_reflection(client) == snapshot

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
            assert await entries_on(owner, "2024-03-01") == []
            assert await entries_on(owner, "2025-12-31") == [updated]
            assert await entries_on(other, "2025-12-31") == []
            assert await saved_reflection(owner) == snapshots[owner_index]

            # A new app instance must read committed changes using the same session.
            restarted = application_for(migrated_engine)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=restarted), base_url="http://test",
                headers=HEADERS, cookies=owner.cookies,
            ) as reconnected:
                assert (await reconnected.get(path)).json() == updated
                assert await entries_on(reconnected, "2025-12-31") == [updated]
                assert await saved_reflection(reconnected) == snapshots[owner_index]
                deleted = await reconnected.delete(path)
                assert deleted.status_code == 204
                assert deleted.content == b""
                assert (await reconnected.get(path)).status_code == 404
                assert (await reconnected.delete(path)).status_code == 404
                assert (await reconnected.get("/api/entries")).json() == []
                assert await entries_on(reconnected, "2025-12-31") == []
                assert await saved_reflection(reconnected) == snapshots[owner_index]

            assert (await owner.get("/api/entries")).json() == []
            assert (await other.get("/api/entries")).json() == [other_entry]
            assert (await other.get(f"/api/entries/{other_entry['id']}")).json() == other_entry
            assert (await other.delete(f"/api/entries/{other_entry['id']}")).status_code == 204
            assert (await other.get("/api/entries")).json() == []
            assert await entries_on(other, "2024-02-29") == []
            for client, snapshot in zip(clients, snapshots):
                assert await saved_reflection(client) == snapshot

    asyncio.run(lifecycle())
