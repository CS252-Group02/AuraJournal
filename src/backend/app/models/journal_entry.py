from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from sqlalchemy import ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, CreatedAt, UpdatedAt


if TYPE_CHECKING:
    from app.models.user import User
    from app.models.mood_record import MoodRecord
    from app.models.journal_image import JournalImage


class JournalEntry(CreatedAt, UpdatedAt, Base):
    __tablename__ = "journal_entries"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    user: Mapped[User] = relationship(back_populates="entries")
    mood_record: Mapped[MoodRecord | None] = relationship(
        back_populates="entry", cascade="all, delete-orphan", passive_deletes=True
    )
    image: Mapped[JournalImage | None] = relationship(
        back_populates="entry", cascade="all, delete-orphan", passive_deletes=True
    )
