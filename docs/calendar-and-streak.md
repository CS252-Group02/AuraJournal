# Per-user calendar and streak queries

Calendar and streak routes require a login session and derive the owner from that
session. All queries use `journal_date`. Creation timestamps do not determine the
calendar day of a backdated journal.

| GET endpoint | Result |
| --- | --- |
| `/api/calendar?year=2026&month=11` | Every date in the month, with a journal count including zeros |
| `/api/entries/by-date?date=2026-11-01` | Only the current owner's entries on that day |
| `/api/stats/streak?timezone=Asia/Ho_Chi_Minh` | Current streak and the comparison date in the selected timezone |
| `/api/dashboard?year=2026&month=11` | Monthly entry count, active days, and current streak |

The dashboard's streak is current, regardless of the month selected for its counts.
Multiple entries on one day count separately on the calendar but once in a streak.
If today has no entry, yesterday may finish the current streak. If neither day has
an entry, the streak is zero. Future dates and other owners do not contribute.
Leap days and month/year boundaries are ordinary consecutive calendar days.
Date edits and deletions affect subsequent queries immediately after commit.

## Dashboard integration (U05/U06)

The Dashboard reuses its existing authenticated `GET /api/entries` request. One
memoized day index feeds Calendar, streaks, monthly activity, selected-day
previews, weekly activity, mood analytics and recent entries. Month, mode and date
changes are local URL transitions; they do not fetch the same entries again.
**Refresh entries** rebuilds the derived activity after edits or deletions.
Account-keyed page mounting and the existing API auth-epoch checks prevent a
previous account's pending response from populating another account's Dashboard.
Loading and error states hide stale counts, links, highlights and recap controls.

Calendar and Dashboard share `calendarModel.journalDayKey` and
`groupEntriesByDay`; the existing `indexJournalDays` export is an alias. A valid
`journal_date` always wins over `created_at`, including backdated/future journals.
Only an absent/null legacy date falls back to an explicit-offset creation
timestamp converted to a browser-local day. Invalid supplied journal dates do
not fall back. Invalid timestamps, impossible dates and timestamps without an
offset are excluded from date statistics, with a visible notice linking to
History. Such entries remain included in the total entry count and accessible
through recent-entry/History links. Nothing rewrites stored dates.

### Today and timezone policy

Stored `journal_date` is a date, not a timestamp: its value is independent of
browser timezone. The Dashboard uses the shared browser-local day clock for
today, current/longest streaks, weekly activity and mood periods. The clock
updates at midnight and when the tab regains focus/visibility. This policy
matches the existing frontend and is disclosed beside the overview statistics.

The server's `/api/stats/streak` and `/api/dashboard` now accept an optional
IANA `timezone`, for example `?timezone=America/New_York` (or `&timezone=...`
when year/month are already present). They derive `as_of` in that zone and echo
its name. Omitting the parameter preserves the existing `Asia/Bangkok` default.
Pass the browser's timezone when comparing API streaks with local Dashboard
statistics; the distinct-day/yesterday/gap rules agree when the comparison date
agrees. For example, at `2026-11-19T00:30:00Z`, New York is still November 18
while Bangkok is November 19. Stored journal dates do not move between days.

The Dashboard continues using its entry list and browser-local clock, without
mixing server streaks into local highlights or making a redundant statistics
request. The database default for omitted journal dates remains unchanged, as do
author-selected dates. See [API parameters and examples](calendar-api.md).

### Counts and insights

- Current streak counts distinct consecutive journal dates ending today or
  yesterday; future dates cannot extend it. Longest streak and **Days journaled**
  count history through local today. Multiple journals count once per active day.
- **Journal entries** includes all saved entries, including future/undated ones.
  The today highlight reports entries *dated* today; it does not claim they were
  written or recorded today.
- The selected month's overview counts all entries and occupied dates in that
  month, matching the backend monthly count contract. Future-dated entries are
  included transparently. The most-active-date action selects that date and
  opens its existing journal preview. Ties show the earliest date and the number
  of tied dates, rather than implying a unique winner.
- Current-month comparisons use equal elapsed day numbers in both months. If
  today is March 31 and February has 28 days, both comparison counts use days
  1–28, and the caption says so. Completed historical months compare whole-month
  totals; future months omit comparisons. No percentages, achievements or
  emotional conclusions are inferred.
- Weekly activity still compares equal elapsed portions of Monday–Sunday weeks.
  AI recap generation remains explicit, uses the existing journal-date API
  contract, and retains source links and error/reload behavior. Neither calendar
  navigation nor these deterministic highlights triggers an AI request.

### Calendar selection and accessibility

URL parameters remain the owner of month, date and mode. A valid date-only URL
opens its month. When an explicit valid month conflicts with a date, the month
wins and no date is selected. Invalid parameters are ignored. Heatmap is the
default; an explicit `mode=mood` continues to work.

Month arrows and the month/year picker carry a selected day number into the new
month and clamp it at month end (January 31 → February 28 → March 28 in a
non-leap year). **Today** refreshes the local clock, selects today and opens its
month. Repeated/rapid month and mode actions compose against the latest pending
URL, including before Router rerenders; external navigation remains authoritative.
Unrelated query parameters survive these actions. Calendar inputs retain the
existing supported year range of 1000–9999; the backend accepts years 1–9999.

