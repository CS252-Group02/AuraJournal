# Deepgram streaming service — Week 7 A02

A02 provides a reusable asynchronous Python service for streaming audio to
Deepgram. It opens one provider WebSocket per take, sends original audio bytes,
yields provider JSON events as they arrive, and releases the connection on
completion, errors, or cancellation. It does not read or write the database,
save audio, open a microphone, or automatically retry a billable connection.

This is the transport for the agreed live-transcript direction. The existing
`external_api_tests/deepgram/test.py` remains an older file-transcription
experiment; the application service does not import or execute it.

## Configuration and supported input

Install the backend requirements, including `websockets>=15,<16`. Set
`DEEPGRAM_API_KEY` in your backend environment or local `.env`; never put a real
key in source, a frontend variable, or a URL. The normal backend launcher loads
`.env`. A standalone caller must export the variable or load that file itself.
Missing credentials do not break app startup; they fail when opening a stream.

The initial input contract is `audio/webm;codecs=opus`, matching the first MIME
candidate in the existing browser recorder. Chunks must come from one continuous
recording in their original order, including its container header and final
chunk. Do not send each chunk as an independent file, change its extension, or
claim that WebM is raw PCM. Other formats are rejected before connecting.

The provider URL uses `model=nova-3`, `language=multi`, hints `vi` and `en`,
`interim_results=true`, and `endpointing=300`. These hints prioritize Vietnamese
and English without restricting recognition to those languages. Containerized
audio does not set `encoding` or `sample_rate`. See Deepgram's official
[language configuration](https://developers.deepgram.com/docs/nova-3-language-prompting),
[container format guidance](https://developers.deepgram.com/docs/determining-your-audio-format-for-live-streaming-audio),
and [interim-results documentation](https://developers.deepgram.com/docs/understand-endpointing-interim-results).

## Service interface

Import `DeepgramStreamingClient` from `app.services` or `app.services.deepgram`.
The client is a reusable factory; each `async with client.connect()` creates an
independent stream. An optional connector can be injected for offline tests.

| Method | Behavior |
| --- | --- |
| `client.connect(mime_type="audio/webm;codecs=opus")` | Async context manager; authenticates to Deepgram with the backend key. |
| `stream.send_audio(chunk)` | Sends nonempty `bytes` unchanged. Calls must follow source order. |
| `stream.events()` | One async iterator per take; yields raw provider JSON objects, including `Results` and terminal `Metadata`. |
| `stream.finish()` | Sends `CloseStream` once and waits for the concurrent reader to consume terminal metadata. No further audio is accepted. |
| `stream.aclose()` | Idempotent cleanup/abort; also called automatically when leaving the context. |

**Consume events concurrently with sending audio and calling `finish()`.**
`finish()` deliberately waits for the reader; it is not a replacement for reading
the final transcript. A second reader is rejected. The caller must cancel and
await its receiver task when its own producer fails or the take is abandoned.

Integration pattern (Python 3.10+, not an automatically executed live test):

```python
import asyncio

from app.services import DeepgramStreamingClient


async def transcribe(audio_chunks, handle_event):
    async with DeepgramStreamingClient().connect() as stream:
        async def receive():
            async for event in stream.events():
                await handle_event(event)  # Internal handler; do not log private text.

        async def send():
            async for chunk in audio_chunks:
                await stream.send_audio(chunk)
            await stream.finish()

        tasks = [asyncio.create_task(send()), asyncio.create_task(receive())]
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
```

Keep the event handler responsive. In B06, supervise producer and receiver so
failure in either immediately cancels the other, including when the browser is
idle. Do not use a slow producer that cannot be cancelled.

Provider [`CloseStream`](https://developers.deepgram.com/docs/close-stream)
flushes remaining audio, sends final results and metadata, and shuts down the
provider connection. The service waits for the metadata consumed by `events()`;
sending the command alone is not a successful completion. An early provider
disconnect is a failure, even with a normal WebSocket close code. Empty transcript
events remain raw events; deciding the application's no-speech outcome is A04.

Defaults are 10 seconds to open/send, 12 seconds for the whole finish operation
(including sending the command), and a bounded close handshake. The provider receive queue holds at most 16
frames, with a 1 MiB message limit. There is no ordinary read timeout while
recording because silence may produce no results. The caller owns recording
duration, audio-size limits, idle policy, and authentication.

## Errors and remaining tasks

All service errors derive from `DeepgramError` and use fixed messages without
provider bodies, credentials, or submitted audio:

- `DeepgramConfigurationError`: missing/invalid key or rejected credentials.
- `DeepgramUnavailableError`: connection/provider failure or incomplete stream.
- `DeepgramInvalidResponseError`: invalid provider JSON/envelope.
- `DeepgramTimeoutError`: opening, sending, or finishing exceeded its deadline.

Invalid method arguments raise `ValueError`; invalid lifecycle operations raise
`RuntimeError`. Cancellation propagates so callers can stop work. Raw events are
private internal data; errors are sanitized, but successful event contents must
not be forwarded wholesale to the browser or logged.

This completes the A02 service implementation, with basic transport safeguards:

- **A03:** map raw events to `segment_id`, `order`, `revision`, `text`, `is_final`;
  preserve final segments and replace interim revisions without duplication.
- **A04:** finalize application policy for silence, bad audio, retries, and errors.
- **A05:** record live Vietnamese/English evaluation and actual browser behavior.
- **B06–B07:** add the authenticated browser WebSocket, Origin checks, limits,
  protocol validation, cancellation, and frontend event mapping.

No browser transcription endpoint is added or enabled by A02. The frontend's
current fixed `language: "vi"` and proposed protocol still need the later
integration changes before setting `VITE_RECORD_TRANSCRIPTION_PATH`.

## Offline verification

From `src/backend`, with the virtual environment active:

```sh
python -m pytest tests/test_deepgram_service.py tests/test_http_isolation.py -q
```

These tests inject a fake provider, need neither PostgreSQL nor a real API key,
and make no paid calls. The shared test fixture blocks real HTTP and WebSocket
provider connections. They verify provider configuration, binary order, concurrent
receive/finalization, failures, timeout, cancellation, and independent takes.
They do not establish live recognition quality or A05 completion.
