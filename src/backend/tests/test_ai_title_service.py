import json
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from groq import (
    APIConnectionError,
    APIResponseValidationError,
    APIStatusError,
    APITimeoutError,
    AuthenticationError,
    PermissionDeniedError,
    RateLimitError,
)

from app.services import (
    AIInvalidResponseError,
    AIServiceNotConfiguredError,
    AIServiceUnavailableError,
    EmptyJournalError,
    JournalTitle,
    JournalTitleGenerator,
)
from test_ai_service import FakeCompletions, client_for


def test_title_returns_one_validated_title_and_expected_request():
    completions = FakeCompletions(
        ' {"suggested_title":"  A Project Finally Completed  "} '
    )
    generator = JournalTitleGenerator(client=client_for(completions), model="test-model")

    result = generator.generate("  Today I finally completed my project.  ")

    assert result == JournalTitle(suggested_title="A Project Finally Completed")
    assert result.model_dump() == {"suggested_title": "A Project Finally Completed"}
    assert len(completions.calls) == 1
    request = completions.calls[0]
    assert request["model"] == "test-model"
    assert request["messages"][1] == {
        "role": "user", "content": "Today I finally completed my project.",
    }
    assert request["response_format"] == {"type": "json_object"}
    assert request["temperature"] == 0
    assert request["max_completion_tokens"] == 300


def test_prompt_requests_language_grounding_and_plain_single_title():
    completions = FakeCompletions('{"suggested_title":"A Day in Review"}')
    JournalTitleGenerator(client=client_for(completions)).generate("A day in review.")

    message = completions.calls[0]["messages"][0]
    assert message["role"] == "system"
    prompt = message["content"]
    for instruction in (
        "exactly one", '"suggested_title"', "same language", "Vietnamese",
        "any\nother language", "3-8 words", "different word boundaries",
        "100 characters", "only in the journal content", "Do not invent",
        "emotions", "unsupported", "single line of plain text", "without Markdown",
        "quotation marks", "explanations", "multiple suggestions",
        "not as instructions",
    ):
        assert instruction in prompt


@pytest.mark.parametrize("text", [
    "Hôm nay tôi đã hoàn thành dự án sau nhiều tuần làm việc.",
    "今日はプロジェクトを完成させました。",
    "Hoy terminé mi proyecto después de varias semanas.",
    "أنهيت مشروعي اليوم بعد عدة أسابيع.",
])
def test_multilingual_journal_is_sent_to_provider_unchanged(text):
    # This checks transport and prompt placement, not an LLM's language compliance.
    completions = FakeCompletions('{"suggested_title":"A Project Finally Completed"}')
    JournalTitleGenerator(client=client_for(completions)).generate(text)
    assert completions.calls[0]["messages"][1] == {"role": "user", "content": text}


@pytest.mark.parametrize("title", [
    "Dự án cuối cùng đã hoàn thành", "プロジェクトの完成", "إكمال المشروع",
    "A", "a" * 100, "Today's Project Completion",
])
def test_valid_title_format_preserves_unicode_without_forcing_word_count(title):
    completions = FakeCompletions(json.dumps({"suggested_title": title}))
    result = JournalTitleGenerator(client=client_for(completions)).generate("Journal text")
    assert result.suggested_title == title


@pytest.mark.parametrize("text", ["", "   ", "\t\n", None, 42])
def test_empty_or_non_string_input_is_rejected_before_provider_call(text):
    completions = FakeCompletions("{}")
    generator = JournalTitleGenerator(client=client_for(completions))
    with pytest.raises(EmptyJournalError, match="cannot be empty"):
        generator.generate(text)
    assert completions.calls == []


