// Vercel route for /api/auth/callback/:provider (e.g. Google).
//
// Same reason as api/auth/signin/[provider].js: the [...auth].js
// catch-all only matches one path segment on Vercel's native function
// router, so /api/auth/callback/google 404s at the edge (verified
// live 2026-11-26). Delegates to the same handler, which still sees
// the full original URL.
"use strict";

const { authHandler } = require("../../_lib/auth");

module.exports = async function handler(req, res) {
  await authHandler(req, res);
};
