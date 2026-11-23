# Automatic private Pixel Art

Journal creation and content edits schedule Pixel Art on the backend. Saving a
journal never waits for Groq or PixelLab. The application commits the journal and
its durable PostgreSQL job in one transaction; if the database cannot persist the
job, that transaction rolls back instead of leaving an unscheduled saved journal.
Provider outages, disabled generation, missing credentials and exhausted credits
never cause an otherwise valid journal save to fail.

## Generation architecture

`pixel_generation.render_pixel_art` reuses the original significant-moment
extractor and PixelLab client. Groq receives the journal and returns validated
`grounded`/`symbolic` output. Grounded scenes require exact source evidence. Only
the minimized visual prompt reaches PixelLab. The existing privacy instructions,
style, 128×128 resolution, model selection, prompt enhancement
setting and PNG validation remain unchanged. No journal text, evidence, scene or
provider error payload is copied into a job or logged by the worker.

`pixel_art_jobs` is an outbox, with one unique `(entry_id, source_version)` row.
`journal_entries.content_version` increases only when trimmed content changes.
Journal CRUD schedules/invalidate jobs inside the journal transaction. No migration,
startup routine, gallery read or deprecated generation POST backfills old journals.

Application lifespan starts a bounded set of managed polling threads. Each pass
examines at most 32 due jobs from distinct owners, so one user's backlog cannot
fill the scan window. It uses short row-lock transactions and the original
PostgreSQL session advisory locks for entries and users. Shared advisory slots
also limit total generation concurrency across application processes. Advisory
locks retain a connection in AUTOCOMMIT mode; no database transaction is held
open during either external AI call. Threads stop taking new work on shutdown and
finish their current attempt before the engine is disposed. A forced process exit
is recovered from persisted state.

The worker commits `processing`, an attempt token and a five-minute lease before
external work. It commits `submitted_at` **before** calling PixelLab. The job UUID
is the image UUID, giving output a deterministic private storage key. The final
transaction rechecks the owner, content version and attempt token under the entry
lock, then attaches the PNG and marks the job ready atomically. Filesystem and
PostgreSQL commits cannot be atomic; recovery handles that gap conservatively.

### Status and retry policy

| Public status | Meaning |
| --- | --- |
| `pending` | Durable work waiting for a worker or the bounded extraction retry |
| `processing` | A worker has claimed the current content version |
| `ready` | An owned image reference and private file are available |
| `failed` | Terminal validation/generation failure, or missing/invalid stored image |
| `unavailable` | Generation disabled, not configured, out of credits, or budget exhausted |
| `uncertain` | PixelLab may have completed; no automatic image-provider resubmission is safe |
| `not_requested` | Historical journal without a job or image |

Obsolete versions use internal `cancelled` rows, never returned as the current
journal's generation status. `error_code` is a safe application code; raw provider
messages, SQL details, paths, prompts and credentials never appear in this API.

Current public error codes are `disabled`, `service_unavailable`,
`credits_unavailable`, `budget_exhausted`, `extraction_unavailable`, `no_depictable_moment`,
`generation_failed`, `provider_busy`, `invalid_image`, `attempts_exhausted`,
`completion_uncertain`, `image_missing`, `invalid_reference`, and
`storage_unavailable`. Successful states use null; clients should use status for
control flow and a safe generic fallback for unrecognized future error codes.

- A transient Groq extraction failure has **one retry**, after at least 60 seconds
  (two total extraction attempts). That retry can incur another Groq charge.
  Invalid output and configuration errors are terminal. Crashes before image
  submission also count toward the two-attempt bound.
- A `symbolic` result (no concrete depictable moment) never produces a generic
  journal-book prompt. It is queued for one extraction retry after at least 60
  seconds; a second such result ends as `failed` with `no_depictable_moment`.
  No PixelLab submission is made unless a grounded scene is found. Existing images
  are not regenerated; editing journal content schedules a new version as usual.
