# Sutekka cart sync — spec v1.0

User request 2026-11-27 ~21:54 SGT (tapped "Yes, sync the cart
to my account"): a signed-in user's cart — and its navbar count —
follows their account across devices.

## The gap it closes

The navbar count badge already worked for a signed-in user with a
non-empty cart (verified headless at 390 px + 1280 px: qty 3 shows
"3"). The gap was only storage: the cart lived in per-device
localStorage (`sutekka-cart-v1`), so items added on one device
showed no count on another even when signed in. The fix is a
server-side cart for signed-in users. Signed-out users keep
exactly today's local-only behaviour.

## Design

- **Model** — `CartItem` (migration `20261127220000_cart_sync`):
  id cuid, userId FK to User with cascade delete, itemId String,
  type String ('single' | 'set' | 'pack'), qty Int, updatedAt.
  `@@unique([userId, itemId, type])` + index on userId. One row
  per cart line; no money, no prices — the checkout still resolves
  prices from `data/payment-links.json` at checkout time.
- **API** — `GET / PUT /api/me/cart` in `api/_lib/me-cart.js`,
  wired into the existing me catch-all router. **No new function
  file**: the project is at 11 of 12 Vercel Hobby functions, so
  the cart route reuses `api/me/[...me].js` like bookmarks,
  photos, preferences and profile. Unsigned → 401, same as the
  other me endpoints. PUT is rate-limited per user (30/min,
  `checkRateLimit`, 429 `rate_limited`) — generous on purpose,
  the client debounces to ~500 ms.
- **GET** returns `{ items: [{ itemId, type, qty }] }`, most
  recently updated first.
- **PUT replaces** the stored cart with the client's full cart:
  lines present are upserted, stored lines absent from the
  request are deleted, and the stored cart is returned.
  Validation is per line, not all-or-nothing: an unknown itemId
  (or a known id with the wrong type) is dropped, qty is clamped
  to 1–99, and a bad line never rejects the whole cart. Known
  items come from `api/_lib/payment-link-map.js` (the generated
  catalogue, same source the checkout resolves against).

## Merge rule (client, on sign-in)

When `loadSession` resolves with a user, the client GETs the
server cart and merges it with the local cart:

- **Union by (itemId, type).** Local lines first, server-only
  lines appended after them.
- **Quantities summed, capped at 99 — but only for genuinely
  new server-side additions.** The merge is idempotent, and that
  matters: after a merge + PUT the server cart equals the local
  cart, so merging the same server cart again must be a no-op —
  otherwise every page load would double the quantities (caught
  by the headless check: badge 3 → 4 → 7 across two loads).
  The client keeps a baseline, `lastSyncedCart` (the cart as of
  the last sync, in localStorage `sutekka-cart-synced-v1`): a
  merge only adds the server's delta over that baseline (server
  qty minus synced qty, when positive). First sync ever has an
  empty baseline, so the full server cart sums in, exactly as
  specified; later syncs add only what another device added
  since. The baseline is updated optimistically at merge time
  and confirmed on each successful PUT (which records the cart
  actually sent — `state.cart` may change again while a PUT is
  in flight).
- The merged cart is saved locally AND PUT to the server, so
  both sides converge. The badge (`updateCartBadge`, already
  sums `state.cart`) then shows the merged count.

## Known limits

- **A deletion can be resurrected if its PUT fails.** Removing
  a line locally PUTs the cart without it, but if that PUT fails
  (offline) the server still holds the line, and the next load's
  merge re-adds it — the baseline only tracks additions, not
  deletions. The carts converge again on the next successful
  PUT; deletions made while online sync immediately. Full
  tombstone tracking was judged overkill for a sticker cart.
- **Two tabs are last-write-wins.** Each tab has its own
  baseline; the server converges to whichever tab PUTs last.
  The local cart in each tab stays correct; only the server
  copy can flap between them.

## Sync on change (client, while signed in)

`saveCart()` also schedules a PUT of the full cart, debounced
~500 ms, so stepper taps don't fire one PUT each. The PUT is
full-replace, so a late PUT always carries the newest cart.

## Fallback rule (the important one)

**The local cart is never wiped because the server is
unreachable.** If the GET fails (offline, 503) or returns 401
(session expired), the local cart and badge stay exactly as they
are, and the merge is retried on the next page load. A failed
PUT is likewise ignored locally and retried on the next save.
Sign-out leaves the local cart as it is on the device.

## What does NOT change

- Checkout stays client-driven: it already sends its items to
  `POST /api/orders/checkout`. The webhook flow is untouched.
- Drafts stay local-only (server-side drafts are still a v2
  item, CART.md).
- The cart drawer, steppers, Lili remove modal, pack progress
  bar and refund line are untouched.
- The sheet-fullscreen reader change (commit 67cd772) is
  untouched.

## Build status

- Shell app.js?v=37 (styles.css unchanged at v=31), SW v39.
  Tests: see `tests/cart-sync.test.mjs` (mocked Prisma +
  session); full suite must stay green.
- Live verify: homepage serves app.js?v=37; `GET /api/me/cart`
  unsigned → 401. The live signed-in sync (real account, two
  devices) needs the user's phone — it cannot be verified from
  this VM.
