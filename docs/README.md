# AuraJournal documentation

Start with the repository [README](../README.md) for prerequisites and startup.

| Guide | Contents |
| --- | --- |
| [Accounts and private journals](authentication.md) | Registration, login/logout, seven-day sessions, journal privacy, API, code walkthrough, troubleshooting, and Google sign-in status |
| [Application flow](application-flow.md) | Frontend-to-backend request flow and test structure |
| [Database migrations](database/migrations.md) | Fresh setup, existing database upgrades, revision history, and backup considerations |
| [Create and test a database](database/create-and-test.md) | SQL examples and relationship checks in the disposable test database |
| [Development users](development-users.md) | Disabled seed users, database-only sample users, and account isolation checks |
| [Security rules](security-rules.md) | Broader product/security requirements and implementation gaps |
| [PoC to MVP](poc-to-mvp-plan.md) | Development approach and future feature planning |

The current account flow uses **email/password** and database revision **0003**.
Google sign-in, email verification, and password recovery are deferred; the
authentication guide distinguishes implemented behavior from future work.
