# Backend integration handoff

This guide covers the journal API contracts and AI/media reliability delivered
for the current backend integration. See [API contracts](journal-api-contracts.md)
for compatible request/response shapes and [audio upload](audio-upload.md),
[weekly reflections](weekly-reflections.md), [weekly recap](weekly-recap.md),
[journal Q&A](journal-questions.md) and [pixel art](pixel-art.md) for details.
No new migration, environment variable or dependency is introduced by this work.
Existing journals and historical reflections are preserved.

## Browser integration

Use the current cookie/CSRF client. Entry lists remain arrays and pagination is
opt-in (`limit`, `offset`); unpaginated clients continue receiving the full list.
Use exact YYYY-MM-DD calendar dates. Select the appropriate weekly endpoint:
saved summaries with two questions use journal_date; recap/highlights retain
creation-time behavior unless date_basis=journal is explicitly requested.
No UI change or simultaneous frontend migration is required.

Journal saving commits before background artwork generation. Poll the entry's
`/pixel-art/status` or the memories feed and inspect generation.status. On ready,
read image.content_url using authenticated binary fetch (the current apiPng
helper), then display a temporary Blob URL. No storage key or public provider URL
is exposed. Ready metadata can outlive a missing physical PNG: content returns
404 and the status/feed identify image_missing. Preserve the journal and show a
fallback; reading status or metadata never regenerates artwork.

Explicit image retry is only allowed for eligible failed/unavailable jobs that
have never been submitted. Pending/processing/ready/submitted/uncertain jobs
cannot be resubmitted through retry or the deprecated generation endpoint.
Provider failure does not prevent saving another journal. Account changes and
logout must clear prior text, answers and Blob URLs using the existing frontend
session guards; server-side reads enforce ownership and session revocation too.

## Repeatable automated verification

From CMD, with the existing dependencies installed, use a disposable PostgreSQL
TEST_DATABASE_URL. Tests create and drop isolated schemas inside that test DB;
they do not migrate the application database or use production records.

```cmd
cd /d D:\Lab_CT\AuraJournal\src\backend
set TEST_DATABASE_URL=postgresql+psycopg://USER:PASSWORD@localhost:5432/aurajournal_test
..\..\.venv\Scripts\python.exe -B -m pytest tests -q -p no:cacheprovider
cd /d D:\Lab_CT\AuraJournal
npm run test:frontend
npm run build
```

Focused suites added here:

- test_journal_search.py: strict filter dates, literal matching, ordering and pagination.
- test_authenticated_journal_contract.py: one-session CRUD/calendar/reflection,
  leap-day data, restart persistence and two-account/session isolation.
- test_weekly_generation_safety.py: committed quotas, no checked-out DB connection
  during provider work, malformed helper results, changed sources and revoked sessions.
- test_ai_failure_contract.py: real Groq SDK/adapters with in-memory MockTransport;
  timeout/auth/quota/5xx, malformed or missing results, one attempt and safe errors/logs.
- test_media_browser_contract.py: saved journal -> pending -> ready -> metadata ->
  private PNG -> restart/logout, missing files and uncertain provider completion.

Existing upload, WebSocket, pixel-job and image suites additionally cover audio
size/MIME/deadlines/disconnect cleanup, safe manual retry and worker concurrency.
External HTTP/WebSocket provider connections remain blocked by pytest. These
checks do not establish real microphone behavior or model accuracy. CI must also
run on its Windows, Ubuntu and macOS jobs after the commits are pushed.

## Pending real browser/provider acceptance

These are manual integration checks, not claims of completed provider testing.
Use synthetic/non-sensitive data and deliberately enable/configure providers;
record only pass/fail, response codes and fixture identifiers, not keys, private
journal text or raw provider diagnostics.

- [ ] A07: at least four realistic microphone recordings covering Vietnamese,
  English and a mixed-language case. Use the actual Record screen and its WebM/Opus
  bytes; verify useful final text, silence/no_speech, permission recovery, bad
  format feedback and that a successful live take does not also auto-upload.
- [ ] A08: generate a saved reflection and recap for dated fixtures containing
  mixed topics, sparse data, future plans and a backdated entry. Check grounded
  content, correct source references and exactly two saved-reflection questions.
  Ask both an answerable Q&A question and one absent from the supplied history.
