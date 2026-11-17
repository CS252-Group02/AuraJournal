from datetime import date
from uuid import UUID

from sqlalchemy import CheckConstraint, Date, ForeignKey, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, CreatedAt, UpdatedAt


class WeeklyReflection(CreatedAt, UpdatedAt, Base):
    __tablename__ = "weekly_reflections"
    __table_args__ = (
        CheckConstraint("btrim(summary) <> ''", name="ck_weekly_reflections_summary"),
        CheckConstraint(
            """CASE WHEN jsonb_typeof(questions) = 'array' THEN
                jsonb_array_length(questions) = 2
                AND jsonb_typeof(questions -> 0) = 'string'
                AND jsonb_typeof(questions -> 1) = 'string'
                AND btrim(questions ->> 0) <> '' AND btrim(questions ->> 1) <> ''
            ELSE false END""",
            name="ck_weekly_reflections_questions",
        ),
        CheckConstraint(
            """source_dates IS NULL OR CASE WHEN jsonb_typeof(source_dates) = 'array' THEN
                jsonb_array_length(source_dates) BETWEEN 1 AND 7
                AND NOT jsonb_path_exists(source_dates, '$[*] ? (@.type() != "string")')
            ELSE false END""",
            name="ck_weekly_reflections_source_dates",
        ),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    period_start: Mapped[date] = mapped_column(Date, primary_key=True)
    summary: Mapped[str] = mapped_column(Text)
    questions: Mapped[list[str]] = mapped_column(JSONB)
    source_dates: Mapped[list[str] | None] = mapped_column(JSONB(none_as_null=True), nullable=True)
