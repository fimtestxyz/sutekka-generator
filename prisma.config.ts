// Prisma 7 configuration (PLAN_AUTH_DB.md §4.2, adapted).
//
// Prisma 7 removed `url` / `directUrl` from schema.prisma (P1012):
// the migrate-time connection URL lives here. Migrations run against
// the DIRECT (non-pooled) Neon URL; the runtime client uses the
// pooled DATABASE_URL via the pg driver adapter (api/_lib/prisma.js).
// Both are placeholders until the owner supplies the real Neon
// project (see .env.example); no real secret is stored in this repo.
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "node prisma/seed.js",
  },
  datasource: {
    url: env("DIRECT_URL"),
  },
});
