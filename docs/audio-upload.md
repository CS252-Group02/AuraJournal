# HTTP recording transcription

The prerecorded client, standalone verification command and
Vietnamese/English browser checklist are documented in
[Browser-recording transcription](recording-transcription.md).

`POST /api/transcriptions` accepts one transient WebM/Opus recording and returns
one transcript using Deepgram prerecorded recognition. The Record screen
uses it for completed local recordings and explicit recovery from failed live
transcription. The `/api/transcriptions/live` WebSocket remains the live path.

## Request and result

Sign in first. Send the existing session cookie, configured `Origin`,
`X-AuraJournal-CSRF: 1`, and `Content-Type: audio/webm;codecs=opus`.
The body is the raw Blob, **not JSON or FormData**. MIME casing, whitespace,
and a quoted `codecs="opus"` value are accepted. Generic `audio/webm`, MP4,
Ogg, WAV, extra MIME parameters, and multipart requests are rejected.

Maximum recording size is 10 MiB. Upload reading has a 30-second deadline;
transcription has a 60-second deadline plus bounded provider cleanup. A WebM
signature is checked before provider access; it does not prove that all audio
can be decoded. Deepgram validates the full recording. No transcoding occurs.

Success returns:

```json
{"transcript":"Today I finished my assignment.","outcome":"transcribed"}
```

Valid audio without recognized speech returns HTTP 200 with
`{"transcript":"","outcome":"no_speech"}`. Empty bytes are an error, not silence.
Only finalized text is returned. An incomplete provider result returns an error
rather than silently promoting provisional words. Responses use `no-store`.

## Browser integration

The signed-in Record screen uses `features/record/audioUpload.js` through
`recordServices.uploadAudio`. The adapter uses `API_URL` from `lib/api.js` and
keeps the JSON `api()` helper separate. Its request is:

```javascript
// Inside the adapter, after validating the completed Blob and session:
const response = await fetch(`${API_URL}/api/transcriptions`, {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'audio/webm;codecs=opus',
    'X-AuraJournal-CSRF': '1',
  },
  body: blob,
  signal,
});
```

The browser supplies Origin. Use the configured API URL outside the default
localhost setup. Record with `audio/webm;codecs=opus` only when
`MediaRecorder.isTypeSupported()` accepts it; do not relabel an MP4/Ogg Blob.
The existing JSON `api()` helper cannot send these raw bytes. Keep the recording
available for playback/retry and let the user review the returned text before
saving through the journal API. Uploading does not create a journal. The existing
5,000-character journal limit still applies when saving; transcription does not
silently truncate longer results.

### Record flow

- With `VITE_RECORD_TRANSCRIPTION_PATH` unset, recording stays local until Stop.
  The existing recorder waits for its final chunk, releases microphone tracks,
  and retains its Blob/playback URL. Supported, nonempty audio up to 10 MiB is
  uploaded once, then its exact transcript enters the existing review editor.
- With the live path configured, successful WebSocket completion (including
  `no_speech`) never triggers HTTP upload. Confirmed/interim handling, animations,
  proofreading configuration, and live finalization remain unchanged.
- Failed or incomplete live transcription retains confirmed text and any
  unconfirmed tail. **Transcribe recorded audio** explicitly sends the entire
  recording as a new, potentially billable request. A failed live attempt never
  silently starts a second provider request. A failed live connection can also
  recover through the existing **Record locally instead** action.
- HTTP processing has its own `transcribing` phase, separate from live
  finalization and journal saving. Playback and editing remain available; Save
  and repeated upload submissions are blocked while processing. The client
  deadline is 100 seconds: the backend's 30-second read and 60-second recognition
  deadlines plus time for bounded cleanup and response transport.
- **Cancel transcription** aborts the request and returns to review without
  releasing the Blob or changing the draft. Timeouts and network/server failures
  retain the same audio for an explicit **Retry transcription**. Nothing retries
  automatically. Invalid/oversized/unsupported audio instead offers manual review
  or a new take. `429` feedback includes a numeric `Retry-After` when supplied.
- A result never overwrites existing confirmed text or edits, including edits
  made while waiting. It appears under **Transcript from uploaded recording**;
  **Replace draft with uploaded transcript** is the explicit replacement action.
  Original live text stays available for comparison. `no_speech` retains any
  current draft and offers manual editing rather than inventing text.
- HTTP `401`/`403` errors stay on this page with readable feedback rather than
  forcing a redirect that would destroy the retained audio. Actual auth epoch
  changes abort pending uploads; responses from an old session cannot populate
  the draft, and an old take cannot be uploaded or saved in a new session.
  Reset, discard, navigation/unmount, and confirmed save keep their existing
  audio cleanup behavior. Audio is held in memory, not persisted across logout,
  reload, or navigation away from Record.
