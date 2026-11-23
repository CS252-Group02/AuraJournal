"""PostgreSQL outbox, bounded workers and conservative billable-call recovery."""
from dataclasses import dataclass
from datetime import timedelta
import logging
from threading import Event, Thread
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import and_, or_, select, update
from sqlalchemy.dialects.postgresql import insert

from app.auth import utcnow
from app.config import pixel_submission_budgets
from app.limits import consume
from app.models import JournalEntry, PixelArtJob
from app.services._groq import AIServiceNotConfiguredError, AIServiceUnavailableError
from app.services.image_lifecycle import generation_locks
from app.services.journal_images import attach_image, has_owned_image_reference
from app.services.pixel_generation import render_pixel_art
from app.services.pixel_art import NoDepictableMoment
from app.services.pixellab import (
    PixelArtCreditsUnavailable, PixelArtError, PixelArtInvalidResponse, PixelArtRateLimited,
    PixelArtTimeout, validate_png,
)

logger = logging.getLogger(__name__)
MAX_ATTEMPTS = 2
LEASE_SECONDS = 300  # Groq 30s + PixelLab 120s, plus DB/storage headroom.
RETRY_SECONDS = 60


def schedule_pixel_art(session, entry, *, enabled):
    """Caller locks existing entries and commits journal + outbox together."""
    session.flush()
    session.execute(insert(PixelArtJob).values(
        id=uuid4(), entry_id=entry.id, source_version=entry.content_version,
        available_at=utcnow(), status="pending" if enabled else "unavailable",
        error_code=None if enabled else "disabled",
    ).on_conflict_do_nothing(constraint="uq_pixel_art_jobs_version"))


def invalidate_pixel_jobs(session, entry_id):
    session.execute(update(PixelArtJob).where(PixelArtJob.entry_id == entry_id).values(
        status="cancelled", error_code="source_changed", attempt_token=None, lease_expires_at=None,
    ))


class ObsoleteAttempt(Exception):
    """The journal changed/deleted or another claim fenced this attempt out."""


@dataclass(frozen=True)
class Attempt:
    job_id: UUID
    entry_id: UUID
    user_id: UUID
    source_version: int
    token: UUID
    content: str
    submitted: bool

    @property
    def key(self):
        return f"pixel-art/{self.entry_id}/{self.job_id}.png"


def _locked_attempt(session, attempt):
    # Same entry -> job lock order as PATCH/DELETE, avoiding completion deadlocks.
    entry = session.scalar(select(JournalEntry).where(
        JournalEntry.id == attempt.entry_id, JournalEntry.user_id == attempt.user_id,
    ).with_for_update().execution_options(populate_existing=True))
    if entry is None or entry.content_version != attempt.source_version:
        raise ObsoleteAttempt()
    job = session.get(PixelArtJob, attempt.job_id, with_for_update=True, populate_existing=True)
    if job is None or job.status != "processing" or job.attempt_token != attempt.token:
        raise ObsoleteAttempt()
    return entry, job


def _claim(state, job_id, entry_id):
    now = utcnow()
    with state.session_factory() as session:
        entry = session.scalar(select(JournalEntry).where(JournalEntry.id == entry_id)
                               .with_for_update(skip_locked=True))
        if entry is None:
            return None
        job = session.get(PixelArtJob, job_id, with_for_update=True)
        if job is None:
            return None
        due = ((job.status == "pending" and job.available_at <= now) or
               (job.status == "processing" and job.lease_expires_at <= now))
        if not due:
            return None
        if entry.content_version != job.source_version:
            job.status, job.error_code = "cancelled", "source_changed"
            session.commit()
            return None
        if entry.image is not None:
            job.status = "ready" if has_owned_image_reference(entry.image) else "failed"
            job.error_code = None if job.status == "ready" else "invalid_reference"
            session.commit()
            return None
        # A recorded image submission must be recovered before any configuration
        # checks, and MUST NEVER be submitted again, even after a worker crash.
        recovering = job.submitted_at is not None
        if not recovering and (not state.pixel_art_enabled or
                not getattr(state.moment_extractor, "configured", True) or
                not getattr(state.pixellab_client, "configured", True)):
            job.status, job.error_code = "unavailable", "service_unavailable"
            session.commit()
            return None
        if not recovering and job.attempts >= MAX_ATTEMPTS:
            job.status, job.error_code = "failed", "attempts_exhausted"
            session.commit()
            return None
        job.status, job.error_code = "processing", None
        job.attempt_token = uuid4()
        job.lease_expires_at = now + timedelta(seconds=LEASE_SECONDS)
        if not recovering:
            job.attempts += 1
        attempt = Attempt(job.id, entry.id, entry.user_id, job.source_version,
                          job.attempt_token, entry.content, recovering)
        session.commit()
        return attempt


def _reserve_budget(state, attempt):
    with state.session_factory() as session:
        _locked_attempt(session, attempt)
        # Bound Groq as well as PixelLab. A crash can consume budget without a
        # provider call; budgets are intentionally never refunded automatically.
        consume(session, pixel_submission_budgets(attempt.user_id))


def _before_submit(state, attempt):
    with state.session_factory() as session:
        entry, job = _locked_attempt(session, attempt)
        if not state.pixel_art_enabled:
            raise AIServiceNotConfiguredError()
        if job.submitted_at is not None or entry.image is not None:
            raise ObsoleteAttempt()
        job.submitted_at = utcnow()
        session.commit()


