"""One-session media journeys across queue, metadata, private bytes and logout."""
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid import UUID

from app.models import JournalImage
from app.services.pixel_jobs import run_pixel_job_once
from app.services.pixellab import PixelArtTimeout
from test_api import app, application_for  # noqa: F401
from test_pixel_art_api import pixel_app, call, create, path  # noqa: F401
from test_pixellab import png


def memory(app, entry):
    result = call(app, "GET", f"/api/entries/pixel-art/memories?as_of={entry['journal_date']}")
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    return next(item for day in result.json()["days"] for item in day["entries"] if item["entry_id"] == entry["id"])


def test_saved_entry_becomes_private_png_in_status_metadata_and_memories(pixel_app):
    app = pixel_app
    entry = create(app)
    assert call(app, "GET", path(entry) + "/status").json()["generation"]["status"] == "pending"
    assert memory(app, entry)["generation"]["status"] == "pending"
    assert call(app, "GET", path(entry)).status_code == 404
    app.state.pixellab_client.generate.assert_not_called()
    app.state.moment_extractor.extract.assert_not_called()
    assert run_pixel_job_once(app.state)
    ready = call(app, "GET", path(entry) + "/status").json()
    assert ready["generation"]["status"] == "ready"
    meta = call(app, "GET", path(entry)).json()
    assert ready["image"] == meta["image"] == memory(app, entry)["image"]
    content_path = meta["image"]["content_url"]
    assert content_path == path(entry) + "/content"
    image = call(app, "GET", content_path)
    assert image.content == png() and image.headers["content-type"] == "image/png"
    assert image.headers["cache-control"] == "no-store"
    assert image.headers["x-content-type-options"] == "nosniff"
    assert str(app.state.image_storage.root) not in str(meta)
    # Saved images remain available with generation disabled and after restart.
    restarted = application_for(app.state.engine)
    restarted.auth_cookies = app.auth_cookies
    restarted.state.image_storage = app.state.image_storage
    restarted.state.pixel_art_enabled = False
    assert call(restarted, "GET", content_path).content == png()
    other = application_for(app.state.engine)
    registration = call(other, "POST", "/api/auth/register", json={
        "email": "media-other@example.com", "password": "test-password-long"})
    assert registration.status_code == 201
    other.auth_cookies = dict(registration.cookies)
    for suffix in ["", "/status", "/content"]:
        assert call(other, "GET", path(entry) + suffix).status_code == 404
    assert call(other, "GET", f"/api/entries/pixel-art/memories?as_of={entry['journal_date']}").json()["days"] == []
    assert call(app, "POST", "/api/auth/logout", json={}).status_code == 204
    for application in [app, restarted]:
        for suffix in ["", "/status", "/content"]:
            assert call(application, "GET", path(entry) + suffix).status_code == 401
    app.state.pixellab_client.generate.assert_called_once()
    app.state.moment_extractor.extract.assert_called_once()


def test_missing_committed_png_has_consistent_failure_without_resubmission(pixel_app):
    app = pixel_app
    entry = create(app)
    assert run_pixel_job_once(app.state)
    with Session(app.state.engine) as session:
        image = session.scalar(select(JournalImage).where(JournalImage.entry_id == UUID(entry["id"])))
        app.state.image_storage.delete(image.image_url)
    status = call(app, "GET", path(entry) + "/status").json()
    assert status["generation"]["status"] == "failed"
    assert status["generation"]["error_code"] == "image_missing"
    assert status["generation"]["retryable"] is False
    assert memory(app, entry)["generation"] == status["generation"]
    assert call(app, "GET", path(entry)).status_code == 200  # Metadata is historical, bytes may be absent.
    assert call(app, "GET", path(entry) + "/content").status_code == 404
    assert call(app, "POST", path(entry) + "/retry", json={}).status_code == 409
    assert call(app, "GET", f"/api/entries/{entry['id']}").json()["content"] == entry["content"]
    app.state.pixellab_client.generate.assert_called_once()


def test_uncertain_provider_completion_preserves_journal_and_never_retries(pixel_app):
    app = pixel_app
    entry = create(app)
    app.state.pixellab_client.generate.side_effect = PixelArtTimeout("SENSITIVE-provider-error")
    assert run_pixel_job_once(app.state)
    result = call(app, "GET", path(entry) + "/status")
    assert result.json()["generation"]["status"] == "uncertain"
    assert result.json()["generation"]["retryable"] is False
    assert "SENSITIVE" not in result.text
    assert memory(app, entry)["generation"] == result.json()["generation"]
    assert call(app, "POST", path(entry) + "/retry", json={}).status_code == 409
    assert call(app, "POST", path(entry), json={}).status_code == 503
    assert call(app, "GET", path(entry) + "/content").status_code == 404
    assert call(app, "GET", f"/api/entries/{entry['id']}").status_code == 200
    second = create(app, "Another journal still saves after an image failure.")
    assert call(app, "GET", path(second) + "/status").json()["generation"]["status"] == "pending"
    app.state.pixellab_client.generate.assert_called_once()
