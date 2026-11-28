from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

Locale = Literal['en', 'vi']
SupportKind = Literal['urgent_support', 'professional_support']
Outcome = Literal['urgent_support', 'professional_support', 'mood_boundary', 'out_of_scope', 'reflection']


class ReflectionTurnRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    turn_id: UUID
    expected_revision: int = Field(ge=0, le=2_147_483_646, strict=True)
    message: str = Field(min_length=1, max_length=2000)
    locale: Locale

    @field_validator('message')
    @classmethod
    def plain_text(cls, value: str) -> str:
        if any(ord(char) < 32 and char not in '\n\r\t' for char in value):
            raise ValueError('Message contains unsupported control characters.')
        return value


class ReflectionChatMetadata(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    title: str
    revision: int
    created_at: datetime
    updated_at: datetime


class ReflectionTurn(BaseModel):
    turn_id: UUID
    revision: int
    message: str
    reply: str
    outcome: Outcome
    support_kind: SupportKind | None
    created_at: datetime


class ReflectionChatList(BaseModel):
    chats: list[ReflectionChatMetadata]
    next_cursor: str | None


class ReflectionChatDetail(BaseModel):
    chat: ReflectionChatMetadata
    turns: list[ReflectionTurn]
    next_before_revision: int | None


class SupportLink(BaseModel):
    label: str
    url: str


class SupportOption(BaseModel):
    guidance: str
    resources: list[SupportLink]


class ReflectionSupport(BaseModel):
    country: str
    locale: Locale
    urgent_support: SupportOption
    professional_support: SupportOption
