// POST /api/stripe/webhook — Stripe webhook receiver for the shop.
//
// Listens for checkout.session.completed and records Order rows for
// the paid session: one row for a Payment Link purchase, one row per
// item for a cart Checkout Session (upsert on (session, item), so
// Stripe redeliveries are idempotent). The download page reads the
// Order(s) back by session id; no sign-in is needed to buy, so this
// endpoint is unauthenticated — its only trust is the Stripe
// signature (STRIPE_WEBHOOK_SECRET, set on Vercel from the endpoint
// created in the Dashboard/API). A request with a bad or missing
// signature is answered 400 and nothing is stored.
//
// The endpoint secret is NOT in this repo: it is created when the
// webhook endpoint is registered with Stripe and stored as a Vercel
// environment variable.
"use strict";

const { getPrisma } = require("../_lib/prisma");
const {
  sendJson,
  methodNotAllowed,
  dbAvailable,
} = require("../_lib/http");
const {
  readRawBody,
  verifyStripeSignature,
  resolveOrderItem,
  resolveCartItems,
} = require("../_lib/stripe-webhook");
const {
  fetchLinksData,
  resolveOrderFiles,
} = require("../_lib/admin-orders");
const linkMap = require("../_lib/payment-link-map");

/** Best-effort WebhookEvent row — health data must never fail an order. */
async function logWebhookEvent(prisma, event) {
  try {
    await prisma.webhookEvent.create({ data: event });
  } catch (e) {
    console.error("webhookEvent log failed", e);
  }
}

/**
 * The catalogue price of one item, in cents — the per-item amount
 * for a cart order (the session total is the whole cart). Returns 0
 * when the item is not in the catalogue; the order is still recorded
 * (the payment is never lost silently).
 *
 * @param {string} itemId single sticker id, set slug, or "complete-pack-30"
 * @param {string} itemType "single" | "set" | "pack"
 * @param {any} linksData parsed payment-links.json
 * @returns {number}
 */
function amountFor(itemId, itemType, linksData) {
  if (!linksData || typeof linksData !== "object") return 0;
  if (itemType === "single" && linksData.singles && linksData.singles[itemId]) {
    return linksData.singles[itemId].amount || 0;
  }
  if (itemType === "set" && linksData.sets && linksData.sets[itemId]) {
    return linksData.sets[itemId].amount || 0;
  }
  if (itemType === "pack" && linksData.pack) {
    return linksData.pack.amount || 0;
  }
  return 0;
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any, webhookSecret?: string, fetchFn?: Function }} [deps] test injection only
 */