- [ ] A10: confirm the integrated helpers retain the documented schemas, input
  budgets and typed failures. Verify UI recovery from missing configuration,
  quota and provider failure without exposing input/provider text.
  Automated contracts and controlled browser recovery are verified below.
  Combined browser-to-live-provider acceptance remains pending; do not infer
  model quality or successful live summary generation from mocked checks.
- [ ] Media integration: save -> pending/processing -> ready -> authenticated PNG;
  repeat with generation disabled or unavailable. The journal must stay readable.
  For uncertain submission, verify the UI does not offer an unsafe second charge.
- [ ] Cross-account browser check: another login cannot load source journals or
  images; logout during generation/download must not populate the next account.

A07/A08/A10 handoff and these checks are still required before calling B09 fully
accepted with real providers. Shared HTTPS deployment (B10), deployed smoke tests
(B12), export/account deletion and new audio formats are outside this change.


## Prior backend integration verification (2026-11-25)

- Complete backend: **1016 passed, 2 skipped** on Windows, 285.94 seconds.
- Focused filter/date suite: **58 passed**.
- Weekly generation safety suite: **34 passed** after fixing account-state reloading.
- AI/transcription/safety integration suite: **173 passed**.
- Pixel job/memory/private-content integration suite: **93 passed**.
- Frontend: **206 passed** (`npm run test:frontend`).
- Frontend production build: passed (`npm run build`).
- `git diff --check`: passed.

Backend tests emitted dependency/runtime warnings; the two skips are the existing
optional administrator-role and Windows symlink-privilege checks. All automated
provider traffic used fakes or in-memory transports. No live provider request,
application database migration, remote push or deployment was performed in this
implementation. This local run does not replace the cross-platform GitHub CI or
the pending A07/A08/A10 acceptance checklist above.

## A10 audit and integration handoff (2026-11-25)

Baseline: clean local main and freshly fetched origin/main both **112c937**;
dedicated branch **feat/ai-contract-standardization** starts at that commit.
No existing user changes were present. No migration, dependency, provider prompt,
retrieval algorithm, audio format, image lifecycle or page layout was changed.
README.md and PLSREAD.md are unchanged.

The audit traced frontend API calls, router validation, service/provider inputs,
shared Groq JSON parsing, Pydantic/domain validation, persistence/public errors and
frontend recovery. Existing delivery was confirmed from implementation history:

- PR #53 / `a30df52`: versioned durable pixel jobs, submission fences, bounded
  workers and private status. PR #54 / `32b0500`: gallery polling, authenticated
  PNGs, Blob cleanup and account guards.
- PR #55 / `54a923e`, PR #56 / `e16608e`, PR #57 / `e78acb6`: extraction/fallback
  corrections, evidence-backed symbolic scenes and safe pre-submission retry.
  These semantics and zero PixelLab resubmissions are retained.
- PR #59 / `93e6942`: weekly boundary/source/session validation and committed
  quotas; `332e752`: shared safe typed-error mapping and actual SDK MockTransport
  checks; `f239baf`: private media integration tests and the pending acceptance
  checklist. A10 was partially delivered despite its task-board state.

