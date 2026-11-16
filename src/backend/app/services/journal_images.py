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


def recent_journal_images(
    session: Session, user_id: UUID, as_of: date
) -> list[tuple[date, JournalImage]]:
    """Images on the latest seven occupied journal dates, including as_of.

    Days without images still count toward the seven days. Return all available
    references on those days, newest first, with stable ties.
    """
    days = (
        select(JournalEntry.journal_date)
        .where(JournalEntry.user_id == user_id, JournalEntry.journal_date <= as_of)
        .distinct()
        .order_by(JournalEntry.journal_date.desc())
        .limit(7)
    )
    query = (
        select(JournalEntry.journal_date, JournalImage)
        .join(JournalImage, JournalImage.entry_id == JournalEntry.id)
        .where(JournalEntry.user_id == user_id, JournalEntry.journal_date.in_(days))
        .order_by(JournalEntry.journal_date.desc(), JournalEntry.created_at.desc(),
                  JournalEntry.id.desc())
    )
    return [(day, image) for day, image in session.execute(query)]
