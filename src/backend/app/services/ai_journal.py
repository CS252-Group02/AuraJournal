from pydantic import BaseModel, ConfigDict, Field, field_validator

# Keep existing exception and protocol imports available from this module.
from app.services._groq import (
    AIInvalidResponseError,
    AIServiceNotConfiguredError,
    AIServiceUnavailableError,
    EmptyJournalError,
    GroqChatClient,
    JournalSummaryError,
    _GroqJSONClient,
)


SYSTEM_PROMPT = """You summarize private journal entries.

Return one JSON object with exactly these fields:
- "summary": a concise, factual summary of one to three sentences
- "reflection_questions": exactly two distinct, gentle questions grounded in the journal entry

Write in the same language as the journal entry. Use only information present in
the entry. Do not invent people, places, events, emotions, or diagnoses. Do not
include Markdown or any text outside the JSON object.
"""


class JournalSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    summary: str = Field(min_length=1, max_length=500)
    reflection_questions: list[str] = Field(min_length=2, max_length=2)

    @field_validator("reflection_questions")
    @classmethod
    def valid_questions(cls, questions: list[str]) -> list[str]:
        if any(
            not question.strip() or len(question) > 300 for question in questions
        ):
            raise ValueError(
                "Reflection questions must be nonblank and at most 300 characters."
            )
        if len({question.strip().casefold() for question in questions}) != 2:
            raise ValueError("Reflection questions must be distinct.")
        return questions


class JournalSummarizer:
    """Generate structured journal assistance through a reusable Groq client."""

    def __init__(
        self,
        client: GroqChatClient | None = None,
        model: str | None = None,
    ) -> None:
        self._ai = _GroqJSONClient(client=client, model=model)

    def summarize(self, text: str) -> JournalSummary:
        return self._ai.generate(
            text, system_prompt=SYSTEM_PROMPT, response_model=JournalSummary
        )
