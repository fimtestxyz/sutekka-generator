// Shared mocks for the API handler tests. Every test injects a
// fake Auth.js core via sessionDeps, so no test needs a database
// or a Google client.
import { Readable } from "node:stream";

export const ENV_KEYS = ["DATABASE_URL", "AUTH_SECRET", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"];

const savedEnv = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

export function clearAuthEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

export function setAuthEnv() {
  process.env.DATABASE_URL = "postgresql://placeholder:placeholder@placeholder-host:5432/sutekka";
  process.env.AUTH_SECRET = "test-secret-not-real";
  process.env.AUTH_GOOGLE_ID = "test-google-id";
  process.env.AUTH_GOOGLE_SECRET = "test-google-secret";
}

export function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

/** sessionDeps whose fake Auth.js core returns a signed-in user. */
export function sessionDepsFor(userId) {
  return {
    authFn: async () =>
      new Response(
        JSON.stringify({ user: { id: userId, name: "Test", email: "t@example.com" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    config: {},
  };
}

/** sessionDeps whose fake Auth.js core returns no user (signed out). */
export function noSessionDeps() {
  return {
    authFn: async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }),
    config: {},
  };
}

export function mockReq({ method = "GET", url = "/api/test", headers = {}, body = null } = {}) {
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

export function mockRes() {
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
  res.json = async () => JSON.parse(await res.body());
  return res;
}
