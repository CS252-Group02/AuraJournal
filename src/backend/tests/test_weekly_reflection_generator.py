import json

import pytest

from app.schemas.weekly import WeeklyReflectionContent
from app.services._groq import AIInvalidResponseError, AIServiceNotConfiguredError, EmptyJournalError
from app.services import weekly_reflection as service
from app.services.weekly_reflection import GroqWeeklyReflectionGenerator, WeeklyReflectionTooLarge
from test_ai_service import FakeCompletions, client_for

SOURCES = [{"id": "00000000-0000-0000-0000-000000000001", "journal_date": "2026-11-12",
            "content": "Hôm nay tôi đã nộp báo cáo."}]
OUTPUT = {"summary": "Bạn đã nộp báo cáo.",
          "questions": ["Nhìn lại lúc nộp báo cáo, điều gì đọng lại với bạn?", "Bạn muốn ghi lại thêm điều gì về việc này?"]}


def test_one_structured_call_receives_dated_unicode_sources_and_prompt():
    completions = FakeCompletions(json.dumps(OUTPUT, ensure_ascii=False))
    generator = GroqWeeklyReflectionGenerator(client=client_for(completions), model="test-model")
    assert generator.generate(SOURCES) == WeeklyReflectionContent(**OUTPUT)
    assert len(completions.calls) == 1
    call = completions.calls[0]
    assert call["model"] == "test-model"
    assert call["max_completion_tokens"] == 1536
    assert call["response_format"] == {"type": "json_object"}
    assert call["messages"][0] == {"role": "system", "content": service.SYSTEM_PROMPT}
    assert json.loads(call["messages"][1]["content"]) == {"entries": SOURCES}
    assert "Hôm nay" in call["messages"][1]["content"]


@pytest.mark.parametrize("content", [None, "", "not JSON", "{}", '[]',
    json.dumps(OUTPUT | {"summary": " "}), json.dumps(OUTPUT | {"summary": "x" * 2401}),
    json.dumps(OUTPUT | {"questions": ["Only one?"]}),
    json.dumps(OUTPUT | {"questions": ["One?", "Two?", "Three?"]}),
    json.dumps(OUTPUT | {"questions": [" ", "Two?"]}),
    json.dumps(OUTPUT | {"questions": ["x" * 301, "Two?"]}),
    json.dumps(OUTPUT | {"questions": ["Same question?", "  SAME   question? "]}),
    json.dumps(OUTPUT | {"extra": "not allowed"}),
])
def test_invalid_outputs_and_duplicate_questions_are_rejected(content):
    generator = GroqWeeklyReflectionGenerator(client=client_for(FakeCompletions(content)))
    with pytest.raises(AIInvalidResponseError):
        generator.generate(SOURCES)


def test_input_budget_is_checked_before_provider_with_exact_boundary_allowed(monkeypatch):
    completions = FakeCompletions(json.dumps(OUTPUT))
    generator = GroqWeeklyReflectionGenerator(client=client_for(completions))
    length = len(json.dumps({"entries": SOURCES}, ensure_ascii=False))
    monkeypatch.setattr(service, "MAX_WEEKLY_REFLECTION_INPUT", length)
    assert generator.generate(SOURCES).summary == OUTPUT["summary"]
    monkeypatch.setattr(service, "MAX_WEEKLY_REFLECTION_INPUT", length - 1)
    with pytest.raises(WeeklyReflectionTooLarge):
        generator.generate(SOURCES)
    with pytest.raises(EmptyJournalError):
        generator.generate([])
    assert len(completions.calls) == 1


def test_missing_configuration_fails_on_generation_not_construction(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    generator = GroqWeeklyReflectionGenerator()
    with pytest.raises(AIServiceNotConfiguredError):
        generator.generate(SOURCES)


def test_default_application_wires_generator_without_calling_provider(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    from app.main import create_app
    app = create_app()
    assert isinstance(app.state.weekly_reflection_generator, GroqWeeklyReflectionGenerator)
    app.state.engine.dispose()
