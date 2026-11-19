# Pixel-art API (A11–A15)

Generation is explicit and independent of journal saving. All endpoints require
an authenticated session cookie. POST also requires the configured Origin,
`X-AuraJournal-CSRF: 1`, and `Content-Type: application/json`.

| Request | Response |
| --- | --- |
| `POST /api/entries/{entry_id}/pixel-art` with `{}` | 201 new image; 200 existing image without another provider call |
| `GET /api/entries/{entry_id}/pixel-art` | 200 image metadata |
| `GET /api/entries/{entry_id}/pixel-art/content` | 200 private PNG bytes |
| `GET /api/entries/pixel-art/recent?as_of=YYYY-MM-DD` | Image metadata on the latest seven occupied journal dates through `as_of` |

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

## Dashboard: Moments in Pixels (U08)

The Dashboard reuses its authenticated `GET /api/entries` result and existing
local-day clock. It shows exactly seven consecutive calendar dates ending today,
or ending on the date chosen in the gallery. Calendar month/date selection is
independent. Today follows browser local midnight and focus/timezone changes;
an earlier selected end date stays fixed. The date picker supports end dates
from `1000-01-07` through today.

The recent endpoint returns an array of `{journal_date, entry_id, image}` records,
with the same image metadata as above. It selects the latest seven **occupied
journal dates**, including dates without images, and returns all images on those
dates. Those dates may span more than seven calendar days. The gallery filters
the complete response to its calendar range and requires each image to match a
loaded journal's ID and saved journal date. It does not truncate the response to
seven records. Malformed or contradictory metadata is unavailable, with a refresh
action, rather than a substitute illustration.

Each day initially shows the image with the latest image `created_at`, breaking
ties by journal creation time and ID. A day's expandable list links to every
journal, identifies additional stored images, and lets the user choose which
image to view. Only the currently selected thumbnail for each day is fetched;
changing it releases the previous thumbnail. Empty dates and saved journals
without an image have distinct labels. Captions come from the associated
journal's first sentence, using the existing title helper.

`apiPng()` is a binary companion to the JSON `api()` helper. It uses configured
`API_URL`, session cookies, `cache: 'no-store'`, and rejects redirects. It accepts
only canonical `/api/entries/{uuid}/pixel-art/content` paths. Metadata also binds
that path to its entry ID. Successful responses must have PNG content type, a PNG
signature, and a nonempty body of at most 2 MiB. The browser's decoder handles
remaining PNG validation; decode failure offers an explicit retry. Images use
temporary Blob object URLs, never public content URLs or localStorage. Request
cancellation, authentication epochs, and component cleanup prevent late responses
from replacing another period/account and revoke completed object URLs on logout,
replacement, refresh, or unmount. A content 401 uses the existing global expired
session handler. Gallery metadata and PNG requests have 30-second client deadlines
and no automatic retry.

Refresh memories reloads journals and metadata together, reconciling edits,
moved dates, deletions, and changes made in another tab. The gallery is a snapshot;
it does not subscribe to live server changes. Changing journal content invalidates
its stored image on the backend; an already displayed snapshot is replaced on
refresh or navigation. No generation action is included in this gallery. Opening,
selecting dates/images, retrying reads, and refreshing make only GET requests.

### Manual Dashboard verification

Use a test account and fictional journals. Existing stored images are sufficient;
the checks below do not require paid generation. If new provider images are
needed, use the separate, explicitly billable verification procedure below.

1. Open `/dashboard` with an empty test account. Confirm seven dated slots and
   the empty-period message. Save fictional journals on some of those dates,
   including two or more on one date. Refresh and distinguish `No journal` from
   `No pixel image yet`; check every journal link.
2. With existing stored images, check correct saved dates, crisp 128px thumbnails,
   captions, latest-image selection, additional-image counts, and every `Show
   image`/journal link in the expanded day. In DevTools, confirm metadata GET
   uses `as_of`, PNG GETs include cookies, `<img>` uses `blob:` URLs, and no
   generation POST occurs on any gallery action.
3. Choose end dates across a month/year boundary and February 29 in a leap year.
   Always count seven consecutive dates. Navigate Calendar independently, then
   use Today in the gallery. Leave the current period open across local midnight,
   or change the test browser's clock/timezone and refocus; verify it advances.
4. Throttle the network, quickly change end dates, leave Dashboard, and log out
   while images are pending. Sign in to a second test account. Confirm no previous
   account images/captions appear and no late request repopulates the gallery.
5. Use browser request interception to simulate metadata network failure and PNG
   403/404/429/503/504 responses. Verify meaningful unavailable states, retained
   journal links, and recovery only after explicit retry/refresh. Expire the test
   session to check the existing sign-in redirect on 401. Test malformed metadata
   and invalid PNG bytes without altering production data.
6. Edit, redate, or delete a fictional journal in another tab, then refresh the
   gallery. Verify the old placement/image disappears and content edits show a
   saved journal without its invalidated image. Check Calendar, heatmap, streaks,
   monthly overview, recent entries, History links, and weekly recap still work.
7. At mobile and desktop widths (including 320px and 1440px), check that only the
   gallery strip scrolls horizontally. Tab through date controls, thumbnails,
   details, image selectors and retries; use Enter/Space on native controls and
   confirm visible focus and meaningful screen-reader labels.

Automated coverage lives in `tests/frontend-pixel-memories.test.js` and the
Dashboard/Calendar regression suites. It uses fake transport/image bytes and
component effect tests; it does not prove browser decoding, visual layout, or
real PixelLab/Groq provider behavior. Run `npm run test:frontend` and
`npm run build` from the repository root.

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
