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
    validate_journal_text,
)


SYSTEM_PROMPT = """You write a short reflection on private journal entries.

Return one JSON object with exactly these fields:
- "summary": one short, factual reflection grounded in the journal entry

Write in the same language as the journal entry. Use only information present in
the entry. Do not invent people, places, events, emotions, or diagnoses. Do not
ask questions, give advice, include Markdown, or add text outside the JSON object.
"""


class JournalSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, revalidate_instances="always")

    summary: str = Field(min_length=1, max_length=500)

    @field_validator("summary")
    @classmethod
    def storable_text(cls, value):
        if "\x00" in value:
            raise ValueError("Summary contains an unsupported null character.")
        return value


class JournalSummarizer:
    """Generate structured journal assistance through a reusable Groq client."""

    def __init__(
        self,
        client: GroqChatClient | None = None,
        model: str | None = None,
    ) -> None:
        self._ai = _GroqJSONClient(client=client, model=model)

    def summarize(self, text: str) -> JournalSummary:
        text = validate_journal_text(text)
        return self._ai.generate(
            text, system_prompt=SYSTEM_PROMPT, response_model=JournalSummary
        )
