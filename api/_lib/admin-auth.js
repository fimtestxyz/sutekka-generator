// Admin authentication for #/kangle (ADMIN.md §2).
//
// The admin is NOT the Auth.js Google login: it is a separate
// username + password stored in the database (AdminUser, scrypt hash
// via node:crypto — no new dependency). The first account is created
// by the one-time first-run setup form; the password never travels
// through chat or a vault.
//
// Sessions are random tokens: the cookie carries the raw token, the
// database stores only its SHA-256 hash (AdminSession, 24h expiry).
// Logout / revoke-all delete rows. No JWT, no session secret.
//
// Rate limiting reuses api/_lib/rate-limit.js (in-memory per
// instance, best-effort — same caveat as the comment limiter).
"use strict";

const crypto = require("crypto");
const { checkRateLimit } = require("./rate-limit");

const ADMIN_COOKIE = "sutekka_admin";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

// scrypt parameters (OWASP-recommended ballpark for interactive login).
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * Hash a password. Returns "scrypt:<salt-hex>:<hash-hex>".
 *
 * @param {string} password
 * @returns {string}
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * True when `password` matches the stored scrypt hash. Any malformed
 * stored value simply fails — it never throws.
 *
 * @param {string} password
 * @param {string} stored "scrypt:<salt-hex>:<hash-hex>"
 * @returns {boolean}
 */
function verifyPassword(password, stored) {
  try {
    if (typeof password !== "string" || typeof stored !== "string") return false;
    const parts = stored.split(":");
    if (parts.length !== 3 || parts[0] !== "scrypt") return false;
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    return crypto.timingSafeEqual(hash, expected);
  } catch (e) {
    return false;
  }
}

/** SHA-256 hex of a session token (what the database stores). */
function hashToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** A new random session token (what the cookie carries). */
function createSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Parse the admin cookie out of a request's Cookie header.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {string | null}
 */
function getAdminToken(req) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  for (const part of String(header).split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === ADMIN_COOKIE) return rest.join("=");
  }
  return null;
}

/**
 * Set the admin session cookie on a response. Path=/ so the SPA's
 * fetch calls to /api/admin/* carry it; HttpOnly + Secure + Lax.
 *
 * @param {import("http").ServerResponse} res
 * @param {string} token raw session token
 * @param {number} [maxAgeSec] defaults to the 24h session TTL
 */
function setAdminCookie(res, token, maxAgeSec) {
  const maxAge = maxAgeSec === undefined ? SESSION_TTL_MS / 1000 : maxAgeSec;
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
  );
}

/** Clear the admin session cookie. */
function clearAdminCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  );
}

/**
 * Create a session row for `adminUserId` and return the raw token
 * for the cookie.
 *
 * @param {any} prisma
 * @param {string} adminUserId
 * @returns {Promise<string>} raw token
 */
async function createAdminSession(prisma, adminUserId) {
  const token = createSessionToken();
  await prisma.adminSession.create({
    data: {
      tokenHash: hashToken(token),
      adminUserId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  return token;
}

/**
 * Resolve the request's admin session. Returns the AdminUser row
 * ({ id, username }) or null when there is no valid session
 * (missing/unknown/expired token). Expired rows are deleted lazily.
 *
 * @param {import("http").IncomingMessage} req
 * @param {any} prisma
 * @returns {Promise<{ id: string, username: string } | null>}
 */
async function getAdminUser(req, prisma) {
  const token = getAdminToken(req);
  if (!token) return null;
  const row = await prisma.adminSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { adminUser: true },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await prisma.adminSession.delete({ where: { id: row.id } }).catch(() => null);
    return null;
  }
  return { id: row.adminUser.id, username: row.adminUser.username };
}

/**
 * True when the login rate limit allows another attempt for this
 * username + client IP. Callers answer 429 on false.
 *
 * @param {string} username
 * @param {import("http").IncomingMessage} req
 * @returns {boolean}
 */
function loginAllowed(username, req) {
  const forwarded = req.headers && req.headers["x-forwarded-for"];
  const ip = forwarded
    ? String(forwarded).split(",")[0].trim()
    : (req.socket && req.socket.remoteAddress) || "unknown";
  return checkRateLimit(`admin-login:${username}:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW_MS);
}

/**
 * Best-effort audit row. A failure to write the log must never fail
 * the admin action it records.
 *
 * @param {any} prisma
 * @param {{ adminUser: string, action: string, orderId?: string | null, details?: any }} entry
 */
async function audit(prisma, entry) {
  try {
    await prisma.auditLog.create({
      data: {
        adminUser: entry.adminUser,
        action: entry.action,
        orderId: entry.orderId || null,
        details: entry.details === undefined ? null : entry.details,
      },
    });
  } catch (e) {
    console.error("auditLog write failed", e);
  }
}

/**
 * Origin check for state-changing admin calls: when the request
 * carries an Origin header it must match the request's own host
 * (same-origin fetch from the SPA). Absent Origin (curl, tests) is
 * allowed — the HttpOnly + SameSite=Lax cookie is the primary CSRF
 * defence.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {boolean}
 */
function originOk(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  try {
    const host = req.headers.host || "";
    const o = new URL(origin);
    return o.host === host;
  } catch (e) {
    return false;
  }
}

module.exports = {
  ADMIN_COOKIE,
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  hashToken,
  createSessionToken,
  getAdminToken,
  setAdminCookie,
  clearAdminCookie,
  createAdminSession,
  getAdminUser,
  loginAllowed,
  audit,
  originOk,
};
