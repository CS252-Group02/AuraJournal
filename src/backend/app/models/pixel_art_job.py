"""Durable outbox and submission fence; no journal text or provider payloads."""
from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, CreatedAt, UpdatedAt


class PixelArtJob(CreatedAt, UpdatedAt, Base):
    __tablename__ = "pixel_art_jobs"
    __table_args__ = (
        UniqueConstraint("entry_id", "source_version", name="uq_pixel_art_jobs_version"),
        CheckConstraint("status IN ('pending','processing','ready','failed','unavailable','uncertain','cancelled')",
                        name="ck_pixel_art_jobs_status"),
        CheckConstraint("attempts BETWEEN 0 AND 2", name="ck_pixel_art_jobs_attempts"),
        Index("ix_pixel_art_jobs_due", "status", "available_at"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    entry_id: Mapped[UUID] = mapped_column(ForeignKey("journal_entries.id", ondelete="CASCADE"), nullable=False)
    source_version: Mapped[int] = mapped_column(nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending", server_default="pending")
    attempts: Mapped[int] = mapped_column(nullable=False, default=0, server_default="0")
    attempt_token: Mapped[UUID | None] = mapped_column(nullable=True)
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_code: Mapped[str | None] = mapped_column(String)
