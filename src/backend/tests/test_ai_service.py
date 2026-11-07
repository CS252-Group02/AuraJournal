from types import SimpleNamespace

import httpx
import pytest
from groq import APIConnectionError, AuthenticationError

from app.services import (
    AIInvalidResponseError,
    AIServiceNotConfiguredError,
    AIServiceUnavailableError,
    EmptyJournalError,
    JournalSummarizer,
    JournalSummary,
)


class FakeCompletions:
    def __init__(self, content=None, error=None):
        self.content = content
        self.error = error
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        message = SimpleNamespace(content=self.content)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def client_for(completions):
    return SimpleNamespace(chat=SimpleNamespace(completions=completions))


def test_summary_returns_validated_json_and_expected_request():
    completions = FakeCompletions(
        ' {"summary":"  A calm day.  ",'
        '"reflection_question":" What felt meaningful? "} '
    )
    summarizer = JournalSummarizer(client=client_for(completions), model="test-model")

    result = summarizer.summarize("  Today was calm.  ")

    assert result == JournalSummary(
        summary="A calm day.", reflection_question="What felt meaningful?"
    )
    request = completions.calls[0]
    assert request["model"] == "test-model"
    assert request["messages"][1]["content"] == "Today was calm."
    assert request["response_format"] == {"type": "json_object"}
    assert request["temperature"] == 0


@pytest.mark.parametrize("text", ["", "   ", None])
def test_empty_journal_is_rejected_without_provider_call(text):
    completions = FakeCompletions("{}")
    summarizer = JournalSummarizer(client=client_for(completions))

    with pytest.raises(EmptyJournalError, match="cannot be empty"):
        summarizer.summarize(text)

    assert completions.calls == []


def test_missing_api_key_is_controlled(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    summarizer = JournalSummarizer()

    with pytest.raises(AIServiceNotConfiguredError, match="not configured"):
        summarizer.summarize("Journal text")


@pytest.mark.parametrize("content", [
    None,
    "",
    "not json",
    '{"summary":"Only one field"}',
    '{"summary":" ","reflection_question":"Question?"}',
    '{"summary":"Summary","reflection_question":"Question?","extra":true}',
])
def test_invalid_provider_responses_are_controlled(content):
    summarizer = JournalSummarizer(client=client_for(FakeCompletions(content)))

    with pytest.raises(AIInvalidResponseError, match="invalid response"):
        summarizer.summarize("Journal text")


def test_connection_error_is_reported_as_unavailable():
    error = APIConnectionError(
        request=httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions")
    )
    summarizer = JournalSummarizer(client=client_for(FakeCompletions(error=error)))

    with pytest.raises(AIServiceUnavailableError, match="unavailable"):
        summarizer.summarize("Journal text")


def test_authentication_error_is_reported_as_not_configured():
    request = httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions")
    response = httpx.Response(401, request=request)
    error = AuthenticationError("Invalid API key", response=response, body=None)
    summarizer = JournalSummarizer(client=client_for(FakeCompletions(error=error)))

    with pytest.raises(AIServiceNotConfiguredError, match="credentials are invalid"):
        summarizer.summarize("Journal text")
