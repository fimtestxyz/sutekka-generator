// POST /api/orders/checkout — create one Stripe Checkout Session for
// a whole cart (CART.md).
//
// Payment Links cannot take a cart — one link is one item — so the
// cart checks out through a server-side Checkout Session built from
// the cart's Stripe Price IDs (resolved from
// data/payment-links.json, the same source the Buy buttons use).
//
// Needs STRIPE_SECRET_KEY on Vercel — a restricted key with only
// "Checkout Sessions: write". Without it the endpoint answers 503
// checkout_not_configured and the cart page says so plainly; the
// cart and drafts keep working. The secret is never logged.
//
// The session carries metadata.cart_count + cart_0…cart_N-1 (item
// ids) + cart_type_0… (types) + shop_type "cart", which the webhook
// reads to record one Order row per item.
"use strict";

const {
  sendJson,
  methodNotAllowed,
  dbAvailable,
  readJsonBody,
} = require("./http");
const { checkRateLimit } = require("./rate-limit");
const { cartCheckoutSchema, parseBody } = require("./schemas");
const { fetchLinksData } = require("./admin-orders");

const MAX_ITEMS = 50;

function clientIp(req) {
  const forwarded = req.headers && req.headers["x-forwarded-for"];
  return forwarded
    ? String(forwarded).split(",")[0].trim()
    : (req.socket && req.socket.remoteAddress) || "unknown";
}

function siteBase() {
  return (process.env.AUTH_URL || "https://sutekka.gobblemon.com").replace(
    /\/$/,
    "",
  );
}

/**
 * Resolve one cart item against the links data. Returns the entry
 * (with price_id + amount) or null when the id/type does not match
 * the catalogue.
 *
 * @param {string} itemId single sticker id, set slug, or "complete-pack-30"
 * @param {string} type "single" | "set" | "pack"
 * @param {any} linksData parsed payment-links.json
 * @returns {any | null}
 */
function resolveCartEntry(itemId, type, linksData) {
  if (!linksData || typeof linksData !== "object") return null;
  if (type === "single") {
    return linksData.singles ? linksData.singles[itemId] || null : null;
  }
  if (type === "set") {
    return linksData.sets ? linksData.sets[itemId] || null : null;
  }
  if (type === "pack") {
    return itemId === "complete-pack-30" ? linksData.pack || null : null;
  }
  return null;
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ stripeSecret?: string, fetchFn?: Function, stripeFetchFn?: Function }} [deps] test injection only
 */
async function checkoutHandler(req, res, deps = {}) {
  try {
    if (req.method !== "POST") {
      methodNotAllowed(res, ["POST"]);
      return;
    }
    if (!dbAvailable(res)) return;
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    const parsed = parseBody(cartCheckoutSchema, body);
    if (!parsed.ok) {
      sendJson(res, 400, { error: "invalid_body", details: parsed.details });
      return;
    }
    if (!checkRateLimit(`cart-checkout:${clientIp(req)}`, 10, 60_000)) {
      sendJson(res, 429, { error: "too_many_attempts" });
      return;
    }
    // Dedup by item id, keeping the first type seen — the cart holds
    // one of each item (digital files, no quantities).
    const seen = new Map();
    for (const item of parsed.data.items) {
      if (!seen.has(item.itemId)) seen.set(item.itemId, item.type);
    }
    if (seen.size > MAX_ITEMS) {
      sendJson(res, 400, {
        error: "invalid_body",
        details: ["too many items"],
      });
      return;
    }
    const secret =
      deps.stripeSecret !== undefined
        ? deps.stripeSecret
        : process.env.STRIPE_SECRET_KEY;
    if (!secret) {
      sendJson(res, 503, { error: "checkout_not_configured" });
      return;
    }
    const linksData = await fetchLinksData({ fetchFn: deps.fetchFn });
    const resolved = [];
    for (const [itemId, type] of seen) {
      const entry = resolveCartEntry(itemId, type, linksData);
      if (!entry || !entry.price_id) {
        sendJson(res, 400, { error: "unknown_item", details: [itemId] });
        return;
      }
      resolved.push({ itemId, type, priceId: entry.price_id });
    }
    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set(
      "success_url",
      siteBase() + "/#/download?session_id={CHECKOUT_SESSION_ID}",
    );
    params.set("cancel_url", siteBase() + "/#/cart");
    params.set("automatic_tax[enabled]", "true");
    resolved.forEach((item, i) => {
      params.set(`line_items[${i}][price]`, item.priceId);
      params.set(`line_items[${i}][quantity]`, "1");
    });
    params.set("metadata[cart_count]", String(resolved.length));
    params.set("metadata[shop_type]", "cart");
    resolved.forEach((item, i) => {
      params.set(`metadata[cart_${i}]`, item.itemId);
      params.set(`metadata[cart_type_${i}]`, item.type);
    });
    const stripeFetch = deps.stripeFetchFn || fetch;
    let stripeRes;
    try {
      stripeRes = await stripeFetch(
        "https://api.stripe.com/v1/checkout/sessions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch (e) {
      console.error("cart checkout: Stripe request failed", e);
      sendJson(res, 502, { error: "stripe_error" });
      return;
    }
    if (!stripeRes.ok) {
      console.error("cart checkout: Stripe answered", stripeRes.status);
      sendJson(res, 502, { error: "stripe_error" });
      return;
    }
    const session = await stripeRes.json();
    if (!session || !session.url || !session.id) {
      console.error("cart checkout: Stripe session missing url/id");
      sendJson(res, 502, { error: "stripe_error" });
      return;
    }
    sendJson(res, 200, { url: session.url, sessionId: session.id });
  } catch (e) {
    console.error("ordersCheckoutHandler error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point (via the orders catch-all router). The optional
// third argument is test injection only (Vercel never passes it).
module.exports = async function handler(req, res, deps) {
  await checkoutHandler(req, res, deps);
};
