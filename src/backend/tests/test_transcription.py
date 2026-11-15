import asyncio
from copy import deepcopy
import json

import pytest

from app.services import (
    DeepgramInvalidResponseError, DeepgramStreamingClient,
    DeepgramUnavailableError, TranscriptNormalizer, normalize_transcript_events,
)
from test_deepgram_service import FakeConnector, FakeSocket


def result(text, *, start=0, end=2, final=False, words=None, **extra):
    alternative = {"transcript": text, "confidence": 0.99}
    if words is not None:
        alternative["words"] = words
    return {
        "type": "Results", "channel_index": [0, 1], "start": start,
        "duration": end - start, "is_final": final,
        "channel": {"alternatives": [alternative]},
        "metadata": {"request_id": "provider-only"}, **extra,
    }


def word(text, start, end, punctuated=None):
    return {"word": text, "start": start, "end": end, "punctuated_word": punctuated or text}


def segment(text, *, order=0, revision=0, final=False):
    return {
        "type": "segment", "session_id": "take-1", "segment_id": f"segment-{order + 1}",
        "order": order, "revision": revision, "text": text, "is_final": final,
    }


def test_interim_updates_finalization_and_duplicate_packets():
    normalizer = TranscriptNormalizer("take-1")
    raw = result(" Hôm ", end=1)
    original = deepcopy(raw)
    assert normalizer.consume(raw) == [segment("Hôm")]
    assert raw == original  # Mapping must not mutate or forward private provider fields.
    assert normalizer.consume(result("Hôm nay", end=2)) == [segment("Hôm nay", revision=1)]
    assert normalizer.consume(result("Hôm nay", end=3)) == []
    assert normalizer.consume(result("old", end=1.5)) == []
    assert normalizer.consume(result("Hôm nay.", end=3, final=True, speech_final=False)) == [
        segment("Hôm nay.", revision=2, final=True),
    ]
    for late in (result("Hôm nay.", end=3, final=True), result("different", end=3, final=True),
                 result("late interim", end=2.5)):
        assert normalizer.consume(late) == []
    assert normalizer.complete() == {"type": "complete", "session_id": "take-1", "final_count": 1}


def test_real_repeated_phrases_are_kept():
    normalizer = TranscriptNormalizer("take-1")
    assert normalizer.consume(result("Đúng rồi.", final=True)) == [segment("Đúng rồi.", final=True)]
    assert normalizer.consume(result("Đúng rồi.", start=3, end=5, final=True, from_finalize=True)) == [
        segment("Đúng rồi.", order=1, final=True),
    ]
    assert normalizer.final_count == 2


@pytest.mark.parametrize("draft,final,expected", [
    (
        result("Hôm nay học rồi đọc sách.", end=5, words=[
            word("Hôm", 0, 0.5), word("nay", 0.6, 1), word("học", 1, 2),
            word("rồi", 3, 3.4), word("đọc", 3.5, 4), word("sách", 4, 5, "sách."),
        ]),
        result("Hôm nay học.", final=True),
        [segment("Hôm nay học.", revision=1, final=True), segment("rồi đọc sách.", order=1)],
    ),
    (
        result("Later event", start=3, end=5),
        result("Earlier event.", final=True),
        [segment("Earlier event.", revision=1, final=True), segment("Later event", order=1)],
    ),
])
def test_partial_final_preserves_remaining_interim(draft, final, expected):
    normalizer = TranscriptNormalizer("take-1")
    normalizer.consume(draft)
    assert normalizer.consume(final) == expected
    assert normalizer.consume(result("Later words.", start=2, end=6, final=True)) == [
        segment("Later words.", order=1, revision=1, final=True),
    ]
    assert normalizer.final_count == 2


def test_cumulative_overlap_uses_timestamps_instead_of_removing_repeated_text():
    normalizer = TranscriptNormalizer("take-1")
    normalizer.consume(result("Yes.", final=True))
    words = [word("yes", 0, 1, "Yes."), word("yes", 2, 3, "Yes."), word("again", 3, 4)]
    assert normalizer.consume(result("Yes. Yes. again", end=4, words=words)) == [
        segment("Yes. again", order=1),
    ]
    assert normalizer.consume(result("Yes. Yes. again", end=4, final=True, words=words)) == [
        segment("Yes. again", order=1, revision=1, final=True),
    ]


