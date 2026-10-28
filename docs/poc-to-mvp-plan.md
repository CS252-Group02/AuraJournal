# PoC to MVP plan

## Goal

Keep the current app useful as a tested proof of concept while evolving it into the MVP in small, reviewable steps. Treat the current create/read flow as the baseline, not as a finished product.

## 1. Preserve the PoC baseline

- Keep the React entry form, FastAPI create/read endpoints, and PostgreSQL integration test runnable.
- Keep the SQLite API tests, PostgreSQL persistence test, frontend build, and cross-platform CI as regression checks.
- Record verification accurately: PostgreSQL create/read persistence passed; the frontend build passed; browser-to-API testing remains to be done.

## 2. Agree on MVP requirements before expanding

Decide the MVP features, whether entries belong to individual users, authentication needs, required entry operations and fields, and deployment constraints. These choices determine the data model and API; avoid adding them speculatively.

## 3. Build the MVP incrementally

- Implement one user-visible vertical slice at a time across React, FastAPI, and PostgreSQL.
- Add database migrations before changing the schema beyond the PoC table.
- Add authentication and per-user data ownership if the agreed MVP requires multiple users.
- Keep settings and secrets in environment variables; keep the AI integration separate unless it is explicitly in the MVP scope.
- Add API and PostgreSQL tests for each slice, plus frontend checks for its user flow.

## 4. Keep a release gate

For each MVP slice, require the automated tests and frontend build to pass. Before calling the full flow ready, manually verify in a browser that a user can save and retrieve entries through FastAPI and PostgreSQL, including after restarting the backend. Update setup instructions with any new requirements.

## Current status

The PoC demonstrates entry creation and retrieval with PostgreSQL persistence and has a passing frontend production build. The current app has no authentication or user-specific entry ownership, and live browser-to-backend verification is still outstanding. The existing CI workflow is configured for Linux, Windows, and macOS; those hosted jobs must run to confirm cross-platform behavior.
