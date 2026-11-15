import asyncio
from contextlib import aclosing
import json

import pytest
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosedError, InvalidStatus
from websockets.frames import Close
from websockets.http11 import Response

from app.services import (
    DeepgramStreamingClient, DeepgramTimeoutError, normalize_transcript_events, transcribe_audio,
)
from test_deepgram_service import FakeConnector, FakeSocket
from test_transcription import result


async def audio(*chunks):
    for chunk in chunks:
        yield chunk


async def collect(socket, chunks=None, *, error=None, audio_timeout=8, **options):
    connector = FakeConnector(socket, error=error)
    client = DeepgramStreamingClient("key", connector=connector, **options)
    async with aclosing(transcribe_audio(
        chunks if chunks is not None else audio(b"container bytes"),
        session_id="take-1", client=client, audio_timeout=audio_timeout,
    )) as events:
        emitted = [event async for event in events]
    assert len(connector.calls) == 1  # Never replay audio or reconnect automatically.
    assert socket.close_calls == (0 if error else 1)
    return emitted


@pytest.mark.parametrize("text,final,outcome", [
    ("", True, "no_speech"), ("Draft", False, "incomplete"), ("Confirmed.", True, "transcribed"),
])
def test_completion_distinguishes_silence_unconfirmed_and_transcribed(text, final, outcome):
    socket = FakeSocket(final_events=[result(text, final=final), {"type": "Metadata"}])
    emitted = asyncio.run(collect(socket))
    assert emitted[-1] == {"type": "complete", "session_id": "take-1",
                           "final_count": int(bool(text) and final), "outcome": outcome}


@pytest.mark.parametrize("chunks", [(), (b"",), ("not binary",)])
def test_empty_or_invalid_audio_has_one_safe_terminal_error(chunks):
    emitted = asyncio.run(collect(FakeSocket(), audio(*chunks)))
    assert len(emitted) == 1 and emitted[0]["code"] == "invalid_audio"


@pytest.mark.parametrize("status,code", [(401, "not_configured"), (429, "rate_limited"),
                                       (500, "provider_unavailable"), (504, "timeout")])
def test_provider_handshake_errors_are_normalized_without_details_or_retries(status, code):
    error = InvalidStatus(Response(status, "private-key", Headers(), body=b"private journal"))
    chunks = audio(b"unconsumed")
    emitted = asyncio.run(collect(FakeSocket(), chunks, error=error))
    assert emitted[0]["code"] == code and "private" not in json.dumps(emitted)
    assert chunks.ag_frame is None


@pytest.mark.parametrize("provider_code,expected", [("DATA-0000", "invalid_audio"),
                                                  ("NET-0001", "timeout"), ("UNKNOWN", "provider_unavailable")])
def test_decode_and_network_failures_cancel_an_idle_audio_source(provider_code, expected):
    closed = []

    async def stalled_audio():
        try:
            yield b"header"
            await asyncio.Event().wait()
        finally:
            closed.append(True)

    socket = FakeSocket()
    frame = Close(1008 if provider_code.startswith("DATA") else 1011, provider_code + " private")
    socket.incoming.put_nowait(ConnectionClosedError(frame, None))
    emitted = asyncio.run(collect(socket, stalled_audio()))
    assert emitted[0]["code"] == expected and "private" not in json.dumps(emitted)
    assert closed == [True]


@pytest.mark.parametrize("phase", ["input", "send", "finish"])
def test_timeout_is_terminal_and_releases_resources(phase):
    socket = FakeSocket(final_events=[])

    async def stalled():
        await asyncio.Event().wait()
        yield b"never reached"

    async def stalled_send(message):
        await asyncio.Event().wait()

    options, chunks = {}, None
    if phase == "send":
        socket.send, options["send_timeout"] = stalled_send, 0.01
    elif phase == "finish":
        options["finish_timeout"] = 0.01
    else:
        chunks = stalled()
    emitted = asyncio.run(collect(socket, chunks, audio_timeout=0.01, **options))
    assert len(emitted) == 1 and emitted[0]["code"] == "timeout"


@pytest.mark.parametrize("cancel", [False, True])
def test_early_close_and_task_cancellation_emit_no_terminal_and_leave_no_tasks(cancel):
    socket, source_closed = FakeSocket(), []
    socket.incoming.put_nowait(json.dumps(result("Draft")))

    async def chunks():
        try:
            yield b"header"
            await asyncio.Event().wait()
        finally:
            source_closed.append(True)

    async def run():
        events = transcribe_audio(chunks(), session_id="take-1",
                                  client=DeepgramStreamingClient("key", connector=FakeConnector(socket)))
        assert (await anext(events))["type"] == "segment"
        if cancel:
            waiting = asyncio.create_task(anext(events))
            await asyncio.sleep(0)
            waiting.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiting
        await events.aclose()
        assert not [task for task in asyncio.all_tasks() if task is not asyncio.current_task() and not task.done()]

    asyncio.run(run())
    assert source_closed == [True] and socket.close_calls == 1


def test_error_serialization_never_uses_arbitrary_exception_text():
    event = DeepgramTimeoutError("private journal and credentials").to_event("take-1")
    assert event["type"] == "error" and event["code"] == "timeout"
    assert "private" not in json.dumps(event)


def test_bad_transcript_is_reported_as_invalid_response_without_completion():
    socket = FakeSocket(final_events=[result("private", is_final="invalid"), {"type": "Metadata"}])
    emitted = asyncio.run(collect(socket))
    assert len(emitted) == 1 and emitted[0]["code"] == "invalid_response"


def test_explicit_transport_close_cannot_be_mistaken_for_successful_completion():
    socket = FakeSocket()

    async def run():
        async with DeepgramStreamingClient("key", connector=FakeConnector(socket)).connect() as stream:
            events = normalize_transcript_events(stream.events(), session_id="take-1")
            reader = asyncio.create_task(anext(events))
            await asyncio.sleep(0)
            await stream.aclose()
            with pytest.raises(asyncio.CancelledError):
                await reader
            await events.aclose()

    asyncio.run(run())
    assert socket.close_calls == 1


def test_concurrent_close_waits_for_shared_cleanup_even_if_one_waiter_is_cancelled():
    socket = FakeSocket()

    async def run():
        started, release = asyncio.Event(), asyncio.Event()
        original_close = socket.close

        async def slow_close():
            started.set()
            await release.wait()
            await original_close()

        socket.close = slow_close
        async with DeepgramStreamingClient("key", connector=FakeConnector(socket)).connect() as stream:
            first = asyncio.create_task(stream.aclose())
            await started.wait()
            first.cancel()
            with pytest.raises(asyncio.CancelledError):
                await first
            second = asyncio.create_task(stream.aclose())
            await asyncio.sleep(0)
            assert not second.done()
            release.set()
            await second

    asyncio.run(run())
    assert socket.close_calls == 1
