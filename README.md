# AuraJournal

A small React + FastAPI + PostgreSQL journal app. It is a tested starting point for the MVP, not a finished product.

## How it works

`src/frontend/src/pages/JournalPage.jsx` sends journal requests to FastAPI through `lib/api.js`. The backend separates database setup, models, validation schemas, and routes. PostgreSQL stores users, journal entries, mood records, and journal images; the journal flow authenticates accounts and scopes entries to the signed-in user. Tests are in `src/backend/tests/`.

## Project structure

```text
.
├── .env.example                 # Backend settings template
├── .github/workflows/ci.yml     # Automated checks on pushes and pull requests
├── .gitignore                   # Keeps local config and build files out of Git
├── docs/application-flow.md     # Frontend, backend, and test flow
├── docs/database/               # Database setup, migrations, and test data
│   ├── create-and-test.md
│   └── migrations.md
├── docs/development-users.md    # Temporary user and additional test users
├── docs/poc-to-mvp-plan.md      # How to grow the PoC into the MVP
├── docs/security-rules.md       # Journal/account rules and current security gaps
├── package.json                 # Root npm dependencies and scripts
├── package-lock.json            # Locked npm dependencies
├── scripts/
│   ├── start-backend.js          # Cross-platform backend launcher
│   └── start.js                  # Dependency bootstrap and service runner
└── src/
    ├── backend/
    │   ├── app/                 # App setup, database, models, schemas, and routers
    │   ├── alembic.ini          # Migration configuration
    │   ├── migrations/          # Versioned PostgreSQL schema
    │   ├── requirements.txt     # Python dependencies
    │   └── tests/               # PostgreSQL API tests
    └── frontend/
        ├── .env.example         # Frontend API URL template
        ├── README.md            # Frontend architecture and contributor guide
        ├── index.html           # Page loaded by the browser
        ├── vite.config.js       # Vite React setup
        └── src/
            ├── main.jsx         # React entry point
            ├── pages/           # Existing route screens
            │   ├── JournalPage.jsx
            │   ├── RecordPage.jsx
            │   ├── LoginPage.jsx
            │   └── RegisterPage.jsx
            ├── auth/            # Session state, guards, and shared auth UI
            │   ├── Auth.jsx
            │   └── AuthLayout.jsx
            ├── lib/
            │   └── api.js       # Cookie/CSRF requests and session isolation
            ├── styles/          # Ordered stylesheet entry and existing rules
            │   ├── index.css
            │   ├── global.css
            │   ├── journal.css
            │   ├── login.css
            │   └── record.css
            └── assets/          # Record fonts and their license
```

See the [frontend contributor guide](src/frontend/README.md) for directory
responsibilities, component placement, CSS ordering, and validation instructions.

## Backend app layout

```text
app/
├── main.py                # FastAPI app and router registration
├── config.py              # Settings and development owner
├── database.py            # Engine and session dependency
├── models/
│   ├── __init__.py         # Model imports and exports
│   ├── base.py             # Declarative base and timestamp mixins
│   ├── user.py
│   ├── journal_entry.py
│   ├── mood_record.py
│   └── journal_image.py
├── schemas/
│   ├── __init__.py
│   └── entries.py          # API input/output models
└── routers/
    ├── __init__.py
    └── entries.py          # Journal endpoints
```

## Setup

Install Python 3.10+, Node.js 20+, and PostgreSQL 14+. First open PostgreSQL's `psql` command prompt. The SQL below must be entered at the `psql` prompt (which usually ends in `=#`), not at Bash, PowerShell, or another system shell.

**Linux:** With PostgreSQL installed and running, open `psql` as its administrative user:

```sh
sudo -u postgres psql
```

Fedora may need its PostgreSQL cluster initialized and localhost password authentication configured first.

**macOS:** With PostgreSQL installed and running, Homebrew users can connect to the default database with:

```sh
psql postgres
```

If your installation uses a `postgres` database role instead, connect with `psql -U postgres -d postgres` and enter that role's password when prompted.

