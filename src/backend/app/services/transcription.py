"""Reduce ordered, single-channel Deepgram events to the Record protocol."""

from collections.abc import AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass, replace
import math
from typing import Literal, TypedDict

from app.services.deepgram import (
    DeepgramConfigurationError, DeepgramInvalidAudioError, DeepgramInvalidResponseError,
    DeepgramRateLimitedError, DeepgramTimeoutError, DeepgramUnavailableError,
    provider_stream_error,
)


# Provider timestamps can differ slightly at the same audio boundary.
_TIME_TOLERANCE = 0.001


class TranscriptSegment(TypedDict):
    type: Literal["segment"]
    session_id: str
    segment_id: str
    order: int
    revision: int
    text: str
    is_final: bool


class TranscriptComplete(TypedDict):
    type: Literal["complete"]
    session_id: str
    final_count: int
    outcome: Literal["transcribed", "no_speech", "incomplete"]


@dataclass(frozen=True, repr=False)
class RecordedTranscript:
    """Final-only result for a completed recording; text stays out of repr()."""

    transcript: str
    outcome: Literal["transcribed", "no_speech"]


async def collect_recorded_transcript(events: AsyncIterator[dict]) -> RecordedTranscript:
    """Collect transcribe_audio() events without promoting provisional text.

    Owns and closes the event generator, including cancellation and early return.
    Service errors are raised as the existing safe Deepgram exceptions; callers
    decide whether to turn them into HTTP responses or another presentation.
    """
    errors = {
        "not_configured": DeepgramConfigurationError,
        "invalid_audio": DeepgramInvalidAudioError,
        "invalid_response": DeepgramInvalidResponseError,
        "timeout": DeepgramTimeoutError,
        "rate_limited": DeepgramRateLimitedError,
    }
    segments = {}
    async with aclosing(events):
        async for event in events:
            if not isinstance(event, dict):
                raise _invalid_response()
            if event.get("type") == "error":
                code = event.get("code")
                error = errors.get(code if isinstance(code, str) else "", DeepgramUnavailableError)
                raise error(error.public_message)
            if event.get("type") == "segment":
                segment_id = event.get("segment_id")
                if (not isinstance(segment_id, str) or not segment_id
                        or not isinstance(event.get("text"), str)
                        or type(event.get("is_final")) is not bool
                        or any(type(event.get(key)) is not int or event[key] < 0
                               for key in ("order", "revision"))):
                    raise _invalid_response()
                previous = segments.get(segment_id)
                if previous is None or (not previous["is_final"] and event["revision"] > previous["revision"]):
                    segments[segment_id] = event
            elif event.get("type") == "complete":
                if event.get("outcome") not in ("transcribed", "no_speech"):
                    raise _invalid_response()
                finals = sorted((s for s in segments.values() if s["is_final"]), key=lambda s: s["order"])
                text = " ".join(s["text"].strip() for s in finals if s["text"].strip())
                if (type(event.get("final_count")) is not int or event["final_count"] != len(finals)
                        or bool(text) != (event["outcome"] == "transcribed")
                        or any(not s["is_final"] and s["text"].strip() for s in segments.values())):
                    raise _invalid_response()
                return RecordedTranscript(transcript=text, outcome=event["outcome"])
            else:
                raise _invalid_response()
    raise _invalid_response()


@dataclass(frozen=True, repr=False)
class _Word:
    start: float
    end: float
    text: str


@dataclass(frozen=True, repr=False)
class _Result:
    start: float
    end: float
    text: str
    is_final: bool
    words: tuple[_Word, ...] | None


@dataclass(frozen=True, repr=False)
class _Draft:
    result: _Result
    order: int
    revision: int


def _invalid_response() -> DeepgramInvalidResponseError:
    return DeepgramInvalidResponseError("Speech service returned an invalid transcript.")


