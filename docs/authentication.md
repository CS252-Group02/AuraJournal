# Accounts and private journals

This guide describes the implemented email/password account flow, its database
changes, and how journal access is restricted to the signed-in account.

## Quick start

Start PostgreSQL and activate your Python environment (`.venv` or your
`AuraJournal` Conda environment). From the repository root:

```powershell
python -m pip install -r src/backend/requirements.txt
python -m alembic -c src/backend/alembic.ini upgrade head
python -m alembic -c src/backend/alembic.ini current
npm start
```

The output of `alembic current` should show the current revision marked `(head)`.
Using `-c` lets Alembic find its configuration from the repository root. Without
`-c`, run Alembic commands from `src/backend`.

Migration is an explicit step; starting the app does not apply it.

Open `http://localhost:5173/register` and create an email/password account. Email
is trimmed and lowercased; passwords are 8–128 characters and are never trimmed.
Registration signs you in immediately. Each account starts with its own empty
journal. Login uses email, not a username. Google login, email verification,
password recovery, and account deletion are not implemented in this slice.

### Register, log in, and log out

1. Open `/register`, enter an email and password, and confirm the password.
   Confirmation is checked by the browser form; only email and password are sent
   to the API. A successful registration signs you in and opens `/`.
2. Write and save a journal entry. Reload the page: the session and saved entry
   should remain available.
3. Select **Log out**. Private content is cleared immediately, the server revokes
   that browser's session, and the login page appears.
4. Open `/login` and enter the same email and password to return to your journal.
   Another account sees its own entries instead.

Anonymous visitors to `/` are redirected to `/login`. Signed-in visitors to
`/login` or `/register` are redirected to `/`. The UI waits for its initial session
check before displaying private content. Failed network requests show an error
rather than being treated as a successful login or logout.

### Why Google sign-in is hidden

The first account implementation covers email/password only. The previous
**Continue with Google** buttons on both login and registration pages were
placeholders with no OAuth request or backend callback. They are hidden so the
screens only offer a working method; no functional Google authentication was
removed. The shared `GoogleButton` component remains in
`src/frontend/src/auth/AuthLayout.jsx`.

Google registration/sign-in is deferred. Showing the button alone would not add
authentication: a future implementation needs Google OAuth/OIDC configuration,
backend identity verification, callback protection, and an account-linking policy.

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
| GET `/api/entries/{entry_id}` | One owned entry; missing and foreign-owned entries both return `404` |
| PATCH `/api/entries/{entry_id}` | `{content}` updates an owned entry; returns the updated entry; clears the saved AI summary if content changes |
| DELETE `/api/entries/{entry_id}` | Deletes an owned entry and linked mood/image records; returns `204` |

Editing and deleting require the same session, origin, and CSRF checks as creating
entries. Missing entries and another account's entries both return `404`. Edits
accept 1–5000 characters, trim whitespace, and reject blank content and extra
fields. An edit preserves the entry ID and creation timestamp and updates
`updated_at`. A changed entry needs a new AI summary; unchanged text keeps the
existing summary. Deletion is permanent and is confirmed in the journal page.
CORS allows `PATCH` and `DELETE` as well as `GET` and `POST`, so the browser can
complete preflight before sending these requests.

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
failures. Throttling uses the request client IP supplied by the ASGI server;
configure Uvicorn's trusted-proxy settings deliberately if deploying behind a
reverse proxy. This is basic login throttling, not a complete internet-facing
abuse prevention system.

## Code walkthrough

| Location | Responsibility |
| --- | --- |
| `src/frontend/src/auth/Auth.jsx` | Session check, shared account state, protected/guest routes, login and logout |
| `src/frontend/src/lib/api.js` | Requests with cookies and CSRF headers; ignores responses from a previous session |
| `src/frontend/src/pages/LoginPage.jsx`, `pages/RegisterPage.jsx` | Email/password forms, validation, submission state, and errors |
| `src/backend/app/routers/auth.py` | Register, login, current-account, and logout endpoints |
| `src/backend/app/auth.py` | Argon2id verification, session creation/validation, cookies, and request-origin checks |
| `src/backend/app/models/auth.py` | Session-token digests and failed-login records |
| `src/backend/app/routers/entries.py` | Creates and lists journals using the verified account ID |
| `src/backend/migrations/versions/0003_auth_sessions.py` | Session/throttling tables and normalized-email enforcement |

```mermaid
sequenceDiagram
    participant UI as React
    participant API as FastAPI
    participant DB as PostgreSQL
    UI->>API: POST /api/auth/login {email, password}
    API->>DB: Find normalized email; check login attempts
    API->>API: Verify Argon2id password hash
    API->>DB: Save new session token digest and expiry
    API-->>UI: Account identity + HttpOnly session cookie
    UI->>API: GET /api/entries with cookie
    API->>DB: Resolve session and select entries for its user ID
    API-->>UI: Only that account's journals
```

The backend is the privacy boundary. React redirects and hidden controls improve
the interface, but every protected journal request is independently authenticated
by FastAPI. Journal content remains plain text in the UI; password hashes and
session-token digests are never included in account responses.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Alembic says `No 'script_location' key found` | Use the repository-root command with `-c src/backend/alembic.ini`, or change into `src/backend` first. |
| Requests return `503` | Check PostgreSQL is running, `.env` credentials are correct, and migration `0003` is applied. The API uses a generic response for database errors. |
| Requests return `401` | Sign in again. The cookie may be missing, invalid, expired, or revoked. |
| Requests return `403` | Check `FRONTEND_ORIGIN` and the CSRF header. Scripts must also supply the expected origin and header. |
| Requests return `429` | Wait for the interval indicated by `Retry-After`; restarting the API does not clear login failures. |
| Login succeeds but refresh loses the account | Use `localhost` consistently; verify cookies are allowed and `AUTH_COOKIE_SECURE` is false only for local HTTP. |
| Old shared journals do not appear | Expected: development-user records remain owned by the disabled development account, not a new registration. |

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
