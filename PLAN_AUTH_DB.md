# PLAN_AUTH_DB.md — Auth, Profile & Social Interaction Layer

Status: draft for agent implementation
Owner: fimtestxyz
Target: sutekka-generator web app (Next.js on Vercel)

## 1. Scope

In scope:
- Google login (expandable to Outlook/Microsoft later)
- User profile: custom avatar, bio
- Keyword preferences
- Likes, comments (with 1-level replies), bookmarks
- Sorting for bookmarks and comments

Out of scope (this plan):
- Sticker generator itself
- Payments (see MONETISE.md)
- Email/password auth

## 2. Decisions (locked)

| Concern | Choice |
|---|---|
| Auth lib | Auth.js v5 (`next-auth@5` beta channel) |
| Providers | Google now; Microsoft Entra ID reserved |
| ORM | Prisma |
| DB | PostgreSQL (Neon on Vercel) |
| Session strategy | JWT, `uid` claim; adapter persists users/accounts |
| ID type | `cuid()` strings |
| Runtime | Node.js (not edge) for Prisma routes |

Rationale for JWT: fewer DB roundtrips per request; adapter still creates/looks up users on first login. If server-side session revocation becomes a requirement, switch to database sessions later (drop `strategy`, add `Session` usage) — schema already supports it.

## 3. Environment variables

Add to Vercel project and local `.env.local`:

```
DATABASE_URL="postgresql://...-pooler.../neondb?sslmode=require"
DIRECT_URL="postgresql://.../neondb?sslmode=require"
AUTH_SECRET="<openssl rand -base64 32>"
AUTH_URL="https://<prod-domain>"          # omit on Vercel preview; auto-detected
AUTH_GOOGLE_ID="<google client id>"
AUTH_GOOGLE_SECRET="<google client secret>"

reserved, do not set yet:

AUTH_MICROSOFT_ENTRA_ID_ID
AUTH_MICROSOFT_ENTRA_ID_SECRET
```

Google Cloud Console setup (manual, one-time):
- OAuth consent screen (External, Testing → publish later)
- Authorized redirect URIs:
  - `http://localhost:3000/api/auth/callback/google`
  - `https://<prod-domain>/api/auth/callback/google`

## 4. Phase 1 — Database & Prisma

### 4.1 Install

```bash
npm i prisma @prisma/client @auth/prisma-adapter next-auth@beta
npm i -D @types/node
npx prisma init --datasource-provider postgresql
```

### 4.2 prisma/schema.prisma

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

model User {
  id            String    @id @default(cuid())
  email         String    @unique
  emailVerified DateTime?
  name          String?
  image         String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  accounts    Account[]
  sessions    Session[]
  profile     UserProfile?
  preferences UserPreference[]
  bookmarks   Bookmark[]
  likes       Like[]
  comments    Comment[]
}

model Account {
  id                String  @id @default(cuid())
  userId            String
  type              String
  provider          String
  providerAccountId String
  refresh_token     String? @db.Text
  access_token      String? @db.Text
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String? @db.Text
  session_state     String?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([provider, providerAccountId])
  @@index([userId])
}

model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expires      DateTime
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}

model VerificationToken {
  identifier String
  token      String   @unique
  expires    DateTime

  @@unique([identifier, token])
}

model UserProfile {
  userId       String   @id
  customAvatar String?
  bio          String?  @db.VarChar(280)
  updatedAt    DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model UserPreference {
  id      String @id @default(cuid())
  userId  String
  keyword String
  weight  Float  @default(1)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, keyword])
  @@index([userId])
}

model Sticker {
  id        String   @id @default(cuid())
  slug      String   @unique
  title     String
  imageUrl  String
  keywords  String[]
  createdAt DateTime @default(now())

  likes     Like[]
  comments  Comment[]
  bookmarks Bookmark[]

  @@index([createdAt])
}

model Bookmark {
  id        String   @id @default(cuid())
  userId    String
  stickerId String
  createdAt DateTime @default(now())

  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  sticker Sticker @relation(fields: [stickerId], references: [id], onDelete: Cascade)

  @@unique([userId, stickerId])
  @@index([userId, createdAt])
  @@index([userId, stickerId])
}

model Like {
  id        String   @id @default(cuid())
  userId    String
  stickerId String
  createdAt DateTime @default(now())

  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  sticker Sticker @relation(fields: [stickerId], references: [id], onDelete: Cascade)

  @@unique([userId, stickerId])
  @@index([stickerId])
  @@index([userId])
}

