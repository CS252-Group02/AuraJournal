"""Capture one explicitly authorized STREAMING request, then replay mapping offline.

The report contains transcript text. Keep it in a local, Git-ignored directory.
No credentials, request headers, provider diagnostics or original audio are logged.
Production completed uploads use prerecorded HTTP instead. This tool is for
streaming comparisons only. No call occurs without --live. There are no retries.
"""
import argparse
import asyncio
from contextlib import aclosing
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import sys
from time import monotonic
import traceback

from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
from app.services import DeepgramError, DeepgramStreamingClient, TranscriptNormalizer  # noqa: E402
from app.services.async_deadline import deadline  # noqa: E402

MAX_AUDIO_BYTES = 10 * 1024 * 1024
MAX_EVENTS = 1000
MAX_CAPTURE_CHARS = 8 * 1024 * 1024


def source_event(event):
    """Only keep fields needed to replay the normalizer, never request metadata."""
    if event.get("type") != "Results":
        return {"type": event.get("type")}
    return {key: event[key] for key in (
        "type", "channel_index", "start", "duration", "is_final", "speech_final", "from_finalize", "channel"
    ) if key in event}


def replay(events):
    normalizer = TranscriptNormalizer("diagnostic-replay")
    segments = []
    for index, record in enumerate(events):
        try:
            segments.extend(normalizer.consume(record["event"]))
        except DeepgramError as error:
            # Stack locations explain the failing validation branch without
            # stringifying exceptions, locals or submitted transcript content.
            frames = []
            current = error
            while current is not None:
                frames.extend({"function": frame.name, "line": frame.lineno}
                              for frame in traceback.extract_tb(current.__traceback__)
                              if Path(frame.filename).name == "transcription.py")
                current = current.__context__
            return {"status": "failed", "error_code": error.code, "event_index": index, "frames": frames}
    completion = normalizer.complete()
    finals = {segment["segment_id"]: segment for segment in segments if segment["is_final"]}
    output = {"status": "incomplete" if completion["outcome"] == "incomplete" else "completed",
              "completion": completion,
              "transcript": " ".join(segment["text"] for segment in sorted(finals.values(), key=lambda item: item["order"]))}
    if completion["outcome"] == "incomplete":
        output["error_code"] = "invalid_response"
    return output


async def capture(audio, report, *, client=None):
    began = monotonic()
    captured_chars = 0
    def phase(name):
        report["phases"].append({"name": name, "elapsed_seconds": round(monotonic() - began, 4)})
    try:
        phase("connecting")
        async with (client or DeepgramStreamingClient()).connect() as stream:
            phase("connected")
            async def send():
                for offset in range(0, len(audio), 64 * 1024):
                    await stream.send_audio(audio[offset:offset + 64 * 1024])
                phase("audio_sent")
                phase("finishing")
                await stream.finish()
                phase("finished")
            async def receive():
                nonlocal captured_chars
                async with aclosing(stream.events()) as events:
                    async for event in events:
                        value = source_event(event)
                        captured_chars += len(json.dumps(value, ensure_ascii=False))
                        if len(report["events"]) >= MAX_EVENTS or captured_chars > MAX_CAPTURE_CHARS:
                            phase("capture_limit")
                            raise ValueError("Diagnostic capture limit reached.")
                        report["events"].append({"elapsed_seconds": round(monotonic() - began, 4), "event": value})
            tasks = [asyncio.create_task(send()), asyncio.create_task(receive())]
            try:
                await deadline(asyncio.gather(*tasks), 60)
            finally:
                for task in tasks: task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        report["transport"] = {"status": "completed"}
    except DeepgramError as error:
        report["transport"] = {"status": "failed", "error_code": error.code}
    except (TimeoutError, asyncio.TimeoutError):
        report["transport"] = {"status": "failed", "error_code": "timeout"}
    report["replay"] = replay(report["events"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path)
    parser.add_argument("--live", action="store_true", help="Allow exactly one provider connection, no retry")
    parser.add_argument("--finish-timeout", type=float, default=12, help="Diagnostic flush deadline, >0 and <=55 seconds (total remains 60)")
    parser.add_argument("--output", type=Path, required=True, help="New local JSON report containing speech text")
    parser.add_argument("--env-file", type=Path, default=BACKEND.parents[1] / ".env")
    args = parser.parse_args(argv)
    if not args.live:
        parser.error("No calls made: --live is required for an explicitly authorized diagnostic.")
    if not math.isfinite(args.finish_timeout) or not 0 < args.finish_timeout <= 55:
        parser.error("No calls made: finish timeout must be finite, >0 and <=55 seconds.")
    report = {"finish_timeout_seconds": args.finish_timeout, "started_at_utc": datetime.now(timezone.utc).isoformat(), "maximum_attempts": 1,
              "automatic_retries": 0, "events": [], "phases": []}
    try:
        with args.audio.open("rb") as source: audio = source.read(MAX_AUDIO_BYTES + 1)
        if not audio.startswith(bytes.fromhex("1a45dfa3")) or len(audio) > MAX_AUDIO_BYTES:
            raise ValueError("Use a browser WebM recording of at most 10 MiB.")
        load_dotenv(args.env_file, override=False)
        if not os.environ.get("DEEPGRAM_API_KEY", "").strip():
            print("No calls made: DEEPGRAM_API_KEY unavailable.", file=sys.stderr)
            return 2
        # Reserve the output before spending credit; an existing report prevents
        # accidental duplicate invocations and is never overwritten.
        with args.output.open("x", encoding="utf-8") as target:
            json.dump(report, target, ensure_ascii=False)
        try:
            asyncio.run(capture(audio, report, client=DeepgramStreamingClient(finish_timeout=args.finish_timeout)))
        finally:
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("Transport:", report["transport"]["status"])
        print("Replay:", report["replay"]["status"])
        if "error_code" in report["replay"]: print("Replay error:", report["replay"]["error_code"])
        print("Events captured:", len(report["events"]))
        return 0 if report["transport"]["status"] == "completed" and report["replay"]["status"] == "completed" else 1
    except (OSError, ValueError):
        print("Check local recording/output paths or diagnostic limits; no retry made.", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
