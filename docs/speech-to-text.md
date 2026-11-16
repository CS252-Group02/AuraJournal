# Deepgram streaming

The transport provides a reusable asynchronous Python service for streaming audio to
Deepgram. It opens one provider WebSocket per take, sends original audio bytes,
yields provider JSON events as they arrive, and releases the connection on
completion, errors, or cancellation. It does not read or write the database,
save audio, open a microphone, or automatically retry a billable connection.

Per-take transcript normalization supports the existing Record frontend:
interim revisions, immutable final segments, and a completion count. It consumes
raw provider events without changing the transport.

The `transcribe_audio()` helper supervises sending/receiving, distinguishes
no-speech and incomplete results, returns safe error envelopes, and cleans up on
failure, cancellation, or early consumer exit.

The authenticated browser WebSocket is available at `/api/transcriptions/live`.
It bridges the existing Record protocol to these services. The application still does
not upload/persist audio or save a journal automatically.

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
| `transcribe_audio(audio_chunks, session_id=..., on_connected=...)` | Yields segments then one complete/error, owns cleanup, and optionally notifies the caller after the provider connection opens. |
| `client.connect(mime_type="audio/webm;codecs=opus")` | Async context manager; authenticates to Deepgram with the backend key. |
| `stream.send_audio(chunk)` | Sends nonempty `bytes` unchanged. Calls must follow source order. |
| `stream.events()` | One async iterator per take; yields raw provider JSON objects, including `Results` and terminal `Metadata`. |
| `stream.finish()` | Sends `CloseStream` once and waits for the concurrent reader to consume terminal metadata. No further audio is accepted. |
| `stream.aclose()` | Idempotent cleanup/abort; also called automatically when leaving the context. |

**When using the lower-level transport interface, consume events concurrently with sending audio and calling `finish()`.**
`finish()` deliberately waits for the reader; it is not a replacement for reading
the final transcript. A second reader is rejected. The caller must cancel and
await its receiver task when its own producer fails or the take is abandoned.

Integration pattern (Python 3.10+, not an automatically executed live test):

```python
from contextlib import aclosing

from app.services import transcribe_audio


async def transcribe(audio_chunks, handle_event):
    async with aclosing(transcribe_audio(
        audio_chunks, session_id="one-server-generated-id-per-take",
    )) as events:
        async for event in events:
            await handle_event(event)  # Only segment, complete, or safe error events.
```

Use an async iterator of binary chunks and a unique server-generated session ID.
Keep the event handler responsive and the source cancellable. The helper owns a
bounded 16-event queue; it cancels and awaits both tasks when either fails,
closes the input iterator if supported, and exits the provider context. The WebSocket endpoint
owns browser authentication and browser disconnect/Reset handling.

