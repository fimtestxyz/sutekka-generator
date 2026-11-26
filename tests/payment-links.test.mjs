// Shop data tests: the generated payment-links.json must cover every
// sellable item at the approved prices, with live test-mode links.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const links = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "web_app", "data", "payment-links.json"),
    "utf8",
  ),
);
const index = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "web_app", "data", "index.json"),
    "utf8",
  ),
);

describe("payment-links.json", () => {
  it("covers all 40 singles at S$4, all 5 sets at S$15, the pack at S$29", () => {
    const singles = Object.values(links.singles);
    const sets = Object.values(links.sets);
    assert.equal(singles.length, 40);
    assert.equal(sets.length, 5);
    assert.ok(singles.every((s) => s.amount === 400 && s.type === "single"));
    assert.ok(sets.every((s) => s.amount === 1500 && s.type === "set"));
    assert.equal(links.pack.amount, 2900);
    assert.equal(links.pack.type, "pack");
    assert.equal(links.currency, "sgd");
  });

  it("every link is a unique test-mode Stripe Payment Link", () => {
    const urls = [
      ...Object.values(links.singles),
      ...Object.values(links.sets),
      links.pack,
    ].map((e) => e.url);
    assert.ok(urls.every((u) => u.startsWith("https://buy.stripe.com/test_")));
    assert.equal(new Set(urls).size, urls.length);
    const linkIds = [
      ...Object.values(links.singles),
      ...Object.values(links.sets),
      links.pack,
    ].map((e) => e.link_id);
    assert.equal(new Set(linkIds).size, linkIds.length);
  });

  it("every single maps to a real sticker and every set lists its 8 stickers", () => {
    const inventoryIds = new Set(
      index.sets.flatMap((s) => s.stickers.map((x) => x.id)),
    );
    assert.equal(inventoryIds.size, 40);
    for (const [id, entry] of Object.entries(links.singles)) {
      assert.ok(inventoryIds.has(id), `${id} is not a real sticker`);
      assert.deepEqual(entry.stickers, [id]);
    }
    for (const [slug, entry] of Object.entries(links.sets)) {
      const set = index.sets.find((s) => s.slug === slug);
      assert.ok(set, `unknown set ${slug}`);
      assert.deepEqual(entry.stickers, set.stickers.map((x) => x.id));
    }
  });

  it("the pack holds exactly 30 real stickers, the first 30 in inventory order", () => {
    const inventoryIds = index.sets.flatMap((s) => s.stickers.map((x) => x.id));
    assert.equal(links.pack.stickers.length, 30);
    assert.deepEqual(links.pack.stickers, inventoryIds.slice(0, 30));
  });
});
