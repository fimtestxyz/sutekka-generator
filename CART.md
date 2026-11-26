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