Provider [`CloseStream`](https://developers.deepgram.com/docs/close-stream)
flushes remaining audio, sends final results and metadata, and shuts down the
provider connection. The service waits for the metadata consumed by `events()`;
sending the command alone is not a successful completion. An early provider
disconnect is a failure, even with a normal WebSocket close code. An intentional
transport close propagates cancellation rather than masquerading as a normal
source end; it can never make the normalizer emit a false `complete`.

Defaults are 10 seconds to open/send, 12 seconds for the whole finish operation
(including sending the command), and a bounded close handshake. The provider receive queue holds at most 16
frames, with a 1 MiB message limit. There is no ordinary read timeout while
recording because silence may produce no results. The session helper separately allows 8 seconds
to receive the next audio chunk (configurable with `audio_timeout`). Silent audio
chunks still count as activity; this is not an 8-second speech-recognition limit.
The WebSocket endpoint owns recording duration, audio-size limits, and authentication.

## Transcript normalization

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
After the provider's raw iterator successfully exhausts, the adapter emits:

```json
{"type": "complete", "session_id": "take-1", "final_count": 1, "outcome": "transcribed"}
```

The count is the number of nonempty final segments sent to the browser, matching
`transcriptState.js`. Metadata alone does not emit `complete`; the adapter waits
for a successful transport end. Source errors, invalid results, cancellation, or early
closure never produce a successful completion event. Unconfirmed text at the end
remains interim so the existing frontend can flag it for review.

The additive `outcome` field distinguishes `transcribed` (one or more finals and
no pending text), `no_speech` (successful processing without any final or pending
text), and `incomplete` (text remains unconfirmed, with or without final segments).
It does not alter `final_count` or promote uncertain text. Existing frontend
merging still works; the frontend can use the outcome for more specific user messages.

For isolated reducers, `TranscriptNormalizer.consume(event)` returns a list of
zero or more `segment` dictionaries, `.final_count` exposes the count, and
`.complete()` returns the final envelope. Call `.complete()` only after a known
successful source end; it is idempotent and prevents later `.consume()` calls.
Do not reuse a normalizer across accounts or recording takes.

## Safe errors and cancellation

`transcribe_audio()` yields exactly one terminal `complete` or `error` event for
an ordinary completed/failed take. Cancellation propagates as `CancelledError`;
explicit `aclose()` emits no terminal event. Use `aclosing()` as above so leaving
an `async for` loop early also cancels/awaits its worker and releases resources.
Already emitted segments remain usable for manual review; no automatic retry or
database write occurs after failure or cancellation.

All expected service errors derive from `DeepgramError`. Its `to_event(session_id)`
method returns only a fixed public message and code, never arbitrary exception
text, provider bodies, credentials, close reasons, or submitted audio:

| Code | Error class / situation |
| --- | --- |
| `invalid_audio` | `DeepgramInvalidAudioError`: no chunks, empty/nonbinary chunks, unsupported MIME, or provider `DATA-0000` decode failure. |
| `not_configured` | `DeepgramConfigurationError`: missing/invalid key, or handshake 400/401/403. |
| `rate_limited` | `DeepgramRateLimitedError`: provider handshake 429; no automatic retry. |
| `timeout` | `DeepgramTimeoutError`: input/open/send/finish deadline, handshake 408/504, or provider `NET-0000/0001/0002`. |
| `invalid_response` | `DeepgramInvalidResponseError`: invalid JSON, transcript shape, or unmappable overlapping timestamps. |
| `provider_unavailable` | `DeepgramUnavailableError`: other provider/connection failures or early provider close. |

For example: `{"type":"error","session_id":"take-1","code":"invalid_audio","message":"Audio is empty, unsupported, or could not be decoded. Please record again."}`.
The endpoint checks the initial EBML/WebM signature, buffering a split prefix
without changing chunk order. A missing, truncated, or mismatching prefix is
`invalid_audio`; no mismatching prefix is forwarded to Deepgram. This signature
is an initial container-family check, not proof of a valid WebM/Opus track. Full
codec/content decoding remains with Deepgram, and later chunks are not expected
to contain independent file headers. See
[Deepgram's decode/network errors](https://developers.deepgram.com/docs/stt-troubleshooting-websocket-data-and-net-errors).

An empty recording is `invalid_audio`, while a valid stream with no recognized
speech is `no_speech`; no provider error or timeout is classified as silence.
During quiet recording continue sending actual audio chunks. If chunks stop for
the input timeout, the session fails rather than being kept alive indefinitely.
Opening, sending, finishing, and the close handshake are bounded. Concurrent
closes share one shielded cleanup task; a failed close handshake aborts the TCP
transport when available.

Invalid programmer arguments still raise `ValueError`; invalid lifecycle calls
raise `RuntimeError`. These are not silently reclassified as provider failures.
Raw provider events are private internal data and must not be forwarded wholesale
to the browser or logged.

## Outstanding verification

- Record live Vietnamese/English evaluation and actual browser behavior.

The frontend path remains disabled by default; enable it deliberately as below.

## Browser WebSocket

Set the backend `DEEPGRAM_API_KEY` and set this in your frontend `.env.local`:

```dotenv
VITE_RECORD_TRANSCRIPTION_PATH=/api/transcriptions/live
```

Restart the frontend after changing Vite environment variables. Keep
`VITE_API_URL=http://localhost:8000` and the configured `FRONTEND_ORIGIN` consistent
with the browser address. Use `ws://` locally and `wss://` behind HTTPS. The normal
frontend adapter derives the WebSocket scheme from `VITE_API_URL`.

The browser must already be logged in. Its existing session cookie is sent to
the `/api/` path. The backend requires an exact configured `Origin`; missing or
foreign origins, missing/expired/revoked sessions, and disabled accounts are
rejected before accepting the connection or accessing Deepgram. It does not
accept credentials in query parameters or client-selected user IDs. WebSockets
use this cookie/Origin check rather than the HTTP JSON/CSRF-header dependency;
HTTP endpoints retain their existing checks. CORS alone does not authenticate a
WebSocket. See [FastAPI WebSockets](https://fastapi.tiangolo.com/advanced/websockets/).

Session checks use short DB sessions in a thread pool, never a database connection
held through recording. The session is checked before acceptance, before provider
access, before successful completion, and every 30 seconds while connected (or
at expiry if sooner). Revocation during a live take stops it on the next check
with `auth_expired`; the existing frontend treats this as requiring login.

Protocol sequence, with one server-generated ID for each connection:

1. Backend sends `{"type":"ready","session_id":"...","accepted_mime_types":["audio/webm;codecs=opus"]}`.
2. Frontend sends `{"type":"start","session_id":"...","mime_type":"audio/webm;codecs=opus","language":"multi"}`.
3. Backend opens Deepgram and sends `{"type":"started","session_id":"..."}` only after it is ready.
4. Frontend sends ordered binary audio chunks; backend sends normalized `segment` messages as results arrive.
5. After sending the recorder's final chunk, frontend sends `{"type":"finish","session_id":"..."}`.
6. Backend flushes Deepgram, sends final segments and `complete`, then closes normally.

The current frontend's fixed `language: "vi"` is also accepted as a compatibility
alias for the same agreed Vietnamese/English multilingual configuration; it does
not switch the provider to Vietnamese-only. No frontend code change is required
to begin integration. Proofreading and idempotent saving remain separate
contracts: leave their optional settings disabled until implemented.

Only the documented string fields are accepted in start/finish controls. Invalid
JSON, duplicate keys, non-finite numbers, deeply nested payloads, and non-string
values are rejected without echoing input or parser errors. Audio before
`started`, extra start/finish fields, a different session ID, a duplicate start,
or messages after finish are invalid. The initial permission/start window is 60
seconds, allowing time to answer the microphone prompt; the provider handshake
uses an 8-second timeout within the frontend's 10-second start deadline.

The endpoint enforces 1 MiB per binary chunk, 10 MiB total audio, 5 minutes after a valid
start, and 4 KiB per control message measured as UTF-8 bytes. Empty binary chunks
are rejected. A fixed one-second window allows at most 64 audio/finish messages
after start, accommodating the recorder's normal four chunks per second and its
startup buffer while bounding tiny-message floods. The session helper's 8-second
input timeout still applies while waiting for each validated chunk, including a
complete initial signature. Limits produce `limit_exceeded`;
malformed controls produce `invalid_request`. Unsupported MIME produces
`invalid_audio`. Failed session revalidation produces `auth_expired` or
`database_unavailable`, with no DB/provider details exposed.

Normal completion closes with 1000. Invalid controls/audio/session state close
with 1008; provider, database, and response-timeout failures close with 1011 after
the safe error event. Sending a browser response has a 5-second deadline; closing
the browser socket has a 2-second deadline, so a slow client cannot hold cleanup
indefinitely.
Rejected upgrades may appear as a failed handshake rather than an accessible HTTP
status in the browser. The current adapter probes `/api/auth/me` to distinguish
expired authentication from ordinary connection failure.

Closing/resetting the browser connection cancels provider opening, recording, or
final-result waiting. The endpoint keeps a disconnect observer during the
handshake and after finish, hands off the sole browser reader safely, and awaits
all service/watch tasks during cleanup. It does not reconnect or retry audio.

### Server transport limits

The normal backend launcher selects Uvicorn's `websockets` transport with a 1 MiB
message limit, a four-message receive queue, and per-message compression disabled.
This bounds buffering before the application receives a message; application
checks alone cannot prevent a server's default larger receive buffer.

For a direct launch from `src/backend`, use the same options:

```sh
python -m uvicorn app.main:app --env-file ../../.env --ws websockets --ws-max-size 1048576 --ws-max-queue 4 --ws-per-message-deflate false
```

Transport-level oversized messages close with 1009 before the endpoint can send
a JSON error. Other application validation failures send the documented safe
error envelope before closing. These per-connection limits do not impose a
cross-worker account quota or global provider concurrency limit.

## Offline verification

From `src/backend`, with the virtual environment active:

```sh
python -m pytest tests/test_transcription_validation.py tests/test_transcriptions_api.py tests/test_transcription_session.py tests/test_transcription.py tests/test_deepgram_service.py tests/test_http_isolation.py -q
```

These tests inject a fake provider, need neither PostgreSQL nor a real API key,
and make no paid calls. The shared test fixture blocks real HTTP and WebSocket
provider connections. They verify provider configuration, binary order, concurrent
receive/finalization, failures, timeout, cancellation, and independent takes.
Normalization tests also cover revisions, duplicate provider packets versus real
repeated phrases, partial finals, cumulative overlaps, retracted guesses, Unicode,
malformed responses, and transport-to-normalizer completion/error behavior.
Session tests cover silence versus empty audio, safe error codes, idle
input cancellation, timeout, task/iterator cancellation, and absence of leaked tasks.
Endpoint tests exercise the actual FastAPI WebSocket route and shared session lookup
rules with in-memory session rows and a fake provider. They check negotiation,
binary order, final completion, rejected cookies/origins, revocation, malformed
starts, size limits, and disconnects during opening/recording/final flush. These
do not replace real PostgreSQL authentication or browser/microphone verification.
They do not establish live recognition quality.

Validation tests cover malformed controls, duplicate JSON keys, oversized UTF-8
controls, empty/wrong/truncated audio headers, header splits, exact byte limits,
message floods, wrong protocol phases, deadlines, slow replies, and safe database
failures. The Uvicorn transport was also checked on loopback with a message over
1 MiB; it closed with 1009 without opening a provider connection.
