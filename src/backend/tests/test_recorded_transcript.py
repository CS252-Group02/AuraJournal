import asyncio
import pytest

from app.services import (
    DeepgramConfigurationError, DeepgramInvalidAudioError, DeepgramInvalidResponseError,
    DeepgramRateLimitedError, DeepgramStreamingClient, DeepgramTimeoutError,
    DeepgramUnavailableError, collect_recorded_transcript, transcribe_audio,
)
from test_deepgram_service import FakeConnector, FakeSocket
from test_transcription import result, segment


def collect(*packets):
    closed = []

    async def source():
        try:
            for packet in packets:
                yield packet
        finally:
            closed.append(True)

    try:
        return asyncio.run(collect_recorded_transcript(source()))
    finally:
        assert closed == [True]


def complete(count=1, outcome="transcribed"):
    return {"type": "complete", "session_id": "take-1", "final_count": count, "outcome": outcome}


def test_collects_real_normalizer_revisions_and_keeps_repeated_phrases():
    socket = FakeSocket(final_events=[
        result("Hôm", end=1), result("Hôm nay.", final=True, end=1),
        result("I finished homework.", start=1, end=2, final=True),
        result("I finished homework.", start=2, end=3, final=True), {"type": "Metadata"},
    ])

    async def run():
        async def audio():
            yield b"container header"
            yield b"final audio chunk"

        return await collect_recorded_transcript(transcribe_audio(
            audio(), session_id="take-1", client=DeepgramStreamingClient("key", connector=FakeConnector(socket)),
        ))

    output = asyncio.run(run())
    assert output.transcript == "Hôm nay. I finished homework. I finished homework."
    assert output.outcome == "transcribed"
    assert socket.close_calls == 1
    assert "homework" not in repr(output)


def test_silence_has_no_transcript_and_retracted_drafts_stay_empty():
    output = collect(segment("Provisional"), segment("", revision=1), complete(0, "no_speech"))
    assert output.transcript == "" and output.outcome == "no_speech"


@pytest.mark.parametrize("packets", [
    (), (segment("Draft"),), (segment("Draft"), complete(0, "incomplete")),
    (segment("Draft"), complete(0, "no_speech")),
    (segment("Final", final=True), complete(0)),
    (segment("Final", final=True), complete(True)),
    (segment("Final", final=True), complete(1, "no_speech")),
    (complete(0),), ({"type": "complete", "outcome": []},),
    ({"type": "segment", "text": "Malformed"},), ({"type": "Metadata"},), (None,),
])
def test_incomplete_or_invalid_stream_never_returns_success(packets):
    with pytest.raises(DeepgramInvalidResponseError):
        collect(*packets)


@pytest.mark.parametrize("code,error", [
    ("not_configured", DeepgramConfigurationError), ("invalid_audio", DeepgramInvalidAudioError),
    ("invalid_response", DeepgramInvalidResponseError), ("timeout", DeepgramTimeoutError),
    ("rate_limited", DeepgramRateLimitedError), ("provider_unavailable", DeepgramUnavailableError),
    ("future_code", DeepgramUnavailableError), ([], DeepgramUnavailableError),
])
def test_error_types_are_preserved_without_copying_provider_details(code, error):
    with pytest.raises(error) as caught:
        collect({"type": "error", "code": code, "message": "private journal and secret key"})
    assert "private" not in str(caught.value) and "secret" not in str(caught.value)


def test_cancellation_closes_the_event_source_and_joins_its_cleanup():
    async def run():
        started, closed = asyncio.Event(), []

        async def source():
            try:
                started.set()
                await asyncio.Event().wait()
                yield
            finally:
                closed.append(True)

        task = asyncio.create_task(collect_recorded_transcript(source()))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert closed == [True]
        assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()]

    asyncio.run(run())
