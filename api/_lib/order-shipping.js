// POST /api/orders/shipping — buyer submits a shipping address for
// a print of their order (ADMIN.md §4.3).
//
// No sign-in is needed to buy, so none is needed here: the
// credential is the order itself — session id or order id PLUS the
// buyer email on the order, which the caller must already know.
// Submitting an address flags the order for the print queue
// (printStatus "none" -> "queued"); it never changes any other
// print status.
"use strict";

const { getPrisma } = require("./prisma");
const {
  sendJson,
  methodNotAllowed,
  dbAvailable,
  readJsonBody,
} = require("./http");
const { checkRateLimit } = require("./rate-limit");
const { buyerShippingSchema, parseBody } = require("./schemas");

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any }} [deps] test injection only
 */
async function shippingHandler(req, res, deps = {}) {
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
    const parsed = parseBody(buyerShippingSchema, body);
    if (!parsed.ok) {
      sendJson(res, 400, { error: "invalid_body", details: parsed.details });
      return;
    }
    const { sessionId, orderId, email, name, address } = parsed.data;
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
    if (!checkRateLimit(`order-shipping:${order.id}`, 10, 60_000)) {
      sendJson(res, 429, { error: "too_many_attempts" });
      return;
    }
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        shippingName: name,
        shippingAddress: address,
        ...(order.printStatus === "none" ? { printStatus: "queued" } : {}),
      },
    });
    sendJson(res, 200, {
      order: {
        id: updated.id,
        printStatus: updated.printStatus,
        hasShippingAddress: true,
      },
    });
  } catch (e) {
    console.error("ordersShippingHandler error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point. The optional third argument is test injection
// only (Vercel never passes it).
module.exports = async function handler(req, res, deps) {
  await shippingHandler(req, res, deps);
};
