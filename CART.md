# Sutekka cart — spec v1.0

User request 2026-11-27 ~00:17 SGT: "for buying, add to shopping
cart. cart management and confirm the payment or save as draft cart."

## What v1 does

- **Add to cart** — an "Add to cart" button beside every Buy button
  (set page, sticker modal, pack card). Tapping it again removes the
  item ("In cart ✓"). One of each item: these are digital files, so
  there are no quantities. Same gating as Buy: hidden while the shop
  is closed or the item is hidden by the admin.
- **Cart management** — `#/cart` lists the items (title, type, price),
  remove per item, clear all, subtotal. A cart icon with a count badge
  sits in the top nav.
- **Confirm the payment** — the cart page has one "Checkout" button.
  It creates a single Stripe Checkout Session for the whole cart (one
  payment: card, PayNow or Link) and sends the buyer to Stripe. The
  success URL is the same download page as a single purchase.
- **Save as draft** — the cart auto-saves on every change (same
  device, survives closing the page), and the cart page has an explicit
  "Save draft" with a name. Saved drafts can be restored or deleted.
  Drafts are localStorage in v1; a signed-in buyer sees the same
  drafts only on that device. Server-side drafts for signed-in users
  are a v2 item (noted below).

## How checkout works (the one new dependency)

Payment Links cannot take a cart — one link is one item. So the cart
checks out through a server-side Checkout Session:

- `POST /api/orders/checkout` (folded into the existing orders
  catch-all router — the project is at 11 of 12 Vercel Hobby
  functions, so no new function file) takes `{ items: [{ itemId,
  type }] }`, resolves each item against `data/payment-links.json`
  (the single source of truth for title, amount and Stripe Price ID),
  and creates the session with Stripe's REST API.
- The session carries `metadata.cart_count` + `cart_0…cart_N-1`
  (item ids) + `cart_type_0…` (types) + `shop_type: "cart"`.
- **It needs `STRIPE_SECRET_KEY` on Vercel** — a Stripe restricted
  key with only "Checkout Sessions: write". The shop deliberately had
  no secret key until now (the Payment Links + webhook design avoided
  one). Without the key the endpoint answers 503
  `checkout_not_configured` and the cart page says so plainly; the
  cart and drafts keep working. The owner creates the key in the
  Stripe Dashboard and supplies it (never in chat); the live cart
  checkout is then verified with one test-mode purchase.
- The webhook already verifies signatures and records orders. For a
  cart session it creates **one Order row per item** (same session
  id), pinning each item's files and amount from the links data. A
  redelivery upserts per item and never touches admin fields.

## Data model

- `Order.stripeSessionId` loses `@unique` and gains
  `@@unique([stripeSessionId, itemId])` + an index on
  `stripeSessionId` (migration `20261127010000_cart_orders`). Existing
  orders have distinct session ids, so the new constraint cannot
  conflict. Single-link purchases are unaffected in behaviour.
- `GET /api/orders/lookup?session_id=` returns `{ order, orders }`
  (first + all rows); `POST` marks every row of the session delivered.
- The download page renders one card per order in a cart session,
  each with its own file list; the invoice/shipping forms live on each
  order's own page (`#/download?order_id=`), unchanged.
- The admin needs no changes: a cart order appears as one row per
  item, with the same session id, and revenue sums per item as before.

## Out of scope for v1

- Quantities (digital, one copy each).
- Server-side drafts / cross-device carts for signed-in users.
- Discount codes on the cart (the links have none either).
- Changing the single Buy buttons — they keep working exactly as now.

## v1.6 — cart drawer + nav icons (2026-11-27)

User request (with a DCHToons cart screenshot): "Make the cart
slide from right. Cart shall be shopping bag icon. Same to About
in the navbar. All items in navbar shall have ocon. What u think"

- **The cart is now a drawer sliding in from the right**
  (DCHToons-style): 420 px panel, full height, dimmed backdrop,
  "Your cart" heading + ×, body scroll locked while open. The
  bag button opens it over whatever page is showing; the #/cart
  route (deep links, Stripe cancel URL) opens it over the home
  view and restores `#/` on close. Close by ×, backdrop click,
  or Escape (one press closes the topmost layer only — the
  Escape handler is now an else-if chain over column / sticker /
  image modals / drawer). The old `#/cart` page view is gone:
  `renderCart` now renders into the drawer's `#cartBody`
  (items, steppers, progress bar, refund line, checkout,
  drafts — unchanged, just housed in the drawer).
