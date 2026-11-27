# Journal grounding verification

A08 uses the existing weekly reflection and journal Q&A services. The change
refines their prompts and adds a shared, repeatable evaluation suite; no API,
dependency, environment-variable or database migration is introduced.

## Production contracts

| Flow | Source selection | Validated result | Empty/long input |
| --- | --- | --- | --- |
| Saved weekly reflection | Authenticated owner, `period_start` through six days later inclusive, by `journal_date`; full current text ordered chronologically | `summary`, exactly two distinct `questions`, sorted distinct `source_dates` from supplied records | Empty period returns null summary and empty lists, without AI or writes. JSON over 60,000 characters or a provider input-size rejection returns 413; no truncation or dropped entries. |
| Journal Q&A | Authenticated owner; existing lexical retrieval, optionally constrained to exact dates mentioned in the question | `status`, `answer`, supporting `source_dates`; unknown source dates rejected | No matches skip AI. A model declaring insufficient evidence gets the canonical safe message and no sources. At most five excerpts of 1,200 characters; JSON capped at 8,000 characters. |

Sources are `{id, journal_date, content}`. Dates identify the journals supporting
the response, not necessarily the dates events occurred. The date list supports
the response as a whole; the API does not expose per-sentence citations. Stored
AI text is never reused as journal evidence. Source/session changes during a
provider call are rechecked by the existing endpoints (409/401); failures retain
saved reflections. See [weekly contracts](weekly-reflections.md) and
[Q&A contracts](journal-questions.md) for request examples and HTTP errors.

Q&A exact dates are a set, not an inclusive range: a question mentioning two ISO
dates retrieves those two days. There is no new start/end request field. Lexical
retrieval is bounded and can miss synonyms or relevant text outside an excerpt;
the prompt must not claim it inspected the complete history. A week with no
entries is different from a nonempty but sparse week.

## Prompt refinements

The reflection prompt asks the model to check each summary clause and each
question premise against the sources, cite dates for retained events, keep
unrelated topics separate, and avoid claims that a selective summary covers
every experience. The Q&A prompt explicitly checks question presuppositions,
cites both sides of conflicting accounts, and avoids resolving uncertainty by
guessing. Existing rules preserve negation, plans, source language and embedded
instruction boundaries. These are model instructions, not a semantic proof.

## Reproducible fictional cases

`scripts/journal-grounding-cases.json` contains eight review cases and grounded
example outputs. Examples serve as fixture outputs in fake-provider tests;
they are never sent to the live provider. All identities and experiences are
fictional. Neither the script nor the fixture accesses the application database.

| Case | Check |
| --- | --- |
| sparse-vietnamese | Brief factual Vietnamese summary and two relevant questions, no invented activity or emotion |
| mixed-topics | Vietnamese/English records, unrelated events, names and dates preserved |
| plans-negation-injection | Uncertain plan followed by explicit non-attendance; ignore a fabricated holiday instruction |
| long-week | More than 40,000 characters across ten entries, each within the 5,000-character journal limit; retain evidence at the end, no invented approval |
| dated-mixed-answer | Answer in Vietnamese using the dated source, preserve Alex's name |
| missing-information | No recorded price: acknowledge missing information without estimating |
| conflicting-accounts | Cite both amounts and dates; preserve uncertainty |
| negated-trip-injection | Do not adopt an unsupported flight premise or follow embedded instructions |

Run from CMD:

```cmd
cd /d D:\Lab_CT\AuraJournal
.venv\Scripts\python.exe -B -X utf8 scripts\evaluate-journal-grounding.py
```

The default run validates fixture contracts and prints the review inventory with
zero provider calls. It does not establish language-model quality. For a
separately authorized live evaluation, put `GROQ_API_KEY` in the root `.env`, then:

```cmd
if not exist external_api_tests\test-local-data\grounding mkdir external_api_tests\test-local-data\grounding
.venv\Scripts\python.exe -B -X utf8 scripts\evaluate-journal-grounding.py --live --output external_api_tests\test-local-data\grounding\review-NEW.json
```

Use a new filename each time. A run makes one helper invocation per selected
case, up to eight real requests, with the existing 20-second Groq timeout and
zero SDK retries. Repeating the command is a new billable run. Optional repeated
`--case NAME` selects fewer cases. Unknown cases, a missing key, or an existing
report file stop before a provider call. Credentials and raw provider errors are
never written to the report. No private journals or audio are read or sent.

Reports contain the model, fixture/prompt hashes, attempt ledger, validated
outputs, contract/date checks and manual review criteria. They remain in the
ignored local directory. An interrupted call is recorded as `attempting`;
never assume it was free or rerun automatically. An authentication failure stops
the remaining cases. Other failures are recorded once without retry.

