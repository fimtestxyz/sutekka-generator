// Prisma singleton tests — no database needed. getPrisma() only
// constructs the client (pg connects lazily on first query), so a
// dummy URL is enough to prove construction works.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getPrisma, isConfigured } from "../api/_lib/prisma.js";

const ORIGINAL_URL = process.env.DATABASE_URL;

beforeEach(() => {
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_URL;
});

describe("api/_lib/prisma", () => {
  it("isConfigured() is false without DATABASE_URL", () => {
    assert.equal(isConfigured(), false);
  });

  it("getPrisma() throws db_not_configured without DATABASE_URL", () => {
    assert.throws(() => getPrisma(), /db_not_configured/);
  });

  it("getPrisma() constructs a client with a dummy URL (no connection attempted)", () => {
    process.env.DATABASE_URL =
      "postgresql://placeholder:placeholder@placeholder-host:5432/sutekka";
    const prisma = getPrisma();
    assert.equal(typeof prisma.$disconnect, "function");
    assert.equal(typeof prisma.sticker.upsert, "function");
    // Singleton: second call returns the same instance.
    assert.equal(getPrisma(), prisma);
  });
});