@pytest.mark.parametrize("words", [None, [word("ambiguous", 1.5, 2.5)]])
def test_ambiguous_overlap_is_rejected_without_changing_confirmed_text(words):
    normalizer = TranscriptNormalizer("take-1")
    normalizer.consume(result("Earlier.", final=True))
    with pytest.raises(DeepgramInvalidResponseError):
        normalizer.consume(result("private overlapping text", end=4, words=words))
    assert normalizer.final_count == 1


@pytest.mark.parametrize("text", ["  Hôm nay  I’m happy! 😀  ", "😀" * 5001])
def test_text_is_preserved_without_silent_truncation(text):
    assert TranscriptNormalizer("take-1").consume(result(text, final=True)) == [
        segment(text.strip(), final=True),
    ]


@pytest.mark.parametrize("raw", [
    None, result("private", start=-1), result("private", duration=float("nan")),
    result("private", is_final="true"), result("private", channel_index=[1, 2]),
    result("private", channel={"alternatives": []}),
    result("private", words=[word("private", 1, 0.5)]),
])
def test_invalid_results_have_safe_errors_and_leave_state_unchanged(raw):
    normalizer = TranscriptNormalizer("take-1")
    with pytest.raises(DeepgramInvalidResponseError) as caught:
        normalizer.consume(raw)
    assert "private" not in str(caught.value)
    assert normalizer.consume(result("valid", final=True)) == [segment("valid", final=True)]


@pytest.mark.parametrize("draft,retracted", [(None, False), ("Unconfirmed words", False), ("A guess", True)])
def test_silence_and_unconfirmed_text_are_not_counted_as_final(draft, retracted):
    normalizer = TranscriptNormalizer("take-1")
    assert normalizer.consume(result("")) == []
    if draft:
        normalizer.consume(result(draft))
    if retracted:
        assert normalizer.consume(result("", final=True)) == [segment("", revision=1)]
    for kind in ("Metadata", "UtteranceEnd", "SpeechStarted"):
        assert normalizer.consume({"type": kind}) == []
    assert normalizer.complete()["final_count"] == 0
    with pytest.raises(RuntimeError, match="already completed"):
        normalizer.consume(result("late final", final=True))


def test_adapter_integrates_with_a02_and_completes_after_final_results():
    socket = FakeSocket(final_events=[result("Hôm nay.", final=True), {"type": "Metadata"}])
    socket.incoming.put_nowait(json.dumps({"type": "Metadata", "phase": "early"}))
    socket.incoming.put_nowait(json.dumps(result("Hôm", end=1)))

    async def run():
        async with DeepgramStreamingClient("key", connector=FakeConnector(socket)).connect() as stream:
            emitted = []
            ready = asyncio.Event()

            async def receive():
                async for event in normalize_transcript_events(stream.events(), session_id="take-1"):
                    emitted.append(event)
                    ready.set()

            receiver = asyncio.create_task(receive())
            await ready.wait()
            assert emitted == [segment("Hôm")]
            await stream.finish()
            await receiver
        assert emitted == [segment("Hôm"), segment("Hôm nay.", revision=1, final=True),
                           {"type": "complete", "session_id": "take-1", "final_count": 1}]

    asyncio.run(run())


@pytest.mark.parametrize("invalid_result", [False, True])
def test_adapter_failure_closes_source_without_emitting_complete(invalid_result):
    emitted, source_closed = [], []

    async def source():
        try:
            yield result("Draft")
            if invalid_result:
                yield result("private", is_final="invalid")
            else:
                raise DeepgramUnavailableError("Speech service is unavailable.")
        finally:
            source_closed.append(True)

    async def run():
        expected = DeepgramInvalidResponseError if invalid_result else DeepgramUnavailableError
        with pytest.raises(expected):
            async for event in normalize_transcript_events(source(), session_id="take-1"):
                emitted.append(event)

    asyncio.run(run())
    assert emitted == [segment("Draft")]
    assert source_closed == [True]


