from datetime import date
import json
from uuid import uuid4

import httpx
import pytest
from groq import APITimeoutError, AuthenticationError, RateLimitError
from pydantic import ValidationError

from app.main import create_app
from app.schemas.journal_qa import JournalAnswerResponse
from app.services import AIInvalidResponseError, AIServiceNotConfiguredError, AIServiceUnavailableError
from app.services.journal_qa import GroqJournalQuestionAnswerer, JournalQuestionTooLarge, insufficient_answer
from test_ai_service import FakeCompletions, client_for

SOURCES = [{"id": str(uuid4()), "journal_date": "2026-11-18", "content": "I had coffee at the riverside cafe."}]
OUTPUT = {"status": "answered", "answer": "You had coffee at the riverside cafe.", "source_dates": ["2026-11-18"]}


def test_adapter_sends_one_bounded_question_with_only_dated_excerpts():
    completions = FakeCompletions(json.dumps(OUTPUT))
    result = GroqJournalQuestionAnswerer(client=client_for(completions), model="test-model").answer("Where did I have coffee?", SOURCES)
    assert result.source_dates == [date(2026, 11, 18)]
    assert len(completions.calls) == 1
    call = completions.calls[0]
    assert json.loads(call["messages"][1]["content"]) == {"question": "Where did I have coffee?", "entries": SOURCES}
    assert call["model"] == "test-model" and call["max_completion_tokens"] == 1536
    assert call["response_format"] == {"type": "json_object"} and call["temperature"] == 0


@pytest.mark.parametrize("value", [
    None, "", "not json", "[]", "{}",
    json.dumps({**OUTPUT, "source_dates": []}),
    json.dumps({**OUTPUT, "source_dates": ["2026-11-19"]}),
    json.dumps({**OUTPUT, "source_dates": [0]}),
    json.dumps({**OUTPUT, "source_dates": ["2026-11-18T00:00:00Z"]}),
    json.dumps({**OUTPUT, "source_dates": ["2026-11-18"] * 6}),
    json.dumps({**OUTPUT, "status": "guess"}),
    json.dumps({**OUTPUT, "status": "insufficient_evidence"}),
    json.dumps({**OUTPUT, "answer": " "}),
    json.dumps({**OUTPUT, "answer": "x" * 2401}),
    json.dumps({**OUTPUT, "user_id": str(uuid4())}),
])
def test_invalid_or_unknown_evidence_is_rejected(value):
    completions = FakeCompletions(value)
    with pytest.raises(AIInvalidResponseError):
        GroqJournalQuestionAnswerer(client=client_for(completions)).answer("Coffee?", SOURCES)
    assert len(completions.calls) == 1


def test_insufficient_result_is_a_canonical_message_without_assertions():
    completions = FakeCompletions(json.dumps({"status": "insufficient_evidence", "answer": "Unverified private claims", "source_dates": []}))
    result = GroqJournalQuestionAnswerer(client=client_for(completions)).answer("Where did I have coffee?", SOURCES)
    assert result == insufficient_answer("Where did I have coffee?")
    assert "Unverified" not in result.answer


@pytest.mark.parametrize("question, vietnamese", [
    ("Where did I go?", False), ("What did Minh say in \u0110\u00e0 L\u1ea1t?", False),
    ("M\u00ecnh \u0111\u00e3 \u0111i \u0111\u00e2u?", True), ("minh di dau?", True),
])
def test_empty_context_uses_question_language_and_never_calls_provider(question, vietnamese):
    completions = FakeCompletions("{}")
    result = GroqJournalQuestionAnswerer(client=client_for(completions)).answer(question, [])
    assert result.status == "insufficient_evidence" and result.source_dates == []
    assert result.answer.startswith("Kh\u00f4ng" if vietnamese else "I could not")
    assert completions.calls == []


def test_input_limits_are_enforced_before_a_provider_call():
    completions = FakeCompletions("{}")
    answerer = GroqJournalQuestionAnswerer(client=client_for(completions))
    with pytest.raises(JournalQuestionTooLarge): answerer.answer("Coffee?", SOURCES * 6)
    with pytest.raises(ValidationError): answerer.answer(" ", SOURCES)
    entries = [{**SOURCES[0], "content": "\x01" * 1200} for _ in range(5)]
    with pytest.raises(JournalQuestionTooLarge): answerer.answer("Coffee?", entries)
    assert completions.calls == []


@pytest.mark.parametrize("kind, expected", [("auth", AIServiceNotConfiguredError), ("timeout", AIServiceUnavailableError), ("quota", AIServiceUnavailableError)])
def test_provider_failures_use_existing_safe_error_types(kind, expected):
    request = httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions")
    response = httpx.Response(401 if kind == "auth" else 429, request=request)
    errors = {"auth": AuthenticationError("private details", response=response, body=None),
              "timeout": APITimeoutError(request=request),
              "quota": RateLimitError("private details", response=response, body=None)}
    completions = FakeCompletions(error=errors[kind])
    with pytest.raises(expected) as caught:
        GroqJournalQuestionAnswerer(client=client_for(completions)).answer("Coffee?", SOURCES)
    assert "private" not in str(caught.value) and len(completions.calls) == 1


def test_application_wires_adapter_without_needing_credentials_at_startup(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    app = create_app()
    try:
        assert isinstance(app.state.journal_question_answerer, GroqJournalQuestionAnswerer)
        with pytest.raises(AIServiceNotConfiguredError): app.state.journal_question_answerer.answer("Coffee?", SOURCES)
    finally:
        app.state.engine.dispose()


def test_constructed_invalid_result_is_revalidated():
    result = JournalAnswerResponse.model_construct(status="answered", answer="Claim", source_dates=[])
    with pytest.raises(ValidationError): JournalAnswerResponse.model_validate(result)
