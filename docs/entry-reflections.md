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

The service and HTTP boundary accept nonblank journal text up to the existing
5,000-character limit. Multiline Vietnamese/English text remains supported.
Generated output must contain only a nonblank summary of at most 500 characters;
the route also validates replaceable helpers and mutated model instances.

Before saving, the server rechecks the session and locks/reloads the owned source.
An expired/revoked session returns 401; changed/deleted/reassigned sources return
409 without saving the obsolete result. Refresh the journal before generating
again. Provider/configuration errors remain 503 and invalid generated output 502.
The prior saved note and source text survive failure. See the
[AI contract reference](journal-api-contracts.md#a10-ai-contract-reference).
