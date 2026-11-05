# Development users and test entries

Email/password authentication is now implemented. Create usable accounts through
`/register`, not by inserting password hashes manually. See [authentication](authentication.md).

The seeded `development@aurajournal.local` user has a disabled `!disabled` password
marker and cannot log in. Its journals remain stored but inaccessible to new accounts.
The API derives journal ownership from the verified session; it never accepts a
client-selected `user_id`.

The following SQL examples are for database relationship tests only. SQL-created
users with `!disabled` markers also cannot log in. API/browser tests should register
accounts normally and verify isolation by logging out and switching accounts.

## Create an additional test user with SQL

Open `psql -h localhost -U aurajournal -d aurajournal` (adjust connection settings to match `.env`). Run:

```sql
INSERT INTO users (id, email, password_hash)
VALUES (gen_random_uuid(), 'tester@example.test', '!disabled')
RETURNING id, email, created_at, updated_at;
```

Use a different email for each user; email is unique. `!disabled` is an explicit unusable password marker, not a password hash or a password to type into the login screen. Authentication rejects disabled users.

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

These entries are available for database/ORM testing. They will not appear in another account's browser journal or `GET /api/entries`, which selects the verified account's entries. Creating an additional user does not switch the API owner. Do not add a client-selected `user_id` to work around this; ownership is enforced by the authenticated session.

When manually updating a user or entry with SQL, set `updated_at = now()` yourself. ORM writes through SQLAlchemy set it automatically.

## Verify account isolation

1. Register account A, create an entry, refresh, and confirm persistence.
2. Log out, register account B, and verify A's entries are absent.
3. Log back into A and verify its entry returns.
4. Confirm requests without a valid session return 401.
5. Use only the dedicated test database for automated checks; tests create and remove isolated schemas.
