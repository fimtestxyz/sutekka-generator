// Cart sync handler tests (mocked Prisma + session).
// The handler is stateful by design (PUT replaces the stored
// cart), so the mock is a tiny in-memory store that applies
// upsert/deleteMany for real instead of only recording calls.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import cartHandler from "../api/_lib/me-cart.js";
import meRouter from "../api/me/[...me].js";
import { resetRateLimits } from "../api/_lib/rate-limit.js";
import {
  setAuthEnv,
  clearAuthEnv,
  restoreEnv,
  sessionDepsFor,
  noSessionDeps,
  mockReq,
  mockRes,
} from "./helpers.mjs";

function cartRow(overrides = {}) {
  return {
    id: "ci-1",
    userId: "u1",
    itemId: "riemann-rashomon",
    type: "set",
    qty: 1,
    createdAt: "2026-11-27T00:00:00.000Z",
    updatedAt: "2026-11-27T00:00:00.000Z",
    ...overrides,
  };
}

function mockPrismaCart({ rows = [] } = {}) {
  const store = rows.map((r) => ({ ...r }));
  let seq = rows.length;
  const calls = { findMany: [], upsert: [], deleteMany: [] };
  return {
    calls,
    store,
    cartItem: {
      findMany: async (args) => {
        calls.findMany.push(args);
        return store
          .filter((r) => r.userId === args.where.userId)
          .map((r) => ({ ...r }));
      },
      upsert: async ({ where, update, create }) => {
        calls.upsert.push({ where, update, create });
        const key = where.userId_itemId_type;
        const found = store.find(
          (r) => r.userId === key.userId && r.itemId === key.itemId && r.type === key.type,
        );
        if (found) {
          found.qty = update.qty;
          found.updatedAt = new Date().toISOString();
          return { ...found };
        }
        const row = {
          id: "ci-" + ++seq,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...create,
        };
        store.push(row);
        return { ...row };
      },
      deleteMany: async (args) => {
        calls.deleteMany.push(args);
        const ids = new Set(args.where.id.in);
        let removed = 0;
        for (let i = store.length - 1; i >= 0; i--) {
          if (store[i].userId === args.where.userId && ids.has(store[i].id)) {
            store.splice(i, 1);
            removed++;
          }
        }
        return { count: removed };
      },
    },
  };
}

beforeEach(() => {
  setAuthEnv();
  resetRateLimits();
});
afterEach(() => restoreEnv());

function run(req, prisma, userId = "u1") {
  const res = mockRes();
  return cartHandler(req, res, { prisma, sessionDeps: sessionDepsFor(userId) }).then(() => res);
}

