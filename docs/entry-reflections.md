# Entry reflections

On an entry page, **Reflect on this entry** generates one short, factual
reflection grounded in the entry and written in the entry's language. It does
not ask questions or give advice. Generating again replaces the saved
reflection. Editing entry content clears the saved reflection because it no
longer describes that text.

`POST /api/entries/{entry_id}/summary` requires the signed-in session and returns
the saved result:

```json
{
  "entry_id": "00000000-0000-0000-0000-000000000000",
  "summary": "You finished an important assignment and took time to recognize the effort it required.",
  "summarized_at": "2026-11-16T12:00:00Z"
}
```

Use **Regenerate reflection** to replace an older result. Empty or invalid
provider responses do not overwrite a previous result.
