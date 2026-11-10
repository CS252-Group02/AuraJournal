# Backend and database security rollout

This change addresses the local assessment of main at `6318dfd`. Code changes are
on `security/backend-database-hardening`. Applying this branch is not equivalent
to changing a machine's PostgreSQL authentication rules: follow the operator steps
below. No production deployment or live database role changes happen automatically.

## Implemented behavior

| Area | Behavior |
| --- | --- |
| Login | Sixty total requests per IP/minute before verification (including valid logins). Five failed attempts per normalized email and thirty per client IP in 15 minutes, independently. PostgreSQL transaction locks serialize both identities across workers. Rotating either identity does not reset the other budget. |
| Registration | Five attempts per IP per 15-minute window, before password hashing. Invalid submissions and duplicate registrations consume budget. |
| New passwords | 15–128 Unicode characters, a local common-password denylist, and rejection of single-character repetition. Passwords are not trimmed or transformed before hashing. |
| Existing passwords | Login retains its existing 8–128 character contract. Successful login upgrades outdated Argon2 parameters. No forced password reset is performed. |
| AI | Shared title/summary budgets: ten requests per account/minute, 100 per account/24-hour window, thirty per IP/minute. One active AI request per account across workers. Rejected/provider-failed requests consume budget. |
| Provider | Explicit 20-second SDK timeout and zero automatic retries. This is an SDK I/O timeout, not a guaranteed total end-to-end wall-clock deadline. |
| Request bodies | Maximum 65,536 bytes before JSON parsing, including chunked bodies. Oversized requests return 413. A production proxy must additionally enforce body/read timeouts and connection limits. |
| Proxy handling | `npm start` passes `--no-proxy-headers`, preventing a direct client from selecting its IP through forwarding headers. |
| Responses | Existing `no-store`, plus `nosniff` and `no-referrer`; production adds HSTS. |
| Production startup | Requires HTTPS frontend origin, Secure cookies, explicit non-default database credentials, verified database TLS, a non-owner runtime role without role memberships, elevated privileges, or schema/database CREATE, and rejection of an intentionally incorrect database password. |

Rate-limit responses return 429 and `Retry-After`. Budgets are stored in PostgreSQL,
not per-process memory, and survive backend restarts. Each budget has a window
starting on its first request; it is not a sliding window. At a window boundary a
client may use two adjacent budgets quickly. Production ingress should also apply
coarse request/connection limits. Login limits can temporarily block a legitimate
user under a targeted attack; recovery/email verification remain future work.

Account registration still returns 409 for an existing email and signs a newly
created account in immediately. This preserves the product contract and **does
not eliminate account enumeration**. A generic email-verification registration
flow needs a mail provider and separate product work. The small local password
list is defense in depth, not a comprehensive breach-password database.

## Code and schema changes

- `app/limits.py`: shared registration and AI budgets and independent client IP extraction.
- `app/routers/auth.py`: independent email/IP login limits and Argon2 rehashing.
- `app/passwords.py`, `common-passwords.txt`: policy for new credentials.
- `app/request_limits.py`: bounded ASGI request-body handling.
- `app/deployment.py`: production settings and database posture checks.
- `app/models/auth.py`: `RateLimitBucket` and additional failed-login indexes.
- `migrations/versions/0005_security_limits.py`: additive migration after `0004`.
- `scripts/database-runtime-role.sql`: explicit, transactional operator provisioning.
- `scripts/audit-database.py`: read-only privilege/TLS and wrong-password audit.
- Registration UI now explains the 15–128 character policy. Login remains compatible.

`0005` adds `rate_limit_buckets(key varchar(64) primary key, attempts integer,
expires_at timestamptz)`, a positive-attempt constraint, an expiry index, and indexes
on `login_attempts(email, created_at)` and `(ip, created_at)`. Keys are SHA-256
identifiers; they are not reversible encryption or protection against guessing
low-entropy identifiers. Existing journal, image, mood, and account data is unchanged.
Expired budget rows are cleaned on budget requests. Failed-login records still use
the existing 15-minute cleanup. Sessions retain their existing seven-day expiry.
No journal dates, weekly reflections, image storage, or calendar features are added.

## 1. Upgrade with a backup

Stop application writers before role/schema changes. Use a dedicated backup folder
outside Git with permissions limited to its owner. For example, in a private shell:

```sh
umask 077
pg_dump -W -h localhost -U aurajournal -d aurajournal -Fc -f /your/private/path/aurajournal-before-security.dump
pg_restore --list /your/private/path/aurajournal-before-security.dump
```

Stop if the dump fails. The archive listing is not a restore test: restore into a
separate scratch database and verify row counts/relationships before an important
upgrade. Encrypt retained/off-device backups using your organization's backup or
key-management system, restrict access, define retention, and test recovery. Do not
put backup files, passwords, `.env`, or database URLs with passwords in Git or logs.

With the project Python environment active, from the repository root:

```sh
python -m alembic -c src/backend/alembic.ini upgrade head
python -m alembic -c src/backend/alembic.ini current
```

The revision must be `0005`. Alembic uses `MIGRATION_DATABASE_URL` when nonempty,
otherwise `DATABASE_URL` for development compatibility. Keep migration credentials
out of the deployed API environment: supply them only to the migration job/shell.

## 2. Separate runtime and migration roles

After migration, connect as a PostgreSQL administrator **to this dedicated app
database** and run:

```sh
psql -X -v ON_ERROR_STOP=1 -h localhost -U YOUR_ADMIN -d aurajournal -f scripts/database-runtime-role.sql
```

