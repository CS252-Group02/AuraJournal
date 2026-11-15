"""Supervise one cancellable take from an authenticated audio source."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
import math

from app.services.deepgram import (
    DeepgramError, DeepgramInvalidAudioError, DeepgramStreamingClient, DeepgramTimeoutError,
)
from app.services.transcription import TranscriptNormalizer, normalize_transcript_events


async def transcribe_audio(
    audio_chunks: AsyncIterator[bytes], *, session_id: str,
    client: DeepgramStreamingClient | None = None, audio_timeout: float = 8,
    on_connected: Callable[[], Awaitable[None]] | None = None,
) -> AsyncIterator[dict]:
    """Yield segments then one complete/error; cancellation emits neither.

    Use contextlib.aclosing() when consuming so early exit also cancels the take.
    Audio inactivity is not silence: silent audio chunks may keep arriving with
    no transcript. No automatic retry, audio storage, or browser endpoint here.
    """
    TranscriptNormalizer(session_id)  # Reject programmer errors before connecting.
    if not math.isfinite(audio_timeout) or audio_timeout <= 0:
        raise ValueError("Audio timeout must be positive and finite.")
    queue = asyncio.Queue(maxsize=16)

    async def run():
        try:
            async with (client or DeepgramStreamingClient()).connect() as stream:
                if on_connected is not None:
                    await on_connected()
                async def send():
                    received_audio = False
                    while True:
                        try:
                            chunk = await asyncio.wait_for(anext(audio_chunks), audio_timeout)
                        except StopAsyncIteration:
                            break
                        except (TimeoutError, asyncio.TimeoutError):
                            raise DeepgramTimeoutError("Audio input timed out.") from None
                        await stream.send_audio(chunk)
                        received_audio = True
                    if not received_audio:
                        raise DeepgramInvalidAudioError("No audio was received.")
                    await stream.finish()

                async def receive():
                    async for event in normalize_transcript_events(stream.events(), session_id=session_id):
                        if event["type"] == "complete":
                            return event
                        await queue.put(event)

                tasks = [asyncio.create_task(send()), asyncio.create_task(receive())]
                try:
                    await asyncio.gather(*tasks)
                    completion = tasks[1].result()
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        except DeepgramError as error:
            completion = error.to_event(session_id)
        finally:
            close = getattr(audio_chunks, "aclose", None)
            if close is not None:
                await close()
        # Release both tasks, the source, and the provider before reporting an outcome.
        await queue.put(completion)

    worker = asyncio.create_task(run())
    pending = None
    try:
        while True:
            pending = asyncio.create_task(queue.get())
            done, _ = await asyncio.wait((pending, worker), return_when=asyncio.FIRST_COMPLETED)
            if worker in done:
                worker.result()  # Surface unexpected failures; never hang on an empty queue.
            event = await pending
            yield event
            if event["type"] in {"complete", "error"}:
                return
    finally:
        worker.cancel()
        if pending is not None:
            pending.cancel()
        await asyncio.gather(worker, *([pending] if pending else []), return_exceptions=True)
