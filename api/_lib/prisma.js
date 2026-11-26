// Prisma client singleton for the Vercel serverless API.
//
// Prisma 7: `new PrismaClient()` no longer reads a connection URL
// from the schema — it needs a driver adapter. We use the pg driver
// adapter (`@prisma/adapter-pg`) over a `pg` Pool pointed at the
// pooled Neon URL (DATABASE_URL). Migrations use the direct URL
// instead (DIRECT_URL, see prisma.config.ts).
//
// No database is configured in this repo until the owner supplies
// the Neon project: when DATABASE_URL is unset, handlers must
// answer 503 `db_not_configured` (see isConfigured) instead of
// crashing on a missing connection string.
"use strict";

const { Pool } = require("pg");
const { PrismaPg } = require("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client");

/** @type {import("@prisma/client").PrismaClient | null} */
let prisma = null;

/** True when a database URL is configured. */
function isConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Return the shared Prisma client, creating it (and its pg Pool)
 * on first use. Throws `db_not_configured` when DATABASE_URL is
 * unset — callers should check isConfigured() first and answer 503.
 *
 * @returns {import("@prisma/client").PrismaClient}
 */
function getPrisma() {
  if (prisma) return prisma;
  if (!isConfigured()) {
    throw new Error("db_not_configured");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  prisma = new PrismaClient({ adapter });
  return prisma;
}

module.exports = { getPrisma, isConfigured };
