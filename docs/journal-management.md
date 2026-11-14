# Journal-management API handoff (Person 1)

## Task tracking

| Task | Current handoff |
| --- | --- |
| B01 | Existing authenticated owner-filtered list; retain its newest-created-first ordering. |
| B02 | Implemented: GET `/api/entries/{entry_id}` uses the existing owner filter and returns the same 404 for foreign and missing entries. |
| B03 | Implemented: optional calendar dates at creation, content/date/both in partial PATCH, and `journal_date` in all entry responses. |
| B04 | Existing owner-only deletion returns 204 and cascades linked records. |
| B05 | Implemented: two independently registered/logged-in accounts exercise private create/list/detail/edit/delete, ownership spoof rejection, session persistence across app recreation, and unchanged foreign entries. Both accounts take the owner role. |
| B10 | Existing title, summary, and weekly-recap endpoints are tested with mocked providers. Real HTTPX network transports now fail the test immediately, including when an SDK would otherwise swallow connection errors. Transcription coverage is blocked until an authenticated transcription endpoint and its contract land. |

## Journal reads

Both GET `/api/entries` and GET `/api/entries/{entry_id}` require a valid account
session. The list stays ordered by `created_at DESC, id DESC`, preserving the
existing client contract. The detail endpoint returns one `EntryResponse`, never
an owner ID or account credentials. Missing/foreign resources both return 404;
anonymous, invalid, expired, revoked, and disabled sessions return 401. Invalid
UUIDs return 422. Private responses use `Cache-Control: no-store`.

## Journal dates and partial edits

POST `/api/entries` accepts `{content, journal_date?}`. Without a supplied date,
PostgreSQL supplies the current transaction's Asia/Bangkok calendar day. Entry
responses include `journal_date` as an ISO date in addition to existing fields.

PATCH `/api/entries/{entry_id}` accepts `{content? , journal_date?}` with at least
one field. For example, `{"journal_date":"2024-02-29"}` moves an entry to a calendar
day without rewriting its text. Supplied dates must be real `YYYY-MM-DD` dates;
nulls, timestamps, numeric dates, and extra fields are rejected with 422. Content
remains nonblank plain text of 1–5000 characters, trimmed on save. Omitted fields
retain their values. Dates are never converted as if they were timestamps.

Owners and `created_at` cannot be changed by clients. Real updates refresh
`updated_at`; no-op updates preserve it. Content changes clear saved AI output;
date-only changes preserve it. After integration with the pixel-art work, text
changes also remove the old image reference and stored file; date-only changes
preserve the image. Deletion retains that work's file cleanup. There is no new migration: use the existing
migration head (`0007` at this handoff). This PR does not migrate the app database.

Frontend date selection/grouping and weekly-recap filtering still need to consume
`journal_date` in their respective integration work. They currently use creation
timestamps. These backend changes deliberately preserve the list's old ordering.

## Frontend integration example

With the existing signed-in `api` helper, create and edit an entry like this:

```javascript
const entry = await api('/api/entries', {
  method: 'POST',
  body: { content: 'Finished our group presentation.', journal_date: '2026-11-14' },
});
const saved = await api(`/api/entries/${entry.id}`);
await api(`/api/entries/${entry.id}`, {
  method: 'PATCH',
  body: { journal_date: '2026-11-13' },
});
await api(`/api/entries/${entry.id}`, { method: 'DELETE' });
```

The helper supplies session credentials and mutation headers. Use the returned
entry on save, handle 401 by asking the user to sign in again, and treat 404 as an
unavailable entry. Empty lists return `[]`; successful deletion has no JSON body.

## Verification

Run backend tests from `src/backend` with `TEST_DATABASE_URL` pointing to a
disposable PostgreSQL database, then run frontend checks from the root:

```powershell
python -m pytest tests -q
# From the repository root:
npm run test:frontend
npm run build
```

`test_journal_lifecycle.py` covers the complete two-account workflow;
`test_entry_reads.py`, `test_entry_dates_api.py`, and `test_entry_mutations.py`
cover invalid sessions, date boundaries/validation, unchanged edits, persisted AI
invalidation, browser preflights, and cascading deletion. No live provider
credentials or paid requests are needed.

Verified on Windows after integrating main's pixel-art changes: **368 backend tests passed**, **69 frontend
tests passed**, and the production build passed. Backend tests emitted one
dependency deprecation warning from Starlette/AnyIO. Tests used isolated schemas
in `aurajournal_test`; the local application database was not migrated or reset.

## Tests without provider charges

`tests/conftest.py` blocks real HTTPX sync and async network transports for every
backend test. Use injected fake AI services, `httpx.MockTransport`, or in-process
ASGI clients. PostgreSQL connections are unaffected; database tests still require
the disposable `aurajournal_test` database and create/drop isolated schemas.

The guard is exercised without opening real connections. Existing mocked AI tests
cover valid output, invalid JSON/schema, unavailable providers, invalid credentials,
and authorization/error contracts. They do not prove model quality or replace a
separate, explicitly requested live evaluation with fictional input.

The integrated pixel-art provider and endpoint tests also use fakes/MockTransport;
the same HTTP guard applies to PixelLab calls. Date-only and combined text/date
edits are checked against real local image storage with fake generated PNGs.

B10 is **partially complete**, not fully complete or silently skipped: there is no
audio-upload/transcription endpoint in the current backend. Once it lands, add
tests for authenticated uploads, accepted formats/limits, silence, invalid audio,
provider failures, and normalized responses using a fake provider and fictional
audio fixtures. Do not introduce a dummy endpoint to claim that coverage exists.
