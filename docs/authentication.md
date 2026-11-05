# Accounts and private journals

Run `python -m pip install -r src/backend/requirements.txt`, then from
`src/backend` run `python -m alembic upgrade head`. The current revision is **0003**.
Return to the repository root and run `npm start`. Migration is an explicit step;
starting the app does not apply it.

Open `http://localhost:5173/register` and create an email/password account. Email
is trimmed and lowercased; passwords are 8–128 characters and are never trimmed.
Registration signs you in immediately. Each account starts with its own empty
journal. Login uses email, not a username. Google login, email verification,
password recovery, and account deletion are not implemented in this slice.

Existing journals remain assigned to their existing owners. The development user
and SQL-created users with `!disabled` password markers cannot log in; their entries
are preserved but are not exposed to real accounts. Never assign those entries to
a registering user automatically.

## Sessions and local setup

Sessions last seven days from issuance, survive application/browser restarts, and
are revoked immediately on logout. Each browser can have its own session.
Only a SHA-256 digest of a cryptographically random session token is stored in
PostgreSQL. Passwords are hashed using Argon2id. Tokens are sent only in a
host-only HttpOnly cookie, never in response JSON or localStorage. Expired session
rows are removed when a new session is issued.

Use `localhost` consistently for both frontend and API; do not mix it with
`127.0.0.1`. The defaults are frontend `http://localhost:5173` and API
`http://localhost:8000`. Set `FRONTEND_ORIGIN` in backend `.env` and `VITE_API_URL`
in `src/frontend/.env.local` if these change. Restart Vite after changing its env.

`AUTH_COOKIE_SECURE=false` permits local HTTP. For deployment use HTTPS and
`AUTH_COOKIE_SECURE=true`. Keep frontend and API on the same site; cross-site
cookie deployments need a separately reviewed configuration.

## API

| Endpoint | Input / result |
| --- | --- |
| POST `/api/auth/register` | `{email, password}` → `201 {id, email}`, session cookie; duplicate email → `409` |
| POST `/api/auth/login` | `{email, password}` → `200 {id, email}`, session cookie; invalid/disabled credentials → `401` |
| GET `/api/auth/me` | `{id, email}`; anonymous/invalid/expired session → `401` |
| POST `/api/auth/logout` | Send `{}`; revokes session, clears cookie, returns `204` even if already logged out |
| POST `/api/entries` | `{content}` → entry owned by the verified current user |
| GET `/api/entries` | Only the verified current user's entries |

All state-changing requests require `Origin` equal to `FRONTEND_ORIGIN`,
`X-AuraJournal-CSRF: 1`, and JSON content type. The shared frontend API client
supplies these headers and includes cookies. API scripts and Swagger requests
must supply the headers too; visiting `/docs` on the API host alone does not
bypass the origin policy. CORS allows credentials only for the exact configured
frontend origin. Never use `*` with credentialed access.

Five failed login attempts for one normalized email/client IP within fifteen
minutes cause subsequent attempts to return `429` with `Retry-After`. Attempts
are database-backed and serialized per identity across backend workers. Expired
attempts are cleaned during login; successful login clears that identity's
failures. The app does not trust forwarded IP headers by default. This is basic
login throttling, not a complete internet-facing abuse prevention system.

## Migrations and verification

Migration `0003` adds sessions, throttling, and normalized-email enforcement without
deleting accounts or journals. It refuses to proceed if existing emails collide
after trimming/lowercasing. Resolve such duplicates deliberately, then rerun it.
Back up important data before migrating. Downgrading `0003` removes sessions and
login-attempt history; downgrading `0002` remains unsupported.

Backend tests require the disposable `aurajournal_test` database and cover account
isolation, invalid/expired/revoked sessions, server restarts, CSRF/CORS, migration
preservation, and throttling. Frontend request/race tests run with
`npm run test:frontend`; production assets build with `npm run build`.

In the browser, register account A, save an entry, refresh, and verify it remains.
Log out, register account B, and verify B has no A entries. Log back into A and
verify its journal returns. No password hashes, session tokens, or journal bodies
should appear in server logs or frontend error details.
