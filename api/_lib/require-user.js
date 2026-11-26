// Per-handler auth check (PLAN_AUTH_DB.md §17): there is no
// middleware in this serverless setup, so every mutating (and
// every private) handler calls requireUser() itself and answers
// 401 when it returns null. The user id always comes from the
// Auth.js session — never from a client-sent userId.
"use strict";

const { getSessionFromRequest } = require("./session");

/**
 * @param {import("http").IncomingMessage} req
 * @param {{ authFn?: Function, config?: object }} [sessionDeps] test injection only, passed to getSessionFromRequest
 * @returns {Promise<string | null>} the authenticated user id, or null
 */
async function requireUser(req, sessionDeps = {}) {
  const session = await getSessionFromRequest(req, sessionDeps);
  if (!session || !session.user || typeof session.user.id !== "string") return null;
  return session.user.id;
}

module.exports = { requireUser };
