# Pixel-art API (A11–A15)

Generation is explicit and independent of journal saving. All endpoints require
an authenticated session cookie. POST also requires the configured Origin,
`X-AuraJournal-CSRF: 1`, and `Content-Type: application/json`.

| Request | Response |
| --- | --- |
| `POST /api/entries/{entry_id}/pixel-art` with `{}` | 201 new image; 200 existing image without another provider call |
| `GET /api/entries/{entry_id}/pixel-art` | 200 image metadata |
| `GET /api/entries/{entry_id}/pixel-art/content` | 200 private PNG bytes |

Example generation response:

```json
{
  "entry_id": "00000000-0000-4000-8000-000000000002",
  "image": {
    "id": "00000000-0000-4000-8000-000000000003",
    "file_format": "png",
    "width": 128,
    "height": 128,
    "created_at": "2026-11-13T12:00:00Z",
    "content_url": "/api/entries/00000000-0000-4000-8000-000000000002/pixel-art/content"
  },
  "representation": "grounded"
}
```

`representation` is returned only for fresh generation. `symbolic` means a
generic journal illustration rather than a depicted memory. Moment text, evidence,
prompt, and representation are not persisted. Retrieval returns image metadata
without representation. All responses use `Cache-Control: no-store`.

Errors use `{"detail":"..."}`. Missing and foreign entries return 404. Other
responses include 401 authentication, 403 browser protection, 415 content type,
422 input validation, 409 concurrent generation or changed source, 429 capacity,
502 invalid provider output, 503 configuration/credits/provider/storage/database
unavailability, and 504 provider timeout. A 429 response includes Retry-After.

There are no automatic generation retries. A timeout can still incur a provider
charge and cannot be recovered through this synchronous API. Retrying is a new
explicit billable submission if no image was saved. Repeating a successful
request returns existing metadata. Existing records are never silently replaced.

## Configuration and deployment

Install `src/backend/requirements.txt`. Configure backend environment variables:

```dotenv
PIXELLAB_ENABLED=true
PIXELLAB_API_KEY=<backend-only PixelLab token>
GROQ_API_KEY=<backend-only Groq token>
GROQ_MODEL=openai/gpt-oss-20b
JOURNAL_IMAGE_STORAGE_DIR=/absolute/path/to/private/persistent/journal-images
```

Generation defaults to disabled. A blank storage setting defaults to the ignored
repository `var/journal-images` directory. Storage must be on a persistent,
privately controlled volume shared by all workers on the backend host. Do not
serve this directory through static hosting. Restrict the volume and backups to
the backend account and use deployment-managed encryption at rest.

The backend uses synchronous PixelLab v2 `/create-image-pixen` with 128×128 output
and prompt enhancement disabled. Only the minimized visual prompt reaches
PixelLab; Groq receives the journal to extract its moment. Factuality and removal
of personal identifiers also depend on the model following its instructions;
structural validation and source quotation checks cannot prove semantic accuracy.

One generation per user and entry is enforced across workers by PostgreSQL
session advisory locks. Two generations per application process may run at once.
Locks retain a database connection, with no open transaction during AI requests.
No queue or database migration is required. Configure reverse-proxy request
limits to allow the long-running explicit generation request.

Changing journal content invalidates image metadata; unchanged edits retain it.
Deletion cascades metadata. Both delete owned files after database commit. A
late result cannot associate with a deleted or changed entry. Existing summary
or reflection updates can also change the entry timestamp and conservatively
invalidate an in-flight generation.

Filesystem and database operations cannot commit atomically. Schedule the
following command **hourly and after restarts**, under the backend account, with
the same environment and volume as the server:

```sh
.venv/bin/python scripts/cleanup-journal-images.py
```

It removes unreferenced owned PNGs and abandoned temporary files, skips active
generation, and preserves referenced files. Normal edit/delete requests clean up
immediately; failed deletions and crash leftovers are retried by this command.
Monitor its nonzero exit status and restore volume permissions/availability when
cleanup fails. Cleanup cannot succeed while storage or PostgreSQL is unavailable.
It never follows legacy external image URLs. External provider retention and
backup erasure are separate deployment/privacy responsibilities.

## Manual verification with real providers

This incurs external API charges. Use fictional journals and a local test account.

1. Set the environment above in the backend `.env`; install requirements and
   restart with `npm start`. Keep local `AUTH_COOKIE_SECURE=false`. Use
   `http://localhost:5173` consistently.
2. Register or log in through the existing UI. Open the browser developer console
   on that frontend origin. Run:

   ```js
   const base = 'http://localhost:8000';
   const headers = {'Content-Type': 'application/json', 'X-AuraJournal-CSRF': '1'};
   const saved = await fetch(`${base}/api/entries`, {
     method: 'POST', credentials: 'include', headers,
     body: JSON.stringify({content: 'Today I finished my mathematics homework after an hour of practice.'})
   });
   if (saved.status !== 201) throw new Error(`Save failed: ${saved.status}`);
   const entry = await saved.json();
   const imagePath = `${base}/api/entries/${entry.id}/pixel-art`;
   const generated = await fetch(imagePath, {
     method: 'POST', credentials: 'include', headers, body: '{}'
   });
   if (generated.status !== 201) throw new Error(`Generation failed: ${generated.status}`);
   const result = await generated.json();
   const metadata = await fetch(imagePath, {credentials: 'include'});
   if (metadata.status !== 200) throw new Error('Metadata missing');
   const content = await fetch(`${base}${result.image.content_url}`, {credentials: 'include'});
   const preview = document.createElement('img');
   const previewURL = URL.createObjectURL(await content.blob());
   preview.src = previewURL;
   preview.width = preview.height = 256;
   preview.style.imageRendering = 'pixelated';
   document.body.append(preview);
   ```

3. Inspect scene fidelity and readability. Repeat the generation request; expect
   200 and the same image ID, with no additional PixelLab submission.
4. PATCH `/api/entries/${entry.id}` with a different `content` using the same
   fetch options. Both image endpoints should now return 404. Generate again
   explicitly if desired, then DELETE the entry with the same headers and `{}`;
   its image endpoints must return 404 and owned PNG files should be removed.
5. Test the URLs from a second signed-in account and logged out; expect 404 and
   401 respectively. Set `PIXELLAB_ENABLED=false`, restart, and verify saving
   still works while requesting a new image returns 503.
6. Remove the console preview with `preview.remove()` and
   `URL.revokeObjectURL(previewURL)`. Run the cleanup command. Repeat with a
   fictional Vietnamese entry to assess language fidelity. Never log real journals
   or provider credentials during verification.
