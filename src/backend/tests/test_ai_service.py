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
    JournalTitle,
    JournalTitleGenerator,
)
from app.services._groq import _GroqJSONClient
from app.services.ai_journal import SYSTEM_PROMPT as SUMMARY_PROMPT
from app.services.ai_title import SYSTEM_PROMPT as TITLE_PROMPT


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


@pytest.mark.parametrize("service,method,schema,prompt,content", [
    (JournalSummarizer, "summarize", JournalSummary, SUMMARY_PROMPT,
     '{"summary":"A calm day.","reflection_question":"What felt meaningful?"}'),
    (JournalTitleGenerator, "generate", JournalTitle, TITLE_PROMPT,
     '{"suggested_title":"A Calm Day at Home"}'),
])
def test_services_share_transport_with_one_direct_request(
    monkeypatch, service, method, schema, prompt, content,
):
    calls = []
    original = _GroqJSONClient.generate

    def track(self, text, **kwargs):
        calls.append((text, kwargs))
        return original(self, text, **kwargs)

    monkeypatch.setattr(_GroqJSONClient, "generate", track)
    completions = FakeCompletions(content)
    result = getattr(service(client=client_for(completions)), method)("  A calm day at home.  ")

    assert isinstance(result, schema)
    assert calls == [("  A calm day at home.  ", {
        "system_prompt": prompt, "response_model": schema,
    })]
    assert len(completions.calls) == 1
    assert completions.calls[0]["messages"] == [
        {"role": "system", "content": prompt},
        {"role": "user", "content": "A calm day at home."},
    ]


def test_existing_error_imports_preserve_identity_and_inheritance():
    import app.services as services
    from app.services import _groq, ai_journal

    for name in (
        "EmptyJournalError", "AIInvalidResponseError", "AIServiceNotConfiguredError",
        "AIServiceUnavailableError", "JournalSummaryError",
    ):
        assert getattr(services, name) is getattr(ai_journal, name) is getattr(_groq, name)
        assert issubclass(getattr(services, name), services.JournalSummaryError)
