# Database setup and migrations

> Security update: current schema head is **0005**. See [security hardening](../security-hardening.md) for the current password policy, independent account/IP limits, request quotas, and separate migration/runtime roles.

AuraJournal uses PostgreSQL 14+ and Alembic. Start PostgreSQL and install `src/backend/requirements.txt` in your virtual environment first. Alembic reads the repository-root `.env`; an exported `DATABASE_URL` takes precedence. Commands below run from `src/backend`, with the virtual environment active.

Current head is **0005**, which adds shared request budgets and independent login indexes. See [authentication](../authentication.md). Existing development entries stay inaccessible to real accounts.

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

- `0003_auth_sessions.py`: revocable sessions, login attempts, normalized emails.
- `0004_ai_summary.py`: saved AI summary, reflection question, and generation timestamp.
- `0005_security_limits.py`: shared request budgets and independent login indexes.

An empty database runs all migrations with `python -m alembic upgrade head`. To inspect the chain, run `python -m alembic history`.

## Existing database

If `python -m alembic current` reports `0005` and the seven application tables match the models, the database is current. Databases at `0002`, `0003`, or `0004` need `python -m alembic upgrade head`. These upgrades preserve existing journal content; back up important data first. Do not stamp it back to an earlier revision.

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

See [development users](development-users.md) for the temporary owner and additional test users.
