from typing import Protocol

from groq import (
    APIConnectionError,
    APIResponseValidationError,
    APIStatusError,
    AuthenticationError,
    Groq,
    PermissionDeniedError,
    RateLimitError,
)
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.config import groq_api_key, groq_model


SYSTEM_PROMPT = """You summarize private journal entries.

Return one JSON object with exactly these fields:
- "summary": a concise, factual summary of one to three sentences
- "reflection_question": one gentle question grounded in the journal entry

Write in the same language as the journal entry. Use only information present in
the entry. Do not invent people, places, events, emotions, or diagnoses. Do not
include Markdown or any text outside the JSON object.
"""


class JournalSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    summary: str = Field(min_length=1, max_length=500)
    reflection_question: str = Field(min_length=1, max_length=300)


class JournalSummaryError(RuntimeError):
    """Base error for journal summary failures."""


class EmptyJournalError(JournalSummaryError):
    """Raised when there is no journal text to summarize."""


class AIServiceNotConfiguredError(JournalSummaryError):
    """Raised when the AI service has no usable credentials."""


class AIServiceUnavailableError(JournalSummaryError):
    """Raised when the AI provider cannot complete a request."""


class AIInvalidResponseError(JournalSummaryError):
    """Raised when the AI provider returns an unusable response."""


class GroqChatClient(Protocol):
    @property
    def chat(self): ...


class JournalSummarizer:
    """Generate structured journal assistance through a reusable Groq client."""

    def __init__(
        self,
        client: GroqChatClient | None = None,
        model: str | None = None,
    ) -> None:
        self._client = client
        self._api_key = groq_api_key() if client is None else None
        self._model = model or groq_model()

    def summarize(self, text: str) -> JournalSummary:
        if not isinstance(text, str) or not (journal_text := text.strip()):
            raise EmptyJournalError("Journal text cannot be empty.")

        client = self._configured_client()
        try:
            completion = client.chat.completions.create(
                model=self._model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": journal_text},
                ],
                response_format={"type": "json_object"},
                temperature=0,
                max_completion_tokens=300,
            )
        except (AuthenticationError, PermissionDeniedError) as error:
            raise AIServiceNotConfiguredError(
                "AI service credentials are invalid."
            ) from error
        except APIResponseValidationError as error:
            raise AIInvalidResponseError(
                "AI service returned an invalid response."
            ) from error
        except (APIConnectionError, RateLimitError, APIStatusError) as error:
            raise AIServiceUnavailableError(
                "AI service is unavailable."
            ) from error

        try:
            content = completion.choices[0].message.content
            if not isinstance(content, str) or not content.strip():
                raise ValueError("Empty AI response")
            return JournalSummary.model_validate_json(content)
        except (AttributeError, IndexError, TypeError, ValueError, ValidationError) as error:
            raise AIInvalidResponseError(
                "AI service returned an invalid response."
            ) from error

    def _configured_client(self) -> GroqChatClient:
        if self._client is not None:
            return self._client
        if not self._api_key or not self._api_key.strip():
            raise AIServiceNotConfiguredError(
                "GROQ_API_KEY is not configured."
            )
        self._client = Groq(api_key=self._api_key)
        return self._client
