"""Owner-scoped image references. The caller controls the transaction."""

from datetime import date
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import JournalEntry, JournalImage


def attach_image(
    session: Session, user_id: UUID, entry_id: UUID, image_id: UUID, key: str
) -> JournalImage:
    """Lock the owner's entry and attach an application-owned PNG reference."""
    entry = session.scalar(select(JournalEntry).where(
        JournalEntry.id == entry_id, JournalEntry.user_id == user_id,
    ).with_for_update())
    if entry is None:
        raise LookupError("Journal entry was not found.")
    if key != f"pixel-art/{entry_id}/{image_id}.png":
        raise ValueError("Image key must belong to this entry and image.")
    if entry.image is not None:
        raise FileExistsError("Journal entry already has an image.")
    image = JournalImage(id=image_id, entry_id=entry_id, image_url=key, file_format="png")
    entry.image = image
    session.add(image)
    session.flush()
    return image


def has_owned_image_reference(image: JournalImage) -> bool:
    """A stored key must identify this exact journal/image, including legacy rows."""
    return image.file_format == "png" and image.image_url == f"pixel-art/{image.entry_id}/{image.id}.png"


def recent_journal_memories(
    session: Session, user_id: UUID, as_of: date
) -> list[tuple[date, UUID, JournalImage | None]]:
    """Entries on the latest seven occupied journal days, including missing art.

    A single owner-scoped outer join keeps days with no images and avoids lazy
    per-entry image lookups. Future days after the supplied cutoff are excluded.
    """
    days = (
        select(JournalEntry.journal_date)
        .where(JournalEntry.user_id == user_id, JournalEntry.journal_date <= as_of)
        .distinct()
        .order_by(JournalEntry.journal_date.desc())
        .limit(7)
    )
    query = (
        select(JournalEntry.journal_date, JournalEntry.id, JournalImage)
        .outerjoin(JournalImage, JournalImage.entry_id == JournalEntry.id)
        .where(JournalEntry.user_id == user_id, JournalEntry.journal_date.in_(days))
        .order_by(JournalEntry.journal_date.desc(), JournalEntry.created_at.desc(),
                  JournalEntry.id.desc())
    )
    return [(day, entry_id, image) for day, entry_id, image in session.execute(query)]


def recent_journal_images(
    session: Session, user_id: UUID, as_of: date
) -> list[tuple[date, JournalImage]]:
    """Legacy image-only view over the same seven occupied journal dates."""
    return [(day, image) for day, _, image in recent_journal_memories(session, user_id, as_of)
            if image is not None]