model Comment {
  id        String   @id @default(cuid())
  userId    String
  stickerId String
  parentId  String?
  content   String   @db.VarChar(1000)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  sticker Sticker @relation(fields: [stickerId], references: [id], onDelete: Cascade)
  parent  Comment? @relation("CommentReplies", fields: [parentId], references: [id], onDelete: Cascade)
  replies Comment[] @relation("CommentReplies")

  @@index([stickerId, createdAt])
  @@index([parentId])
  @@index([userId])
}
```

### 4.3 Migrate & seed

```bash
npx prisma migrate dev --name init_auth_social
npx prisma generate
```

Create prisma/seed.ts that imports the existing stickers.json and upserts Sticker rows (map slug, title, imageUrl, keywords). Wire "prisma": { "seed": "ts-node prisma/seed.ts" } in package.json.

### 4.4 Client singleton

lib/prisma.ts:

```ts
import { PrismaClient } from "@prisma/client"

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }
export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ log: ["warn", "error"] })
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma
```

### Acceptance criteria

- npx prisma migrate deploy runs clean on Neon.
- npx prisma studio shows the tables; seed populated Sticker rows.
- npx prisma generate in CI workflow passes.

## 5. Phase 2 — Auth.js v5 (Google only)

### 5.1 auth.ts (project root of the Next app)

```ts
import NextAuth from "next-auth"
import Google from "next-auth/providers/google"
import { PrismaAdapter } from "@auth/prisma-adapter"
import { prisma } from "@/lib/prisma"

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  providers: [
    Google({
      // Explicit so a later Microsoft provider with the same email
      // does NOT silently merge accounts by default.
      allowDangerousEmailAccountLinking: false,
    }),
    // Outlook (reserved):
    // MicrosoftEntraID({ allowDangerousEmailAccountLinking: false }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) token.uid = user.id
      return token
    },
    async session({ session, token }) {
      if (session.user && token.uid) {
        ;(session.user as { id?: string }).id = token.uid as string
      }
      return session
    },
  },
  pages: { signIn: "/login" },
})
```

### 5.2 Types

types/next-auth.d.ts:

```ts
import "next-auth"
declare module "next-auth" {
  interface Session {
    user: { id: string; name?: string | null; email?: string | null; image?: string | null }
  }
}
```

### 5.3 Route handler

app/api/auth/[...nextauth]/route.ts:

```ts
import { handlers } from "@/auth"
export const { GET, POST } = handlers
export const runtime = "nodejs"
```

### 5.4 UI

- app/login/page.tsx: a single "Continue with Google" button calling signIn("google", { redirectTo: "/" }) (server action or client signIn from next-auth/react).
- components/UserMenu.tsx: uses useSession(); if unauthenticated shows a Sign-in button; if authenticated shows avatar + links to Profile / Bookmarks / Sign out.
- Wrap app/layout.tsx with <SessionProvider> (client wrapper component since layout is server).

### Acceptance criteria

- Visiting /api/auth/signin offers Google.
- After Google login, User + Account rows exist; a profile photo appears in UserMenu.
- auth() inside a server component returns a session with user.id.
- Sign out clears session; refresh keeps user logged in.

## 6. Phase 3 — Profile & Preferences

### 6.1 Routes

app/api/me/profile/route.ts

- GET → returns { name, email, image, profile: { customAvatar, bio } }
- PATCH → body { customAvatar?: string | null, bio?: string }, upserts UserProfile, validates bio.length <= 280.

app/api/me/preferences/route.ts

- GET → { items: [{ keyword, weight }] }
- PUT → body { keywords: string[] }; replaces all rows for user in a transaction; dedupes, trims, max 30 keywords, each <= 32 chars.

All /api/me/* handlers must call const session = await auth() and return 401 if !session?.user?.id.

### 6.2 UI pages

- app/profile/page.tsx: edit display name (via PATCH /api/me/profile writing to User.name — add this field to the PATCH), custom avatar URL, bio. Show current Google avatar as fallback.
- app/settings/preferences/page.tsx: chip input for keywords; save button calls PUT /api/me/preferences.

### 6.3 Helper

lib/require-user.ts:

```ts
import { auth } from "@/auth"
export async function requireUser() {
  const session = await auth()
  if (!session?.user?.id) return null
  return session.user
}
```

### Acceptance criteria

- PATCH /api/me/profile persists and is reflected on reload.
- PUT /api/me/preferences replaces keywords atomically (verify via Prisma Studio).
- Unauthenticated requests to all /api/me/* return 401.

## 7. Phase 4 — Likes

app/api/stickers/[id]/like/route.ts

- POST → toggle: if Like exists for (userId, stickerId) delete it, else create. Return { liked: boolean, count: number } (count via prisma.like.count).
- GET → { liked: boolean, count: number } for current user (or liked:false if anon).

Use prisma.$transaction to keep the create/delete + count consistent.

UI: components/LikeButton.tsx — optimistic toggle via React useOptimistic or simple local state; disabled for anon with tooltip "Sign in to like".

### Acceptance criteria

- Rapid double-click cannot create duplicate rows (unique constraint is authoritative; catch P2002 and treat as liked).
- Count returned matches SELECT COUNT(*) in Prisma Studio.

## 8. Phase 5 — Comments

### 8.1 Routes

app/api/stickers/[id]/comments/route.ts

- GET → top-level comments (parentId = null), orderBy: createdAt desc (support ?sort=old), each with replies included (limit 3, note repliesCount), author: { id, name, image (fallback to profile.customAvatar) }, page (default 1) and pageSize (default 20).
- POST → body { content, parentId? }. Validate: content 1–1000 chars; parentId must reference a comment on the same sticker and its own parentId must be null (1-level replies only). Rate-limit: max 10 comments/minute/user (simple in-memory map acceptable initially; note TODO for Redis).

app/api/comments/[id]/route.ts

- PATCH → author only; body { content }.
- DELETE → author only; cascades to replies.

### 8.2 UI

- components/CommentThread.tsx on the sticker detail page: list, reply box per top-level comment, edit/delete menu for own comments, "show more replies" link.
- Optimistic append on POST.

### Acceptance criteria

- Reply to a reply returns 400.
- Non-author PATCH/DELETE returns 403.
- Deleting a parent removes replies (cascade verified).

## 9. Phase 6 — Bookmarks & Sorting

### 9.1 Routes

app/api/me/bookmarks/route.ts

- GET → query ?sort=recent|oldest|title&page=&pageSize=:
  - recent → orderBy: { createdAt: "desc" } (default)
  - oldest → { createdAt: "asc" }
  - title → orderBy: { sticker: { title: "asc" } } (Prisma nested orderBy)
  - include sticker relation; return { items, total, page, pageSize }.
- POST → body { stickerId }; upsert on @@unique([userId, stickerId]); return 201 or 200 if already bookmarked.

app/api/me/bookmarks/[stickerId]/route.ts

- DELETE → remove; 404 if none.

### 9.2 UI

- components/BookmarkButton.tsx on sticker cards and detail page.
- app/bookmarks/page.tsx: grid with sort dropdown bound to ?sort=, pagination.

### Acceptance criteria

- GET /api/me/bookmarks?sort=title returns items ordered by sticker.title asc.
- Duplicate POST does not create duplicate rows.
- Anon GET returns 401.

## 10. Phase 7 — Middleware & security

middleware.ts:

```ts
import { auth } from "@/auth"
export default auth((req) => {
  const { pathname } = req.nextUrl
  if (pathname.startsWith("/api/me/")) {
    if (!req.auth?.user) return new Response("Unauthorized", { status: 401 })
  }
})
export const config = { matcher: ["/api/me/:path*"] }
```

Additional rules for the agent:

- Every mutation (POST/PATCH/DELETE under /api/stickers, /api/comments) re-checks auth() server-side; never trust client-sent userId.
- Sanitize comment content (escape HTML; no markdown rendering for v1).
- Validate all bodies with Zod schemas in lib/schemas.ts.
- Cap request body size (Vercel default is fine).
- Use revalidatePath / revalidateTag after mutations if using cached fetch on sticker pages.

## 11. Phase 8 — File tree (target)

```
web_app/
  auth.ts
  middleware.ts
  lib/
    prisma.ts
    require-user.ts
    schemas.ts
  types/next-auth.d.ts
  prisma/
    schema.prisma
    seed.ts
  app/
    api/
      auth/[...nextauth]/route.ts
      me/
        profile/route.ts
        preferences/route.ts
        bookmarks/route.ts
        bookmarks/[stickerId]/route.ts
      stickers/[id]/
        like/route.ts
        comments/route.ts
      comments/[id]/route.ts
    login/page.tsx
    profile/page.tsx
    settings/preferences/page.tsx
    bookmarks/page.tsx
  components/
    SessionProviderClient.tsx
    UserMenu.tsx
    LikeButton.tsx
    BookmarkButton.tsx
    CommentThread.tsx
