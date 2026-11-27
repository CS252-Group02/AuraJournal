# Authenticated journal API contracts

All private routes use the same `aurajournal_session` HttpOnly cookie. Browser
requests include credentials; mutations also require the configured Origin,
`X-AuraJournal-CSRF: 1` and JSON, except the documented raw audio upload.
Missing, expired, revoked and disabled-account sessions return 401. Ownership is
resolved from the session, never a client user ID. Foreign and missing entries
both return 404. Private responses use `Cache-Control: no-store`.

## Journal and calendar routes

- `POST /api/entries`: content and optional journal_date; returns 201 entry.
- `GET /api/entries`: returns an array, empty accounts return `[]`.
- `GET/PATCH/DELETE /api/entries/{id}`: read, partial update, or delete (204, no body).
- `GET /api/entries/by-date?date=YYYY-MM-DD`: array for the chosen journal day.
- `GET /api/calendar?year=2024&month=2`: every calendar day, including zeros.
- `GET /api/dashboard?year=2024&month=2` and `GET /api/stats/streak`:
  accept an optional IANA timezone, retaining the existing Asia/Bangkok default.

The list accepts literal case-insensitive `q` (accents preserved), inclusive
`start/end`, `sort=newest|oldest`, optional `limit >= 1`, and `offset >= 0`
(default 0). Dates must be exactly YYYY-MM-DD. Reversed ranges return 422.
Filters and ownership are applied before ordering, offset and limit. No default
limit is imposed, preserving existing frontend behavior. Example:

```text
GET /api/entries?q=library&start=2024-02-01&end=2024-02-29&sort=newest&limit=20&offset=20
```

An unfiltered list retains creation-time descending order, then ID descending.
Search/date-filtered/explicitly sorted lists use journal_date, created_at and ID
in the chosen direction. Keep query parameters unchanged between pages. Offset
pagination is not a frozen snapshot: concurrent inserts/edits can shift pages.
Calendar dates never shift when the timezone changes; timestamps retain offsets.
Entry fields remain id, content, journal_date, ai_summary, ai_summarized_at,
created_at and updated_at. No response wrapper or frontend migration is required.

## Two distinct weekly contracts

`POST /api/weekly-reflections` accepts `{ "period_start": "2024-02-26" }`.
It selects seven inclusive journal dates, returns summary, exactly two questions
and source_dates for a nonempty period, and saves the result for private
`GET /api/weekly-reflections/{period_start}` reads. Any valid seven-day start is
accepted. An empty generation returns summary null and empty questions/sources,
and does not create a saved record; a missing saved result returns 404.
Historical saved source_dates may remain null; evidence is never invented.

`POST /api/reflections/weekly` accepts start (Monday), timezone and optional
`date_basis`. The default `recorded` selects creation timestamps in the local
week, respecting DST. Explicit `journal` selects journal_date instead. It returns
week_start/week_end, timezone, entry_count, summary and highlights with entry_ids;
it does not save a reflection or return coaching questions. An empty week returns
summary null and highlights []. Both contracts require exact YYYY-MM-DD input.
These routes intentionally retain different behavior; clients must select the
contract that matches their screen.

## Error contract and verification

Business errors use `{ "detail": "Safe public message" }`. Validation uses
`{ "detail": [{ "loc": [], "msg": "...", "type": "..." }] }`, without echoing
submitted input. Standard codes: 401 session, 403 Origin/CSRF, 404 missing/private
resource, 409 changed sources/conflict, 413 too large, 415 wrong content type,
422 invalid fields, 429 quota (Retry-After), 502 invalid AI output and 503 service
unavailable. Audio additionally uses 400 for interrupted/invalid uploads and 504
for deadlines; its existing contract is documented separately.

Run tests/test_authenticated_journal_contract.py and tests/test_journal_search.py
with TEST_DATABASE_URL pointing to a disposable PostgreSQL database. Tests use
isolated schemas and fake AI, covering one-session journeys, two accounts,
calendar leap days, pagination, strict dates, restart persistence and revoked
sessions. No application database migration or live provider call is needed.


## AI and speech failure policies

Recap, saved reflection and journal Q&A share typed-error HTTP mapping while
retaining their existing public messages. Groq credentials, rate limits, network
errors and timeouts map to 503; malformed/empty outputs and invalid evidence map
to 502. The configured SDK uses timeout=20 seconds and max_retries=0. This is a
provider transport timeout, not cancellation of arbitrary synchronous Python work.
Unexpected programming exceptions are not disguised as provider failures.

Audio keeps its specific mapping: invalid audio 422, invalid transcript 502,
provider unavailable 503, timeout 504 and rate limit 429 with Retry-After.
Uploads accept only raw audio/webm;codecs=opus, at most 10 MiB; upload deadline
is 30 seconds and recognition deadline 60 seconds. These processing deadlines
are not an assertion about the uploaded recording's media duration. Live capture
has a separate 300-second session limit. Neither audio path stores the recording
or creates a journal; saving remains an explicit authenticated action.

