// Admin order helpers tests (pure): file pinning, DPI, serializers.
// No database, no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lib = require("../api/_lib/admin-orders.js");

const LINKS_DATA = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web_app", "data", "payment-links.json"),
    "utf8",
  ),
);

describe("stickerFilePath", () => {
  it("maps a sticker id to its file path", () => {
    assert.equal(
      lib.stickerFilePath("ai-agent-four-faces-03"),
      "stickers/ai-agent-four-faces/stickers/03.png",
    );
    assert.equal(
      lib.stickerFilePath("riemann-rashomon-01"),
      "stickers/riemann-rashomon/stickers/01.png",
    );
  });
});

describe("resolveOrderFiles", () => {
  it("pins one file for a single", () => {
    const files = lib.resolveOrderFiles("ai-agent-four-faces-03", "single", LINKS_DATA);
    assert.deepEqual(files, [
      {
        itemId: "ai-agent-four-faces-03",
        file: "stickers/ai-agent-four-faces/stickers/03.png",
        width: 1600,
        height: 1680,
      },
    ]);
  });

  it("pins all 8 files for a set", () => {
    const files = lib.resolveOrderFiles("riemann-rashomon", "set", LINKS_DATA);
    assert.equal(files.length, 8);
    assert.equal(files[0].file, "stickers/riemann-rashomon/stickers/01.png");
    assert.equal(files[7].file, "stickers/riemann-rashomon/stickers/08.png");
    assert.ok(files.every((f) => f.width === 1600 && f.height === 1680));
  });

  it("pins all 30 files for the pack", () => {
    const files = lib.resolveOrderFiles("complete-pack-30", "pack", LINKS_DATA);
    assert.equal(files.length, 30);
    assert.equal(files[0].itemId, "riemann-rashomon-01");
    assert.equal(files[29].itemId, "lauren-tan-20-agents-06");
  });

  it("returns null for an unknown item or missing data", () => {
    assert.equal(lib.resolveOrderFiles("nope-01", "single", LINKS_DATA).length, 1); // single pins by id alone
    assert.equal(lib.resolveOrderFiles("no-such-set", "set", LINKS_DATA), null);
    assert.equal(lib.resolveOrderFiles("complete-pack-30", "pack", null), null);
    assert.equal(lib.resolveOrderFiles("x", "weird-type", LINKS_DATA), null);
  });
});

describe("dpiAt", () => {
  it("reports 320 DPI at 5 inches for a 1600px file", () => {
    assert.equal(lib.dpiAt({ width: 1600, height: 1680 }, 5), 320);
    assert.equal(lib.dpiAt({ width: 1600, height: 1680 }, 6), 267);
  });
});

describe("serializers", () => {
  const ROW = {
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
    filesJson: [{ itemId: "ai-agent-four-faces-03", file: "stickers/ai-agent-four-faces/stickers/03.png", width: 1600, height: 1680 }],
    printStatus: "queued",
    shippingName: "Test Buyer",
    shippingAddress: { line1: "1 Test St", city: "Singapore", postal: "123456", country: "Singapore" },
    trackingCourier: "SingPost",
    trackingNumber: "RF123",
    invoiceId: "in_1",
    invoiceNumber: "INV-1",
    invoiceRequestedAt: new Date("2026-11-26T10:00:00Z"),
    adminNotes: "handle with care",
    refundedAt: null,
    cancelReason: null,
    createdAt: new Date("2026-11-26T09:00:00Z"),
    updatedAt: new Date("2026-11-26T09:00:00Z"),
  };

  it("adminOrder exposes everything the admin needs, including Stripe ids", () => {
    const o = lib.adminOrder(ROW);
    assert.equal(o.stripeSessionId, "cs_1");
    assert.equal(o.buyerEmail, "buyer@example.com");
    assert.equal(o.files.length, 1);
    assert.equal(o.printStatus, "queued");
    assert.equal(o.trackingNumber, "RF123");
    assert.equal(o.invoiceNumber, "INV-1");
  });

  it("buyerFulfilment exposes fulfilment only — no Stripe ids, no email", () => {
    const f = lib.buyerFulfilment(ROW);
    assert.equal(f.printStatus, "queued");
    assert.equal(f.trackingNumber, "RF123");
    assert.equal(f.invoiceNumber, "INV-1");
    assert.equal(f.hasShippingAddress, true);
    assert.equal("stripeSessionId" in f, false);
    assert.equal("buyerEmail" in f, false);
    assert.equal("files" in f, false);
  });
});
