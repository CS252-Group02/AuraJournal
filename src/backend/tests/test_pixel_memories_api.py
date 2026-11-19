from datetime import date, datetime, timedelta, timezone
from unittest.mock import Mock
from uuid import UUID, uuid4

import pytest
from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.models import JournalEntry, JournalImage, User
from app.routers import pixel_art
from app.services.journal_images import attach_image
from test_api import app, application_for, request  # noqa: F401
from test_pixel_art_api import pixel_app, call, create, path  # noqa: F401
from test_pixellab import png

FEED = "/api/entries/pixel-art/memories"
CUTOFF = date(2027, 1, 3)


def feed(app, as_of=CUTOFF):
    return call(app, "GET", f"{FEED}?as_of={as_of.isoformat()}")


def seed_memory(session, app, owner, day, number, *, image=True, created=None):
    entry_id, image_id = UUID(int=number), UUID(int=number + 10000)
    entry = JournalEntry(id=entry_id, user_id=owner, content="Fictional private journal",
                         journal_date=day, created_at=created or datetime(2026, 11, 20, tzinfo=timezone.utc))
    session.add(entry)
    session.flush()
    if image:
        key = app.state.image_storage.save(entry_id, image_id, png())
        attach_image(session, owner, entry_id, image_id, key)
    return entry_id


def test_empty_feed_and_missing_images_work_without_generation(pixel_app):
    app = pixel_app
    app.state.pixel_art_enabled = False
    assert feed(app).json() == {"as_of": CUTOFF.isoformat(), "days": []}
    entry = call(app, "POST", "/api/entries", json={"content": "No illustration yet", "journal_date": CUTOFF.isoformat()}).json()
    response = feed(app)
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert response.json() == {"as_of": CUTOFF.isoformat(), "days": [{
        "journal_date": CUTOFF.isoformat(), "entries": [{"entry_id": entry["id"], "image": None}],
    }]}
    assert call(app, "GET", f"/api/entries/pixel-art/recent?as_of={CUTOFF}").json() == []
    assert call(app, "GET", path(entry)).status_code == 404
    app.state.pixellab_client.generate.assert_not_called()
    app.state.moment_extractor.extract.assert_not_called()


