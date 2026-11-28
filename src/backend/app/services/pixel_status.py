"""Read-only public status projection; never schedules, repairs or calls providers."""
from app.schemas.pixel_art import PixelGenerationStatus
from app.services.journal_images import has_owned_image_reference


def artwork_retry_available(state):
    return (
        state.pixel_art_enabled
        and getattr(state.moment_extractor, "configured", True)
        and getattr(state.pixellab_client, "configured", True)
    )


def is_retryable_job(image, job):
    return (
        image is None and job is not None
        and job.status in {"failed", "unavailable"} and job.submitted_at is None
    )


def generation_status(storage, image, job, *, retry_available: bool):
    if image is not None:
        code = "invalid_reference"
        if has_owned_image_reference(image):
            try:
                if storage.path(image.image_url).is_file():
                    return PixelGenerationStatus(status="ready", updated_at=job.updated_at if job else image.created_at)
                code = "image_missing"
            except (OSError, ValueError):
                code = "storage_unavailable"
        return PixelGenerationStatus(status="failed", error_code=code, updated_at=job.updated_at if job else None)
    if job is None:
        return PixelGenerationStatus(status="not_requested")
    # A missing committed image must never be advertised as ready.
    if job.status in {"ready", "cancelled"}:
        return PixelGenerationStatus(status="failed", error_code="image_missing", updated_at=job.updated_at)
    return PixelGenerationStatus(status=job.status, error_code=job.error_code, updated_at=job.updated_at,
                                 retryable=retry_available and is_retryable_job(image, job))