`tests/test_ai_failure_contract.py` exercises the real Groq SDK through local
MockTransport, checking one attempt, safe responses/logs and preserved saved data.
Audio limit/timeout/disconnect/error cases remain covered by
`test_transcription_upload.py`, `test_transcription_upload_auth.py` and the live
transcription tests. All external network calls remain blocked in pytest.

## A10 AI contract reference

Audited from `origin/main` **112c937** (2026-11-25). These are separate feature
contracts; they share transport/error handling where appropriate, not a universal
AI request or response model. Character budgets include JSON escaping when stated
as serialized budgets. Unicode, Vietnamese/English and internal journal newlines
are preserved. Sources are never silently removed to fit a weekly budget.

| Feature / entry point | Input boundary and budget | Validated output / domain rules | Persistence and consumer |
| --- | --- | --- | --- |
| Title: `POST /api/ai/suggest-title`, `JournalTitleGenerator.generate` | `JournalTitleRequest`: only content, nonblank string, at most 5,000 characters before trimming; unsupported C0 controls rejected except newline, carriage return and tab. Direct helper applies the same checks. | `JournalTitle`: one nonblank suggested_title, at most 100 characters, single line, no Markdown/list or enclosing quotes; extras rejected. Route revalidates injected helpers, including constructed/mutated models. | Stateless suggestion; no journal reads/writes. No current frontend title consumer was found. Optional assistance must not block saving. |
| Entry summary: `POST /api/entries/{id}/summary`, `JournalSummarizer.summarize` | Owned UUID and current stored text; same single-journal budget at service and route boundaries. Empty/invalid stored text returns 422 before calling any helper. | `JournalSummary`: only nonblank summary, at most 500 characters. Route revalidates helper output before writing. | Updates summary/timestamp only after session revalidation and a locked owner/content/version/date/update-time snapshot check; conflicts return 409. EntryPage keeps its previous note on failure. |
| Q&A: `POST /api/entries/ask`, `GroqJournalQuestionAnswerer.answer` | `JournalQuestionRequest`: only a nonblank question, at most 1,000 characters, supported controls. `JournalExcerpt`: UUID, exact journal_date, nonblank content of at most 1,200 characters; at most five excerpts and 8,000 serialized question/context characters. | `JournalAnswerResponse`: answered or insufficient_evidence; nonblank answer at most 2,400 characters; at most five strict, sorted, unique dates. Answered requires dates drawn from the original supplied sources; insufficient evidence requires no dates and uses the deterministic localized explanation. | No answer/history persistence. Owner-scoped retrieval, source copies/snapshot and session recheck remain in place. `createAskLoader` handles errors, retry, cancellation and superseded results; no mounted Q&A JSX consumer exists in this baseline. Empty/no-match context returns 200 without provider/quota use. |
| Recap: `POST /api/reflections/weekly`, `WeeklyRecapGenerator.generate` | Monday, IANA timezone and recorded/journal date_basis. Direct sources require UUID, nonblank string content and exactly one strict journal_date or timezone-aware recorded_at. At most 60,000 serialized source characters, checked before provider work. | `WeeklyRecap`: summary 1–2,400 characters; zero to five highlights, each text 1–400 and one to five UUID references belonging to the supplied journals. Extras/nested invalid models rejected by adapter and route. | Not persisted. Empty week returns 200/null summary/empty highlights without AI. Existing source and session rechecks, quota commit and released read transaction remain. ReflectionPage/dashboard loaders discard stale/cancelled work. |
| Saved reflection: `POST /api/weekly-reflections`, `GroqWeeklyReflectionGenerator.generate` | Exact period_start with a complete seven-day range. Sources: UUID, strict journal_date and nonblank content; at most 60,000 serialized characters. API and adapter enforce budgets. | `WeeklyReflectionContent`: summary 1–2,400; exactly two distinct questions, each 1–300; one to seven strict sorted unique source dates, all present in original supplied sources. Route independently revalidates helper output. | Atomic owner/period upsert after session/source checks. Empty period preserves prior data without calling AI. Historical GET source_dates remains null when evidence was never stored. SavedReflection preserves its prior snapshot on generation errors. |
| Moment: `MomentExtractor.extract`, `render_pixel_art` | Nonblank single-journal string with the existing 5,000-character budget. No client-supplied source/owner; worker uses its versioned journal snapshot. | `SignificantMoment`: grounded/symbolic, moment 1–400, nullable evidence at most 500 and scene at most 450; nonblank plain strings; evidence/scene paired, grounded requires both. Evidence is an exact substring and scene cannot contain the whole journal. Rendering revalidates injected extractors and evidence before submission intent. | No new moment persistence. No evidenced scene raises NoDepictableMoment, preserving its existing bounded extraction retry policy. Prompt/grounded/symbolic semantics are unchanged. |
| PixelLab: `PixelLabClient.generate` through durable jobs | Minimized prompt at most 800 characters; 128×128 requested, no prompt enhancement. | Bounded 2 MiB response, base64 envelope, decoded single-frame 128×128 PNG, metadata removed by re-encoding. Provider envelope extras are deliberately tolerated. Recovery PNGs are validated too. | Existing owner/version/attempt fences and private image association. Never resubmit after submitted_at, even after timeout/5xx/malformed output. Feed/status do not claim ready for missing files. PixelMemories can retry PNG reads; generation retry is allowed only by server eligibility. |
| Deepgram live / recorded: `transcribe_audio`, `collect_recorded_transcript` | Agreed raw WebM/Opus bytes; HTTP at most 10 MiB, 30-second upload and 60-second recognition deadlines. Live uses 300-second/10 MiB limits and bounded message sizes; these are not an HTTP recording-duration guarantee. Nonblank take ID and ordered binary chunks required. | Strict provider JSON and event/word types, finite timing, final-only segments and consistent completion. HTTP UploadedTranscript is transcribed with nonblank text or no_speech with empty text. Unconfirmed/incomplete drafts never become successful recorded transcripts. | No audio storage or journal write. Record flow preserves recording/draft, releases loading on failure and supports explicit safe retry/cancel. Account/session/take guards prevent late text entering a new session. A07 accuracy/capture evaluation is separate. |

