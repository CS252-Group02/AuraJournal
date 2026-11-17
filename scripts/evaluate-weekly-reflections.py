"""Explicit opt-in: six fictional inputs, at most six billable calls, no DB access."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "backend"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Allow up to six real Groq calls with bundled fictional journals")
    parser.add_argument("--case", action="append", dest="selected", help="Evaluate only this bundled case (repeatable)")
    args = parser.parse_args()
    if not args.live:
        parser.error("No calls made. Pass --live to evaluate the six fictional journal sets.")

    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    from app.config import groq_api_key, groq_model
    from app.services._groq import JournalSummaryError
    from app.services.weekly_reflection import GroqWeeklyReflectionGenerator, SYSTEM_PROMPT

    if not groq_api_key() or not groq_api_key().strip():
        parser.exit(2, "Not executed: GROQ_API_KEY is unavailable.\n")
    cases = json.loads(Path(__file__).with_name("weekly-reflection-cases.json").read_text(encoding="utf-8"))
    if len(cases) != 6:
        parser.exit(2, "No calls made: expected exactly six bundled cases.\n")
    if args.selected:
        selected = set(args.selected)
        if not selected <= {case["name"] for case in cases}:
            parser.exit(2, "No calls made: unknown case name.\n")
        cases = [case for case in cases if case["name"] in selected]
    generator = GroqWeeklyReflectionGenerator()
    report = {"model": groq_model(), "prompt_sha256": hashlib.sha256(SYSTEM_PROMPT.encode()).hexdigest(), "cases": []}
    failed = False
    for case in cases:
        entries = [entry | {"id": str(UUID(int=index + 1))} for index, entry in enumerate(case["entries"])]
        record = {"name": case["name"], "review": case["review"]}
        try:
            record["result"] = generator.generate(entries).model_dump()
        except JournalSummaryError as error:
            record["error"] = type(error).__name__  # Never echo credentials or provider bodies.
            failed = True
        report["cases"].append(record)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
