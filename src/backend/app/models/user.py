from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, CreatedAt, UpdatedAt


if TYPE_CHECKING:
    from app.models.journal_entry import JournalEntry


class User(CreatedAt, UpdatedAt, Base):
    __tablename__ = "users"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    email: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    entries: Mapped[list[JournalEntry]] = relationship(
        back_populates="user", cascade="all, delete-orphan", passive_deletes=True
    )
