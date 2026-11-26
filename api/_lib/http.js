// Shared helpers for the JSON API handlers (profile, preferences,
// likes, comments, bookmarks). Phase 7 adds Zod schemas on top of
// these; the inline checks in each handler stay as the first line
// of defence and are replaced by the schemas there.
"use strict";

const { isConfigured } = require("./prisma");

/** Send a JSON response. */
function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

/** 405 with an Allow header. */
function methodNotAllowed(res, allowed) {
  res.setHeader("Allow", allowed.join(", "));
  sendJson(res, 405, { error: "method_not_allowed" });
}

/**
 * True when a database is configured; otherwise answers
 * 503 db_not_configured and returns false.
 */
function dbAvailable(res) {
  if (isConfigured()) return true;
  sendJson(res, 503, { error: "db_not_configured" });
  return false;
}

/**
 * Read and parse a JSON request body. Returns {} for an empty body.
 * Throws SyntaxError on malformed JSON — callers answer 400.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {Promise<any>}
 */
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

/**
 * URL path segments of a request (query string stripped, each
 * segment decoded). For /api/stickers/<id>/like this returns
 * ["api", "stickers", "<id>", "like"]. Handlers resolve dynamic
 * route params from here rather than depending on Vercel's
 * req.query injection, so the same code works in tests.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {string[]}
 */
function getPathSegments(req) {
  const path = (req.url || "/").split("?")[0];
  return path
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch (e) {
        return s;
      }
    });
}

/**
 * Query params of a request as URLSearchParams.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {URLSearchParams}
 */
function getQuery(req) {
  return new URL(req.url || "/", "http://localhost").searchParams;
}

module.exports = { sendJson, methodNotAllowed, dbAvailable, readJsonBody, getPathSegments, getQuery };
