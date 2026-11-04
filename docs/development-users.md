# Development users and test entries

Authentication is not implemented yet. Login and registration screens are placeholders. These instructions create database records for local testing; they do not create usable login credentials.

## Default user for browser and API tests

After following [database setup and migration](database-migrations.md), migration `0002` has already created:

| Field | Value |
| --- | --- |
| ID | `00000000-0000-4000-8000-000000000001` |
| Email | `development@aurajournal.local` |
| Password marker | `!disabled` |

You do not need to register or create another user to test the app. Run `npm start` from the repository root and open `http://localhost:5173`. The unauthenticated journal API always creates and lists entries for this fixed user. `user_id` is not accepted in the create-entry request.

You can also send `POST http://localhost:8000/api/entries` with JSON `{"content":"My development entry"}` and read `GET http://localhost:8000/api/entries`. There is no token or password to provide. This shared-owner behavior is intended for local development; it does not provide user isolation between people accessing the app.

## Create an additional test user with SQL

Open `psql -h localhost -U aurajournal -d aurajournal` (adjust connection settings to match `.env`). Run:

```sql
INSERT INTO users (id, email, password_hash)
VALUES (gen_random_uuid(), 'tester@example.test', '!disabled')
RETURNING id, email, created_at, updated_at;
```

Use a different email for each user; email is unique. `!disabled` is an explicit unusable password marker, not a password hash or a password to type into the login screen. Future authentication must reject disabled users until they receive real credentials.

Add an entry for that user:

```sql
INSERT INTO journal_entries (id, user_id, content)
SELECT gen_random_uuid(), id, 'Entry for the additional test user'
FROM users WHERE email = 'tester@example.test'
RETURNING id, user_id, content;
```

Inspect it with:

```sql
SELECT u.email, e.id, e.content, e.created_at, e.updated_at
FROM users u
JOIN journal_entries e ON e.user_id = u.id
WHERE u.email = 'tester@example.test';
```

These entries are available for database/ORM testing. They will not appear in the current browser journal or `GET /api/entries`, which always selects the fixed development owner. Creating an additional user does not switch the API owner. Do not add a client-selected `user_id` to work around this; authenticated ownership will be implemented separately.

When manually updating a user or entry with SQL, set `updated_at = now()` yourself. ORM writes through SQLAlchemy set it automatically.

## Verify the temporary flow

1. Create an entry in the browser and confirm it appears after reloading and restarting the backend.
2. Inspect the entry in PostgreSQL and confirm its `user_id` is the fixed UUID above.
3. Create the additional user and entry using the SQL examples; confirm the current journal API does not return that user's entry.
4. Use the dedicated test database for automated checks, never your app database. The tests create and remove isolated schemas and apply the migrations to each one.

The default development user is part of the temporary app flow. Keep it in place while using the journal API. Deleting any user cascades to that user's entries, moods, and images.
