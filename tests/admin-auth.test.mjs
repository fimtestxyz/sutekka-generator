// Admin auth lib tests (pure): password hashing, session tokens,
// cookie handling. No database, no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const auth = require("../api/_lib/admin-auth.js");

describe("hashPassword / verifyPassword", () => {
  it("verifies the password it hashed and rejects any other", () => {
    const stored = auth.hashPassword("correct horse battery staple");
    assert.equal(auth.verifyPassword("correct horse battery staple", stored), true);
    assert.equal(auth.verifyPassword("wrong password here", stored), false);
    assert.equal(auth.verifyPassword("", stored), false);
  });

  it("salts: the same password hashes differently each time", () => {
    const a = auth.hashPassword("same-password-123");
    const b = auth.hashPassword("same-password-123");
    assert.notEqual(a, b);
    assert.equal(auth.verifyPassword("same-password-123", a), true);
    assert.equal(auth.verifyPassword("same-password-123", b), true);
  });

  it("rejects malformed stored values without throwing", () => {
    assert.equal(auth.verifyPassword("x", ""), false);
    assert.equal(auth.verifyPassword("x", "bcrypt:$2b$10$abc"), false);
    assert.equal(auth.verifyPassword("x", "scrypt:zz:zz"), false);
    assert.equal(auth.verifyPassword("x", null), false);
  });
});

describe("session tokens and cookies", () => {
  it("hashes tokens deterministically and creates unique tokens", () => {
    const t1 = auth.createSessionToken();
    const t2 = auth.createSessionToken();
    assert.notEqual(t1, t2);
    assert.equal(t1.length, 64);
    assert.equal(auth.hashToken(t1), auth.hashToken(t1));
    assert.notEqual(auth.hashToken(t1), auth.hashToken(t2));
    assert.equal(auth.hashToken(t1).length, 64);
  });

  it("parses the admin cookie out of a Cookie header", () => {
    const req = /** @type {any} */ ({ headers: { cookie: "other=1; sutekka_admin=tok_abc; x=2" } });
    assert.equal(auth.getAdminToken(req), "tok_abc");
    assert.equal(auth.getAdminToken(/** @type {any} */ ({ headers: {} })), null);
    assert.equal(auth.getAdminToken(/** @type {any} */ ({ headers: { cookie: "other=1" } })), null);
  });

  it("sets an HttpOnly Secure SameSite cookie and clears it", () => {
    const headers = {};
    const res = /** @type {any} */ ({ setHeader: (k, v) => { headers[k] = v; } });
    auth.setAdminCookie(res, "tok_abc");
    assert.match(headers["Set-Cookie"], /sutekka_admin=tok_abc/);
    assert.match(headers["Set-Cookie"], /HttpOnly/);
    assert.match(headers["Set-Cookie"], /Secure/);
    assert.match(headers["Set-Cookie"], /SameSite=Lax/);
    assert.match(headers["Set-Cookie"], /Max-Age=86400/);
    auth.clearAdminCookie(res);
    assert.match(headers["Set-Cookie"], /Max-Age=0/);
  });
});
