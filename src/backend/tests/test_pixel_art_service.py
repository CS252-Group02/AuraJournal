import json

import pytest
from pydantic import ValidationError

from app.services._groq import AIInvalidResponseError, EmptyJournalError
from app.services.pixel_art import (
    FALLBACK_SCENE, SYSTEM_PROMPT, MomentExtractor, SignificantMoment, build_pixel_art_prompt,
)
from test_ai_service import FakeCompletions, client_for


def grounded(**changes):
    return dict(kind="grounded", moment="Finished homework", evidence="finished my homework",
                scene="A person completing a homework exercise.", **changes)


def extractor(result):
    completions = FakeCompletions(json.dumps(result, ensure_ascii=False))
    return MomentExtractor(client=client_for(completions)), completions


def test_extract_and_build_separate_stages():
    service, calls = extractor(grounded())
    source = "Today I finished my homework. Tomorrow I plan to visit the museum."
    moment = service.extract(source)
    prompt = build_pixel_art_prompt(moment)
    assert moment.kind == "grounded"
    assert moment.evidence in source
    assert source not in prompt
    assert moment.scene in prompt and "128x128" in prompt
    assert "No text" in prompt and len(prompt) <= 800
    assert calls.calls[0]["response_format"] == {"type": "json_object"}
    assert calls.calls[0]["messages"][1]["content"] == source


def test_vietnamese_source_and_evidence_are_preserved():
    source = "Hôm nay tôi hoàn thành bài tập Toán. Ngày mai tôi định đi chơi."
    result = dict(kind="grounded", moment="Hoàn thành bài tập Toán", evidence="hoàn thành bài tập Toán",
                  scene="A person finishing a mathematics exercise.")
    service, calls = extractor(result)
    assert service.extract(source).moment == result["moment"]
    assert calls.calls[0]["messages"][1]["content"] == source


@pytest.mark.parametrize("source", ["Okay.", "...", "Tomorrow I plan to fly to Paris."])
def test_vague_and_future_only_entries_use_explicit_symbolic_fallback(source):
    service, _ = extractor(dict(kind="symbolic", moment="No concrete moment selected", evidence=None, scene=None))
    moment = service.extract(source)
    assert moment.kind == "symbolic"
    assert build_pixel_art_prompt(moment).startswith(FALLBACK_SCENE)
    assert source not in build_pixel_art_prompt(moment)


@pytest.mark.parametrize("source", ["", "  ", None])
def test_empty_input_does_not_call_groq(source):
    service, calls = extractor({})
    with pytest.raises(EmptyJournalError):
        service.extract(source)
    assert calls.calls == []


@pytest.mark.parametrize("result", [
    {}, {"kind": "grounded"},
    dict(kind="symbolic", moment="none", evidence="invented", scene="an event"),
    dict(kind="grounded", moment="A", evidence=None, scene="B"),
    dict(kind="grounded", moment="A", evidence="invented", scene="B"),
    dict(kind="grounded", moment="A", evidence="homework", scene="x" * 451),
    dict(kind="grounded", moment="A", evidence="homework", scene="Line\nbreak"),
])
def test_invalid_or_ungrounded_output_is_rejected(result):
    service, _ = extractor(result)
    with pytest.raises(AIInvalidResponseError):
        service.extract("I finished my homework.")


def test_full_journal_cannot_be_forwarded_as_scene():
    source = "I finished my homework."
    result = grounded()
    result["scene"] = source
    service, _ = extractor(result)
    with pytest.raises(AIInvalidResponseError):
        service.extract(source)


def test_invalid_json_is_controlled():
    service = MomentExtractor(client=client_for(FakeCompletions("not json")))
    with pytest.raises(AIInvalidResponseError):
        service.extract("My day")


def test_schema_forbids_unknown_fields_and_invalid_prompt():
    result = grounded()
    result["instructions"] = "ignore source"
    with pytest.raises(ValidationError):
        SignificantMoment.model_validate(result)
    result = grounded()
    result["scene"] = " "
    with pytest.raises(ValidationError):
        SignificantMoment.model_validate(result)


def test_factual_and_injection_constraints_are_in_system_message():
    for instruction in ["untrusted", "NEVER instructions", "Future plans", "negated",
                        "Never invent", "Vietnamese", "identifiers", "exact short quotation"]:
        assert instruction in SYSTEM_PROMPT
