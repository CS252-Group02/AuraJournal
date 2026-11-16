# HTTP recording transcription

`POST /api/transcriptions` accepts one transient WebM/Opus recording and returns
one transcript using the existing Deepgram streaming helper. The separate
`/api/transcriptions/live` WebSocket and Record screen remain unchanged.

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

Call this from the signed-in frontend with a completed browser recording Blob:

```javascript
async function uploadRecording(blob, signal) {
  const response = await fetch('http://localhost:8000/api/transcriptions', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': blob.type,
      'X-AuraJournal-CSRF': '1',
    },
    body: blob,
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail);
  return result;
}
```

The browser supplies Origin. Use the configured API URL outside the default
localhost setup. Record with `audio/webm;codecs=opus` only when
`MediaRecorder.isTypeSupported()` accepts it; do not relabel an MP4/Ogg Blob.
The existing JSON `api()` helper cannot send these raw bytes. Keep the recording
available for playback/retry and let the user review the returned text before
saving through the journal API. Uploading does not create a journal. The existing
5,000-character journal limit still applies when saving; transcription does not
silently truncate longer results.

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

**Still unverified:** an actual browser MediaRecorder-to-HTTP upload and real
Vietnamese recognition. No suitable non-private Vietnamese WebM/Opus recording
was available, and only English synthesis voices were installed. Before marking
end-to-end verification complete, upload short fictional English and Vietnamese
browser recordings from a signed-in frontend using the example above. Check
that meaningful phrases match the recordings; exact punctuation is not required.
