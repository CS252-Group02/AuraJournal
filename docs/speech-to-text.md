# Deepgram streaming and transcript mapping — Week 7 A02–A03

A02 provides a reusable asynchronous Python service for streaming audio to
Deepgram. It opens one provider WebSocket per take, sends original audio bytes,
yields provider JSON events as they arrive, and releases the connection on
completion, errors, or cancellation. It does not read or write the database,
save audio, open a microphone, or automatically retry a billable connection.

A03 adds per-take transcript normalization for the existing Record frontend:
interim revisions, immutable final segments, and a completion count. It consumes
A02's raw events without changing the provider transport or enabling an endpoint.

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

from app.services import DeepgramStreamingClient, normalize_transcript_events


async def transcribe(audio_chunks, handle_event):
    async with DeepgramStreamingClient().connect() as stream:
        async def receive():
            async for event in normalize_transcript_events(
                stream.events(), session_id="one-server-generated-id-per-take",
            ):
                await handle_event(event)  # Only normalized segment/complete events.

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

## Transcript normalization (A03)

`normalize_transcript_events(stream.events(), session_id=...)` is the normal
integration entry point. It replaces the raw reader in the example above and
yields JSON-serializable dictionaries matching the existing frontend:

```json
{
  "type": "segment",
  "session_id": "take-1",
  "segment_id": "segment-1",
  "order": 0,
  "revision": 1,
  "text": "Hôm nay tôi đi học.",
  "is_final": true
}
```

Each take has its own `TranscriptNormalizer`. Orders and revisions start at zero;
an interim update keeps its segment ID/order and increases the revision when its
text changes. A final update increases the revision even if the text is unchanged.
Duplicate interim text may update internal timing information without another
browser event. Only approved fields are emitted; provider metadata, confidence,
word timestamps, alternative transcripts, and request IDs stay internal.

Normalization follows the ordered audio timeline on one channel
(`channel_index: [0, 1]`). Final intervals cannot be revised. Replayed final
packets and late interims for finalized audio are ignored. The same phrase spoken
again later remains a separate final segment; matching text alone is never used
to remove repetition. `speech_final` detects a pause, not session completion.
See Deepgram's [interim/final timeline examples](https://developers.deepgram.com/docs/understand-endpointing-interim-results).

When a long interim is finalized in shorter pieces, word timestamps preserve the
remaining unconfirmed suffix in a new segment. Cumulative results overlapping
finalized audio are trimmed using the same timestamps, with a 1 ms tolerance for
boundary rounding. Full provider transcripts retain their punctuation, Unicode,
and internal whitespace (only outer whitespace is stripped); a trimmed suffix
uses space-joined `punctuated_word` values, falling back to `word`.

An overlap with missing word timings or a word crossing a final boundary cannot
be safely guessed: it raises `DeepgramInvalidResponseError` and leaves existing
normalizer state intact. The later endpoint must report failure and preserve the
user's already displayed text for manual review. No LLM correction is performed.

An empty final retracts any corresponding interim guess rather than counting it
as a spoken phrase. A silence-only take therefore completes with `final_count: 0`.
After A02's raw iterator successfully exhausts, the adapter emits:

```json
{"type": "complete", "session_id": "take-1", "final_count": 1}
```

The count is the number of nonempty final segments sent to the browser, matching
`transcriptState.js`. Metadata alone does not emit `complete`; the adapter waits
for A02's successful end. Source errors, invalid results, cancellation, or early
closure never produce a successful completion event. Unconfirmed text at the end
remains interim so the existing frontend can flag it for review.

For isolated reducers, `TranscriptNormalizer.consume(event)` returns a list of
zero or more `segment` dictionaries, `.final_count` exposes the count, and
`.complete()` returns the final envelope. Call `.complete()` only after a known
successful source end; it is idempotent and prevents later `.consume()` calls.
Do not reuse a normalizer across accounts or recording takes.

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

The A02 transport and A03 normalization are implemented, with basic safeguards:

- **A04:** finalize application policy for silence, bad audio, retries, and errors.
- **A05:** record live Vietnamese/English evaluation and actual browser behavior.
- **B06–B07:** add the authenticated browser WebSocket, Origin checks, limits,
  protocol validation, cancellation, and integration with the A03 adapter.

No browser transcription endpoint is added or enabled by A02–A03. The frontend's
current fixed `language: "vi"` and proposed protocol still need the later
integration changes before setting `VITE_RECORD_TRANSCRIPTION_PATH`.

## Offline verification

From `src/backend`, with the virtual environment active:

```sh
python -m pytest tests/test_transcription.py tests/test_deepgram_service.py tests/test_http_isolation.py -q
```

These tests inject a fake provider, need neither PostgreSQL nor a real API key,
and make no paid calls. The shared test fixture blocks real HTTP and WebSocket
provider connections. They verify provider configuration, binary order, concurrent
receive/finalization, failures, timeout, cancellation, and independent takes.
Normalization tests also cover revisions, duplicate provider packets versus real
repeated phrases, partial finals, cumulative overlaps, retracted guesses, Unicode,
malformed responses, and A02-to-A03 completion/error behavior.
They do not establish live recognition quality or A05 completion.
