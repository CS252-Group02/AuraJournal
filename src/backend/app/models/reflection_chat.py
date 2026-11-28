from datetime import date
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, CreatedAt, UpdatedAt


class ReflectionChat(CreatedAt, UpdatedAt, Base):
    __tablename__ = 'reflection_chats'
    __table_args__ = (
        Index('ix_reflection_chats_owner_activity', 'user_id', 'updated_at', 'id'),
        CheckConstraint('revision >= 0', name='ck_reflection_chats_revision'),
        CheckConstraint('journal_access_version >= 0', name='ck_reflection_chats_access_version'),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'))
    title: Mapped[str] = mapped_column(String(60), server_default='New reflection')
    revision: Mapped[int] = mapped_column(server_default='0')
    use_journals: Mapped[bool] = mapped_column(server_default='false')
    journal_access_version: Mapped[int] = mapped_column(server_default='0')


class ReflectionChatMessage(CreatedAt, Base):
    __tablename__ = 'reflection_chat_messages'
    __table_args__ = (
        UniqueConstraint('chat_id', 'revision', 'role', name='uq_reflection_chat_revision_role'),
        UniqueConstraint('chat_id', 'turn_id', 'role', name='uq_reflection_chat_turn_role'),
        CheckConstraint('revision > 0', name='ck_reflection_chat_messages_revision'),
        CheckConstraint(
            "(role = 'user' AND outcome IS NULL) OR "
            "(role = 'assistant' AND outcome IS NOT NULL AND outcome IN "
            "('reflection','out_of_scope','mood_boundary','professional_support','urgent_support'))",
            name='ck_reflection_chat_message_role_outcome',
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    chat_id: Mapped[UUID] = mapped_column(ForeignKey('reflection_chats.id', ondelete='CASCADE'))
    turn_id: Mapped[UUID]
    revision: Mapped[int]
    role: Mapped[str] = mapped_column(String(9))
    text: Mapped[str] = mapped_column(String(2000))
    outcome: Mapped[str | None] = mapped_column(String(20))
    journal_context_used: Mapped[bool] = mapped_column(server_default='false')


class ReflectionChatSource(Base):
    __tablename__ = 'reflection_chat_sources'
    __table_args__ = (Index('ix_reflection_chat_sources_entry', 'entry_id'),)

    message_id: Mapped[UUID] = mapped_column(
        ForeignKey('reflection_chat_messages.id', ondelete='CASCADE'), primary_key=True,
    )
    entry_id: Mapped[UUID] = mapped_column(ForeignKey('journal_entries.id', ondelete='CASCADE'), primary_key=True)
    journal_date: Mapped[date]
    content_version: Mapped[int]
