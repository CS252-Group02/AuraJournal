# Calendar and streak APIs

All endpoints require the existing session cookie. Ownership comes from the
session, never from a supplied owner ID. Queries reuse the journal-history
services; stored `journal_date` determines activity, including backdated entries.
Creation timestamps and the database session timezone do not move those dates.

## Endpoints

| GET endpoint | Result |
| --- | --- |
| `/api/calendar?year=2026&month=11` | `year`, `month`, and every date in ascending `days`, including `{date, count: 0}` for empty days |
| `/api/entries/by-date?date=2026-11-20` | Current owner's entry objects for that exact journal date; `[]` when empty |
| `/api/stats/streak?timezone=Asia/Ho_Chi_Minh` | Server-computed `as_of`, requested `timezone`, and `current_streak` |
| `/api/dashboard?year=2026&month=11&timezone=Asia/Ho_Chi_Minh` | Monthly `entry_count`/`active_days` plus the same current-streak fields |

Selected-day entries sort by creation time descending, then UUID descending for
stable ties, matching the common date-range query. Entry objects retain the
existing response shape, including `journal_date`. No CRUD endpoint or SQL layer
is duplicated.

Calendar counts include every saved entry dated in the requested month, including
future-dated entries. Multiple entries count separately in `entry_count` and the
daily count, but once in `active_days` and a streak. Dashboard monthly totals
refer to the requested month; its streak always refers to the current local date,
even when viewing an old or empty month.

## Today, timezone and streak

`timezone` is optional on `/api/stats/streak` and `/api/dashboard`. It accepts an
IANA timezone name, up to 100 characters, such as `Asia/Ho_Chi_Minh`,
`America/New_York` or `Pacific/Kiritimati`. If omitted, the existing
`Asia/Bangkok` default remains for compatibility. Bangkok and Ho Chi Minh City
both use the application's UTC+7 convention. The response echoes the selected
name. No profile setting, schema migration or timezone conversion of journal
dates is involved.

The server reads an aware UTC clock and derives `as_of` in the selected timezone.
Clients cannot choose an arbitrary comparison date. A browser caller wanting its
local comparison day can pass
`Intl.DateTimeFormat().resolvedOptions().timeZone` as `timezone`.

Current-streak rules:

- If today has an entry, count consecutive distinct dates backwards from today.
- Otherwise, if yesterday has an entry, count backwards from yesterday.
- If neither has an entry, return zero. An empty account also returns zero.
- Ignore future-dated entries and other users' entries. Multiple entries on one
  day cannot extend the streak or fill another user's gap.
- Count calendar days, not 24-hour intervals. Month/year boundaries, leap days,
  and daylight-saving transitions do not break consecutive dates.
- The query is not restricted to the month displayed. A long streak can cross
  multiple months or years. Edits, backdating and deletion affect later requests.

For example, at `2026-11-20T00:30:00Z`, New York's `as_of` is November 19 while
Ho Chi Minh City's is November 20. That difference can change the streak, but
never the selected-day entries or per-day counts. Use the same timezone when
comparing API streaks with a browser-derived streak.

The existing Dashboard derives its data from the authenticated entry list and
uses its shared browser-local clock. It does not gain a redundant statistics
request. See [Dashboard timezone policy](calendar-and-streak.md#today-and-timezone-policy).

## Validation and errors

- Year/month are required on calendar/dashboard: year 1-9999, month 1-12.
- Selected dates must be real, exact `YYYY-MM-DD` dates. Timestamps, Unix times,
  compact dates, ISO-week dates and missing/invalid dates return 422.
- Missing/expired authentication returns 401; invalid timezone/year/month returns
  422; database failures return a safe 503 without SQL or credentials.
- Responses use `Cache-Control: no-store`. No endpoint grants access using a
  client-supplied user ID.

Create/edit payloads continue to support validated non-null `journal_date`.
Omission uses the database default on create and preserves the date on edit.
The read-by-date query now shares the same calendar-date validator.

## Verification

Verified on 2026-11-20: **87 focused calendar/date tests passed** and the full
backend suite returned **793 passed, 2 skipped**. The skips are the existing
administrator-only database-role test and Windows symlink-privilege test.
Database checks used isolated schemas in `aurajournal_test`; the application
database was not migrated or seeded. No external AI calls were made.

From `src/backend`, configure `TEST_DATABASE_URL` to the disposable PostgreSQL
instance described in the README, then run:

```sh
python -m pytest tests/test_calendar_api.py tests/test_journal_history.py tests/test_calendar_samples.py tests/test_entry_dates_api.py -q
```

These tests use real isolated PostgreSQL schemas and authenticated API requests,
with a controlled clock for midnight and DST scenarios. They cover empty/leap
months, stable day lookup, privacy, invalid dates/timezones, timezone-specific
streaks, long streaks, minimum/maximum supported dates, future entries,
backdating/deletion and safe database errors. No AI key or external provider is
required. The [repeatable sample demo](calendar-and-streak.md#repeatable-database-demo)
remains available.
