# Database setup and migrations

AuraJournal uses PostgreSQL 14+ and Alembic. Start PostgreSQL and install `src/backend/requirements.txt` in your virtual environment first. Alembic reads the repository-root `.env`; an exported `DATABASE_URL` takes precedence. Commands below run from `src/backend`, with the virtual environment active.

Current head is **0005**, which adds the required `journal_date` field. Revision `0003` introduced authentication and `0004` added saved AI summaries. See [authentication](../authentication.md). Existing development entries stay inaccessible to real accounts.

## Fresh database

Use an empty app database configured in `.env`, then run:

```sh
python -m alembic upgrade head
python -m alembic current
```

The current revision should be `0005`. Return to the repository root and run `npm start`. The backend no longer creates or modifies tables at startup.

## Version history

```text
<base> → 0001 → 0002 → 0003 → 0004 → 0005 (head)
```

- `0001_legacy_entries.py`: the initial journal table with integer IDs, content, and creation time.
- `0002_journal_schema.py`: converts entry IDs to UUIDs, adds required user ownership and update timestamps, and creates users, mood records, and journal images. It also seeds the development user.
- `0003_auth_sessions.py`: adds revocable sessions, login throttling, and normalized-email enforcement.
- `0004_ai_summary.py`: adds the saved summary, reflection question, and generation timestamp to each entry.
- `0005_journal_date.py`: adds a required journal day, backfills existing rows using UTC+7, and supplies a database default for new entries.

An empty database runs the complete chain with `python -m alembic upgrade head`. To inspect it, run `python -m alembic history`.

## Existing database

If `python -m alembic current` reports `0005` and the six application tables match the models, the database is current. For a tracked database at `0002`, `0003`, or `0004`, stop the backend, back up its data, then run `python -m alembic upgrade head`. Revision `0005` fills the new date column while preserving entry IDs, owners, content, timestamps, and saved AI results. Re-running the command at head preserves all existing dates. Do not stamp the database back to an earlier revision.

A database already recorded at `0001` only needs `python -m alembic upgrade head`, after a backup.

### Original journal table without migration tracking

Stop the backend and back up the database before upgrading. With the default local settings:

```sh
pg_dump -h localhost -U aurajournal -d aurajournal -Fc -f aurajournal-backup.dump
```

Adjust connection settings to match `.env`. Store the backup securely outside version control, and verify a restore into a separate scratch database before migrating important data.

Connect using `psql -h localhost -U aurajournal -d aurajournal` and inspect:

```sql
\d journal_entries
\dt
SELECT count(*) FROM journal_entries;
```

Only use the stamp below if the database has the original schema: an auto-incrementing integer primary key `id`, non-null `content varchar(5000)`, and non-null `created_at timestamp with time zone DEFAULT now()`. The `users`, `mood_records`, and `journal_images` tables must not already exist, and no other tables should reference entry IDs. The database must not have an applied Alembic revision.

From `src/backend`, run:

```sh
python -m alembic stamp 0001
python -m alembic upgrade head
python -m alembic current
```

Stamping only records that the initial schema already exists; it does not create or verify tables. Do not stamp directly to `head` to bypass an incompatible schema.

The upgrade preserves entry content and creation times, generates new UUIDs, initializes `updated_at` from `created_at`, and assigns existing entries to the development user. Original numeric IDs are not retained. Migration `0002` refuses a downgrade because it cannot recover those IDs; restore a pre-migration backup to return to the initial schema.

Migrations are an explicit setup/deployment step, not part of `npm start`.

## Journal dates and timestamps

The MVP uses `Asia/Bangkok` (UTC+7) for journal days. `journal_date` is a required PostgreSQL `DATE` describing the day an entry belongs to. `created_at` and `updated_at` remain timezone-aware timestamps describing when the record was created and changed.

Revision `0005` first adds a nullable column, fills it from `(created_at AT TIME ZONE 'Asia/Bangkok')::date`, then applies `NOT NULL` and the default `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date`. The old schema recorded no separate journal day, so the backfill assumes the local creation day. New ORM and direct SQL inserts that omit the date receive the current UTC+7 transaction date, regardless of the database session's timezone. Historical/test inserts should set `journal_date` explicitly.

Creation timestamps stay unchanged when the journal date is edited. ORM updates refresh `updated_at`; direct SQL must set it explicitly. This migration does not add a timestamp trigger. The current HTTP entry payload still accepts only `content`; date selection in API requests/responses is the Backend integration step for B03. A future API should pass a supplied calendar date through without treating it as a timestamp.

After the model change, run migration `0005` before restarting the backend. To verify the local database in `psql`:

```sql
SELECT id, journal_date, created_at, updated_at
FROM journal_entries
ORDER BY created_at;

SELECT count(*) AS missing_journal_dates
FROM journal_entries
WHERE journal_date IS NULL;
```

The missing-date count should be zero. `python -m alembic upgrade head` can be run again to verify it is a no-op. Schema changes and backfill run in the existing PostgreSQL transaction, and Alembic records the revision after a successful upgrade.

On the disposable test database, run `python -m pytest tests/test_journal_date.py tests/test_database.py -q` with `TEST_DATABASE_URL` configured. These tests cover fresh installation, legacy data, the UTC+7 midnight boundary, session-independent defaults, required dates, ORM timestamps, repeated upgrades, and downgrade/re-upgrade.

Downgrading to `0004` drops `journal_date` and loses dates selected by users. Re-upgrading derives dates from `created_at` again. Use a backup to recover selected dates, and keep downgrade exercises on disposable data.

## Schema and code organization

- `app/config.py`: database URL, frontend origin, and temporary development owner.
- `app/database.py`: PostgreSQL engine and request-scoped sessions.
- `app/models/base.py`: declarative base and shared timestamp columns.
- `app/models/`: one file per table, with ORM relationships. Its `__init__.py` imports and exports the models so SQLAlchemy and Alembic discover all tables.
- `app/schemas/entries.py`: request and response validation; entry responses expose UUID strings and timestamps.
- `app/routers/`: create/list journal endpoints. `app/main.py` composes the app.
- `migrations/versions/`: the initial schema and subsequent changes, linked by revision IDs. New schema changes add migration files rather than replacing applied revisions.

Users have many entries. Each entry may have zero or one mood record and zero or one image; unique foreign keys enforce these limits. PostgreSQL cascades deletions from user to entry to mood/image. Creation timestamps default in PostgreSQL; SQLAlchemy initializes and updates `updated_at` on ORM writes. Raw SQL updates must explicitly set `updated_at = now()`.

UUIDs are generated by SQLAlchemy for new ORM records. Direct SQL inserts must supply IDs, for example with `gen_random_uuid()`. There is no assumed numeric range for valence or arousal yet. Database content uses `text`, while the current journal API continues accepting 1–5000 characters and rejects blank content.

## Future migrations

From `src/backend`:

```sh
python -m alembic revision --autogenerate -m "describe schema change"
```

Review the generated operations and data conversion carefully before running `python -m alembic upgrade head`. Commit migration files with their corresponding model changes. Keep already-shared/applied migrations unchanged and add a new revision for each subsequent change. Back up data before schema changes.

See [development users](../development-users.md) for the temporary owner and additional test users.