async function webhookHandler(req, res, deps = {}) {
  try {
    if (req.method !== "POST") {
      methodNotAllowed(res, ["POST"]);
      return;
    }
    if (!dbAvailable(res)) return;
    const secret =
      deps.webhookSecret !== undefined
        ? deps.webhookSecret
        : process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      sendJson(res, 503, { error: "webhook_not_configured" });
      return;
    }
    const rawBody = await readRawBody(req);
    const signatureHeader = req.headers["stripe-signature"];
    const signature = Array.isArray(signatureHeader)
      ? signatureHeader[0]
      : signatureHeader;
    const prisma = deps.prisma || getPrisma();
    if (!verifyStripeSignature(rawBody, signature, secret)) {
      await logWebhookEvent(prisma, {
        type: "invalid_signature",
        status: "error",
        error: "signature verification failed",
      });
      sendJson(res, 400, { error: "invalid_signature" });
      return;
    }
    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch (e) {
      await logWebhookEvent(prisma, {
        type: "invalid_json",
        status: "error",
        error: "body is not valid JSON",
      });
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    if (event.type !== "checkout.session.completed") {
      await logWebhookEvent(prisma, {
        type: event.type || "unknown",
        stripeSessionId:
          (event.data && event.data.object && event.data.object.id) || null,
        status: "ok",
      });
      sendJson(res, 200, { received: true, ignored: true });
      return;
    }
    const session = event.data && event.data.object ? event.data.object : {};
    const resolved = resolveOrderItem(session, linkMap);
    const cartItems = resolveCartItems(session);
    // Pin the exact files bought (ADMIN.md §3): resolved from the
    // live payment-links data so a later redraw never changes what
    // the print queue prints. A failed fetch stores null — the admin
    // view then resolves live instead of failing the order.
    let linksData = null;
    try {
      linksData = await fetchLinksData({ fetchFn: deps.fetchFn });
    } catch (e) {
      console.error("order files pinning failed", e);
      linksData = null;
    }
    const payMethodType =
      session.payment_method_types &&
      session.payment_method_types.length > 0
        ? session.payment_method_types[0]
        : null;
    const buyerEmail =
      (session.customer_details && session.customer_details.email) || null;
    const currency = session.currency || "sgd";
    // One Order row per item bought. A cart session lists its items
    // in the metadata; a Payment Link session resolves to one item.
    // The upsert key is (session, item), so a redelivery is
    // idempotent per item.
    const bought = cartItems || (resolved ? [{ ...resolved, quantity: 1 }] : [{ itemId: "unknown", itemType: "unknown", quantity: 1 }]);
    const orderIds = [];
    try {
      for (const item of bought) {
        const files = resolveOrderFiles(item.itemId, item.itemType, linksData);
        if (!files) {
          console.error(
            "order files pinning failed: could not resolve files for",
            item.itemId,
            "— order recorded without a file pin",
          );
        }
        const quantity = item.quantity || 1;
        const unitAmount = amountFor(item.itemId, item.itemType, linksData);
        const createData = {
          stripeSessionId: session.id,
          stripePaymentLinkId: session.payment_link || null,
          stripePaymentIntentId: session.payment_intent || null,
          buyerEmail,
          itemId: item.itemId,
          itemType: item.itemType,
          quantity,
          // Cart items are priced from the catalogue (the session
          // total is the whole cart), unit price x quantity; a
          // single-link session prices from Stripe, falling back to
          // the catalogue.
          amountTotal:
            cartItems || typeof session.amount_total !== "number"
              ? unitAmount * quantity
              : session.amount_total,
          currency,
          status: "paid",
          payMethodType,
          filesJson: files,
        };
        // The update branch is Stripe-owned facts ONLY. It never
        // touches status, printStatus, filesJson or any admin-managed
        // field, so a Stripe redelivery cannot undo a refund, a print
        // status or the pinned files. Quantity is a Stripe-owned fact
        // (it comes from the session metadata), so it belongs here.
        const updateData = {
          stripePaymentLinkId: createData.stripePaymentLinkId,
          stripePaymentIntentId: createData.stripePaymentIntentId,
          buyerEmail: createData.buyerEmail,
          itemId: createData.itemId,
          itemType: createData.itemType,
          quantity: createData.quantity,
          amountTotal: createData.amountTotal,
          currency: createData.currency,
        };
        const order = await prisma.order.upsert({
          where: {
            stripeSessionId_itemId: {
              stripeSessionId: session.id,
              itemId: item.itemId,
            },
          },
          create: createData,
          update: updateData,
        });
        orderIds.push(order.id);
      }
    } catch (e) {
      await logWebhookEvent(prisma, {
        type: event.type,
        stripeSessionId: session.id || null,
        status: "error",
        error: String((e && e.message) || e).slice(0, 500),
      });
      throw e;
    }
    await logWebhookEvent(prisma, {
      type: event.type,
      stripeSessionId: session.id || null,
      status: "ok",
    });
    sendJson(res, 200, { received: true, orderIds });
  } catch (e) {
    console.error("stripeWebhookHandler error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point. The optional third argument is test injection
// only (Vercel never passes it); see webhookHandler's deps.
module.exports = async function handler(req, res, deps) {
  await webhookHandler(req, res, deps);
};
