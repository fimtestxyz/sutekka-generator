// Admin router tests: setup, login, session, orders, print queue,
// invoices, stats, webhooks, audit, settings, change password.
// In-memory mock Prisma — no database, no network.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import adminHandler from "../api/admin/[...admin].js";
import { resetRateLimits } from "../api/_lib/rate-limit.js";
import {
  setAuthEnv,
  restoreEnv,
  mockReq,
  mockRes,
} from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { hashPassword, hashToken } = require("../api/_lib/admin-auth.js");

/** Tiny where-matcher for the mock: equality, {not}, {contains, mode}, {gte, lte}, OR. */
function matchRow(row, where) {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") {
      if (!v.some((sub) => matchRow(row, sub))) return false;
      continue;
    }
    const val = row[k];
    if (v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
      if ("not" in v) {
        if (val === v.not) return false;
        continue;
      }
      if ("contains" in v) {
        if (typeof val !== "string") return false;
        const needle = v.mode === "insensitive" ? String(v.contains).toLowerCase() : String(v.contains);
        const hay = v.mode === "insensitive" ? val.toLowerCase() : val;
        if (!hay.includes(needle)) return false;
        continue;
      }
      if ("gte" in v && !(val >= v.gte)) return false;
      if ("lte" in v && !(val <= v.lte)) return false;
      continue;
    }
    if (val !== v) return false;
  }
  return true;
}

function sortRows(rows, orderBy) {
  if (!orderBy) return rows;
  const [key, dir] = Object.entries(orderBy)[0];
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === bv) return 0;
    return (av < bv ? -1 : 1) * (dir === "desc" ? -1 : 1);
  });
}

