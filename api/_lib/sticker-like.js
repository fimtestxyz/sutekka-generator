// GET / POST /api/stickers/[id]/like
//
// GET returns the like count and whether the signed-in user likes
// this set ({ likes, liked }); signed-out callers get liked: false.
// POST toggles the signed-in user's like and returns the new state.
//
// The toggle is: delete when a like exists, create when it does
// not. Two concurrent creates race on the @@unique([userId,
// stickerId]) key — the loser gets P2002, which is treated as
// liked (the like exists now), not as an error.
"use strict";

const { getPrisma } = require("./prisma");
const { requireUser } = require("./require-user");
const { findSticker } = require("./stickers");
const {
  sendJson,
  methodNotAllowed,
  dbAvailable,
  getPathSegments,
} = require("./http");

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any, sessionDeps?: object }} [deps] test injection only
 */
async function likeHandler(req, res, deps = {}) {
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
    const likeWhere = (uid) => ({
      userId_stickerId: { userId: uid, stickerId: sticker.id },
    });

    if (req.method === "GET") {
      const uid = await requireUser(req, deps.sessionDeps);
      let liked = false;
      if (uid) {
        liked = Boolean(await prisma.like.findUnique({ where: likeWhere(uid) }));
      }
      const likes = await prisma.like.count({ where: { stickerId: sticker.id } });
      sendJson(res, 200, { liked, likes, sticker: { id: sticker.id, slug: sticker.slug } });
      return;
    }

    // POST — toggle, sign-in required.
    const uid = await requireUser(req, deps.sessionDeps);
    if (!uid) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const existing = await prisma.like.findUnique({ where: likeWhere(uid) });
    let liked;
    if (existing) {
      await prisma.like.delete({ where: likeWhere(uid) });
      liked = false;
    } else {
      try {
        await prisma.like.create({ data: { userId: uid, stickerId: sticker.id } });
        liked = true;
      } catch (e) {
        if (e && e.code === "P2002") {
          liked = true; // raced with another create; the like exists
        } else {
          throw e;
        }
      }
    }
    const likes = await prisma.like.count({ where: { stickerId: sticker.id } });
    sendJson(res, 200, { liked, likes, sticker: { id: sticker.id, slug: sticker.slug } });
  } catch (e) {
    console.error("likeHandler error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point. The optional third argument is test injection
// only (Vercel never passes it); see likeHandler's deps.
module.exports = async function handler(req, res, deps) {
  await likeHandler(req, res, deps);
};
