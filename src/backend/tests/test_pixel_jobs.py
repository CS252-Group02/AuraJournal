"""Durable orchestration against real PostgreSQL; all providers are fakes."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from unittest.mock import Mock
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import event, func, select, update
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.auth import utcnow
from app.models import JournalEntry, PixelArtJob
from app.services._groq import AIServiceUnavailableError, AIServiceNotConfiguredError, AIInvalidResponseError
from app.services.image_lifecycle import generation_locks, reconcile_images
from app.services.pixel_jobs import PixelArtWorkers, run_pixel_job_once, schedule_pixel_art
from app.services.pixel_art import SignificantMoment
from app.services.pixellab import (
    PixelArtError, PixelArtTimeout, PixelArtCreditsUnavailable, PixelArtRateLimited, PixelArtInvalidResponse,
)
from conftest import migrate
from test_api import app, application_for  # noqa: F401
from test_pixel_art_api import pixel_app, call, create, path  # noqa: F401
from test_pixellab import png


def job_for(app, entry):
    with Session(app.state.engine) as session:
        return session.scalar(select(PixelArtJob).where(PixelArtJob.entry_id == UUID(entry["id"]))
                              .order_by(PixelArtJob.source_version.desc()))


def status(app, entry):
    response = call(app, "GET", path(entry) + "/status")
    assert response.status_code == 200
    return response.json()


def due(app, entry, **changes):
    with Session(app.state.engine) as session:
        session.execute(update(PixelArtJob).where(PixelArtJob.id == job_for(app, entry).id).values(
            available_at=utcnow() - timedelta(seconds=1), **changes))
        session.commit()


def test_create_commits_outbox_without_waiting_or_calling_providers(pixel_app):
    app = pixel_app
    app.state.moment_extractor.extract.side_effect = AssertionError("Must not call during save")
    app.state.pixellab_client.generate.side_effect = AssertionError("Must not call during save")
    entry = create(app)
    job = job_for(app, entry)
    assert (job.status, job.source_version, job.attempts, job.submitted_at) == ("pending", 1, 0, None)
    assert status(app, entry)["generation"]["status"] == "pending"
    app.state.moment_extractor.extract.assert_not_called()
    app.state.pixellab_client.generate.assert_not_called()


def test_job_insert_failure_rolls_back_journal_in_same_transaction(pixel_app):
    app = pixel_app
    def fail(connection, cursor, statement, *args):
        if statement.startswith("INSERT INTO pixel_art_jobs"):
            raise OperationalError("private", {}, Exception("secret"))
    event.listen(app.state.engine, "before_cursor_execute", fail)
    try:
        response = call(app, "POST", "/api/entries", json={"content": "Must roll back"})
        assert response.status_code == 503 and "secret" not in response.text
    finally:
        event.remove(app.state.engine, "before_cursor_execute", fail)
    with Session(app.state.engine) as session:
        assert session.scalar(select(func.count()).select_from(JournalEntry)) == 0
        assert session.scalar(select(func.count()).select_from(PixelArtJob)) == 0


def test_processing_is_durable_visible_and_save_is_independent(pixel_app):
    app = pixel_app
    entry = create(app)
    started, resume = Event(), Event()
    def provider(prompt):
        started.set()
        assert resume.wait(10)
        return png()
    app.state.pixellab_client.generate.side_effect = provider
    with ThreadPoolExecutor() as pool:
        future = pool.submit(run_pixel_job_once, app.state)
        try:
            assert started.wait(10)
            job = job_for(app, entry)
            assert job.status == "processing" and job.submitted_at is not None
            assert status(app, entry)["generation"]["status"] == "processing"
            second = create(app, "A second journal saves while generation is blocked.")
            assert job_for(app, second).status == "pending"
            assert call(app, "POST", path(entry), json={}).status_code == 409
            assert not run_pixel_job_once(app.state)  # Per-owner advisory lock.
        finally:
            resume.set()
        assert future.result(timeout=10)
    assert status(app, entry)["generation"]["status"] == "ready"
    assert job_for(app, entry).status == "ready"
    app.state.pixellab_client.generate.assert_called_once()


@pytest.mark.parametrize("error,expected", [
    (AIServiceNotConfiguredError("secret"), "unavailable"),
    (AIInvalidResponseError("secret"), "failed"),
])
def test_extractor_terminal_failures_preserve_journal(pixel_app, error, expected):
    entry = create(pixel_app)
    pixel_app.state.moment_extractor.extract.side_effect = error
    assert run_pixel_job_once(pixel_app.state)
    assert status(pixel_app, entry)["generation"]["status"] == expected
    assert call(pixel_app, "GET", "/api/entries").json() == [entry]
    pixel_app.state.pixellab_client.generate.assert_not_called()


def test_transient_extraction_retries_once_with_backoff_then_stops(pixel_app):
    app = pixel_app
    entry = create(app)
    app.state.moment_extractor.extract.side_effect = AIServiceUnavailableError("secret")
    assert run_pixel_job_once(app.state)
    job = job_for(app, entry)
    assert job.status == "pending" and job.attempts == 1 and job.available_at > utcnow()
    assert not run_pixel_job_once(app.state)
    due(app, entry)
    assert run_pixel_job_once(app.state)
    assert job_for(app, entry).status == "failed" and job_for(app, entry).attempts == 2
    assert not run_pixel_job_once(app.state)
    app.state.pixellab_client.generate.assert_not_called()


@pytest.mark.parametrize("second_grounded", [False, True])
def test_no_depictable_moment_requeues_without_submitting_pixel_art(pixel_app, second_grounded):
    app = pixel_app
    entry = create(app)
    symbolic = SignificantMoment(kind="symbolic", moment="No concrete moment", evidence=None, scene=None)
    grounded = app.state.moment_extractor.extract.return_value
    app.state.moment_extractor.extract.side_effect = [symbolic, grounded if second_grounded else symbolic]
    assert run_pixel_job_once(app.state)
    job = job_for(app, entry)
    assert (job.status, job.error_code, job.attempts, job.submitted_at) == ("pending", "no_depictable_moment", 1, None)
    assert job.available_at > utcnow() + timedelta(seconds=50)
    assert not run_pixel_job_once(app.state)
    app.state.pixellab_client.generate.assert_not_called()
    due(app, entry)
    assert run_pixel_job_once(app.state)
    job = job_for(app, entry)
    assert job.attempts == 2
    if second_grounded:
        assert job.status == "ready" and job.submitted_at is not None
        app.state.pixellab_client.generate.assert_called_once()
    else:
        assert (job.status, job.error_code, job.submitted_at) == ("failed", "no_depictable_moment", None)
        assert status(app, entry)["generation"]["error_code"] == "no_depictable_moment"
        app.state.pixellab_client.generate.assert_not_called()
    assert not run_pixel_job_once(app.state)
    assert call(app, "GET", "/api/entries").json() == [entry]


def test_manual_retry_requeues_only_unsubmitted_job_and_can_complete(pixel_app):
    app = pixel_app
    entry = create(app)
    symbolic = SignificantMoment(kind="symbolic", moment="No scene", evidence=None, scene=None)
    grounded = app.state.moment_extractor.extract.return_value
    app.state.moment_extractor.extract.side_effect = [symbolic, symbolic, grounded]
    assert run_pixel_job_once(app.state)
    due(app, entry)
    assert run_pixel_job_once(app.state)
    assert status(app, entry)["generation"]["retryable"] is True
    endpoint = path(entry) + "/retry"
    response = call(app, "POST", endpoint, json={})
    assert response.status_code == 200
    assert response.json()["generation"]["status"] == "pending"
    assert call(app, "POST", endpoint, json={}).status_code == 409
    assert run_pixel_job_once(app.state)
    assert status(app, entry)["generation"]["status"] == "ready"
    assert call(app, "POST", endpoint, json={}).status_code == 409
    app.state.pixellab_client.generate.assert_called_once()


def test_manual_retry_never_resubmits_uncertain_pixel_lab_work(pixel_app):
    app = pixel_app
    entry = create(app)
    app.state.pixellab_client.generate.side_effect = PixelArtTimeout("private")
    assert run_pixel_job_once(app.state)
    assert status(app, entry)["generation"]["retryable"] is False
    assert call(app, "POST", path(entry) + "/retry", json={}).status_code == 409
    app.state.pixellab_client.generate.assert_called_once()


def test_manual_retry_requires_owner_csrf_and_enabled_service(pixel_app):
    app = pixel_app
    entry = create(app)
    app.state.moment_extractor.extract.return_value = SignificantMoment(
        kind="symbolic", moment="No scene", evidence=None, scene=None)
    assert run_pixel_job_once(app.state)
    due(app, entry)
    assert run_pixel_job_once(app.state)
    endpoint = path(entry) + "/retry"
    anonymous = application_for(app.state.engine)
    assert call(anonymous, "POST", endpoint, json={}).status_code == 401
    assert call(app, "POST", endpoint, json={}, headers={"Origin": "https://evil.example", "X-AuraJournal-CSRF": "1"}).status_code == 403
    assert call(app, "POST", f"/api/entries/{uuid4()}/pixel-art/retry", json={}).status_code == 404
    app.state.pixel_art_enabled = False
    assert call(app, "POST", endpoint, json={}).status_code == 503
    assert job_for(app, entry).status == "failed"


@pytest.mark.parametrize("unavailable", ["disabled", "groq", "pixellab"])
def test_retry_status_and_feed_follow_artwork_availability(pixel_app, unavailable):
    app = pixel_app
    app.state.pixel_art_enabled = unavailable != "disabled"
    app.state.moment_extractor.configured = unavailable != "groq"
    app.state.pixellab_client.configured = unavailable != "pixellab"
    entry = create(app)
    if unavailable != "disabled":
        assert run_pixel_job_once(app.state)

    def feed_generation():
        response = call(app, "GET", f"/api/entries/pixel-art/memories?as_of={entry['journal_date']}")
        assert response.status_code == 200
        return response.json()["days"][0]["entries"][0]["generation"]

    for generation in (status(app, entry)["generation"], feed_generation()):
        assert generation["status"] == "unavailable"
        assert generation["retryable"] is False
    assert call(app, "POST", path(entry) + "/retry", json={}).status_code == 503
    assert job_for(app, entry).status == "unavailable"
    app.state.moment_extractor.extract.assert_not_called()
    app.state.pixellab_client.generate.assert_not_called()

    app.state.pixel_art_enabled = True
    app.state.moment_extractor.configured = True
    app.state.pixellab_client.configured = True
    assert status(app, entry)["generation"]["retryable"] is True
    assert feed_generation()["retryable"] is True
    response = call(app, "POST", path(entry) + "/retry", json={})
    assert response.status_code == 200
    assert response.json()["generation"]["status"] == "pending"
    assert response.json()["generation"]["retryable"] is False


@pytest.mark.parametrize("action", ["edit", "delete"])
def test_queued_symbolic_attempt_is_invalidated_when_journal_changes(pixel_app, action):
    app = pixel_app
    entry = create(app)
    app.state.moment_extractor.extract.return_value = SignificantMoment(
        kind="symbolic", moment="No concrete moment", evidence=None, scene=None,
    )
    assert run_pixel_job_once(app.state)
    old_job = job_for(app, entry).id
    if action == "edit":
        assert call(app, "PATCH", f"/api/entries/{entry['id']}", json={"content": "A new version"}).status_code == 200
    else:
        assert call(app, "DELETE", f"/api/entries/{entry['id']}", json={}).status_code == 204
    with Session(app.state.engine) as session:
        old = session.get(PixelArtJob, old_job)
        assert old is None if action == "delete" else old.status == "cancelled"
    app.state.pixellab_client.generate.assert_not_called()


@pytest.mark.parametrize("error,expected", [
    (PixelArtTimeout("secret"), "uncertain"), (PixelArtError("secret"), "uncertain"),
    (PixelArtCreditsUnavailable("secret"), "unavailable"),
    (PixelArtRateLimited("secret"), "failed"), (PixelArtInvalidResponse("secret"), "failed"),
])
def test_no_image_provider_retry_even_from_legacy_post(pixel_app, error, expected):
    app = pixel_app
    entry = create(app)
    app.state.pixellab_client.generate.side_effect = error
    assert run_pixel_job_once(app.state)
    assert job_for(app, entry).status == expected
    assert "secret" not in str(status(app, entry))
    assert call(app, "GET", "/api/entries").json() == [entry]
    for _ in range(3):
        assert not run_pixel_job_once(app.state)
        assert call(app, "POST", path(entry), json={}).status_code == 503
    app.state.pixellab_client.generate.assert_called_once()


@pytest.mark.parametrize("disabled_at_save", [False, True])
def test_disabled_generation_never_blocks_save_or_replays_on_enable(pixel_app, disabled_at_save):
    app = pixel_app
    app.state.pixel_art_enabled = not disabled_at_save
    entry = create(app)
    app.state.pixel_art_enabled = False
    run_pixel_job_once(app.state)
    assert job_for(app, entry).status == "unavailable"
    app.state.pixel_art_enabled = True
    assert not run_pixel_job_once(app.state)
    app.state.moment_extractor.extract.assert_not_called()
    app.state.pixellab_client.generate.assert_not_called()


def test_missing_configuration_avoids_sending_journal_to_either_provider(pixel_app):
    app = pixel_app
    app.state.pixellab_client.configured = False
    entry = create(app)
    assert run_pixel_job_once(app.state)
    assert job_for(app, entry).status == "unavailable"
    app.state.moment_extractor.extract.assert_not_called()
    app.state.pixellab_client.generate.assert_not_called()


def test_duplicate_scheduling_and_delivery_suppressed(pixel_app):
    app = pixel_app
    entry = create(app)
    with Session(app.state.engine) as session:
        saved = session.get(JournalEntry, UUID(entry["id"]))
        schedule_pixel_art(session, saved, enabled=True)
        schedule_pixel_art(session, saved, enabled=True)
        session.commit()
        assert session.scalar(select(func.count()).select_from(PixelArtJob)) == 1
    assert run_pixel_job_once(app.state)
    assert not run_pixel_job_once(app.state)
    assert call(app, "POST", path(entry), json={}).status_code == 200
    app.state.pixellab_client.generate.assert_called_once()


def test_pending_job_survives_application_restart(pixel_app):
    app = pixel_app
    entry = create(app)
    restarted = application_for(app.state.engine)
    restarted.state.pixel_art_enabled = True
    restarted.state.image_storage = app.state.image_storage
    restarted.state.moment_extractor = app.state.moment_extractor
    restarted.state.pixellab_client = app.state.pixellab_client
    assert run_pixel_job_once(restarted.state)
    assert status(app, entry)["generation"]["status"] == "ready"


@pytest.mark.parametrize("submitted,output,expected", [
    (False, False, "ready"), (True, False, "uncertain"), (True, True, "ready"),
])
def test_expired_crash_recovery_only_submits_when_safe(pixel_app, submitted, output, expected):
    app = pixel_app
    entry = create(app)
    job = job_for(app, entry)
    due(app, entry, status="processing", attempts=1, attempt_token=uuid4(),
        lease_expires_at=utcnow() - timedelta(seconds=1), submitted_at=utcnow() if submitted else None)
    if output:
        app.state.image_storage.save(UUID(entry["id"]), job.id, png())
        assert reconcile_images(app.state.engine, app.state.image_storage) == 0
    if submitted:
        app.state.pixel_art_enabled = False  # Recovery also works with generation disabled.
    assert run_pixel_job_once(app.state)
    assert job_for(app, entry).status == expected
    assert app.state.pixellab_client.generate.call_count == (0 if submitted else 1)
    if output:
        assert call(app, "GET", path(entry) + "/content").content == png()


def test_unexpired_lease_and_live_entry_lock_prevent_recovery(pixel_app):
    app = pixel_app
    entry = create(app)
    due(app, entry, status="processing", attempts=1, lease_expires_at=utcnow() + timedelta(seconds=60))
    assert not run_pixel_job_once(app.state)
    due(app, entry, lease_expires_at=utcnow() - timedelta(seconds=1))
    with generation_locks(app.state.engine, UUID(entry["id"])):
        assert not run_pixel_job_once(app.state)
    assert run_pixel_job_once(app.state)
    app.state.pixellab_client.generate.assert_called_once()


@pytest.mark.parametrize("operation", ["PATCH", "DELETE"])
def test_edit_delete_during_provider_call_cannot_attach_stale_image(pixel_app, operation):
    app = pixel_app
    entry = create(app)
    original_job = job_for(app, entry).id
    started, resume = Event(), Event()
    def provider(prompt):
        started.set()
        assert resume.wait(10)
        return png()
    app.state.pixellab_client.generate.side_effect = provider
    with ThreadPoolExecutor() as pool:
        future = pool.submit(run_pixel_job_once, app.state)
        try:
            assert started.wait(10)
            changed = call(app, operation, f"/api/entries/{entry['id']}", json={"content": "New content"})
            assert changed.status_code == (200 if operation == "PATCH" else 204)
        finally:
            resume.set()
        assert future.result(timeout=10)
    assert call(app, "GET", path(entry) + "/content").status_code == 404
    assert not list(app.state.image_storage.root.rglob("*.png"))
    with Session(app.state.engine) as session:
        old = session.get(PixelArtJob, original_job)
        assert old is None if operation == "DELETE" else old.status == "cancelled"
    if operation == "PATCH":
        assert job_for(app, entry).source_version == 2
        # The replacement journal needs evidence from its own current text.
        app.state.moment_extractor.extract.return_value = SignificantMoment(
            kind="symbolic", moment="A new beginning", evidence="New content",
            scene="An abstract emerging circle.",
        )
        assert run_pixel_job_once(app.state)
        assert status(app, entry)["generation"]["status"] == "ready"


def test_date_and_summary_changes_during_generation_keep_image(pixel_app):
    app = pixel_app
    entry = create(app)
    job_id = job_for(app, entry).id
    def provider(prompt):
        assert call(app, "PATCH", f"/api/entries/{entry['id']}", json={"journal_date": "2024-02-29"}).status_code == 200
        with Session(app.state.engine) as session:
            saved = session.get(JournalEntry, UUID(entry["id"]))
            saved.ai_summary = "Summary metadata"
            session.commit()
        return png()
    app.state.pixellab_client.generate.side_effect = provider
    assert run_pixel_job_once(app.state)
    assert job_for(app, entry).id == job_id
    assert status(app, entry)["journal_date"] == "2024-02-29"
    assert status(app, entry)["generation"]["status"] == "ready"


def test_attachment_error_keeps_output_without_another_charge(pixel_app):
    app = pixel_app
    entry = create(app)
    def fail(connection, cursor, statement, *args):
        if statement.startswith("INSERT INTO journal_images"):
            raise OperationalError("private", {}, Exception("secret"))
    event.listen(app.state.engine, "before_cursor_execute", fail)
    try:
        assert run_pixel_job_once(app.state)
    finally:
        event.remove(app.state.engine, "before_cursor_execute", fail)
    assert job_for(app, entry).status == "uncertain"
    assert reconcile_images(app.state.engine, app.state.image_storage) == 0
    # Operator may re-open attachment recovery after fixing storage/DB. The
    # immutable submitted_at marker makes this safe: it cannot call PixelLab.
    due(app, entry, status="processing", lease_expires_at=utcnow() - timedelta(seconds=1))
    assert run_pixel_job_once(app.state)
    assert status(app, entry)["generation"]["status"] == "ready"
    app.state.pixellab_client.generate.assert_called_once()


def test_daily_budget_does_not_fail_journal_save(pixel_app, monkeypatch):
    app = pixel_app
    monkeypatch.setenv("PIXEL_ART_USER_DAILY_LIMIT", "1")
    first, second = create(app), create(app)
    assert run_pixel_job_once(app.state)
    assert run_pixel_job_once(app.state)
    states = [job_for(app, item) for item in (first, second)]
    assert sorted(job.status for job in states) == ["ready", "unavailable"]
    assert next(job for job in states if job.status == "unavailable").error_code == "budget_exhausted"
    app.state.pixellab_client.generate.assert_called_once()


def test_status_feed_is_read_only_multiple_journals_and_private(pixel_app):
    app = pixel_app
    first, second = create(app), create(app)
    for _ in range(3):
        response = call(app, "GET", "/api/entries/pixel-art/memories?as_of=" + first["journal_date"])
        items = response.json()["days"][0]["entries"]
        assert {item["entry_id"] for item in items} == {first["id"], second["id"]}
        assert all(item["generation"]["status"] == "pending" and item["image"] is None for item in items)
        assert call(app, "GET", "/api/entries/pixel-art/recent?as_of=" + first["journal_date"]).json() == []
        status(app, first)
    assert job_for(app, first).attempts == job_for(app, second).attempts == 0
    app.state.moment_extractor.extract.assert_not_called()
    app.state.pixellab_client.generate.assert_not_called()
    other = application_for(app.state.engine)
    assert call(other, "GET", path(first) + "/status").status_code == 401
    registered = call(other, "POST", "/api/auth/register", json={"email": "other-status@example.com", "password": "test-password-long"})
    assert registered.status_code == 201
    other.auth_cookies = dict(registered.cookies)
    assert call(other, "GET", path(first) + "/status").status_code == 404
    assert call(other, "GET", "/api/entries/pixel-art/memories?as_of=" + first["journal_date"]).json()["days"] == []


def test_missing_image_status_does_not_resubmit(pixel_app):
    app = pixel_app
    entry = create(app)
    assert run_pixel_job_once(app.state)
    image_id = job_for(app, entry).id
    app.state.image_storage.delete(f"pixel-art/{entry['id']}/{image_id}.png")
    assert status(app, entry)["generation"]["error_code"] == "image_missing"
    assert status(app, entry)["generation"]["status"] == "failed"
    assert not run_pixel_job_once(app.state)
    app.state.pixellab_client.generate.assert_called_once()


def test_worker_lifespan_starts_and_drains_durable_jobs(pixel_app, monkeypatch):
    app = pixel_app
    entry = create(app)
    finished = Event()
    app.state.pixellab_client.generate.side_effect = lambda prompt: (finished.set(), png())[1]
    workers = PixelArtWorkers(app.state)
    monkeypatch.setenv("PIXEL_ART_WORKER_ENABLED", "true")
    monkeypatch.setattr("app.main.PixelArtWorkers", lambda state: workers)
    with TestClient(app):
        assert finished.wait(10)
    assert all(not thread.is_alive() for thread in workers.threads)
    assert status(app, entry)["generation"]["status"] == "ready"


def test_migration_round_trip_preserves_history_without_backfilling_jobs(isolated_engine):
    migrate(isolated_engine, "0009")
    from app.config import DEVELOPMENT_USER_ID
    from sqlalchemy import text
    entry_id = uuid4()
    with isolated_engine.begin() as connection:
        connection.execute(text("INSERT INTO journal_entries (id,user_id,content) VALUES (:id,:owner,'Historical')"),
                           {"id": entry_id, "owner": DEVELOPMENT_USER_ID})
    migrate(isolated_engine)
    with Session(isolated_engine) as session:
        assert session.get(JournalEntry, entry_id).content_version == 1
        assert session.scalar(select(func.count()).select_from(PixelArtJob)) == 0
    migrate(isolated_engine, "0009", downgrade=True)
    migrate(isolated_engine)
    with Session(isolated_engine) as session:
        assert session.get(JournalEntry, entry_id).content == "Historical"
        assert session.scalar(select(func.count()).select_from(PixelArtJob)) == 0


def test_independent_workers_do_not_duplicate_even_when_lease_expires(pixel_app):
    app = pixel_app
    entry = create(app)
    other = application_for(app.state.engine)
    other.state.pixel_art_enabled = True
    other.state.moment_extractor = app.state.moment_extractor
    other.state.pixellab_client = app.state.pixellab_client
    other.state.image_storage = app.state.image_storage
    started, resume = Event(), Event()
    def provider(prompt):
        started.set()
        assert resume.wait(10)
        return png()
    app.state.pixellab_client.generate.side_effect = provider
    with ThreadPoolExecutor() as pool:
        future = pool.submit(run_pixel_job_once, app.state)
        try:
            assert started.wait(10)
            due(app, entry, lease_expires_at=utcnow() - timedelta(seconds=1))
            assert not run_pixel_job_once(other.state)
        finally:
            resume.set()
        assert future.result(timeout=10)
    assert job_for(app, entry).status == "ready"
    app.state.pixellab_client.generate.assert_called_once()


def test_global_capacity_across_processes_and_users(pixel_app):
    app = pixel_app
    app.state.pixel_art_concurrency = 1
    entry = create(app)
    other = application_for(app.state.engine)
    registered = call(other, "POST", "/api/auth/register", json={
        "email": "capacity@example.com", "password": "test-password-long",
    })
    assert registered.status_code == 201
    other.auth_cookies = dict(registered.cookies)
    other.state.pixel_art_enabled = True
    other.state.pixel_art_concurrency = 1
    other.state.moment_extractor = app.state.moment_extractor
    other.state.pixellab_client = app.state.pixellab_client
    other.state.image_storage = app.state.image_storage
    second = create(other)
    started, resume = Event(), Event()
    def provider(prompt):
        started.set()
        assert resume.wait(10)
        return png()
    app.state.pixellab_client.generate.side_effect = provider
    with ThreadPoolExecutor() as pool:
        future = pool.submit(run_pixel_job_once, app.state)
        try:
            assert started.wait(10)
            assert not run_pixel_job_once(other.state)
            assert job_for(app, second).attempts == 0
        finally:
            resume.set()
        assert future.result(timeout=10)
    assert run_pixel_job_once(other.state)
    assert status(app, entry)["generation"]["status"] == "ready"
    assert status(other, second)["generation"]["status"] == "ready"
    assert app.state.pixellab_client.generate.call_count == 2


def test_content_change_during_extraction_fences_image_submission(pixel_app):
    app = pixel_app
    entry = create(app)
    moment = app.state.moment_extractor.extract.return_value
    def extract(content):
        assert call(app, "PATCH", f"/api/entries/{entry['id']}", json={"content": "Another event"}).status_code == 200
        return moment
    app.state.moment_extractor.extract.side_effect = extract
    assert run_pixel_job_once(app.state)
    assert job_for(app, entry).source_version == 2
    app.state.pixellab_client.generate.assert_not_called()


def test_identical_content_and_date_only_edits_keep_one_pending_job(pixel_app):
    app = pixel_app
    entry = create(app)
    original = job_for(app, entry)
    assert call(app, "PATCH", f"/api/entries/{entry['id']}", json={"content": "  " + entry["content"] + "  "}).status_code == 200
    assert call(app, "PATCH", f"/api/entries/{entry['id']}", json={"journal_date": "2024-02-29"}).status_code == 200
    assert job_for(app, entry).id == original.id
    with Session(app.state.engine) as session:
        assert session.scalar(select(func.count()).select_from(PixelArtJob)) == 1


def test_deleting_queued_journal_cascades_job_without_provider_calls(pixel_app):
    app = pixel_app
    entry = create(app)
    assert call(app, "DELETE", f"/api/entries/{entry['id']}", json={}).status_code == 204
    assert not run_pixel_job_once(app.state)
    assert job_for(app, entry) is None
    app.state.moment_extractor.extract.assert_not_called()
    app.state.pixellab_client.generate.assert_not_called()


def test_storage_failure_is_uncertain_and_never_resubmits(pixel_app, monkeypatch):
    app = pixel_app
    entry = create(app)
    monkeypatch.setattr(app.state.image_storage, "save", Mock(side_effect=PixelArtError("private")))
    assert run_pixel_job_once(app.state)
    assert status(app, entry)["generation"]["status"] == "uncertain"
    assert not run_pixel_job_once(app.state)
    app.state.pixellab_client.generate.assert_called_once()


def test_lost_commit_acknowledgement_keeps_ready_image(pixel_app):
    app = pixel_app
    entry = create(app)
    factory = app.state.session_factory
    def uncertain_session():
        session = factory()
        commit = session.commit
        def commit_then_disconnect():
            ready = any(isinstance(row, PixelArtJob) and row.status == "ready" for row in session.identity_map.values())
            commit()
            if ready:
                raise OperationalError("hidden", {}, Exception("lost acknowledgement"))
        session.commit = commit_then_disconnect
        return session
    app.state.session_factory = uncertain_session
    try:
        assert run_pixel_job_once(app.state)
    finally:
        app.state.session_factory = factory
    assert job_for(app, entry).status == "ready"
    assert call(app, "GET", path(entry) + "/content").content == png()
    assert reconcile_images(app.state.engine, app.state.image_storage) == 0
    assert not run_pixel_job_once(app.state)
    app.state.pixellab_client.generate.assert_called_once()


def test_historical_journal_is_not_requested_and_reads_do_not_backfill(pixel_app):
    app = pixel_app
    with Session(app.state.engine) as session:
        historical = JournalEntry(content="Historical", user_id=app.user_id)
        session.add(historical)
        session.commit()
        entry = {"id": str(historical.id)}
    assert status(app, entry)["generation"]["status"] == "not_requested"
    assert call(app, "POST", path(entry), json={}).status_code == 503
    assert not run_pixel_job_once(app.state)
    assert job_for(app, entry) is None


def test_large_owner_backlog_does_not_starve_another_user(pixel_app):
    app = pixel_app
    first = create(app)
    with Session(app.state.engine) as session:
        for _ in range(32):
            queued = JournalEntry(user_id=app.user_id, content="Another queued journal")
            session.add(queued)
            schedule_pixel_art(session, queued, enabled=True)
        session.commit()
    other = application_for(app.state.engine)
    registered = call(other, "POST", "/api/auth/register", json={
        "email": "backlog@example.com", "password": "test-password-long",
    })
    assert registered.status_code == 201
    other.auth_cookies = dict(registered.cookies)
    other.state.pixel_art_enabled = True
    other.state.moment_extractor = app.state.moment_extractor
    other.state.pixellab_client = app.state.pixellab_client
    other.state.image_storage = app.state.image_storage
    second = create(other)
    started, resume = Event(), Event()
    def provider(prompt):
        if not started.is_set():
            started.set()
            assert resume.wait(10)
        return png()
    app.state.pixellab_client.generate.side_effect = provider
    with ThreadPoolExecutor() as pool:
        future = pool.submit(run_pixel_job_once, app.state)
        try:
            assert started.wait(10)
            assert run_pixel_job_once(other.state)
            assert status(other, second)["generation"]["status"] == "ready"
        finally:
            resume.set()
        assert future.result(timeout=10)
    assert status(app, first)["generation"]["status"] == "ready"