| Requirement | Baseline classification / concrete gap | A10 result and regression evidence |
| --- | --- | --- |
| Title/summary/moment direct input budgets | Partially implemented: API journals/title limited to 5,000; direct generate/summarize/extract could bypass it. | Existing JournalTitleRequest contract reused before provider work; exact limit, Unicode/newlines, oversize and unsupported controls checked in test_ai_contract_boundaries.py. No weekly truncation or new size limit. |
| Direct recap source contract | Missing service validation: WeeklyRecapGenerator.generate serialized arbitrary records before checking IDs after AI. | UUID/nonblank text/exact date or aware timestamp validated before provider access; malformed/missing sources, empty input and exact 60,000-character budget covered. |
| Structured title/summary boundary | Partially implemented: concrete adapters validated JSON; routes trusted injected helpers and summary could save unchecked text. | JournalTitle/JournalSummary models revalidate instances; routers reject bad dictionaries, constructed/mutated models with safe 502 before output/persistence. Valid dictionaries remain supported. |
| Summary data/session preservation | Partially implemented: ownership checked initially, without a post-provider session/source check. | Existing revalidate_session_owner plus locked source snapshot check before update; logout/expiry/disable, edit/delete/date/owner changes tested. Existing valid note and journal are preserved. |
| Moment replacement boundary | Partially implemented: concrete extractor checked evidence; render_pixel_art trusted replacements before paid submission intent. | Model and source evidence independently checked before before_submit/PixelLab; malformed models, invented evidence and full-source scene forwarding rejected without either call. |
| Q&A and saved reflection contracts | Already implemented and verified: bounded sources, status/evidence combinations, distinct questions, source copies, historical null evidence and session/snapshot checks. | Existing Q&A, reflection and weekly safety suites retained; shared SDK failure matrix extended, without prompt/retrieval changes. |
| PixelLab/job and Deepgram failure policies | Already implemented and verified: strict media/results, typed safe codes, private content, conservative image retry and transcript cleanup. | Existing service/job/API/media/transcription suites retained. Moment timeout 30s explicitly checked alongside shared Groq 20s; no A07 accuracy or A09 feature changes. |
| Actual SDK failure coverage | Already implemented but insufficiently verified for A10: three route kinds and six failure kinds. | test_ai_failure_contract.py now covers five routes × eight failure cases, adding title/summary, permission and connection failure; one attempt, safe logs/responses, preserved source/reflection data. Existing missing-config/unit malformed-output suites remain. |
| Frontend malformed HTTP recovery | Partially implemented: api parsed all bodies as JSON; malformed 401 skipped session recovery and error detail shapes could fail formatting. | Status/safe messages retained for HTML/empty/malformed errors; abort/session guards preserved, bounded Retry-After metadata exposed, no retries added. Unit and actual browser recovery checks cover quota/invalid/unavailable/network cases and preserved prior content. |
| Title/Q&A screen integration | Outside A10 scope: title has no current frontend consumer; Q&A has API/loader tests but no mounted JSX consumer in main. | No new UI introduced. Q&A real-screen acceptance needs the team's consumer integration; loader recovery is verified. |
| A07 accuracy, A08 semantic grounding, A09 image quality | Outside A10 scope. | Existing acceptance ownership/checklists remain. No paid image generation, real microphone evaluation or prompt-quality rewrite performed. |

