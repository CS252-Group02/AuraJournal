# Reflection chat retrieval benchmark

**Decision:** retain contextual lexical retrieval for follow-ups, now merged into `main`, and hold the embeddings pilot. Hybrid retrieval gained **3.03 percentage points** over contextual lexical retrieval, below the **10-point** gate. The “Phase 2 lexical” baseline below describes the historical current-message-only search; it is retained for comparison with the contextual implementation.

## Results

The 42 held-out queries include 33 answerable and nine no-source cases. Recall@5 averages the fraction of labeled sources present in the first five results per answerable query. False matches count no-source queries that returned any entry.

| Method | Recall@5 | English | Vietnamese | Mixed | False matches | Ownership violations | Date violations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Phase 2 lexical | 66.67% | 63.64% | 54.55% | 81.82% | 4/9 | 0 | 0 |
| Contextual lexical | 84.85% | 81.82% | 72.73% | 100% | 4/9 | 0 | 0 |
| Hybrid with context | 87.88% | 81.82% | 81.82% | 100% | 4/9 | 0 | 0 |

| Held-out scenario | Queries | Phase 2 | Contextual lexical | Hybrid |
| --- | ---: | ---: | ---: | ---: |
| Follow-up | 6 | 0% | 100% | 100% |
| Paraphrase | 9 | 77.78% | 77.78% | 88.89% |
| Cross-language retrieval | 3 | 33.33% | 33.33% | 33.33% |
| Older relevant match | 3 | 66.67% | 66.67% | 66.67% |
| Explicit date or range | 6 | 100% | 100% | 100% |
| Topic change | 6 | 100% | 100% | 100% |

One Windows CPU run using two ONNX threads measured warmed p95 retrieval at **51 ms** for Phase 2, **72 ms** for contextual lexical, and **100 ms** for hybrid. Each method had one warm-up and three measured calls per held-out query. Measurements exclude model loading, passage embedding, and Groq generation. Treat these timings as local observations for a 24-entry fictional corpus.

Contextual lexical search added the prior user message only on fixture-labeled follow-ups. This offline result measures how much the context can help retrieval. The live routing check below measures how well the production classifier detects those cases without labels.

## Reproduce

1. Use Python 3.11 or newer with the backend requirements installed. Install `numpy==2.4.6`, `onnxruntime==1.32.0`, and `tokenizers==0.23.3` in your benchmark environment.
2. Download `onnx/model.onnx` and `onnx/tokenizer.json` into a local directory outside the checkout. The runner verifies both SHA-256 hashes before loading them. [Pinned Multilingual E5 Small artifacts](https://huggingface.co/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3/onnx)
3. Set `TEST_DATABASE_URL` to a disposable PostgreSQL database with permission to create schemas. From the repository root, run the command below. The runner rolls back its temporary schema. It reads only the checked-in fictional data and makes no network requests.

   ```sh
   python scripts/evaluate-reflection-retrieval.py --model-dir /path/to/local/model > retrieval-report.json
   ```

The JSON report contains the rankings, runtime versions, metrics by language and scenario, and release gates. The runner selects a cosine threshold using 18 tuning queries, then runs the remaining 42 as held-out queries. This run selected **0.84**. Hybrid uses cosine similarity on locally encoded passages and combines the semantic and lexical rankings by reciprocal rank, with newer entries winning ties. Explicit dates and owner filters apply before ranking. See the [fictional fixtures](../scripts/reflection-retrieval-cases.json).

## Groq conversation context

Groq Chat Completions uses the conversation context supplied with each request. AuraJournal stores the chat and provides up to six eligible previous turns within its character budget. PostgreSQL integration tests capture the actual adapter payload after a fresh login, a chat or account switch, and journal opt-out. They also verify that the classifier receives no journal excerpts. [Groq Chat Completions documentation](https://console.groq.com/docs/text-chat)

The optional live command below makes up to nine Groq calls using three bundled fictional follow-ups. Review each answer against the expected fact in its output. The benchmark and automated tests use no live Groq calls.

```sh
python scripts/evaluate-reflection-retrieval.py --live
```

## Live follow-up routing check

With `TEST_DATABASE_URL` pointing at a disposable PostgreSQL database and `GROQ_API_KEY` configured, run the command below. It makes up to 12 classifier calls using fictional English, Vietnamese, and mixed-language follow-ups, topic changes, and explicit dates. The topic and date controls explicitly ask for reflection. The check reports model decisions and the resulting lexical recall separately from the offline benchmark. It runs the same lexical retrieval as the backend and needs no embedding model.

```sh
python scripts/evaluate-reflection-retrieval.py --live-routing
```

The final local run against Groq `openai/gpt-oss-120b` matched all 12 expected routing decisions. Current-message-only search found six of the 12 labeled sources. Classifier-routed search found all 12, including all six dependent follow-ups. There were zero ownership or date violations. The final run passed after increasing the classifier completion budget from 300 to 768 tokens. Earlier runs returned provider HTTP 400 for one mixed-language case. To retry a specific case, append `--routing-case mixed-10`. These results cover a 12-case sample drawn from the offline benchmark’s held-out queries, with reflection framing added to the live controls.


## Frontend acceptance boundary

The existing Reflection Chat UI uses the same turn and citation contract for
contextual lexical retrieval. It sends the current message, locale, revision and
turn ID; the backend selects eligible history and builds retrieval queries.
There are no frontend retrieval-mode controls or embedding/indexing status fields.

`tests/fixtures/reflection-chat-context.json` supplies scripted English,
Vietnamese and mixed-language replies for browser acceptance: an initial grounded
turn, dependent follow-up, topic change, explicit current-message date range and
empty evidence. Browser checks verify exact request fields and render only the
returned entry/date links, including an older source. They do not evaluate model
routing, ranking, factual accuracy or the benchmark metrics above.

See the [frontend release handoff](reflection-chat.md#phase-3-frontend-validation-and-release-handoff)
for current checks and the pending live staging scenarios. The recorded backend
benchmark and Groq results above were not rerun as part of frontend validation.
