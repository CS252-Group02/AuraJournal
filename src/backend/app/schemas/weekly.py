from datetime import date, datetime, timedelta
import re
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StringConstraints, field_validator, model_validator


class WeeklyRecapRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: date
    timezone: str = Field(min_length=1, max_length=100)
    date_basis: Literal["recorded", "journal"] = "recorded"

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


def _complete_reflection_period(value):
    if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        value = date.fromisoformat(value)
    if (not isinstance(value, date) or isinstance(value, datetime)
            or value > date.max - timedelta(days=6)):
        raise ValueError("Choose a YYYY-MM-DD start date with a complete seven-day range.")
    return value


ReflectionPeriodStart = Annotated[date, BeforeValidator(_complete_reflection_period)]


class WeeklyReflectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    period_start: ReflectionPeriodStart


ReflectionSummary = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2400)]
ReflectionQuestion = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]


class WeeklyReflectionContent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    summary: ReflectionSummary
    questions: list[ReflectionQuestion] = Field(min_length=2, max_length=2)


class SavedWeeklyReflectionResponse(WeeklyReflectionContent):
    period_start: date
    period_end: date
    created_at: datetime
    updated_at: datetime


class WeeklyReflectionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    period_start: date
    period_end: date
    entry_count: int = Field(ge=0)
    summary: ReflectionSummary | None
    questions: list[ReflectionQuestion] = Field(max_length=2)

    @model_validator(mode="after")
    def result_matches_entries(self):
        if self.entry_count == 0:
            if self.summary is not None or self.questions:
                raise ValueError("An empty period must have no generated content.")
        elif self.summary is None or len(self.questions) != 2:
            raise ValueError("A nonempty period requires a summary and exactly two questions.")
        return self