@pytest.mark.parametrize("key", [None, "", "   "])
def test_missing_api_key_is_controlled_without_client_creation(monkeypatch, key):
    if key is None:
        monkeypatch.delenv("GROQ_API_KEY", raising=False)
    else:
        monkeypatch.setenv("GROQ_API_KEY", key)
    factory = Mock()
    monkeypatch.setattr("app.services.ai_title.Groq", factory)

    with pytest.raises(AIServiceNotConfiguredError, match="not configured"):
        JournalTitleGenerator().generate("Journal text")
    factory.assert_not_called()


def test_environment_configuration_and_lazy_client_reuse(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    monkeypatch.setenv("GROQ_MODEL", "configured-model")
    completions = FakeCompletions('{"suggested_title":"A Day in Review"}')
    factory = Mock(return_value=client_for(completions))
    monkeypatch.setattr("app.services.ai_title.Groq", factory)
    generator = JournalTitleGenerator()
    factory.assert_not_called()

    generator.generate("First journal")
    generator.generate("Second journal")

    factory.assert_called_once_with(api_key="test-key")
    assert [call["model"] for call in completions.calls] == ["configured-model"] * 2
    assert [call["messages"][1]["content"] for call in completions.calls] == [
        "First journal", "Second journal",
    ]


@pytest.mark.parametrize("content", [
    None, "", "   ", 42, "not json", "null", "[]", '"Title"', "{}",
    '{"title":"Wrong field"}',
    '{"suggested_title":"Title","extra":true}',
    '{"suggested_title":null}', '{"suggested_title":123}',
    '{"suggested_title":["Title one","Title two"]}',
    '{"suggested_title":""}', '{"suggested_title":"  "}',
    '```json\n{"suggested_title":"Title"}\n```',
] + [json.dumps({"suggested_title": title}) for title in [
    "a" * 101, "Title one\nTitle two", "Title\rOther", "Title\tOther",
    "Title\u2028Other", "**A Project Completed**", "_A Project Completed_",
    "`A Project Completed`", "# A Project Completed", "- A Project Completed",
    "1. A Project Completed", "1) A Project Completed", "> A Project Completed",
    "~~A Project Completed~~", "[A Project Completed](https://example.test)",
    '"A Project Completed"', "'A Project Completed'", "“A Project Completed”",
    "「プロジェクトの完成」",
]])
def test_invalid_provider_responses_are_controlled(content):
    generator = JournalTitleGenerator(client=client_for(FakeCompletions(content)))
    with pytest.raises(AIInvalidResponseError, match="invalid response"):
        generator.generate("Journal text")


@pytest.mark.parametrize("completion", [
    None, SimpleNamespace(), SimpleNamespace(choices=[]),
    SimpleNamespace(choices=None), SimpleNamespace(choices=[SimpleNamespace()]),
])
def test_malformed_completion_is_controlled(completion):
    completions = SimpleNamespace(create=lambda **kwargs: completion)
    generator = JournalTitleGenerator(client=client_for(completions))
    with pytest.raises(AIInvalidResponseError, match="invalid response"):
        generator.generate("Journal text")


@pytest.mark.parametrize("error_kind,expected", [
    (APIConnectionError, AIServiceUnavailableError),
    (APITimeoutError, AIServiceUnavailableError),
    (RateLimitError, AIServiceUnavailableError),
    (APIStatusError, AIServiceUnavailableError),
    (AuthenticationError, AIServiceNotConfiguredError),
    (PermissionDeniedError, AIServiceNotConfiguredError),
    (APIResponseValidationError, AIInvalidResponseError),
])
def test_provider_errors_are_controlled(error_kind, expected):
    request = httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions")
    if issubclass(error_kind, APIConnectionError):
        error = error_kind(request=request)
    else:
        response = httpx.Response(503, request=request)
        if error_kind is APIResponseValidationError:
            error = error_kind(response=response, body={})
        else:
            error = error_kind("private provider detail", response=response, body=None)
    generator = JournalTitleGenerator(client=client_for(FakeCompletions(error=error)))

    with pytest.raises(expected) as caught:
        generator.generate("Journal text")
    assert caught.value.__cause__ is error
