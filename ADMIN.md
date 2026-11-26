# ADMIN.md — Sutekka shop admin (`#/kangle`) — SPEC v1.0

Written 2026-11-26. Status: **spec only — nothing here is built yet.**
The shop it administers is live in the Stripe sandbox (see STRIPE_PLAN.md):
46 Payment Links (40 singles S$4, 5 sets S$15, 1 pack of 30 S$29),
an `Order` table in Neon, a Stripe webhook, Buy buttons and a download
page. The test purchase passed end to end 2026-11-26 23:41 SGT.

## 1. Purpose

One page where the owner (the admin) sees every confirmed payment and
every delivery, issues invoices, and runs the physical-printing queue.
Buyers never see it; there is no link to it in the site navigation.

Design rules:

- **The order is the source of truth.** Everything the admin does —
  invoice, print, ship, refund — hangs off one Order row.
- **No money moves silently.** Every admin action that touches money or
  fulfilment is written to an audit log with who did it and when.
- **The admin never sees card details.** Stripe never exposes them; the
  admin sees payment method type (card / PayNow), brand and last 4 only
  where Stripe provides them.
- **No destructive actions.** Orders are never deleted. A bad order is
  refunded or cancelled with a reason, and stays visible.

## 2. URL and access

- **Route: `#/kangle`** in the existing SPA (hash routing, same shell as
  every other view). The admin bookmarks
  `https://sutekka.gobblemon.com/#/kangle`. A separate top-level `/kangle`
  page is a future hardening step, not v1 — the SPA route keeps one
  codebase and one deploy.
- **Login: a form, username + password.** No Google sign-in for the
  admin area — it is a separate credential, so a Google account problem
  can never lock the owner out of the shop, and the admin session is
  distinct from a buyer's Google session.
- **First-run setup (how the password is set).** The password is never
  sent through chat, never typed into a vault form for Muse, and never
  stored as an env var. Instead: the first time anyone opens `#/kangle`
  while no admin account exists, the page shows a one-time setup form
  ("Create your admin account"). The owner types the username +
  password there, on their own site; the server hashes it (scrypt,
  Node built-in — no new dependency) and stores it in the database.
  After the first account is created the setup form is gone for good
  (`POST /api/admin/setup` returns 409 once an admin exists). The
  owner must create the account immediately after deploy — the window
  between deploy and first setup is the only time the form exists, and
  the URL is unlinked, so the exposure is small, but it is real and the
  owner should not leave it open.
- **How the session works:** `POST /api/admin/login` checks the
  password against the stored scrypt hash, then creates a random
  32-byte session token, stores only its SHA-256 hash in the database
  (`AdminSession`, 24-hour expiry), and sets an httpOnly, Secure,
  SameSite=Lax cookie carrying the raw token. Every `/api/admin/*`
  endpoint verifies the cookie against the stored hash; without it the
  answer is 401 and the frontend shows the login form. No admin UI code
  path ever runs without a verified session. Sessions are revocable:
  logout deletes the row, and "revoke all sessions" deletes every row
  for the admin. No `ADMIN_SESSION_SECRET` env var is needed.
- **Rate limiting:** 5 failed logins → 15-minute lockout for that
  username + IP. Login attempts (success and failure) go to the audit
  log.
- **One admin to start** (the owner). A second login is v2 and needs
  only a second `AdminUser` row — the table exists from v1.

## 3. What the buyer gets: invoice and order details

This is the buyer-facing half the admin supports. It already partly
exists; the spec completes it.

- **Order page (already live).** The download page shows: order id,
  date, item title, amount, currency, buyer email, payment status
  (paid / delivered). It stays the buyer's permanent record — the same
  URL (`#/download?order_id=…`) works weeks later.
- **Receipt (already live).** Stripe sends the buyer an email receipt
  automatically on every Payment Link purchase.
- **Payment method on the order.** The webhook already stores the
  session; v1 also stores the payment method type (card / PayNow) and,
  for cards, brand + last 4, so the order page can say "Paid by Visa
  •••• 4242" or "Paid by PayNow". Source: the Checkout Session's
  `payment_method_types` plus the PaymentMethod (last 4 needs one extra
  Stripe read in the webhook — allowed, it uses the webhook secret only
  for verification, not the API key; see §6 note).
