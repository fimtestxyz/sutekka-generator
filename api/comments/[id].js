// PATCH / DELETE /api/comments/[id]
//
// Author-only: only the user who wrote the comment may edit or
// delete it (403 otherwise). Deleting a top-level comment also
// deletes its replies — the Comment self-relation is
// onDelete: Cascade in the schema.
"use strict";

const { getPrisma } = require("../_lib/prisma");
const { requireUser } = require("../_lib/require-user");
const { cleanContent, publicComment, authorInclude } = require("../_lib/comments");
const {
  sendJson,
  methodNotAllowed,
  dbAvailable,
  readJsonBody,
  getPathSegments,
} = require("../_lib/http");

const MAX_CONTENT = 1000;

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any, sessionDeps?: object }} [deps] test injection only
 */
async function commentHandler(req, res, deps = {}) {
  try {
    if (req.method !== "PATCH" && req.method !== "DELETE") {
      methodNotAllowed(res, ["PATCH", "DELETE"]);
      return;
    }
    if (!dbAvailable(res)) return;
    const segments = getPathSegments(req);
    const id = segments[2] || "";
    const uid = await requireUser(req, deps.sessionDeps);
    if (!uid) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const prisma = deps.prisma || getPrisma();
    const comment = await prisma.comment.findUnique({ where: { id } });
    if (!comment) {
      sendJson(res, 404, { error: "comment_not_found" });
      return;
    }
    if (comment.userId !== uid) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }

    if (req.method === "DELETE") {
      await prisma.comment.delete({ where: { id } });
      sendJson(res, 200, { ok: true });
      return;
    }

    // PATCH — edit content.
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    const errors = [];
    let content = "";
    if (!body || typeof body !== "object" || typeof body.content !== "string") {
      errors.push("content must be a string");
    } else {
      content = cleanContent(body.content.trim());
      if (!content) errors.push("content must not be empty");
      else if (content.length > MAX_CONTENT) errors.push(`content must be at most ${MAX_CONTENT} characters`);
    }
    if (errors.length > 0) {
      sendJson(res, 400, { error: "invalid_body", details: errors });
      return;
    }
    const row = await prisma.comment.update({
      where: { id },
      data: { content },
      include: authorInclude,
    });
    sendJson(res, 200, { comment: publicComment(row) });
  } catch (e) {
    console.error("commentHandler error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point. The optional third argument is test injection
// only (Vercel never passes it); see commentHandler's deps.
module.exports = async function handler(req, res, deps) {
  await commentHandler(req, res, deps);
};
