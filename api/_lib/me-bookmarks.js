// GET / POST / DELETE /api/me/bookmarks
//
// GET lists the signed-in user's bookmarks, with the sticker
// attached to each row. ?sort=recent (default, newest first) |
// oldest | title (A–Z by set title). With ?stickerId=<slug-or-
// cuid> it answers the single-set state instead: { bookmarked,
// bookmark? } — that is what the reader's bookmark button reads.
// POST adds a bookmark { stickerId }; creating one that already
// exists is a 200, not an error (P2002 → return the existing row).
// DELETE removes it: DELETE /api/me/bookmarks?stickerId=<...>.
// DELETE with ?scope=sets|stickers|all clears a whole shelf at
// once — sets are whole-set bookmarks, stickers are individually
// collected stickers (slug ends in -NN); `all` clears both.
// Answers { ok: true, removed: <count> }. Sign-in required for
// everything.
"use strict";

const { getPrisma } = require("./prisma");
const { requireUser } = require("./require-user");
const { findSticker } = require("./stickers");
const { bookmarkCreateSchema, parseBody } = require("./schemas");
const {
  sendJson,
  methodNotAllowed,
  dbAvailable,
  readJsonBody,
  getQuery,
} = require("./http");

const SORTS = {
  recent: { createdAt: "desc" },
  oldest: { createdAt: "asc" },
  title: { sticker: { title: "asc" } },
};

const stickerSelect = { id: true, slug: true, title: true, imageUrl: true };

function publicBookmark(row) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    sticker: {
      id: row.sticker.id,
      slug: row.sticker.slug,
      title: row.sticker.title,
      imageUrl: row.sticker.imageUrl,
    },
  };
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any, sessionDeps?: object }} [deps] test injection only
 */
async function bookmarksHandler(req, res, deps = {}) {
  try {
    if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
      methodNotAllowed(res, ["GET", "POST", "DELETE"]);
      return;
    }
    if (!dbAvailable(res)) return;
    const uid = await requireUser(req, deps.sessionDeps);
    if (!uid) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const prisma = deps.prisma || getPrisma();
    const query = getQuery(req);

    if (req.method === "GET") {
      const stickerId = query.get("stickerId");
      if (stickerId) {
        const sticker = await findSticker(prisma, stickerId);
        if (!sticker) {
          sendJson(res, 404, { error: "sticker_not_found" });
          return;
        }
        const row = await prisma.bookmark.findUnique({
          where: { userId_stickerId: { userId: uid, stickerId: sticker.id } },
          include: { sticker: { select: stickerSelect } },
        });
        sendJson(res, 200, { bookmarked: Boolean(row), bookmark: row ? publicBookmark(row) : null });
        return;
      }
      const sort = query.get("sort") || "recent";
      if (!SORTS[sort]) {
        sendJson(res, 400, { error: "invalid_sort", details: ["sort must be recent, oldest or title"] });
        return;
      }
      const rows = await prisma.bookmark.findMany({
        where: { userId: uid },
        orderBy: SORTS[sort],
        include: { sticker: { select: stickerSelect } },
      });
      sendJson(res, 200, { bookmarks: rows.map(publicBookmark) });
      return;
    }

    if (req.method === "POST") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      const parsed = parseBody(bookmarkCreateSchema, body);
      if (!parsed.ok) {
        sendJson(res, 400, { error: "invalid_body", details: parsed.details });
        return;
      }
      const sticker = await findSticker(prisma, parsed.data.stickerId);
      if (!sticker) {
        sendJson(res, 404, { error: "sticker_not_found" });
        return;
      }
      try {
        const row = await prisma.bookmark.create({
          data: { userId: uid, stickerId: sticker.id },
          include: { sticker: { select: stickerSelect } },
        });
        sendJson(res, 201, { bookmark: publicBookmark(row) });
      } catch (e) {
        if (e && e.code === "P2002") {
          const row = await prisma.bookmark.findUnique({
            where: { userId_stickerId: { userId: uid, stickerId: sticker.id } },
            include: { sticker: { select: stickerSelect } },
          });
          sendJson(res, 200, { bookmark: row ? publicBookmark(row) : null });
        } else {
          throw e;
        }
      }
      return;
    }

    // DELETE
    const scope = query.get("scope");
    if (scope) {
      if (scope !== "sets" && scope !== "stickers" && scope !== "all") {
        sendJson(res, 400, { error: "invalid_body", details: ["scope must be sets, stickers or all"] });
        return;
      }
      // Sets are whole-set bookmarks, stickers are individually
      // collected ones — the slug suffix (-NN) tells them apart.
      const isSticker = (slug) => /-\d{2}$/.test(slug);
      const rows = await prisma.bookmark.findMany({
        where: { userId: uid },
        include: { sticker: { select: { id: true, slug: true } } },
      });
      const targets = rows.filter(
        (r) => scope === "all" || (scope === "stickers" ? isSticker(r.sticker.slug) : !isSticker(r.sticker.slug)),
      );
      const ids = targets.map((r) => r.id);
      const result = ids.length
        ? await prisma.bookmark.deleteMany({ where: { userId: uid, id: { in: ids } } })
        : { count: 0 };
      sendJson(res, 200, { ok: true, removed: result.count });
      return;
    }
    const stickerId = query.get("stickerId");
    if (!stickerId) {
      sendJson(res, 400, { error: "invalid_body", details: ["stickerId query param is required"] });
      return;
    }
    const sticker = await findSticker(prisma, stickerId);
    if (!sticker) {
      sendJson(res, 404, { error: "sticker_not_found" });
      return;
    }
    await prisma.bookmark.deleteMany({ where: { userId: uid, stickerId: sticker.id } });
    sendJson(res, 200, { ok: true, bookmarked: false });
  } catch (e) {
    console.error("bookmarksHandler error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point. The optional third argument is test injection
// only (Vercel never passes it); see bookmarksHandler's deps.
module.exports = async function handler(req, res, deps) {
  await bookmarksHandler(req, res, deps);
};
