// Auth.js v5 core for the serverless API (PLAN_AUTH_DB.md §5, §17).
//
// No Next.js: @auth/core is framework-agnostic, so it runs inside a
// plain Vercel Node function. @auth/core and @auth/prisma-adapter
// are ESM-only — they are loaded with dynamic import() and cached
// (see loadAuthCore). Google is the only provider. Sessions are
// JWTs carrying the database user id as the `uid` claim; the
// adapter still stores the User / Account rows so sign-ins link to
// a persistent user. Email account linking is NOT allowed
// (allowDangerousEmailAccountLinking: false).
//
// Until the owner supplies the Neon database and the Google OAuth
// client, auth is not configured: the handler answers
// 503 auth_not_configured and the session helper returns null.
"use strict";

const { getPrisma, isConfigured: isDbConfigured } = require("./prisma");

/** @type {{ Auth: Function, Google: Function, PrismaAdapter: Function } | null} */
let coreCache = null;
/** @type {object | null} */
let configCache = null;

/**
 * True when everything auth needs is configured: the database plus
 * the Auth.js secret and the Google OAuth client credentials.
 */
function isAuthConfigured() {
  return (
    isDbConfigured() &&
    Boolean(process.env.AUTH_SECRET) &&
    Boolean(process.env.AUTH_GOOGLE_ID) &&
    Boolean(process.env.AUTH_GOOGLE_SECRET)
  );
}

/** Load the ESM-only Auth.js packages once and cache them. */
async function loadAuthCore() {
  if (coreCache) return coreCache;
  const [{ Auth }, { default: Google }, { PrismaAdapter }] = await Promise.all([
    import("@auth/core"),
    import("@auth/core/providers/google"),
    import("@auth/prisma-adapter"),
  ]);
  coreCache = { Auth, Google, PrismaAdapter };
  return coreCache;
}

/** Build (once) the Auth.js config object. */
async function getAuthConfig() {
  if (configCache) return configCache;
  const { Google, PrismaAdapter } = await loadAuthCore();
  configCache = {
    trustHost: true,
    // @auth/core defaults basePath to "/auth" (the Next.js route sets
    // it to "/api/auth" automatically). This is a plain Vercel
    // function at /api/auth/*, so without this the action cannot be
    // parsed from the path (UnknownAction) and every auth route
    // answers 400 "Bad request." — seen live 2026-11-26.
    basePath: "/api/auth",
    secret: process.env.AUTH_SECRET,
    adapter: PrismaAdapter(getPrisma()),
    providers: [
      Google({
        clientId: process.env.AUTH_GOOGLE_ID,
        clientSecret: process.env.AUTH_GOOGLE_SECRET,
        allowDangerousEmailAccountLinking: false,
      }),
    ],
    session: { strategy: "jwt" },
    callbacks: {
      async jwt({ token, user }) {
        if (user) token.uid = user.id;
        return token;
      },
      async session({ session, token }) {
        if (token && typeof token.uid === "string") {
          session.user.id = token.uid;
        }
        return session;
      },
    },
  };
  return configCache;
}

/** Base URL (https://host) for a request arriving via Vercel. */
function getRequestBaseUrl(req) {
  const host =
    req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

/**
 * Convert a Vercel Node request into a web Request for Auth.js.
 * The body is buffered first — auth payloads are small form posts
 * and JSON, so streaming is not needed.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {Promise<Request>}
 */
async function toWebRequest(req) {
  const url = getRequestBaseUrl(req) + (req.url || "/");
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else {
      headers.set(name, value);
    }
  }
  const method = (req.method || "GET").toUpperCase();
  /** @type {Buffer | undefined} */
  let body;
  if (method !== "GET" && method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }
  // Note: undici's RequestInit typing does not accept a Node Buffer
  // as BodyInit here, although it works at runtime; the cast keeps
  // the (buffered, small) auth body working without a stream wrapper.
  return new Request(url, /** @type {any} */ ({ method, headers, body }));
}

/**
 * Copy a web Response (from Auth.js) onto a Vercel Node response,
 * preserving status, headers and every Set-Cookie value.
 *
 * @param {Response} webRes
 * @param {import("http").ServerResponse} res
 */
async function sendWebResponse(webRes, res) {
  res.statusCode = webRes.status;
  const setCookie = webRes.headers.getSetCookie();
  webRes.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") return;
    res.setHeader(name, value);
  });
  if (setCookie.length > 0) res.setHeader("Set-Cookie", setCookie);
  res.end(Buffer.from(await webRes.arrayBuffer()));
}

/**
 * The Auth.js handler for every /api/auth/* route.
 *
 * `deps` is test injection only: { authFn, config } replaces the
 * real Auth.js core / config so the request/response adapter can be
 * exercised without a database or a Google client.
 *
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ authFn?: Function, config?: object }} [deps]
 */
async function authHandler(req, res, deps = {}) {
  if (!isAuthConfigured()) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "auth_not_configured" }));
    return;
  }
  const authFn = deps.authFn || (await loadAuthCore()).Auth;
  const config = deps.config || (await getAuthConfig());
  const webReq = await toWebRequest(req);
  const webRes = await authFn(webReq, config);
  await sendWebResponse(webRes, res);
}

module.exports = {
  isAuthConfigured,
  loadAuthCore,
  getAuthConfig,
  getRequestBaseUrl,
  toWebRequest,
  sendWebResponse,
  authHandler,
};
