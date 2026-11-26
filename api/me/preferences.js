// GET / PUT /api/me/preferences
//
// Preferences are weighted keywords (PLAN_AUTH_DB.md §4.2:
// UserPreference is one row per keyword, unique per user, with a
// weight that defaults to 1). There is no lang/notify row in the
// schema — the site's language toggle stays a local UI state.
//
// GET returns the user's keywords ordered by weight desc, then
// keyword asc. PUT replaces the whole set in one transaction:
//   { "keywords": [{ "keyword": "AI", "weight": 1.5 }, ...] }
// Validation (inline here; replaced by Zod schemas in Phase 7):
//   keywords: array, at most 50 entries; each keyword a string of
//   1–40 chars after trim; each weight a number 0–2 (default 1).
//   Duplicate keywords (after trim) collapse, last one wins.
//   An empty array clears all preferences.
"use strict";

const { getPrisma } = require("../_lib/prisma");
const { requireUser } = require("../_lib/require-user");
const { sendJson, methodNotAllowed, dbAvailable, readJsonBody } = require("../_lib/http");

const MAX_KEYWORDS = 50;

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any, sessionDeps?: object }} [deps] test injection only
 */
async function preferencesHandler(req, res, deps = {}) {
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
      const rows = await prisma.userPreference.findMany({
        where: { userId: uid },
        orderBy: [{ weight: "desc" }, { keyword: "asc" }],
      });
      sendJson(res, 200, {
        keywords: rows.map((r) => ({ keyword: r.keyword, weight: r.weight })),
      });
      return;
    }

    // PUT
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    const errors = [];
    if (!body || typeof body !== "object" || !Array.isArray(body.keywords)) {
      errors.push("keywords must be an array");
    }
    /** @type {Map<string, number>} */
    const byKeyword = new Map();
    if (Array.isArray(body && body.keywords)) {
      if (body.keywords.length > MAX_KEYWORDS) {
        errors.push(`at most ${MAX_KEYWORDS} keywords`);
      }
      for (const item of body.keywords) {
        if (!item || typeof item !== "object" || typeof item.keyword !== "string") {
          errors.push("each keyword entry needs a keyword string");
          continue;
        }
        const keyword = item.keyword.trim();
        if (!keyword || keyword.length > 40) {
          errors.push("each keyword must be 1–40 characters");
          continue;
        }
        let weight = 1;
        if (item.weight !== undefined) {
          if (typeof item.weight !== "number" || Number.isNaN(item.weight) || item.weight < 0 || item.weight > 2) {
            errors.push(`weight for "${keyword}" must be a number 0–2`);
            continue;
          }
          weight = item.weight;
        }
        byKeyword.set(keyword, weight);
      }
    }
    if (errors.length > 0) {
      sendJson(res, 400, { error: "invalid_body", details: errors });
      return;
    }
    const keywords = [...byKeyword.entries()].map(([keyword, weight]) => ({ keyword, weight }));
    const ops = [prisma.userPreference.deleteMany({ where: { userId: uid } })];
    if (keywords.length > 0) {
      ops.push(
        prisma.userPreference.createMany({
          data: keywords.map((k) => ({ userId: uid, keyword: k.keyword, weight: k.weight })),
        }),
      );
    }
    await prisma.$transaction(ops);
    sendJson(res, 200, { keywords });
  } catch (e) {
    console.error("preferencesHandler error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point. The optional third argument is test injection
// only (Vercel never passes it); see preferencesHandler's deps.
module.exports = async function handler(req, res, deps) {
  await preferencesHandler(req, res, deps);
};
