# Create and test a local database

This guide walks through initializing PostgreSQL, creating sample users and journals, and checking how the data is related. The SQL examples are run at the `psql` prompt. They use the dedicated `aurajournal_test` database so the sample data stays separate from your app database.

## 1. Start PostgreSQL and prepare the test database

Make sure your local PostgreSQL server is running. If you have not created the project databases yet, follow the role/database setup in the root [README](../README.md).

From the repository root, activate the virtual environment and apply the current schema to the test database:

```sh
source .venv/bin/activate
cd src/backend
export DATABASE_URL='postgresql+psycopg://aurajournal:aurajournal@localhost:5432/aurajournal_test'
python3 -m alembic upgrade head
python3 -m alembic current
```

The revision should be `0003`. This creates the schema and the temporary development user. These commands use the sample credentials from `.env.example`; adjust them if your PostgreSQL role or password differs.

If the database already contains data, read [database migration instructions](migrations.md) before applying migrations. Do not use the test database for important data.

## 2. Open the database in psql

Keep that terminal open, then open another terminal and connect:

```sh
psql -h localhost -U aurajournal -d aurajournal_test
```

Inside `psql`, check the selected database and tables:

```sql
SELECT current_database();
\dt
SELECT id, email FROM users ORDER BY email;
```

You should see the six application tables (`users`, `journal_entries`, `mood_records`, `journal_images`, `auth_sessions`, `login_attempts`), the Alembic version table, and the seeded development user.

## 3. Create three test users

Run once in `psql`:

```sql
INSERT INTO users (id, email, password_hash)
VALUES
    (gen_random_uuid(), 'alice@example.test', '!disabled'),
    (gen_random_uuid(), 'bob@example.test', '!disabled'),
    (gen_random_uuid(), 'carol@example.test', '!disabled');
```

Inspect their IDs and timestamps:

```sql
SELECT id, email, created_at, updated_at
FROM users
WHERE email LIKE '%@example.test'
ORDER BY email;
```

The unique ID for each user is the value referenced by `journal_entries.user_id`. `!disabled` is only a placeholder; these SQL-created users cannot log in. Register through the browser to create usable accounts.

## 4. Add three journals for each test user

Run once in `psql`:

```sql
INSERT INTO journal_entries (id, user_id, content)
SELECT gen_random_uuid(), u.id, j.content
FROM users AS u
CROSS JOIN (VALUES
    ('I felt happy after finishing my assignment.'),
    ('I felt stressed about the upcoming exam.'),
    ('I enjoyed spending time with my friends.')
) AS j(content)
WHERE u.email IN (
    'alice@example.test',
    'bob@example.test',
    'carol@example.test'
);
```

This creates nine journals: each user gets one entry for each sample sentence. PostgreSQL generates each journal UUID. `created_at` and `updated_at` get their database defaults.

## 5. Check who owns each journal

```sql
SELECT u.email, e.id AS journal_id, e.content, e.created_at, e.updated_at
FROM users AS u
JOIN journal_entries AS e ON e.user_id = u.id
WHERE u.email LIKE '%@example.test'
ORDER BY u.email, e.created_at, e.id;
```

Count entries for each test user:

```sql
SELECT u.email, COUNT(e.id) AS journal_count
FROM users AS u
LEFT JOIN journal_entries AS e ON e.user_id = u.id
WHERE u.email LIKE '%@example.test'
GROUP BY u.email
ORDER BY u.email;
```

Each should have three. The `user_id` foreign key means a journal cannot point to a user that does not exist.

## 6. Try editing and roll it back

The transaction lets you inspect an edit, then undo it safely:

```sql
BEGIN;

UPDATE journal_entries
SET content = 'Temporary edited journal text', updated_at = now()
WHERE id = (
    SELECT e.id
    FROM journal_entries AS e
    JOIN users AS u ON u.id = e.user_id
    WHERE u.email = 'alice@example.test'
    ORDER BY e.created_at, e.id
    LIMIT 1
)
RETURNING id, content, updated_at;

ROLLBACK;
```

`RETURNING` displays the edited row immediately. `ROLLBACK` discards the edit. To keep an edit, use `COMMIT` instead and run the query from step 5 again. For direct SQL updates, set `updated_at = now()` yourself.

## 7. Try deleting a user and inspect cascading deletes

This transaction shows how deleting a user removes their journals; then rollback restores the records:

```sql
BEGIN;

DELETE FROM users
WHERE email = 'bob@example.test'
RETURNING id, email;

SELECT COUNT(*) AS bob_journals_remaining
FROM journal_entries AS e
JOIN users AS u ON u.id = e.user_id
WHERE u.email = 'bob@example.test';

ROLLBACK;
```

The delete returns Bob's row, and the count inside the transaction is zero because the foreign key cascades to his journals. `ROLLBACK` restores both. To permanently delete Bob and his related journal, mood, and image records, use `COMMIT` instead; this is permanent.

## 8. Run the automated tests

Exit `psql` with `\q`. In a terminal from `src/backend`, run the tests against the dedicated test database:

```sh
TEST_DATABASE_URL='postgresql+psycopg://aurajournal:aurajournal@localhost:5432/aurajournal_test' \
python3 -m pytest tests -q
```

The automated tests create temporary schemas and remove them afterward. Your manually inserted test users and journals stay in the normal `public` schema.

## What you will see in the browser

The journal API requires a valid account session and only returns that account's
entries. SQL-created users above have disabled passwords; their records are for
relationship tests only. Register accounts through the browser for login and
isolation tests. See [authentication](../authentication.md).
