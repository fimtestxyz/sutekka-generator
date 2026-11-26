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

// --- Admin (ADMIN.md) ---

const adminUsernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/, {
    message: "username may only contain letters, digits, _ and -",
  });

const adminPasswordSchema = z.string().min(10).max(200);

const adminSetupSchema = z.object({
  username: adminUsernameSchema,
  password: adminPasswordSchema,
});

const adminLoginSchema = z.object({
  username: z.string().trim().min(1).max(32),
  password: z.string().min(1).max(200),
});

const adminChangePasswordSchema = z.object({
  oldPassword: z.string().min(1).max(200),
  newPassword: adminPasswordSchema,
});

const adminOrderStatusSchema = z.object({
  status: z.enum(["delivered", "refunded", "cancelled"]),
  reason: z.string().trim().min(1).max(500),
});

const adminOrderNoteSchema = z.object({
  note: z.string().trim().max(2000),
});

const adminShippingAddressSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  postal: z.string().trim().min(1).max(20),
  country: z.string().trim().min(1).max(100),
});

const adminOrderShippingSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  address: adminShippingAddressSchema.optional(),
  courier: z.string().trim().max(100).optional(),
  trackingNumber: z.string().trim().max(100).optional(),
});

const adminOrderPrintSchema = z.object({
  printStatus: z.enum(["none", "queued", "printing", "shipped", "delivered"]),
});

const adminOrderInvoiceSchema = z.object({
  invoiceId: z.string().trim().min(1).max(100),
  invoiceNumber: z.string().trim().min(1).max(100),
});

const adminInvoiceResolveSchema = z.object({
  status: z.enum(["issued", "declined"]),
});

const adminSettingsSchema = z.object({
  shopClosed: z.boolean().optional(),
  announcement: z.string().trim().max(280).optional(),
  hiddenItems: z.array(z.string().trim().min(1)).max(100).optional(),
});

// Buyer shipping address (public POST /api/orders/shipping) — same
// shape as the admin's address, without the courier/tracking fields.
const buyerShippingSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  orderId: z.string().trim().min(1).optional(),
  email: z.string().trim().email().max(254),
  name: z.string().trim().min(1).max(200),
  address: adminShippingAddressSchema,
});

const buyerInvoiceRequestSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  orderId: z.string().trim().min(1).optional(),
  email: z.string().trim().email().max(254),
});

const cartCheckoutSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().trim().min(1).max(100),
        type: z.enum(["single", "set", "pack"]),
        // DCHToons-style quantity: how many copies of this item.
        // Digital files — the download is still the one PNG; the
        // quantity multiplies the price and is recorded on the Order
        // (it also doubles as the print count if physical comes later).
        quantity: z.number().int().min(1).max(99).default(1),
      }),
    )
    .min(1)
    .max(50),
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
  adminSetupSchema,
  adminLoginSchema,
  adminChangePasswordSchema,
  adminOrderStatusSchema,
  adminOrderNoteSchema,
  adminOrderShippingSchema,
  adminOrderPrintSchema,
  adminOrderInvoiceSchema,
  adminInvoiceResolveSchema,
  adminSettingsSchema,
  buyerShippingSchema,
  buyerInvoiceRequestSchema,
  cartCheckoutSchema,
  parseBody,
};
