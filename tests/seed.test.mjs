// Seed tests — run against the real generated index.json with a
// mocked Prisma client (no database needed).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seed } from "../prisma/seed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexData = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "web_app", "data", "index.json"), "utf8"),
);

function mockPrisma() {
  const calls = [];
  return {
    calls,
    sticker: {
      upsert: async (args) => {
        calls.push(args);
        return { slug: args.where.slug };
      },
    },
  };
}

describe("seed", () => {
  it("upserts one Sticker row per set plus one per individual sticker", async () => {
    const prisma = mockPrisma();
    const rows = await seed(/** @type {any} */ (prisma), indexData);
    const stickerCount = indexData.sets.reduce((n, s) => n + (s.stickers || []).length, 0);
    assert.equal(rows.length, indexData.sets.length + stickerCount);
    assert.equal(stickerCount, 40);
    // Rows are grouped per set (set row first, then its sticker rows),
    // so the set rows are the ones whose slug does not end in -NN.
    assert.deepEqual(
      rows.filter((r) => !/-\d{2}$/.test(r.slug)).map((r) => r.slug),
      indexData.sets.map((s) => s.slug),
    );
    assert.equal(rows.filter((r) => /-\d{2}$/.test(r.slug)).length, stickerCount);
    assert.equal(prisma.calls.length, indexData.sets.length + stickerCount);
  });

  it("maps slug / title / imageUrl / keywords from the set record", async () => {
    const prisma = mockPrisma();
    await seed(/** @type {any} */ (prisma), indexData);
    const first = prisma.calls[0];
    const set = indexData.sets[0];
    assert.equal(first.where.slug, set.slug);
    assert.equal(first.create.slug, set.slug);
    assert.equal(first.create.title, set.title);
    assert.equal(first.create.imageUrl, "/" + set.image);
    assert.deepEqual(first.create.keywords, set.tags);
    // Idempotent: update carries the same data as create.
    assert.deepEqual(first.update, {
      title: set.title,
      imageUrl: "/" + set.image,
      keywords: set.tags,
    });
  });

  it("maps slug / title / imageUrl / keywords for sticker rows", async () => {
    const prisma = mockPrisma();
    await seed(/** @type {any} */ (prisma), indexData);
    const firstSet = indexData.sets[0];
    const firstSticker = firstSet.stickers[0];
    // Calls are grouped per set: set row first, then its sticker rows.
    const call = prisma.calls[1];
    assert.equal(call.where.slug, firstSticker.id);
    assert.equal(call.create.slug, firstSticker.id);
    assert.equal(call.create.title, firstSticker.title);
    assert.equal(call.create.imageUrl, "/" + firstSticker.file);
    assert.deepEqual(call.create.keywords, firstSet.tags);
    assert.deepEqual(call.update, {
      title: firstSticker.title,
      imageUrl: "/" + firstSticker.file,
      keywords: firstSet.tags,
    });
  });

  it("returns [] for an index with no sets", async () => {
    const prisma = mockPrisma();
    assert.deepEqual(await seed(/** @type {any} */ (prisma), { sets: [] }), []);
    assert.equal(prisma.calls.length, 0);
  });
});