- HTTP output enters manual review directly. It does not invoke proofreading or
  create a journal. **Save journal** still uses `POST /api/entries`, the existing
  5,000-character validation, and uncertain-save safeguards.

Set `DEEPGRAM_API_KEY` only in the backend environment or root `.env`. Missing
credentials do not prevent startup; they produce a safe error on transcription.
Installing the existing backend requirements is sufficient; no multipart package,
new environment variable, or schema migration is needed. The existing database
must be at head (`0008` when this endpoint was added) for shared request budgets.

## Errors and privacy

| Status | Meaning |
| --- | --- |
| 400 | Invalid recording length or interrupted upload |
| 401 | Missing, expired, revoked, or disabled account session |
| 403 | Origin or CSRF validation failed |
| 413 | Recording exceeds 10 MiB |
| 415 | Unsupported audio Content-Type |
| 422 | Empty audio, invalid WebM signature, or provider decode failure |
| 429 | Shared AI request budget or provider rate limit exceeded |
| 502 | Invalid or incomplete provider transcript |
| 503 | Missing/rejected provider credentials, unavailable provider, or unavailable database |
| 504 | Upload, provider, or transcription deadline exceeded |

Errors expose fixed `detail` messages, not provider bodies, credentials, audio,
or submitted transcript text. The existing AI budgets apply across title,
summary, and upload requests: 10 per account/minute, 100 per account/day,
and 30 per client IP/minute. Rejected upload attempts also consume budget.
Rate-limit responses include `Retry-After`.

Authentication precedes body consumption, and the session is rechecked before
provider access and before returning text. Database connections are released
during upload and recognition. The 64 KiB JSON limit and JSON-only mutation
policy stay in force on other routes. Only this exact POST path accepts raw
audio. A client disconnect or cancellation stops the take and closes resources.
There are no automatic billable retries, audio files, journal writes, or transcript
logs. Audio is held only in bounded request memory and sent to Deepgram.

## Verification

For the U03 frontend integration, from the repository root:

```sh
npm run test:frontend
npm run build
```

The existing API, recorder, flow and animation suites cover raw Blob identity and
bytes, cookie/CSRF headers, permission recovery, MIME/size limits, exact Unicode
and whitespace, review/save separation, no speech, failed/slow requests, explicit
retry, cancel/reset/unmount/auth changes, preserved drafts and playback, live/HTTP
deduplication, and unchanged animation/scroll behavior. Rendered component checks
cover visible recording controls, processing/cancel feedback, retry, playback,
and explicit transcript replacement. All network/provider responses in these
automated tests are fake; they do not prove real microphone or recognition quality.

U03 verification on 2026-11-19: **145 frontend tests passed** and the Vite
production build passed. The complete frontend suite needed execution outside
the sandbox because its existing timezone tests spawn child Node processes.
With Node 24.22.2 and Python 3.14.4, the offline backend command below passed
**190 tests** (with dependency deprecation warnings):

```sh
# From src/backend, using the repository virtual environment:
../../.venv/bin/python -m pytest tests/test_transcription_upload.py tests/test_recorded_transcript.py tests/test_transcriptions_api.py tests/test_transcription_validation.py tests/test_transcription_session.py tests/test_transcription.py tests/test_deepgram_service.py tests/test_http_isolation.py -q
```

No backend code changed for U03. Database-backed upload authentication/budget
tests were inspected but were not rerun in this integration check. Real browser
microphone/provider checks remain pending below; no real provider calls were
made during U03 automated verification.

With declared dependencies installed and `TEST_DATABASE_URL` set to a disposable
PostgreSQL database, run from `src/backend`:

```powershell
python -m pytest tests/test_transcription_upload.py tests/test_transcription_upload_auth.py tests/test_deepgram_service.py tests/test_transcription_session.py tests/test_transcription.py tests/test_transcriptions_api.py tests/test_transcription_validation.py tests/test_http_isolation.py -q
python -m pytest tests -q
```

Automated tests use fake providers; real HTTP/WebSocket provider connections
remain blocked. They cover auth and budgets with real database sessions,
two-account isolation, no journal writes, MIME validation, exact size limits,
chunked uploads, Unicode/revisions, silence, invalid audio, safe provider errors,
timeouts, disconnect cleanup, and live-WebSocket compatibility.

The helper also fixes cancellation races observed on Python 3.11 and accepts
provisional word-end estimates extending beyond an interim result window while
keeping final-word timing checks strict. The latter reproduces a real Nova-3
response observed during verification.

