# Calendar and streak APIs

All endpoints require the existing session cookie. Ownership comes from the session.
Calendar activity uses `journal_date`, now included in entry responses, rather than
`created_at`. Stored journal dates are preserved without timezone conversion.
The streak endpoint's `as_of` uses the data team's UTC+7 convention
(`Asia/Bangkok`). The Dashboard derives activity from the existing entry list and
uses browser-local today consistently; near midnight this can differ from the
server's `as_of`. See the [Dashboard timezone policy](calendar-and-streak.md#today-and-timezone-policy).

- `GET /api/calendar?year=2026&month=11`: returns `year`, `month`, and `days`, an
  ascending list of `{date: "2026-11-01", count: 0}` for every date of the month.
- `GET /api/stats/streak`: returns `as_of`, `timezone`, and `current_streak`.
  Distinct days count once; today may be unfinished, so a streak ending yesterday
  remains active. Missing both today and yesterday gives zero. Future days are ignored.
- `GET /api/entries/by-date?date=2026-11-14`: returns entry objects newest first,
  with creation time and UUID descending as tie breakers. Empty dates return `[]`.
- `GET /api/dashboard?year=2026&month=11`: returns `year`, `month`, `entry_count`,
  `active_days`, `as_of`, `timezone`, and `current_streak`. Counts describe the
  requested month; the streak always describes today.

Year and month are required, with year 1–9999 and month 1–12. Invalid inputs return
422, unauthenticated requests 401, and database failures 503. Existing create/edit
payloads support `journal_date` as a validated non-null calendar date; omission
uses the database default on create and preserves the value on edit. U05/U06
adds no API or schema changes and does not duplicate these statistics requests.
