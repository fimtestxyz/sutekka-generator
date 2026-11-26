// Read the Auth.js session from a Vercel request's cookies.
//
// The session is a JWT (see api/_lib/auth.js), so this replays the
// request's cookie header against Auth.js's own /api/auth/session
// endpoint and returns the parsed session — or null when there is
// no session or auth is not configured. Handlers use this (via
// api/_lib/require-user.js) and never trust a client-sent userId.
"use strict";

const { isAuthConfigured, getAuthConfig, loadAuthCore, getRequestBaseUrl } = require("./auth");

/**
 * @param {import("http").IncomingMessage} req
 * @param {{ authFn?: Function, config?: object }} [deps] test injection only
 * @returns {Promise<{ user: { id: string, name?: string | null, email?: string | null, image?: string | null } } | null>}
 */
async function getSessionFromRequest(req, deps = {}) {
  if (!isAuthConfigured()) return null;
  const authFn = deps.authFn || (await loadAuthCore()).Auth;
  const config = deps.config || (await getAuthConfig());
  const url = getRequestBaseUrl(req) + "/api/auth/session";
  const headers = new Headers();
  if (req.headers.cookie) headers.set("cookie", req.headers.cookie);
  const webReq = new Request(url, { method: "GET", headers });
  const webRes = await authFn(webReq, config);
  if (!webRes.ok) return null;
  const data = await webRes.json().catch(() => null);
  if (!data || typeof data !== "object" || !data.user) return null;
  return data;
}

module.exports = { getSessionFromRequest };
