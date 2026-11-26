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
const linkMap = require("../_lib/payment-link-map");

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any, webhookSecret?: string }} [deps] test injection only
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
    if (!verifyStripeSignature(rawBody, signature, secret)) {
      sendJson(res, 400, { error: "invalid_signature" });
      return;
    }
    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch (e) {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    if (event.type !== "checkout.session.completed") {
      sendJson(res, 200, { received: true, ignored: true });
      return;
    }
    const session = event.data && event.data.object ? event.data.object : {};
    const resolved = resolveOrderItem(session, linkMap);
    const prisma = deps.prisma || getPrisma();
    const data = {
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
    };
    const order = await prisma.order.upsert({
      where: { stripeSessionId: session.id },
      create: data,
      update: data,
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
