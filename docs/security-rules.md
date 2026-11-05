# Journal and account security rules

Owner: Security & Data team. Status: ready for peer review; approval pending. Updated: 2026-11-02.

Based on AuraJournal Website Blueprint v0.67 in *CS252 - Capstone Defense (1).zip* (Scope, Requirements, Architecture, Security, QA, and Project Plan) and the kickoff meeting minutes. These are requirements; implementation and verification remain separate tasks.

## Scope and current state

FR-01–FR-05 are **Must**: Email/Google/Facebook authentication, voice transcription, mood-based visuals/music, timeline/calendar history, and visual recaps. Streak tracking (FR-06) is **Should**. Public sharing and clinical assessment are outside the MVP; additional emotion-estimation/coaching ideas are outside the agreed Must scope.

The backend implements email/password registration, Argon2id hashing, seven-day
revocable cookie sessions, login throttling, origin/header CSRF checks, and
session-derived journal ownership. Google/Facebook login, email verification,
password recovery, account deletion, AI/media workflows, and production encryption
remain unimplemented. Tests cover authentication and journal isolation; these do
not certify the broader acceptance checks below. See [authentication](authentication.md).

## Security rules

1. **Use fictional local data.** Keep the unauthenticated PoC on localhost. Separate development, test, staging, and production data and credentials. Tests must use the disposable `aurajournal_test` database: fixtures create and drop isolated schemas in that database.

2. **Protect secrets.** Keep database passwords, API keys, and signing/encryption secrets in backend env files or deployment secret settings. Never commit them or place them in frontend `VITE_*` values. The sample password is local-only. Review staged files; revoke/rotate exposed credentials.

3. **Authenticate on the backend.** Support Email/password, Google, and Facebook login. Hash local passwords with Argon2id; verify provider identities through standard OAuth/OIDC flows and protect callbacks/account linking. Reject missing, invalid, or expired credentials with `401`. Define expiry, logout invalidation, and login throttling. Cookie authentication requires Secure/HttpOnly, an appropriate SameSite policy, and CSRF protection.

4. **Enforce ownership.** Use reviewed migrations and foreign keys for `JournalEntry.user_id -> User.id` and `MoodRecord.entry_id -> JournalEntry.id`. Derive owners from verified identity. Check every private journal, mood, statistics, media, and AI-job request; return `404` for another user's resource. Keep private media storage restricted and authorize playback/access URLs. CORS and hidden buttons do not enforce ownership.

5. **Validate and minimize logs.** Keep server-side content checks (1–5000 characters; reject whitespace-only text), parameterized database operations, and plain-text rendering. Enforce audio format, size, and duration limits. Never log journal bodies, recordings, passwords, tokens, keys, or connection strings; return generic internal-error messages.

6. **Encrypt and back up.** Use HTTPS and verified TLS for remote connections. Encrypt deployed database/media storage and backups; restrict access and keep keys separate. Use a restricted runtime database role. Schedule backups and test recovery before launch. Exclude temporary audio and reapply completed deletions after restoration.

7. **Explain AI processing.** Obtain microphone permission and explain provider disclosure before recording; stop capture/new uploads when cancelled. Live transcription may send audio before Save. Send only necessary authorized data through the backend. Review provider retention, training, and deletion terms. Deleting app copies does not prove provider deletion.

8. **Delete temporary and personal data.** Delete application-held raw recordings/chunks after transcription, before Save. Clean up failed, partial, cancelled, and abandoned uploads with retries and a documented maximum cleanup window. Discard abandoned transcripts. Provide account/data deletion covering journals, moods, private media, and recaps; invalidate sessions and prevent late jobs recreating deleted data. Define retained-data and backup expiry periods before real use.

9. **Publish accurate privacy information.** Make Privacy Policy, Terms of Service, and Cookie Notice available before login. Explain collected data, AI providers, recording cleanup, retention, deletion requests, backup limitations, account responsibilities, and actual login cookies. Avoid non-essential tracking. Verify notices against implemented behavior before launch.

10. **Handle incidents and vulnerabilities.** Report exposures privately to Security & Data and the Tech Lead. Revoke affected credentials, restrict exposure, preserve redacted evidence, and verify fixes with the responsible team and QA. Resolve critical/high-severity defects before release.

## Acceptance checks

These checks are **planned, not passed**. Use fictional accounts A and B.

| ID | Required result |
| --- | --- |
| SEC-01 | Protected APIs reject anonymous/invalid/expired access; private pages require login. |
| SEC-02 | All three login methods, callback protection, expiry, and logout work; password hashes stay private. |
| SEC-03 | Lists, calendars, moods, and statistics are owner-scoped; owner spoofing and orphaned records fail. |
| SEC-04 | A cannot access, modify, delete, or generate from B's entries/media/jobs; private assets are not public. |
| SEC-05 | Microphone denial prevents recording/upload; notices precede minimal provider disclosure. |
| SEC-06 | Audio is deleted after transcription and failures/cancellation are cleaned within the approved window. |
| SEC-07 | Account deletion covers linked data, sessions, pending jobs, and restored backups. |
| SEC-08 | Invalid input/uploads are rejected; frontend bundles, Git changes, logs, and errors expose no secrets/private content. |
| SEC-09 | TLS, storage encryption, restricted access, scheduled backups, and recovery have verification evidence. |
| SEC-10 | Public privacy pages match actual processing, retention, cookies, and absence of non-essential tracking. |

Before launch, FR-01–FR-05 must pass production E2E checks, automated checks must pass, and critical/high-severity bugs must be resolved. Apply the Blueprint's remaining QA criteria separately.

## Decisions and review

Backend + Security & Data must specify session/token design, identity linking, migrations, and media/job ownership. AI + Security & Data must select providers and audio limits/cleanup windows. Product + Security & Data must define retained-data periods and notices; Tech Lead + Security & Data must choose hosting, encryption, and backup controls.

QA verifies evidence with each implementation owner. The documentation task is ready for review; obtain at least one peer approval and merge before marking it Done.
