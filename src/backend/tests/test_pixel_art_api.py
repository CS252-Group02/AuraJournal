import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID, uuid4

import pytest
from sqlalchemy import event, select, text
from sqlalchemy.orm import Session

from app.models import JournalEntry, JournalImage, User
from app.services._groq import AIInvalidResponseError, AIServiceNotConfiguredError, AIServiceUnavailableError
from app.services.image_lifecycle import GenerationConflict, generation_locks, reconcile_images
from app.services.image_storage import ImageStorage
from app.services.pixel_art import SignificantMoment
from app.services.pixellab import PixelArtError, PixelArtInvalidResponse, PixelArtRateLimited, PixelArtTimeout
from test_api import app, application_for, request  # noqa: F401
from test_pixellab import png


@pytest.fixture
def pixel_app(app, tmp_path):
    app.state.pixel_art_enabled = True
    app.state.image_storage = ImageStorage(tmp_path)
    app.state.moment_extractor = SimpleNamespace(extract=Mock(return_value=SignificantMoment(
        kind="grounded", moment="Finished homework", evidence="homework",
        scene="A person completing a homework exercise.",
    )))
    app.state.pixellab_client = SimpleNamespace(generate=Mock(return_value=png()))
    return app


def call(app, method, path, **kwargs):
    return asyncio.run(request(app, method, path, **kwargs))


def create(app, content="I finished homework. Tomorrow I might visit a friend."):
    response = call(app, "POST", "/api/entries", json={"content": content})
    assert response.status_code == 201
    return response.json()


def path(entry):
    return f"/api/entries/{entry['id']}/pixel-art"


def assert_no_files(app):
    assert not list(app.state.image_storage.root.rglob("*.png"))
    assert not list(app.state.image_storage.root.rglob("*.tmp"))
    with Session(app.state.engine) as session:
        assert session.scalar(select(JournalImage.id)) is None


def test_generation_association_retrieval_and_duplicate(pixel_app):
    app = pixel_app
    entry = create(app)
    result = call(app, "POST", path(entry), json={})
    assert result.status_code == 201
    data = result.json()
    assert data["entry_id"] == entry["id"]
    assert data["representation"] == "grounded"
    assert data["image"]["file_format"] == "png"
    assert data["image"]["width"] == data["image"]["height"] == 128
    assert "image_url" not in result.text and str(app.state.image_storage.root) not in result.text
    with Session(app.state.engine) as session:
        image = session.scalar(select(JournalImage).where(JournalImage.entry_id == UUID(entry["id"])))
        assert str(image.id) == data["image"]["id"]
        assert app.state.image_storage.read(image.image_url) == png()
    meta = call(app, "GET", path(entry))
    assert meta.status_code == 200 and meta.json()["image"] == data["image"]
    content = call(app, "GET", data["image"]["content_url"])
    assert content.status_code == 200 and content.content == png()
    assert content.headers["content-type"] == "image/png"
    assert content.headers["cache-control"] == "no-store"
    duplicate = call(app, "POST", path(entry), json={})
    assert duplicate.status_code == 200
    assert duplicate.json()["image"] == data["image"]
    app.state.pixellab_client.generate.assert_called_once()
    prompt = app.state.pixellab_client.generate.call_args.args[0]
    assert entry["content"] not in prompt and "Tomorrow" not in prompt
    assert call(app, "GET", "/api/entries").json() == [entry]


@pytest.mark.parametrize("method,suffix", [("POST", ""), ("GET", ""), ("GET", "/content")])
def test_ownership_and_authentication(pixel_app, method, suffix):
    app = pixel_app
    own = create(app)
    with Session(app.state.engine) as session:
        foreign = JournalEntry(user=User(email="foreign-image@example.test", password_hash="!disabled"), content="private")
        session.add(foreign)
        session.commit()
        foreign_id = foreign.id
    for identifier in (foreign_id, uuid4()):
        response = call(app, method, f"/api/entries/{identifier}/pixel-art{suffix}", **({"json": {}} if method == "POST" else {}))
        assert response.status_code == 404
    anonymous = application_for(app.state.engine)
    response = call(anonymous, method, path(own) + suffix, **({"json": {}} if method == "POST" else {}))
    assert response.status_code == 401
    app.state.pixellab_client.generate.assert_not_called()


@pytest.mark.parametrize("payload", [{"user_id": str(uuid4())}, {"prompt": "client scene"}, {"force": True}])
def test_generation_accepts_no_client_identity_or_prompt(pixel_app, payload):
    entry = create(pixel_app)
    assert call(pixel_app, "POST", path(entry), json=payload).status_code == 422
    pixel_app.state.pixellab_client.generate.assert_not_called()


