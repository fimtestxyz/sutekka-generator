// Order lookup tests (mocked Prisma). No database, no Stripe account.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import lookupHandler from "../api/_lib/order-lookup.js";
import {
  setAuthEnv,
  clearAuthEnv,
  restoreEnv,
  mockReq,
  mockRes,
} from "./helpers.mjs";

const ORDER = {
  id: "ord_abc",
  itemId: "ai-agent-four-faces-03",
  itemType: "single",
  amountTotal: 400,
  currency: "sgd",
  status: "paid",
  createdAt: new Date("2026-11-26T15:00:00Z"),
};

function mockPrismaOrder({ found = ORDER, list = [ORDER] } = {}) {
  const calls = { findUnique: [], findMany: [], updateMany: [] };
  return {
    calls,
    order: {
      findUnique: async (args) => {
        calls.findUnique.push(args);
        return found;
      },
      findMany: async (args) => {
        calls.findMany.push(args);
        return list;
      },
      updateMany: async (args) => {
        calls.updateMany.push(args);
        return { count: found ? 1 : 0 };
      },
    },
  };
}

beforeEach(() => setAuthEnv());
afterEach(() => restoreEnv());

describe("GET /api/orders/lookup", () => {
  it("returns an order by session id, without leaking buyer or Stripe ids", async () => {
    const prisma = mockPrismaOrder();
    const res = mockRes();
    await lookupHandler(
      mockReq({ method: "GET", url: "/api/orders/lookup?session_id=cs_test_123" }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 200);
    const body = await res.json();
    assert.equal(body.order.id, "ord_abc");
    assert.equal(body.order.itemId, "ai-agent-four-faces-03");
    assert.equal(body.order.amountTotal, 400);
    assert.equal("buyerEmail" in body.order, false);
    assert.equal("stripeSessionId" in body.order, false);
  });

  it("answers 404 for an unknown session id", async () => {
    const prisma = mockPrismaOrder({ found: null });
    const res = mockRes();
    await lookupHandler(
      mockReq({ method: "GET", url: "/api/orders/lookup?session_id=cs_nope" }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 404);
    assert.equal((await res.json()).error, "order_not_found");
  });

  it("returns an order by order id", async () => {
    const prisma = mockPrismaOrder();
    const res = mockRes();
    await lookupHandler(
      mockReq({ method: "GET", url: "/api/orders/lookup?order_id=ord_abc" }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 200);
    assert.equal((await res.json()).order.id, "ord_abc");
  });

  it("lists a buyer's orders by email", async () => {
    const prisma = mockPrismaOrder({ list: [ORDER, { ...ORDER, id: "ord_def" }] });
    const res = mockRes();
    await lookupHandler(
      mockReq({ method: "GET", url: "/api/orders/lookup?email=buyer%40example.com" }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 200);
    assert.equal((await res.json()).orders.length, 2);
  });

  it("rejects a malformed email and a missing lookup key", async () => {
    const res1 = mockRes();
    await lookupHandler(
      mockReq({ method: "GET", url: "/api/orders/lookup?email=not-an-email" }),
      res1,
      { prisma: mockPrismaOrder() },
    );
    assert.equal(res1.statusCode, 400);
    const res2 = mockRes();
    await lookupHandler(
      mockReq({ method: "GET", url: "/api/orders/lookup" }),
      res2,
      { prisma: mockPrismaOrder() },
    );
    assert.equal(res2.statusCode, 400);
  });
});

describe("POST /api/orders/lookup", () => {
  it("marks a paid order delivered", async () => {
    const prisma = mockPrismaOrder();
    const res = mockRes();
    await lookupHandler(
      mockReq({
        method: "POST",
        url: "/api/orders/lookup",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: "cs_test_123" }),
      }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 200);
    assert.equal(prisma.calls.updateMany.length, 1);
    assert.deepEqual(prisma.calls.updateMany[0].where, {
      stripeSessionId: "cs_test_123",
      status: "paid",
    });
    assert.equal((await res.json()).order.id, "ord_abc");
  });

  it("answers 404 for an unknown session id and 400 without one", async () => {
    const res1 = mockRes();
    await lookupHandler(
      mockReq({
        method: "POST",
        url: "/api/orders/lookup",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: "cs_nope" }),
      }),
      res1,
      { prisma: mockPrismaOrder({ found: null }) },
    );
    assert.equal(res1.statusCode, 404);
    const res2 = mockRes();
    await lookupHandler(
      mockReq({
        method: "POST",
        url: "/api/orders/lookup",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      res2,
      { prisma: mockPrismaOrder() },
    );
    assert.equal(res2.statusCode, 400);
  });

  it("rejects other methods with 405", async () => {
    const res = mockRes();
    await lookupHandler(
      mockReq({ method: "PUT", url: "/api/orders/lookup" }),
      res,
      { prisma: mockPrismaOrder() },
    );
    assert.equal(res.statusCode, 405);
  });
});
