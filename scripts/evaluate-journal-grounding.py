"""Evaluate eight bundled fictional A08 cases; offline by default, no database access."""
import argparse
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path
import sys
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "backend"))
CASES_PATH = Path(__file__).with_name("journal-grounding-cases.json")
MAX_CALLS = 8


def load_cases():
    """Expand only checked-in fictional fixtures, never caller-supplied journals."""
    from app.schemas.journal_qa import JournalExcerpt, JournalQuestionRequest, MAX_QA_CONTEXT_CHARS
    from app.services.weekly_reflection import _Source, MAX_WEEKLY_REFLECTION_INPUT

    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    if len(cases) != MAX_CALLS or len({c["name"] for c in cases}) != MAX_CALLS:
        raise ValueError("Expected eight uniquely named bundled cases.")
    for case in cases:
        entries = []
        for index, entry in enumerate(case["entries"]):
            content = entry["content"] + entry.get("repeat", "") * entry.get("repeat_count", 0) + entry.get("suffix", "")
            entries.append(dict(id=str(UUID(int=index + 1)), journal_date=entry["journal_date"], content=content))
        case["entries"] = entries
        if case["kind"] == "reflection":
            start = date.fromisoformat(case["period_start"])
            if not entries or any(not start <= date.fromisoformat(e["journal_date"]) <= start + timedelta(days=6) for e in entries):
                raise ValueError("Reflection fixture must stay inside its selected week.")
            for entry in entries:
                _Source.model_validate(entry)
            payload = {"entries": entries}
            maximum = MAX_WEEKLY_REFLECTION_INPUT
        elif case["kind"] == "qa":
            JournalQuestionRequest(question=case["question"])
            for entry in entries:
                JournalExcerpt.model_validate(entry)
            if len(entries) > 5:
                raise ValueError("Q&A fixture exceeds source count.")
            payload = {"question": case["question"], "entries": entries}
            maximum = MAX_QA_CONTEXT_CHARS
        else:
            raise ValueError("Unknown fixture kind.")
        if len(json.dumps(payload, ensure_ascii=False)) > maximum:
            raise ValueError("Fixture exceeds the production input budget.")
        check_result(case, case["example_output"])
    return cases


def check_result(case, raw):
    """Check contracts, date membership and case-specific Q&A expectations only.

    A passing check does not establish that natural-language claims are grounded.
    """
    from app.schemas.journal_qa import JournalAnswerResponse
    from app.schemas.weekly import WeeklyReflectionContent
    from app.services.journal_qa import validate_answer_sources
    from app.services.weekly_reflection import validate_reflection_sources

    if case["kind"] == "reflection":
        result = WeeklyReflectionContent.model_validate(raw)
        validate_reflection_sources(result, case["entries"])
    else:
        result = JournalAnswerResponse.model_validate(raw)
        validate_answer_sources(result, case["entries"])
        if result.status != case["expected_status"]:
            raise ValueError("Case returned an unexpected evidence status.")
        if [day.isoformat() for day in result.source_dates] != case["expected_source_dates"]:
            raise ValueError("Case returned unexpected evidence dates.")
    return result.model_dump(mode="json")


def safe_failure_details(error):
    """Whitelist SDK failure metadata; never serialize messages, bodies or headers."""
    from groq import APIConnectionError, APIStatusError, APITimeoutError

    cause = error.__cause__
    if isinstance(cause, APITimeoutError):
        return {"failure_category": "timeout"}
    if isinstance(cause, APIStatusError):
        status = cause.status_code
        if type(status) is int and 400 <= status <= 599:
            return {"failure_category": "provider_http_error", "provider_status": status}
    if isinstance(cause, APIConnectionError):
        return {"failure_category": "connection"}
    return {}