def test_browser_protection_and_missing_metadata(pixel_app):
    entry = create(pixel_app)
    assert call(pixel_app, "GET", path(entry)).status_code == 404
    assert call(pixel_app, "GET", path(entry) + "/content").status_code == 404
    assert call(pixel_app, "POST", path(entry), json={}, headers={}).status_code == 403
    assert call(pixel_app, "POST", path(entry), json={}, headers={
        "Origin": "http://localhost:5173", "X-AuraJournal-CSRF": "1", "Content-Type": "text/plain",
    }).status_code == 415


@pytest.mark.parametrize("stage,error,code", [
    ("groq", AIInvalidResponseError("secret"), 502),
    ("groq", AIServiceUnavailableError("secret"), 503),
    ("groq", AIServiceNotConfiguredError("secret"), 503),
    ("pixel", PixelArtError("secret"), 503),
    ("pixel", PixelArtTimeout("secret"), 504),
    ("pixel", PixelArtInvalidResponse("secret"), 502),
    ("pixel", PixelArtRateLimited("secret"), 429),
    ("storage", PixelArtError("secret"), 503),
])
def test_failure_preserves_saved_journal_and_can_retry(pixel_app, monkeypatch, stage, error, code):
    app = pixel_app
    entry = create(app)
    target = app.state.moment_extractor.extract if stage == "groq" else app.state.pixellab_client.generate
    if stage == "storage":
        original = app.state.image_storage.save
        monkeypatch.setattr(app.state.image_storage, "save", Mock(side_effect=error))
    else:
        target.side_effect = error
    response = call(app, "POST", path(entry), json={})
    assert response.status_code == code
    assert "secret" not in response.text
    assert call(app, "GET", "/api/entries").json() == [entry]
    assert_no_files(app)
    if stage == "storage":
        monkeypatch.setattr(app.state.image_storage, "save", original)
    else:
        target.side_effect = None
    assert call(app, "POST", path(entry), json={}).status_code == 201


def test_journaling_works_with_generation_disabled(pixel_app):
    pixel_app.state.pixel_art_enabled = False
    entry = create(pixel_app)
    assert call(pixel_app, "POST", path(entry), json={}).status_code == 503
    assert call(pixel_app, "GET", "/api/entries").json() == [entry]
    pixel_app.state.moment_extractor.extract.assert_not_called()


@pytest.mark.parametrize("method,content", [("PATCH", "different"), ("DELETE", None), ("PATCH", "same")])
def test_edit_delete_consistency(pixel_app, method, content):
    app = pixel_app
    entry = create(app)
    assert call(app, "POST", path(entry), json={}).status_code == 201
    body = {"content": entry["content"] if content == "same" else content} if method == "PATCH" else {}
    response = call(app, method, f"/api/entries/{entry['id']}", json=body)
    assert response.status_code == (200 if method == "PATCH" else 204)
    if content == "same":
        assert call(app, "GET", path(entry)).status_code == 200
    else:
        assert call(app, "GET", path(entry)).status_code == 404
        assert_no_files(app)


@pytest.mark.parametrize("operation,expected", [("PATCH", 409), ("DELETE", 404)])
def test_edit_delete_during_generation_discards_result(pixel_app, operation, expected):
    app = pixel_app
    entry = create(app)
    started, resume = Event(), Event()

    def slow_provider(prompt):
        started.set()
        assert resume.wait(10)
        return png()

    app.state.pixellab_client.generate.side_effect = slow_provider
    with ThreadPoolExecutor() as pool:
        future = pool.submit(call, app, "POST", path(entry), json={})
        try:
            assert started.wait(10)
            changed = call(app, operation, f"/api/entries/{entry['id']}", json={"content": "Changed"})
            assert changed.status_code == (200 if operation == "PATCH" else 204)
        finally:
            resume.set()
        assert future.result(timeout=10).status_code == expected
    assert_no_files(app)


