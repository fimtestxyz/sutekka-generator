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

module.exports = { sendJson, methodNotAllowed, dbAvailable, readJsonBody };
