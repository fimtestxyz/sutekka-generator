// GET / POST /api/orders/lookup — tracked-order lookup for buyers.
//
// No sign-in is needed to buy, so none is needed to look an order up:
// possession of the session id (from the download link in the success
// URL) or the order id is the credential. An email lookup lists that
// email's orders — the caller supplies the email, so nothing new is
// disclosed beyond what they already know.
//
// GET ?session_id=cs_... | ?order_id=<cuid> | ?email=<email>
// POST { session_id } marks that order delivered (called by the download
// page once the files are shown).
"use strict";

const { getPrisma } = require("../_lib/prisma");
const {
  sendJson,
  methodNotAllowed,
  dbAvailable,
  readJsonBody,
  getQuery,
} = require("../_lib/http");

function publicOrder(row) {
  return {
    id: row.id,
    itemId: row.itemId,
    itemType: row.itemType,
    amountTotal: row.amountTotal,
    currency: row.currency,
    status: row.status,
    createdAt: row.createdAt,
  };
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any }} [deps] test injection only
 */
async function lookupHandler(req, res, deps = {}) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      methodNotAllowed(res, ["GET", "POST"]);
      return;
    }
    if (!dbAvailable(res)) return;
    const prisma = deps.prisma || getPrisma();

    if (req.method === "POST") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      const sessionId = body && body.session_id;
      if (!sessionId || typeof sessionId !== "string") {
        sendJson(res, 400, {
          error: "invalid_body",
          details: ["session_id is required"],
        });
        return;
      }
      const row = await prisma.order.updateMany({
        where: { stripeSessionId: sessionId, status: "paid" },
        data: { status: "delivered" },
      });
      if (row.count === 0) {
        const exists = await prisma.order.findUnique({
          where: { stripeSessionId: sessionId },
        });
        if (!exists) {
          sendJson(res, 404, { error: "order_not_found" });
          return;
        }
      }
      const updated = await prisma.order.findUnique({
        where: { stripeSessionId: sessionId },
      });
      sendJson(res, 200, { order: updated ? publicOrder(updated) : null });
      return;
    }

    const query = getQuery(req);
    const sessionId = query.get("session_id");
    const orderId = query.get("order_id");
    const email = query.get("email");
    if (sessionId) {
      const row = await prisma.order.findUnique({
        where: { stripeSessionId: sessionId },
      });
      if (!row) {
        sendJson(res, 404, { error: "order_not_found" });
        return;
      }
      sendJson(res, 200, { order: publicOrder(row) });
      return;
    }
    if (orderId) {
      const row = await prisma.order.findUnique({ where: { id: orderId } });
      if (!row) {
        sendJson(res, 404, { error: "order_not_found" });
        return;
      }
      sendJson(res, 200, { order: publicOrder(row) });
      return;
    }
    if (email) {
      if (!email.includes("@") || email.length > 254) {
        sendJson(res, 400, {
          error: "invalid_body",
          details: ["email must be a valid email address"],
        });
        return;
      }
      const rows = await prisma.order.findMany({
        where: { buyerEmail: email },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      sendJson(res, 200, { orders: rows.map(publicOrder) });
      return;
    }
    sendJson(res, 400, {
      error: "invalid_body",
      details: ["one of session_id, order_id or email is required"],
    });
  } catch (e) {
    console.error("ordersLookupHandler error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point. The optional third argument is test injection
// only (Vercel never passes it); see lookupHandler's deps.
module.exports = async function handler(req, res, deps) {
  await lookupHandler(req, res, deps);
};
