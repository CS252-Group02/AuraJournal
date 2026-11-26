# Journal-grounded questions

`POST /api/entries/ask` answers one question using a bounded set of the signed-in
user's relevant journal excerpts. It is separate from weekly reflection and does
not create a chat history or modify journals. Only the question is accepted from
the client; identity and source context always come from the backend.

## Request and response

Use the existing login cookie, configured Origin, `X-AuraJournal-CSRF: 1`, and
`Content-Type: application/json`:

```json
{"question": "Where did I have coffee?"}
```

A supported answer has status `answered` and supporting journal dates:

```json
{
  "status": "answered",
  "answer": "You had coffee at the riverside cafe.",
  "source_dates": ["2026-11-18"]
}
```

Empty history, no relevant matches, or insufficient evidence return 200 with
status `insufficient_evidence`, a safe explanation, and `source_dates: []`.
The fallback message uses Vietnamese or English when identifiable. A model's
insufficient-evidence result is replaced by this deterministic message.
Provider failures are errors, not invented successful answers.

Questions must contain nonblank text of at most 1,000 characters. Unsupported
control characters and extra fields (including owner IDs or supplied entries)
are rejected. Answers are nonblank, at most 2,400 characters. Source dates are
strict calendar dates, sorted and deduplicated; an answered result requires at
least one date, and every date must occur in the actual excerpts supplied.
Dates identify source journals, not proof that every event occurred on that day.
Clients can use `/api/entries/by-date?date=...` to open the supporting day.

## Retrieval and context limits

Retrieval runs in PostgreSQL with the authenticated owner filter applied before
ranking and limiting. It selects only journal IDs, journal dates and raw journal
content. Other owners' entries, saved AI summaries, image references and auth
fields are not supplied as context.

- Up to 12 distinct meaningful question terms are matched as literal whole words.
  English/Vietnamese stop words are removed. Case, Vietnamese diacritics and
  decomposed Unicode are normalized for matching; excerpts preserve original text.
- Exact `YYYY-MM-DD` dates in the question constrain selection to those journal
  days. Date-only questions can supply context without keyword matches. Invalid
  calendar dates return no relevant context rather than selecting a different day.
- Results rank by matched-term count, then journal date, creation time and UUID
  descending for stable ties. Old relevant entries can be found without loading
  or sending a user's complete history.
- At most five journals are selected. Each excerpt is at most 1,200 characters,
  placed around a matched word when available. The serialized JSON question and
  excerpts are capped at 8,000 characters, including JSON escaping.
- Without relevant terms or dates, no recent-journal fallback is performed.
  Empty matches do not call an AI service or spend the shared AI quota.

This is lexical retrieval, without embeddings, a vector database, stemming or
semantic synonym matching. Relative dates such as yesterday are not interpreted
as calendar filters. Generic questions with no specific matching terms may lack
context even when history exists. Ask about a concrete term or explicit date.
Bounded excerpts may omit evidence; the answer must not imply an exhaustive
search or all-history total. Weekly summaries remain a separate feature.

## Replaceable answerer

`GroqJournalQuestionAnswerer` implements the replaceable `JournalQuestionAnswerer`
protocol independently of weekly reflection. Another Q&A helper can implement
this interface and be assigned to `app.state.journal_question_answerer`:

```python
def answer(self, question: str, entries: list[JournalQASource]) -> JournalAnswerResponse:
    ...
```

Each source contains exactly `id` (UUID string), `journal_date` (`YYYY-MM-DD`)
and `content` (the bounded excerpt). Both the concrete adapter and API boundary
validate source dates. The answerer receives copies of the records, so it cannot
alter the original allowed dates used for boundary validation. Implementations
should raise the shared `AIInvalidResponseError`, `AIServiceNotConfiguredError`
and `AIServiceUnavailableError` for output, configuration and provider failures,
respectively. `JournalQuestionTooLarge` maps to the context-limit response.