See [AI contract reference](journal-api-contracts.md#a10-ai-contract-reference) for
the per-feature schemas/budgets, public statuses, timeouts, retry policy, privacy,
persistence and frontend expectations. Test fixtures in pixel concurrency and
security tests were updated to supply evidence/current validated title shapes;
their original locking/concurrency assertions remain intact.
Generated summary/reflection null characters are rejected before PostgreSQL
text/JSONB writes; focused regressions retain invalid-output 502 semantics and
preserve prior results. Historical reflection source_dates semantics are unchanged.

### A10 verification environment and commands

Linux, Python 3.14, local Node/Vite and installed Brave. A new PostgreSQL 18 cluster
was initialized under /tmp/aurajournal-a10-pg on port 55432. Only the disposable
aurajournal_a10_test database and isolated test schemas were used. Application DB
and existing user/provider data were not touched. Backend pytest fixtures block
external HTTP/WebSocket traffic; SDK failures use in-memory transports.
The disposable cluster was stopped after verification; restart or provision a
disposable test database before repeating these commands.

```sh
# From src/backend; activate the existing repository .venv first.
export TEST_DATABASE_URL=postgresql+psycopg://a10_test@127.0.0.1:55432/aurajournal_a10_test
python -m pytest tests/test_ai_contract_boundaries.py tests/test_ai_failure_contract.py tests/test_ai_service.py tests/test_pixel_art_service.py tests/test_pixel_jobs.py -q
python -m pytest tests/test_ai_contract_boundaries.py tests/test_weekly_reflection_generator.py tests/test_weekly_generation_safety.py tests/test_security.py -q
python -m pytest tests -q
# From repository root:
npm run test:frontend
npm run build
npm run test:frontend:browser
node --test --test-concurrency=1 tests/frontend-ai-contract-browser.test.js
git diff --check
```

The optional browser command includes A10 recovery fixtures and skips when no
supported Chromium executable/BROWSER_BIN exists. Fixtures intercept API traffic;
they are real-browser checks of the frontend, not live provider end-to-end tests.
Sandbox restrictions on database sockets/Node child processes required running
those verification commands in the normal user context.

Final executed results:

| Verification | Actual result |
| --- | --- |
| Complete backend, final code | **1,102 passed, 1 skipped**, 256.50 seconds. The explicit administrator-URL role provisioning test was skipped; dependency deprecation warnings remain. |
| Focused persistence/boundary/weekly safety/security command above | **119 passed**, 33.03 seconds. |
| Earlier focused AI/SDK/pixel command above | **181 passed** before the final four null-character cases were added; those additional cases passed in the later focused/full runs. |
| npm run test:frontend | **210 passed**. |
| npm run build | Passed, 105 modules transformed. |
| npm run test:frontend:browser | **23 passed** in installed Brave, including the A10 suite. |
| A10 browser file independently | **4 passed**, covering five controlled failure modes and non-JSON session expiry. |
| git diff --check / diff against origin/main | Passed; no configured secret values, environment files, generated images or databases included. |

The first full backend run exposed a legacy security-test title mock; its shape
was corrected without weakening the concurrency assertion. A mobile account-menu
placement assertion failed once in the broader browser suite, then passed on both
an untouched origin/main snapshot and the final branch rerun. No layout changes
were made. There are no remaining failures in the final automated runs.

### A10 provider and manual acceptance limits

One explicit synthetic live check used fixture **A10-synthetic-1**, a temporary
isolated schema, the real authenticated ASGI application and configured Groq
adapters. Five HTTP features plus extraction-only made at most six Groq calls,
without automatic retries. Title, Q&A, recap and saved reflection returned 200
with validated contracts; the saved reflection GET also returned 200. Moment
extraction passed its structured/evidence checks. Entry summary returned a safe
503; a successful live summary contract is **not verified**. The test schema was
dropped afterward. No raw outputs, prompts, keys or provider diagnostic bodies
were recorded in this handoff. PixelLab/Deepgram were never called in this check.

Still pending: a browser connected to the real backend/providers using synthetic
fixtures (including a successful summary), review of actual Vietnamese/English
model content, and the team's Q&A screen integration. UI failure injection used
controlled browser responses, not real quota exhaustion. No provider quota was
deliberately exhausted. A07/A08 acceptance and cross-platform CI remain separate.


### A07 completed-recording update (2026-11-26)

The previously documented mixed-sentence omission was resolved on the supplied
replacement recording by routing completed audio to prerecorded Deepgram HTTP.
Four live authenticated API requests and one mixed CLI confirmation use the new
production adapter, retaining both languages. Latest CER is5.56% VI,4.11% EN,
3.10% mixed and18.18% natural speech; word substitutions still require review.
See [current verification](transcription-verification.md). Live streaming remains
separate. Real-provider silence and full Record-screen acceptance are still
manual follow-ups; this does not change the A08 semantic-grounding status.

## A08 grounding handoff (2026-11-27)

Reflection and Q&A retain their dated contracts and owner-scoped selection.
New prompt checks address unsupported clauses/question premises, mixed topics
and conflicting accounts. The shared [verification guide](journal-grounding-verification.md)
includes eight fictional cases, a default-offline evaluator and authenticated
DB-to-adapter tests. No migration or frontend change is needed.

The earlier A08 browser checklist remains a manual follow-up. The guide records
actual provider review separately from schema/date checks; fake outputs do not
establish model quality.

A08 live review used 12 explicitly authorized fictional Groq requests across two
budgets, without retries. All four Q&A cases passed review; reflection exposed
writing/language weaknesses refined in the prompt. The final language change
still needs live verification. A provider HTTP 413 now maps to the existing
safe too-long response, preserving journals and saved reflections. Successful
long-week model generation and the browser check remain pending; see the guide.

Verification: full backend run 1,180 passed / 2 existing skips; final focused
regression after the 413 change 214 passed; frontend tests 210 passed.
`git diff --check` passed. No application migration, commit or push performed.
