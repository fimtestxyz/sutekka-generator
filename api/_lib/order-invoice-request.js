// POST /api/orders/invoice-request — buyer asks for a formal invoice
// for their order (ADMIN.md §3, §4.2).
//
// No sign-in is needed to buy, so none is needed here: the
// credential is the order itself — session id or order id PLUS the
// buyer email on the order, which the caller must already know. One
// open request per order; a repeat request answers 409.
"use strict";

const { getPrisma } = require("./prisma");
const {
  sendJson,
  methodNotAllowed,
  dbAvailable,
  readJsonBody,
} = require("./http");
const { checkRateLimit } = require("./rate-limit");
const { buyerInvoiceRequestSchema, parseBody } = require("./schemas");

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any }} [deps] test injection only
 */
async function invoiceRequestHandler(req, res, deps = {}) {
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
    const parsed = parseBody(buyerInvoiceRequestSchema, body);
    if (!parsed.ok) {
      sendJson(res, 400, { error: "invalid_body", details: parsed.details });
      return;
    }
    const { sessionId, orderId, email } = parsed.data;
    if (!sessionId && !orderId) {
      sendJson(res, 400, {
        error: "invalid_body",
        details: ["one of sessionId or orderId is required"],
      });
      return;
    }
    const prisma = deps.prisma || getPrisma();
    let order = null;
    if (sessionId) {
      // A cart session owns one row per item, so a session id alone
      // does not identify one order — the buyer must use the order
      // id (the download page links each item to its own order page).
      const rows = await prisma.order.findMany({
        where: { stripeSessionId: sessionId },
        take: 2,
      });
      if (rows.length === 0) {
        sendJson(res, 404, { error: "order_not_found" });
        return;
      }
      if (rows.length > 1) {
        sendJson(res, 400, {
          error: "ambiguous_session",
          details: [
            "this payment covers several items — use the order id",
          ],
        });
        return;
      }
      order = rows[0];
    } else {
      order = await prisma.order.findUnique({ where: { id: orderId } });
    }
    if (!order) {
      sendJson(res, 404, { error: "order_not_found" });
      return;
    }
    if (
      !order.buyerEmail ||
      order.buyerEmail.toLowerCase() !== email.toLowerCase()
    ) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    if (!checkRateLimit(`order-invoice:${order.id}`, 5, 60_000)) {
      sendJson(res, 429, { error: "too_many_attempts" });
      return;
    }
    const existing = await prisma.invoiceRequest.findUnique({
      where: { orderId: order.id },
    });
    if (existing && existing.status === "open") {
      sendJson(res, 409, { error: "invoice_request_exists" });
      return;
    }
    const request = await prisma.invoiceRequest.upsert({
      where: { orderId: order.id },
      create: { orderId: order.id, buyerEmail: order.buyerEmail, status: "open" },
      update: { status: "open", resolvedAt: null },
    });
    await prisma.order.update({
      where: { id: order.id },
      data: { invoiceRequestedAt: new Date() },
    });
    sendJson(res, 201, { request: { id: request.id, status: request.status } });
  } catch (e) {
    console.error("ordersInvoiceRequestHandler error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point. The optional third argument is test injection
// only (Vercel never passes it).
module.exports = async function handler(req, res, deps) {
  await invoiceRequestHandler(req, res, deps);
};