**Windows:** Open **SQL Shell (psql)** from the Start Menu. For the connection prompts, use `localhost` for Server, `5432` for Port, `postgres` for Database and Username, then enter the password chosen during PostgreSQL installation.

Once you see the `psql` prompt, create the app role and database:

```sql
CREATE USER aurajournal WITH PASSWORD 'aurajournal';
CREATE DATABASE aurajournal OWNER aurajournal;
CREATE DATABASE aurajournal_test OWNER aurajournal;
```

The example password here is `aurajournal`, matching `.env.example`. It is a public development default, not a shared project password: each contributor's `localhost` points to their own computer and database. If you choose a different password, substitute it in the `CREATE USER` command and use that same value in both your `.env` `DATABASE_URL` and the test database URL below. Never use this example password for a database reachable by other machines.

Exit `psql` with `\q`.

From the repository root, create your own local environment and config files.

**Linux/macOS:**

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r src/backend/requirements.txt
cp .env.example .env
cp src/frontend/.env.example src/frontend/.env.local
```

**Windows PowerShell:**

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r src/backend/requirements.txt
Copy-Item .env.example .env
Copy-Item src/frontend/.env.example src/frontend/.env.local
```

Update `.env` if your PostgreSQL credentials differ. The virtual environment and local env files are not shared or committed.

Before starting the app, apply database migrations. With the virtual environment active, run from `src/backend`:

```sh
python -m alembic upgrade head
```

An empty database runs the initial journal-table migration (`0001`) then the four-table migration (`0002`), then authentication sessions and throttling (`0003`). **If your database already has the original journal table without migration tracking, follow the backup and baseline-stamp instructions in [database setup](docs/database/migrations.md) first.** A database already at revision `0002` must apply `0003`. Return to the repository root afterward. The app does not create tables at startup.

The old development user remains disabled and its entries stay private. Register a real account in the browser. See [accounts and sessions](docs/authentication.md) for configuration and API details.

## Run

PostgreSQL must be running before you start the app. From the repository root, run:

```sh
npm start
```

`npm start` installs npm dependencies when needed, then runs the backend and frontend together with `[backend]` and `[frontend]` log labels. Press Ctrl+C to stop both. The launcher uses `.venv`'s Python when available; otherwise it uses `python3` on Linux/macOS or `python` on Windows. Make sure the Python backend dependencies and `.env` are set up as described above. Open `http://localhost:5173` when Vite is ready. The API provides `POST /api/entries` with `{"content":"..."}` and `GET /api/entries`.

## AI title suggestions

`POST /api/ai/suggest-title` accepts journal text directly and returns one short
title. It does not look up or save journal entries and rejects `entry_id` or any
other extra fields. Set `GROQ_API_KEY` and optionally `GROQ_MODEL` (default:
`openai/gpt-oss-20b`), using the same configuration as journal summarization.

Request: `{"content":"Today I finally completed my project after several challenging weeks."}`

Example response: `{"suggested_title":"A Project Finally Completed"}`

Content must be nonblank and at most 5000 characters. Titles are validated as one
plain-text line of at most 100 characters. The prompt requests the journal's
language and prefers 3–8 words where natural; relevance and language compliance
are model instructions, not guarantees enforced by validation.

The endpoint requires the existing login cookie, configured `Origin`,
`X-AuraJournal-CSRF: 1`, and `Content-Type: application/json`. Existing session
authentication reads PostgreSQL; the title service and handler do not access the
database or persist content/results. Responses use `Cache-Control: no-store`.
Errors follow existing conventions: `401` for invalid sessions, `403` for invalid
origin/CSRF, `415` for non-JSON requests, `422` for invalid input, `502` for invalid
AI output, and `503` for missing/invalid Groq credentials or provider failures,
including rate limits. No provider details or submitted content appear in errors.

### Optional manual Groq verification