Verified on Windows/Python 3.11.18: the complete backend regression run returned
**627 passed, 1 skipped**. The skip was the existing administrator-only runtime-role
provisioning test because `SECURITY_ADMIN_DATABASE_URL` was not configured; no
cluster roles were changed. The final upload-only run, including three subsequently
added missing-MIME/session-expiry cases, returned **37 passed**. Both runs emitted
one Starlette/AnyIO dependency deprecation warning. No live provider calls were
made by automated tests.

### Real provider check

The authenticated endpoint was checked with a real configured Deepgram service
and synthetic, non-private English WebM/Opus audio generated locally. Registration
returned 201 and the upload returned 200 with:

```json
{"transcript":"today i finished my assignment tomorrow i will go for a walk","outcome":"transcribed"}
```

This check used the in-process HTTP application and a temporary isolated schema
in `aurajournal_test`, removed afterward. It did not migrate the application DB.
The initial live check exposed a strict interim-word timing rejection; a
diagnostic call and final successful check were performed explicitly, not as
automatic retries. No private journal or human recording was submitted.

**Still unverified for U03:** real browser MediaRecorder-to-HTTP upload and real
English/Vietnamese recognition through the integrated Record screen. The prior
synthetic-audio check above does not establish these acceptance criteria.

### Manual U03 end-to-end checklist (pending)

Use a signed-in account, an HTTPS/localhost browser supporting WebM/Opus, a
running FastAPI backend/database with current migrations, matching frontend
origin/cookie configuration, and a backend-only `DEEPGRAM_API_KEY`. Use fictional
speech. Each upload/retry can consume provider credit; perform these explicitly.

- [ ] **Real microphone and permission recovery:** leave the live path unset.
  Deny microphone permission and verify actionable feedback. Allow permission
  and retry. Verify the central Record/Stop control, running duration, and browser
  microphone indicator. After Stop, confirm microphone tracks stop and playback
  and Replay work. In browser Network tools verify one authenticated
  `POST /api/transcriptions`, raw `audio/webm;codecs=opus` bytes, CSRF header,
  and a FastAPI response. Do not record private payloads in logs or Git.
- [ ] **English:** say “Today I finished my assignment. Tomorrow I will visit the
  library.” Stop, play it back, and compare the recognized phrases with the audio.
- [ ] **Vietnamese:** say “Hôm nay tôi hoàn thành bài tập nhóm. Ngày mai tôi sẽ
  đến thư viện.” Confirm meaningful Vietnamese text appears in review. Optionally
  record mixed English/Vietnamese speech and check the language switch.
- [ ] **Silence:** record several seconds in a quiet room. Confirm valid audio
  can return `no_speech`, with manual review, playable audio and no automatic save.
- [ ] **Network failure:** go offline before Stop or interrupt the upload. Confirm
  error feedback and preserved audio/draft. Restore networking and explicitly
  retry once; confirm repeated clicks do not send additional requests.
- [ ] **Slow transcription:** throttle the request or use a local delayed fake
  provider. Confirm processing feedback, editable draft, playback and disabled
  Save. Cancel and verify retained work; ignore a late response. In a separate
  attempt, confirm the 100-second client deadline returns to recoverable review.
- [ ] **Live coexistence:** enable `/api/transcriptions/live`, restart the frontend,
  and verify interim/final animations, scrolling and final review without any
  HTTP upload. Interrupt the socket mid-take; verify retained confirmed text and
  audio. Explicitly transcribe the full recording and check that edited text
  remains until choosing **Replace draft with uploaded transcript**.
- [ ] **Review and journal saving:** correct recognized text and choose **Save
  journal**. Verify only the reviewed editor text is posted to `/api/entries`,
  then open the saved journal. Check that transcription alone created no entry.
- [ ] **Session/reset/navigation:** cancel or discard during upload, start a new
  take, and confirm no old response appears. Check navigation discard protection.
  Change authentication during a pending request and confirm cancellation and
  that no previous-session result enters the new account's draft.


## Completed-file recognition update

A07 comparisons isolated a mixed-language omission in the streaming results.
The same audio/hints through Deepgram prerecorded returned the English sentence,
so completed uploads now use DeepgramRecordedClient.transcribe, a single bounded
HTTP request. The CLI uses the same client. Public API/size/session/quota/CSRF
contracts stay unchanged. It validates completed results without reconstructing
streaming intervals and preserves no_speech. Live WebSockets retain their separate
streaming client and 12-second finish budget. There is no automatic fallback,
second paid call, prompt correction or reference-text upload.

HTTP read timeout is 45 seconds inside the unchanged 60-second recognition cap;
upload reception remains limited to 30 seconds. See
[verification results](transcription-verification.md) for measured CER/timing and
residual recognition errors; manual review remains necessary.
