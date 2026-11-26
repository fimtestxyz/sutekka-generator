// GET / PATCH /api/me/profile
//
// GET returns the signed-in user's Auth.js identity plus their
// UserProfile row (null when they have never saved one).
// PATCH edits User.name and/or the profile's bio + customAvatar
// (PLAN_AUTH_DB.md §4.2: UserProfile has no displayName of its
// own — the display name IS User.name).
//
// Validation (inline here; replaced by Zod schemas in Phase 7):
//   name:         optional, string, 1–100 chars after trim
//   bio:          optional, string, ≤ 280 chars (empty clears it)
//   customAvatar: optional, string, empty clears it, otherwise an
//                 https:// URL ≤ 2048 chars (http would be mixed
//                 content on the https site)
// At least one of the three must be present.
"use strict";

const { getPrisma } = require("./prisma");
const { requireUser } = require("./require-user");
const { sendJson, methodNotAllowed, dbAvailable, readJsonBody } = require("./http");
const { profilePatchSchema, parseBody } = require("./schemas");

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, image: user.image };
}

function publicProfile(profile) {
  return profile ? { customAvatar: profile.customAvatar, bio: profile.bio } : null;
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any, sessionDeps?: object }} [deps] test injection only
 */
async function profileHandler(req, res, deps = {}) {
  try {
    if (req.method !== "GET" && req.method !== "PATCH") {
      methodNotAllowed(res, ["GET", "PATCH"]);
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
      const user = await prisma.user.findUnique({ where: { id: uid } });
      if (!user) {
        sendJson(res, 404, { error: "user_not_found" });
        return;
      }
      const profile = await prisma.userProfile.findUnique({ where: { userId: uid } });
      sendJson(res, 200, { user: publicUser(user), profile: publicProfile(profile) });
      return;
    }

    // PATCH
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { error: "invalid_body", details: ["body must be a JSON object"] });
      return;
    }
    const parsed = parseBody(profilePatchSchema, body);
    if (!parsed.ok) {
      sendJson(res, 400, { error: "invalid_body", details: parsed.details });
      return;
    }
    const { name } = parsed.data;
    // Empty string clears the field; an absent field leaves it alone.
    /** @type {string | null | undefined} */
    const bio = parsed.data.bio === undefined ? undefined : parsed.data.bio || null;
    /** @type {string | null | undefined} */
    const customAvatar =
      parsed.data.customAvatar === undefined ? undefined : parsed.data.customAvatar || null;
    if (name === undefined && bio === undefined && customAvatar === undefined) {
      sendJson(res, 400, {
        error: "invalid_body",
        details: ["nothing to update: send name, bio and/or customAvatar"],
      });
      return;
    }

    let user = null;
    if (name !== undefined) {
      user = await prisma.user.update({ where: { id: uid }, data: { name } });
    }
    let profile = null;
    if (bio !== undefined || customAvatar !== undefined) {
      profile = await prisma.userProfile.upsert({
        where: { userId: uid },
        update: {
          ...(bio !== undefined ? { bio } : {}),
          ...(customAvatar !== undefined ? { customAvatar } : {}),
        },
        create: {
          userId: uid,
          bio: bio === undefined ? null : bio,
          customAvatar: customAvatar === undefined ? null : customAvatar,
        },
      });
    } else {
      profile = await prisma.userProfile.findUnique({ where: { userId: uid } });
    }
    if (!user) {
      user = await prisma.user.findUnique({ where: { id: uid } });
    }
    if (!user) {
      sendJson(res, 404, { error: "user_not_found" });
      return;
    }
    sendJson(res, 200, { user: publicUser(user), profile: publicProfile(profile) });
  } catch (e) {
    console.error("profileHandler error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point. The optional third argument is test injection
// only (Vercel never passes it); see profileHandler's deps.
module.exports = async function handler(req, res, deps) {
  await profileHandler(req, res, deps);
};
