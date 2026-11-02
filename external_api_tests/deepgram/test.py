"""Run one local Deepgram Speech-to-Text test.

Paste a temporary key in DEEPGRAM_API_KEY, run this file, then clear the key
before committing or sharing the file.
"""
from __future__ import annotations

import json
import mimetypes
import sys
import time
import wave
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEEPGRAM_API_KEY = ""

ROOT = Path(__file__).resolve().parent
AUDIO_PATH = ROOT / "data" / "audio" / "vivoice34_train_0000.wav"
REFERENCE_PATH = ROOT / "data" / "reference" / "vivoice34_train_0000.txt"
MODEL = "nova-3"
LANGUAGE = "vi"
TIMEOUT_SECONDS = 180


def wav_duration_seconds(path: Path) -> float | None:
    """Return the duration of a WAV file when it can be read locally."""
    try:
        with wave.open(str(path), "rb") as audio:
            return audio.getnframes() / audio.getframerate()
    except (wave.Error, OSError, ZeroDivisionError):
        return None


def normalize(text: str) -> str:
    """Normalize text for a simple character error rate calculation."""
    return " ".join(text.lower().split())


def character_error_rate(reference: str, hypothesis: str) -> float | None:
    """Calculate CER without changing the provider transcript."""
    reference = normalize(reference)
    hypothesis = normalize(hypothesis)
    if not reference:
        return None

    previous = list(range(len(hypothesis) + 1))
    for row, reference_char in enumerate(reference, start=1):
        current = [row]
        for column, hypothesis_char in enumerate(hypothesis, start=1):
            current.append(min(
                current[-1] + 1,
                previous[column] + 1,
                previous[column - 1] + (reference_char != hypothesis_char),
            ))
        previous = current
    return previous[-1] / len(reference)


def extract_transcript(response: dict) -> str:
    """Extract the first transcript returned by Deepgram."""
    try:
        return response["results"]["channels"][0]["alternatives"][0]["transcript"]
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError("Deepgram returned no transcript in the expected format.") from error


def request_transcript(audio_path: Path) -> tuple[dict, float]:
    """Send one audio file to Deepgram without automatic retries."""
    query = urlencode({"model": MODEL, "language": LANGUAGE, "smart_format": "true"})
    media_type = mimetypes.guess_type(audio_path.name)[0] or "application/octet-stream"
    request = Request(
        f"https://api.deepgram.com/v1/listen?{query}",
        data=audio_path.read_bytes(),
        method="POST",
        headers={
            "Authorization": f"Token {DEEPGRAM_API_KEY}",
            "Content-Type": media_type,
        },
    )
    started = time.perf_counter()
    try:
        with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8")
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Deepgram returned HTTP {error.code}: {body}") from error
    except URLError as error:
        raise RuntimeError(f"Could not connect to Deepgram: {error.reason}") from error
    return json.loads(body), time.perf_counter() - started


def main() -> int:
    if not DEEPGRAM_API_KEY.strip():
        print("Set DEEPGRAM_API_KEY at the top of test.py before running.")
        return 1
    if not AUDIO_PATH.is_file():
        print(f"Audio file not found: {AUDIO_PATH}")
        return 1

    print(f"Sending one file to Deepgram: {AUDIO_PATH.name}")
    try:
        response, request_seconds = request_transcript(AUDIO_PATH)
        transcript = extract_transcript(response)
    except (RuntimeError, json.JSONDecodeError) as error:
        print(f"Request failed: {error}")
        return 1

    reference = REFERENCE_PATH.read_text(encoding="utf-8").strip() if REFERENCE_PATH.is_file() else ""
    duration_seconds = wav_duration_seconds(AUDIO_PATH)
    output_dir = ROOT / "results" / f"run_{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}"
    output_dir.mkdir(parents=True, exist_ok=False)

    (output_dir / "transcript.txt").write_text(transcript + "\n", encoding="utf-8")
    (output_dir / "response.json").write_text(
        json.dumps(response, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    if reference:
        (output_dir / "reference.txt").write_text(reference + "\n", encoding="utf-8")
    metrics = {
        "audio_file": str(AUDIO_PATH.relative_to(ROOT)),
        "audio_duration_seconds": duration_seconds,
        "duration_in_required_range_20_to_60_seconds": (
            20 <= duration_seconds <= 60 if duration_seconds is not None else None
        ),
        "model": MODEL,
        "language": LANGUAGE,
        "request_seconds": round(request_seconds, 3),
        "character_error_rate": character_error_rate(reference, transcript) if reference else None,
        "reference_available": bool(reference),
        "note": "Deepgram confidence values, if returned, are not accuracy.",
    }
    (output_dir / "metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print("Request succeeded.")
    print(f"Transcript: {transcript}")
    print(f"Saved results: {output_dir}")
    if metrics["character_error_rate"] is not None:
        print(f"CER against the local reference: {metrics['character_error_rate']:.2%}")
    return 0


if __name__ == "__main__":
    sys.exit(main())