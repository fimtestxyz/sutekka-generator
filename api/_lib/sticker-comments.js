// GET / POST /api/stickers/[id]/comments
//
// GET lists the set's top-level comments, oldest first, each with
// its 1-level replies (also oldest first). Works signed out.
// POST creates a top-level comment, or a reply when parentId is
// given. Replies are one level only: replying to a reply is a
// 400, and the parent must belong to the same sticker.
//
// POST is rate-limited to 10 comments/minute per user (in-memory,
// best-effort — see api/_lib/rate-limit.js). Content is capped at
// 1000 chars (the Comment.content column) and stripped of < >
// on write (see api/_lib/comments.js).
"use strict";

const { getPrisma } = require("./prisma");
const { requireUser } = require("./require-user");
const { findSticker } = require("./stickers");
const { checkRateLimit } = require("./rate-limit");
const { cleanContent, publicComment, authorInclude } = require("./comments");
const { commentCreateSchema, parseBody } = require("./schemas");
const {
  sendJson,
  methodNotAllowed,
  dbAvailable,
  readJsonBody,
  getPathSegments,
} = require("./http");

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any, sessionDeps?: object }} [deps] test injection only
 */
async function commentsHandler(req, res, deps = {}) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      methodNotAllowed(res, ["GET", "POST"]);
      return;
    }
    if (!dbAvailable(res)) return;
    const segments = getPathSegments(req);
    const id = segments[2] || "";
    const prisma = deps.prisma || getPrisma();
    const sticker = await findSticker(prisma, id);
    if (!sticker) {
      sendJson(res, 404, { error: "sticker_not_found" });
      return;
    }

    if (req.method === "GET") {
      const rows = await prisma.comment.findMany({
        where: { stickerId: sticker.id, parentId: null },
        orderBy: { createdAt: "asc" },
        include: {
          ...authorInclude,
          replies: {
            orderBy: { createdAt: "asc" },
            include: authorInclude,
          },
        },
      });
      sendJson(res, 200, { comments: rows.map(publicComment) });
      return;
    }

    // POST — sign-in required.
    const uid = await requireUser(req, deps.sessionDeps);
    if (!uid) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    const parsed = parseBody(commentCreateSchema, body);
    if (!parsed.ok) {
      sendJson(res, 400, { error: "invalid_body", details: parsed.details });
      return;
    }
    // Strip < > on write (engage.js parity); an all-bracket
    // comment is empty after cleaning.
    const content = cleanContent(parsed.data.content);
    if (!content) {
      sendJson(res, 400, { error: "invalid_body", details: ["content must not be empty"] });
      return;
    }
    const parentId = parsed.data.parentId ?? null;
    if (!checkRateLimit(`comment:${uid}`)) {
      sendJson(res, 429, { error: "rate_limited" });
      return;
    }
    if (parentId) {
      const parent = await prisma.comment.findUnique({ where: { id: parentId } });
      if (!parent || parent.stickerId !== sticker.id) {
        sendJson(res, 400, {
          error: "invalid_body",
          details: ["parent comment not found on this sticker"],
        });
        return;
      }
      if (parent.parentId !== null) {
        sendJson(res, 400, {
          error: "invalid_body",
          details: ["replies can only be one level deep"],
        });
        return;
      }
    }
    const row = await prisma.comment.create({
      data: { userId: uid, stickerId: sticker.id, parentId, content },
      include: authorInclude,
    });
    sendJson(res, 201, { comment: publicComment(row) });
  } catch (e) {
    console.error("commentsHandler error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point. The optional third argument is test injection
// only (Vercel never passes it); see commentsHandler's deps.
module.exports = async function handler(req, res, deps) {
  await commentsHandler(req, res, deps);
};
