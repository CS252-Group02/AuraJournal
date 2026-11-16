"""Interface for weekly reflection generation, independent of provider prompts."""

from typing import Protocol, TypedDict

from app.schemas.weekly import WeeklyReflectionContent

MAX_WEEKLY_REFLECTION_INPUT = 60_000


class WeeklyReflectionTooLarge(ValueError):
    pass


class WeeklyReflectionSource(TypedDict):
    id: str
    journal_date: str
    content: str


class WeeklyReflectionGenerator(Protocol):
    def generate(self, entries: list[WeeklyReflectionSource]) -> WeeklyReflectionContent:
        """Return a grounded summary and two questions, or raise a shared AI service error."""
        ...
