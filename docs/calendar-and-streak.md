# Per-user calendar and streak queries

Calendar and streak routes require a login session and derive the owner from that
session. All queries use `journal_date`. Creation timestamps do not determine the
calendar day of a backdated journal.

| GET endpoint | Result |
| --- | --- |
| `/api/calendar?year=2026&month=11` | Every date in the month, with a journal count including zeros |
| `/api/entries/by-date?date=2026-11-01` | Only the current owner's entries on that day |
| `/api/stats/streak` | Current streak and the server's UTC+7 comparison date |
| `/api/dashboard?year=2026&month=11` | Monthly entry count, active days, and current streak |

The dashboard's streak is current, regardless of the month selected for its counts.
Multiple entries on one day count separately on the calendar but once in a streak.
If today has no entry, yesterday may finish the current streak. If neither day has
an entry, the streak is zero. Future dates and other owners do not contribute.
Leap days and month/year boundaries are ordinary consecutive calendar days.
Date edits and deletions affect subsequent queries immediately after commit.

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
