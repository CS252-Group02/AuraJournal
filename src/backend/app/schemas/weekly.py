from datetime import date, datetime, timedelta
import re
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, StringConstraints, field_validator, model_validator


from app.schemas.entries import JournalDate


class WeeklyRecapRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: JournalDate
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
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, revalidate_instances="always")
    text: str = Field(min_length=1, max_length=400)
    entry_ids: list[UUID] = Field(min_length=1, max_length=5)


class WeeklyRecap(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, revalidate_instances="always")
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


def _source_date(value):
    if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return date.fromisoformat(value)
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    raise ValueError("Source dates must use YYYY-MM-DD.")


ReflectionSourceDate = Annotated[date, BeforeValidator(_source_date)]
ReflectionSourceDates = Annotated[
    list[ReflectionSourceDate], Field(min_length=1, max_length=7),
    AfterValidator(lambda days: sorted(set(days))),
]


class WeeklyReflectionText(BaseModel):
    model_config = ConfigDict(extra="forbid")
    summary: ReflectionSummary
    questions: list[ReflectionQuestion] = Field(min_length=2, max_length=2)


class WeeklyReflectionContent(WeeklyReflectionText):
    model_config = ConfigDict(revalidate_instances="always")
    source_dates: ReflectionSourceDates

    @field_validator("questions")
    @classmethod
    def distinct_questions(cls, value):
        if " ".join(value[0].split()).casefold() == " ".join(value[1].split()).casefold():
            raise ValueError("Reflection questions must be distinct.")
        return value


class SavedWeeklyReflectionResponse(WeeklyReflectionText):
    # Historical reflections did not store evidence. Never infer it from today's journals.
    source_dates: ReflectionSourceDates | None
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
    source_dates: Annotated[
        list[ReflectionSourceDate], Field(max_length=7),
        AfterValidator(lambda days: sorted(set(days))),
    ]

    @model_validator(mode="after")
    def result_matches_entries(self):
        if self.entry_count == 0:
            if self.summary is not None or self.questions or self.source_dates:
                raise ValueError("An empty period must have no generated content.")
        elif self.summary is None or len(self.questions) != 2 or not self.source_dates:
            raise ValueError("A nonempty period requires a summary, two questions and source dates.")
        if any(day < self.period_start or day > self.period_end for day in self.source_dates):
            raise ValueError("Source dates must belong to the selected period.")
        return self
