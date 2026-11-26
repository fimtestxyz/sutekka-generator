// Seed the social layer from the generated sticker index.
//
// One Sticker row per sticker SET (slug = set slug, e.g.
// "riemann-rashomon"), not per individual sticker — likes and
// comments on the site are per set, matching the /api/engage
// behaviour the Postgres endpoints replace. Source of truth is
// web_app/data/index.json, produced by scripts/build_sticker_index.py
// (there is no stickers.json). Idempotent: re-running updates the
// title / image / keywords of existing rows.
//
// Usage: `node prisma/seed.js` (or `npm run db:seed`, or
// `npx prisma db seed`). Requires DATABASE_URL to point at the
// Neon database — no live database exists yet, so seeding against
// a real database is blocked until the owner supplies it.
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Upsert one Sticker row per set in the index.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ sets?: Array<{ slug: string, title: string, image: string, tags?: string[] }> }} indexData
 * @returns {Promise<Array<{ slug: string }>>} the upserted rows
 */
async function seed(prisma, indexData) {
  const sets = indexData.sets || [];
  const rows = [];
  for (const set of sets) {
    const data = {
      title: set.title,
      imageUrl: "/" + set.image,
      keywords: set.tags || [],
    };
    const row = await prisma.sticker.upsert({
      where: { slug: set.slug },
      update: data,
      create: { slug: set.slug, ...data },
    });
    rows.push(row);
  }
  return rows;
}

async function main() {
  const indexPath = path.join(__dirname, "..", "web_app", "data", "index.json");
  const indexData = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const { getPrisma } = require("../api/_lib/prisma");
  const prisma = getPrisma();
  try {
    const rows = await seed(prisma, indexData);
    console.log(
      `Seeded ${rows.length} sticker sets: ${rows.map((r) => r.slug).join(", ")}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { seed };