Single-entry dates still link directly to the journal. Ordinary activation also
stores the selected date in the current Dashboard history location; modified
clicks leave that location alone. Multiple/empty dates select the existing
preview section, with its date heading, count, bounded previews, links, empty
state and progressive 20-entry batches. History and Entry implementations are
unchanged.

The grid keeps one date in the tab sequence. Arrows move one day/week, Home/End
move within the current row, and Page Up/Down move months with day clamping.
Keyboard moves across months retain focus on the target date. Today, picker and
external URL selection update the tab stop without stealing focus from their
controls. Hover/focus transitions respect reduced-motion preferences; the
existing heatmap palette and responsive Dashboard layout remain in use.

### Mood availability

The inspected model stores optional `MoodRecord.valence` and `arousal` floats.
No application mood writer, categorical read API, numeric range, or supported
mapping to Calm/Happy/Blue/Reflective/Stressed was found. The database migration
documentation explicitly states that numeric ranges are not assumed. Live
database mood rows were not inspected; an optional numeric row would still not
establish a categorical label.

No classifier, thresholds, API change or migration is added. Calendar Mood mode
explains the absence and links back to Heatmap, analytics reports missing saved
classifications, and recent entries show **Mood unavailable**. Existing explicit
category inputs remain supported for future integration and tests. Decorative
card tones and numeric scores are never interpreted as moods.

### Verification

From the repository root:

```sh
npm run test:frontend
npm run build
```

Extended Calendar/Dashboard tests cover authoritative/legacy dates, malformed
dates, leap years and year boundaries, heatmap buckets, distinct-day streaks,
equal-period comparisons, refresh after date edits/deletion, URL transitions,
rapid actions, keyboard component handlers/focus refs, bounded previews, loading
and stale-data masking, account changes, mood absence and unchanged recap
behavior. Child-process timezone cases exercise UTC, Ho Chi Minh City and New
York/DST. No real AI calls are made. Component interaction tests use controlled
React hooks/ref handles, not a full browser DOM.

U05/U06 verification on November 19, 2026: **163 frontend tests passed** and the
Vite production build passed. The full suite ran outside the filesystem sandbox
because its existing timezone tests launch child Node processes. A regression
also matches frontend streaks against the published Alice/Bob backend calendar
sample expectations at the same `as_of` dates, including leap day.

That U05/U06 frontend-only verification changed no backend files. At that time,
the PostgreSQL suites were inspected but not rerun because `TEST_DATABASE_URL`
was not configured. The subsequent calendar API verification on November 20,
2026 ran the real isolated PostgreSQL suites: 87 focused tests passed, with
793 passed and 2 environment-dependent skips in the full backend run. See the
[current API verification](calendar-api.md#verification). Automated frontend
checks alone do not substitute for that backend evidence.

Browser checks still pending:

- Check narrow/mobile and desktop layouts, native month/date pickers, readable
  selected/today outlines and reduced-motion behavior.
- Use the keyboard across leap day/month boundaries and check screen-reader
  announcements, direct single-entry links, browser Back and modified clicks.
- Create/edit/backdate/delete real entries, refresh Dashboard, and check counts,
  selected-day lists, highlights and streaks. Confirm two signed-in accounts
  cannot access one another's journals and expired sessions hide private data.
- Change browser timezone near midnight; verify the displayed local policy and
  unchanged stored journal dates. Confirm weekly recap generation remains
  explicit and source links/error recovery still work.

## Repeatable database demo

From `src/backend`, activate the project virtual environment and set
`TEST_DATABASE_URL` to a disposable PostgreSQL database. Apply migrations to that
database using the [migration guide](database/migrations.md), then run:

```sh
python -m scripts.demo_calendar
python -m scripts.demo_calendar
```

The command seeds 12 deterministic journals across two disabled sample accounts
and prints JSON query results. It runs without the frontend, API server, or AI.
Repeated runs preserve existing samples and reject conflicting owner/entry IDs;
all sample writes use one transaction. The original Week 7 seed remains usable
independently with its eight journals. This expanded demo adds four backdated
entries whose creation timestamp is in November 2026 but journal dates are in 2024.

| Expected result | Alice | Bob |
| --- | --- | --- |
| Counts, Oct 30–Nov 3, 2026 (occupied days) | Oct 30: 1; Oct 31: 2; Nov 1: 1; Nov 3: 1 | Oct 31: 1; Nov 2: 1; Nov 3: 1 |
| Streak at Nov 1, 2, 3, 5 | 3, 3, 1, 0 | 1, 1, 2, 0 |
| Streak at March 1, 2024 | 3 | 1 |

Sample accounts cannot log in. The demo calls database services directly; API
tests register authenticated accounts to verify private calendar access.

```sh
python -m pytest tests/test_calendar_api.py tests/test_calendar_samples.py tests/test_journal_history.py tests/test_week7_samples.py -q
```

These tests cover empty/leap months, invalid requests, login requirements, owner
isolation, duplicate days, future dates, gaps, boundary dates, repeatable samples,
and calendar/streak changes after journal date edits and deletions.

Verified November 16, 2026 on disposable PostgreSQL 18: **31 tests passed**.
The demo was run twice and returned the same expected results. FastAPI emitted
Python 3.15 deprecation warnings; no checks failed.
