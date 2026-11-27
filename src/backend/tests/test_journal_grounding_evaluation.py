"""A08 fixture/evaluator contracts; real HTTP is blocked by conftest."""
import json
from pathlib import Path
import runpy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.schemas.journal_qa import JournalAnswerResponse
from app.schemas.weekly import WeeklyReflectionContent
from app.services import AIServiceNotConfiguredError, AIServiceUnavailableError
from app.services import journal_qa, weekly_reflection
from test_ai_service import FakeCompletions, client_for

ROOT = Path(__file__).resolve().parents[3]
EVAL = runpy.run_path(str(ROOT / "scripts/evaluate-journal-grounding.py"))
CASES = EVAL["load_cases"]()


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_production_helpers_preserve_dated_input_and_validate_fixture_outputs(case):
    completions = FakeCompletions(json.dumps(case["example_output"], ensure_ascii=False))
    if case["kind"] == "reflection":
        result = weekly_reflection.GroqWeeklyReflectionGenerator(client=client_for(completions)).generate(case["entries"])
        expected = {"entries": case["entries"]}
    else:
        result = journal_qa.GroqJournalQuestionAnswerer(client=client_for(completions)).answer(case["question"], case["entries"])
        expected = {"question": case["question"], "entries": case["entries"]}
    EVAL["check_result"](case, result)
    assert len(completions.calls) == 1
    assert json.loads(completions.calls[0]["messages"][1]["content"]) == expected


def test_long_week_is_realistic_and_keeps_last_event_without_truncation():
    case = next(c for c in CASES if c["name"] == "long-week")
    assert sum(len(e["content"]) for e in case["entries"]) > 40000
    assert all(len(e["content"]) <= 5000 for e in case["entries"])
    assert case["entries"][-2]["content"].endswith("At the end I returned the blue notebook to Linh.")