- **Every navbar item carries a Flaticon UICONS Bold Rounded
  icon** (classes verified present in the font CSS *and* their
  codepoints present in the shipped woff2 — the local headless
  browser cannot reach the font CDN, so the glyphs were checked
  that way instead): Latest home, Bookmarks bookmark,
  Collections folder, Cart shopping-bag (with the count badge),
  About info, Sign in user. Icon + label on desktop; icon only
  under 719 px, where the labels would push the row off-screen.
  Sign in gets its icon in `renderAuthArea` too, since that
  function rewrites the user area (the static HTML icon alone
  would be replaced on load).
- **Layering:** drawer z-40 / backdrop z-39, below the image
  lightbox (z-50) so a thumbnail opened from the drawer still
  shows its full-size image above it; closing the lightbox while
  the drawer is open keeps the page locked.
- Shell app.js?v=31 / styles.css?v=25, SW v32 (no index change,
  DATA_V stays 12). Tests 155/155, typecheck clean. Local
  headless check at 390/1280 px before deploying: drawer slides
  in (right edge = viewport edge), subtotal S$52, Escape closes,
  deep link #/cart opens the drawer, hash restores to #/ on
  close; labels hidden at 390 px, visible at 1280 px. Live
  verify 2026-11-27 ~06:21: ALL PASS — all six icons render
  (enlarged navbar crop), badge 2 → 3 as items were added,
  drawer 420 px with 2 lines + subtotal S$34 + progress bar +
  Checkout, scroll lock held, × and Escape close, #/cart deep
  link opens the drawer over home. Minor notes (not fixed):
  long Chinese titles clamp harder in the 420 px drawer than
  on the old full-width cart page (2-line clamp, by design);
  the × sits 12 px from the drawer's right edge, which is the
  viewport edge — the checker read it as "close to clipped"
  but it is fully clickable.

## v1.5 — cart thumbnails open a full-size lightbox (2026-11-27)

User request: "In cart when user click the thumbnail image,
modal display original size image shown."

- **Clicking a cart thumbnail now opens the same modal pattern
  as the sticker/column modals** (backdrop, × button, Escape,
  backdrop click, page scroll locked): the item title on top and
  the original-size image below — the full 1600×1680 PNG for a
  single sticker, the full sheet for a set, the first sticker's
  full PNG for the pack. The thumbnail is now a `<button>`
  (keyboard-accessible, focus ring) instead of a link to the set
  page — the modal replaces that navigation.
- **Verified at 390 px in local headless Chromium before
  deploying:** single → `stickers/riemann-rashomon/stickers/01.png`
  (naturalWidth 1600), set → `stickers/riemann-rashomon/sheet.png`
  (3320 px), pack → first sticker's PNG; Escape and backdrop
  clicks both close and clear the image. Screenshot in /tmp
  (cart-modal-single.png — ephemeral).
- Shell app.js?v=30 / styles.css?v=24, SW v31 (no index change,
  DATA_V stays 12). Tests 155/155, typecheck clean. Live verify
  2026-11-27 ~05:55: ALL PASS — single thumb → full 1600 px PNG
  with title + × (closed by ×), set thumb → full 8-sticker sheet
  (closed by backdrop), pack thumb → first sticker's full PNG
  (closed by Escape); cart intact after all three, subtotal S$48,
  no navigation away from #/cart.

## v1.4 — cart layout rebuilt for phones (2026-11-27)

The user (via a screenshot + a critique they forwarded) found the
v1.3 cart broken on phones: the title wrapped one word per line.
The critique was right, and the cause was mine: the cart line was
one `nowrap` flex row — the stepper + price + Remove button took a
fixed ~260 px, so on a ~360 px screen the title column collapsed
to almost zero width.

- **Mobile-first stacking, exactly as the critique prescribed:**
  top row = thumbnail | title + price; bottom row = stepper
  (left) | Remove (right). The controls wrap to their own row
  (`flex: 1 1 100%`), so they can never starve the title again.
  On ≥640 px the row goes back to one line.
- **Title clamps to 2 lines** (`-webkit-line-clamp: 2`) with an
  ellipsis. **SKU removed from the cart line** (it stays on the
  order record / admin, where it is actually useful — the cart is
  a customer surface). **"each" dropped** — the line total is the
  price. **Remove is now a small muted text link**, not a grey
  button. Thumbnail 56 → 64 px.
