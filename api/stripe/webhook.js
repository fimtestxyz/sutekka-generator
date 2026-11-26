// POST /api/stripe/webhook — Stripe webhook receiver for the shop.
//
// Listens for checkout.session.completed and records one Order row per
// paid session (upsert on stripeSessionId, so Stripe redeliveries are
// idempotent). The download page reads the Order back by session id; no
// sign-in is needed to buy, so this endpoint is unauthenticated — its
// only trust is the Stripe signature (STRIPE_WEBHOOK_SECRET, set on
// Vercel from the endpoint created in the Dashboard/API). A request
// with a bad or missing signature is answered 400 and nothing is stored.
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
    // Pin the exact files bought (ADMIN.md §3): resolved from the
    // live payment-links data so a later redraw never changes what
    // the print queue prints. A failed fetch stores null — the admin
    // view then resolves live instead of failing the order.
    let files = null;
    try {
      const linksData = await fetchLinksData({ fetchFn: deps.fetchFn });
      files = resolved
        ? resolveOrderFiles(resolved.itemId, resolved.itemType, linksData)
        : null;
    } catch (e) {
      files = null;
    }
    const payMethodType =
      session.payment_method_types &&
      session.payment_method_types.length > 0
        ? session.payment_method_types[0]
        : null;
    const createData = {
      stripeSessionId: session.id,
      stripePaymentLinkId: session.payment_link || null,
      stripePaymentIntentId: session.payment_intent || null,
      buyerEmail:
        (session.customer_details && session.customer_details.email) || null,
      itemId: resolved ? resolved.itemId : "unknown",
      itemType: resolved ? resolved.itemType : "unknown",
      amountTotal:
        typeof session.amount_total === "number" ? session.amount_total : 0,
      currency: session.currency || "sgd",
      status: "paid",
      payMethodType,
      filesJson: files,
    };
    // The update branch is Stripe-owned facts ONLY. It never touches
    // status, printStatus, filesJson or any admin-managed field, so a
    // Stripe redelivery cannot undo a refund, a print status or the
    // pinned files.
    const updateData = {
      stripePaymentLinkId: createData.stripePaymentLinkId,
      stripePaymentIntentId: createData.stripePaymentIntentId,
      buyerEmail: createData.buyerEmail,
      itemId: createData.itemId,
      itemType: createData.itemType,
      amountTotal: createData.amountTotal,
      currency: createData.currency,
    };
    let order;
    try {
      order = await prisma.order.upsert({
        where: { stripeSessionId: session.id },
        create: createData,
        update: updateData,
      });
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
    sendJson(res, 200, { received: true, orderId: order.id });
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
