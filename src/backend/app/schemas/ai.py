from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class JournalSummaryResponse(BaseModel):
    entry_id: UUID
    summary: str
    reflection_question: str
    summarized_at: datetime


class JournalTitleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=5000)

    @field_validator("content")
    @classmethod
    def nonblank_content(cls, content: str) -> str:
        if not (content := content.strip()):
            raise ValueError("Journal content cannot be blank.")
        return content


class JournalTitleResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    suggested_title: str = Field(min_length=1, max_length=100)
