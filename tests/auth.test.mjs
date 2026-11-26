// Auth handler + session tests. The real @auth/core is never
// loaded here — a fake auth function is injected via `deps`, so
// these run with no database and no Google client.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { isAuthConfigured, authHandler, getAuthConfig } from "../api/_lib/auth.js";
import { getSessionFromRequest } from "../api/_lib/session.js";

const ENV_KEYS = ["DATABASE_URL", "AUTH_SECRET", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"];
const savedEnv = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function clearAuthEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function setAuthEnv() {
  process.env.DATABASE_URL = "postgresql://placeholder:placeholder@placeholder-host:5432/sutekka";
  process.env.AUTH_SECRET = "test-secret-not-real";
  process.env.AUTH_GOOGLE_ID = "test-google-id";
  process.env.AUTH_GOOGLE_SECRET = "test-google-secret";
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function mockReq({ method = "GET", url = "/api/auth/session", headers = {}, body = null } = {}) {
  // A bare Readable stands in for IncomingMessage (async-iterable
  // body + method/url/headers); cast to any for the extra props.
  const stream = /** @type {any} */ (
    body === null ? Readable.from([]) : Readable.from([Buffer.from(body)])
  );
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

function mockRes() {
  const chunks = [];
  let resolveEnd;
  const ended = new Promise((r) => {
    resolveEnd = r;
  });
  const res = /** @type {any} */ ({
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      resolveEnd();
    },
  });
  res.body = async () => {
    await ended;
    return Buffer.concat(chunks).toString("utf8");
  };
  return res;
}

describe("isAuthConfigured", () => {
  it("is false without env vars", () => {
    clearAuthEnv();
    assert.equal(isAuthConfigured(), false);
  });

  it("is true when all four vars are set", () => {
    setAuthEnv();
    assert.equal(isAuthConfigured(), true);
  });

  it("is false when only some vars are set", () => {
    clearAuthEnv();
    process.env.AUTH_SECRET = "x";
    assert.equal(isAuthConfigured(), false);
  });
});

describe("authHandler", () => {
  it("answers 503 auth_not_configured when auth is not configured", async () => {
    clearAuthEnv();
    const res = mockRes();
    await authHandler(mockReq(), res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(JSON.parse(await res.body()), { error: "auth_not_configured" });
  });

  it("converts the Node request to a web Request and the web Response back", async () => {
    setAuthEnv();
    let received = null;
    const fakeAuth = async (webReq) => {
      received = {
        url: webReq.url,
        method: webReq.method,
        cookie: webReq.headers.get("cookie"),
        body: webReq.method === "GET" ? null : await webReq.text(),
      };
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "a=1; Path=/; HttpOnly");
      headers.append("set-cookie", "b=2; Path=/; HttpOnly");
      return new Response(JSON.stringify({ ok: true }), { status: 201, headers });
    };
    const req = mockReq({
      method: "POST",
      url: "/api/auth/callback/google?state=x",
      headers: { host: "example.test", cookie: "session=abc" },
      body: "code=123",
    });
    const res = mockRes();
    await authHandler(req, res, { authFn: fakeAuth, config: {} });
    assert.equal(received.url, "https://example.test/api/auth/callback/google?state=x");
    assert.equal(received.method, "POST");
    assert.equal(received.cookie, "session=abc");
    assert.equal(received.body, "code=123");
    assert.equal(res.statusCode, 201);
    assert.equal(res.headers["content-type"], "application/json");
    assert.deepEqual(res.headers["set-cookie"], ["a=1; Path=/; HttpOnly", "b=2; Path=/; HttpOnly"]);
    assert.deepEqual(JSON.parse(await res.body()), { ok: true });
  });
});

describe("auth basePath (regression: live 400 Bad request. 2026-11-26)", () => {
  it("getAuthConfig sets basePath /api/auth", async () => {
    setAuthEnv();
    const config = /** @type {{ basePath?: string }} */ (await getAuthConfig());
    assert.equal(config.basePath, "/api/auth");
  });

  it("real Auth core answers /api/auth/session with 200, not 400", async () => {
    setAuthEnv();
    const res = mockRes();
    await authHandler(mockReq(), res);
    assert.equal(res.statusCode, 200);
    // No session cookie: Auth.js returns JSON null (not {}).
    assert.equal(JSON.parse(await res.body()), null);
  });
});

describe("getSessionFromRequest", () => {
  it("returns null when auth is not configured", async () => {
    clearAuthEnv();
    assert.equal(await getSessionFromRequest(mockReq()), null);
  });

  it("returns the session user from the auth session endpoint", async () => {
    setAuthEnv();
    let requestedUrl = null;
    let requestedCookie = null;
    const fakeAuth = async (webReq) => {
      requestedUrl = webReq.url;
      requestedCookie = webReq.headers.get("cookie");
      return new Response(
        JSON.stringify({ user: { id: "u1", name: "Test", email: "t@example.com" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const session = await getSessionFromRequest(
      mockReq({ headers: { host: "example.test", cookie: "session=abc" } }),
      { authFn: fakeAuth, config: {} },
    );
    assert.equal(requestedUrl, "https://example.test/api/auth/session");
    assert.equal(requestedCookie, "session=abc");
    assert.deepEqual(session, { user: { id: "u1", name: "Test", email: "t@example.com" } });
  });

  it("returns null when the session endpoint is not ok or has no user", async () => {
    setAuthEnv();
    const noUser = async () => new Response(JSON.stringify({}), { status: 200 });
    assert.equal(
      await getSessionFromRequest(mockReq(), { authFn: noUser, config: {} }),
      null,
    );
    const unauthorized = async () => new Response("no", { status: 401 });
    assert.equal(
      await getSessionFromRequest(mockReq(), { authFn: unauthorized, config: {} }),
      null,
    );
  });
});
