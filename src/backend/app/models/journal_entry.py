from __future__ import annotations

from datetime import date, datetime
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from sqlalchemy import Date, DateTime, ForeignKey, Index, Text, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, CreatedAt, UpdatedAt


if TYPE_CHECKING:
    from app.models.user import User
    from app.models.mood_record import MoodRecord
    from app.models.journal_image import JournalImage


class JournalEntry(CreatedAt, UpdatedAt, Base):
    __tablename__ = "journal_entries"
    __table_args__ = (
        Index("ix_journal_entries_owner_date", "user_id", "journal_date", "created_at", "id"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    journal_date: Mapped[date] = mapped_column(
        Date, nullable=False,
        server_default=text("(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date"),
    )
    ai_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_reflection_question: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_summarized_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    user: Mapped[User] = relationship(back_populates="entries")
    mood_record: Mapped[MoodRecord | None] = relationship(
        back_populates="entry", cascade="all, delete-orphan", passive_deletes=True
    )
    image: Mapped[JournalImage | None] = relationship(
        back_populates="entry", cascade="all, delete-orphan", passive_deletes=True
    )
