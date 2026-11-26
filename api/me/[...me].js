// "Me" router (catch-all api/me/[...me].js).
//
// One Vercel Serverless Function for the four signed-in-user routes
// — the Hobby plan allows 12 functions per deployment, and one file
// per route would have pushed this project over it (see AGENTS.md).
// The implementations live in api/_lib/me-*.js; the URLs are
// unchanged.
//
//   GET / POST / DELETE /api/me/bookmarks
//   GET / POST / DELETE /api/me/photos
//   GET / PUT /api/me/preferences
//   GET / PATCH /api/me/profile
"use strict";

const { sendJson } = require("../_lib/http");
const { getPathSegments } = require("../_lib/http");
const bookmarksHandler = require("../_lib/me-bookmarks");
const photosHandler = require("../_lib/me-photos");
const preferencesHandler = require("../_lib/me-preferences");
const profileHandler = require("../_lib/me-profile");

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any, sessionDeps?: any }} [deps] test injection only
 */
async function meRouter(req, res, deps = {}) {
  try {
    const segments = getPathSegments(req);
    // ["api", "me", <route>]
    const route = segments[2] || "";
    if (route === "bookmarks") {
      await bookmarksHandler(req, res, deps);
      return;
    }
    if (route === "photos") {
      await photosHandler(req, res, deps);
      return;
    }
    if (route === "preferences") {
      await preferencesHandler(req, res, deps);
      return;
    }
    if (route === "profile") {
      await profileHandler(req, res, deps);
      return;
    }
    sendJson(res, 404, { error: "me_route_not_found" });
  } catch (e) {
    console.error("meRouter error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point (catch-all api/me/[...me].js). The optional
// third argument is test injection only (Vercel never passes it).
module.exports = async function handler(req, res, deps) {
  await meRouter(req, res, deps);
};
