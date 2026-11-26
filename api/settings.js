// GET /api/settings — public site settings the storefront reads
// (ADMIN.md §4.7): whether the shop is closed, the announcement
// banner, and which items' Buy buttons are hidden. Written only by
// the admin (POST /api/admin/settings). No sign-in needed to read.
"use strict";

const { getPrisma } = require("./_lib/prisma");
const { sendJson, methodNotAllowed, dbAvailable } = require("./_lib/http");

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any }} [deps] test injection only
 */
async function settingsHandler(req, res, deps = {}) {
  try {
    if (req.method !== "GET") {
      methodNotAllowed(res, ["GET"]);
      return;
    }
    if (!dbAvailable(res)) return;
    const prisma = deps.prisma || getPrisma();
    const rows = await prisma.siteSetting.findMany();
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    sendJson(res, 200, {
      shopClosed: map.shop_closed === "true",
      announcement: map.announcement || "",
      hiddenItems: map.hidden_items ? JSON.parse(map.hidden_items) : [],
      uploadsEnabled: map.uploads_enabled === "true",
    });
  } catch (e) {
    console.error("settingsHandler error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point. The optional third argument is test injection
// only (Vercel never passes it).
module.exports = async function handler(req, res, deps) {
  await settingsHandler(req, res, deps);
};
