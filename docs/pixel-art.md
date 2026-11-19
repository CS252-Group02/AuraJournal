# Pixel-art API (A11–A15)

Generation is explicit and independent of journal saving. All endpoints require
an authenticated session cookie. POST also requires the configured Origin,
`X-AuraJournal-CSRF: 1`, and `Content-Type: application/json`.

| Request | Response |
| --- | --- |
| `POST /api/entries/{entry_id}/pixel-art` with `{}` | 201 new image; 200 existing image without another provider call |
| `GET /api/entries/{entry_id}/pixel-art` | 200 image metadata |
| `GET /api/entries/{entry_id}/pixel-art/content` | 200 private PNG bytes |
| `GET /api/entries/pixel-art/memories?as_of=2026-11-20` | Up to seven occupied journal days, including missing images |
| `GET /api/entries/pixel-art/recent?as_of=2026-11-20` | Existing flat image-only view of the same seven days |

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

## Seven-day memory feed

`GET /api/entries/pixel-art/memories?as_of=2026-11-20` returns the signed-in
user's latest **seven distinct days with journals**, on or before the inclusive
`as_of` cutoff. These are not seven consecutive calendar dates or seven images.
A journal day without any generated image still occupies one of the seven slots;
older image-bearing days do not replace it. Dates use `journal_date`, including
backdated journals, rather than journal or image creation timestamps.

The response is grouped newest day first. Within each day all journals are
included, sorted by creation time descending, then journal UUID descending for
stable ties. Multiple images in a day are retained, so more than seven image
cards can be returned. Empty accounts return `{"as_of":"2026-11-20","days":[]}`.

Example response with an existing illustration and a missing one:

```json
{
  "as_of": "2026-11-20",
  "days": [
    {
      "journal_date": "2026-11-20",
      "entries": [
        {
          "entry_id": "00000000-0000-4000-8000-000000000002",
          "image": {
            "id": "00000000-0000-4000-8000-000000000003",
            "file_format": "png",
            "width": 128,
            "height": 128,
            "created_at": "2026-11-20T12:00:00Z",
            "content_url": "/api/entries/00000000-0000-4000-8000-000000000002/pixel-art/content"
          }
        }
      ]
    },
    {
      "journal_date": "2026-11-16",
      "entries": [
        {"entry_id": "00000000-0000-4000-8000-000000000004", "image": null}
      ]
    }
  ]
}
```

`as_of` is required and must be an exact real `YYYY-MM-DD` date. A client can
supply its local date or a historical cutoff; the server never shifts stored
journal dates according to timezone. Entries after the cutoff are excluded.
The existing `/pixel-art/recent` route retains its flat list response and omits
missing images, using the same day-selection query and strict date validation.
Use the grouped feed when a UI needs to distinguish empty history from journals
whose illustrations have not been generated.

GET requests do not call Groq/PixelLab, generate images or write metadata/files.
They work when generation is disabled or provider credentials are unavailable.
Fresh generation remains the explicit POST above: it validates ownership, calls
the existing extractor/PixelLab services, saves a private PNG, and attaches the
reference atomically in the existing database workflow. Successful repeats reuse
the saved image. A generation failure leaves the written journal intact.

### Missing art, private links and lifecycle

- `image: null` means no usable owned reference is stored for that journal.
  Render a placeholder; do not trigger automatic billable generation.
- Metadata only exposes an authenticated backend `content_url`, never a disk
  path, storage key or provider URL. Load it with the existing session cookie;
  cross-origin fetches need `credentials: 'include'`.
- An image key must match the exact associated journal ID and image ID and use
  the supported PNG format. Legacy external, malformed or cross-journal keys
  return 404 for direct metadata/content, are omitted from the flat list, and
  become `image: null` in the grouped feed. Invalid references never reach storage.
- The feed reads metadata without opening every PNG. If a referenced file was
  removed or disappears after the response, content GET returns 404; the UI must
  also provide an image-load fallback. A storage outage may return 503. Neither
  case automatically replaces the record or resubmits a generation request.
- Date-only edits move the day group and retain the image. Text edits invalidate
  the image association; the journal stays in the feed with `image: null`.
  Deleting a journal removes it from future responses and its content URL stops
  working. Existing post-commit cleanup/reconciliation handles file removal.
- Newest-day selection and ordering are recalculated on each request. Every
  query and content request enforces the current authenticated owner, including
  after switching accounts. All responses use `Cache-Control: no-store`.

The existing `representation` field is only known on fresh generation, not saved
in image metadata. A gallery should label retrieved art as an illustration;
metadata alone does not establish that the scene depicts a grounded event.
Connecting the existing frontend gallery to this feed is a separate UI change.

## Automated verification

Verified on 2026-11-20: the complete backend regression returned **818 passed,
2 skipped**. The skips are the existing administrator-only database-role test
and Windows symlink-privilege test. Tests used isolated PostgreSQL schemas and
private PNGs in temporary test storage; provider calls were mocked/blocked.
No application-database migration, private-image modification, or live AI call
was performed during this implementation verification.

From `src/backend`, set `TEST_DATABASE_URL` to a disposable PostgreSQL database
as described in the README, then run:

```sh
python -m pytest tests/test_pixel_memories_api.py tests/test_pixel_art_api.py tests/test_journal_images.py tests/test_image_storage.py -q
```

Tests use real private PNG files, authenticated HTTP requests and isolated
PostgreSQL schemas. External provider calls are mocked/blocked. They cover
seven occupied days across gaps/month boundaries, missing images, stable ties,
multiple images per day, one image query per feed, restart durability, two-user
isolation, strict cutoffs, invalid/cross-journal references, missing files,
date/text edits, deletion, failure recovery and idempotent generation. This
verifies API/storage integration, not real-provider scene quality.

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
