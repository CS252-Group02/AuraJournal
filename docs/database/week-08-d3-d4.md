# Week 8 Data & Security handoff

## D3 — Stored pixel-art references

Image bytes live in the private directory configured by
`JOURNAL_IMAGE_STORAGE_DIR` (default `var/journal-images`). PostgreSQL stores
the application key in `journal_images.image_url`. The generation API now calls
`attach_image(session, user_id, entry_id, image_id, key)` from
`app.services.journal_images`. This helper verifies the owner and exact key,
locks the entry, rejects an existing image and flushes within the caller's
transaction. The generation route retains file recovery on commit failure.

`recent_journal_images(session, user_id, as_of)` returns images from the latest
seven distinct occupied journal dates through `as_of`. Gaps can extend that
window beyond seven calendar days. Every occupied day counts, including a day
with no image. All available references on selected days are returned, ordered
by journal date, creation time and entry ID descending. Future dates are excluded.

The authenticated endpoint is
`GET /api/entries/pixel-art/recent?as_of=2026-11-16`.
It returns a list with `journal_date`, `entry_id` and `image` metadata.
An empty result is `[]`. Image URLs point to the existing authenticated PNG
endpoint. The query skips journals without image metadata. A referenced file
lost from the volume returns 404 when its content URL is fetched.

Deleting an entry cascades its database reference and removes the file after
commit. The existing cleanup script retries orphan removal after failures.
See [pixel-art operations](../pixel-art.md) for volume configuration, cleanup
and real-provider verification.

## D4 — Private keyword and date search

`search_entries(session, user_id, keyword="", start=None, end=None)` in
`app.services.journal_history` searches the stored `content` field.
The model currently has no stored title. The keyword is a literal substring
with case-insensitive matching. Surrounding whitespace is trimmed, accents are
preserved and `%`, `_` and `/` are escaped before pattern matching. A blank
keyword omits the text filter. Optional dates include both boundaries and use
`journal_date`. An inverted interval raises `ValueError`.

Backend can call this helper with the authenticated owner's ID. The existing
`GET /api/entries` also accepts `q`, `start` and `end`, for example
`/api/entries?q=Python&start=2026-11-01&end=2026-11-30`.
Filtered results use journal date, creation timestamp and ID descending.
Requests without filter parameters retain the existing creation-time ordering.
The response remains a list of entry objects. No matches return `[]`.
Invalid dates, inverted intervals, null characters and keywords longer than
5,000 characters return 422. Anonymous requests return 401.

### Supporting index

Both tasks use the existing B-tree
`ix_journal_entries_owner_date(user_id, journal_date, created_at, id)`.
The foreign key `journal_images.entry_id` already has a unique index.
The owner/date index narrows the user's candidate entries before matching
content. In a local PostgreSQL measurement using 10,000 synthetic entries,
1,000 owned by the selected user, `EXPLAIN ANALYZE` used a bitmap index scan
for keyword-only search (1.132 ms, 1,000 matches), and an index scan with a
January date filter (0.046 ms, 42 matches). Those are single-run measurements
on local sample data. Keyword matching still examines the owner's candidate
content. Larger per-user histories should be measured before adding a
trigram index. This implementation requires the existing migration head 0007.

## Start and verify on Windows

With PostgreSQL running, open PowerShell in the repository root.

```powershell
& .\.venv\Scripts\python.exe -m pip install -r src/backend/requirements.txt
npm.cmd ci
Set-Location src/backend
& ..\..\.venv\Scripts\python.exe -m alembic upgrade head
& ..\..\.venv\Scripts\python.exe -m alembic current
Set-Location ../..
npm.cmd start
```

The schema head is `0007`. Open http://localhost:5173 and sign in.
API documentation is at http://localhost:8000/docs.
From the browser console on the frontend, inspect the authenticated image list.

```javascript
await fetch('http://localhost:8000/api/entries/pixel-art/recent?as_of=2026-11-16', {
  credentials: 'include'
}).then(response => response.json())
```

For a repeatable search demo, create two entries through the application with
the texts `Today I studied Python` and `Today I went for a walk`. In the same
browser console, run the following. Only your Python entry should appear.

```javascript
await fetch('http://localhost:8000/api/entries?' + new URLSearchParams({q: 'python'}), {
  credentials: 'include'
}).then(response => response.json())
```

Add `start` and `end` in YYYY-MM-DD form to test date limits. Sign in as a
second user and repeat to verify account isolation. The saved-entry screen
can use these query parameters when its search controls are implemented.

To run data and API tests, set `TEST_DATABASE_URL` to a disposable PostgreSQL
database using your local credentials. From `src/backend`, run:

```powershell
& ..\..\.venv\Scripts\python.exe -m pytest tests/test_journal_images.py tests/test_pixel_art_api.py tests/test_image_storage.py tests/test_journal_search.py tests/test_journal_history.py -q
```

These tests use fake image providers, temporary image directories and isolated
database schemas. They cover ownership, seven occupied days across gaps and a
year boundary, multiple images per day, omitted images, future dates, deletion,
failed commits and concurrent generation.
Search tests cover Vietnamese accents, mixed case, literal special characters,
blank keywords, inclusive date boundaries, invalid filters and separate owners.

## Verified results

The complete backend suite passed with 562 tests, and the frontend suite passed
with 91 tests on the implementation branch. Backend execution reported 6,491
warnings. Image-provider calls were mocked, so those results verify local
storage, HTTP behavior and database integration. Real provider generation can
be checked separately using the pixel-art operations guide.