- There are **zero automatic PixelLab retries**, including timeout, transport/5xx,
  rate-limit, malformed output, storage failure and lost commit acknowledgement.
  A submission marker can exist even if a crash prevented the actual request;
  that ambiguity intentionally sacrifices an image rather than risking a charge.
- Expired `processing` jobs without a submission marker may resume within the
  attempt bound. The entry advisory lock prevents recovery while another worker
  still owns the job, even if the lease has expired. Attempt tokens fence stale
  workers that lost their lock/claim.
- Expired jobs with a submission marker first check the deterministic private PNG.
  If valid, they attach it without calling either provider. If absent, they become
  terminal `uncertain`. A possibly committed reference is never deleted after a
  lost acknowledgement.
- Lock/capacity contention leaves jobs pending without consuming attempts or
  provider budget. Database outages leave durable claims recoverable after lease
  expiry. Worker failures log only a fixed message, without exception payloads.
- `failed`, `unavailable` and `uncertain` jobs are not automatically re-enqueued
  by enabling providers, restarting, refreshing, or clicking the old Generate
  button. A new content version is a new request. Do not clear `submitted_at`
  or blindly reset terminal jobs to pending.

For an `uncertain` job whose output reached disk but could not attach, an operator
may fix the database/storage problem and reopen **attachment recovery only**:

```sql
UPDATE pixel_art_jobs
SET status = 'processing', lease_expires_at = now() - interval '1 second'
WHERE id = '<investigated-job-uuid>' AND status = 'uncertain'
  AND submitted_at IS NOT NULL;
```

The retained submission marker ensures this operation cannot call PixelLab again.
If no output exists, it returns to `uncertain`. There is no user-facing retry API
in this PR. Uncertain jobs/files require operational review; they are intentionally
retained until recovered, invalidated by content edits, or removed with the journal.

### Edit and delete lifecycle

Content changes invalidate the old image and jobs, clear the existing summary
fields as before, increment the content version, and schedule the new version.
Identical trimmed content, date-only edits and summary changes preserve valid
artwork and in-flight work. Dates are read from the journal, so retained artwork
moves to its updated `journal_date`. Changing content and then changing it back
still produces a new version; an earlier in-flight result cannot attach.

Deletion cascades jobs and image references. Worker completion checks the locked
entry/version/token, so deleted journals cannot receive late images. Normal edits
and deletion remove old files after database commit. Account deletion retains the
existing database cascades and orphan cleanup behavior.

## Read-only memory API

Every route requires the authenticated session cookie. Missing and foreign journal
IDs return 404; anonymous requests return 401. Responses have `Cache-Control:
no-store` and `X-Content-Type-Options: nosniff`. No GET schedules jobs, calls AI,
repairs rows or writes files. Query-supplied user identity is never trusted.

| Request | Response |
| --- | --- |
| `GET /api/entries/pixel-art/memories?as_of=YYYY-MM-DD` | 200 grouped feed with images and generation status |
| `GET /api/entries/{entry_id}/pixel-art/status` | 200 current journal date, image or null, and generation status |
| `GET /api/entries/{entry_id}/pixel-art` | Existing 200 image metadata; 404 if no usable reference |
| `GET /api/entries/{entry_id}/pixel-art/content` | Existing private 200 PNG; 404 missing/invalid reference or missing file; 503 storage outage |
| `GET /api/entries/pixel-art/recent?as_of=YYYY-MM-DD` | Existing flat image-only array, unchanged |

Grouped feed example (UUIDs abbreviated here for readability):

```json
{
  "as_of": "2026-11-21",
  "days": [
    {
      "journal_date": "2026-11-21",
      "entries": [
        {
          "entry_id": "<journal-B-uuid>",
          "image": null,
          "generation": {
            "status": "processing",
            "error_code": null,
            "updated_at": "2026-11-21T12:00:00Z"
          }
        },
        {
          "entry_id": "<journal-A-uuid>",
          "image": {
            "id": "<image-uuid>",
            "file_format": "png",
            "width": 128,
            "height": 128,
            "created_at": "2026-11-21T11:59:00Z",
            "content_url": "/api/entries/<journal-A-uuid>/pixel-art/content"
          },
          "generation": {
            "status": "ready",
            "error_code": null,
            "updated_at": "2026-11-21T11:59:00Z"
          }
        }
      ]
    }
  ]
}
```