def _finish(state, attempt, data, *, already_saved=False):
    with state.session_factory() as session:
        entry, job = _locked_attempt(session, attempt)
        if entry.image is not None:
            raise ObsoleteAttempt()
        if not already_saved:
            state.image_storage.save(attempt.entry_id, attempt.job_id, data)
        attach_image(session, attempt.user_id, attempt.entry_id, attempt.job_id, attempt.key)
        job.status, job.error_code, job.lease_expires_at = "ready", None, None
        session.commit()
    # Files survive uncertain COMMIT acknowledgement. Recovery and reconciliation
    # check the committed reference before deciding what can be removed.


def _failure(state, attempt, error):
    with state.session_factory() as session:
        _, job = _locked_attempt(session, attempt)
        if job.submitted_at is not None:
            # No image-provider retries, including rate limits, malformed output,
            # transport errors, storage errors and lost commit acknowledgements.
            if isinstance(error, PixelArtCreditsUnavailable):
                job.status, job.error_code = "unavailable", "credits_unavailable"
            elif isinstance(error, PixelArtRateLimited):
                job.status, job.error_code = "failed", "provider_busy"
            elif isinstance(error, PixelArtInvalidResponse):
                job.status, job.error_code = "failed", "invalid_image"
            else:
                job.status, job.error_code = "uncertain", "completion_uncertain"
        elif isinstance(error, (AIServiceUnavailableError, NoDepictableMoment)) and job.attempts < MAX_ATTEMPTS:
            job.status = "pending"
            job.error_code = "no_depictable_moment" if isinstance(error, NoDepictableMoment) else "extraction_unavailable"
            job.available_at = utcnow() + timedelta(seconds=RETRY_SECONDS)
        elif isinstance(error, NoDepictableMoment):
            job.status, job.error_code = "failed", "no_depictable_moment"
        elif isinstance(error, (AIServiceNotConfiguredError, HTTPException)):
            job.status = "unavailable"
            job.error_code = "budget_exhausted" if isinstance(error, HTTPException) else "service_unavailable"
        else:
            job.status, job.error_code = "failed", "generation_failed"
        job.lease_expires_at = None
        session.commit()


def _execute(state, attempt):
    try:
        if attempt.submitted:
            data = state.image_storage.read(attempt.key)
            if data is None:
                raise PixelArtTimeout()
            _finish(state, attempt, validate_png(data), already_saved=True)
        else:
            _reserve_budget(state, attempt)
            data, _ = render_pixel_art(state, attempt.content,
                                       before_submit=lambda: _before_submit(state, attempt))
            _finish(state, attempt, data)
    except ObsoleteAttempt:
        pass  # PATCH/DELETE already invalidated the job; no file was attached.
    except Exception as error:
        try:
            _failure(state, attempt, error)
        except ObsoleteAttempt:
            pass
        # If PostgreSQL is down, the persisted lease/submission fence remains;
        # the next worker pass recovers it without resubmitting an image request.


def run_pixel_job_once(state):
    """Process at most one due job. Safe to call from independent processes."""
    now = utcnow()
    with state.session_factory() as session:
        # One candidate per owner keeps a busy user's backlog from filling the
        # scan window and starving other users while provider capacity is free.
        eligible = (select(PixelArtJob.id, PixelArtJob.entry_id, JournalEntry.user_id, PixelArtJob.available_at)
            .join(JournalEntry, JournalEntry.id == PixelArtJob.entry_id)
            .where(or_(and_(PixelArtJob.status == "pending", PixelArtJob.available_at <= now),
                       and_(PixelArtJob.status == "processing", PixelArtJob.lease_expires_at <= now)))
            .distinct(JournalEntry.user_id)
            .order_by(JournalEntry.user_id, PixelArtJob.available_at, PixelArtJob.id).subquery())
        candidates = session.execute(select(eligible.c.id, eligible.c.entry_id, eligible.c.user_id)
            .order_by(eligible.c.available_at, eligible.c.id).limit(32)).all()
    for job_id, entry_id, user_id in candidates:
        try:
            with generation_locks(state.engine, entry_id, user_id, capacity=state.pixel_art_concurrency):
                if not state.pixel_art_capacity.acquire(blocking=False):
                    return False
                try:
                    attempt = _claim(state, job_id, entry_id)
                    if attempt is not None:
                        _execute(state, attempt)
                    return True
                finally:
                    state.pixel_art_capacity.release()
        except PixelArtRateLimited:
            continue  # Local contention is not a provider attempt and consumes no budget.
        except PixelArtError as error:
            if error.status_code != 409:
                raise
    return False


class PixelArtWorkers:
    """Managed lifespan threads; the outbox, never thread memory, owns work."""
    def __init__(self, state):
        self.state = state
        self.stop_event = Event()
        self.threads = [Thread(target=self._run, name=f"pixel-art-{i}", daemon=True)
                        for i in range(state.pixel_art_concurrency)]

    def start(self):
        for thread in self.threads:
            thread.start()

    def stop(self):
        self.stop_event.set()
        for thread in self.threads:
            thread.join()  # Application lifespan calls this off the event loop.

    def _run(self):
        while not self.stop_event.is_set():
            try:
                worked = run_pixel_job_once(self.state)
            except Exception:
                # Never log exception strings/SQL parameters or private content.
                logger.warning("Pixel-art worker pass failed; durable work remains recoverable.")
                worked = False
            self.stop_event.wait(0.1 if worked else 2.0)
