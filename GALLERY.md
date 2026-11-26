# Personal gallery — photo uploads

User request 2026-11-27 ~07:01 SGT: "Create upload to allow user to
upload their photos. Upload function configurable on admin page. Think
of the neon db layer on storage. Can clear the photos. Gallery mode.
What is best to implement". The user chose the **personal gallery**
build (each user sees only their own photos) over a public wall.

## Design (the answer to "what is best")

- **Bytes live in Vercel Blob, Neon stores only metadata.** Postgres
  is not a file store: a few hundred multi-MB photos would eat the
  database's storage and slow every other query. One `Photo` row is a
  few hundred bytes (id, user, URL, pathname, filename, size, date);
  the URL points at Blob. Deleting a photo removes the Blob object
  AND the row, so nothing orphans.
- **Vercel Blob, not a new provider.** Same account as the hosting,
  no new dashboard, public URLs, `put`/`del` from the existing me
  router. Hobby free allowance (Oct–Nov 2026 docs): 1 GB storage,
  2,000 advanced ops/month, 10 GB transfer; over the limit Hobby
  stops Blob for 30 days — no surprise bill.
- **Upload is one raw-body POST per file** (`POST /api/me/photos`,
  Content-Type image/*, X-Filename header) — no multipart parser,
  no base64 bloat. Limits: 4 MB per photo (Vercel caps function
  request bodies at 4.5 MB on Hobby), 20 photos per user, JPEG/PNG/
  WebP/GIF only. The caps keep one user under 80 MB, inside the
  free tier for a small community.
- **Admin toggle, not a code flag.** `uploads_enabled` in the
  existing `SiteSetting` key-value store, toggled in #/kangle
  Settings next to shop open/closed, read by the public
  `GET /api/settings`. Off by default (absent key = false). Off
  hides the upload button and the API answers 503
  `uploads_disabled`.
- **Clearing asks Lili first**, same pattern as the cart and the
  saved shelves: per-photo delete and clear-all both open the
  remove-confirm modal.

## What it is

- **Route**: `#/gallery` — nav link with the `fi-br-images`
  (U+F804, verified present in the shipped woff2) icon. Signed-in
  only; signed-out shows "Sign in first".
- **Gallery view**: grid of the user's photos (square tiles,
  `object-fit: cover`, filename caption), tap a tile to open the
  existing image lightbox, × on each tile to delete, "Clear all
  photos" text button, upload button (label + hidden file input).
- **Empty state**: hand-drawn SVG of Lili's face framed like a
  photo (ears over the frame, star, sparkles), "No photos yet!",
  "Upload a photo of your stickers (or anything you love) and
  it'll live right here, just for you.", "Only you can see your
  photos — this gallery is yours alone.", "Upload your first
  photo" button. Reuses the `.empty-saved` / `.empty-art` pattern.
- **Upload flow**: client validates type/size first, then POSTs
  the raw file. Errors map to plain messages: `uploads_disabled`
  ("turned off right now"), `uploads_not_configured` ("aren't set
  up yet — the shop owner is adding the storage key"),
  `photo_limit_reached` (20 photos), `photo_too_large` (4 MB).
  The photo appearing in the grid is the success confirmation.

## Server

- `Photo` model + migration `20261127070000_photos` (userId FK
  cascade, index on (userId, createdAt)). Applied by the Vercel
  build (`prisma migrate deploy`).
- `api/_lib/me-photos.js`: GET lists the user's photos (newest
  first, metadata only — no Blob internals leak); POST checks
  setting → Blob token (`BLOB_READ_WRITE_TOKEN`) → content type
  → per-user count → reads the raw body with a 4 MB cap →
  `blob.put('photos/<uid>/<ts>-<sanitized-name>')` → creates the
  row; DELETE `?id=` removes one, `?scope=all` clears the whole
  gallery (Blob `del` per URL, best-effort, then the rows).
- Wired into the existing `api/me/[...me].js` router — function
  count stays 11/12.
- `api/_lib/http.js` gained `readRawBody(req, maxBytes)` (throws
  with `code: 'BODY_TOO_LARGE'` over the cap).
- `adminSettingsSchema` gained `uploadsEnabled`; the admin
  settings GET/POST and the public `GET /api/settings` both carry
  it.

## Setup the owner still has to do

Create the Blob store in the Vercel dashboard (Storage → Create
Blob store → connect it to sutekka-generator). The
`BLOB_READ_WRITE_TOKEN` env var is added automatically; redeploy
after. Until then uploads answer 503 `uploads_not_configured`
(the gallery view, empty state and the admin toggle all work
without it). The toggle itself also stays off until the admin
turns it on in #/kangle → Settings.

## Verification

- Tests: 162/162 (6 new in `tests/photos.test.mjs`, mocked Prisma
  + Blob + session: list, upload, disabled/not-configured 503s,
  bad type/empty/oversize/limit, single delete, clear-all).
  Typecheck clean, `prisma validate` clean.
- Local headless check at 390px against a mock API (fresh port,
  real file upload via `setInputFiles`): 19/19 checks passed —
  empty state (SVG 180×147, exact copy), upload → 1 card with the
  filename, lightbox + Escape close, delete modal (Keep focused,
  Keep leaves the photo, confirm removes it), two photos →
  clear-all modal → empty, uploads-disabled state (no input,
  "turned off right now."). Screenshots in /tmp (ephemeral).
- Live browser check: the cloud browser has no session, so the
  signed-in gallery flow still needs one try on the user's phone.
