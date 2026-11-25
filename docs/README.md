# AuraJournal documentation

Start with the repository [README](../README.md) for prerequisites and startup.

For the project defense, start with the [Data and security architecture overview](data-and-security-overview.md).
It explains the implemented capabilities, data model, relationships, request/data
flows, security controls, limitations, and reproducible verification.

| Guide | Contents |
| --- | --- |
| [Shared HTTPS staging](staging.md) | Teammate usage, deployment, verification, redeploy, rollback and troubleshooting |
| [Backend integration handoff](backend-integration-handoff.md) | Verification commands, AI/media contracts and pending real-provider acceptance |
| [Authenticated API contracts](journal-api-contracts.md) | Shared sessions, journal filters/pagination, calendar dates, weekly contracts and errors |
| [HTTP audio upload](audio-upload.md) | Authenticated raw WebM/Opus transcription, browser request contract, safe errors, and real-provider verification status |
| [Speech-to-text streaming service and API](speech-to-text.md) | Provider transport, transcript normalization, authenticated WebSocket protocol, frontend configuration, and offline tests |
| [Weekly recap](weekly-recap.md) | Factual weekly summaries, timezone boundaries, source links, API, and verification |
| [Entry reflections](entry-reflections.md) | Per-entry short reflections, regeneration, and API response |
| [Calendar and streak](calendar-and-streak.md) | Per-user endpoints, streak rules, repeatable sample demo, and verification |
| [Weekly reflections](weekly-reflections.md) | Date-based seven-day summaries with two questions, private saving/reading, and generator integration contract |
| [Accounts and private journals](authentication.md) | Registration, login/logout, seven-day sessions, journal privacy, API, code walkthrough, troubleshooting, and Google sign-in status |
| [Journal-management API handoff](journal-management.md) | Person 1 task status, private detail reads, date-aware partial edits, two-user CRUD tests, and the transcription dependency |
| [Application flow](application-flow.md) | Frontend-to-backend request flow and test structure |
| [Database migrations](database/migrations.md) | Fresh setup, existing database upgrades, revision history, and backup considerations |
| [W8-D1 Data completion](database/week-08-d1-data.md) | Journal-date and reflection-storage contracts, migration regression coverage, verification, and integration follow-ups |
| [W8-D3/D4 Data handoff](database/week-08-d3-d4.md) | Private image references, seven occupied journal days, keyword/date search, supporting indexes and Windows verification |
| [Week 7 Data & Security handoff (Vietnamese)](database/week-07-data.md) | D01–D08, PowerShell setup, repeatable sample journals, SQL checks and a runnable calendar and streak demo |
| [Create and test a database](database/create-and-test.md) | SQL examples and relationship checks in the disposable test database |
| [Development users](development-users.md) | Disabled seed users, database-only sample users, and account isolation checks |
| [Security hardening](security-hardening.md) | Backend protections, migration 0005, runtime roles, SCRAM authentication, and deployment checks |
| [Security rules](security-rules.md) | Broader product/security requirements and implementation gaps |
| [PoC to MVP](poc-to-mvp-plan.md) | Development approach and future feature planning |

The current account flow uses **email/password**, introduced in database revision **0003**.
Google sign-in, email verification, and password recovery are deferred; the
authentication guide distinguishes implemented behavior from future work.
