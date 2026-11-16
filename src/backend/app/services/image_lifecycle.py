"""Cross-worker generation locks and recovery for filesystem/DB commit gaps."""
from contextlib import contextmanager
import hashlib
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models import JournalImage
from app.services.image_storage import ImageStorage
from app.services.pixellab import PixelArtError, PixelArtRateLimited


class GenerationConflict(PixelArtError):
    status_code = 409
    detail = "Image generation is already in progress for this entry."


@contextmanager
def generation_locks(engine, entry_id: UUID, user_id: UUID | None = None):
    # Session locks survive transaction boundaries. AUTOCOMMIT prevents an idle
    # transaction during network calls. All workers use stable namespaced keys.
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        namespace = connection.scalar(text("SELECT current_schema()"))
        connection.commit()
        held = []
        try:
            resources = [("entry", entry_id)]
            if user_id is not None:
                resources.append(("user", user_id))
            for kind, identifier in resources:
                key = int.from_bytes(hashlib.sha256(
                    f"aurajournal:pixel-art:{namespace}:{kind}:{identifier}".encode()
                ).digest()[:8], signed=True)
                acquired = connection.scalar(text("SELECT pg_try_advisory_lock(:key)"), {"key": key})
                connection.commit()
                if not acquired:
                    raise GenerationConflict() if kind == "entry" else PixelArtRateLimited()
                held.append(key)
            yield
        finally:
            try:
                for key in reversed(held):
                    connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": key})
                    connection.commit()
            except Exception:
                # A pooled connection must never retain a session lock.
                connection.invalidate()
                raise


def reconcile_images(engine, storage: ImageStorage) -> int:
    removed = 0
    directory = storage.root / "pixel-art"
    if not directory.exists():
        return removed
    try:
        for path in directory.glob("*/*"):
            if path.suffix not in {".png", ".tmp"}:
                continue
            key = path.with_suffix(".png").relative_to(storage.root).as_posix()
            try:
                validated = storage.path(key)
                entry_id = UUID(validated.parent.name)
            except ValueError:
                continue
            try:
                with generation_locks(engine, entry_id):
                    with Session(engine) as session:
                        referenced = session.scalar(select(JournalImage.id).where(JournalImage.image_url == key))
                    if not referenced:
                        if path.suffix == ".tmp":
                            if not path.is_symlink():
                                path.unlink(missing_ok=True)
                                removed += 1
                        elif storage.delete(key):
                            removed += 1
                        else:
                            raise PixelArtError()
            except GenerationConflict:
                continue
    except OSError as error:
        raise PixelArtError() from error
    return removed
