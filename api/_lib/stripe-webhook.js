// Stripe webhook signature verification + order-item resolution.
//
// The webhook (api/stripe/webhook.js) verifies Stripe's HMAC signature
// with node:crypto only — no `stripe` SDK dependency in this repo.
// Stripe's scheme: the Stripe-Signature header carries t=<unix seconds>
// and one or more v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")> values.
// See https://docs.stripe.com/webhooks#verify-official-libraries
"use strict";

const crypto = require("crypto");

const SIGNATURE_TOLERANCE_SEC = 300;

/**
 * Read the request body as raw bytes. The webhook signature is computed
 * over the exact bytes Stripe sent, so the body must NOT be JSON-parsed
 * first (readJsonBody would re-encode it).
 *
 * @param {import("http").IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * True when `signatureHeader` is a valid Stripe signature for `rawBody`
 * under `secret`. Rejects stale timestamps (> tolerance) and any
 * signature that does not match, using a timing-safe comparison.
 *
 * @param {Buffer} rawBody
 * @param {string} signatureHeader the Stripe-Signature header value
 * @param {string} secret the webhook endpoint secret (whsec_...)
 * @param {number} [nowSec] unix seconds, defaults to Date.now()/1000
 * @returns {boolean}
 */
function verifyStripeSignature(rawBody, signatureHeader, secret, nowSec) {
  if (!rawBody || !signatureHeader || !secret) return false;
  const now = nowSec === undefined ? Math.floor(Date.now() / 1000) : nowSec;
  let timestamp = null;
  const signatures = [];
  for (const part of String(signatureHeader).split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t") timestamp = parseInt(v, 10);
    else if (k === "v1") signatures.push(v);
  }
  if (!timestamp || Number.isNaN(timestamp) || signatures.length === 0) {
    return false;
  }
  if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SEC) return false;
  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  return signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, "utf8");
    return (
      sigBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(sigBuf, expectedBuf)
    );
  });
}

/**
 * Resolve which shop item a Checkout Session bought, from the session
 * metadata the Payment Link stamped on it (shop_item/shop_type), falling
 * back to the generated link map (api/_lib/payment-link-map.js) keyed by
 * the session's payment_link id. Returns null when neither resolves —
 * the caller still records the order, with itemId "unknown", so the
 * payment is never lost silently.
 *
 * @param {any} session a checkout.session object
 * @param {Record<string, { itemId: string, type: string, amount: number }>} linkMap
 * @returns {{ itemId: string, itemType: string } | null}
 */
function resolveOrderItem(session, linkMap) {
  const meta = session && session.metadata ? session.metadata : {};
  if (meta.shop_item) {
    return { itemId: meta.shop_item, itemType: meta.shop_type || "unknown" };
  }
  const byLink =
    session && session.payment_link ? linkMap[session.payment_link] : null;
  if (byLink) {
    return { itemId: byLink.itemId, itemType: byLink.type };
  }
  return null;
}

/**
 * The items a cart Checkout Session bought, from the metadata the
 * cart checkout stamped on it (cart_count + cart_0… + cart_type_0…
 * + cart_qty_0…). Quantities default to 1 when absent or malformed
 * (older sessions predate them). Returns null when the session is
 * not a cart session, or the metadata is malformed — the caller then
 * falls back to the single-item resolution above.
 *
 * @param {any} session a checkout.session object
 * @returns {{ itemId: string, itemType: string, quantity: number }[] | null}
 */
function resolveCartItems(session) {
  const meta = session && session.metadata ? session.metadata : {};
  const count = parseInt(meta.cart_count, 10);
  if (!count || Number.isNaN(count) || count <= 0 || count > 50) {
    return null;
  }
  const items = [];
  for (let i = 0; i < count; i++) {
    const itemId = meta[`cart_${i}`];
    const itemType = meta[`cart_type_${i}`];
    if (!itemId || !itemType) return null;
    const qty = parseInt(meta[`cart_qty_${i}`], 10);
    items.push({
      itemId,
      itemType,
      quantity:
        !qty || Number.isNaN(qty) ? 1 : Math.max(1, Math.min(99, qty)),
    });
  }
  return items;
}

module.exports = {
  readRawBody,
  verifyStripeSignature,
  resolveOrderItem,
  resolveCartItems,
  SIGNATURE_TOLERANCE_SEC,
};
