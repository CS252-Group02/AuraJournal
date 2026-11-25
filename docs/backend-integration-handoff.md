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
- [ ] Media integration: save -> pending/processing -> ready -> authenticated PNG;
  repeat with generation disabled or unavailable. The journal must stay readable.
  For uncertain submission, verify the UI does not offer an unsafe second charge.
- [ ] Cross-account browser check: another login cannot load source journals or
  images; logout during generation/download must not populate the next account.

A07/A08/A10 handoff and these checks are still required before calling B09 fully
accepted with real providers. Shared HTTPS deployment (B10), deployed smoke tests
(B12), export/account deletion and new audio formats are outside this change.


## Local verification result (2026-11-25)

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
