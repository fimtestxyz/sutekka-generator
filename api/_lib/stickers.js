// Shared sticker lookup for the social endpoints (likes, comments,
// bookmarks). The [id] route param is a set SLUG (e.g.
// "riemann-rashomon") or a Sticker cuid — the site links and the
// seed use slugs, but cuids are accepted too.
"use strict";

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} id slug or cuid
 * @returns {Promise<{ id: string, slug: string } | null>}
 */
async function findSticker(prisma, id) {
  return prisma.sticker.findFirst({ where: { OR: [{ slug: id }, { id }] } });
}

module.exports = { findSticker };
