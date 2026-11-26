// Vercel route for /api/auth/signin/:provider (e.g. Google).
//
// The catch-all api/auth/[...auth].js only matches ONE path segment on
// Vercel's native function router, so /api/auth/signin/google 404s at
// the edge (verified live 2026-11-26). Explicit files for the
// two-segment auth actions are the workaround; they delegate to the
// same handler, which still sees the full original URL.
"use strict";

const { authHandler } = require("../../_lib/auth");

module.exports = async function handler(req, res) {
  await authHandler(req, res);
};