describe("GET /api/me/cart", () => {
  it("lists the user's own lines and answers 401 when signed out", async () => {
    const rows = [
      cartRow(),
      cartRow({ id: "ci-2", itemId: "riemann-rashomon-01", type: "single", qty: 2 }),
    ];
    const res = await run(mockReq({ url: "/api/me/cart" }), mockPrismaCart({ rows }));
    assert.equal(res.statusCode, 200);
    const body = await res.json();
    assert.equal(body.items.length, 2);
    assert.deepEqual(body.items[0], { itemId: "riemann-rashomon", type: "set", qty: 1 });
    assert.deepEqual(Object.keys(body.items[0]).sort(), ["itemId", "qty", "type"]); // no internal ids leak

    const signedOut = mockRes();
    await cartHandler(mockReq({ url: "/api/me/cart" }), signedOut, {
      prisma: mockPrismaCart(),
      sessionDeps: noSessionDeps(),
    });
    assert.equal(signedOut.statusCode, 401);
  });

  it("answers 503 when the database is not configured", async () => {
    clearAuthEnv();
    const res = mockRes();
    await cartHandler(mockReq({ url: "/api/me/cart" }), res, {
      prisma: mockPrismaCart(),
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(res.statusCode, 503);
    assert.equal((await res.json()).error, "db_not_configured");
  });
});

describe("PUT /api/me/cart", () => {
  it("replaces the stored cart: upserts present lines, deletes absent ones", async () => {
    const prisma = mockPrismaCart({
      rows: [
        cartRow(),
        cartRow({ id: "ci-2", itemId: "riemann-rashomon-01", type: "single", qty: 2 }),
      ],
    });
    const res = await run(
      mockReq({
        method: "PUT",
        url: "/api/me/cart",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [
            { itemId: "riemann-rashomon-01", type: "single", qty: 3 },
            { itemId: "kakeya-wang-hong", type: "set", qty: 1 },
          ],
        }),
      }),
      prisma,
    );
    assert.equal(res.statusCode, 200);
    const body = await res.json();
    assert.deepEqual(body.items, [
      { itemId: "riemann-rashomon-01", type: "single", qty: 3 },
      { itemId: "kakeya-wang-hong", type: "set", qty: 1 },
    ]);
    // The set line that was absent from the request is gone.
    assert.equal(prisma.store.find((r) => r.itemId === "riemann-rashomon"), undefined);
    assert.deepEqual(prisma.calls.deleteMany, [
      { where: { userId: "u1", id: { in: ["ci-1"] } } },
    ]);
  });

  it("clears the cart when given an empty items array", async () => {
    const prisma = mockPrismaCart({ rows: [cartRow()] });
    const res = await run(
      mockReq({
        method: "PUT",
        url: "/api/me/cart",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [] }),
      }),
      prisma,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await res.json(), { items: [] });
    assert.equal(prisma.store.length, 0);
  });

  it("drops unknown items and wrong-type ids, clamps qty 1–99", async () => {
    const prisma = mockPrismaCart();
    const res = await run(
      mockReq({
        method: "PUT",
        url: "/api/me/cart",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [
            { itemId: "no-such-sticker", type: "single", qty: 1 },
            { itemId: "riemann-rashomon", type: "single", qty: 1 }, // known id, wrong type
            { itemId: "riemann-rashomon-01", type: "single", qty: 0 },
            { itemId: "riemann-rashomon-02", type: "single", qty: 150 },
            { itemId: "kakeya-wang-hong", type: "set" }, // qty missing -> 1
            { itemId: "complete-pack-30", type: "pack", qty: "3" },
            { itemId: "complete-pack-30", type: "pack", qty: 2 }, // dupe: last wins
          ],
        }),
      }),
      prisma,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await res.json(), {
      items: [
        { itemId: "riemann-rashomon-01", type: "single", qty: 1 },
        { itemId: "riemann-rashomon-02", type: "single", qty: 99 },
        { itemId: "kakeya-wang-hong", type: "set", qty: 1 },
        { itemId: "complete-pack-30", type: "pack", qty: 2 },
      ],
    });
  });

  it("answers 400 when items is not an array, 401 when signed out, 405 otherwise", async () => {
    const bad = await run(
      mockReq({
        method: "PUT",
        url: "/api/me/cart",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: "not-an-array" }),
      }),
      mockPrismaCart(),
    );
    assert.equal(bad.statusCode, 400);

    const signedOut = mockRes();
    await cartHandler(
      mockReq({
        method: "PUT",
        url: "/api/me/cart",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [] }),
      }),
      signedOut,
      { prisma: mockPrismaCart(), sessionDeps: noSessionDeps() },
    );
    assert.equal(signedOut.statusCode, 401);

    const wrongMethod = await run(
      mockReq({ method: "POST", url: "/api/me/cart" }),
      mockPrismaCart(),
    );
    assert.equal(wrongMethod.statusCode, 405);
  });

  it("rate-limits PUTs per user (30/min)", async () => {
    const prisma = mockPrismaCart();
    const body = JSON.stringify({ items: [] });
    let last;
    for (let i = 0; i < 31; i++) {
      last = await run(
        mockReq({
          method: "PUT",
          url: "/api/me/cart",
          headers: { "content-type": "application/json" },
          body,
        }),
        prisma,
        "u-rate",
      );
    }
    assert.equal(last.statusCode, 429);
    assert.equal((await last.json()).error, "rate_limited");
  });
});

describe("me router dispatches /api/me/cart", () => {
  it("routes GET cart through the me router", async () => {
    const prisma = mockPrismaCart({ rows: [cartRow()] });
    const res = mockRes();
    await meRouter(mockReq({ url: "/api/me/cart" }), res, {
      prisma,
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(res.statusCode, 200);
    assert.equal((await res.json()).items.length, 1);
  });
});
