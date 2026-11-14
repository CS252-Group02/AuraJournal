from datetime import date, datetime
import re
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class _EntryWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    journal_date: date | None = None

    @field_validator("journal_date", mode="before")
    @classmethod
    def calendar_date(cls, value):
        # An omitted field uses the database default/preserves the old value.
        # Explicit nulls, timestamps and numeric Unix times are not calendar dates.
        if isinstance(value, date) and not isinstance(value, datetime):
            return value
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError("Use a non-null journal date in YYYY-MM-DD form.")
        return value


class EntryCreate(_EntryWrite):
    content: str = Field(min_length=1, max_length=5000)


class EntryUpdate(_EntryWrite):
    content: str | None = Field(default=None, min_length=1, max_length=5000)

    @field_validator("content", mode="before")
    @classmethod
    def non_null_content(cls, value):
        if value is None:
            raise ValueError("Content cannot be null.")
        return value

    @model_validator(mode="after")
    def at_least_one_field(self):
        if not self.model_fields_set:
            raise ValueError("Provide content or journal_date to update.")
        return self


class EntryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    content: str
    journal_date: date
    ai_summary: str | None
    ai_reflection_question: str | None
    ai_summarized_at: datetime | None
    created_at: datetime
    updated_at: datetime