The per-journal status response is exactly
`{entry_id, journal_date, image, generation}`, with the same nested types.
`generation` always has `status`, nullable `error_code`, and nullable ISO timestamp
`updated_at`. Historical journals without jobs use `not_requested`, with null
error/timestamp. Nullable fields are present in the feed/status responses. Image
metadata retains its existing fields and authenticated content URL. Representation
is not persisted; retrieved artwork should be labeled an illustration, without
claiming it depicts a grounded event.

The feed selects the latest **seven distinct occupied journal dates** on or before
the inclusive `as_of` cutoff, rather than seven consecutive dates or seven images.
Days with no ready images still count. Every journal on each selected date is
included. Days sort descending; journals sort by creation timestamp descending,
then UUID descending. Multiple journals on one date keep separate images and
statuses. Empty accounts return `{"as_of":"YYYY-MM-DD","days":[]}`. `as_of`
is required and strictly validated as a real `YYYY-MM-DD` date; invalid dates
return 422. Dates are never converted from image timestamps or client timezones.
The feed uses one joined query for entries, images and current jobs.

Storage keys must match the associated journal/image exactly and be PNG. Legacy
external URLs, malformed and cross-journal keys never reach storage and yield
`image: null` in the feed; direct metadata/content returns 404. The status projection
checks file presence without decoding every PNG. A missing file is reported as
`failed`/`image_missing`, while retaining valid metadata for legacy consumers.
Storage can disappear after a response; clients must still handle content 404/503
and decode errors. Reads never repair or regenerate missing images.

The frontend gallery uses this contract through authenticated, no-store GETs.
No WebSocket/SSE infrastructure is needed. Account-scoped cancellation, PNG Blob
URLs and logout revocation remain in place.

### Deprecated POST compatibility

`POST /api/entries/{entry_id}/pixel-art` still requires `{}`, configured Origin,
`X-AuraJournal-CSRF: 1`, and JSON content type. It is deprecated in OpenAPI:

- 200 with the existing `{entry_id, image}` shape if a valid reference exists;
- 409 with `Retry-After: 5` if the automatic job is pending/processing;
- 503 if unavailable, terminal or never scheduled; 404 for missing/foreign journals;
- it never schedules, runs providers, clears a fence or retries an unchanged journal.

The dedicated frontend gallery never calls this POST. It remains available only
for older consumers; it cannot start or retry provider work.

## Dedicated Moments in Pixels gallery

`/memories` is a protected content page inside the existing AppShell. It shares
navigation, the account menu, theme controls and floating Record link. Dashboard
links to the page and retains its calendar/activity/reflection/mood features; it
no longer embeds a second gallery.

The UI shows exactly **seven consecutive browser-local calendar dates** ending on
the selected date, independently of the feed's seven occupied dates. It creates
seven stable slots and matches groups by `journal_date`, leaving unoccupied slots
empty and ignoring occupied dates outside that calendar range. It preserves all
journals/images on each visible date. Today follows the shared local-day clock at
midnight and on focus/timezone changes; historical selections stay fixed. The date
picker retains its `1000-01-07` minimum and today's local date as its maximum.

The grouped feed is the authoritative artwork/status source. Journal captions use
one authenticated journal-list read scoped to the visible seven calendar dates
on opening, explicit refresh/focus, and when
the feed changes. Unchanged polls do not refetch the journal list. Metadata is
validated before rendering: date/UUID/status structure, unique journal/image
identities, PNG dimensions/format/timestamps, exact authenticated content URLs,
and matching current journal/date associations. Invalid metadata never becomes
an arbitrary image URL. Associations that changed during the two reads display
an unavailable state until the next refresh, rather than moving an image to a
wrong date or journal.

