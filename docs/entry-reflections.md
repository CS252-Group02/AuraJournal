# Entry reflections

On an entry page, **Reflect on this entry** generates a concise, factual summary
and exactly two distinct reflection questions grounded in the entry. All three
fields use the language of the entry. The summary remains one to three sentences.
Generating again replaces the saved summary and both questions. Editing entry
content clears the saved reflection because it no longer describes that text.

`POST /api/entries/{entry_id}/summary` requires the signed-in session and returns
the saved result:

```json
{
  "entry_id": "00000000-0000-0000-0000-000000000000",
  "summary": "You finished an important assignment.",
  "reflection_questions": [
    "What helped you finish it?",
    "What would you like to carry into your next challenge?"
  ],
  "summarized_at": "2026-11-16T12:00:00Z"
}
```

Existing saved questions are migrated as one-item arrays and remain visible.
Use **Regenerate reflection** to replace an older result with the current
two-question format. Empty or invalid provider responses do not overwrite a
previous result.
