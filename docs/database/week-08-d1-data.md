# W8-D1: journal dates, migrations, and reflection storage

Scope: Sec + Data backend completion. Journal dates and reflection storage were
already implemented in revisions `0005` and `0006`; the current head is `0007`.
This work removes a duplicate response-schema declaration and adds a populated
reflection migration regression test. No schema revision is required.

## Data contract

- `journal_date` is a required calendar date. Omitted creation dates use the
  database's UTC+7 (`Asia/Bangkok`) transaction date. Explicit nulls and timestamp
  strings are rejected by the API. Editing the date preserves `created_at`.
- Legacy dates are derived from the UTC+7 creation day. Repeated upgrades preserve
  dates subsequently selected by users.
- Reflections belong to an authenticated owner and an inclusive seven-day period
  starting on any selected date. Storage contains a nonblank summary and exactly
  two nonblank questions, with one row per owner/start date.
- Regeneration retains `created_at` and refreshes `updated_at`. Failed generation,
  source-conflict checks, and failed commits preserve previously saved results.
- Saved reflections are snapshots. Later journal changes require explicit
  regeneration; concurrent successful generations use last-write-wins behavior.

## Verification

Status: W8-D1 backend data acceptance checks passed on November 16, 2026:
**107 passed** on disposable PostgreSQL 18 with Python 3.15. The run emitted
FastAPI deprecation warnings about `asyncio.iscoroutinefunction`; no tests failed.
The deployed database revision has not been checked or changed.

Run from `src/backend`, using the project virtual environment and a disposable
PostgreSQL database supplied through `TEST_DATABASE_URL`:

```sh
python -m pytest tests/test_database.py tests/test_journal_date.py tests/test_entry_dates_api.py tests/test_weekly_reflections.py tests/test_weekly_reflections_api.py tests/test_journal_history.py -q
```

The suite checks fresh and legacy upgrades, metadata parity, timezone boundaries,
date validation, owner isolation, storage constraints, persistence across app
instances, regeneration timestamps, and preservation after provider/commit errors.
The added migration test saves a reflection after `0005 → 0006`, upgrades to head
twice, then exercises downgrade/re-upgrade while verifying journal preservation.
Dropping `0006` intentionally loses saved reflections; upgrading does not restore
them. Downgrade tests run only on disposable data.

## Deployment and follow-ups

Follow [database migrations](migrations.md) to back up an existing database and
run `alembic upgrade head` before application startup. This verification does not
apply migrations to a deployed application database.

The following remain separate integration tasks:

- Implement and connect the weekly reflection provider; nonempty generation
  currently returns `503` when no provider is configured.
- Connect the frontend to saved reflection GET/POST endpoints and the two-question
  response contract. The current recap UI uses the older unsaved endpoint.
- Add journal-date selection and use `journal_date` for frontend day grouping;
  retain creation/update timestamps for record metadata.

See [weekly reflections](../weekly-reflections.md) for the provider contract and
API behavior. Automated verification uses fake providers, not live AI calls.
