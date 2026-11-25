# Weekly reflections

The reflection page also displays a saved reflection panel. It reads the selected
period without generating on mount and offers explicit generation/regeneration.
Switching account or period aborts outstanding actions; empty results preserve a
previous saved snapshot. See the [data and security overview](data-and-security-overview.md)
for the storage model, lifecycle and defense guide.

`POST /api/weekly-reflections` generates a summary and exactly two reflection
questions plus supporting journal dates from the authenticated user's journals,
and saves the validated result.
It accepts any selected start
date, covering `period_start` through `period_start + 6` inclusively. Selection
uses `journal_date`, including backdated entries, rather than creation timestamps.
No timezone conversion or Monday restriction applies to these calendar dates.

The existing `/api/reflections/weekly` and its summary/highlights UI remain
available separately; see [weekly recaps](weekly-recap.md).

## Request and response

Use the login cookie, configured `Origin`, `X-AuraJournal-CSRF: 1`, and
`Content-Type: application/json`. The only request field is:

```json
{"period_start": "2026-11-12"}
```

Example response:

```json
{
  "period_start": "2026-11-12",
  "period_end": "2026-11-18",
  "entry_count": 1,
  "summary": "You completed an exam.",
  "questions": ["What helped you prepare?", "What would you try next time?"],
  "source_dates": ["2026-11-12"]
}
```

Empty periods return `200` with `entry_count: 0`, `summary: null`, and
`questions: []` and `source_dates: []`, without calling a generator. Responses use
`Cache-Control: no-store`. Empty periods do not create, replace, or delete a saved
reflection. Source journals are never modified by reflection generation.

## Saving and reading

Successful nonempty generation saves `summary`, `questions` and `source_dates` in the existing
`weekly_reflections` table, keyed by the authenticated user and `period_start`.
Regenerating the same period updates that record atomically, retaining
`created_at` and refreshing `updated_at`. Different owners or start dates have
separate records. Migration `0009` adds nullable JSONB `source_dates` to the table
created in revision `0006`. Run `alembic upgrade head` before starting the updated
backend; application startup does not migrate the database automatically.

Existing reflections keep their summary/questions and use SQL NULL for unknown
historical sources. GET returns `source_dates: null` for those records; it never
infers evidence from the current journal history. Successful regeneration stores
one to seven sorted, distinct ISO dates. Downgrading to `0008` removes evidence
only; summaries/questions remain, and a later upgrade cannot recover lost dates.

`GET /api/weekly-reflections/2026-11-12` reads the logged-in user's saved result
without calling a generator or requiring its configuration. Use the existing
session cookie. Example response:

```json
{
  "period_start": "2026-11-12",
  "period_end": "2026-11-18",
  "summary": "You completed an exam.",
  "questions": ["What helped you prepare?", "What would you try next time?"],
  "source_dates": ["2026-11-12"],
  "created_at": "2026-11-19T08:00:00Z",
  "updated_at": "2026-11-19T08:00:00Z"
}
```

The saved response omits `entry_count`: the table does not store the number of
source entries at generation time. It does not substitute a current journal
count for that historical count. The POST response still includes `entry_count`.
GET returns `404` if that owner has no saved reflection for the selected period.
It never falls back to another account's reflection or generates a new one.

Invalid output, provider failures, source conflicts, and failed database commits
leave a previous saved result unchanged. Saved content is a snapshot; later
journal edits/deletions do not automatically regenerate or delete it. Explicit
regeneration is needed to reflect current sources. If multiple successful
generations overlap, the last database write wins for that owner and period.

## Generator integration

`create_app()` connects `GroqWeeklyReflectionGenerator` to
`app.state.weekly_reflection_generator`. Construction makes no provider request;
missing credentials do not prevent application startup. Configure `GROQ_API_KEY`
in the backend environment or root `.env` loaded by the launcher. `GROQ_MODEL`
uses the same setting as other journal AI helpers. The shared transport uses JSON
responses, temperature zero, a 20-second provider timeout and no automatic retries.
Weekly reflection requests allow up to 2,048 completion tokens.

