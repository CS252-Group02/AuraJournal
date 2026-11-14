from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class EntryCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=5000)


class EntryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    journal_date: date
    id: UUID
    content: str
    ai_summary: str | None
    ai_reflection_question: str | None
    ai_summarized_at: datetime | None
    created_at: datetime
    updated_at: datetime
