from typing import Protocol, TypeVar

from groq import (
    APIConnectionError,
    APIResponseValidationError,
    APIStatusError,
    AuthenticationError,
    Groq,
    PermissionDeniedError,
    RateLimitError,
)
from pydantic import BaseModel, ValidationError

from app.config import groq_api_key, groq_model


ResponseModel = TypeVar("ResponseModel", bound=BaseModel)


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


class _GroqJSONClient:
    """Internal Groq transport shared by journal AI services."""

    def __init__(
        self,
        client: GroqChatClient | None = None,
        model: str | None = None,
    ) -> None:
        self._client = client
        self._api_key = groq_api_key() if client is None else None
        self._model = model or groq_model()

    def generate(
        self, text: str, *, system_prompt: str, response_model: type[ResponseModel]
    ) -> ResponseModel:
        if not isinstance(text, str) or not (journal_text := text.strip()):
            raise EmptyJournalError("Journal text cannot be empty.")

        client = self._configured_client()
        try:
            completion = client.chat.completions.create(
                model=self._model,
                messages=[
                    {"role": "system", "content": system_prompt},
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
            return response_model.model_validate_json(content)
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
