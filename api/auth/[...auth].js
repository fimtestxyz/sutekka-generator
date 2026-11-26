// Vercel catch-all for every Auth.js route (/api/auth/*):
// /api/auth/session, /signin, /signout, /callback/*, /csrf, ...
// The file name's [...auth] segment is Vercel's catch-all syntax
// for standalone api/ functions.
"use strict";

const { authHandler } = require("../_lib/auth");

module.exports = async function handler(req, res) {
  await authHandler(req, res);
};
