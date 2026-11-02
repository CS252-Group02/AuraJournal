# Application and Backend Test Flow

This guide explains how the React app, FastAPI API, and PostgreSQL database work together, and how the backend tests exercise that flow.

## App request flow

```mermaid
sequenceDiagram
    participant User
    participant UI as React app (App.jsx)
    participant API as FastAPI (main.py)
    participant DB as PostgreSQL
    User->>UI: Open journal
    UI->>API: GET /api/entries
    API->>DB: Select entries, newest first
    DB-->>API: Entry rows
    API-->>UI: JSON list
    UI-->>User: Render recent entries
    User->>UI: Submit entry
    UI->>API: POST /api/entries {content}
    API->>API: Validate and trim content
    API->>DB: Insert entry
    DB-->>API: Saved row with id and timestamp
    API-->>UI: 201 response with entry
    UI->>API: GET /api/entries
    API-->>UI: Updated JSON list
    UI-->>User: Show saved entry
```

### Frontend

[`src/frontend/src/App.jsx`](../src/frontend/src/App.jsx) is the journal screen. It gets the API base URL from `VITE_API_URL`, defaulting to `http://localhost:8000`. On page load, it requests `GET /api/entries`; when the user saves, it posts JSON containing `content` to `POST /api/entries`, then reloads the list. The UI displays connection/save status and the entry timestamps.

Vite loads `App.jsx` through [`src/frontend/src/main.jsx`](../src/frontend/src/main.jsx). For local development, set `VITE_API_URL` in `src/frontend/.env.local` if the API is not at the default URL.

### Backend and database

[`src/backend/app/main.py`](../src/backend/app/main.py) defines the API and SQLAlchemy model. The API accepts entry content from 1 to 5000 characters, trims it, and rejects whitespace-only content. `POST /api/entries` creates an entry and returns it with its ID and creation time; `GET /api/entries` returns entries newest first. The `journal_entries` table stores the content and timestamp in PostgreSQL.

The backend connects using `DATABASE_URL` (the default is the local `aurajournal` PostgreSQL database). It creates the table when the app starts. CORS allows the origin configured by `FRONTEND_ORIGIN`, defaulting to Vite's `http://localhost:5173`. Database errors return HTTP 503 with a generic availability message. A non-PostgreSQL URL is rejected during app creation.

## Why these choices

These choices keep the current app small and make its behavior easier to check. They describe the current starting point, not permanent product requirements.

- **PostgreSQL is the only supported database.** The app and tests use the same database engine, so the tests check the database behavior the app relies on. The tradeoff is that backend tests require a running PostgreSQL instance.
- **The app only creates and lists entries.** This gives the project one complete user flow, from form to database and back, before adding more features. Editing, deleting, accounts, and AI are left for later requirements.
- **The frontend reloads entries after a successful save.** The API and database remain the source of truth, so the UI displays the saved response state (including its generated ID and timestamp) instead of maintaining a separate local copy of the write logic.
- **Entry content is limited and trimmed.** The 5000-character limit matches the database column and frontend control. Trimming and rejecting whitespace-only content prevents entries that look empty from being stored.
- **Tests use a disposable PostgreSQL database.** This verifies database-backed API behavior, including persistence across a fresh app instance. The fixture clears the table before each test, so a dedicated test database protects real journal data.
- **Tables are created at startup for now.** This keeps the initial setup straightforward while the schema is small. When schema changes need to be applied safely to existing data, use migrations instead of relying on `create_all`.
- **CORS defaults to the local Vite origin, and database errors return a generic 503.** The local default makes development work without extra configuration; `FRONTEND_ORIGIN` allows deployments to set their frontend origin. The generic database response tells clients the request could not be served without exposing internal connection details.

## Backend tests

[`src/backend/tests/test_api.py`](../src/backend/tests/test_api.py) sends in-process HTTP requests through the FastAPI app using HTTPX; it does not need a browser or a running web server. The requests still use a real PostgreSQL database configured by `TEST_DATABASE_URL`.

The tests check that:

- Entries can be created and listed through the API.
- An entry remains saved after creating a fresh app instance.
- Empty, missing, and whitespace-only content is rejected.
- Database failures produce a controlled 503 response.
- A non-PostgreSQL database URL is rejected.

The test fixture creates the table if needed and clears `journal_entries` before each test. Use a disposable test database, never the database containing your journal entries. From `src/backend`, run:

```sh
TEST_DATABASE_URL=postgresql+psycopg://aurajournal:aurajournal@localhost:5432/aurajournal_test python -m pytest tests
```

In PowerShell, set `$env:TEST_DATABASE_URL` to that URL before running `python -m pytest tests`. GitHub Actions provisions PostgreSQL and runs these backend tests on Ubuntu, Windows, and macOS. It builds the frontend separately.
