"""Explicit live check of one non-private browser recording; no automatic retries.

Run from src/backend: python scripts/verify_transcription.py recording.webm
Only an explicit --output writes the transcript to disk. No database is required.
"""

import argparse
import asyncio
from dataclasses import asdict
import json
import os
from pathlib import Path
import sys
import unicodedata
from uuid import uuid4

from dotenv import load_dotenv

# Support the documented direct script invocation, without importing app.main.
BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.services import DeepgramError, collect_recorded_transcript, transcribe_audio  # noqa: E402
from app.services.async_deadline import deadline  # noqa: E402


MAX_AUDIO_BYTES = 10 * 1024 * 1024
CHUNK_BYTES = 64 * 1024
WEBM_SIGNATURE = b"\x1a\x45\xdf\xa3"


def character_error_rate(reference: str, transcript: str) -> float:
    def normalize(text):
        text = unicodedata.normalize("NFC", text).casefold()
        return " ".join("".join(c if c.isalnum() or c.isspace() else " " for c in text).split())

    expected, actual = normalize(reference), normalize(transcript)
    if not expected:
        raise ValueError("Reference must contain letters or numbers.")
    previous = list(range(len(actual) + 1))
    for row, left in enumerate(expected, start=1):
        current = [row]
        for column, right in enumerate(actual, start=1):
            current.append(min(current[-1] + 1, previous[column] + 1,
                               previous[column - 1] + (left != right)))
        previous = current
    return previous[-1] / len(expected)


async def verify(audio):
    async def chunks():
        for offset in range(0, len(audio), CHUNK_BYTES):
            yield audio[offset:offset + CHUNK_BYTES]

    return await deadline(collect_recorded_transcript(transcribe_audio(
        chunks(), session_id=str(uuid4()),
    )), 60)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path, help="A non-private WebM/Opus recording exported by MediaRecorder.")
    parser.add_argument("--reference", type=Path, help="UTF-8 expected speech; reports CER, not an automatic quality verdict.")
    parser.add_argument("--expect", choices=("transcribed", "no_speech"), default="transcribed")
    parser.add_argument("--env-file", type=Path, default=BACKEND.parents[1] / ".env")
    parser.add_argument("--output", type=Path, help="Optional new JSON report, including transcript; never overwrites a file.")
    args = parser.parse_args(argv)
    try:
        with args.audio.open("rb") as source:
            audio = source.read(MAX_AUDIO_BYTES + 1)
        if len(audio) > MAX_AUDIO_BYTES or not audio.startswith(WEBM_SIGNATURE):
            raise ValueError("Use nonempty WebM/Opus audio of at most 10 MiB. Do not relabel other formats.")
        reference = args.reference.read_text(encoding="utf-8") if args.reference else None
        if reference is not None:
            character_error_rate(reference, "")  # Validate before a billable request.
        if args.output and (args.output.exists() or not args.output.parent.is_dir()):
            raise ValueError("Choose a new output file inside an existing directory.")
        load_dotenv(args.env_file, override=False)
        if not os.environ.get("DEEPGRAM_API_KEY", "").strip():
            print("Not executed: DEEPGRAM_API_KEY is unavailable.", file=sys.stderr)
            return 2
        output = asyncio.run(verify(audio))
        report = {**asdict(output), "audio_bytes": len(audio), "expected_outcome": args.expect,
                  "outcome_matches": output.outcome == args.expect}
        if reference is not None:
            report["character_error_rate"] = character_error_rate(reference, output.transcript)
        if args.output:
            with args.output.open("x", encoding="utf-8") as target:
                json.dump(report, target, ensure_ascii=False, indent=2)
                target.write("\n")
        print(f"outcome={output.outcome}; characters={len(output.transcript)}; expected={args.expect}")
        if reference is not None:
            print(f"CER={report['character_error_rate']:.2%}; review meaning and missing phrases manually.")
        return 0 if report["outcome_matches"] else 1
    except DeepgramError as error:
        print(f"Transcription failed: {error.code}.", file=sys.stderr)
        return 1
    except (TimeoutError, asyncio.TimeoutError):
        print("Transcription failed: timeout.", file=sys.stderr)
        return 1
    except (OSError, UnicodeError, ValueError):
        print("Check the recording, reference, and output path. No automatic retry was made.", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("Transcription cancelled.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
