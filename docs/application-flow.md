# Application and backend test flow

See [authentication](authentication.md) for endpoints, CSRF, seven-day sessions, and setup.

## Request flow

```mermaid
sequenceDiagram
    participant User
    participant UI as React JournalPage.jsx
    participant API as FastAPI entry router
    participant DB as PostgreSQL
    User->>UI: Open journal
    UI->>API: GET /api/entries
    API->>DB: Select authenticated user's entries, newest first
    DB-->>API: Entry rows
    API-->>UI: JSON list
    User->>UI: Submit entry
    UI->>API: POST /api/entries {content}
    API->>API: Validate and trim content
    API->>DB: Insert with authenticated owner and UUID
    DB-->>API: Saved row with timestamps
    API-->>UI: 201 response
    UI->>API: GET /api/entries
    API-->>UI: Updated JSON list
```

`pages/JournalPage.jsx` uses `lib/api.js`, which gets its API URL from `VITE_API_URL`, defaulting to `http://localhost:8000`. The journal page reloads entries after a successful save and displays connection/save errors. Login and registration connect to the auth API. The shared API client includes session cookies and the CSRF header; protected routes check `/api/auth/me` before showing private content.

## Backend and database

`app/main.py` creates the FastAPI application, sets CORS, installs the generic SQLAlchemy error handler, and registers routes. `app/database.py` validates PostgreSQL connection URLs and provides request-scoped sessions. `app/config.py` holds application settings and the authenticated owner. `app/models/` has one module per table, with the declarative base and timestamp mixins in `base.py`; `app/schemas/entries.py` defines entry input and output validation; `app/routers/entries.py` implements create/list behavior.

`POST /api/entries` accepts content from 1 to 5000 characters, trims it, and rejects blank content. Extra fields, including `user_id`, are rejected. The server derives ownership from the authenticated session. Responses contain `id` as a UUID string, `content`, `created_at`, and `updated_at`. `GET /api/entries` selects only that owner's entries, sorted by creation time descending with UUID as a deterministic tie-breaker. Anonymous, invalid, expired, and revoked sessions receive 401. Other accounts' entries are never included.

PostgreSQL stores users, entries, mood records, and journal images. Each entry requires an owner and can have at most one mood record and one image. Mood/image endpoints and AI integrations are deferred. See [database migrations](database/migrations.md) for schema details and [development users](development-users.md) for testing with additional users.

The app connects using `DATABASE_URL`, defaulting to the local `aurajournal` PostgreSQL database. CORS allows `FRONTEND_ORIGIN`, defaulting to `http://localhost:5173`. SQLAlchemy errors return HTTP 503 with a generic availability message. App startup does not create tables; run Alembic before starting the backend. Shutdown disposes the connection pool.

## Tests

Tests send in-process HTTP requests through FastAPI using HTTPX, with a real PostgreSQL database. They require `TEST_DATABASE_URL` pointing to a dedicated disposable database. Each database test creates a uniquely named schema and removes it afterward. No app tables are cleared. The test database role needs permission to create schemas.

Tests apply Alembic migrations rather than `create_all()`. Coverage includes fresh schema/model agreement, initial-schema upgrades preserving entries, downgrade protection, UUID responses, authenticated ownership and account isolation, ordering, input validation, persistence across app instances, database-error handling, unique constraints, foreign keys, cascades, and ORM timestamp updates.

With the virtual environment active, run from `src/backend`:

```sh
TEST_DATABASE_URL=postgresql+psycopg://aurajournal:aurajournal@localhost:5432/aurajournal_test python -m pytest tests
```

In PowerShell, set `$env:TEST_DATABASE_URL` before running `python -m pytest tests`. CI applies migrations to its test database, runs the PostgreSQL tests on Linux, Windows, and macOS, and builds the frontend separately.
