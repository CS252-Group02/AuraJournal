from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, CreatedAt


if TYPE_CHECKING:
    from app.models.journal_entry import JournalEntry


class JournalImage(CreatedAt, Base):
    __tablename__ = "journal_images"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    entry_id: Mapped[UUID] = mapped_column(
        ForeignKey("journal_entries.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    image_url: Mapped[str] = mapped_column(Text, nullable=False)
    file_format: Mapped[str] = mapped_column(
        String, nullable=False, default="png", server_default="png"
    )
    entry: Mapped[JournalEntry] = relationship(back_populates="image")
