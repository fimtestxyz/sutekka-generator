// GET / PUT /api/me/cart
//
// Server-synced cart (CART_SYNC.md): the signed-in user's cart
// lives in the database as one CartItem row per line, so the cart
// (and its navbar count) follows the account across devices. The
// local cart in localStorage stays the fallback — a failed sync
// never wipes it.
//
// GET lists the user's stored lines, most recently updated first.
// PUT replaces the stored cart with the client's full cart: lines
// present in the request are upserted, stored lines absent from
// the request are deleted, and the stored cart is returned.
// Validation is per line, not all-or-nothing: an unknown itemId
// (or a known id with the wrong type) is dropped, and qty is
// clamped to 1–99 — a bad line never rejects the whole cart.
// Sign-in required for everything.
"use strict";

const { getPrisma } = require("./prisma");
const { requireUser } = require("./require-user");
const { checkRateLimit } = require("./rate-limit");
const PAYMENT_LINK_MAP = require("./payment-link-map");
const {
  sendJson,
  methodNotAllowed,
  dbAvailable,
  readJsonBody,
} = require("./http");

// Known shop items, from the generated payment-link map (the same
// catalogue the checkout resolves against): "type:itemId".
const KNOWN_ITEMS = new Set(
  Object.values(PAYMENT_LINK_MAP).map((e) => e.type + ":" + e.itemId),
);

const CART_TYPES = ["single", "set", "pack"];
const MAX_QTY = 99;

function clampQty(q) {
  const n = parseInt(q, 10);
  if (!n || Number.isNaN(n)) return 1;
  return Math.max(1, Math.min(MAX_QTY, n));
}

// Validate one client cart line. Returns the normalised line, or
// null when the line is not a known shop item (dropped, not an
// error — the rest of the cart still syncs).
function normaliseLine(raw) {
  if (!raw || typeof raw !== "object") return null;
  const itemId = typeof raw.itemId === "string" ? raw.itemId.trim() : "";
  if (!itemId || itemId.length > 100) return null;
  if (CART_TYPES.indexOf(raw.type) === -1) return null;
  if (!KNOWN_ITEMS.has(raw.type + ":" + itemId)) return null;
  return { itemId, type: raw.type, qty: clampQty(raw.qty) };
}

// Dedupe by (itemId, type), last occurrence wins — the client
// never sends dupes; this is only defensive.
function normaliseCart(items) {
  const byKey = new Map();
  for (const raw of items) {
    const line = normaliseLine(raw);
    if (line) byKey.set(line.type + ":" + line.itemId, line);
  }
  return Array.from(byKey.values());
}

function publicCartItem(row) {
  return { itemId: row.itemId, type: row.type, qty: row.qty };
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any, sessionDeps?: object }} [deps] test injection only
 */
async function cartHandler(req, res, deps = {}) {
  try {
    if (req.method !== "GET" && req.method !== "PUT") {
      methodNotAllowed(res, ["GET", "PUT"]);
      return;
    }
    if (!dbAvailable(res)) return;
    const uid = await requireUser(req, deps.sessionDeps);
    if (!uid) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const prisma = deps.prisma || getPrisma();

    if (req.method === "GET") {
      const rows = await prisma.cartItem.findMany({
        where: { userId: uid },
        orderBy: { updatedAt: "desc" },
      });
      sendJson(res, 200, { items: rows.map(publicCartItem) });
      return;
    }

    // PUT — replace the stored cart with the client's full cart.
    // Generous per-user limit: the client debounces to ~500 ms, so
    // normal use is a handful of PUTs per minute; the limit only
    // stops a runaway client.
    if (!checkRateLimit("cart:" + uid, 30, 60_000)) {
      sendJson(res, 429, { error: "rate_limited" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    if (!body || !Array.isArray(body.items)) {
      sendJson(res, 400, { error: "invalid_body", details: ["items must be an array"] });
      return;
    }
    const wanted = normaliseCart(body.items);
    const wantedKeys = new Set(wanted.map((l) => l.type + ":" + l.itemId));

    const existing = await prisma.cartItem.findMany({ where: { userId: uid } });
    const stale = existing.filter((r) => !wantedKeys.has(r.type + ":" + r.itemId));
    if (stale.length) {
      await prisma.cartItem.deleteMany({
        where: { userId: uid, id: { in: stale.map((r) => r.id) } },
      });
    }
    for (const line of wanted) {
      await prisma.cartItem.upsert({
        where: { userId_itemId_type: { userId: uid, itemId: line.itemId, type: line.type } },
        update: { qty: line.qty },
        create: { userId: uid, itemId: line.itemId, type: line.type, qty: line.qty },
      });
    }
    const rows = await prisma.cartItem.findMany({
      where: { userId: uid },
      orderBy: { updatedAt: "desc" },
    });
    sendJson(res, 200, { items: rows.map(publicCartItem) });
  } catch (e) {
    console.error("cartHandler error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point. The optional third argument is test injection
// only (Vercel never passes it); see cartHandler's deps.
module.exports = async function handler(req, res, deps) {
  await cartHandler(req, res, deps);
};
