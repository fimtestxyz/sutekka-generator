// Admin order helpers (ADMIN.md §3, §5): pinning the exact files an
// order bought, and serializing orders for the admin and the buyer.
//
// Pinning: at webhook time the order records the file list it bought
// (filesJson) — file path + pixel dimensions — so the print queue
// always prints what the buyer bought, even if the sticker is later
// redrawn. The file list is resolved from the live payment-links
// data (web_app/data/payment-links.json), which carries the sticker
// ids per set and per pack.
//
// Sticker PNGs are 1600x1680 (verified 2026-11-26 from the actual
// file web_app/stickers/ai-agent-four-faces/stickers/03.png).
"use strict";

const STICKER_PX = { width: 1600, height: 1680 };
const LINKS_URL =
  (process.env.AUTH_URL || "https://sutekka.gobblemon.com").replace(/\/$/, "") +
  "/data/payment-links.json";

/** In-memory cache of the fetched links data (per lambda instance). */
let linksCache = null;

/**
 * File path of one sticker id: "ai-agent-four-faces-03" ->
 * "stickers/ai-agent-four-faces/stickers/03.png".
 *
 * @param {string} stickerId
 * @returns {string}
 */
function stickerFilePath(stickerId) {
  const idx = stickerId.lastIndexOf("-");
  const slug = stickerId.slice(0, idx);
  const num = stickerId.slice(idx + 1);
  return `stickers/${slug}/stickers/${num}.png`;
}

/**
 * Resolve the pinned file list for an order from the payment-links
 * data. Returns null when the item cannot be resolved (caller stores
 * null and the admin view falls back to live resolution).
 *
 * @param {string} itemId single sticker id, set slug, or "complete-pack-30"
 * @param {string} itemType "single" | "set" | "pack"
 * @param {any} linksData parsed payment-links.json
 * @returns {{ itemId: string, file: string, width: number, height: number }[] | null}
 */
function resolveOrderFiles(itemId, itemType, linksData) {
  if (!linksData || typeof linksData !== "object") return null;
  let ids = null;
  if (itemType === "single") {
    ids = [itemId];
  } else if (itemType === "set") {
    const set = linksData.sets && linksData.sets[itemId];
    ids = set && Array.isArray(set.stickers) ? set.stickers : null;
  } else if (itemType === "pack") {
    ids =
      linksData.pack && Array.isArray(linksData.pack.stickers)
        ? linksData.pack.stickers
        : null;
  }
  if (!ids || ids.length === 0) return null;
  return ids.map((id) => ({
    itemId: id,
    file: stickerFilePath(id),
    width: STICKER_PX.width,
    height: STICKER_PX.height,
  }));
}

/**
 * Fetch the live payment-links data (cached per instance). Returns
 * null on any failure — the caller treats that as "cannot pin" and
 * stores filesJson null instead of failing the order.
 *
 * @param {{ fetchFn?: Function }} [deps] test injection only
 * @returns {Promise<any | null>}
 */
async function fetchLinksData(deps = {}) {
  if (linksCache) return linksCache;
  const fetchFn = deps.fetchFn || fetch;
  try {
    const res = await fetchFn(LINKS_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    linksCache = data;
    return data;
  } catch (e) {
    return null;
  }
}

/** Test seam only: clear the links-data cache. */
function resetLinksCache() {
  linksCache = null;
}

/** DPI of a pinned file at a given print width in inches. */
function dpiAt(file, inches) {
  return Math.round(file.width / inches);
}

/**
 * Full admin serialization of an Order row: everything the admin
 * needs, including the pinned files and the fulfilment fields.
 * Stripe ids are included — the admin is the owner, and the order
 * detail links out to the Stripe Dashboard with them.
 *
 * @param {any} row Prisma Order row
 * @returns {any}
 */
function adminOrder(row) {
  return {
    id: row.id,
    stripeSessionId: row.stripeSessionId,
    stripePaymentLinkId: row.stripePaymentLinkId,
    stripePaymentIntentId: row.stripePaymentIntentId,
    buyerEmail: row.buyerEmail,
    itemId: row.itemId,
    itemType: row.itemType,
    amountTotal: row.amountTotal,
    quantity: row.quantity ?? 1,
    currency: row.currency,
    status: row.status,
    payMethodType: row.payMethodType || null,
    files: row.filesJson || null,
    printStatus: row.printStatus || "none",
    shippingName: row.shippingName || null,
    shippingAddress: row.shippingAddress || null,
    trackingCourier: row.trackingCourier || null,
    trackingNumber: row.trackingNumber || null,
    invoiceId: row.invoiceId || null,
    invoiceNumber: row.invoiceNumber || null,
    invoiceRequestedAt: row.invoiceRequestedAt || null,
    adminNotes: row.adminNotes || null,
    refundedAt: row.refundedAt || null,
    cancelReason: row.cancelReason || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Buyer-facing additions to the lookup's public order shape: the
 * fulfilment fields a buyer may see on their own order page
 * (tracking, invoice state). No Stripe ids, no buyer email beyond
 * what the caller already supplied.
 *
 * @param {any} row Prisma Order row
 * @returns {any}
 */
function buyerFulfilment(row) {
  return {
    payMethodType: row.payMethodType || null,
    printStatus: row.printStatus || "none",
    trackingCourier: row.trackingCourier || null,
    trackingNumber: row.trackingNumber || null,
    invoiceNumber: row.invoiceNumber || null,
    invoiceRequestedAt: row.invoiceRequestedAt || null,
    hasShippingAddress: Boolean(row.shippingAddress),
  };
}

module.exports = {
  STICKER_PX,
  stickerFilePath,
  resolveOrderFiles,
  fetchLinksData,
  resetLinksCache,
  dpiAt,
  adminOrder,
  buyerFulfilment,
};
