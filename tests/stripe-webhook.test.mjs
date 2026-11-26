// Stripe webhook tests: signature verification (pure) + the webhook
// handler with a mocked Prisma client. No network, no Stripe account.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import webhookHandler from "../api/stripe/webhook.js";
import {
  verifyStripeSignature,
  resolveOrderItem,
} from "../api/_lib/stripe-webhook.js";
import {
  setAuthEnv,
  clearAuthEnv,
  restoreEnv,
  mockReq,
  mockRes,
} from "./helpers.mjs";

const require = createRequire(import.meta.url);
const linkMap = require("../api/_lib/payment-link-map.js");
const KNOWN_LINK_ID = Object.keys(linkMap)[0];
const KNOWN_ITEM = linkMap[KNOWN_LINK_ID];

const SECRET = "whsec_test_secret";
const TS = 1793000000; // fixed "now" for the pure verify tests only;
// Handler tests sign with the real clock (the handler checks the
// timestamp against Date.now()), so sign() defaults ts to now.
function sign(body, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${body}`, "utf8")
    .digest("hex");
  return `t=${ts},v1=${sig}`;
}

function sessionEvent(overrides = {}) {
  const session = {
    id: "cs_test_123",
    payment_link: KNOWN_LINK_ID,
    payment_intent: "pi_test_123",
    amount_total: 400,
    currency: "sgd",
    customer_details: { email: "buyer@example.com" },
    metadata: { shop_item: "ai-agent-four-faces-03", shop_type: "single" },
    ...overrides,
  };
  return JSON.stringify({
    id: "evt_test_1",
    type: "checkout.session.completed",
    data: { object: session },
  });
}

function mockPrismaOrder() {
  const calls = { upsert: [] };
  return {
    calls,
    order: {
      upsert: async (args) => {
        calls.upsert.push(args);
        return { id: "ord_1", ...args.create };
      },
    },
  };
}

beforeEach(() => setAuthEnv());
afterEach(() => restoreEnv());

describe("verifyStripeSignature", () => {
  const body = Buffer.from('{"hello":"world"}');
  it("accepts a correct signature", () => {
    assert.equal(verifyStripeSignature(body, sign(body.toString(), SECRET, TS), SECRET, TS), true);
  });
  it("rejects a tampered body", () => {
    assert.equal(
      verifyStripeSignature(Buffer.from('{"hello":"mars"}'), sign(body.toString(), SECRET, TS), SECRET, TS),
      false,
    );
  });
  it("rejects the wrong secret", () => {
    assert.equal(verifyStripeSignature(body, sign(body.toString(), "whsec_other", TS), SECRET, TS), false);
  });
  it("rejects a stale timestamp", () => {
    assert.equal(verifyStripeSignature(body, sign(body.toString(), SECRET, TS - 301), SECRET, TS), false);
  });
  it("rejects a missing or garbage header", () => {
    assert.equal(verifyStripeSignature(body, "", SECRET, TS), false);
    assert.equal(verifyStripeSignature(body, "nonsense", SECRET, TS), false);
  });
});

describe("resolveOrderItem", () => {
  it("prefers session metadata", () => {
    assert.deepEqual(
      resolveOrderItem({ metadata: { shop_item: "x-01", shop_type: "single" }, payment_link: KNOWN_LINK_ID }, linkMap),
      { itemId: "x-01", itemType: "single" },
    );
  });
  it("falls back to the link map", () => {
    assert.deepEqual(
      resolveOrderItem({ metadata: {}, payment_link: KNOWN_LINK_ID }, linkMap),
      { itemId: KNOWN_ITEM.itemId, itemType: KNOWN_ITEM.type },
    );
  });
  it("returns null when nothing resolves", () => {
    assert.equal(resolveOrderItem({ metadata: {}, payment_link: "plink_nope" }, linkMap), null);
  });
});

describe("POST /api/stripe/webhook", () => {
  it("records an order from a completed session (metadata path)", async () => {
    const prisma = mockPrismaOrder();
    const raw = sessionEvent();
    const res = mockRes();
    await webhookHandler(
      mockReq({ method: "POST", url: "/api/stripe/webhook", headers: { "stripe-signature": sign(raw) }, body: raw }),
      res,
      { prisma, webhookSecret: SECRET },
    );
    assert.equal(res.statusCode, 200);
    assert.equal((await res.json()).received, true);
    assert.equal(prisma.calls.upsert.length, 1);
    const data = prisma.calls.upsert[0].create;
    assert.equal(data.stripeSessionId, "cs_test_123");
    assert.equal(data.itemId, "ai-agent-four-faces-03");
    assert.equal(data.itemType, "single");
    assert.equal(data.amountTotal, 400);
    assert.equal(data.buyerEmail, "buyer@example.com");
    assert.equal(data.status, "paid");
  });

  it("falls back to the link map when the session has no metadata", async () => {
    const prisma = mockPrismaOrder();
    const raw = sessionEvent({ metadata: {} });
    const res = mockRes();
    await webhookHandler(
      mockReq({ method: "POST", url: "/api/stripe/webhook", headers: { "stripe-signature": sign(raw) }, body: raw }),
      res,
      { prisma, webhookSecret: SECRET },
    );
    assert.equal(res.statusCode, 200);
    assert.equal(prisma.calls.upsert[0].create.itemId, KNOWN_ITEM.itemId);
  });

  it("still records the payment when the item cannot be resolved", async () => {
    const prisma = mockPrismaOrder();
    const raw = sessionEvent({ metadata: {}, payment_link: "plink_nope" });
    const res = mockRes();
    await webhookHandler(
      mockReq({ method: "POST", url: "/api/stripe/webhook", headers: { "stripe-signature": sign(raw) }, body: raw }),
      res,
      { prisma, webhookSecret: SECRET },
    );
    assert.equal(res.statusCode, 200);
    assert.equal(prisma.calls.upsert[0].create.itemId, "unknown");
  });

  it("ignores other event types without touching the database", async () => {
    const prisma = mockPrismaOrder();
    const raw = JSON.stringify({ id: "evt_2", type: "payment_intent.created", data: { object: {} } });
    const res = mockRes();
    await webhookHandler(
      mockReq({ method: "POST", url: "/api/stripe/webhook", headers: { "stripe-signature": sign(raw) }, body: raw }),
      res,
      { prisma, webhookSecret: SECRET },
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await res.json(), { received: true, ignored: true });
    assert.equal(prisma.calls.upsert.length, 0);
  });

  it("rejects a bad signature with 400", async () => {
    const prisma = mockPrismaOrder();
    const raw = sessionEvent();
    const res = mockRes();
    await webhookHandler(
      mockReq({ method: "POST", url: "/api/stripe/webhook", headers: { "stripe-signature": sign(raw, "whsec_wrong") }, body: raw }),
      res,
      { prisma, webhookSecret: SECRET },
    );
    assert.equal(res.statusCode, 400);
    assert.equal(prisma.calls.upsert.length, 0);
  });

  it("answers 503 when the webhook secret is not configured", async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      const res = mockRes();
      await webhookHandler(
        mockReq({ method: "POST", url: "/api/stripe/webhook", headers: {}, body: "{}" }),
        res,
        { prisma: mockPrismaOrder() },
      );
      assert.equal(res.statusCode, 503);
    } finally {
      if (saved !== undefined) process.env.STRIPE_WEBHOOK_SECRET = saved;
    }
  });

  it("rejects non-POST with 405", async () => {
    const res = mockRes();
    await webhookHandler(
      mockReq({ method: "GET", url: "/api/stripe/webhook" }),
      res,
      { prisma: mockPrismaOrder(), webhookSecret: SECRET },
    );
    assert.equal(res.statusCode, 405);
  });
});