```

## 12. Phase 9 — Outlook expansion checklist

When approved, only these change:

1. npm i nothing new (provider ships in next-auth).
2. In auth.ts add MicrosoftEntraID to providers, uncomment env vars.
3. Azure portal: register app, redirect URI https://<domain>/api/auth/callback/microsoft-entra-id.
4. Decide account-linking policy: same-email across providers stays unlinked by default (allowDangerousEmailAccountLinking: false). If product wants one identity across providers, add an explicit "link account" flow rather than enabling dangerous linking.
5. No schema or route changes required.

## 13. Phase 10 — QA & CI

Add to the existing GitHub Actions workflow:

- npx prisma validate and npx prisma generate
- tsc --noEmit
- Lint
- Prisma migrate on a throwaway Neon branch for PRs (Neon GitHub integration) — optional for v1.

Manual test matrix (agent must run and record in PR description):

- [ ] Google login new user → User+Account created
- [ ] Login existing user → no duplicate user
- [ ] Profile edit persists; bio > 280 rejected
- [ ] Preferences replace atomically
- [ ] Like toggle idempotent under double-click
- [ ] Comment create/reply/edit/delete; reply-to-reply rejected
- [ ] Bookmark create/duplicate/delete; all three sorts correct
- [ ] All /api/me/* return 401 when anon
- [ ] Sign out → protected calls 401
- [ ] Google account with a second Google account does not cross-contaminate data

## 14. Rollout order (commit granularity)

1. chore: add prisma schema + migrate init_auth_social
2. feat: prisma client singleton + seed stickers from stickers.json
3. feat: auth.js v5 google provider + login page + UserMenu
4. feat: /api/me/profile + /profile page
5. feat: /api/me/preferences + /settings/preferences page
6. feat: like toggle API + LikeButton
7. feat: comments API + CommentThread
8. feat: bookmarks API + sort + /bookmarks page
9. chore: middleware + zod validation + rate-limit stub
10. ci: prisma validate/generate + tsc in workflow
11. docs: update README to reflect auth/social layer

## 15. Open questions for owner

- Display name: editable independent of Google name, or mirror Google? (Plan assumes editable User.name.)
- Custom avatar: URL only, or upload (would need Vercel Blob / S3)? (Plan assumes URL for v1.)
- Comment moderation: flag/hide tool needed? (Plan defers.)
- Rate limiting: in-memory v1 acceptable, or add Upstash Redis now?

## 16. References

- Auth.js v5: https://authjs.dev
- Prisma Adapter schema: https://authjs.dev/getting-started/adapters/prisma
- Neon + Vercel pooling: https://neon.tech/docs/guides/vercel

---

## 17. Baseline v0.1.0 & chief-engineer adaptation (2026-11-26)

### 17.1 Baseline

`v0.1.0` (tag, commit `343fe5c`) is the pre-auth baseline: the static
sticker showcase as it stands — 5 sets live, SEO/GEO files, the
auto-regenerate GitHub Actions workflow. Anything the auth work breaks
can be diffed against this tag.

### 17.2 Decision: adapt the plan to the static site — do NOT migrate to Next.js

The plan as written assumes a Next.js app. The real site is a static
vanilla-JS SPA: `web_app/index.html` + `app.js`, no `package.json`, no
framework. The Vercel project root is the repo root, `outputDirectory`
is `web_app`, and serverless functions already live at repo-root `api/`
(`api/engage.js` — likes/comments today).

Migrating the reader, homepage grid, search, service worker, share-page
pipeline and OG generation to Next.js just to get auth would be a large,
risky rewrite of a working site, for no user-facing gain. So:

- **Keep the static frontend.** No framework migration in this change.
- **Keep every locked decision in §2** (Auth.js v5, Google first,
  Prisma, Neon Postgres, JWT with `uid`, `cuid()` ids, Node runtime).
  Only the framework shell changes: Auth.js runs as its
  framework-agnostic core (`@auth/core`) inside Vercel serverless
  functions, not as Next.js route handlers.
- **API routes move to repo-root `api/`** (the existing pattern), not
  `web_app/app/api/`. The static frontend calls the same paths the plan
  specifies (`/api/auth/*`, `/api/me/*`, `/api/stickers/*/like`,
  `/api/stickers/*/comments`, `/api/comments/*`).
- **UI becomes static-JS sections** in `web_app/app.js` (sign-in button,
  user menu, like/bookmark buttons, comment thread) instead of React
  components. The existing `/api/engage` (Vercel KV) likes/comments are
  replaced by the Postgres-backed endpoints; existing single-device
  localStorage likes/comments do not migrate.
- **`middleware.ts` becomes per-handler auth checks**: every function
  calls the shared `requireUser()` helper first; there is no
  framework middleware in a static site.
- **Seed source correction**: the plan's §4.3 seeds from `stickers.json`,
  which does not exist. Seed from the generated
  `web_app/data/index.json` (+ `inventory.json`) instead.
- **Build**: add a repo-root `package.json` (dependencies + a
  `postinstall` running `prisma generate`); the Vercel build already
  installs npm dependencies automatically when `package.json` exists
  at the project root. The Python build script is untouched.

### 17.3 Path mapping (plan → adapted)

| Plan (§) | Adapted location |
|---|---|
| `auth.ts` (§5.1) | `api/auth/[...auth].js` — Auth.js core handler |
| `app/api/auth/[...nextauth]` (§5.3) | same `api/auth/*` functions |
| `lib/prisma.ts` (§4.4) | `api/_lib/prisma.js` |
| `lib/require-user.ts` (§6.3) | `api/_lib/require-user.js` |
| `lib/schemas.ts` (§10) | `api/_lib/schemas.js` (Zod) |
| `types/next-auth.d.ts` (§5.2) | not needed (no TS framework types); session shape documented in `api/_lib/session.js` |
| `app/api/me/*`, `app/api/stickers/*`, `app/api/comments/*` (§6–9) | `api/me/*`, `api/stickers/*`, `api/comments/*` |
| `middleware.ts` (§10) | per-handler `requireUser()` |
| `components/*`, `app/*/page.tsx` (§5.4, §6.2, §9.2) | sections in `web_app/app.js` + static views |
| `prisma/schema.prisma` (§4.2) | `prisma/schema.prisma` (unchanged from the plan) |
| CI (§13) | extend `.github/workflows/seo-geo.yml` or add `ci.yml`: `prisma validate`, `prisma generate`, `tsc --noEmit` |

### 17.4 Branching

Auth work lands on branch `auth-db-v0.2`, not `main`, until it is
verified end to end against a real Neon database and Google OAuth
client. `main` stays on the v0.1.0 static site until then.

### 17.5 Blockers (need the owner — no agent can do these)

1. **Neon project**: create a project at neon.tech (or reuse an
   existing one) and supply `DATABASE_URL` (pooled) + `DIRECT_URL`.
   No Neon credentials are on file here.
2. **Google OAuth client**: in Google Cloud Console, create an OAuth
   client ID/secret with the redirect URIs from §3, and supply
   `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` (+ `AUTH_SECRET`).
   No Google Cloud credentials are on file here.

Until both exist, the code can be written, typechecked and
schema-validated, but no login can be verified live.


---

### A few notes on the plan itself

- **Session strategy inconsistency, called out:** In my previous answer I said "recommended JWT." The plan keeps JWT as primary but explicitly explains *why* (fewer roundtrips) and notes the database-session fallback since the `Session` table is already in the schema. That keeps the earlier advice consistent while leaving the door open.
- **`allowDangerousEmailAccountLinking: false`** is set now, proactively, because when Outlook lands the temptation to flip it on is high — and that flag silently merges accounts by email, which is a data-contamination risk for a social layer with likes/comments.
- **Toggle endpoints** (`POST /like` toggling) are preferred over `POST`+`DELETE` pairs for likes because they survive double-clicks with a single unique constraint; the agent is told to catch `P2002`.
- **Sorting** is scoped to exactly what you asked (bookmarks), plus a default comment sort — kept simple, no full-text search in v1.
- **Open questions** are surfaced rather than silently decided, so you can lock them before the agent starts.
