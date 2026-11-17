# Browser-recording transcription

The recording service reuses the existing Deepgram transport, transcript normalizer
and session helper. The HTTP endpoint exposes `POST /api/transcriptions` with the same raw
WebM/Opus request and `{transcript, outcome}` response. No database migration,
new dependency, frontend change or separate speech provider is needed.

## Reusable helper contract

```python
from app.services import collect_recorded_transcript, transcribe_audio

async def recording_chunks():
    # Ordered bytes from ONE continuous WebM/Opus recording, including its header
    # and final chunk. A silent recording still contains nonempty audio bytes.
    yield first_chunk
    yield last_chunk

result = await collect_recorded_transcript(
    transcribe_audio(recording_chunks(), session_id="unique-recording-id")
)
# result.transcript: str
# result.outcome: "transcribed" | "no_speech"
```

`transcribe_audio()` remains the streaming interface used by WebSocket callers.
`collect_recorded_transcript()` is its final-only adapter for completed recordings;
the HTTP upload endpoint now uses this same adapter. It owns and closes the
event generator on success, error and cancellation. It retains real repeated
phrases, uses only finalized segments and rejects incomplete/missing completion,
inconsistent final counts and unresolved drafts. Transcript text is excluded
from the result object's `repr()`.

The collector raises existing `DeepgramError` subclasses. Callers can use
`error.code`: `invalid_audio`, `not_configured`, `invalid_response`, `timeout`,
`rate_limited`, or `provider_unavailable`. Raw provider messages are never copied
into those errors. The upload endpoint keeps its existing HTTP status mapping, limits, session
checks and cancellation behavior. See [HTTP upload](audio-upload.md).

The Deepgram transport also rejects ambiguous/invalid JSON responses: duplicate
fields, non-finite JSON constants and excessive nesting become
`invalid_response` and release the connection.

## Audio and language behavior

Use `audio/webm;codecs=opus` only when
`MediaRecorder.isTypeSupported('audio/webm;codecs=opus')` succeeds. MP4, WAV and
Ogg are not supported by this browser-upload contract; renaming files or changing
their MIME does not convert them. A WebM header is only a preliminary check;
Deepgram must still decode the complete recording.

The existing provider configuration stays `model=nova-3`, `language=multi`, with
`language_hint=vi` and `language_hint=en`. Hints favor those languages rather
than restricting recognition to them. The live protocol's legacy `language: vi`
alias still selects this same multilingual configuration. See the official
[Nova-3 language prompting](https://developers.deepgram.com/docs/nova-3-language-prompting)
and [streaming errors](https://developers.deepgram.com/docs/stt-troubleshooting-websocket-data-and-net-errors)
references. No automatic reconnect or billable retry is added.

## Offline regression

From `src/backend` with the backend environment active:

```sh
python -m pytest tests/test_recorded_transcript.py tests/test_verify_transcription.py tests/test_deepgram_service.py tests/test_transcription.py tests/test_transcription_session.py tests/test_transcription_upload.py tests/test_transcriptions_api.py tests/test_transcription_validation.py tests/test_http_isolation.py -q
```

These suites block external HTTP/WebSocket calls and use a fake provider. They
do not require a real key or PostgreSQL. Database-backed authentication tests in
`test_transcription_upload_auth.py` additionally need a disposable
`TEST_DATABASE_URL` as described in the repository README.

## Real-provider check using browser exports

Export short fictional recordings from a browser supporting WebM/Opus. This
console example records ten seconds from the microphone and downloads the exact
MediaRecorder Blob; run it on the local frontend and answer the browser's
microphone prompt. It does not upload or save a journal:

```javascript
const mimeType = 'audio/webm;codecs=opus';
if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('WebM/Opus unavailable');
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
try {
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType });
  const stopped = new Promise((resolve, reject) => {
    recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
    recorder.onstop = resolve;
    recorder.onerror = reject;
  });
  recorder.start(250);
  setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 10000);
  await stopped;
  const url = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'recording.webm';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
} finally {
  stream.getTracks().forEach(track => track.stop());
}
```

Use this matrix; keep the words in a UTF-8 reference file for each speech sample:

| Sample | Fictional content | Expected result |
| --- | --- | --- |
| Vietnamese | Hôm nay tôi hoàn thành bài tập nhóm. Ngày mai tôi sẽ đến thư viện. | `transcribed`, with the main Vietnamese phrases preserved |
| English | Today I finished my assignment. Tomorrow I will visit the library. | `transcribed`, with both sentences represented |
| Mixed | Hôm nay tôi học ở thư viện. Tomorrow I will finish my project. | `transcribed`, preserving the language switch |
| Silence | Record without speaking in a quiet environment | `no_speech`, empty transcript |

Set `DEEPGRAM_API_KEY` in the process environment or the root `.env`. From
`src/backend`, explicitly run one live request per exported file:

```sh
python scripts/verify_transcription.py recording-vi.webm --reference reference-vi.txt --output report-vi.json
python scripts/verify_transcription.py recording-en.webm --reference reference-en.txt --output report-en.json
python scripts/verify_transcription.py recording-mixed.webm --reference reference-mixed.txt --output report-mixed.json
python scripts/verify_transcription.py recording-silence.webm --expect no_speech --output report-silence.json
```

The command validates the local input before a provider call, sends one recording
through the same session/collector as the HTTP upload endpoint, and bounds transcription at 60 seconds.
It has no database dependency and does not verify authentication or the HTTP
upload itself. It prints outcome/length and optional character error rate (CER),
not the transcript. Only explicit `--output` writes the transcript, into a new
file; keep reports containing personal content out of Git. A missing key skips
provider access. Exit codes are `0` for matching outcome, `1` for service failure
or unexpected outcome, `2` for missing configuration/local input, and `130` for
interruption. CER normalizes Unicode, case, whitespace and punctuation; it is a
diagnostic metric, not proof of meaning or a pass threshold. Review the important
phrases and final sentence manually.

Then send the same Blobs through the authenticated HTTP example in
[audio-upload.md](audio-upload.md#browser-integration). Confirm the payload,
session behavior and safe errors. The existing Record page's WebSocket path is
a separate integration; confirm that its final text agrees with the recording.

## Completion evidence

Implementation verification: the offline regression above passed all 196 tests
(190 service/HTTP/WebSocket tests and six verification-command tests). Provider
calls were blocked/mocked; no live calls were made. The existing environment
emits dependency deprecation warnings. On this Windows sandbox, pytest's private
temporary directories needed the normal user context for the CLI tests.

The HTTP upload documentation records an English synthetic-audio provider check.
It does not establish browser microphone behavior or Vietnamese recognition.
At implementation time neither the process environment nor the repository
`.env` provides a Deepgram key, so no new real-provider quality claim is made.
Run the four browser checks above and record their results before marking the
recording transcription verification complete. Do not substitute mocked transcripts for
that evidence.
