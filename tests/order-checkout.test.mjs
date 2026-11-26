// Cart checkout tests: POST /api/orders/checkout creates one Stripe
// Checkout Session for the whole cart. The Stripe call is mocked —
// no network, no Stripe account.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import checkoutHandler from "../api/_lib/order-checkout.js";
import { resetLinksCache } from "../api/_lib/admin-orders.js";
import { resetRateLimits } from "../api/_lib/rate-limit.js";
import {
  setAuthEnv,
  restoreEnv,
  mockReq,
  mockRes,
} from "./helpers.mjs";

// The real shop links data (local file, no network) — the checkout
// resolves Price IDs from it.
const LINKS_DATA = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web_app", "data", "payment-links.json"),
    "utf8",
  ),
);
const linksFetchFn = async () => ({ ok: true, json: async () => LINKS_DATA });

const SINGLE = "ai-agent-four-faces-03";
const SET = "riemann-rashomon";

function cartReq(items) {
  return mockReq({
    method: "POST",
    url: "/api/orders/checkout",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
}

// A fake Stripe that captures the Checkout Session request.
function stripeMock() {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      json: async () => ({
        id: "cs_test_cart_1",
        url: "https://checkout.stripe.com/c/pay/cs_test_cart_1",
      }),
    };
  };
  return { calls, fetchFn };
}

beforeEach(() => {
  setAuthEnv();
  resetLinksCache();
  resetRateLimits();
  delete process.env.STRIPE_SECRET_KEY;
});
afterEach(() => {
  restoreEnv();
  delete process.env.STRIPE_SECRET_KEY;
});

describe("POST /api/orders/checkout", () => {
  it("answers 503 when the Stripe secret key is not configured", async () => {
    const res = mockRes();
    await checkoutHandler(
      cartReq([{ itemId: SINGLE, type: "single" }]),
      res,
      { fetchFn: linksFetchFn, stripeFetchFn: stripeMock().fetchFn },
    );
    assert.equal(res.statusCode, 503);
    assert.equal((await res.json()).error, "checkout_not_configured");
  });

  it("rejects an empty cart, an unknown item and a bad type", async () => {
    const cases = [
      { items: [] },
      { items: [{ itemId: "no-such-sticker", type: "single" }] },
      { items: [{ itemId: SINGLE, type: "sticker" }] },
    ];
    for (const body of cases) {
      const res = mockRes();
      await checkoutHandler(
        mockReq({
          method: "POST",
          url: "/api/orders/checkout",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        res,
        { stripeSecret: "sk_test_cart", fetchFn: linksFetchFn },
      );
      assert.equal(res.statusCode, 400);
    }
  });

  it("creates one session with the cart's Price IDs, quantities and metadata", async () => {
    const stripe = stripeMock();
    const res = mockRes();
    await checkoutHandler(
      cartReq([
        { itemId: SINGLE, type: "single", quantity: 3 },
        { itemId: SET, type: "set" },
      ]),
      res,
      { stripeSecret: "sk_test_cart", fetchFn: linksFetchFn, stripeFetchFn: stripe.fetchFn },
    );
    assert.equal(res.statusCode, 200);
    const body = await res.json();
    assert.equal(body.sessionId, "cs_test_cart_1");
    assert.equal(body.url, "https://checkout.stripe.com/c/pay/cs_test_cart_1");
    assert.equal(stripe.calls.length, 1);
    assert.equal(stripe.calls[0].url, "https://api.stripe.com/v1/checkout/sessions");
    assert.equal(stripe.calls[0].opts.method, "POST");
    assert.equal(
      stripe.calls[0].opts.headers.Authorization,
      "Bearer sk_test_cart",
    );
    const params = new URLSearchParams(stripe.calls[0].opts.body);
    assert.equal(params.get("mode"), "payment");
    assert.equal(params.get("line_items[0][price]"), LINKS_DATA.singles[SINGLE].price_id);
    assert.equal(params.get("line_items[0][quantity]"), "3");
    assert.equal(params.get("line_items[1][price]"), LINKS_DATA.sets[SET].price_id);
    assert.equal(params.get("line_items[1][quantity]"), "1");
    assert.equal(params.get("metadata[cart_count]"), "2");
    assert.equal(params.get("metadata[cart_0]"), SINGLE);
    assert.equal(params.get("metadata[cart_type_0]"), "single");
    assert.equal(params.get("metadata[cart_qty_0]"), "3");
    assert.equal(params.get("metadata[cart_1]"), SET);
    assert.equal(params.get("metadata[cart_type_1]"), "set");
    assert.equal(params.get("metadata[cart_qty_1]"), "1");
    assert.equal(params.get("metadata[shop_type]"), "cart");
    assert.equal(params.get("automatic_tax[enabled]"), "true");
    assert.equal(
      params.get("success_url"),
      "https://sutekka.gobblemon.com/#/download?session_id={CHECKOUT_SESSION_ID}",
    );
    assert.equal(params.get("cancel_url"), "https://sutekka.gobblemon.com/#/cart");
  });

  it("dedups the same item and prices the pack from the catalogue", async () => {
    const stripe = stripeMock();
    const res = mockRes();
    await checkoutHandler(
      cartReq([
        { itemId: SINGLE, type: "single", quantity: 2 },
        { itemId: SINGLE, type: "single", quantity: 5 },
        { itemId: "complete-pack-30", type: "pack" },
      ]),
      res,
      { stripeSecret: "sk_test_cart", fetchFn: linksFetchFn, stripeFetchFn: stripe.fetchFn },
    );
    assert.equal(res.statusCode, 200);
    const params = new URLSearchParams(stripe.calls[0].opts.body);
    assert.equal(params.get("metadata[cart_count]"), "2");
    assert.equal(params.get("line_items[0][price]"), LINKS_DATA.singles[SINGLE].price_id);
    assert.equal(params.get("line_items[0][quantity]"), "2"); // first line wins
    assert.equal(params.get("line_items[1][price]"), LINKS_DATA.pack.price_id);
  });

  it("rejects out-of-range quantities with 400", async () => {
    for (const quantity of [0, 100, 1.5, "3"]) {
      const res = mockRes();
      await checkoutHandler(
        cartReq([{ itemId: SINGLE, type: "single", quantity }]),
        res,
        { stripeSecret: "sk_test_cart", fetchFn: linksFetchFn, stripeFetchFn: stripeMock().fetchFn },
      );
      assert.equal(res.statusCode, 400, `quantity ${quantity} should be rejected`);
      assert.equal((await res.json()).error, "invalid_body");
    }
  });

  it("answers 502 when Stripe answers with an error", async () => {
    const res = mockRes();
    await checkoutHandler(cartReq([{ itemId: SINGLE, type: "single" }]), res, {
      stripeSecret: "sk_test_cart",
      fetchFn: linksFetchFn,
      stripeFetchFn: async () => ({ ok: false, status: 401 }),
    });
    assert.equal(res.statusCode, 502);
    assert.equal((await res.json()).error, "stripe_error");
  });

  it("rejects other methods with 405", async () => {
    const res = mockRes();
    await checkoutHandler(
      mockReq({ method: "GET", url: "/api/orders/checkout" }),
      res,
      { stripeSecret: "sk_test_cart" },
    );
    assert.equal(res.statusCode, 405);
  });
});
