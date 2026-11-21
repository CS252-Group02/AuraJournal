from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class PixelArtRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PixelArtMetadata(BaseModel):
    id: UUID
    file_format: Literal["png"] = "png"
    width: Literal[128] = 128
    height: Literal[128] = 128
    created_at: datetime
    content_url: str


class PixelArtResponse(BaseModel):
    entry_id: UUID
    image: PixelArtMetadata
    representation: Literal["grounded", "symbolic"] | None = None


class DatedPixelArt(BaseModel):
    journal_date: date
    entry_id: UUID
    image: PixelArtMetadata


class PixelGenerationStatus(BaseModel):
    status: Literal["pending", "processing", "ready", "failed", "unavailable", "uncertain", "not_requested"]
    error_code: str | None = None
    updated_at: datetime | None = None


class PixelArtStatusResponse(BaseModel):
    entry_id: UUID
    journal_date: date
    image: PixelArtMetadata | None
    generation: PixelGenerationStatus


class PixelMemoryEntry(BaseModel):
    entry_id: UUID
    image: PixelArtMetadata | None
    generation: PixelGenerationStatus


class PixelMemoryDay(BaseModel):
    journal_date: date
    entries: list[PixelMemoryEntry] = Field(min_length=1)


class PixelMemoryFeed(BaseModel):
    as_of: date
    days: list[PixelMemoryDay] = Field(max_length=7)