function mockPrismaAdmin({ orders = [], adminUsers = [] } = {}) {
  const db = {
    orders: orders.map((o) => ({ ...o })),
    adminUsers: adminUsers.map((u) => ({ ...u })),
    sessions: [],
    audit: [],
    invoiceRequests: [],
    webhookEvents: [],
    settings: {},
  };
  let seq = 1;
  const nextId = (p) => `${p}_${seq++}`;

  function findMany(rows, args = {}) {
    let out = rows.filter((r) => matchRow(r, args.where));
    out = sortRows(out, args.orderBy);
    if (args.skip) out = out.slice(args.skip);
    if (args.take !== undefined) out = out.slice(0, args.take);
    return out;
  }

  return {
    db,
    adminUser: {
      count: async (args) => db.adminUsers.filter((r) => matchRow(r, args?.where)).length,
      findUnique: async ({ where }) =>
        db.adminUsers.find((u) => (where.username && u.username === where.username) || (where.id && u.id === where.id)) || null,
      create: async ({ data }) => {
        const row = { id: nextId("admin"), createdAt: new Date(), updatedAt: new Date(), ...data };
        db.adminUsers.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = db.adminUsers.find((u) => u.id === where.id);
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    adminSession: {
      create: async ({ data }) => {
        const row = { id: nextId("sess"), createdAt: new Date(), ...data };
        db.sessions.push(row);
        return row;
      },
      findUnique: async ({ where, include }) => {
        const row = db.sessions.find((s) => s.tokenHash === where.tokenHash) || null;
        if (!row) return null;
        if (include?.adminUser) {
          return { ...row, adminUser: db.adminUsers.find((u) => u.id === row.adminUserId) };
        }
        return row;
      },
      findMany: async (args = {}) => findMany(db.sessions, args),
      delete: async ({ where }) => {
        const i = db.sessions.findIndex((s) => s.tokenHash === where.tokenHash || s.id === where.id);
        if (i === -1) throw new Error("not found");
        return db.sessions.splice(i, 1)[0];
      },
      deleteMany: async ({ where }) => {
        const before = db.sessions.length;
        db.sessions = db.sessions.filter((s) => !matchRow(s, where));
        return { count: before - db.sessions.length };
      },
    },
    auditLog: {
      create: async ({ data }) => {
        const row = { id: nextId("audit"), createdAt: new Date(), ...data };
        db.audit.push(row);
        return row;
      },
      findMany: async (args = {}) => findMany(db.audit, args),
      count: async (args) => db.audit.filter((r) => matchRow(r, args?.where)).length,
    },
    order: {
      count: async (args) => db.orders.filter((r) => matchRow(r, args?.where)).length,
      findMany: async (args = {}) => findMany(db.orders, args),
      findUnique: async (args) => {
        const row =
          db.orders.find((o) => (args.where.id && o.id === args.where.id) || (args.where.stripeSessionId && o.stripeSessionId === args.where.stripeSessionId)) ||
          null;
        if (!row) return null;
        if (args.include?.invoiceRequest) {
          return {
            ...row,
            invoiceRequest: db.invoiceRequests.find((r) => r.orderId === row.id) || null,
          };
        }
        return row;
      },
      update: async ({ where, data }) => {
        const row = db.orders.find((o) => o.id === where.id);
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    invoiceRequest: {
      findMany: async (args = {}) => findMany(db.invoiceRequests, args),
      findUnique: async ({ where }) =>
        db.invoiceRequests.find((r) => (where.id && r.id === where.id) || (where.orderId && r.orderId === where.orderId)) || null,
      update: async ({ where, data }) => {
        const row = db.invoiceRequests.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const r of db.invoiceRequests) {
          if (matchRow(r, where)) {
            Object.assign(r, data);
            count += 1;
          }
        }
        return { count };
      },
      upsert: async ({ where, create, update }) => {
        let row = db.invoiceRequests.find((r) => r.orderId === where.orderId);
        if (row) Object.assign(row, update);
        else {
          row = { id: nextId("inv"), createdAt: new Date(), ...create };
          db.invoiceRequests.push(row);
        }
        return row;
      },
    },
    webhookEvent: {
      findMany: async (args = {}) => findMany(db.webhookEvents, args),
      create: async ({ data }) => {
        const row = { id: nextId("we"), createdAt: new Date(), ...data };
        db.webhookEvents.push(row);
        return row;
      },
    },
    siteSetting: {
      findMany: async () =>
        Object.entries(db.settings).map(([key, value]) => ({ key, value, updatedAt: new Date() })),
      upsert: async ({ where, create, update }) => {
        db.settings[where.key] = update?.value ?? create.value;
        return { key: where.key, value: db.settings[where.key] };
      },
    },
  };
}

const ORDER = {
  id: "ord_1",
  stripeSessionId: "cs_1",
  stripePaymentLinkId: "plink_1",
  stripePaymentIntentId: "pi_1",
  buyerEmail: "buyer@example.com",
  itemId: "ai-agent-four-faces-03",
  itemType: "single",
  amountTotal: 400,
  currency: "sgd",
  status: "paid",
  payMethodType: "card",
  filesJson: null,
  printStatus: "none",
  shippingName: null,
  shippingAddress: null,
  trackingCourier: null,
  trackingNumber: null,
  invoiceId: null,
  invoiceNumber: null,
  invoiceRequestedAt: null,
  adminNotes: null,
  refundedAt: null,
  cancelReason: null,
  createdAt: new Date("2026-11-26T09:00:00Z"),
  updatedAt: new Date("2026-11-26T09:00:00Z"),
};

/** Run setup, return the session cookie value for later calls. */
async function setupAdmin(prisma, username = "owner", password = "correct horse battery staple") {
  const res = mockRes();
  await adminHandler(
    mockReq({
      method: "POST",
      url: "/api/admin/setup",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    }),
    res,
    { prisma },
  );
  assert.equal(res.statusCode, 201);
  const cookie = res.headers["set-cookie"];
  const token = /sutekka_admin=([^;]+)/.exec(cookie)[1];
  return token;
}

/** @param {{ method?: string, url: string, token?: string | null, body?: string | null }} opts */
function authedReq({ method = "GET", url, token, body = null }) {
  return mockReq({
    method,
    url,
    headers: {
      ...(token ? { cookie: `sutekka_admin=${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body,
  });
}

beforeEach(() => {
  setAuthEnv();
  resetRateLimits();
});
afterEach(() => restoreEnv());

describe("POST /api/admin/setup", () => {
  it("creates the first admin and a session, then refuses a second", async () => {
    const prisma = mockPrismaAdmin();
    const token = await setupAdmin(prisma);
    assert.ok(token.length > 0);
    assert.equal(prisma.db.adminUsers.length, 1);
    assert.equal(prisma.db.sessions.length, 1);

    const res = mockRes();
    await adminHandler(
      mockReq({
        method: "POST",
        url: "/api/admin/setup",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "second", password: "another password here" }),
      }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 409);
    assert.equal((await res.json()).error, "setup_complete");
  });

  it("rejects a short password and a bad username", async () => {
    const prisma = mockPrismaAdmin();
    const res1 = mockRes();
    await adminHandler(
      mockReq({
        method: "POST",
        url: "/api/admin/setup",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "owner", password: "short" }),
      }),
      res1,
      { prisma },
    );
    assert.equal(res1.statusCode, 400);
    const res2 = mockRes();
    await adminHandler(
      mockReq({
        method: "POST",
        url: "/api/admin/setup",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "bad name!", password: "a perfectly fine password" }),
      }),
      res2,
      { prisma },
    );
    assert.equal(res2.statusCode, 400);
    assert.equal(prisma.db.adminUsers.length, 0);
  });
});

describe("GET /api/admin/session", () => {
  it("reports setupNeeded when no admin exists", async () => {
    const prisma = mockPrismaAdmin();
    const res = mockRes();
    await adminHandler(mockReq({ method: "GET", url: "/api/admin/session" }), res, { prisma });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await res.json(), { admin: null, setupNeeded: true });
  });

  it("reports the signed-in admin from the cookie", async () => {
    const prisma = mockPrismaAdmin();
    const token = await setupAdmin(prisma);
    const res = mockRes();
    await adminHandler(authedReq({ url: "/api/admin/session", token }), res, { prisma });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await res.json(), { admin: { username: "owner" }, setupNeeded: false });
  });
});

describe("POST /api/admin/login", () => {
  it("signs in with the right password and rejects the wrong one", async () => {
    const prisma = mockPrismaAdmin();
    await setupAdmin(prisma);
    // Log out the setup session first so the login creates its own.
    const ok = mockRes();
    await adminHandler(
      authedReq({
        method: "POST",
        url: "/api/admin/login",
        body: JSON.stringify({ username: "owner", password: "correct horse battery staple" }),
      }),
      ok,
      { prisma },
    );
    assert.equal(ok.statusCode, 200);
    assert.equal((await ok.json()).admin.username, "owner");
    assert.match(ok.headers["set-cookie"], /sutekka_admin=/);

    const bad = mockRes();
    await adminHandler(
      mockReq({
        method: "POST",
        url: "/api/admin/login",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "owner", password: "wrong password here" }),
      }),
      bad,
      { prisma },
    );
    assert.equal(bad.statusCode, 401);
    assert.equal((await bad.json()).error, "invalid_credentials");
  });

  it("locks out after 5 failed attempts", async () => {
    const prisma = mockPrismaAdmin();
    await setupAdmin(prisma, "owner2");
    for (let i = 0; i < 5; i++) {
      const res = mockRes();
      await adminHandler(
        mockReq({
          method: "POST",
          url: "/api/admin/login",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "owner2", password: "wrong password here" }),
        }),
        res,
        { prisma },
      );
      assert.equal(res.statusCode, 401);
    }
    const locked = mockRes();
    await adminHandler(
      mockReq({
        method: "POST",
        url: "/api/admin/login",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "owner2", password: "correct horse battery staple" }),
      }),
      locked,
      { prisma },
    );
    assert.equal(locked.statusCode, 429);
    assert.equal((await locked.json()).error, "too_many_attempts");
  });
});

describe("admin routes require a session", () => {
  it("answers 401 without a cookie on every protected route", async () => {
    const prisma = mockPrismaAdmin({ orders: [ORDER] });
    await setupAdmin(prisma);
    for (const url of [
      "/api/admin/orders",
      "/api/admin/orders/ord_1",
      "/api/admin/print-queue",
      "/api/admin/stats",
      "/api/admin/webhooks",
      "/api/admin/audit",
      "/api/admin/settings",
      "/api/admin/invoices",
    ]) {
      const res = mockRes();
      await adminHandler(mockReq({ method: "GET", url }), res, { prisma });
      assert.equal(res.statusCode, 401, url);
    }
  });
});

describe("GET /api/admin/orders", () => {
  it("lists orders with filters and pagination", async () => {
    const prisma = mockPrismaAdmin({
      orders: [
        ORDER,
        { ...ORDER, id: "ord_2", buyerEmail: "other@example.com", status: "delivered", amountTotal: 1500 },
      ],
    });
    const token = await setupAdmin(prisma);
    const res = mockRes();
    await adminHandler(authedReq({ url: "/api/admin/orders?status=paid", token }), res, { prisma });
    assert.equal(res.statusCode, 200);
    const body = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.orders[0].id, "ord_1");
    assert.equal(body.orders[0].buyerEmail, "buyer@example.com");

    const res2 = mockRes();
    await adminHandler(authedReq({ url: "/api/admin/orders?q=other@example.com", token }), res2, { prisma });
    assert.equal((await res2.json()).total, 1);
    assert.equal((await res2.json()).orders[0].id, "ord_2");
  });
});

describe("order actions", () => {
  it("changes status only along allowed transitions and audits it", async () => {
    const prisma = mockPrismaAdmin({ orders: [ORDER] });
    const token = await setupAdmin(prisma);
    const res = mockRes();
    await adminHandler(
      authedReq({
        method: "POST",
        url: "/api/admin/orders/ord_1/status",
        token,
        body: JSON.stringify({ status: "delivered", reason: "files sent" }),
      }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 200);
    assert.equal((await res.json()).order.status, "delivered");
    assert.equal(prisma.db.audit.length, 2); // setup + status
    assert.equal(prisma.db.audit[1].action, "order.status");

    // delivered -> delivered is not a transition.
    const res2 = mockRes();
    await adminHandler(
      authedReq({
        method: "POST",
        url: "/api/admin/orders/ord_1/status",
        token,
        body: JSON.stringify({ status: "delivered", reason: "again" }),
      }),
      res2,
      { prisma },
    );
    assert.equal(res2.statusCode, 409);
  });

  it("refunds with a timestamp and a reason", async () => {
    const prisma = mockPrismaAdmin({ orders: [ORDER] });
    const token = await setupAdmin(prisma);
    const res = mockRes();
    await adminHandler(
      authedReq({
        method: "POST",
        url: "/api/admin/orders/ord_1/status",
        token,
        body: JSON.stringify({ status: "refunded", reason: "duplicate charge" }),
      }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 200);
    const order = await res.json();
    assert.equal(order.order.status, "refunded");
    assert.ok(order.order.refundedAt);
    assert.equal(order.order.cancelReason, "duplicate charge");
  });

  it("updates print status, shipping and notes", async () => {
    const prisma = mockPrismaAdmin({ orders: [ORDER] });
    const token = await setupAdmin(prisma);
    const print = mockRes();
    await adminHandler(
      authedReq({
        method: "POST",
        url: "/api/admin/orders/ord_1/print",
        token,
        body: JSON.stringify({ printStatus: "printing" }),
      }),
      print,
      { prisma },
    );
    assert.equal(print.statusCode, 200);
    assert.equal((await print.json()).order.printStatus, "printing");

    const ship = mockRes();
    await adminHandler(
      authedReq({
        method: "POST",
        url: "/api/admin/orders/ord_1/shipping",
        token,
        body: JSON.stringify({ courier: "SingPost", trackingNumber: "RF123" }),
      }),
      ship,
      { prisma },
    );
    assert.equal(ship.statusCode, 200);
    assert.equal((await ship.json()).order.trackingNumber, "RF123");

    const note = mockRes();
    await adminHandler(
      authedReq({
        method: "POST",
        url: "/api/admin/orders/ord_1/note",
        token,
        body: JSON.stringify({ note: "handle with care" }),
      }),
      note,
      { prisma },
    );
    assert.equal(note.statusCode, 200);
    assert.equal((await note.json()).order.adminNotes, "handle with care");
  });

  it("records a Dashboard-issued invoice and closes the request", async () => {
    const prisma = mockPrismaAdmin({ orders: [ORDER] });
    prisma.db.invoiceRequests.push({
      id: "inv_1",
      orderId: "ord_1",
      buyerEmail: "buyer@example.com",
      status: "open",
      createdAt: new Date(),
      resolvedAt: null,
    });
    const token = await setupAdmin(prisma);
    const res = mockRes();
    await adminHandler(
      authedReq({
        method: "POST",
        url: "/api/admin/orders/ord_1/invoice",
        token,
        body: JSON.stringify({ invoiceId: "in_123", invoiceNumber: "INV-2026-001" }),
      }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 200);
    assert.equal((await res.json()).order.invoiceNumber, "INV-2026-001");
    assert.equal(prisma.db.invoiceRequests[0].status, "issued");
    assert.ok(prisma.db.invoiceRequests[0].resolvedAt);
  });

  it("answers 404 for an unknown order", async () => {
    const prisma = mockPrismaAdmin({ orders: [ORDER] });
    const token = await setupAdmin(prisma);
    const res = mockRes();
    await adminHandler(authedReq({ url: "/api/admin/orders/ord_nope", token }), res, { prisma });
    assert.equal(res.statusCode, 404);
  });
});

describe("GET /api/admin/print-queue, stats, webhooks, audit", () => {
  it("lists queued prints oldest-first by status rank", async () => {
    const prisma = mockPrismaAdmin({
      orders: [
        { ...ORDER, id: "ord_ship", printStatus: "shipped" },
        { ...ORDER, id: "ord_q", printStatus: "queued" },
        { ...ORDER, id: "ord_plain", printStatus: "none" },
      ],
    });
    const token = await setupAdmin(prisma);
    const res = mockRes();
    await adminHandler(authedReq({ url: "/api/admin/print-queue", token }), res, { prisma });
    assert.equal(res.statusCode, 200);
    const orders = (await res.json()).orders;
    assert.deepEqual(
      orders.map((o) => o.id),
      ["ord_q", "ord_ship"],
    );
  });

  it("computes revenue and top sellers from orders", async () => {
    const prisma = mockPrismaAdmin({
      orders: [
        ORDER,
        { ...ORDER, id: "ord_2", itemId: "riemann-rashomon", itemType: "set", amountTotal: 1500, status: "delivered" },
        { ...ORDER, id: "ord_3", itemId: "ai-agent-four-faces-03", amountTotal: 400, status: "refunded" },
      ],
    });
    const token = await setupAdmin(prisma);
    const res = mockRes();
    await adminHandler(authedReq({ url: "/api/admin/stats", token }), res, { prisma });
    const s = await res.json();
    assert.equal(s.totalOrders, 3);
    assert.equal(s.paidOrders, 2);
    assert.equal(s.refundedOrders, 1);
    assert.equal(s.totalRevenue, 1900);
    assert.equal(s.topItems[0].itemId, "ai-agent-four-faces-03");
  });

  it("shows webhook events and the audit log", async () => {
    const prisma = mockPrismaAdmin({ orders: [ORDER] });
    prisma.db.webhookEvents.push({
      id: "we_1",
      type: "checkout.session.completed",
      stripeSessionId: "cs_1",
      status: "ok",
      error: null,
      createdAt: new Date(),
    });
    const token = await setupAdmin(prisma);
    const res = mockRes();
    await adminHandler(authedReq({ url: "/api/admin/webhooks", token }), res, { prisma });
    assert.equal((await res.json()).events.length, 1);
    const res2 = mockRes();
    await adminHandler(authedReq({ url: "/api/admin/audit", token }), res2, { prisma });
    const audit = await res2.json();
    assert.ok(audit.entries.some((e) => e.action === "auth.setup"));
  });
});

describe("settings and password", () => {
  it("reads and writes site settings", async () => {
    const prisma = mockPrismaAdmin();
    const token = await setupAdmin(prisma);
    const get1 = mockRes();
    await adminHandler(authedReq({ url: "/api/admin/settings", token }), get1, { prisma });
    assert.deepEqual(await get1.json(), { shopClosed: false, announcement: "", hiddenItems: [], uploadsEnabled: false });

    const post = mockRes();
    await adminHandler(
      authedReq({
        method: "POST",
        url: "/api/admin/settings",
        token,
        body: JSON.stringify({ shopClosed: true, announcement: "Prints ship in 5 days", hiddenItems: ["riemann-rashomon"] }),
      }),
      post,
      { prisma },
    );
    assert.equal(post.statusCode, 200);
    const get2 = mockRes();
    await adminHandler(authedReq({ url: "/api/admin/settings", token }), get2, { prisma });
    assert.deepEqual(await get2.json(), {
      shopClosed: true,
      announcement: "Prints ship in 5 days",
      hiddenItems: ["riemann-rashomon"],
      uploadsEnabled: false,
    });
  });

  it("changes the password and revokes other sessions", async () => {
    const prisma = mockPrismaAdmin();
    const token1 = await setupAdmin(prisma);
    // A second session from a fresh login.
    const login = mockRes();
    await adminHandler(
      mockReq({
        method: "POST",
        url: "/api/admin/login",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "owner", password: "correct horse battery staple" }),
      }),
      login,
      { prisma },
    );
    const token2 = /sutekka_admin=([^;]+)/.exec(login.headers["set-cookie"])[1];
    assert.equal(prisma.db.sessions.length, 2);

    const bad = mockRes();
    await adminHandler(
      authedReq({
        method: "POST",
        url: "/api/admin/change-password",
        token: token1,
        body: JSON.stringify({ oldPassword: "wrong old password", newPassword: "brand new password here" }),
      }),
      bad,
      { prisma },
    );
    assert.equal(bad.statusCode, 401);

    const ok = mockRes();
    await adminHandler(
      authedReq({
        method: "POST",
        url: "/api/admin/change-password",
        token: token1,
        body: JSON.stringify({ oldPassword: "correct horse battery staple", newPassword: "brand new password here" }),
      }),
      ok,
      { prisma },
    );
    assert.equal(ok.statusCode, 200);
    assert.equal(prisma.db.sessions.length, 1);
    assert.equal(prisma.db.sessions[0].tokenHash, hashToken(token1));
    // The old password no longer works; the new one does.
    const user = prisma.db.adminUsers[0];
    assert.equal(user.passwordHash.startsWith("scrypt:"), true);
    const relogin = mockRes();
    await adminHandler(
      mockReq({
        method: "POST",
        url: "/api/admin/login",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "owner", password: "brand new password here" }),
      }),
      relogin,
      { prisma },
    );
    assert.equal(relogin.statusCode, 200);
  });

  it("lists sessions and revokes all but the current one", async () => {
    const prisma = mockPrismaAdmin();
    const token = await setupAdmin(prisma);
    const list = mockRes();
    await adminHandler(authedReq({ url: "/api/admin/sessions", token }), list, { prisma });
    const sessions = (await list.json()).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].current, true);

    const del = mockRes();
    await adminHandler(authedReq({ method: "DELETE", url: "/api/admin/sessions", token }), del, { prisma });
    assert.equal(del.statusCode, 200);
    assert.equal(prisma.db.sessions.length, 1); // the current one stays
  });
});

describe("logout", () => {
  it("deletes the session and clears the cookie", async () => {
    const prisma = mockPrismaAdmin();
    const token = await setupAdmin(prisma);
    const res = mockRes();
    await adminHandler(authedReq({ method: "POST", url: "/api/admin/logout", token }), res, { prisma });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["set-cookie"], /Max-Age=0/);
    assert.equal(prisma.db.sessions.length, 0);
    const check = mockRes();
    await adminHandler(authedReq({ url: "/api/admin/session", token }), check, { prisma });
    assert.deepEqual(await check.json(), { admin: null, setupNeeded: false });
  });
});