- **Formal invoice (new).** A buyer who needs a proper invoice clicks
  "Request invoice" on the order page. That creates an invoice request
  the admin sees; the admin issues a Stripe Hosted Invoice from the
  order view (one click, prefilled from the order + the business
  details on the Stripe account). The invoice carries: Gobblemon
  business name + address, invoice number (Stripe-assigned), date,
  buyer email, item, amount, currency, and a "No GST charged" line
  while the business is below Singapore's S$1m GST registration
  threshold (with the threshold as a watch item — see STRIPE_PLAN.md).
  The buyer gets the invoice by email; the admin can re-download it
  from the order.
- **The sticker is saved for printing (new).** At the moment the
  webhook records the order, it pins the exact files bought: item id,
  file path(s) and the file's pixel dimensions as of purchase. The
  order keeps that pin even if the sticker is later redrawn — the
  print queue always prints what the buyer bought, not the newest
  version. (Today the Order stores only `itemId`; the file list is
  resolved live from the index. Pinning is a v1 requirement for
  printing — see §5.)

## 4. What the admin can manage

### 4.1 Orders and payments

- **Orders table:** every order, newest first, with buyer email, item,
  amount, status, date. Filter by status (paid / delivered / refunded /
  cancelled), by item type (single / set / pack), by date range; search
  by order id, Stripe session id, or buyer email.
- **Order detail:** full record — buyer email, item(s) with file links,
  amount + currency, Stripe session id + payment intent id (each linking
  out to the Stripe Dashboard), payment method, paid date, status
  timeline (paid → delivered, with timestamps), admin notes.
- **Confirm payment:** the table shows only webhook-confirmed payments.
  A payment that never reached the webhook (e.g. a webhook outage) is
  visible as a gap, not silently missing — see §4.9.
- **Mark delivered / mark refunded / cancel:** status changes with a
  required reason, written to the audit log. Refund: see the decision
  in §10 — v1 does the refund in the Stripe Dashboard (linked from the
  order), v2 does it in-admin.
- **Resend download link:** re-sends the buyer their download URL by
  email (uses the buyer email on the order; the email itself is sent
  from the site's mail path — v1 may be a "copy the link" action for the
  admin to paste, if no mail sender is wired up yet).
- **Export:** orders as CSV (all columns, current filter applied).

### 4.2 Invoices

- **Invoice requests queue:** buyers' "Request invoice" clicks, oldest
  first; each shows the order and the buyer email.
- **Issue / re-download / void:** issue a Stripe Hosted Invoice from
  the order; download the PDF; void a wrongly issued one (Stripe-side).
- **Invoice register:** every issued invoice with number, order, amount,
  date, status (paid / void).

### 4.3 Physical printing and fulfilment

Physical printing is Phase 3 of MONETISE.md (print-on-demand, sample in
hand before selling). The admin is what makes it operable; it does not
start selling prints by itself.

- **Print queue:** orders flagged for printing, in print-status order
  (queued → printing → shipped → delivered). A digital-only order never
  enters the queue unless the admin (or the buyer) flags it.
- **Per-order print files:** the pinned file list from §3, each with a
  download link, pixel dimensions, and DPI at common print sizes. The
  current masters are 1600×1680 PNG (sRGB) — about 5.3" × 5.6" at
  300 DPI. The admin view states the honest maximum for each size; it
  never promises a larger print than the file supports. (If a higher-res
  master exists for a set, that file is what the queue links — the queue
  shows which source it used.)
- **Print status + tracking:** admin sets printing → shipped, entering
  courier + tracking number. The buyer sees the status and tracking
  number on their order page.
- **Shipping address:** Payment Links do not collect a shipping address
  today. V1: the buyer adds name + address on the download page after
  purchase (a small form, stored on the Order); the admin sees it in the
  print queue. V2: enable Stripe's shipping-address collection on the
  Payment Links instead (requires recreating the links — see §10).
