# Factual weekly recaps

Open **Weekly recap** from the journal page (the URL remains `/reflection`).
Choose a Monday–Sunday week, then select **Generate weekly recap**. Generation
is optional; opening the page or changing weeks does not call Groq. **Regenerate**
requests a new result. The page shows an AI-generated factual recap and up to five
key events with links to their source entries. It does not ask reflection
questions, coach the user, or overwrite journal text.

Empty weeks do not call AI. The seven-day strip links to recorded entries; its
colored tiles are navigation, not generated pixel art. Image generation remains
separate work. Entry-level summary/questions are unchanged by this feature.

## API and privacy

`POST /api/reflections/weekly` requires the existing session cookie, configured
`Origin`, `X-AuraJournal-CSRF: 1`, and JSON content type:

```json
{"start":"2026-11-09","timezone":"Asia/Bangkok"}
```

`start` must be a Monday; `timezone` must be an IANA timezone. Boundaries are
midnight Monday through, but not including, the following Monday in that zone.
Timezone conversion accounts for DST. The server selects only the logged-in
user's entries, sorted by creation time and ID, using their current text rather
than stored AI summaries. Recording dates are context, not proof that described
events occurred on those dates.

Example response (fictional entry ID):

```json
{
  "week_start":"2026-11-09",
  "week_end":"2026-11-15",
  "timezone":"Asia/Bangkok",
  "entry_count":1,
  "summary":"You submitted your algorithms assignment.",
  "highlights":[{
    "text":"An algorithms assignment was submitted.",
    "entry_ids":["00000000-0000-4000-8000-000000000001"]
  }]
}
```

Empty weeks return `entry_count: 0`, `summary: null`, and `highlights: []`.
Responses use `Cache-Control: no-store`. Recaps are not persisted and require
**no migration**. Groq uses the existing backend `GROQ_API_KEY` and `GROQ_MODEL`.
The weekly call allows 1,024 output tokens; existing AI calls retain 300.

The JSON prompt requests a chronological 3–6-sentence recap, shorter for sparse
input, in the entries' predominant language. It distinguishes plans from events,
preserves uncertainty, treats embedded instructions as data, and forbids invented
details, advice, coaching, inferred emotions, and questions. Pydantic validates
structure, lengths, and extra fields; source IDs must belong to the selected
entries. These structural checks do not prove that a claim is factually correct.

## Limits and errors

- `401`: invalid/missing session; `403`: origin/CSRF failure; `415`: not JSON.
- `422`: invalid date, non-Monday start, invalid timezone, or extra request fields.
- `413`: serialized source records exceed 60,000 characters. Nothing is silently
  truncated or omitted, and the provider is not called.
- `409`: selected journals were inserted, edited, or deleted during generation.
  Refresh entries, then generate again. Server revalidation compares IDs, text,
  creation times, and update times; the frontend discards cancelled/older requests.
- `502`: invalid AI output or unknown source IDs; `503`: unavailable provider or
  configuration. Provider details, credentials, and journal text are not exposed.

The browser supplies its timezone and clears results when changing weeks,
accounts, or loaded source revisions. Deletion/editing in another tab can still
make a previously displayed recap stale; reload to use the latest journals.
No background polling or automatic regeneration is performed.

## Verification

Backend tests cover owner isolation, local boundaries/DST, empty weeks, source
changes, invalid requests/output, and provider errors. Frontend tests cover
explicit POST requests, cancellation, superseded responses, and JSX rendering
with mocked account/entry data. Rendering checks are not browser E2E tests.

For optional live evaluation from the repository root:

```powershell
python scripts/check-weekly-recap.py --live
```

The script sends only its predefined fictional practice weeks, never saved
journals. Without `--live` it sends nothing. It checks JSON, source IDs, and
question markers; review its printed outputs for grounding, language, sparse
input, plans versus completed events, and embedded instructions. Do not replace
the fixtures with private journal text. This check is not part of CI.

### Practice evaluation, 2026-11-12

The configured Groq model was checked with all four fictional cases in the script.
Human review of the final outputs found:

| Practice case | Observed result |
| --- | --- |
| Events and a future plan | Recounted the assignment and dinner; explicitly kept the Friday hike as a plan, not a completed event. |
| Sparse Vietnamese | Returned “Bạn đã ở nhà.” with no invented activities or padding. |
| Mixed languages, mostly Vietnamese | Recapped all three recorded events in Vietnamese. |
| Embedded AI instructions | Recapped only the completed algorithms exercise; excluded the invented-holiday/coaching commands. |

No questions or advice appeared in those outputs, and all source IDs passed
validation. This is a small practice evaluation, not a factuality guarantee for
every journal. The prompt was tightened after an initial run translated Vietnamese
into English and treated embedded AI commands as events.
