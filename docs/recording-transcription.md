# Browser-recording transcription

Completed browser recordings use the Deepgram **prerecorded HTTP API**. Live
WebSockets retain the streaming transport/normalizer. Both accept WebM/Opus and
share safe Deepgram error types; neither automatically retries or saves audio.

## Completed-recording helper

```python
from app.services.deepgram_recorded import DeepgramRecordedClient

result = await DeepgramRecordedClient().transcribe(webm_opus_bytes)
# result.transcript: str
# result.outcome: "transcribed" | "no_speech"
```

The HTTP endpoint `POST /api/transcriptions` and verification CLI use this client.
It sends original audio bytes once to `https://api.deepgram.com/v1/listen`, with
model=nova-3, language=multi and vi/en language hints. It never sends a reference
.txt, journal prompt, auth cookie or user ID to the provider. The backend key
stays in the Authorization header. No reference text is used to fill missing speech.

The client bounds audio at 10 MiB and response JSON at 2 MiB. Open/read/write/pool
HTTP budgets are 8/45/10/5 seconds, with a 60-second whole-recognition deadline.
Redirects and environment proxies are disabled. Completed JSON must have valid
metadata and one result channel with a transcript; an empty transcript yields
no_speech. Duplicate fields, non-finite numbers, excessive nesting and malformed
results fail safely. Cancellation closes response/client work. The immutable
RecordedTranscript excludes its text from repr().

The upload retains `{transcript, outcome}`, cookie/Origin/CSRF checks, shared AI
quota, a 30-second upload deadline, session rechecks and no journal writes. See
[HTTP upload](audio-upload.md) for the browser contract and status mapping.

## Live streaming remains separate

`transcribe_audio`, `TranscriptNormalizer` and `collect_recorded_transcript` remain
available for streaming. Only confirmed segments can become saved transcript text;
unresolved drafts remain incomplete. A final may revise timestamps in an older
draft, while genuinely ambiguous new cumulative overlap still fails safely.
Live transport keeps its 12-second finish budget. The streaming diagnostic below
is not the production completed-file recognition path.

## Language and quality

WebM/Opus is the current browser contract. A .weba filename can contain the same
WebM/Opus bytes; changing extensions is unnecessary and never converts audio.
WAV, MP4 and Ogg are not added by this change. Language hints bias recognition;
they do not enforce a language or guarantee correct words. See the official
[language-hint documentation](https://developers.deepgram.com/docs/nova-3-language-prompting)
and [prerecorded API](https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded).

Controlled A07 comparisons found that the streaming results omitted an English
sentence in the mixed recording. The same file and hints through prerecorded
recognition retained both languages. The production upload and CLI were therefore
moved to prerecorded, without an automatic second request or a fallback chain.
See [verification results](transcription-verification.md) for CER, timing, call
budgets, residual word substitutions and the separate live/browser checks.

## Offline verification

Run these suites with TEST_DATABASE_URL targeting a disposable PostgreSQL database:

```cmd
cd /d D:\Lab_CT\AuraJournal\src\backend
..\..\.venv\Scripts\python.exe -B -m pytest tests/test_deepgram_recorded.py tests/test_verify_transcription.py tests/test_transcription_upload.py tests/test_transcription_upload_auth.py tests/test_transcriptions_api.py tests/test_transcription_validation.py tests/test_transcription.py tests/test_transcription_session.py tests/test_recorded_transcript.py tests/test_deepgram_service.py tests/test_diagnose_transcription.py -q -p no:cacheprovider
```

Tests use MockTransport/fake providers and block real external connections. The
recorded REST adapter has independent schema/status/limit/deadline/cancellation
tests, including an actual adapter-to-upload route test. Legacy timed streaming
fixtures are adapted to the recorded interface only to retain existing adversarial
API-boundary cases; they are not evidence of real prerecorded provider behavior.

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
through the same prerecorded client as the HTTP upload endpoint, and bounds transcription at 60 seconds.
It has no database dependency and does not verify authentication or the HTTP
upload itself. It prints outcome/length and optional character error rate (CER),
not the transcript. Only explicit `--output` writes the transcript, into a new
file; keep reports containing personal content out of Git. A missing key skips
provider access. Exit codes are `0` for matching outcome, `1` for service failure
or unexpected outcome, `2` for missing configuration/local input, and `130` for
interruption. CER normalizes Unicode, case, whitespace and punctuation; it is a
diagnostic metric, not proof of meaning or a pass threshold. Review the important
phrases and final sentence manually.

Then use the authenticated Record screen and the
[U03 end-to-end checklist](audio-upload.md#manual-u03-end-to-end-checklist-pending).
Confirm raw upload bytes, session behavior, safe errors, playback and manual
review/save. With live transcription enabled, confirm that its final text agrees
with the recording and that successful live completion does not also upload it.

## Optional streaming diagnostics

`src/backend/scripts/diagnose_transcription.py` requires --live and a new --output
file. It captures exactly one explicitly authorized streaming connection with no
retry and replays the normalizer offline. --finish-timeout can be >0 and <=55
seconds; the total capture deadline remains 60 seconds. This is useful for live
mapping comparisons, not for evaluating the new prerecorded production adapter.

The report contains speech text/timings and must stay in a Git-ignored local
folder. It omits credentials, request headers and top-level provider metadata.
An existing output file blocks provider access. Incomplete provisional text is
never reported as a successful transcript. Use the normal verify_transcription.py
command for production prerecorded quality checks.
