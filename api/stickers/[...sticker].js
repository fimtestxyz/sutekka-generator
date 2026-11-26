// Stickers router (catch-all api/stickers/[...sticker].js).
//
// One Vercel Serverless Function for the two per-set engagement
// routes — the Hobby plan allows 12 functions per deployment, and
// one file per route would have pushed this project over it (see
// AGENTS.md). The implementations live in api/_lib/sticker-*.js;
// the URLs are unchanged, and the handlers still read the sticker
// id from path segment [2], exactly as before.
//
//   GET / POST /api/stickers/<id>/like
//   GET / POST /api/stickers/<id>/comments
"use strict";

const { sendJson } = require("../_lib/http");
const { getPathSegments } = require("../_lib/http");
const likeHandler = require("../_lib/sticker-like");
const commentsHandler = require("../_lib/sticker-comments");

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any, sessionDeps?: any }} [deps] test injection only
 */
async function stickerRouter(req, res, deps = {}) {
  try {
    const segments = getPathSegments(req);
    // ["api", "stickers", <id>, <route>]
    const route = segments[3] || "";
    if (route === "like") {
      await likeHandler(req, res, deps);
      return;
    }
    if (route === "comments") {
      await commentsHandler(req, res, deps);
      return;
    }
    sendJson(res, 404, { error: "sticker_route_not_found" });
  } catch (e) {
    console.error("stickerRouter error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point (catch-all api/stickers/[...sticker].js). The
// optional third argument is test injection only (Vercel never
// passes it).
module.exports = async function handler(req, res, deps) {
  await stickerRouter(req, res, deps);
};