- **Verified at real phone width before deploying:** local
  headless Chromium at 390 px, 3-line cart (set + 2× single +
  pack, subtotal S$52) — every title column 204–213 px wide,
  titles exactly 2 lines, controls on the second row, all 3
  thumbnails loaded, no SKU / "each" text. Same page at 1280 px:
  clean single-row lines. Screenshots in /tmp (cart-mobile.png,
  cart-desktop.png — ephemeral, not committed).
- Shell app.js?v=29 / styles.css?v=23, SW v30 (no index change,
  DATA_V stays 12). Tests 155/155, typecheck clean. Live verify
  2026-11-27 ~05:48: ALL PASS — titles on one line at desktop
  width, no SKU, no "each", price = line total, Remove a text
  link, thumbnails visible; subtotal S$48; + on the set line →
  S$30 / S$63. (Phone-width layout verified locally at 390 px
  before the deploy.)

## v1.3 — cart lines show thumbnail + SKU + name (2026-11-27)

User request: "cart page display show the sku id sticker name
and the sticker img too thumbnail small one".

- **Each cart line now shows:** a 56 px thumbnail (left), the item
  title, and a meta line `SKU <id> · <type> · <unit price> each`.
  Singles show the sticker itself; sets show the set cover
  (`thumbs/<slug>.jpg`); the pack shows its first sticker. The
  thumbnail links back to the set page.
- **New thumbnails:** the build script (`build_sticker_index.py`)
  now generates one 320 px JPEG per sticker
  (`thumbs/<slug>-<nn>.jpg`, 40 files) and records it as `thumb`
  on every sticker record in `data/index.json`. Set thumbs already
  existed. The full PNGs are 1600×1680 — too heavy to show at
  56 px. Sticker PNGs are RGB on white, so no transparency issue.
  Thumbs + index.json are committed (the Vercel build regenerates
  them on every deploy).
- **Versioning (per the cache rule):** index.json changed, so
  DATA_V 11 → 12 and LS_KEY `sticker-showcase-index-v12`; shell
  app.js?v=28 / styles.css?v=22, SW v29.
- Tests 155/155, typecheck clean. Live verify 2026-11-27 ~05:41:
  ALL PASS — set (cover thumb, SKU riemann-rashomon, S$15),
  single (sticker thumb, SKU riemann-rashomon-01, S$4), pack
  (first-sticker thumb, SKU complete-pack-30, S$29); subtotal
  S$48; steppers + Remove re-tested on every line.

## v1.2 — quantity steppers (2026-11-27)

The user sent a screenshot of dchtoons.com's product cards
("− 0 +" / "− 3 +" steppers under each sticker) and asked for the
same: a buy count shown on the item, and the cart able to change
the count too.

- **Steppers replace the Add to cart toggles** beside every Buy
  button: set page (`cartSetStepper`), sticker modal
  (`stickerCartStepper`), homepage pack card (`packCartStepper`).
  The count shown is the cart quantity, 0 when not in the cart;
  minus is disabled at 0, plus caps at 99. The nav badge now sums
  quantities, not lines.
- **Cart lines have steppers too** (plus the line total and the
  existing Remove button); stepping a line to 0 removes it.
- **Semantics, stated plainly:** a quantity multiplies the price.
  The download is still the one PNG file per item — buying 3 copies
  of a digital sticker pays 3× and downloads the same file once.
  The quantity is recorded on the Order row, so it doubles as the
  print count if physical printing comes later.
- **Backend:** `Order.quantity Int @default(1)` (migration
  `20261127010000_cart_orders` lesson applied: additive
  `ADD COLUMN`, no constraint surgery);
  `cartCheckoutSchema` gains `quantity` (int 1–99, default 1);
  checkout sends `line_items[][quantity]` + `metadata[cart_qty_N]`;
  the webhook records one Order row per line with
  `amountTotal = unit × quantity` (single-link purchases stay
  quantity 1); `publicOrder` / `adminOrder` serializers include
  `quantity`; the download page shows "× N" when quantity > 1.
  Old saved carts and drafts without a qty field read as 1.
- Shell app.js?v=27 / styles.css?v=21, SW v28. Tests 155/155
  (was 153; + quantity validation + metadata-qty parsing),
  typecheck clean. Live verify 2026-11-27 ~05:33: ALL PASS — set
  stepper 0 → 2 (badge Cart 2), modal stepper → 1 (badge Cart 3),
  cart lines 2 × S$15 = S$30 + 1 × S$4 = S$4, subtotal S$34;
  + on the set line → 3 × S$15 = S$45, subtotal S$49; − on the
  sticker line (1 → 0) removes it; progress box shows the
  over-threshold state; refund line still visible.

