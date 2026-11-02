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
├── docs/application-flow.md     # Frontend, backend, and test flow
├── docs/fedora-postgresql.md    # Fedora PostgreSQL setup notes
├── docs/poc-to-mvp-plan.md      # How to grow the PoC into the MVP
├── package.json                 # Root npm dependencies and scripts
├── package-lock.json            # Locked npm dependencies
├── scripts/
│   ├── start-backend.js          # Cross-platform backend launcher
│   └── start.js                  # Dependency bootstrap and service runner
└── src/
    ├── backend/
    │   ├── app/main.py          # FastAPI routes and database model
    │   ├── requirements.txt     # Python dependencies
    │   └── tests/               # PostgreSQL API tests
    └── frontend/
        ├── .env.example         # Frontend API URL template
        ├── index.html           # Page loaded by the browser
        ├── vite.config.js       # Vite React setup
        └── src/
            ├── App.jsx          # Journal entry form and list
            ├── main.jsx         # React entry point
            └── style.css        # App styles
```

## Setup

Install Python 3.10+, Node.js 20+, and PostgreSQL 14+. First open PostgreSQL's `psql` command prompt. The SQL below must be entered at the `psql` prompt (which usually ends in `=#`), not at Bash, PowerShell, or another system shell.

**Linux:** With PostgreSQL installed and running, open `psql` as its administrative user:

```sh
sudo -u postgres psql
```

Fedora may need its PostgreSQL cluster initialized and localhost password authentication configured first; see the [Fedora PostgreSQL setup note](docs/fedora-postgresql.md).

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

## Run

PostgreSQL must be running before you start the app. From the repository root, run:

```sh
npm start
```

`npm start` installs npm dependencies when needed, then runs the backend and frontend together with `[backend]` and `[frontend]` log labels. Press Ctrl+C to stop both. The launcher uses `.venv`'s Python when available; otherwise it uses `python3` on Linux/macOS or `python` on Windows. Make sure the Python backend dependencies and `.env` are set up as described above. Open `http://localhost:5173` when Vite is ready. The API provides `POST /api/entries` with `{"content":"..."}` and `GET /api/entries`.

## Tests

The backend tests require PostgreSQL and clear all `journal_entries` rows in the test database before each test. Use the dedicated `aurajournal_test` database created during setup; never use your app database or other data you want to keep. In a new terminal at the repository root:

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

For the request flow, backend behavior, and test details, see the [application flow guide](docs/application-flow.md).

## MVP starting point

The current flow creates and reads entries. It has no accounts, entry ownership, migrations, or AI features. Agree on MVP requirements before adding them. See [the short PoC-to-MVP plan](docs/poc-to-mvp-plan.md).
