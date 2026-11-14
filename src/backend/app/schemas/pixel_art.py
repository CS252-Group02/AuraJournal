from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


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