This sends only the three practice entries below directly to Groq, with one
completion per entry and no database access. It is not a CI test. With the Python
environment activated and `GROQ_API_KEY` exported securely (optionally set
`GROQ_MODEL`), run from the repository root:

```sh
cd src/backend
python - <<'PY'
import os
import sys
from app.services import JournalSummaryError, JournalTitleGenerator

if not os.environ.get("GROQ_API_KEY", "").strip():
    sys.exit("Not executed: GROQ_API_KEY is unavailable.")

examples = {
    "Vietnamese": "Hôm nay tôi hoàn thành bài tập môn Toán sau nhiều giờ cố gắng. Buổi tối tôi nghỉ ngơi và đọc sách.",
    "English": "Today I finally completed my project after several challenging weeks.",
    "Minimal": "Hôm nay tôi ở nhà.",
}
generator = JournalTitleGenerator()
for label, content in examples.items():
    try:
        title = generator.generate(content).suggested_title
    except JournalSummaryError:
        sys.exit("Verification failed; check AI configuration/provider availability. Details omitted.")
    print(f"{label}: {title}")
PY
```

Inspect each title for concise wording, the entry's language, and grounding:
Vietnamese should describe mathematics homework or the stated day's activities;
English should describe project completion; Minimal should describe staying home,
without added emotions or activities. Do not require exact wording. All titles
must be one plain-text suggestion of at most 100 characters. A successful command
checks structure; human review checks meaning. Do not substitute private entries
or log credentials/provider details. Missing credentials means this check was
not executed, rather than passed.

## Tests

AI service tests and isolated title API tests use mocked Groq responses and can
run without PostgreSQL. With the Python environment activated, run from
`src/backend`:

```sh
python -m pytest tests/test_ai_service.py tests/test_ai_title_service.py tests/test_ai_titles_api.py
```

The title API tests override authentication and fail on database access. Real
session authentication, journal summary persistence, and other backend regression
tests require PostgreSQL. Each database test creates an isolated schema, applies
migrations, and drops that schema afterward; the test role needs permission to
create schemas. Use the dedicated `aurajournal_test` database created during
setup; never use your app database or other data you want to keep. In a new
terminal at the repository root:

**Linux/macOS:**

```sh
source .venv/bin/activate
export TEST_DATABASE_URL='postgresql+psycopg://aurajournal:aurajournal@localhost:5432/aurajournal_test'
cd src/backend
python -m pytest tests
```

**Windows PowerShell:**

```powershell
.\.venv\Scripts\Activate.ps1
$env:TEST_DATABASE_URL = 'postgresql+psycopg://aurajournal:aurajournal@localhost:5432/aurajournal_test'
Set-Location src/backend
python -m pytest tests
```

To build the frontend, run `npm run build` from the repository root. No Python environment activation is needed for the frontend.

GitHub Actions runs the PostgreSQL backend tests on Linux, Windows, and macOS, and builds the frontend.

For an interactive walkthrough to create and inspect test users and journals, see [create and test the database](docs/database/create-and-test.md). For request flow, backend behavior, and test details, see the [application flow guide](docs/application-flow.md).

## Accounts and current limits

Email/password registration, login, logout, seven-day revocable cookie sessions,
and private journal create/list are implemented. Open `/register` to create an
account; `/` requires login. Existing development-user entries remain stored and
are not assigned to new users. Google sign-in, email verification, password
recovery, account deletion, mood/image endpoints, and AI frontend integration are deferred.

See [authentication](docs/authentication.md) for API, CSRF, cookie, and deployment
settings. Use `localhost` consistently for frontend and API. Local HTTP uses
`AUTH_COOKIE_SECURE=false`; HTTPS deployments must set it to `true`.

Run `npm run test:frontend` for API/session-race tests and `npm run build` for the
frontend build. PostgreSQL tests cover authentication and account isolation in
addition to database behavior. CI runs both frontend checks and cross-platform
backend tests.

The [security rules](docs/security-rules.md) include broader deployment and product
requirements; implementing authentication does not certify all those requirements.
