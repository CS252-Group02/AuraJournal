# AuraJournal

A small React + FastAPI + PostgreSQL journal app. It is a tested starting point for the MVP, not a finished product.

## How it works

`src/frontend/src/App.jsx` sends create/read requests to `src/backend/app/main.py`. FastAPI stores entries in PostgreSQL's `journal_entries` table. Tests are in `src/backend/tests/`.

## Project structure

```text
.
├── .env.example                 # Backend settings template
├── .github/workflows/ci.yml     # Automated checks on pushes and pull requests
├── .gitignore                   # Keeps local config and build files out of Git
├── docs/poc-to-mvp-plan.md      # How to grow the PoC into the MVP
└── src/
    ├── backend/
    │   ├── app/main.py          # FastAPI routes and database model
    │   ├── requirements.txt     # Python dependencies
    │   └── tests/               # SQLite API tests and PostgreSQL test
    └── frontend/
        ├── .env.example         # Frontend API URL template
        ├── index.html           # Page loaded by the browser
        ├── package.json         # Frontend scripts and dependencies
        ├── package-lock.json    # Locked npm dependency versions
        ├── vite.config.js       # Vite React setup
        └── src/
            ├── App.jsx          # Journal entry form and list
            ├── main.jsx         # React entry point
            └── style.css        # App styles
```

## Setup

Install Python 3.10+, Node.js 20+, and PostgreSQL 14+. Create a PostgreSQL role and database named `aurajournal`, then copy the example settings:

```sql
CREATE USER aurajournal WITH PASSWORD 'aurajournal';
CREATE DATABASE aurajournal OWNER aurajournal;
```

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

## Run

Start the API from the repository root:

```sh
cd src/backend
python -m uvicorn app.main:app --reload --env-file ../../.env
```

In another terminal, activate `.venv`, then start the frontend:

```sh
cd src/frontend
npm ci
npm run dev
```

Open the URL printed by Vite, usually `http://localhost:5173`. The API provides `POST /api/entries` with `{"content":"..."}` and `GET /api/entries`.

## Tests

From `src/backend`, run `python -m pytest tests`. These tests use SQLite by default. To include the PostgreSQL integration test, set `TEST_DATABASE_URL` to a disposable test database URL before running pytest. From `src/frontend`, run `npm run build`.

GitHub Actions runs the backend tests on Linux, Windows, and macOS, tests PostgreSQL persistence, and builds the frontend.

## MVP starting point

The current flow creates and reads entries. It has no accounts, entry ownership, migrations, or AI features. Agree on MVP requirements before adding them. See [the short PoC-to-MVP plan](docs/poc-to-mvp-plan.md).
