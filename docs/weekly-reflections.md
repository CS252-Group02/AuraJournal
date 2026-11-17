# Weekly reflections

`POST /api/weekly-reflections` generates a summary and exactly two reflection
questions from the authenticated user's journals and saves the validated result.
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

Example response (wording varies with the journals):

```json
{
  "period_start": "2026-11-12",
  "period_end": "2026-11-18",
  "entry_count": 1,
  "summary": "You completed an exam.",
  "questions": ["What helped you prepare?", "What would you try next time?"]
}
```

Empty periods return `200` with `entry_count: 0`, `summary: null`, and
`questions: []`, without calling a generator. Responses use
`Cache-Control: no-store`. Empty periods do not create, replace, or delete a saved
reflection. Source journals are never modified by reflection generation.

## Saving and reading

Successful nonempty generation saves `summary` and `questions` in the existing
`weekly_reflections` table, keyed by the authenticated user and `period_start`.
Regenerating the same period updates that record atomically, retaining
`created_at` and refreshing `updated_at`. Different owners or start dates have
separate records. This uses database revision `0006`; no new migration is needed.

`GET /api/weekly-reflections/2026-11-12` reads the logged-in user's saved result
without calling a generator or requiring its configuration. Use the existing
session cookie. Example response:

```json
{
  "period_start": "2026-11-12",
  "period_end": "2026-11-18",
  "summary": "You completed an exam.",
  "questions": ["What helped you prepare?", "What would you try next time?"],
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

Application setup now connects `GroqWeeklyReflectionGenerator`, implementing the
existing `WeeklyReflectionGenerator` protocol in
`app/services/weekly_reflection.py`. Its synchronous method is:

```python
def generate(self, entries: list[WeeklyReflectionSource]) -> WeeklyReflectionContent:
    ...
```

Set backend `GROQ_API_KEY` and optionally `GROQ_MODEL`, shared with other journal
AI features. Construction is lazy: missing credentials do not break startup;
generation returns a safe 503. Each nonempty generation makes one structured
Groq call with at most 1,536 completion tokens and no automatic retries. GET reads
saved results without credentials or provider calls.

Sources are ordered oldest first by `(journal_date, created_at, id)`. Each source
contains exactly `id` (UUID string), `journal_date` (`YYYY-MM-DD`), and `content`
(current raw journal text). Other owners' entries, stored AI summaries, and
authentication fields are excluded. The database read transaction is released
before the generator is called.

Return `WeeklyReflectionContent` (a matching dictionary is also validated by the
route): a nonblank summary of at most 2,400 characters and exactly two nonblank
question strings of at most 300 characters each. Extra fields are rejected.
The concrete generator also rejects duplicate questions after whitespace/case
normalization, preserving the existing saved result on failure.
Treat journal text as untrusted source data. Language, grounding, and question
quality must be implemented and evaluated by the generator; structural validation
alone does not establish them.

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
provider failures, respectively. Timeout/rate-limit failures should map to
`AIServiceUnavailableError`. A stricter provider input budget can raise
`WeeklyReflectionTooLarge` without truncating the sources.

## Limits and errors

- `401`: invalid or missing session; `403`: invalid Origin or CSRF header;
  `415`: non-JSON request.
- `404`: no saved reflection owned by the logged-in user for the requested period.
- `422`: missing, invalid, or non-`YYYY-MM-DD` start date, an overflowing seven-day
  period, or extra request fields (including client-supplied owner IDs).
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

B04's backend generate/persist/retrieve flow is implemented. Verification on
Windows/Python 3.11.18 returned **62 focused generator/API tests passed** and
**654 backend tests passed, 1 skipped**. The skip was the existing role-provisioning
test requiring an explicit disposable-cluster administrator URL. The full run
emitted one Starlette/AnyIO dependency warning. All automated provider calls were
faked, and database tests used isolated schemas in `aurajournal_test`. No
application database migration or reset was performed. The refined prompt also
passed the 17 mocked generator tests; writing-quality evaluation is documented
separately and must not be inferred from those tests.

With a disposable PostgreSQL database configured as described in the repository
README, run from `src/backend`:

```sh
python -m pytest tests/test_weekly_reflection_generator.py tests/test_weekly_reflections_api.py tests/test_weekly_recap.py
```

The reflection API tests use real database queries and mocked generation. They
cover owner/date boundaries, chronological ordering, empty periods, invalid
contracts, input budgets, source changes, browser security, regeneration,
persistence across application instances, private saved reads, and preservation
of saved results after generation or commit errors. The concrete generator is
also exercised through generate/save/read with two real registered accounts and
a fake Groq transport. GET never regenerates, and accounts cannot read each
other's reflections. Automated tests do not call Groq or establish writing quality.

From the repository root, a separate explicit opt-in runs at most six paid calls
using only the bundled fictional English/Vietnamese inputs, with no DB access:

```powershell
python scripts/evaluate-weekly-reflections.py --live
```

Never replace these samples with private journals. The JSON report includes the
configured model, prompt hash, expected review criteria, and actual outputs;
provider errors expose only their safe exception type. Missing credentials means
the evaluation was not executed. Review meaning and tone manually, not with exact
wording assertions or a blanket ban on emotion-related words.
