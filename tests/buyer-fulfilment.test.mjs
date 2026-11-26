// Buyer fulfilment tests: POST /api/orders/shipping and
// POST /api/orders/invoice-request. Mocked Prisma — no database.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import shippingHandler from "../api/_lib/order-shipping.js";
import invoiceRequestHandler from "../api/_lib/order-invoice-request.js";
import settingsHandler from "../api/settings.js";
import { resetRateLimits } from "../api/_lib/rate-limit.js";
import {
  setAuthEnv,
  restoreEnv,
  mockReq,
  mockRes,
} from "./helpers.mjs";

const ORDER = {
  id: "ord_1",
  stripeSessionId: "cs_1",
  buyerEmail: "buyer@example.com",
  itemId: "ai-agent-four-faces-03",
  itemType: "single",
  amountTotal: 400,
  currency: "sgd",
  status: "paid",
  printStatus: "none",
  shippingAddress: null,
};

/**
 * @param {{ order?: any, invoiceRequest?: any, sessionRows?: any[] }} [opts]
 */
function mockPrisma({ order = ORDER, invoiceRequest = null, sessionRows } = {}) {
  const calls = { orderUpdate: [], invoiceUpsert: [], orderInvoiceUpdate: [] };
  const rows = sessionRows !== undefined ? sessionRows : order ? [order] : [];
  return {
    calls,
    order: {
      findUnique: async ({ where }) => {
        if (where.stripeSessionId) return order && order.stripeSessionId === where.stripeSessionId ? order : null;
        if (where.id) return order && order.id === where.id ? order : null;
        return null;
      },
      findMany: async ({ where }) => {
        if (where.stripeSessionId) {
          return rows.filter((r) => r.stripeSessionId === where.stripeSessionId);
        }
        return rows;
      },
      update: async ({ where, data }) => {
        calls.orderUpdate.push({ where, data });
        const updated = { ...order, ...data };
        if (where.id === order.id) Object.assign(order, data);
        calls.orderInvoiceUpdate.push(data);
        return updated;
      },
    },
    invoiceRequest: {
      findUnique: async () => invoiceRequest,
      upsert: async ({ create, update }) => {
        calls.invoiceUpsert.push({ create, update });
        return { id: "inv_1", ...create };
      },
    },
  };
}

const ADDRESS = {
  line1: "1 Test Street",
  city: "Singapore",
  postal: "123456",
  country: "Singapore",
};

beforeEach(() => {
  setAuthEnv();
  resetRateLimits();
});
afterEach(() => restoreEnv());

describe("POST /api/orders/shipping", () => {
  it("saves the address and queues the order for printing", async () => {
    const prisma = mockPrisma();
    const res = mockRes();
    await shippingHandler(
      mockReq({
        method: "POST",
        url: "/api/orders/shipping",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "cs_1",
          email: "buyer@example.com",
          name: "Test Buyer",
          address: ADDRESS,
        }),
      }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 200);
    const body = await res.json();
    assert.equal(body.order.id, "ord_1");
    assert.equal(body.order.printStatus, "queued");
    assert.equal(body.order.hasShippingAddress, true);
    assert.equal(prisma.calls.orderUpdate[0].data.shippingName, "Test Buyer");
    assert.deepEqual(prisma.calls.orderUpdate[0].data.shippingAddress, ADDRESS);
  });

  it("does not reset a print status that is already past queued", async () => {
    const prisma = mockPrisma({ order: { ...ORDER, printStatus: "printing" } });
    const res = mockRes();
    await shippingHandler(
      mockReq({
        method: "POST",
        url: "/api/orders/shipping",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId: "ord_1",
          email: "buyer@example.com",
          name: "Test Buyer",
          address: ADDRESS,
        }),
      }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 200);
    assert.equal((await res.json()).order.printStatus, "printing");
    assert.equal("printStatus" in prisma.calls.orderUpdate[0].data, false);
  });

  it("rejects a wrong email with 403 and an unknown order with 404", async () => {
    const prisma = mockPrisma();
    const res1 = mockRes();
    await shippingHandler(
      mockReq({
        method: "POST",
        url: "/api/orders/shipping",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "cs_1", email: "someone-else@example.com", name: "X", address: ADDRESS }),
      }),
      res1,
      { prisma },
    );
    assert.equal(res1.statusCode, 403);
    const res2 = mockRes();
    await shippingHandler(
      mockReq({
        method: "POST",
        url: "/api/orders/shipping",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "cs_nope", email: "buyer@example.com", name: "X", address: ADDRESS }),
      }),
      res2,
      { prisma },
    );
    assert.equal(res2.statusCode, 404);
  });

  it("rejects a bad address with 400", async () => {
    const prisma = mockPrisma();
    const res = mockRes();
    await shippingHandler(
      mockReq({
        method: "POST",
        url: "/api/orders/shipping",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "cs_1", email: "buyer@example.com", name: "X", address: { line1: "" } }),
      }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 400);
  });

  it("answers 400 when a session id covers several items (cart)", async () => {
    const second = { ...ORDER, id: "ord_2", itemId: "kakeya-wang-hong", itemType: "set" };
    const prisma = mockPrisma({ sessionRows: [ORDER, second] });
    const res = mockRes();
    await shippingHandler(
      mockReq({
        method: "POST",
        url: "/api/orders/shipping",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "cs_1", email: "buyer@example.com", name: "X", address: ADDRESS }),
      }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 400);
    assert.equal((await res.json()).error, "ambiguous_session");
  });
});