def evaluate(cases, generator, answerer, report, save):
    """One production helper invocation per selected case, no automatic retries."""
    from app.services._groq import JournalSummaryError, AIServiceNotConfiguredError
    from pydantic import ValidationError

    failed = False
    for case in cases:
        record = {"name": case["name"], "kind": case["kind"],
                  "source_dates": sorted({e["journal_date"] for e in case["entries"]}),
                  "input_sha256": hashlib.sha256(json.dumps(case["entries"], ensure_ascii=False).encode()).hexdigest(),
                  "review_criteria": case["review"], "semantic_review": "pending",
                  "checks": "attempting"}
        report["cases"].append(record)
        report["attempts"] += 1
        save()  # Leave an attempt record even if interrupted during provider work.
        try:
            if case["kind"] == "reflection":
                result = generator.generate(case["entries"])
            else:
                result = answerer.answer(case["question"], case["entries"])
            record["result"] = result.model_dump(mode="json")
            check_result(case, result)
            record["checks"] = "passed"
        except (JournalSummaryError, ValidationError, ValueError) as error:
            # No exception messages, raw provider bodies, credentials or tracebacks.
            record["checks"] = "failed"
            record["error_type"] = type(error).__name__
            record.update(safe_failure_details(error))
            failed = True
            if isinstance(error, AIServiceNotConfiguredError):
                save()
                break
        save()
    report["completed"] = len(report["cases"]) == len(cases) and all(c["checks"] != "attempting" for c in report["cases"])
    save()
    return 1 if failed else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Allow one real Groq call per selected fictional case, at most eight")
    parser.add_argument("--case", action="append", dest="selected", help="Select a bundled case by name (repeatable)")
    parser.add_argument("--output", type=Path, help="New JSON report path; required for live evaluation, never overwritten")
    args = parser.parse_args(argv)
    cases = load_cases()
    if args.selected:
        selected = set(args.selected)
        if not selected <= {c["name"] for c in cases}:
            parser.error("Unknown case. No calls made.")
        cases = [c for c in cases if c["name"] in selected]
    if not args.live:
        print(json.dumps({"mode": "offline", "provider_calls": 0, "semantic_review": "not_run",
                          "cases": [{"name": c["name"], "kind": c["kind"],
                                     "input_chars": sum(len(e["content"]) for e in c["entries"]),
                                     "review_criteria": c["review"]} for c in cases]}, ensure_ascii=False, indent=2))
        return 0
    if not args.output:
        parser.error("Live evaluation requires a new --output report path. No calls made.")
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    from app.config import groq_api_key, groq_model
    from app.services.weekly_reflection import GroqWeeklyReflectionGenerator, SYSTEM_PROMPT as REFLECTION_PROMPT
    from app.services.journal_qa import GroqJournalQuestionAnswerer, SYSTEM_PROMPT as QA_PROMPT
    if not (groq_api_key() or "").strip():
        parser.exit(2, "GROQ_API_KEY is unavailable. No calls made.\n")
    report = {"mode": "live", "fictional_only": True, "model": groq_model(),
              "fixture_sha256": hashlib.sha256(CASES_PATH.read_bytes()).hexdigest(),
              "prompt_sha256": {"reflection": hashlib.sha256(REFLECTION_PROMPT.encode()).hexdigest(),
                                "qa": hashlib.sha256(QA_PROMPT.encode()).hexdigest()},
              "max_calls": len(cases), "attempts": 0, "completed": False, "cases": []}
    # Reserve the file before constructing/calling adapters. Existing evidence is preserved.
    try:
        output = args.output.open("x", encoding="utf-8")
    except OSError:
        parser.exit(2, "Report path is unavailable or already exists. No calls made.\n")
    with output:
        def save():
            output.seek(0)
            json.dump(report, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.truncate()
            output.flush()
        save()
        code = evaluate(cases, GroqWeeklyReflectionGenerator(), GroqJournalQuestionAnswerer(), report, save)
    print(f"Recorded {report['attempts']} attempts; review natural-language grounding in {args.output}.")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