- **Print notes:** free-text per order (e.g. "reprint — first run
  mis-cut", "buyer asked for matte").
- **"Download all" for a print run:** v1 is per-file links; a zip of one
  order's files is v2 (server-side zip is out of scope for v1).

### 4.4 Products and prices

- **Catalogue view:** the 46 shop items with live status (link active /
  archived), price, and sales count. Read-only in v1 — prices change by
  creating a new Price + Payment Link (the existing
  `scripts/create_stripe_links.py` flow), not by editing a number in the
  admin. This keeps the link map (`payment-links.json`) as the single
  source of truth.
- **Hide / show a Buy button:** v1 can hide an item's Buy button
  (e.g. a set under a column-rights review) without touching Stripe —
  a flag in `payment-links.json` the frontend respects. Unhiding
  re-enables it.
- **Add a set / pack to the shop:** runs the link-creation script
  (admin triggers it, or the owner runs it — v1 is owner-run, the admin
  only sees the result).

### 4.5 Discounts

- **Coupons / promotion codes:** created in the Stripe Dashboard and
  attached to Payment Links. V1: the admin views which codes are live
  and their redemption counts (read from Stripe); creating a code is a
  Dashboard action. In-admin creation is v2.

### 4.6 Customers

- **Buyers:** one row per buyer email — orders, total spent, first/last
  purchase. No account is required to buy, so this is a view of order
  history, not a user directory.
- **Signed-in users (the social layer):** list Google-signed-in users
  with their bookmarks/likes/comments counts — read-only in v1.
- **Content moderation:** comments list with hide/delete; feedback
  inbox (the About-page form) with mark-resolved. Hiding is reversible;
  deleting is logged.

### 4.7 Site and shop settings

- **Shop open / closed:** one toggle that hides every Buy button
  site-wide (e.g. while the live account is being set up, or during a
  print backlog). The download and order pages keep working.
- **Announcement:** one short banner line on the homepage (e.g. "Print
  orders ship in 5 working days").
- **Pack composition:** view (not edit) — the pack is the first 30
  stickers in inventory order; changing it is a code + link change, not
  an admin toggle.

### 4.8 Analytics

- **Sales summary:** revenue by day / week / month, by item type, top
  10 sellers, refund rate. Computed from the Order table (not from
  Stripe) so it matches what the admin sees in the orders table.
- **Conversion (rough):** Buy-button clicks (GA4 event `buy_click`,
  already emitted) vs paid orders. Directional only — link clicks and
  payments are not joined per buyer.

### 4.9 System and security

- **Webhook health:** last webhook event received (time + type), recent
  failures (bad signature, DB errors), and a "replay" note — Stripe
  redelivers automatically; the admin sees the failure, not a fix
  button, in v1.
- **Audit log:** every admin login, status change, refund/cancel,
  invoice issue, print-status change, tracking-number entry, and
  settings change — admin user, action, order id, timestamp. Read-only,
  newest first, exportable as CSV.
- **Admin access:** change password (old + new, in the admin), view
  active sessions, revoke all sessions.

## 5. Data model changes

Add to the `Order` model (Prisma, new migration):

| Field | Type | Notes |
|---|---|---|
| `payMethodType` | String? | `card` / `paynow` / … from the session |
| `payMethodDetail` | String? | card brand + last 4, e.g. `Visa •••• 4242` |
| `filesJson` | Json? | pinned files at purchase: `[{itemId, file, width, height}]` |
| `printStatus` | String | `none` / `queued` / `printing` / `shipped` / `delivered` (default `none`) |
| `shippingName` | String? | buyer name for shipping |
| `shippingAddress` | Json? | `{line1, line2, city, postal, country}` from the download-page form |
| `trackingCourier` | String? | e.g. `SingPost`, `Ninja Van` |
| `trackingNumber` | String? | shown to the buyer on the order page |
| `invoiceId` | String? | Stripe invoice id once issued |
| `invoiceNumber` | String? | Stripe invoice number |
| `adminNotes` | String? | free text, admin-only |
| `refundedAt` | DateTime? | set on refund, with `status = 'refunded'` |
| `cancelReason` | String? | required when status → cancelled/refunded |

New model `AdminUser`: `id`, `username` (unique), `passwordHash`
(scrypt, `scrypt:<salt-hex>:<hash-hex>`), `createdAt`, `updatedAt`.
Created once by the first-run setup; a second row is how v2 adds a
helper.

New model `AdminSession`: `id`, `tokenHash` (unique, SHA-256 of the
random session token), `adminUserId` (FK), `expiresAt`, `createdAt`.
Logout and "revoke all" delete rows; no JWT, no session secret.

New model `AuditLog`: `id`, `adminUser` (username), `action`
(e.g. `order.delivered`, `order.refunded`, `invoice.issued`,
`print.shipped`, `settings.shop_closed`, `auth.login_failed`),
`orderId` (nullable), `details` (Json, small), `createdAt`. No updates,
no deletes.

New model `InvoiceRequest`: `id`, `orderId` (unique), `buyerEmail`,
`status` (`open` / `issued` / `declined`), `createdAt`,
`resolvedAt` — or fold it into Order as a `invoiceRequestedAt` flag.
Prefer the separate table: it is the queue, and it keeps Order clean.

New model `WebhookEvent`: `id`, `type` (e.g.
`checkout.session.completed`), `stripeSessionId` (nullable),
`status` (`ok` / `error`), `error` (nullable), `createdAt`. The
webhook handler writes one row per event it processes — this is the
webhook-health view's data.

New model `SiteSetting`: `key` (unique, e.g. `shop_closed`,
`announcement`, `hidden_items`), `value` (String, JSON for
`hidden_items`). Read by a public `GET /api/settings`; written only
by the admin.

No `ADMIN_*` env vars in v1: the password lives in `AdminUser`, the
session in `AdminSession`. (An earlier draft of this spec used
`ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` / `ADMIN_SESSION_SECRET` env
vars; that was changed at build time because the password would have
had to travel through chat or the vault to reach Vercel, which is not
acceptable — the first-run setup keeps it on the owner's own site.)

## 6. API endpoints

All under `/api/admin/*`, all require the admin session cookie (401
otherwise). All writes validate with Zod (same pattern as
`api/_lib/schemas.js`) and write an `AuditLog` row.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/admin/setup` | POST | One-time first-run setup `{username, password}` → creates the first `AdminUser`. Returns 409 once any admin exists. |
| `/api/admin/login` | POST | `{username, password}` → session cookie. Rate-limited. |
| `/api/admin/logout` | POST | Clears the cookie. |
| `/api/admin/session` | GET | `{admin: {username} \| null}` — what the frontend checks. |
| `/api/admin/orders` | GET | List + filter (`?status&itemType&from&to&q`), paginated. |
| `/api/admin/orders/[id]` | GET | One order + its audit entries. |
| `/api/admin/orders/[id]/status` | POST | `{status, reason}` — delivered / refunded / cancelled. |
| `/api/admin/orders/[id]/note` | POST | `{note}` — admin notes. |
| `/api/admin/orders/[id]/shipping` | POST | `{name, address, courier, trackingNumber}` + print status. |
| `/api/admin/orders/[id]/print` | POST | `{printStatus}` — queued / printing / shipped / delivered. |
| `/api/admin/orders/[id]/invoice` | POST | Issue a Stripe Hosted Invoice for the order. **Note:** issuing an invoice calls the Stripe API, which needs the Stripe secret key server-side. The webhook today needs only the webhook secret. So invoice-issuing (and any in-admin refund) requires adding `STRIPE_SECRET_KEY` to Vercel — a deliberate decision, see §10. V1 may instead link out to the Dashboard to issue it, and store the resulting invoice id. |
| `/api/admin/invoices` | GET | Invoice requests queue + issued-invoice register. |
| `/api/admin/print-queue` | GET | Orders with `printStatus != none`, ordered by status then date. |
| `/api/admin/stats` | GET | Revenue by period, top sellers, refund rate. |
| `/api/admin/webhooks` | GET | Recent webhook events + last-received time (from a small `WebhookEvent` log the webhook handler writes — v1 logs only failures + a heartbeat row; full event storage is v2). |
| `/api/admin/audit` | GET | Audit log, paginated, filterable by admin/action/order. |
| `/api/admin/settings` | GET/POST | Shop open/closed + announcement banner + hidden items. |
| `/api/admin/change-password` | POST | `{oldPassword, newPassword}` — verifies the old password, stores a new scrypt hash in `AdminUser`. (Possible in-function because the hash lives in the DB, not an env var.) |
| `/api/admin/sessions` | GET/DELETE | List active sessions / revoke all (logout everywhere). |

Buyer-facing additions (public, no admin session):

| Endpoint | Change |
|---|---|
| `POST /api/orders/lookup` | Already marks delivered. No change. |
| `POST /api/orders/[id]/shipping` (new, public) | Buyer submits name + shipping address for their own order (session id or order id + buyer email as the credential, same as the lookup). Stored on the Order; shown in the print queue. |
| `POST /api/orders/[id]/invoice-request` (new, public) | Buyer requests a formal invoice; creates an `InvoiceRequest` row. Rate-limited per order (one open request). |

## 7. Frontend views (`web_app/`, hash routes)

- **`#/kangle` (login):** username + password form, error text on failure
  ("Wrong username or password" — never say which), lockout message
  after 5 failures. On success → dashboard.
- **`#/kangle/dashboard` (or `#/kangle` once signed in):** sales
  summary cards (today / this week / this month, orders, refunds),
  invoice-request count, print-queue count, webhook health line.
- **`#/kangle/orders`:** the orders table (filters + search + CSV
  export). Row click → order detail.
- **`#/kangle/orders/<id>`:** order detail — everything in §4.1 +
  status buttons (with reason prompt), invoice section (issue /
  download / void), print section (files with dimensions + DPI,
  shipping address, courier + tracking, print-status buttons),
  admin notes, audit trail for that order.
- **`#/kangle/print`:** the print queue — one card per order with its
  files, address, status buttons.
- **`#/kangle/invoices`:** invoice requests + register.
- **`#/kangle/settings`:** shop open/closed, announcement, password
  change instructions, sessions.
- **Buyer download page (`#/download`):** add "Request invoice" button
  (when no invoice yet) and a shipping-address form (shown when the
  buyer wants a print — v1 shows it to every buyer with a "Want this
  printed? Add your shipping address" section; the order is flagged for
  the queue only when the buyer submits it).

Versioning follows the existing convention: `app.js`/`styles.css`
`?v=` bumps + SW CACHE bump on every shell change; no new `DATA_V`
(the admin reads live API data, not `index.json`).

## 8. Security rules

- The admin cookie is httpOnly + Secure + SameSite=Lax; the frontend
  never reads it. CSRF: state-changing admin calls check the `Origin`
  header against the site origin.
- No admin endpoint ever returns a password hash, a session secret, a
  Stripe secret, or full card numbers. The admin sees at most brand +
  last 4.
- The admin cannot delete orders, audit rows, or other admins (there is
  only one admin in v1). The admin cannot edit an order's amount or
  item — money facts come from Stripe, not from a form.
- The admin page is not linked anywhere public; it is reachable only by
  typing the URL. (Security by obscurity is not the defence — the
  password + session is. The unlinked URL just keeps casual visitors
  out of a login form.)
- Failed logins are rate-limited and logged; the lockout message never
  confirms whether the username exists.
- All admin reads/writes go through the same Prisma client and the
  existing `dbAvailable` 503 pattern; if the DB is down the admin sees
  "unavailable", not a partial page.

## 9. Phased rollout

- **v1 (this spec):** password login + session; orders table + detail;
  invoice requests + issue (via Dashboard link or API — decision §10);
  print queue with pinned files, shipping-address form, tracking;
  audit log; shop open/closed + announcement; CSV exports. No refunds
  in-admin, no discount creation, no multi-admin, no zip download.
- **v2:** refund in-admin (needs `STRIPE_SECRET_KEY` on Vercel);
  discount creation; zip download for a print run; webhook event log
  (full); in-function password rotation + a second admin login;
  Stripe shipping-address collection on the Payment Links (recreate
  links); sales analytics charts.

## 11. Build status (v1 — built 2026-11-26/27, commit e554838, deploy dpl_5pN6yXHWqhJPm8N8Uvmrs6mnHevq READY)

Everything in §§2–8 is built except the items marked otherwise below.
Tests 142/142 (was 97), typecheck clean.

- **Auth:** first-run setup + scrypt hash in `AdminUser` + DB session
  tokens + 5-fail lockout + audit log, as specced in §2 (the env-var
  design in the first draft was replaced — see §2).
- **Webhook pinning:** live — each new order stores `payMethodType`
  and `filesJson` (file paths + 1600×1680). Redeliveries update only
  Stripe-owned fields, never status/print/files/admin fields.
  Deviation from §3: card brand + last 4 are NOT stored in v1 — they
  need a Stripe API read with the secret key, and v1 deliberately has
  no `STRIPE_SECRET_KEY` on Vercel. Only the method type (card /
  PayNow) is stored. Last 4 is a v2 item (with the secret key).
- **Admin API:** `api/admin/[...admin].js` — all routes in §6 except
  the invoice-issuing API call: v1 records an invoice issued in the
  Dashboard (per decision 2); no in-admin issuing.
- **Buyer:** shipping + invoice-request endpoints live; download page
  shows tracking, invoice state, and both forms.
- **Settings:** shop open/closed + announcement + hidden items live;
  the storefront reads them on load.
- **Function-count constraint (build lesson):** the first v1 deploy
  FAILED with `exceeded_serverless_functions_per_deployment` — the
  Hobby plan allows 12 Serverless Functions per deployment and the
  project was already at 12 before the admin added 4. Fixed by
  consolidating into catch-all routers (implementations in `api/_lib/`):
  `api/orders/[...order].js` (lookup + shipping + invoice-request),
  `api/me/[...me].js` (bookmarks + preferences + profile),
  `api/stickers/[...sticker].js` (like + comments). Function count
  is now 11 of 12 — any new endpoint must reuse a router, not add a
  file. See AGENTS.md.
- **Not yet verified live:** the file pinning on a real webhook event
  (a second test purchase is running to prove it); the admin login
  itself (the owner creates the account at `#/kangle` first — the
  setup form is live, `setupNeeded: true` confirmed by curl).
- **Still open (from §10):** decisions 2 (invoice/refund in-admin
  needs `STRIPE_SECRET_KEY`), 3 (Stripe shipping collection later),
  4 (print size promise + sample before selling prints), 5
  (column-rights check per set, enforced by hide/show).

1. **Admin username + password.** The owner picks them and types them
   into the first-run setup form at `#/kangle` immediately after the
   v1 deploy — the password never goes through chat or the vault, and
   nothing can be built to need it first. The only action before the
   build is: create the account the moment the deploy lands.
2. **Invoice issuing: Dashboard link vs in-admin API.** In-admin issuing
   is one click, but it needs `STRIPE_SECRET_KEY` as a Vercel env var —
   a second live secret next to the webhook secret. Dashboard issuing
   needs no new secret but is a manual hop per invoice. Recommendation:
   v1 = Dashboard link (no new secret), v2 = in-admin API.
3. **Refunds: same question.** V1 = Stripe Dashboard (linked from the
   order). In-admin refunds need `STRIPE_SECRET_KEY` too.
4. **Shipping address: post-purchase form (v1) vs Stripe collection
   on the links (v2).** The form is faster to ship and works with the
   live links; Stripe collection is cleaner but requires recreating
   all 46 links. Recommendation: form now, Stripe collection later.
5. **Print promise.** Before the print queue is offered to buyers, the
   owner confirms the maximum print size per file (1600×1680 → ~5.3" at
   300 DPI) and that a sample print exists (MONETISE.md Phase 3 rule:
   sample in hand before selling). The admin spec does not authorise
   selling prints on its own.
6. **Column-rights check per set** (open since the monetisation plan):
   confirm each set's column may be sold before its Buy button is
   shown — the admin's hide/show toggle (§4.4) is the enforcement
   point.