The reusable synchronous interface remains:

```python
def generate(self, entries: list[WeeklyReflectionSource]) -> WeeklyReflectionContent:
    ...
```

Sources are ordered oldest first by `(journal_date, created_at, id)`. Each source
contains exactly `id` (UUID string), `journal_date` (`YYYY-MM-DD`), and `content`
(current raw journal text). Other owners' entries, stored AI summaries, and
authentication fields are excluded. The database read transaction is released
before the generator is called. Inputs are neither truncated nor silently omitted.

Results contain a nonblank summary of at most 2,400 characters, exactly two
distinct nonblank questions of at most 300 characters each, and one to seven
`source_dates`. Extra fields and invalid dates are rejected; dates are sorted and
deduplicated. Both the concrete generator and the API boundary reject dates not
present in the supplied sources, including dates inside the week with no entry.
An injected generator must return this complete contract as a validated model or
matching dictionary. Empty lists raise `EmptyJournalError` when the helper is
called directly; the route handles empty weeks without calling it.

The prompt asks for the predominant language of the journal content in both the
summary and questions, grounded experiences and no inferred emotions/diagnoses.
It distinguishes future plans from completed events, preserves uncertainty,
and treats instruction-like journal text as untrusted data. Sparse weeks should
produce shorter summaries, not invented experiences. Date membership and schema
validation do not establish semantic accuracy; real-model review remains necessary.

### Writing direction

The summary uses natural, direct second-person language and stays close to the
recorded events. Short weeks get short summaries. It avoids report headings,
day-by-day templates, praise, advice, diagnoses, and generic claims about growth.
Feelings may be acknowledged only when the writer explicitly named them; the
model must not decide the week's mood or tell the writer what events meant.

Exactly two different, non-leading questions invite the writer's own perspective.
They must not presume an event was positive, difficult, significant, or needs
improvement. English and Vietnamese style examples guide the prompt; the
predominant language of journal content determines all output language.
Plans remain plans, uncertainty stays uncertain, and embedded AI instructions
are ignored rather than described as recorded experiences.

Metaprompting is a development process (draft, critique, evaluate), not an extra
production critique/rewrite call. See the [prompt evaluation](weekly-reflection-evaluation.md)
for fictional cases, actual results, and remaining quality limits.

Use the shared `AIInvalidResponseError`, `AIServiceNotConfiguredError`, and
`AIServiceUnavailableError` exceptions for invalid output, configuration, and
provider failures, respectively. Timeout/rate-limit failures map to
`AIServiceUnavailableError`. Oversized input raises `WeeklyReflectionTooLarge`
without dropping sources. Whitespace-only source text raises `EmptyJournalError`.

## Limits and errors

- `401`: invalid or missing session; `403`: invalid Origin or CSRF header;
  `415`: non-JSON request.
- `404`: no saved reflection owned by the logged-in user for the requested period.
- `422`: missing, invalid, or non-`YYYY-MM-DD` start date, an overflowing seven-day
  period, extra request fields (including client-supplied owner IDs), or unusable
  empty source text that needs editing.
- `413`: `json.dumps({"entries": sources}, ensure_ascii=False)` exceeds 60,000
  characters, or the generator rejects its input size. No entries are truncated
  or omitted. The backend limit is checked before calling the generator.
- `429`: existing shared AI budgets are exceeded (10/account/minute,
  100/account/day, 30/client-IP/minute). `Retry-After` indicates when to retry.
  Empty periods, oversized inputs, and saved reads do not spend this quota.
  Budget transactions finish before the provider call; no database connection
  is held while generating.