The prompt restricts answers to the excerpts, treats instruction-like journal
text as untrusted data, preserves plans/negation/uncertainty, and uses the question's
language. It must admit missing evidence, avoid general-knowledge answers,
unstated emotions or diagnoses, and avoid claiming full-history coverage.
Schema/date checks cannot establish semantic accuracy; real-model quality still
needs review with fictional Vietnamese/English cases.

## Configuration, privacy and failures

Questions with selected context send the question and bounded excerpts from the
authenticated user's journals to the configured Groq service. Configure backend
`GROQ_API_KEY` and optional `GROQ_MODEL`, shared with the existing Groq helpers. There are no new dependencies,
migrations or profile settings. Construction makes no provider request; missing
credentials do not block startup or local no-evidence responses.

Relevant-context requests make one structured Groq call, with at most 1,536 output
tokens, a 20-second provider timeout and no automatic retries. Only the question
and selected dated excerpts are sent. The feature adds no question, excerpt or
answer logs and persists none of that text; the existing hashed rate-limit
counters still change.

The shared limits are 10 attempts/account/minute, 100/account/day and
30/client-IP/minute. They are committed before provider access and are not
refunded on failure. No database transaction/connection is held during generation.
Before returning private text, the API rechecks the session and selected source
IDs, owner, journal dates and full text. This is a point-in-time recheck; it does
not lock out edits after the check. Changes to unselected journals do not rerun
retrieval or invalidate the selected-context snapshot.

| Status | Meaning |
| --- | --- |
| 200 | Answered, or an honest insufficient-evidence result |
| 401 | Missing/expired/revoked session, or disabled account; session is checked again after generation |
| 403 / 415 | Browser Origin/CSRF or JSON content-type protection rejected the request |
| 422 | Invalid/empty/oversized question or unsupported request fields |
| 413 | Request-body limit or context rejected as too large |
| 429 | Shared AI quota exceeded; includes Retry-After |
| 409 | Selected journals changed, disappeared or changed owner during generation |
| 502 | Invalid AI/helper structure or unsupported source dates |
| 503 | Missing/rejected Groq credentials, provider timeout/quota/network error, or database failure |

Errors omit provider bodies, credentials, SQL and submitted journal text.
Responses use `Cache-Control: no-store`. No fallback to another AI provider,
weekly reflection, or unrelated journal history is performed.

## Verification

Verified on 2026-11-20: **74 focused retrieval/service/API tests passed**, and
the complete backend suite returned **892 passed, 2 skipped**. The skips are the
existing administrator-only database-role test and Windows symlink-privilege
test. All provider calls were faked or blocked, and database checks used isolated
PostgreSQL schemas. No live Groq call, private-journal submission, or application
database migration was performed during verification.

From `src/backend`, set `TEST_DATABASE_URL` to the disposable PostgreSQL database
from the README and run:

```sh
python -m pytest tests/test_journal_retrieval.py tests/test_journal_qa_service.py tests/test_journal_qa_api.py -q
```

Tests use isolated database schemas, authenticated API calls and fake provider
responses. They cover Unicode/diacritic matching, ranking and old sources,
explicit dates, serialized context bounds, absent/unrelated histories, cross-user
privacy, malformed output, quota/errors, source edits/deletion, logout/disable
during generation and preservation of journal content. External HTTP is blocked;
these tests send no private journal to Groq and do not prove model-answer quality.

Live evaluation was not run: this environment has no configured `GROQ_API_KEY`.
After configuring it, use fictional saved journals and explicit questions from
a signed-in account, then inspect meaning and source dates. Try a related question,
an unrelated topic, an unsupported date, mixed languages and a journal containing
AI-directed instructions. A frontend Q&A screen is separate from this backend API.

## Grounding verification

The current prompt checks unsupported question premises and conflicting
accounts, requiring the dates needed to support every retained claim. See the
[shared grounding verification](journal-grounding-verification.md) for answerable,
missing-information, conflicting and injected-input cases and live review status.
