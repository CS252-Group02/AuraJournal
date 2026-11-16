# AuraJournal documentation

Start with the repository [README](../README.md) for prerequisites and startup.

| Guide | Contents |
| --- | --- |
| [Speech-to-text streaming service and API](speech-to-text.md) | Provider transport, transcript normalization, authenticated WebSocket protocol, frontend configuration, and offline tests |
| [Weekly recap](weekly-recap.md) | Factual weekly summaries, timezone boundaries, source links, API, and verification |
| [Weekly reflections](weekly-reflections.md) | Date-based seven-day summaries with two questions, private saving/reading, and generator integration contract |
| [Accounts and private journals](authentication.md) | Registration, login/logout, seven-day sessions, journal privacy, API, code walkthrough, troubleshooting, and Google sign-in status |
| [Journal-management API handoff](journal-management.md) | Person 1 task status, private detail reads, date-aware partial edits, two-user CRUD tests, and the transcription dependency |
| [Application flow](application-flow.md) | Frontend-to-backend request flow and test structure |
| [Database migrations](database/migrations.md) | Fresh setup, existing database upgrades, revision history, and backup considerations |
| [W8-D1 Data completion](database/week-08-d1-data.md) | Journal-date and reflection-storage contracts, migration regression coverage, verification, and integration follow-ups |
| [Week 7 Data & Security handoff (Vietnamese)](database/week-07-data.md) | D01–D08, PowerShell setup, repeatable sample journals, SQL checks and a runnable calendar and streak demo |
| [Create and test a database](database/create-and-test.md) | SQL examples and relationship checks in the disposable test database |
| [Development users](development-users.md) | Disabled seed users, database-only sample users, and account isolation checks |
| [Security rules](security-rules.md) | Broader product/security requirements and implementation gaps |
| [PoC to MVP](poc-to-mvp-plan.md) | Development approach and future feature planning |

The current account flow uses **email/password**, introduced in database revision **0003**.
Google sign-in, email verification, and password recovery are deferred; the
authentication guide distinguishes implemented behavior from future work.
