from datetime import date, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator


class WeeklyRecapRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: date
    timezone: str = Field(min_length=1, max_length=100)

    @field_validator("start")
    @classmethod
    def monday(cls, value):
        if value.weekday() != 0 or value > date.max - timedelta(days=7):
            raise ValueError("Choose a Monday with a complete seven-day date range.")
        return value

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("Choose a valid IANA timezone.") from None
        return value


class WeeklyEvent(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    text: str = Field(min_length=1, max_length=400)
    entry_ids: list[UUID] = Field(min_length=1, max_length=5)


class WeeklyRecap(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    summary: str = Field(min_length=1, max_length=2400)
    highlights: list[WeeklyEvent] = Field(max_length=5)


class WeeklyRecapResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    week_start: date
    week_end: date
    timezone: str
    entry_count: int
    summary: str | None
    highlights: list[WeeklyEvent]
