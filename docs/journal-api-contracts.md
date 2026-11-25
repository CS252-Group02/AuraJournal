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
