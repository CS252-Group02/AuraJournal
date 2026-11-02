# PoC to MVP

Keep the create/read flow as the baseline. Preserve the PostgreSQL API tests, frontend build, and cross-platform CI as regression checks. See the [application flow guide](application-flow.md) for how the frontend, backend, and tests work.

Before expanding, agree on MVP features, user accounts and entry ownership, required entry operations, and deployment constraints. Add only the data model and API behavior those decisions require.

Build one user-facing slice at a time across React, FastAPI, and PostgreSQL. Add migrations when the schema changes, and authentication if the agreed scope requires it. Keep AI integration separate unless explicitly included in the MVP.

For each slice, require automated tests and a frontend build. Before calling the MVP ready, verify save/read in a browser against PostgreSQL, including after restarting the backend.
