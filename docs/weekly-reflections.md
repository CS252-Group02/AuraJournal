# Weekly reflection generation

`POST /api/weekly-reflections` generates a summary and exactly two reflection
questions from the authenticated user's journals. It accepts any selected start
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

Example response after a generator has been connected:

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
`Cache-Control: no-store`. Generation does not save a `WeeklyReflection` or
modify source journals. Saving and reading reflections are not implemented yet.

## Generator integration

The backend implements the query, HTTP contract, validation, and error handling.
The provider-specific reflection generator is not implemented or connected yet.
`app.state.weekly_reflection_generator` defaults to `None`: nonempty periods
return `503` until a real generator is assigned during application setup.
There is no production placeholder that invents a summary or questions.

Implement `WeeklyReflectionGenerator` in `app/services/weekly_reflection.py` and
assign its instance in `create_app()`. Its synchronous method is:

```python
def generate(self, entries: list[WeeklyReflectionSource]) -> WeeklyReflectionContent:
    ...
```

Sources are ordered oldest first by `(journal_date, created_at, id)`. Each source
contains exactly `id` (UUID string), `journal_date` (`YYYY-MM-DD`), and `content`
(current raw journal text). Other owners' entries, stored AI summaries, and
authentication fields are excluded. The database read transaction is released
before the generator is called.

Return `WeeklyReflectionContent` (a matching dictionary is also validated by the
route): a nonblank summary of at most 2,400 characters and exactly two nonblank
question strings of at most 300 characters each. Extra fields are rejected.
Treat journal text as untrusted source data. Language, grounding, and question
quality must be implemented and evaluated by the generator; structural validation
alone does not establish them.

Use the shared `AIInvalidResponseError`, `AIServiceNotConfiguredError`, and
`AIServiceUnavailableError` exceptions for invalid output, configuration, and
provider failures, respectively. Timeout/rate-limit failures should map to
`AIServiceUnavailableError`. A stricter provider input budget can raise
`WeeklyReflectionTooLarge` without truncating the sources.

## Limits and errors

- `401`: invalid or missing session; `403`: invalid Origin or CSRF header;
  `415`: non-JSON request.
- `422`: missing, invalid, or non-`YYYY-MM-DD` start date, an overflowing seven-day
  period, or extra request fields (including client-supplied owner IDs).
- `413`: `json.dumps({"entries": sources}, ensure_ascii=False)` exceeds 60,000
  characters, or the generator rejects its input size. No entries are truncated
  or omitted. The backend limit is checked before calling the generator.
- `409`: selected sources changed during generation. The backend rechecks IDs,
  journal dates, current content, creation times, and update times before returning
  the result. Retry with current entries. This is a point-in-time recheck, not a
  lock preventing subsequent edits.
- `502`: invalid generator output; `503`: generator not connected, AI service
  unavailable, or database unavailable. Public errors omit provider details and
  journal content.

## Verification

With a disposable PostgreSQL database configured as described in the repository
README, run from `src/backend`:

```sh
python -m pytest tests/test_weekly_reflections_api.py tests/test_weekly_recap.py
```

The reflection API tests use real database queries and mocked generation. They
cover owner/date boundaries, chronological ordering, empty periods, invalid
contracts, input budgets, source changes, and browser security. They do not call
Groq or establish real-model quality. End-to-end AI verification is pending the
generator integration.