## v1.1 — pack progress bar + refund policy line (2026-11-27)

From the DCHToons note the user supplied (dchtoons.com, SG Shopify
sticker shop): its AOV mechanics are a pinned promo banner and a
free-delivery threshold; its controversy is a refund policy (unboxing
video required) never disclosed before payment.

- **Pack progress bar** (`#/cart`, `packProgressHtml` in app.js):
  the digital equivalent of the free-delivery threshold. Under the
  S$29 complete pack it shows "S$X away from the complete pack" with
  a fill bar and an "Add the pack" button (adds via the normal cart
  toggle); at or over S$29 without the pack it says the cart is
  already worth more than the pack; with the pack in the cart it
  shows "Complete pack in your cart ✓". Savings are computed from
  the catalogue (30 singles × S$4 − S$29 = S$91), not hard-coded.
  The every-page banner part needs no code — the admin announcement
  setting (`#/kangle` → Settings) already exists; suggested copy:
  "Complete 30-sticker pack — S$29 · save S$91 vs singles".
- **Refund policy line** (`refundLineHtml`): on the cart page under
  the Stripe line and on the download page (single + multi-order
  renders). Wording from MONETISE.md §7, verbatim policy: digital
  files can't be returned once downloaded; refunds only for
  duplicate charges or a corrupt file, within 7 days — write in via
  the feedback form on the About page. Prices include GST (also
  MONETISE.md §7: say so on the checkout page).
- Shell app.js?v=26 / styles.css?v=20, SW v27. Tests 153/153,
  typecheck clean. Live verify 2026-11-27 ~05:24: ALL PASS — one
  set in cart shows "S$14 away from the complete pack" with a
  half-full bar and Add-the-pack button; tapping it gives set +
  pack, subtotal S$44, "Complete pack in your cart ✓"; refund line
  (quoted verbatim above) visible on the cart page and the download
  page. Note from the same check: the download page spent ~35s on
  the "Confirming your payment…" spinner before the files appeared
  — pre-existing polling behaviour, not new in v1.1.

## Build status (v1 — built 2026-11-27, deploy dpl_AA8dk9oHinUqi2dgiYAGgn1UyHKA READY)

Everything above is built. Tests 153/153 (was 142), typecheck clean.

- **First deploy failed, then fixed:** migration
  `20261127010000_cart_orders` failed with P3018 — Prisma created
  the old unique as an INDEX, so `DROP CONSTRAINT` errored. Fixed
  to `DROP INDEX IF EXISTS`, and the build ran a one-time
  `migrate resolve --rolled-back` (removed again in the next commit,
  so the build is clean now). The failed migration applied nothing
  (transaction rolled back), production never saw a half-state.
- **Live, verified by curl:** shell app.js?v=24 / styles.css?v=18;
  `POST /api/orders/checkout` answers 503 `checkout_not_configured`
  (the route is live, the key is genuinely absent); the two old test
  orders still look up; the migration left existing rows intact.
- **Live, verified in the browser:** (first check, 2026-11-27 ~00:34)
  cart page, draft save/restore, clear, checkout message and item
  removal all pass — but two bugs: (1) the single-sticker Add to
  cart never appeared in the modal; (2) the set Add to cart only
  appeared after a full reload, not on SPA hash navigation; (3) the
  empty-cart badge showed "Cart 0" instead of hiding. Cause: openSet
  called renderBuyButtons but not renderCartButtons, openStickerModal
  called renderStickerBuyBtn but not renderCartButtons (loadLinks had
  hidden the modal button while no sticker was selected), and
  `.cart-count { display: inline-block }` beat the `[hidden]`
  default. Fixed in commit 5a1efd0 (app.js?v=25 / styles.css?v=19,
  deploy dpl_FVTNdaWnRQBGQADRJBMsyR7SAt3Y READY); browser re-check
  2026-11-27 ~00:37: ALL PASS — set button appears on SPA navigation,
  modal button present (and survives next/prev), two-item cart
  subtotals S$19, empty-cart badge hidden. Cart v1 fully verified
  live except cart checkout itself, which waits on the key.
- **Still open — the one step only the owner can do:** create a
  Stripe **restricted key** (Checkout Sessions: write) in the Stripe
  Dashboard and add it as `STRIPE_SECRET_KEY` on Vercel (production
  + preview). Until then the cart, drafts and management all work and
  checkout says plainly that it is not connected yet. Once the key is
  set, verify with one test-mode cart purchase (two items, one
  payment) and check the webhook records one Order row per item.
