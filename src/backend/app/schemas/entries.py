from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class EntryCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=5000)


class EntryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    content: str
    created_at: datetime
    updated_at: datetime