The automated checks verify shape, allowed dates, and the Q&A case's expected
status/date set. They do not compare wording or detect every unsupported claim.
`semantic_review` remains `pending` until a reviewer compares actual output with
the fixture and records a separate review. Do not interpret `checks: passed` as
a guarantee of factual language. The model can still cite a valid date beside
an unsupported claim.

## Verification and handoff

The new API tests insert fictional raw journals into an isolated PostgreSQL test
schema, exercise the real production adapters through authenticated endpoints
with fake provider completions, and inspect exact provider input. They verify
owner/date filtering, backdated selection despite later creation times, complete
long input, saved/read evidence, no journal edits, no stored-AI evidence, and no
provider calls for empty input. Other existing suites cover malformed results,
source races, quotas and safe failures. Pytest blocks real provider traffic.

The full backend run completed with **1,180 passed, 2 skipped**. The skips are
the existing optional administrator-role and Windows symlink-privilege checks.
That run preceded the final provider-413 refinement and seven evaluator guard
tests; the final focused regression covers those later changes:
**214 passed**, including both adapters, dated API integration, weekly persistence,
session/source safety and safe provider failures. New coverage totals 35 tests.
Frontend regression: **210 passed**. `git diff --check` passed. No frontend code
changed.

For browser acceptance, use a dedicated development account with non-sensitive
entries matching the fixtures; select the week beginning 2026-11-16, explicitly
generate, and open the source dates. Verify the saved result on refresh. Ask the
answerable and missing-information questions and check sources and recovery
from provider errors. This browser check is separate from offline/API tests and
from helper-level live evaluation; do not send private history for this check.

## Live evaluation and remaining limits (2026-11-27)

The first run used **8/8 authorized calls** with `openai/gpt-oss-20b`, once per
fictional case. The user subsequently authorized four additional reflection
checks; **4/4** were used. Total: **12 calls, zero automatic retries**, no private
journals, no audio and no other AI service. Reports and separate reviewer notes
are local ignored files:

- `external_api_tests/test-local-data/grounding/grounding-20261127-run01.json`
- `external_api_tests/test-local-data/grounding/grounding-20261127-run01-review.json`
- `external_api_tests/test-local-data/grounding/grounding-20261127-run02.json`
- `external_api_tests/test-local-data/grounding/grounding-20261127-run02-review.json`

All four Q&A cases passed actual output review: Alex retained, missing price and
flight information acknowledged without guesses, both conflicting notebook
amounts and dates cited without choosing a version. The Q&A prompt is unchanged
since that live review.

| Reflection case | Latest observed result and review |
| --- | --- |
| Sparse Vietnamese | Faithful short summary and two relevant questions; copied relative-day wording removed. Questions remain formulaic. |
| Mixed topics | Three unrelated events and dates preserved in Vietnamese; no invented emotional interpretation or causal link. |
| Plans/negation/injection | Non-attendance and uncertainty preserved; injected holiday ignored; unstated-decision premise removed. Second run unexpectedly used Vietnamese for English sources. |
| Long week | Groq HTTP 413, no generated content. Long-week model quality could not be assessed. |

The first run exposed source-relative "today" copied into sparse questions and
an unstated decision presumed in another question. The next prompt explicitly
applied retrospective wording and premise checks to both questions. The second
run improved those issues but introduced the language mismatch above. The final
prompt now reinforces that output language comes only from journal content,
including explicit English-to-English and Vietnamese-to-Vietnamese rules for
all three text fields. **This last language refinement has fake-test coverage
but has not been live-reverified.** Do not call all reflection quality accepted.

The long input (more than 40,000 characters) was rejected by the provider with
HTTP 413. The helper now maps that SDK response to `WeeklyReflectionTooLarge`;
the existing endpoint returns 413 with a safe too-long message and leaves a saved
reflection and the journals unchanged. It neither truncates records nor retries.
Focused tests exercise the concrete adapter and authenticated endpoint with the
same SDK status. Production Groq limits can be below the application's 60,000
character limit; [Groq rate limits](https://console.groq.com/docs/rate-limits)
are account/model dependent. No inference about which specific token limit
triggered this account's rejection is made from HTTP status alone.

Final acceptance still needs: live recheck of the last English-language prompt
refinement, successful long-week generation within an appropriate account limit,
and the browser checklist above. Both approved call budgets are exhausted; no
further provider request was made. Prior weekly-reflection evaluation used a
different model/prompt and is historical evidence.