describe("POST /api/orders/invoice-request", () => {
  it("creates an open request and stamps the order", async () => {
    const prisma = mockPrisma();
    const res = mockRes();
    await invoiceRequestHandler(
      mockReq({
        method: "POST",
        url: "/api/orders/invoice-request",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "cs_1", email: "buyer@example.com" }),
      }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 201);
    assert.equal((await res.json()).request.status, "open");
    assert.equal(prisma.calls.invoiceUpsert.length, 1);
    assert.equal(prisma.calls.invoiceUpsert[0].create.orderId, "ord_1");
    assert.ok(prisma.calls.orderUpdate[0].data.invoiceRequestedAt);
  });

  it("answers 409 when an open request already exists", async () => {
    const prisma = mockPrisma({
      invoiceRequest: { id: "inv_1", orderId: "ord_1", status: "open" },
    });
    const res = mockRes();
    await invoiceRequestHandler(
      mockReq({
        method: "POST",
        url: "/api/orders/invoice-request",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: "ord_1", email: "buyer@example.com" }),
      }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 409);
    assert.equal((await res.json()).error, "invoice_request_exists");
  });

  it("rejects a wrong email with 403", async () => {
    const prisma = mockPrisma();
    const res = mockRes();
    await invoiceRequestHandler(
      mockReq({
        method: "POST",
        url: "/api/orders/invoice-request",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "cs_1", email: "intruder@example.com" }),
      }),
      res,
      { prisma },
    );
    assert.equal(res.statusCode, 403);
  });
});

describe("GET /api/settings", () => {
  it("returns the public settings, defaulting to shop open", async () => {
    const prisma = {
      siteSetting: {
        findMany: async () => [
          { key: "shop_closed", value: "false" },
          { key: "announcement", value: "Hello" },
          { key: "hidden_items", value: JSON.stringify(["riemann-rashomon"]) },
        ],
      },
    };
    const res = mockRes();
    await settingsHandler(mockReq({ method: "GET", url: "/api/settings" }), res, { prisma });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await res.json(), {
      shopClosed: false,
      announcement: "Hello",
      hiddenItems: ["riemann-rashomon"],
      uploadsEnabled: false,
    });
  });

  it("defaults everything when no settings rows exist", async () => {
    const prisma = { siteSetting: { findMany: async () => [] } };
    const res = mockRes();
    await settingsHandler(mockReq({ method: "GET", url: "/api/settings" }), res, { prisma });
    assert.deepEqual(await res.json(), { shopClosed: false, announcement: "", hiddenItems: [], uploadsEnabled: false });
  });
});