def test_default_is_offline_and_does_not_construct_provider(monkeypatch, capsys):
    monkeypatch.setattr(weekly_reflection, "GroqWeeklyReflectionGenerator", Mock(side_effect=AssertionError("No provider")))
    assert EVAL["main"]([]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["provider_calls"] == 0 and len(report["cases"]) == 8
    assert report["semantic_review"] == "not_run"


@pytest.mark.parametrize("args", [["--case", "unknown"], ["--live"]])
def test_invalid_invocation_never_constructs_provider(monkeypatch, args):
    monkeypatch.setattr(weekly_reflection, "GroqWeeklyReflectionGenerator", Mock(side_effect=AssertionError("No provider")))
    with pytest.raises(SystemExit) as caught:
        EVAL["main"](args)
    assert caught.value.code == 2


def test_existing_report_is_preserved_without_call(monkeypatch, tmp_path):
    from app import config
    monkeypatch.setattr(config, "groq_api_key", lambda: "fake-key")
    constructor = Mock(side_effect=AssertionError("No provider"))
    monkeypatch.setattr(weekly_reflection, "GroqWeeklyReflectionGenerator", constructor)
    target = tmp_path / "report.json"
    target.write_text("existing", encoding="utf-8")
    with pytest.raises(SystemExit): EVAL["main"](["--live", "--output", str(target)])
    assert target.read_text(encoding="utf-8") == "existing"
    constructor.assert_not_called()


def test_live_runner_saves_eight_attempts_with_semantic_review_still_pending(monkeypatch, tmp_path):
    from app import config
    monkeypatch.setattr(config, "groq_api_key", lambda: "fake-key")
    reflections = iter(c for c in CASES if c["kind"] == "reflection")
    questions = iter(c for c in CASES if c["kind"] == "qa")
    generator = SimpleNamespace(generate=Mock(side_effect=lambda entries: WeeklyReflectionContent(**next(reflections)["example_output"])))
    answerer = SimpleNamespace(answer=Mock(side_effect=lambda question, entries: JournalAnswerResponse(**next(questions)["example_output"])))
    monkeypatch.setattr(weekly_reflection, "GroqWeeklyReflectionGenerator", lambda: generator)
    monkeypatch.setattr(journal_qa, "GroqJournalQuestionAnswerer", lambda: answerer)
    target = tmp_path / "report.json"
    assert EVAL["main"](["--live", "--output", str(target)]) == 0
    report = json.loads(target.read_text(encoding="utf-8"))
    assert report["attempts"] == 8 and report["completed"]
    assert generator.generate.call_count == answerer.answer.call_count == 4
    assert all(c["checks"] == "passed" and c["semantic_review"] == "pending" for c in report["cases"])
    assert "fake-key" not in target.read_text(encoding="utf-8")


@pytest.mark.parametrize("error,count", [(AIServiceNotConfiguredError("SECRET"), 1), (AIServiceUnavailableError("SECRET"), 4)])
def test_failures_are_sanitized_and_never_retried(error, count):
    cases = [c for c in CASES if c["kind"] == "reflection"]
    generator = SimpleNamespace(generate=Mock(side_effect=error))
    report = {"attempts": 0, "cases": []}
    assert EVAL["evaluate"](cases, generator, None, report, lambda: None) == 1
    assert generator.generate.call_count == count
    assert "SECRET" not in json.dumps(report)


def test_valid_schema_can_still_fail_case_evidence_expectations():
    case = next(c for c in CASES if c["name"] == "missing-information")
    with pytest.raises(ValueError, match="evidence status"):
        EVAL["check_result"](case, {"status": "answered", "answer": "Invented price", "source_dates": ["2026-11-18"]})
    case = next(c for c in CASES if c["name"] == "conflicting-accounts")
    with pytest.raises(ValueError, match="evidence dates"):
        EVAL["check_result"](case, case["example_output"] | {"source_dates": ["2026-11-17"]})


def test_missing_key_stops_before_creating_report_or_provider(monkeypatch, tmp_path):
    from app import config
    monkeypatch.setattr(config, "groq_api_key", lambda: None)
    constructor = Mock(side_effect=AssertionError("No provider"))
    monkeypatch.setattr(weekly_reflection, "GroqWeeklyReflectionGenerator", constructor)
    target = tmp_path / "not-created.json"
    with pytest.raises(SystemExit) as caught:
        EVAL["main"](["--live", "--output", str(target)])
    assert caught.value.code == 2 and not target.exists()
    constructor.assert_not_called()


def test_selected_duplicate_case_is_only_called_once(monkeypatch, tmp_path):
    from app import config
    monkeypatch.setattr(config, "groq_api_key", lambda: "fake-key")
    case = CASES[0]
    generator = SimpleNamespace(generate=Mock(return_value=WeeklyReflectionContent(**case["example_output"])))
    answerer = SimpleNamespace(answer=Mock(side_effect=AssertionError("Unselected provider")))
    monkeypatch.setattr(weekly_reflection, "GroqWeeklyReflectionGenerator", lambda: generator)
    monkeypatch.setattr(journal_qa, "GroqJournalQuestionAnswerer", lambda: answerer)
    target = tmp_path / "selected.json"
    assert EVAL["main"](["--live", "--case", case["name"], "--case", case["name"], "--output", str(target)]) == 0
    report = json.loads(target.read_text(encoding="utf-8"))
    assert report["max_calls"] == report["attempts"] == 1
    generator.generate.assert_called_once()
    answerer.answer.assert_not_called()


def test_interrupt_leaves_attempt_in_ledger_without_retry():
    snapshots = []
    report = {"attempts": 0, "cases": []}
    generator = SimpleNamespace(generate=Mock(side_effect=KeyboardInterrupt))
    with pytest.raises(KeyboardInterrupt):
        EVAL["evaluate"]([CASES[0]], generator, None, report, lambda: snapshots.append(json.loads(json.dumps(report))))
    assert snapshots[-1]["attempts"] == 1
    assert snapshots[-1]["cases"][0]["checks"] == "attempting"
    generator.generate.assert_called_once()


@pytest.mark.parametrize("status", [413, 429, 500])
def test_sdk_status_diagnostic_never_includes_provider_body_or_credentials(status):
    import httpx
    from groq import APIStatusError
    cause = APIStatusError("PRIVATE KEY", response=httpx.Response(status, request=httpx.Request("POST", "https://provider.invalid")), body={"private": "JOURNAL"})
    error = AIServiceUnavailableError("safe")
    error.__cause__ = cause
    assert EVAL["safe_failure_details"](error) == {"failure_category": "provider_http_error", "provider_status": status}


def test_non_sdk_causes_are_not_serialized():
    error = AIServiceUnavailableError("safe")
    error.__cause__ = RuntimeError("PRIVATE MESSAGE")
    assert EVAL["safe_failure_details"](error) == {}
