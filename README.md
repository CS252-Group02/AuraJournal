# AuraJournal PoC

Minimal prototype for validating React → FastAPI communication and PostgreSQL persistence. The app lets you create journal entries and read them back. It does not call AI APIs.

## Requirements

- Python 3.10 or newer
- Node.js 20 or newer
- PostgreSQL 14 or newer, running locally

## Configure PostgreSQL

Create a local role and database (adjust the PostgreSQL administrator command for your installation):

```sql
CREATE USER aurajournal WITH PASSWORD 'aurajournal';
CREATE DATABASE aurajournal OWNER aurajournal;
```

Copy `.env.example` to `.env` and `src/frontend/.env.example` to `src/frontend/.env.local`. These files contain local placeholder settings; update the database URL if your PostgreSQL setup differs. Vite reads the frontend URL from `.env.local`.

## Create a Python environment

Run these commands from the repository root. Each contributor should create their own virtual environment; it is machine-specific and should not be shared or committed.

**Linux and macOS:**

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

## Run the application

In terminal one, from the repository root:

Linux/macOS: `cd src/backend && python -m uvicorn app.main:app --reload --env-file ../../.env`

Windows PowerShell: `Set-Location src/backend; python -m uvicorn app.main:app --reload --env-file ../../.env`

In a second terminal, from the repository root (with the same environment activated):

```sh
cd src/frontend
npm install
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`). Submit an entry, confirm it appears under Recent entries, and refresh the page to confirm it is retrieved from the API. The API also exposes `GET /api/health`, `POST /api/entries` (JSON body `{"content":"..."}`), and `GET /api/entries`.

## Tests

Run backend API tests from the repository root, after activating the environment:

```sh
cd src/backend
python -m pytest tests
```

The default automated tests cover create/read, persistence across app restarts, invalid input, database health, and controlled database errors using SQLite. A separate PostgreSQL integration test verifies create/read persistence across an app restart against a disposable PostgreSQL database. You can also verify persistence through the UI by creating an entry, restarting FastAPI, and confirming it remains visible. Inspect saved records with:

Linux/macOS: `psql "$DATABASE_URL" -c 'SELECT id, content, created_at FROM journal_entries ORDER BY id DESC;'`

Windows PowerShell: `psql $env:DATABASE_URL -c "SELECT id, content, created_at FROM journal_entries ORDER BY id DESC;"`

To run the PostgreSQL integration test against a disposable test database, set `TEST_DATABASE_URL` to its connection URL before running `python -m pytest tests`. The test creates an entry, verifies it remains retrievable after recreating the app, and removes that test entry.

## Known PoC limits

- Entries are shared by all users; authentication and editing/deleting entries are outside this prototype.
- The first app startup creates the table automatically; schema migrations are not included.
- The requested `dev` branch is not available; the current review branch is based on `main`.
