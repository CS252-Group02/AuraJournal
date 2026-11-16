# Calendar and streak APIs

All endpoints require the existing session cookie. Ownership comes from the session.
Calendar activity uses `journal_date`, now included in entry responses, rather than
`created_at`. The calendar and streak use the data team's UTC+7 convention
(`Asia/Bangkok`). Frontend integration should use these dates rather than regrouping
creation timestamps in the browser timezone.

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
payloads remain content-only; date editing belongs to B03. No schema migration is
required beyond the existing revision 0007. Frontend adoption is a separate task.