def _seconds(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError
    value = float(value)
    if not math.isfinite(value) or value < 0:
        raise ValueError
    return value


def _read_result(event: dict) -> _Result:
    """Validate privately, without letting provider input escape in errors."""
    try:
        channel = event["channel_index"]
        if not isinstance(channel, list) or channel != [0, 1] or any(type(v) is not int for v in channel):
            raise ValueError
        start = _seconds(event["start"])
        end = start + _seconds(event["duration"])
        if not math.isfinite(end) or type(event["is_final"]) is not bool:
            raise ValueError
        for flag in ("speech_final", "from_finalize"):
            if flag in event and type(event[flag]) is not bool:
                raise ValueError
        alternative = event["channel"]["alternatives"][0]
        text = alternative["transcript"]
        if not isinstance(text, str) or (text.strip() and end <= start):
            raise ValueError
        words = None
        if "words" in alternative:
            if not isinstance(alternative["words"], list):
                raise ValueError
            parsed = []
            for word in alternative["words"]:
                word_start, word_end = _seconds(word["start"]), _seconds(word["end"])
                raw_text = word["word"]
                word_text = word.get("punctuated_word", raw_text)
                if (not isinstance(raw_text, str) or not raw_text.strip()
                        or not isinstance(word_text, str) or not word_text.strip()
                        or word_end < word_start
                        or word_start < start - _TIME_TOLERANCE
                        # Interim word ends are provisional and can extend past
                        # the result window (observed with real Nova-3 output).
                        # They must start within the window; finals stay bounded.
                        or word_start > end + _TIME_TOLERANCE
                        or (event["is_final"] and word_end > end + _TIME_TOLERANCE)
                        or (parsed and word_start < parsed[-1].start)):
                    raise ValueError
                parsed.append(_Word(word_start, word_end, word_text.strip()))
            if parsed and not text.strip():
                raise ValueError
            words = tuple(parsed) or None
        return _Result(start, end, text.strip(), event["is_final"], words)
    except (KeyError, IndexError, TypeError, ValueError, OverflowError):
        raise _invalid_response() from None


def _after(result: _Result, boundary: float, *, superseded_draft: bool = False) -> _Result:
    """Keep only audio after a final boundary; never guess by matching words."""
    if result.start >= boundary - _TIME_TOLERANCE:
        return result
    if not result.text:
        return replace(result, start=boundary)
    if result.words is None:
        raise _invalid_response()
    # A new cumulative result must not ambiguously cross committed audio.
    # An older provisional draft is different: a newer final may revise its
    # word ends. Words beginning in the committed interval belong to that final;
    # only later draft words survive, still unconfirmed and replaceable.
    if not superseded_draft and any(
        word.start < boundary - _TIME_TOLERANCE and word.end > boundary + _TIME_TOLERANCE
        for word in result.words
    ):
        raise _invalid_response()
    words = tuple(word for word in result.words if word.start >= boundary - _TIME_TOLERANCE)
    return replace(result, start=boundary, text=" ".join(word.text for word in words), words=words)


class TranscriptNormalizer:
    """One ordered take, one pending draft, and an immutable final audio boundary.

    Identity comes from the audio timeline, not text: an actual repeated phrase
    in a later interval is retained. Provider events and words stay internal.
    """

    def __init__(self, session_id: str):
        if not isinstance(session_id, str) or not session_id.strip():
            raise ValueError("A nonblank transcription session ID is required.")
        self._session_id = session_id
        self._pending: _Draft | None = None
        self._next_order = 0
        self._final_end: float | None = None
        self._final_count = 0
        self._finished = False

    @property
    def final_count(self) -> int:
        return self._final_count

    def _segment(self, draft: _Draft, *, is_final: bool) -> TranscriptSegment:
        return {
            "type": "segment", "session_id": self._session_id,
            "segment_id": f"segment-{draft.order + 1}", "order": draft.order,
            "revision": draft.revision, "text": draft.result.text, "is_final": is_final,
        }

    def _interim(self, result: _Result) -> list[TranscriptSegment]:
        previous = self._pending
        if previous is not None:
            if result.end < previous.result.end - _TIME_TOLERANCE:
                return []  # An older interim must not replace a newer hypothesis.
            changed = result.text != previous.result.text
            self._pending = _Draft(result, previous.order, previous.revision + int(changed))
            return [self._segment(self._pending, is_final=False)] if changed else []
        if not result.text:
            return []
        self._pending = _Draft(result, self._next_order, 0)
        self._next_order += 1
        return [self._segment(self._pending, is_final=False)]

    def consume(self, event: dict) -> list[TranscriptSegment]:
        """Map one raw event to zero or more segments, without mutating input."""
        if self._finished:
            raise RuntimeError("This transcript has already completed.")
        if not isinstance(event, dict) or not isinstance(event.get("type"), str):
            raise _invalid_response()
        if event["type"] == "Error":
            code = event.get("code", event.get("err_code", ""))
            raise provider_stream_error(code if isinstance(code, str) else "")
        if event["type"] != "Results":
            return []  # Metadata, pause detection, and future non-result events.
        result = _read_result(event)
        if self._final_end is not None:
            if result.end <= self._final_end + _TIME_TOLERANCE:
                return []  # Replayed finals and late interims for finalized audio.
            result = _after(result, self._final_end)
        if not result.is_final:
            return self._interim(result)

        previous = self._pending
        suffix = None
        if previous is not None and previous.result.end > result.end + _TIME_TOLERANCE:
            # Final timestamps supersede the older draft's provisional word
            # ends. Keep the unconfirmed suffix, without rejecting a valid final.
            suffix = _after(previous.result, result.end, superseded_draft=True)
        segments = []
        if result.text:
            order = previous.order if previous else self._next_order
            revision = previous.revision + 1 if previous else 0
            segments.append(self._segment(_Draft(result, order, revision), is_final=True))
            if previous is None:
                self._next_order += 1
            self._final_count += 1
        elif previous is not None and previous.result.text:
            # An empty final retracts a guess; it is not a confirmed phrase.
            cleared = _Draft(replace(previous.result, text=""), previous.order, previous.revision + 1)
            segments.append(self._segment(cleared, is_final=False))
        self._pending = None
        self._final_end = result.end
        if suffix is not None:
            segments.extend(self._interim(suffix))
        return segments

    def complete(self) -> TranscriptComplete:
        """Call only after the provider event iterator has successfully exhausted.

        Remaining interim text stays unconfirmed for manual review. Metadata or
        speech_final alone must never promote it or finish the browser session.
        """
        self._finished = True
        outcome = "incomplete" if self._pending and self._pending.result.text else (
            "transcribed" if self._final_count else "no_speech"
        )
        return {"type": "complete", "session_id": self._session_id,
                "final_count": self._final_count, "outcome": outcome}


async def normalize_transcript_events(
    events: AsyncIterator[dict], *, session_id: str,
) -> AsyncIterator[TranscriptSegment | TranscriptComplete]:
    """Adapt provider events for the browser; errors/cancellation never emit complete.

    This is the one reader for stream.events(). The transport owns the provider
    connection; consume this concurrently with send_audio() and finish().
    """
    normalizer = TranscriptNormalizer(session_id)
    try:
        async for event in events:
            for segment in normalizer.consume(event):
                yield segment
        yield normalizer.complete()
    finally:
        close = getattr(events, "aclose", None)
        if close is not None:
            await close()