The script creates `aurajournal_owner` and `aurajournal_runtime`, transfers the
app database/schema/tables to the owner, revokes PUBLIC database/schema access,
and grants runtime CONNECT, schema USAGE, and only SELECT/INSERT/UPDATE/DELETE
on the seven application tables. Runtime cannot alter/drop tables, create schemas,
or access Alembic metadata. Existing elevated role definitions or runtime role
memberships are rejected. No default password is assigned. Because PUBLIC grants
are revoked, this script is for a dedicated AuraJournal database, not a shared
multi-application database. Review any pre-existing explicit grants separately.

In the same administrator session, set unique credentials interactively:

```sql
SET password_encryption = 'scram-sha-256';
\password aurajournal_owner
\password aurajournal_runtime
```

Configure the API's `DATABASE_URL` with runtime credentials. Supply the owner URL
only as `MIGRATION_DATABASE_URL` during migrations. Future new tables require
explicit grants; the script intentionally avoids granting runtime blanket access
to every future table. Re-run the role script to restore its current grants if
needed. UUID tables need no sequence privileges. Retire or rotate old application
credentials after confirming no other project relies on that role.

## 3. Remove PostgreSQL trust authentication safely

The audit found `trust` for sockets and loopback on this developer's PostgreSQL
cluster. This is a **server configuration change**, outside an Alembic migration.

1. Identify configuration with `SHOW hba_file;` in an administrator session.
2. Preserve a backup and a working administrator session/access route.
3. Set SCRAM passwords for every role whose password login you need, including
   the administrator if used over TCP, before editing authentication rules.
4. Replace applicable `trust` entries; PostgreSQL uses the first matching rule.
   Merely appending stricter entries after a matching `trust` entry does nothing.

Example for a dedicated password-authenticated local cluster (review other apps
and replication needs first):

```text
local  all          all                      scram-sha-256
host   all          all  127.0.0.1/32         scram-sha-256
host   all          all  ::1/128              scram-sha-256
local  replication  all                      scram-sha-256
host   replication  all  127.0.0.1/32         scram-sha-256
host   replication  all  ::1/128              scram-sha-256
```

An OS-authenticated `peer` rule with a deliberate mapping can be used for an
administrative Unix socket instead. Do not enable remote listening just to make
this work. Remote production database access should use restricted networks and
`hostssl` SCRAM rules, with certificates verified by the client.

5. Inspect `pg_hba_file_rules` for parsing errors; reload with
   `SELECT pg_reload_conf();`. Test in a **new connection** before closing the
   retained administrator session. Existing connections keep their authentication.
6. Verify correct credentials succeed and wrong/missing credentials fail. Run
   `python scripts/audit-database.py` using the configured runtime connection.
   A network failure is reported as inconclusive/failing, never as a password pass.

The audit exits 1 for any production posture failure, including disabled database
TLS on local development. It prints booleans only, not credentials or journal data.
Production startup uses the same wrong-password check, which produces one expected
failed database login per backend worker startup. Certificate/peer-only database
authentication is not supported by this production password-enforcement policy.

## 4. Production environment and proxy

Set `APP_ENV=production`, `AUTH_COOKIE_SECURE=true`, and an exact HTTPS
`FRONTEND_ORIGIN` with no trailing slash/path. The runtime database URL must use
`sslmode=verify-full` and a trusted CA (for example `sslrootcert` supplied securely).
Never commit the real URL or certificates containing private keys. The startup
checks require both actual TLS and restricted privileges; setting flags alone
cannot satisfy them. `APP_ENV=development` is the default for local HTTP only.

`npm start` is a development launcher with reload. A direct production backend can
be launched behind TLS termination with `--no-proxy-headers`; IP limits then see
the direct peer. If forwarding the original client IP is required, launch Uvicorn
with `--proxy-headers --forwarded-allow-ips=EXACT_PROXY_IP`, bind/firewall the API
so only that proxy reaches it, and configure the proxy to **overwrite**, not trust,
client-supplied `X-Forwarded-For` and `X-Forwarded-Proto`. Never use `*`. Configure
TLS, request-body/read timeouts, connection limits, and frontend CSP at the proxy.

## Validation and rollback

Run the backend suite with `TEST_DATABASE_URL` pointing to a dedicated disposable
test database, then `npm run test:frontend`, `npm run build`, and `git diff --check`.
Database fixtures create and remove isolated schemas; do not use production.
Provider calls are mocked in tests. A separate optional test accepts
`SECURITY_ADMIN_DATABASE_URL` for a disposable PostgreSQL cluster:

```sh
# From src/backend, after setting the explicit test/admin URLs securely:
python -m pytest tests
python -m pytest tests/test_database_roles.py
```

The admin test creates a uniquely named scratch database, checks repeatable role
provisioning, allows runtime DML, rejects runtime DDL/migration-table changes,
checks owner DDL, rolls back temporary roles and drops its scratch database. It
skips if either deployment role already exists to avoid touching real roles.

If rolling back code, stop the upgraded API first. Revision `0005` can be downgraded
to `0004`; doing so discards request budgets and resets those limits. Database role
and HBA changes are separate operator changes and are not undone by Alembic. Keep
the secure roles/authentication unless a reviewed recovery procedure requires a
change. Never automatically restore broad privileges or `trust` on rollback.

## Remaining work

Email-verification registration and recovery, comprehensive compromised-password
screening, revoke-all sessions/idle expiry, RLS, journal pagination, summary/edit
concurrency control, audit event retention, and application-level journal encryption
are separate follow-ups. This branch does not certify the whole deployment or
perform live third-party AI/load/penetration testing.

## Validation of this branch

Local validation: 209 backend tests passed, including the optional administrator
role-provisioning test on a disposable database; four frontend API tests passed;
the Vite production build and whitespace checks passed. AI responses were mocked.
No live AI requests, load tests, or browser UI verification were performed.
