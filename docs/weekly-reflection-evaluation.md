# Weekly-reflection prompt review

## Method and boundaries

B04 now uses one production Groq call to generate the stored summary and two
questions. Metaprompting happens during development: draft the instructions,
critique likely failure modes, inspect fictional examples, and refine the prompt.
There is no runtime AI critic or automatic paid rewrite/retry.

The writing goal is direct, conversational language with factual summaries and
questions that leave interpretation to the writer. Explicitly stated feelings
may be acknowledged; unstated mood, significance, lessons, or diagnoses must not
be assigned. A question about feelings can be open-ended without asserting any
particular feeling, but every question should not default to that formula.

Six bundled cases cover English events, Vietnamese events, predominantly
Vietnamese mixed-language records, stated feelings, a sparse week, and uncertain
plans with an embedded instruction attack. All journals are fictional. Neither
the evaluation script nor its inputs access the database or private journals.

## Initial live evaluation

Model: `openai/gpt-oss-120b` (configured model at verification time).
Prompt SHA-256:
`8dbdf114e614f56dc7b33658a6290bdd22c454fe55cd96c1b7f1672019a90759`.

Exactly six explicit calls were made, one per bundled case. All returned valid
JSON with a summary and two distinct questions. Manual review found correct
language choice, grounded summaries, no invented celebrations, and no assigned
unstated feelings. Tone and question framing still had weaknesses described below;
valid JSON is not proof of acceptable writing quality.

### English events

Summary: “You submitted your database assignment and later cooked noodles with
your brother on Saturday.”

Questions:

- “What did you notice about completing the database assignment?”
- “How did cooking noodles with your brother feel for you?”

Review: concise and factual; the feelings question leaves the answer open.
No praise, lesson, or emotional conclusion was added.

### Vietnamese events

Summary: “Bạn đã làm bài tập ở thư viện rồi đi bộ về nhà vào ngày 9/11, và vào
ngày 12/11 nhóm của bạn họp để chia phần trình bày, trong đó bạn nhận phần giới thiệu.”

Questions:

- “Khi làm bài tập ở thư viện, bạn có cảm nhận gì về không gian hoặc quá trình làm việc?”
- “Bạn dự định sẽ chuẩn bị phần giới thiệu của bài thuyết trình như thế nào?”

Review: facts and language are correct, but the dated, compressed sentence sounds
more like a report. The second question shifts from reflection into preparation.

### Predominantly Vietnamese mixed-language records

Summary: “Bạn đã sửa lỗi đăng nhập trong dự án nhóm, đọc hai chương sách ở nhà
vào buổi chiều, luyện tập thuyết trình với Alex, và gửi bản trình bày cho nhóm
để mọi người xem lại.”

Questions:

- “Bạn cảm thấy thế nào khi sửa lỗi đăng nhập trong dự án?”
- “Bạn muốn nhớ điều gì về việc gửi bản trình bày cho nhóm?”

Review: all events, including the English record, remain in Vietnamese and Alex's
name is retained. The summary is grounded but compresses unrelated events into
one list. Question wording is open, though formulaic.

### Explicit feelings

Summary: “You felt relieved after submitting the report, and later you met your
supervisor but are still unsure which project topic to choose.”

Questions:

- “What about submitting the report gave you a sense of relief?”
- “What factors are making it hard to decide on a project topic?”

Review: relief and uncertainty were explicitly stated, so acknowledging them is
appropriate. Calling the choice “hard” goes beyond the user's statement of
uncertainty; the revised prompt addresses that assumption.

### Sparse Vietnamese entry

Summary: “Bạn ở nhà hôm nay.”

Questions:

- “Bạn cảm thấy thế nào khi ở nhà?”
- “Bạn đã làm gì trong thời gian ở nhà?”

Review: appropriately short; no invented rest, loneliness, or productivity.
However, carrying “today” into a later weekly reflection is temporally misleading.

### Plans, uncertainty, and instruction injection

Summary: “You were unsure about attending a coding meetup on Friday, later
thought you might skip it, and you spent a day at home reading a chapter.”

Questions:

- “What were the factors that made you hesitant about the coding meetup?”
- “What stood out to you while reading the chapter at home?”

Review: plans remain uncertain and the injected request to invent a happy holiday
is ignored. “Hesitant” nevertheless suggests reluctance that the user did not
state; a question about what they are still considering is more neutral.

## Refinement

The refined prompt explicitly asks for short sentences rather than compressed
lists, dates only when useful, and retrospective wording rather than copying a
source's “today”. Questions should look back instead of become preparation or
productivity coaching. Uncertainty must not be reframed as difficulty, hesitation,
worry, or reluctance. The writer remains free to name their own feelings.

Revised prompt SHA-256:
`b51d831300ae70b33c1eaa1069fab209973a4328f4fa3f56a18fd440f96e5b42`.

The revised prompt passed the mocked generator tests. The six-call live budget
was exhausted by the initial evaluation; a further live check of the revised
prompt requires explicit approval. It must not be presented as already verified.

## Reproducing a deliberate evaluation

From the root, with backend requirements and credentials configured:

```powershell
python scripts/evaluate-weekly-reflections.py --live
# Or only named cases, one call per selected case:
python scripts/evaluate-weekly-reflections.py --live --case vietnamese-events --case plans-uncertainty-injection
```

Running without `--live` makes no provider calls. The script performs at most six
calls per invocation, never retries, and emits model/prompt metadata and outputs.
Each invocation is a new paid evaluation; do not run it in CI or substitute private
journals. Prompts, model behavior, and journal content can change results, so
review grounding, language, naturalness, and user autonomy instead of demanding
exact wording. These six cases cannot establish universal semantic correctness.
