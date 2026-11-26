# Transcription verification (A07)

Status on 2026-11-26: **the mixed missing-English-sentence regression is fixed for
completed uploads and the verification CLI**, and verified against the supplied
recording. Four real microphone samples passed through the authenticated API with
the new adapter. Recognition is not word-perfect; users still review/edit drafts.
Real live-WebSocket multilingual quality and full browser acceptance remain
separate from the completed-recording fix described here.

## Cause isolated by comparison

Streaming final results omitted the English clause in both supplied mixed-file
versions. The same replacement audio and nova-3/vi/en hint parameters through
Deepgram prerecorded HTTP retained the Vietnamese -> English -> Vietnamese
sequence. The change is therefore to the recognition path for completed files,
not to fabricate missing text, promote interim guesses or edit the references.
The observed mode difference does not establish Deepgram's internal root cause.

Production `POST /api/transcriptions` and verify_transcription.py now use
DeepgramRecordedClient: one raw-audio HTTP request, strict completed-result/JSON
validation, 2 MiB response bound, 45-second read timeout inside a 60-second total
recognition cap. WebM/Opus/10 MiB, auth/Origin/CSRF, quota, session rechecks and the
public transcript/outcome JSON stay unchanged. There is no automatic retry,
second paid call or streaming-to-prerecorded fallback. Live streaming remains a
separate client with its existing 12-second finish budget and final-only mapping.

See the official [prerecorded API](https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded)
and [multilingual hints](https://developers.deepgram.com/docs/nova-3-language-prompting).
The reference .txt files are used only locally for evaluation and never sent to
Deepgram. No language-specific keyterms/prompts were added to fit these samples.

## Latest real-provider results

These four requests used the real authenticated ASGI application, actual session
and quota checks, the production prerecorded adapter and an isolated PostgreSQL
test schema. Original audio bytes were sent once per request. The schema/accounts
were removed afterward; the application database was not migrated.

| Sample | Earlier streaming observation | New prerecorded API result | Normalized CER | Request time |
| --- | --- | --- | --- | --- |
| Vietnamese | invalid_response; captured replay fixed at 5.56% | HTTP200, transcribed | 5.56% | 1.752s |
| English | invalid_response; later streaming diagnostic10.27% | HTTP200, transcribed | 4.11% | 1.870s |
| Vietnamese/English mixed, replacement | English clause omitted, CER37.98% | HTTP200, both languages retained | 3.10% | 1.572s |
| Natural Vietnamese | timeout; later diagnostic18.18% | HTTP200, transcribed | 18.18% | 1.963s |

A separate subsequent CLI call repeated the mixed result at **3.10% CER**, with
the English clause retained. Small remaining substitutions include the project
term README, a Vietnamese word/spacing, an English time expression and colloquial
natural speech. Do not claim universal or exact recognition. CER uses Unicode,
case, whitespace and punctuation normalization plus character edit distance; it
is a diagnostic metric, not an accuracy percentage or an automatic quality gate.

## Confirmed mapping and deadline work

The earlier streaming normalizer rejected a valid partial final because a word
in an older draft straddled a newly finalized boundary. That fix remains relevant
to live streaming: the final supersedes provisional timing; later draft words
stay unconfirmed. Invalid final timing/new ambiguous cumulative overlap and
unresolved completion remain rejected. Synthetic regression tests contain no
private recording text.

Earlier completed-file streaming diagnostics needed 12.224s (English) and12.907s
(natural) after CloseStream, beyond the old12s finish cap. The final upload change
to prerecorded eliminates this streaming-flush dependency; total recognition is
still bounded at60s and client read at45s. Streaming diagnostics remain available
only for live mapping comparisons and do not represent the new upload path.

## Call budget and local evidence

Before this investigation there were9 explicitly requested A07 provider calls:
the initial4, one Vietnamese diagnostic, three follow-up diagnostics and one
replacement mixed check. The new authorization allowed up to8 additional calls;
**only6 were used**: one controlled prerecorded comparison, four live authenticated
API checks and one mixed CLI confirmation. There were no automatic retries or
other-provider calls. Two allowed calls were left unused after successful checks.

Audio, references, provider traces, API responses, CER reports and the durable call
ledger are under external_api_tests/test-local-data/, excluded by Git. The latest
folder prefix is reports/mixed-investigation-. Its summary.md records the exact
cases and residual errors. Older streaming failures are preserved as historical
evidence, not overwritten or represented as new prerecorded results.

## Tests and acceptance boundaries

The independent prerecorded suite covers byte-exact audio/options, no reference
upload, safe status/timeout/network handling, strict JSON/results, silence,
response limits, cancellation and one request only. A real adapter MockTransport
also runs through the upload route. Existing streaming/collector, upload auth,
size/MIME/error/timeout/disconnect and smoke suites remain covered.

Fake-provider silence returns empty/no_speech and invalid audio is rejected before
provider access. Real-provider silence was not included in the four-file budget.
The source recordings are actual browser microphone exports; full Record-screen
permission/playback/save/session interactions and live multilingual behavior still
need their separate manual checks. This report does not relabel prerecorded
requests as live-WebSocket success or offline replay as live-provider evidence.

See [recording usage](recording-transcription.md) and [HTTP upload](audio-upload.md)
for reproducible commands and safe presentation. No new dependency, migration or
frontend response contract is introduced.


## Final executed regression results

- Complete backend on the final code: **1,154 passed, 2 skipped**, 310.19 seconds.
  The skips are the existing optional administrator-role and Windows symlink
  checks; dependency/runtime warnings remain.
- Focused speech/prerecorded/live/CLI/auth/smoke suites: **252 passed**.
- Frontend compatibility suites: **210 passed**.
- `git diff --check`: passed.

No remote push or new commit was created by this investigation. All provider
artifacts stay local and ignored; the generic code, tests and documentation are
ready for review. Restart the backend to load the prerecorded client before
using the existing completed-recording flow. The current frontend local config
has live transcription disabled, so its Record flow uses this upload path.
