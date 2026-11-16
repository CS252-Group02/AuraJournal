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

To run data and API tests, set `TEST_DATABASE_URL` to a disposable PostgreSQL
database using your local credentials. From `src/backend`, run:

```powershell
& ..\..\.venv\Scripts\python.exe -m pytest tests/test_journal_images.py tests/test_pixel_art_api.py tests/test_image_storage.py -q
```

These tests use fake image providers, temporary image directories and isolated
database schemas. They cover ownership, seven occupied days across gaps and a
year boundary, multiple images per day, omitted images, future dates, deletion,
failed commits and concurrent generation.
