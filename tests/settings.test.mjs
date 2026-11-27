// Public GET /api/settings — the hide_buy_buttons default.
// Buy buttons are hidden by default: an absent hide_buy_buttons key
// means hidden, the admin unchecks the toggle to show them again.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import settingsHandler from "../api/settings.js";
import { setAuthEnv, restoreEnv, mockReq, mockRes } from "./helpers.mjs";

beforeEach(() => setAuthEnv());
afterEach(() => restoreEnv());

function mockPrisma(rows) {
  return {
    siteSetting: {
      findMany: async () => rows.map(([key, value]) => ({ key, value, updatedAt: new Date() })),
    },
  };
}

describe("GET /api/settings hideBuyButtons", () => {
  it("defaults to hidden when the key is absent", async () => {
    const res = mockRes();
    await settingsHandler(mockReq({ url: "/api/settings" }), res, { prisma: mockPrisma([]) });
    assert.deepEqual(await res.json(), {
      shopClosed: false,
      announcement: "",
      hiddenItems: [],
      uploadsEnabled: false,
      hideBuyButtons: true,
    });
  });

  it("returns false when the admin stored false", async () => {
    const res = mockRes();
    await settingsHandler(mockReq({ url: "/api/settings" }), res, {
      prisma: mockPrisma([["hide_buy_buttons", "false"]]),
    });
    assert.equal((await res.json()).hideBuyButtons, false);
  });

  it("returns true when the admin stored true", async () => {
    const res = mockRes();
    await settingsHandler(mockReq({ url: "/api/settings" }), res, {
      prisma: mockPrisma([["hide_buy_buttons", "true"]]),
    });
    assert.equal((await res.json()).hideBuyButtons, true);
  });

  it("rejects non-GET methods", async () => {
    const res = mockRes();
    await settingsHandler(mockReq({ method: "POST", url: "/api/settings" }), res, { prisma: mockPrisma([]) });
    assert.equal(res.statusCode, 405);
  });
});
