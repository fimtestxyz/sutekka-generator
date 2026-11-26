// Stripe webhook tests: signature verification (pure) + the webhook
// handler with a mocked Prisma client. No network, no Stripe account.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import webhookHandler from "../api/stripe/webhook.js";
import {
  verifyStripeSignature,
  resolveOrderItem,
} from "../api/_lib/stripe-webhook.js";
import { resetLinksCache } from "../api/_lib/admin-orders.js";
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

// The real shop links data (local file, no network) — the webhook
// pins files from it, so the pinning tests assert against the real
// catalogue.
const LINKS_DATA = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web_app", "data", "payment-links.json"),
    "utf8",
  ),
);
const linksFetchFn = async () => ({ ok: true, json: async () => LINKS_DATA });

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
    payment_method_types: ["card"],
    ...overrides,
  };
  return JSON.stringify({
    id: "evt_test_1",
    type: "checkout.session.completed",
    data: { object: session },
  });
}

function mockPrismaOrder() {
  const calls = { upsert: [], webhookEvent: [] };
  return {
    calls,
    order: {
      upsert: async (args) => {
        calls.upsert.push(args);
        return { id: "ord_1", ...args.create };
      },
    },
    webhookEvent: {
      create: async (args) => {
        calls.webhookEvent.push(args);
        return { id: "we_1", ...args.data };
      },
    },
  };
}

beforeEach(() => {
  setAuthEnv();
  resetLinksCache();
});
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
      { prisma, webhookSecret: SECRET, fetchFn: linksFetchFn },
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
    // Admin pinning (ADMIN.md §3): the exact files bought + the
    // payment method type are stored on the order at webhook time.
    assert.equal(data.payMethodType, "card");
    assert.deepEqual(data.filesJson, [
      {
        itemId: "ai-agent-four-faces-03",
        file: "stickers/ai-agent-four-faces/stickers/03.png",
        width: 1600,
        height: 1680,
      },
    ]);
    // A redelivery must never overwrite admin-managed fields: the
    // update branch carries Stripe-owned facts only.
    const update = prisma.calls.upsert[0].update;
    assert.equal("status" in update, false);
    assert.equal("printStatus" in update, false);
    assert.equal("filesJson" in update, false);
    assert.equal("payMethodType" in update, false);
    // The processed event is logged for the admin health view.
    assert.equal(prisma.calls.webhookEvent.length, 1);
    assert.equal(prisma.calls.webhookEvent[0].data.type, "checkout.session.completed");
    assert.equal(prisma.calls.webhookEvent[0].data.status, "ok");
  });

  it("pins all 8 files for a set purchase", async () => {
    const prisma = mockPrismaOrder();
    const raw = sessionEvent({
      metadata: { shop_item: "riemann-rashomon", shop_type: "set" },
    });
    const res = mockRes();
    await webhookHandler(
      mockReq({ method: "POST", url: "/api/stripe/webhook", headers: { "stripe-signature": sign(raw) }, body: raw }),
      res,
      { prisma, webhookSecret: SECRET, fetchFn: linksFetchFn },
    );
    assert.equal(res.statusCode, 200);
    const files = prisma.calls.upsert[0].create.filesJson;
    assert.equal(files.length, 8);
    assert.equal(files[0].file, "stickers/riemann-rashomon/stickers/01.png");
    assert.equal(files[7].file, "stickers/riemann-rashomon/stickers/08.png");
  });

  it("stores null files when the links data cannot be fetched", async () => {
    const prisma = mockPrismaOrder();
    const raw = sessionEvent();
    const res = mockRes();
    await webhookHandler(
      mockReq({ method: "POST", url: "/api/stripe/webhook", headers: { "stripe-signature": sign(raw) }, body: raw }),
      res,
      {
        prisma,
        webhookSecret: SECRET,
        fetchFn: async () => {
          throw new Error("network down");
        },
      },
    );
    assert.equal(res.statusCode, 200);
    assert.equal(prisma.calls.upsert[0].create.filesJson, null);
  });

  it("falls back to the link map when the session has no metadata", async () => {
    const prisma = mockPrismaOrder();
    const raw = sessionEvent({ metadata: {} });
    const res = mockRes();
    await webhookHandler(
      mockReq({ method: "POST", url: "/api/stripe/webhook", headers: { "stripe-signature": sign(raw) }, body: raw }),
      res,
      { prisma, webhookSecret: SECRET, fetchFn: linksFetchFn },
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
      { prisma, webhookSecret: SECRET, fetchFn: linksFetchFn },
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
      { prisma, webhookSecret: SECRET, fetchFn: linksFetchFn },
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await res.json(), { received: true, ignored: true });
    assert.equal(prisma.calls.upsert.length, 0);
    // …but the ignored event is still logged for the health view.
    assert.equal(prisma.calls.webhookEvent.length, 1);
    assert.equal(prisma.calls.webhookEvent[0].data.type, "payment_intent.created");
  });

  it("rejects a bad signature with 400 and logs the failure", async () => {
    const prisma = mockPrismaOrder();
    const raw = sessionEvent();
    const res = mockRes();
    await webhookHandler(
      mockReq({ method: "POST", url: "/api/stripe/webhook", headers: { "stripe-signature": sign(raw, "whsec_wrong") }, body: raw }),
      res,
      { prisma, webhookSecret: SECRET, fetchFn: linksFetchFn },
    );
    assert.equal(res.statusCode, 400);
    assert.equal(prisma.calls.upsert.length, 0);
    assert.equal(prisma.calls.webhookEvent.length, 1);
    assert.equal(prisma.calls.webhookEvent[0].data.status, "error");
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
