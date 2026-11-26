// Orders router (catch-all api/orders/[...order].js).
//
// One Vercel Serverless Function for the three buyer order routes —
// the Hobby plan allows 12 functions per deployment, and one file
// per route would have pushed this project over it (see AGENTS.md).
// The implementations live in api/_lib/order-*.js; the URLs are
// unchanged, so the storefront and the tests call them as before.
//
//   GET / POST /api/orders/lookup          — tracked-order lookup
//   POST /api/orders/shipping             — buyer shipping address
//   POST /api/orders/invoice-request      — buyer invoice request
//   POST /api/orders/checkout             — cart → Stripe Checkout Session
"use strict";

const { sendJson } = require("../_lib/http");
const { getPathSegments } = require("../_lib/http");
const lookupHandler = require("../_lib/order-lookup");
const shippingHandler = require("../_lib/order-shipping");
const invoiceRequestHandler = require("../_lib/order-invoice-request");
const checkoutHandler = require("../_lib/order-checkout");

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any }} [deps] test injection only
 */
async function orderRouter(req, res, deps = {}) {
  try {
    const segments = getPathSegments(req);
    // ["api", "orders", <route>]
    const route = segments[2] || "";
    if (route === "lookup") {
      await lookupHandler(req, res, deps);
      return;
    }
    if (route === "shipping") {
      await shippingHandler(req, res, deps);
      return;
    }
    if (route === "invoice-request") {
      await invoiceRequestHandler(req, res, deps);
      return;
    }
    if (route === "checkout") {
      await checkoutHandler(req, res, deps);
      return;
    }
    sendJson(res, 404, { error: "order_route_not_found" });
  } catch (e) {
    console.error("orderRouter error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point (catch-all api/orders/[...order].js). The
// optional third argument is test injection only (Vercel never
// passes it).
module.exports = async function handler(req, res, deps) {
  await orderRouter(req, res, deps);
};