### Timeouts, attempts and safe failures

Groq title/summary/Q&A/weekly helpers use the existing **20-second** SDK transport
timeout and `max_retries=0`. Moment extraction intentionally uses **30 seconds**
and zero SDK retries. Completion token budgets remain 300 title/summary, 1,536
Q&A, 1,024 recap, 2,048 reflection and 600 moment. A timeout bounds provider
transport operations; it does not cancel arbitrary injected synchronous helpers.

Groq authentication/permission failures become AIServiceNotConfiguredError;
connection/timeout/rate-limit/other HTTP provider failures become
AIServiceUnavailableError. Both remain HTTP 503. Empty/missing choices, malformed
JSON, schema errors and unsupported evidence become AIInvalidResponseError/502.
Title and summary now use the existing `ai_service_error` mapping too, suppressing
raw exception chains at the HTTP boundary. Unexpected helper programming errors
still propagate as errors, rather than pretending to be provider downtime.

Application quotas remain 429 with Retry-After, invalid user input 422, body or
weekly/context budget rejection 413, and source conflict 409. Direct helper
input violations raise their existing empty/budget exceptions or Pydantic
ValidationError; they are not valid no-evidence model outputs.

PixelLab retains its 120-second read/overall deadline checks (connect 5, write 10,
pool 5 seconds), zero submission retries and conservative uncertain completion.
Only pre-submission transient extraction/no-moment results get one retry after at
least 60 seconds (two attempts total). Explicit eligible retries keep their existing
budgets and submitted_at gate; invalid/configuration output is not automatically
retried. Job status/error_code, rather than a Groq HTTP remapping, is the consumer
contract for background generation.

Deepgram retains its separate 422 invalid audio, 502 invalid transcript, 503
configuration/unavailable, 504 timeout and 429 rate-limit plus Retry-After mapping.
Open/send/finish defaults are 10/10/12 seconds; the application configures an
8-second open deadline and the session has an 8-second audio inactivity deadline.
There is no ordinary receive timeout during live silence and no automatic reconnect.

### Privacy and frontend recovery

Public errors and application logs omit credentials, prompts, journal text, raw
provider messages and private storage paths. Provider causes can remain internal
for adapter diagnostics; HTTP handlers suppress them and never stringify/log them.
Database and pixel lifecycle/ownership protections remain unchanged. Invalid
generated data is checked before summary/reflection persistence or image submission;
source journals are preserved on every AI failure. Generated summary/reflection
text containing a null character is rejected as invalid output before PostgreSQL
text/JSONB storage, preserving 502 rather than misclassifying it as database 503.

The shared `api` client retains status for non-JSON/malformed error bodies,
dispatches unauthorized recovery even for a non-JSON 401, validates error-envelope
shape, and uses safe messages for server/AI/quota/network failures. It exposes a
numeric retryAfter only for a bounded Retry-After value. Malformed successful JSON
is a safe client error, never raw parser text. Session-epoch and abort checks run
before requests and after fetch/body parsing. No automatic request retry was added.
Feature loaders resolve loading on error and permit explicit retry; prior saved
reflections/entry notes and recording drafts remain available. Account changes
still clear private state. See the handoff for executed checks and pending browser
acceptance; schema checks alone do not establish model factuality.

Regression evidence is in `test_ai_contract_boundaries.py`,
`test_ai_failure_contract.py`, `test_ai_titles_api.py`, `test_ai_service.py`,
`test_weekly_generation_safety.py`, the existing Q&A/reflection/pixel/transcription
suites, and `tests/frontend-api.test.js`. Use the complete verification commands
in [the backend handoff](backend-integration-handoff.md#repeatable-automated-verification).


Completed-file transcription uses the prerecorded HTTP adapter: one raw-audio
request, 45-second HTTP read timeout inside the 60-second recognition deadline,
strict completed-result validation and no automatic retry/fallback. Live keeps its
12-second streaming finish budget. The upload response remains transcript/outcome.
See [verification results](transcription-verification.md).