### Read-only updates

The gallery polls the grouped feed approximately every five seconds only while a
visible journal is `pending` or `processing`, within a two-minute window. It stops
on terminal states, read failures, hidden tabs, unmount/navigation, logout and
account changes. Refresh, focus or returning to a visible tab opens a new bounded
window. Older pending occupied dates outside the visible calendar slots do not
start polling. A paused-update message offers a read refresh; there is no automatic
provider retry or generation POST. New journals/edits made elsewhere after all
visible jobs are terminal are discovered on refresh/focus.

Pending artwork appears automatically after a successful poll. Unchanged data
retains its snapshot, day components, image identities and Blob URLs; refresh does
not remount the whole gallery. Read errors preserve an existing authorized snapshot
with an error message, but authentication changes clear all private data. Late
metadata/image responses from old date ranges or sessions are ignored.

### Daily artwork navigation and image safety

A date with multiple ready artworks shows Previous/Next buttons **beneath** the
square image and a position such as `1 / 3`. Controls have descriptive accessible
names, visible focus, boundary disabled states and native keyboard/arrow-key
operation. There is no autoplay. Initial selection uses the earliest image creation
time, with journal UUID ties. Selection is latched by journal/image identity:
new images do not unexpectedly replace it; removal falls back to a valid remaining
artwork. The caption, image link and journal destination always follow that exact
selection. Other journals retain their own status and source links in the day's
expandable list. A ready artwork remains visible when other journals are pending.

All seven dates fit together on sufficiently wide screens; narrower viewports use
a contained horizontal scroller and larger cards. Images scale with their square
area using `object-fit: contain` and `image-rendering: pixelated`, without cropping
or overlays. Feature CSS is imported independently of Dashboard CSS and uses the
shared theme tokens in both Light and Dark.

The original authenticated PNG loader and `apiPng()` validation are retained.
They enforce canonical paths, cookies, no-store, redirect rejection, PNG content
and signature/size checks, request deadlines and auth epochs. Images use temporary
Blob URLs, revoked on replacement, removal, logout or unmount. Image download/decode
failures offer **Retry image**, which only repeats the PNG GET and does not change
backend generation status. Nothing is stored in localStorage. No manual generation
button, source selector, billable retry/check flow or `pixelGeneration.js` remains.

## Configuration, deployment and privacy

```dotenv
PIXELLAB_ENABLED=false
PIXELLAB_API_KEY=
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-20b
PIXEL_ART_WORKER_ENABLED=true
PIXEL_ART_CONCURRENCY=2
PIXEL_ART_USER_DAILY_LIMIT=20
PIXEL_ART_DAILY_LIMIT=200
JOURNAL_IMAGE_STORAGE_DIR=/absolute/private/persistent/journal-images
```

`PIXELLAB_ENABLED` gates new work and defaults false. Disabled saves persist terminal
`unavailable` jobs; enabling it does not replay them. Workers can remain running to
recover already-submitted output even while generation is disabled.
`PIXEL_ART_WORKER_ENABLED=false` stops workers in that process without dropping
pending jobs; keep at least one enabled application process for generation.
Concurrency is clamped to 1–4 and **must match across all replicas**, which must
share PostgreSQL/schema and the private persistent storage volume. Each process
creates that many worker threads, while shared slots enforce the configured total.
Budget database connections for these workers, advisory-lock connections, normal
requests and recovery. Direct or session-pooled PostgreSQL is required; transaction
pooling cannot preserve session advisory locks.

Provider-attempt budgets use the existing PostgreSQL rate-limit buckets: 10 per
user per minute, configured per-user daily (default 20), and configured shared
daily (default 200), across replicas. They include extraction retries and failed
attempts; recovery from a saved PNG does not consume budget. These are fixed
windows starting on first use, matching existing bucket semantics. Budget exhaustion
is terminal `unavailable` and does not block journal saving.

