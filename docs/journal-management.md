# Journal-management API handoff (Person 1)

## Task tracking

| Task | Current handoff |
| --- | --- |
| B01 | Existing authenticated owner-filtered list; retain its newest-created-first ordering. |
| B02 | Owner-protected individual entry read is the next implementation step. |
| B03 | The database has journal dates; HTTP date creation/editing is the next implementation step. |
| B04 | Existing owner-only deletion returns 204 and cascades linked records. |
| B05 | Existing mutation tests cover isolation; a complete two-account lifecycle is the next implementation step. |
| B10 | Existing title, summary, and weekly-recap endpoints are tested with mocked providers. Real HTTPX network transports now fail the test immediately, including when an SDK would otherwise swallow connection errors. Transcription coverage is blocked until an authenticated transcription endpoint and its contract land. |

## Tests without provider charges

`tests/conftest.py` blocks real HTTPX sync and async network transports for every
backend test. Use injected fake AI services, `httpx.MockTransport`, or in-process
ASGI clients. PostgreSQL connections are unaffected; database tests still require
the disposable `aurajournal_test` database and create/drop isolated schemas.

The guard is exercised without opening real connections. Existing mocked AI tests
cover valid output, invalid JSON/schema, unavailable providers, invalid credentials,
and authorization/error contracts. They do not prove model quality or replace a
separate, explicitly requested live evaluation with fictional input.

B10 is **partially complete**, not fully complete or silently skipped: there is no
audio-upload/transcription endpoint in the current backend. Once it lands, add
tests for authenticated uploads, accepted formats/limits, silence, invalid audio,
provider failures, and normalized responses using a fake provider and fictional
audio fixtures. Do not introduce a dummy endpoint to claim that coverage exists.