def test_latest_seven_occupied_days_preserve_missing_art_all_entries_and_stable_order(pixel_app):
    app = pixel_app
    with Session(app.state.engine) as session:
        other = User(email="memories-other@example.test", password_hash="!disabled")
        session.add(other)
        session.flush()
        for offset in range(8):
            seed_memory(session, app, app.user_id, CUTOFF - timedelta(days=offset * 4), 100 + offset,
                        image=offset != 2)
        seed_memory(session, app, app.user_id, CUTOFF, 200)
        seed_memory(session, app, app.user_id, CUTOFF, 201)
        seed_memory(session, app, app.user_id, CUTOFF, 50, image=False,
                    created=datetime(2026, 11, 21, tzinfo=timezone.utc))
        seed_memory(session, app, app.user_id, CUTOFF + timedelta(days=1), 901)
        seed_memory(session, app, other.id, CUTOFF, 900)
        session.commit()
    statements = []

    def trace(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT") and "journal_images" in statement:
            statements.append(statement)

    event.listen(app.state.engine, "before_cursor_execute", trace)
    try:
        response = feed(app)
    finally:
        event.remove(app.state.engine, "before_cursor_execute", trace)
    assert response.status_code == 200
    assert len(statements) == 1  # No per-entry lazy image queries.
    data = response.json()
    assert [day["journal_date"] for day in data["days"]] == [
        (CUTOFF - timedelta(days=offset * 4)).isoformat() for offset in range(7)
    ]
    assert [entry["entry_id"] for entry in data["days"][0]["entries"]] == [
        str(UUID(int=number)) for number in [50, 201, 200, 100]
    ]
    assert data["days"][2]["entries"] == [{"entry_id": str(UUID(int=102)), "image": None}]
    assert data["days"][0]["entries"][0]["image"] is None
    images = [entry["image"] for day in data["days"] for entry in day["entries"] if entry["image"]]
    assert len(images) == 8  # Seven journal days, not seven image cards.
    assert "image_url" not in response.text and "Fictional private journal" not in response.text
    assert str(app.state.image_storage.root) not in response.text
    assert feed(app).json() == data
    assert len(call(app, "GET", f"/api/entries/pixel-art/recent?as_of={CUTOFF}").json()) == 8
    assert call(app, "GET", images[0]["content_url"]).content == png()
    app.state.pixellab_client.generate.assert_not_called()


def test_generated_image_is_saved_and_retrieved_after_restart_without_provider_calls(pixel_app):
    app = pixel_app
    entry = create(app)
    generated = call(app, "POST", path(entry), json={})
    assert generated.status_code == 201
    cutoff = date.fromisoformat(entry["journal_date"])
    expected = {"as_of": entry["journal_date"], "days": [{
        "journal_date": entry["journal_date"],
        "entries": [{"entry_id": entry["id"], "image": generated.json()["image"]}],
    }]}
    assert feed(app, cutoff).json() == expected
    restarted = application_for(app.state.engine)
    restarted.auth_cookies = app.auth_cookies
    restarted.state.image_storage = app.state.image_storage
    restarted.state.pixel_art_enabled = False
    assert feed(restarted, cutoff).json() == expected
    assert call(restarted, "GET", generated.json()["image"]["content_url"]).content == png()
    app.state.pixellab_client.generate.assert_called_once()


@pytest.mark.parametrize("endpoint", [FEED, "/api/entries/pixel-art/recent"])
@pytest.mark.parametrize("suffix", ["", "?as_of=invalid", "?as_of=0", "?as_of=20270103", "?as_of=2027-01-03T00:00:00Z", "?as_of=2027-02-30"])
def test_feed_requires_an_exact_calendar_cutoff(pixel_app, endpoint, suffix):
    assert call(pixel_app, "GET", endpoint + suffix).status_code == 422
    pixel_app.state.pixellab_client.generate.assert_not_called()


@pytest.mark.parametrize("day", ["0001-01-01", "9999-12-31"])
def test_empty_feed_handles_supported_date_limits(pixel_app, day):
    assert call(pixel_app, "GET", f"{FEED}?as_of={day}").json() == {"as_of": day, "days": []}


def test_feed_and_each_content_url_remain_private_between_signed_in_accounts(pixel_app):
    app = pixel_app
    entry = create(app)
    generated = call(app, "POST", path(entry), json={}).json()
    cutoff = date.fromisoformat(entry["journal_date"])
    anonymous = application_for(app.state.engine)
    assert feed(anonymous, cutoff).status_code == 401
    other = application_for(app.state.engine)
    registered = call(other, "POST", "/api/auth/register", json={
        "email": "memory-account@example.com", "password": "test-password-long",
    })
    assert registered.status_code == 201
    other.auth_cookies = dict(registered.cookies)
    assert feed(other, cutoff).json()["days"] == []
    other.state.image_storage = app.state.image_storage
    with Session(app.state.engine) as session:
        other_entry = seed_memory(session, app, UUID(registered.json()["id"]), cutoff, 777)
        session.commit()
    other_feed = feed(other, cutoff).json()
    assert [item["entry_id"] for day in other_feed["days"] for item in day["entries"]] == [str(other_entry)]
    other_url = other_feed["days"][0]["entries"][0]["image"]["content_url"]
    assert call(other, "GET", other_url).content == png()
    assert call(app, "GET", other_url).status_code == 404
    assert call(other, "GET", path(entry)).status_code == 404
    assert call(other, "GET", generated["image"]["content_url"]).status_code == 404
    assert call(anonymous, "GET", generated["image"]["content_url"]).status_code == 401
    assert call(app, "GET", f"{FEED}?as_of={cutoff}&user_id={registered.json()['id']}").json() == feed(app, cutoff).json()


@pytest.mark.parametrize("kind", ["foreign_key", "external_url", "traversal", "wrong_format"])
def test_invalid_stored_references_never_serve_another_journals_file(pixel_app, monkeypatch, kind):
    app = pixel_app
    own = create(app)
    other_image_id = uuid4()
    with Session(app.state.engine) as session:
        other = JournalEntry(user=User(email="foreign-key@example.test", password_hash="!disabled"), content="Private other owner")
        session.add(other)
        session.flush()
        other_key = app.state.image_storage.save(other.id, other_image_id, png())
        attach_image(session, other.user_id, other.id, other_image_id, other_key)
        own_id, image_id = UUID(own["id"]), uuid4()
        keys = {"foreign_key": other_key, "external_url": "https://example.test/private.png",
                "traversal": "../private.png", "wrong_format": f"pixel-art/{own_id}/{image_id}.png"}
        session.add(JournalImage(id=image_id, entry_id=own_id, image_url=keys[kind],
                                 file_format="jpg" if kind == "wrong_format" else "png"))
        session.commit()
    read = Mock(side_effect=AssertionError("Invalid references must not reach storage"))
    monkeypatch.setattr(app.state.image_storage, "read", read)
    assert call(app, "GET", path(own)).status_code == 404
    assert call(app, "GET", path(own) + "/content").status_code == 404
    assert call(app, "POST", path(own), json={}).status_code == 404
    data = feed(app, date.fromisoformat(own["journal_date"])).json()
    assert data["days"][0]["entries"] == [{"entry_id": own["id"], "image": None}]
    assert call(app, "GET", "/api/entries/pixel-art/recent?as_of=" + own["journal_date"]).json() == []
    read.assert_not_called()
    app.state.pixellab_client.generate.assert_not_called()


def test_missing_physical_file_is_a_recoverable_content_404_not_automatic_regeneration(pixel_app):
    app = pixel_app
    entry = create(app)
    image = call(app, "POST", path(entry), json={}).json()["image"]
    with Session(app.state.engine) as session:
        key = session.scalar(select(JournalImage.image_url))
    assert app.state.image_storage.delete(key)
    assert feed(app, date.fromisoformat(entry["journal_date"])).json()["days"][0]["entries"][0]["image"] == image
    assert call(app, "GET", image["content_url"]).status_code == 404
    app.state.pixellab_client.generate.assert_called_once()


def test_date_edits_content_changes_and_deletion_refresh_the_feed(pixel_app):
    app = pixel_app
    entry = create(app)
    image = call(app, "POST", path(entry), json={}).json()["image"]
    cutoff = date.fromisoformat(entry["journal_date"])
    endpoint = "/api/entries/" + entry["id"]
    assert call(app, "PATCH", endpoint, json={"journal_date": "2024-02-29"}).status_code == 200
    moved = feed(app, cutoff).json()["days"][0]
    assert moved == {"journal_date": "2024-02-29", "entries": [{"entry_id": entry["id"], "image": image}]}
    assert call(app, "PATCH", endpoint, json={"content": "Changed journal content"}).status_code == 200
    assert feed(app, cutoff).json()["days"][0]["entries"][0]["image"] is None
    assert call(app, "GET", image["content_url"]).status_code == 404
    assert call(app, "DELETE", endpoint, json={}).status_code == 204
    assert feed(app, cutoff).json()["days"] == []


def test_memory_query_failure_returns_safe_unavailable_response(pixel_app, monkeypatch):
    def unavailable(*args):
        raise OperationalError("private SQL", {}, Exception("private credentials"))

    monkeypatch.setattr(pixel_art, "recent_journal_memories", unavailable)
    response = feed(pixel_app)
    assert response.status_code == 503
    assert response.json() == {"detail": "Database is unavailable. Please try again later."}
    assert response.headers["cache-control"] == "no-store"