Before deployment, back up and run `alembic upgrade head` from `src/backend` using
owner credentials (`MIGRATION_DATABASE_URL`). Migration `0010` adds the version
column and job table **without generating any historical work**. Reapply
`scripts/database-runtime-role.sql` as administrator, or explicitly grant the
restricted runtime role SELECT/INSERT/UPDATE/DELETE on `pixel_art_jobs`. API/worker
processes use restricted runtime credentials, not migration-owner credentials.
The migration reversibly drops its table/column; downgrade loses job/fence history.
Stop all workers before downgrade and never reconstruct automatic jobs from that
lost history. Existing journal content and image references remain intact.

Keep images and backups private, outside static hosting. The blank storage setting
still defaults to ignored `var/journal-images`. Preserve volume permissions and use
deployment-managed encryption at rest. Schedule the existing cleanup command hourly
and after restarts, with the same DB/schema and storage configuration:

```sh
.venv/bin/python scripts/cleanup-journal-images.py
```

Cleanup retains referenced images and submitted recoverable/uncertain job outputs,
skips actively locked entries, and removes other orphan PNG/temp files. Inspect
worker fixed-message warnings, pending age, expired leases, terminal job counts,
provider budgets and cleanup exit status. DB/storage outages need operational
repair; this design does not provide an operations UI or provider-side result lookup.

**Disclosure/consent requirement before enabling automatic generation:** the
application must clearly explain before journal submission that saving or changing
journal text automatically sends the full journal to Groq and a minimized scene
to PixelLab, that artwork can be symbolic/inaccurate, and that provider processing,
retention and charges may apply. Obtain informed opt-in where required by the
product's privacy policy and applicable obligations. This PR supplies an operational
flag, not per-account consent storage/UI; keep generation disabled for users who
have not received the disclosure/required consent. The frontend now displays the
external-artwork disclosure before written journal saves, recorded-journal saves,
and content edits, explaining Groq/PixelLab transmission, symbolic/inaccurate art,
provider processing/retention and possible charges. It does not add a cosmetic
consent checkbox or change provider configuration.

**Remaining production blocker where per-user opt-in is required:** PR1 has no
per-account consent persistence or backend enforcement. Frontend disclosure alone
cannot enforce consent for direct API clients or other users. Add the required
backend consent policy/enforcement before enabling automatic generation for those
accounts; this frontend PR does not claim to solve that missing enforcement.
Credentials remain backend-only. Structural/evidence validation does not prove
semantic factuality or removal of all identifying details by the model. Provider
retention, backups and deletion are separate privacy/deployment responsibilities.

## Verification

Automated provider interactions are mocked; `tests/conftest.py` blocks real HTTP
and provider WebSockets. Use a disposable PostgreSQL test database:

```sh
cd src/backend
TEST_DATABASE_URL=postgresql+psycopg://user@localhost/aurajournal_test \
  ../../.venv/bin/python -m pytest tests -q
```

Coverage includes atomic outbox persistence, nonblocking saves, status transitions,
provider/budget failures, bounded retry, duplicate suppression, concurrent workers,
leases/restart recovery, saved-output recovery, uncertain commits, edit/delete
races, private content, multiple journals per date and no generation on reads.
Migration tests compare model metadata and exercise upgrade/downgrade without a
historical backfill. Run `npm run test:frontend` and `npm run build` from the root
for existing frontend compatibility. Browser coverage uses only fixture journals and canvas PNGs. It checks private
navigation/account isolation, automatic updates, Blob URL stability, unobstructed
carousel controls, disclosure placement, and 320/768/1024/1440-pixel layouts in both
themes. Run `npm run test:frontend:browser` with an installed Chromium/Chrome/Brave
(or `BROWSER_BIN`) for these optional browser checks. No live provider call is
required or implied.

Any live evaluation requires separate explicit authorization, fictional journals,
a test account, provider credits and the deployment/privacy prerequisites above.
Saving a journal with providers enabled is itself billable; no Generate action is
needed. Observe the status GET/feed until completion, inspect the private PNG,
then test date/content edits and deletion. Never log real journals or credentials.
