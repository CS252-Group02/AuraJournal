# Journal-management API handoff (Person 1)

## Task tracking

| Task | Current handoff |
| --- | --- |
| B01 | Authenticated ownership is enforced across journal, AI, transcription, reflection, and image routes; auth regression coverage includes session and account isolation. |
| B02 | GET `/api/entries` supports literal keyword search, inclusive date filters, newest/oldest journal-date sorting, and an optional result limit. Detail reads use the owner filter and return the same 404 for foreign and missing entries. |
| B03 | Implemented: optional calendar dates at creation, content/date/both in partial PATCH, and `journal_date` in all entry responses. |
| B04 | Existing owner-only deletion returns 204 and cascades linked records. |
| B05 | Implemented: two independently registered/logged-in accounts exercise private create/list/detail/date-only edit/combined edit/delete, selected-date reads, ownership spoof rejection, persistence across app recreation, and unchanged foreign entries and saved weekly reflections. Both accounts take the owner role. |
| B10 | Title, summary, weekly-recap, saved-reflection, pixel-art, and live-transcription tests use fake providers. Real HTTPX and provider WebSocket connections fail tests immediately. The transcription endpoint and its offline tests have now landed; see [speech-to-text](speech-to-text.md). Live recognition quality remains separate verification. |

## Journal reads

Both GET `/api/entries` and GET `/api/entries/{entry_id}` require a valid account
session. The list supports `q`, `start`, `end`, `sort`, and `limit`, and defaults
to `journal_date DESC, created_at DESC, id DESC`. The detail endpoint returns one `EntryResponse`, never
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

Earlier verification after integrating main's pixel-art changes: **368 backend tests passed**, **69 frontend
tests passed**, and the production build passed. Backend tests emitted one
dependency deprecation warning from Starlette/AnyIO. Tests used isolated schemas
in `aurajournal_test`; the local application database was not migrated or reset.

### Current-schema CRUD verification (W8)

Base revision: `0332943`, including the W8-D1 date/reflection data handoff. The
existing private routes already work with schema head `0007`; this task extends
integration coverage without adding endpoints, migrations, or changing ordering.

The two-account lifecycle now checks entries sharing a date, owner-only list and
detail reads, and `/api/entries/by-date`. A date-only edit moves a leap-day entry
from `2024-02-29` to `2024-03-01`; the old day becomes empty for that owner while
the other account's entry stays on leap day. Combined edits, app recreation,
deletion, and matching foreign/missing-ID 404s are also exercised. Each account
has a distinct saved weekly reflection for the same period; CRUD preserves both
snapshots and never returns the other account's snapshot.

Use the project's declared dependencies before verification. The local Conda
environment initially had unsupported `websockets 17.3`; all 62 selected tests
stopped in fixture setup before any API assertions. Installing the existing
requirements restored `websockets 15.0.1` (and Pillow `12.3.0`) without weakening
the network guard or changing dependency declarations.

With the intended Python environment active, install from the repository root:

```powershell
python -m pip install -r src/backend/requirements.txt
```

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database as described in the
[repository test setup](../README.md#tests). Then run from `src/backend`:

```powershell
python -m pytest tests/test_journal_lifecycle.py tests/test_entry_reads.py tests/test_entry_dates_api.py tests/test_entry_mutations.py tests/test_calendar_api.py tests/test_weekly_reflections_api.py tests/test_pixel_art_api.py -q
python -m pytest tests -q
```

On Windows with Python `3.11.18`, the expanded two-user lifecycle passed both
owner roles (**2 passed**), and the selected journal/calendar/reflection/pixel-art
regression suite passed (**135 passed in 93.63 seconds**). All provider calls
were faked; test data stayed in isolated schemas in `aurajournal_test`.

The full backend suite was attempted but did not finish: it stalled at
the unchanged Deepgram test
`test_finish_timeout_closes_socket_and_releases_receiver`. Running
`tests/test_deepgram_service.py` separately reproduced the stall at that test;
the preceding 25 cases passed, and a 20-second faulthandler dump showed the event
loop waiting inside its `asyncio.run`. Both stalled runs were stopped. Neither
the Deepgram service nor its tests changed in this task, and the full suite must
not be reported as passing. This remains a separate transcription follow-up.

Verification is limited to the current schema. Historical upgrade testing stays
with the existing migration tests. The application database is not migrated or
reset; no frontend integration or AI generator work is included.

## Tests without provider charges

`tests/conftest.py` blocks real HTTPX sync/async transports and provider WebSocket
connections for every backend test. Use injected fake AI services, `httpx.MockTransport`, or in-process
ASGI clients. PostgreSQL connections are unaffected; database tests still require
the disposable `aurajournal_test` database and create/drop isolated schemas.

The guard is exercised without opening real connections. Existing mocked AI tests
cover valid output, invalid JSON/schema, unavailable providers, invalid credentials,
and authorization/error contracts. They do not prove model quality or replace a
separate, explicitly requested live evaluation with fictional input.

The integrated pixel-art provider and endpoint tests also use fakes/MockTransport;
the same HTTP guard applies to PixelLab calls. Date-only and combined text/date
edits are checked against real local image storage with fake generated PNGs.

Live transcription is now exposed through the authenticated
`/api/transcriptions/live` WebSocket, with offline tests for authentication,
formats/limits, silence, invalid audio, provider failures, and normalized events.
It is a streaming protocol, not a multipart upload endpoint. Real Vietnamese and
English recording evaluation remains pending; offline passing tests do not
establish recognition quality. See the [speech-to-text guide](speech-to-text.md).