def test_duplicate_and_user_capacity_across_app_instances(pixel_app):
    app = pixel_app
    first, second = create(app), create(app)
    other = application_for(app.state.engine)
    other.auth_cookies = app.auth_cookies
    other.state.pixel_art_enabled = True
    started, resume = Event(), Event()

    def slow_provider(prompt):
        started.set()
        assert resume.wait(10)
        return png()

    app.state.pixellab_client.generate.side_effect = slow_provider
    with ThreadPoolExecutor() as pool:
        future = pool.submit(call, app, "POST", path(first), json={})
        try:
            assert started.wait(10)
            assert call(other, "POST", path(first), json={}).status_code == 409
            limited = call(other, "POST", path(second), json={})
            assert limited.status_code == 429 and limited.headers["retry-after"] == "30"
        finally:
            resume.set()
        assert future.result(timeout=10).status_code == 201
    assert app.state.pixellab_client.generate.call_count == 1


def test_no_idle_transaction_while_providers_run(pixel_app):
    app = pixel_app
    entry = create(app)

    def check_transactions(*args):
        with app.state.engine.connect() as connection:
            count = connection.scalar(text("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND state = 'idle in transaction'"))
            assert count == 0
        return png()

    app.state.pixellab_client.generate.side_effect = check_transactions
    assert call(app, "POST", path(entry), json={}).status_code == 201


def test_commit_failure_removes_new_file(pixel_app):
    app = pixel_app
    entry = create(app)

    def fail_insert(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith("INSERT INTO journal_images"):
            from sqlalchemy.exc import OperationalError
            raise OperationalError("hidden", {}, Exception("private"))

    event.listen(app.state.engine, "before_cursor_execute", fail_insert)
    try:
        assert call(app, "POST", path(entry), json={}).status_code == 503
    finally:
        event.remove(app.state.engine, "before_cursor_execute", fail_insert)
    assert_no_files(app)
    assert call(app, "POST", path(entry), json={}).status_code == 201


def test_reconciliation_removes_orphans_and_skips_active_and_referenced(pixel_app):
    app = pixel_app
    entry = create(app)
    assert call(app, "POST", path(entry), json={}).status_code == 201
    storage = app.state.image_storage
    orphan_entry = uuid4()
    orphan = storage.save(orphan_entry, uuid4(), png())
    abandoned = storage.path(f"pixel-art/{uuid4()}/{uuid4()}.png").with_suffix(".tmp")
    abandoned.parent.mkdir(parents=True)
    abandoned.write_bytes(b"partial")
    with generation_locks(app.state.engine, orphan_entry):
        assert reconcile_images(app.state.engine, storage) == 1
        assert storage.read(orphan) is not None
    assert not abandoned.exists()
    assert reconcile_images(app.state.engine, storage) == 1
    assert storage.read(orphan) is None
    assert call(app, "GET", path(entry) + "/content").status_code == 200


def test_failed_postcommit_cleanup_is_recoverable(pixel_app, monkeypatch):
    app = pixel_app
    entry = create(app)
    assert call(app, "POST", path(entry), json={}).status_code == 201
    original = app.state.image_storage.delete
    monkeypatch.setattr(app.state.image_storage, "delete", lambda key: False)
    assert call(app, "DELETE", f"/api/entries/{entry['id']}", json={}).status_code == 204
    assert call(app, "GET", path(entry) + "/content").status_code == 404
    monkeypatch.setattr(app.state.image_storage, "delete", original)
    assert reconcile_images(app.state.engine, app.state.image_storage) == 1
    assert_no_files(app)


def test_uncertain_commit_does_not_delete_referenced_file(pixel_app):
    app = pixel_app
    entry = create(app)
    factory = app.state.session_factory

    def uncertain_session():
        session = factory()
        commit = session.commit

        def commit_then_disconnect():
            from sqlalchemy.exc import OperationalError
            commit()
            raise OperationalError("hidden", {}, Exception("lost acknowledgement"))

        session.commit = commit_then_disconnect
        return session

    app.state.session_factory = uncertain_session
    try:
        assert call(app, "POST", path(entry), json={}).status_code == 503
        # The commit actually happened; an idempotent retry returns its result.
        assert call(app, "POST", path(entry), json={}).status_code == 200
        assert call(app, "GET", path(entry) + "/content").content == png()
        assert reconcile_images(app.state.engine, app.state.image_storage) == 0
    finally:
        app.state.session_factory = factory


def test_locks_release_on_failure_without_leaking_into_pool(pixel_app):
    entry_id = uuid4()
    with pytest.raises(RuntimeError):
        with generation_locks(pixel_app.state.engine, entry_id):
            with pytest.raises(GenerationConflict):
                with generation_locks(pixel_app.state.engine, entry_id):
                    pytest.fail("Second connection must not acquire the entry lock")
            raise RuntimeError("failed request")
    with pixel_app.state.engine.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())")) == 0
