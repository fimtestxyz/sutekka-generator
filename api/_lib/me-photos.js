// GET / POST / DELETE /api/me/photos
//
// Personal gallery: the signed-in user's own photos only —
// nobody else's photos are ever listed here.
//
// The image bytes live in Vercel Blob; Neon stores only the
// metadata row (url + pathname, so a delete can remove the Blob
// object too). Bytes in Postgres would eat the database's storage
// in a few hundred photos and slow everything else down.
//
// POST uploads one image: the client sends the raw file bytes as
// the request body (Content-Type: image/*, X-Filename header) —
// no multipart parser, no base64 bloat. Limits: 4 MB per photo
// (Vercel caps function request bodies at 4.5 MB on Hobby),
// 20 photos per user, images only. Uploads also need the admin's
// uploads_enabled setting AND a Blob token (BLOB_READ_WRITE_TOKEN
// — created by connecting a Blob store to the project in the
// Vercel dashboard); without the setting it answers 503
// uploads_disabled, without the token 503 uploads_not_configured.
// DELETE removes one photo (?id=...) or the whole gallery
// (?scope=all); the Blob object and the row are both removed.
// Sign-in required for everything.
"use strict";

const { put, del } = require("@vercel/blob");
const { getPrisma } = require("./prisma");
const { requireUser } = require("./require-user");
const {
  sendJson,
  methodNotAllowed,
  dbAvailable,
  readRawBody,
  getQuery,
} = require("./http");

const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const MAX_PHOTOS_PER_USER = 20;
const ALLOWED_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function publicPhoto(row) {
  return {
    id: row.id,
    url: row.url,
    filename: row.filename,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}

// The filename is never trusted as a path: strip directories and
// odd characters, cap the length, and take the extension from the
// verified content type (the bytes are what matter).
function sanitizeFilename(raw, contentType) {
  const ext = ALLOWED_TYPES[contentType] || "bin";
  const base = String(raw || "photo")
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]*$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return (base || "photo") + "." + ext;
}

async function uploadsEnabled(prisma) {
  const row = await prisma.siteSetting.findUnique({ where: { key: "uploads_enabled" } });
  return row ? row.value === "true" : false;
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any, sessionDeps?: object, blob?: { put: any, del: any } }} [deps] test injection only
 */
async function photosHandler(req, res, deps = {}) {
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
    const blob = deps.blob || { put, del };

    if (req.method === "GET") {
      const rows = await prisma.photo.findMany({
        where: { userId: uid },
        orderBy: { createdAt: "desc" },
      });
      sendJson(res, 200, { photos: rows.map(publicPhoto) });
      return;
    }

    if (req.method === "POST") {
      if (!(await uploadsEnabled(prisma))) {
        sendJson(res, 503, { error: "uploads_disabled" });
        return;
      }
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        sendJson(res, 503, { error: "uploads_not_configured" });
        return;
      }
      const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (!ALLOWED_TYPES[contentType]) {
        sendJson(res, 400, { error: "invalid_body", details: ["photo must be a JPEG, PNG, WebP or GIF image"] });
        return;
      }
      const count = await prisma.photo.count({ where: { userId: uid } });
      if (count >= MAX_PHOTOS_PER_USER) {
        sendJson(res, 400, { error: "photo_limit_reached", details: ["at most " + MAX_PHOTOS_PER_USER + " photos per user"] });
        return;
      }
      let body;
      try {
        body = await readRawBody(req, MAX_PHOTO_BYTES);
      } catch (e) {
        if (e && e.code === "BODY_TOO_LARGE") {
          sendJson(res, 413, { error: "photo_too_large", details: ["at most 4 MB per photo"] });
          return;
        }
        throw e;
      }
      if (!body.length) {
        sendJson(res, 400, { error: "invalid_body", details: ["empty photo"] });
        return;
      }
      const filename = sanitizeFilename(req.headers["x-filename"], contentType);
      const pathname = "photos/" + uid + "/" + Date.now() + "-" + filename;
      let stored;
      try {
        stored = await blob.put(pathname, body, { access: "public", contentType });
      } catch (e) {
        console.error("photosHandler blob put error", e);
        sendJson(res, 503, { error: "uploads_not_configured" });
        return;
      }
      const row = await prisma.photo.create({
        data: {
          userId: uid,
          url: stored.url,
          pathname: stored.pathname,
          filename,
          sizeBytes: body.length,
        },
      });
      sendJson(res, 201, { photo: publicPhoto(row) });
      return;
    }

    // DELETE
    const query = getQuery(req);
    const scope = query.get("scope");
    if (scope === "all") {
      const rows = await prisma.photo.findMany({
        where: { userId: uid },
        select: { id: true, url: true },
      });
      await Promise.all(rows.map((r) => blob.del(r.url).catch(() => {})));
      await prisma.photo.deleteMany({ where: { userId: uid } });
      sendJson(res, 200, { ok: true, removed: rows.length });
      return;
    }
    const id = query.get("id");
    if (!id) {
      sendJson(res, 400, { error: "invalid_body", details: ["id query param or scope=all is required"] });
      return;
    }
    const row = await prisma.photo.findFirst({ where: { id, userId: uid } });
    if (!row) {
      sendJson(res, 404, { error: "photo_not_found" });
      return;
    }
    await blob.del(row.url).catch(() => {});
    await prisma.photo.delete({ where: { id: row.id } });
    sendJson(res, 200, { ok: true });
  } catch (e) {
    console.error("photosHandler error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point. The optional third argument is test injection
// only (Vercel never passes it); see photosHandler's deps.
module.exports = async function handler(req, res, deps) {
  await photosHandler(req, res, deps);
};