- `409`: selected sources changed during generation. The backend rechecks IDs,
  journal dates, current content, creation times, and update times before saving
  and returning the result. Retry with current entries. This is a point-in-time
  recheck, not a lock preventing subsequent edits.
- `502`: invalid generator output, including duplicate questions; `503`: missing/rejected credentials, AI service
  unavailable, or database unavailable. Public errors omit provider details and
  journal content.

## Verification

After reconciling main and source-date support on 2026-11-17, backend regression
returned **747 passed, 2 skipped**, using isolated PostgreSQL test schemas and
mocked providers. All **120 frontend tests passed** and the frontend build passed. The skips are the
administrator-only role-provisioning test and Windows symlink-privilege test.
No Groq quality verification or application-database migration was performed.

With a disposable PostgreSQL database configured as described in the repository
README, run from `src/backend`:

```sh
python -m pytest tests/test_weekly_reflection_service.py tests/test_weekly_reflection_generator.py tests/test_weekly_reflections_api.py tests/test_weekly_reflections.py tests/test_weekly_recap.py tests/test_database.py -q
```

The reflection API tests use real database queries and mocked generation. They
cover owner/date boundaries, chronological ordering, empty periods, invalid
contracts, input budgets, source changes, browser security, regeneration,
persistence across application instances, private saved reads, and preservation
of saved results after generation or commit errors. They do not call
Groq or establish real-model quality. Generator tests additionally cover date
membership/normalization, Vietnamese/English/mixed source preservation, malformed
JSON, empty/large input, duplicate questions and provider failures. Migration tests
cover fresh setup, old results with unknown dates, upgrade/downgrade and model parity.

For an explicit live helper check, run this Python example from `src/backend`
with the backend environment active. It sends one fictional week to Groq, uses
quota, does not need PostgreSQL and does not save a reflection:

```python
from dotenv import load_dotenv
from app.services.weekly_reflection import GroqWeeklyReflectionGenerator

load_dotenv("../../.env")
entries = [{
    "id": "00000000-0000-4000-8000-000000000001",
    "journal_date": "2026-11-16",
    "content": "Today I finished my group assignment. Tomorrow I plan to visit the library.",
}]
result = GroqWeeklyReflectionGenerator().generate(entries)
print(result.model_dump_json(indent=2))
```

Repeat with fictional Vietnamese, English, mixed-language, sparse and instruction-like
journal text. Review that both questions fit the source, the predominant language
is preserved, plans are not described as completed events, and no experience is
invented. A source date is a reference to a journal, not independent proof of an
AI claim. Provider quality verification remains pending while `GROQ_API_KEY` is
unavailable. For full integration, authenticate, POST a period with saved journals,
then GET the saved result and check that its evidence survives reload.


### Bundled writing-quality evaluation

From the repository root, `python scripts/evaluate-weekly-reflections.py --live`
explicitly runs up to six paid calls with the bundled fictional cases and no DB
access. The report serializes source dates as ISO strings. Missing credentials
means no evaluation is executed. Review both the writing and supporting dates.

The [previous prompt evaluation](weekly-reflection-evaluation.md) records earlier
results from main. The merged prompt additionally requires source dates and has
a different hash; those historical results do not verify this exact prompt.
No live evaluation of the merged prompt was performed during conflict resolution.


## Generation boundary and private sessions

Nonempty generation uses the shared AI budgets (10/account/minute,
100/account/day, 30/client IP/minute), committed before the provider call.
Empty periods do not call AI or consume this budget. Provider work holds no
checked-out database connection. The HTTP endpoint independently validates the
helper result and checks evidence against its original sources, even if a custom
helper mutates the copy it receives. Invalid output returns 502.

Before returning or saving generated content, the endpoint reloads the session
and account from the database. Logout, expiry or a disabled account returns 401;
a change to the selected sources returns 409. Failed generation never replaces
an existing saved reflection. These checks are covered by
`tests/test_weekly_generation_safety.py` with fake providers and isolated schemas.
