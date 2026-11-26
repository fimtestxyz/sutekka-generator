// Zod schemas for every mutating API body (PLAN_AUTH_DB.md
// Phase 7). Handlers validate with parseBody() and answer
// 400 { error: "invalid_body", details } on failure.
//
// Two rules the schemas enforce by construction:
//   - Unknown fields are stripped (Zod objects strip by default),
//     so a client-sent userId can never reach a query — the user
//     id always comes from the Auth.js session (requireUser).
//   - Strings are trimmed before the length checks, so "   "
//     cannot pass a min(1) check.
//
// Comment content is validated here but NOT HTML-escaped here:
// stored text stays raw and is escaped at render (app.js esc()).
// The server only strips < > on write (engage.js parity — see
// api/_lib/comments.js).
"use strict";

const { z } = require("zod");

const profilePatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  bio: z.string().trim().max(280).optional(),
  customAvatar: z
    .string()
    .trim()
    .max(2048)
    .refine((v) => v === "" || v.startsWith("https://"), {
      message: "customAvatar must be an https:// URL",
    })
    .optional(),
});

const preferencesPutSchema = z.object({
  keywords: z
    .array(
      z.object({
        keyword: z.string().trim().min(1).max(40),
        weight: z.number().min(0).max(2).default(1),
      }),
    )
    .max(50),
});

const commentContentSchema = z.string().trim().min(1).max(1000);

const commentCreateSchema = z.object({
  content: commentContentSchema,
  parentId: z.string().nullable().optional(),
});

const commentPatchSchema = z.object({
  content: commentContentSchema,
});

const bookmarkCreateSchema = z.object({
  stickerId: z.string().trim().min(1),
});

/**
 * Validate `body` against a schema. Returns a flat result object
 * (not a discriminated union — tsc does not narrow the union form
 * through this JSDoc): `data` is set on success, `details` on
 * failure.
 *
 * @param {import("zod").ZodType} schema
 * @param {unknown} body
 * @returns {{ ok: boolean, data: any, details: string[] | null }}
 */
function parseBody(schema, body) {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, data: result.data, details: null };
  return {
    ok: false,
    data: null,
    details: result.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    }),
  };
}

module.exports = {
  profilePatchSchema,
  preferencesPutSchema,
  commentCreateSchema,
  commentPatchSchema,
  bookmarkCreateSchema,
  parseBody,
};
