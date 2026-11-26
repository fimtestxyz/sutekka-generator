// Admin API router (ADMIN.md §6): every /api/admin/* route in one
// catch-all file, following the api/auth/[...auth].js precedent.
//
// Public (no session): POST /setup (one-time first run), POST /login,
// GET /session (also reports whether setup is still needed).
// Everything else requires the admin session cookie (see
// api/_lib/admin-auth.js) and writes an AuditLog row for actions
// that touch money, fulfilment or settings.
//
// State-changing calls check the Origin header when present
// (same-origin fetch from the SPA); the HttpOnly + SameSite=Lax
// cookie is the primary CSRF defence.
"use strict";

const { getPrisma } = require("../_lib/prisma");
const {
  sendJson,
  methodNotAllowed,
  dbAvailable,
  readJsonBody,
  getPathSegments,
  getQuery,
} = require("../_lib/http");
const {
  hashPassword,
  verifyPassword,
  hashToken,
  getAdminToken,
  setAdminCookie,
  clearAdminCookie,
  createAdminSession,
  getAdminUser,
  loginAllowed,
  audit,
  originOk,
} = require("../_lib/admin-auth");
const { adminOrder } = require("../_lib/admin-orders");
const {
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
  parseBody,
} = require("../_lib/schemas");

const PRINT_RANK = { queued: 0, printing: 1, shipped: 2, delivered: 3 };

function invalidBody(res, details) {
  sendJson(res, 400, { error: "invalid_body", details });
}

/** Parse ?page=&take= with sane clamps. */
function parsePage(query) {
  const page = Math.max(1, parseInt(query.get("page") || "1", 10) || 1);
  const take = Math.min(100, Math.max(1, parseInt(query.get("take") || "20", 10) || 20));
  return { page, take, skip: (page - 1) * take };
}

/**
 * Resolve the admin session or answer 401. Returns the AdminUser
 * ({ id, username }) or null when the response was already sent.
 */
async function requireAdmin(req, res, prisma) {
  const admin = await getAdminUser(req, prisma);
  if (!admin) {
    sendJson(res, 401, { error: "admin_unauthorized" });
    return null;
  }
  return admin;
}

/** Load an order by id or answer 404. Returns the row or null. */
async function findOrderOr404(prisma, id, res) {
  const row = await prisma.order.findUnique({ where: { id } });
  if (!row) sendJson(res, 404, { error: "order_not_found" });
  return row || null;
}

async function handleSetup(req, res, prisma) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }
  if (!originOk(req)) {
    sendJson(res, 403, { error: "forbidden_origin" });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    invalidBody(res, ["body must be valid JSON"]);
    return;
  }
  const parsed = parseBody(adminSetupSchema, body);
  if (!parsed.ok) {
    invalidBody(res, parsed.details);
    return;
  }
  // One admin, ever, through this endpoint. The count check has a
  // tiny race if two setups run at the same instant before the first
  // admin exists; the username unique constraint is the backstop.
  const existing = await prisma.adminUser.count();
  if (existing > 0) {
    sendJson(res, 409, { error: "setup_complete" });
    return;
  }
  const user = await prisma.adminUser.create({
    data: {
      username: parsed.data.username,
      passwordHash: hashPassword(parsed.data.password),
    },
  });
  const token = await createAdminSession(prisma, user.id);
  setAdminCookie(res, token);
  await audit(prisma, { adminUser: user.username, action: "auth.setup" });
  sendJson(res, 201, { admin: { username: user.username } });
}

async function handleLogin(req, res, prisma) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }
  if (!originOk(req)) {
    sendJson(res, 403, { error: "forbidden_origin" });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    invalidBody(res, ["body must be valid JSON"]);
    return;
  }
  const parsed = parseBody(adminLoginSchema, body);
  if (!parsed.ok) {
    invalidBody(res, parsed.details);
    return;
  }
  const { username, password } = parsed.data;
  if (!loginAllowed(username, req)) {
    sendJson(res, 429, { error: "too_many_attempts" });
    return;
  }
  const user = await prisma.adminUser.findUnique({ where: { username } });
  // Same answer whether the username exists or the password is wrong:
  // no user enumeration.
  if (!user || !verifyPassword(password, user.passwordHash)) {
    await audit(prisma, { adminUser: username, action: "auth.login_failed" });
    sendJson(res, 401, { error: "invalid_credentials" });
    return;
  }
  const token = await createAdminSession(prisma, user.id);
  setAdminCookie(res, token);
  await audit(prisma, { adminUser: user.username, action: "auth.login" });
  sendJson(res, 200, { admin: { username: user.username } });
}

async function handleLogout(req, res, prisma) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }
  const token = getAdminToken(req);
  if (token) {
    await prisma.adminSession
      .delete({ where: { tokenHash: hashToken(token) } })
      .catch(() => null);
  }
  clearAdminCookie(res);
  sendJson(res, 200, { ok: true });
}

async function handleSession(req, res, prisma) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }
  const admin = await getAdminUser(req, prisma);
  if (admin) {
    sendJson(res, 200, { admin: { username: admin.username }, setupNeeded: false });
    return;
  }
  const count = await prisma.adminUser.count();
  sendJson(res, 200, { admin: null, setupNeeded: count === 0 });
}

async function handleOrdersList(req, res, prisma, admin) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }
  const query = getQuery(req);
  const where = {};
  const status = query.get("status");
  if (status) where.status = status;
  const itemType = query.get("itemType");
  if (itemType) where.itemType = itemType;
  const printStatus = query.get("printStatus");
  if (printStatus) where.printStatus = printStatus;
  const from = query.get("from");
  const to = query.get("to");
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }
  const q = query.get("q");
  if (q) {
    where.OR = [
      { buyerEmail: { contains: q, mode: "insensitive" } },
      { stripeSessionId: { contains: q } },
      { id: q },
    ];
  }
  const { page, take, skip } = parsePage(query);
  const [total, rows] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
  ]);
  sendJson(res, 200, {
    orders: rows.map(adminOrder),
    total,
    page,
    take,
  });
}

async function handleOrderDetail(req, res, prisma, admin, orderId) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }
  const row = await prisma.order.findUnique({
    where: { id: orderId },
    include: { invoiceRequest: true },
  });
  if (!row) {
    sendJson(res, 404, { error: "order_not_found" });
    return;
  }
  const auditRows = await prisma.auditLog.findMany({
    where: { orderId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  sendJson(res, 200, {
    order: adminOrder(row),
    invoiceRequest: row.invoiceRequest || null,
    audit: auditRows,
  });
}

async function handleOrderStatus(req, res, prisma, admin, orderId) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }
  if (!originOk(req)) {
    sendJson(res, 403, { error: "forbidden_origin" });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    invalidBody(res, ["body must be valid JSON"]);
    return;
  }
  const parsed = parseBody(adminOrderStatusSchema, body);
  if (!parsed.ok) {
    invalidBody(res, parsed.details);
    return;
  }
  const row = await findOrderOr404(prisma, orderId, res);
  if (!row) return;
  const { status, reason } = parsed.data;
  const allowedFrom = { delivered: ["paid"], refunded: ["paid", "delivered"], cancelled: ["paid", "delivered"] };
  if (!allowedFrom[status].includes(row.status)) {
    sendJson(res, 409, {
      error: "invalid_transition",
      details: [`cannot move an order from ${row.status} to ${status}`],
    });
    return;
  }
  const data = { status, cancelReason: reason };
  if (status === "refunded") data.refundedAt = new Date();
  const updated = await prisma.order.update({ where: { id: orderId }, data });
  await audit(prisma, {
    adminUser: admin.username,
    action: "order.status",
    orderId,
    details: { from: row.status, to: status, reason },
  });
  sendJson(res, 200, { order: adminOrder(updated) });
}

async function handleOrderNote(req, res, prisma, admin, orderId) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }
  if (!originOk(req)) {
    sendJson(res, 403, { error: "forbidden_origin" });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    invalidBody(res, ["body must be valid JSON"]);
    return;
  }
  const parsed = parseBody(adminOrderNoteSchema, body);
  if (!parsed.ok) {
    invalidBody(res, parsed.details);
    return;
  }
  const row = await findOrderOr404(prisma, orderId, res);
  if (!row) return;
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { adminNotes: parsed.data.note },
  });
  await audit(prisma, {
    adminUser: admin.username,
    action: "order.note",
    orderId,
    details: { note: parsed.data.note.slice(0, 200) },
  });
  sendJson(res, 200, { order: adminOrder(updated) });
}

async function handleOrderShipping(req, res, prisma, admin, orderId) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }
  if (!originOk(req)) {
    sendJson(res, 403, { error: "forbidden_origin" });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    invalidBody(res, ["body must be valid JSON"]);
    return;
  }
  const parsed = parseBody(adminOrderShippingSchema, body);
  if (!parsed.ok) {
    invalidBody(res, parsed.details);
    return;
  }
  const row = await findOrderOr404(prisma, orderId, res);
  if (!row) return;
  const data = {};
  if (parsed.data.name !== undefined) data.shippingName = parsed.data.name;
  if (parsed.data.address !== undefined) data.shippingAddress = parsed.data.address;
  if (parsed.data.courier !== undefined) data.trackingCourier = parsed.data.courier;
  if (parsed.data.trackingNumber !== undefined) data.trackingNumber = parsed.data.trackingNumber;
  if (Object.keys(data).length === 0) {
    invalidBody(res, ["at least one of name, address, courier, trackingNumber is required"]);
    return;
  }
  const updated = await prisma.order.update({ where: { id: orderId }, data });
  await audit(prisma, {
    adminUser: admin.username,
    action: "order.shipping",
    orderId,
    details: { fields: Object.keys(data) },
  });
  sendJson(res, 200, { order: adminOrder(updated) });
}

async function handleOrderPrint(req, res, prisma, admin, orderId) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }
  if (!originOk(req)) {
    sendJson(res, 403, { error: "forbidden_origin" });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    invalidBody(res, ["body must be valid JSON"]);
    return;
  }
  const parsed = parseBody(adminOrderPrintSchema, body);
  if (!parsed.ok) {
    invalidBody(res, parsed.details);
    return;
  }
  const row = await findOrderOr404(prisma, orderId, res);
  if (!row) return;
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { printStatus: parsed.data.printStatus },
  });
  await audit(prisma, {
    adminUser: admin.username,
    action: "order.print",
    orderId,
    details: { from: row.printStatus, to: parsed.data.printStatus },
  });
  sendJson(res, 200, { order: adminOrder(updated) });
}

async function handleOrderInvoice(req, res, prisma, admin, orderId) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }
  if (!originOk(req)) {
    sendJson(res, 403, { error: "forbidden_origin" });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    invalidBody(res, ["body must be valid JSON"]);
    return;
  }
  const parsed = parseBody(adminOrderInvoiceSchema, body);
  if (!parsed.ok) {
    invalidBody(res, parsed.details);
    return;
  }
  const row = await findOrderOr404(prisma, orderId, res);
  if (!row) return;
  // v1: the invoice itself is issued in the Stripe Dashboard (linked
  // from the order view); this endpoint records the result on the
  // order and closes any open invoice request for it.
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      invoiceId: parsed.data.invoiceId,
      invoiceNumber: parsed.data.invoiceNumber,
    },
  });
  await prisma.invoiceRequest
    .updateMany({
      where: { orderId, status: "open" },
      data: { status: "issued", resolvedAt: new Date() },
    })
    .catch(() => null);
  await audit(prisma, {
    adminUser: admin.username,
    action: "invoice.recorded",
    orderId,
    details: { invoiceNumber: parsed.data.invoiceNumber },
  });
  sendJson(res, 200, { order: adminOrder(updated) });
}

async function handleInvoices(req, res, prisma, admin) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }
  const [requests, issued] = await Promise.all([
    prisma.invoiceRequest.findMany({
      where: { status: "open" },
      orderBy: { createdAt: "asc" },
      take: 50,
    }),
    prisma.order.findMany({
      where: { invoiceId: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: 50,
    }),
  ]);
  sendJson(res, 200, {
    requests,
    issued: issued.map(adminOrder),
  });
}

async function handleInvoiceResolve(req, res, prisma, admin, requestId) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }
  if (!originOk(req)) {
    sendJson(res, 403, { error: "forbidden_origin" });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    invalidBody(res, ["body must be valid JSON"]);
    return;
  }
  const parsed = parseBody(adminInvoiceResolveSchema, body);
  if (!parsed.ok) {
    invalidBody(res, parsed.details);
    return;
  }
  const row = await prisma.invoiceRequest.findUnique({ where: { id: requestId } });
  if (!row) {
    sendJson(res, 404, { error: "invoice_request_not_found" });
    return;
  }
  const updated = await prisma.invoiceRequest.update({
    where: { id: requestId },
    data: { status: parsed.data.status, resolvedAt: new Date() },
  });
  await audit(prisma, {
    adminUser: admin.username,
    action: "invoice.resolved",
    orderId: row.orderId,
    details: { status: parsed.data.status },
  });
  sendJson(res, 200, { request: updated });
}

async function handlePrintQueue(req, res, prisma, admin) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }
  const rows = await prisma.order.findMany({
    where: { printStatus: { not: "none" } },
    orderBy: { createdAt: "asc" },
  });
  rows.sort(
    (a, b) =>
      (PRINT_RANK[a.printStatus] ?? 99) - (PRINT_RANK[b.printStatus] ?? 99),
  );
  sendJson(res, 200, { orders: rows.map(adminOrder) });
}

async function handleStats(req, res, prisma, admin) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }
  const rows = await prisma.order.findMany({
    select: {
      itemId: true,
      itemType: true,
      amountTotal: true,
      status: true,
      createdAt: true,
    },
  });
  const paid = rows.filter((r) => r.status === "paid" || r.status === "delivered");
  const totalRevenue = paid.reduce((s, r) => s + r.amountTotal, 0);
  const revenueByType = {};
  const byItem = {};
  for (const r of paid) {
    revenueByType[r.itemType] = (revenueByType[r.itemType] || 0) + r.amountTotal;
    byItem[r.itemId] = byItem[r.itemId] || { itemId: r.itemId, orders: 0, revenue: 0 };
    byItem[r.itemId].orders += 1;
    byItem[r.itemId].revenue += r.amountTotal;
  }
  const topItems = Object.values(byItem)
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 10);
  const byDay = {};
  const now = Date.now();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    byDay[d.toISOString().slice(0, 10)] = { date: d.toISOString().slice(0, 10), orders: 0, revenue: 0 };
  }
  for (const r of paid) {
    const day = new Date(r.createdAt).toISOString().slice(0, 10);
    if (byDay[day]) {
      byDay[day].orders += 1;
      byDay[day].revenue += r.amountTotal;
    }
  }
  sendJson(res, 200, {
    totalOrders: rows.length,
    paidOrders: paid.length,
    refundedOrders: rows.filter((r) => r.status === "refunded").length,
    totalRevenue,
    revenueByType,
    topItems,
    byDay: Object.values(byDay),
  });
}

async function handleWebhooks(req, res, prisma, admin) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }
  const events = await prisma.webhookEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const lastOk = events.find((e) => e.status === "ok");
  sendJson(res, 200, {
    events,
    lastOkAt: lastOk ? lastOk.createdAt : null,
  });
}

async function handleAudit(req, res, prisma, admin) {
  if (req.method !== "GET") {
    methodNotAllowed(res, ["GET"]);
    return;
  }
  const query = getQuery(req);
  const where = {};
  const action = query.get("action");
  if (action) where.action = action;
  const orderId = query.get("orderId");
  if (orderId) where.orderId = orderId;
  const { page, take, skip } = parsePage(query);
  const [total, entries] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
  ]);
  sendJson(res, 200, { entries, total, page, take });
}

async function handleSettings(req, res, prisma, admin) {
  if (req.method === "GET") {
    const rows = await prisma.siteSetting.findMany();
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    sendJson(res, 200, {
      shopClosed: map.shop_closed === "true",
      announcement: map.announcement || "",
      hiddenItems: map.hidden_items ? JSON.parse(map.hidden_items) : [],
      uploadsEnabled: map.uploads_enabled === "true",
    });
    return;
  }
  if (req.method !== "POST") {
    methodNotAllowed(res, ["GET", "POST"]);
    return;
  }
  if (!originOk(req)) {
    sendJson(res, 403, { error: "forbidden_origin" });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    invalidBody(res, ["body must be valid JSON"]);
    return;
  }
  const parsed = parseBody(adminSettingsSchema, body);
  if (!parsed.ok) {
    invalidBody(res, parsed.details);
    return;
  }
  const updates = [];
  if (parsed.data.shopClosed !== undefined) {
    updates.push(["shop_closed", String(parsed.data.shopClosed)]);
  }
  if (parsed.data.announcement !== undefined) {
    updates.push(["announcement", parsed.data.announcement]);
  }
  if (parsed.data.hiddenItems !== undefined) {
    updates.push(["hidden_items", JSON.stringify(parsed.data.hiddenItems)]);
  }
  if (parsed.data.uploadsEnabled !== undefined) {
    updates.push(["uploads_enabled", String(parsed.data.uploadsEnabled)]);
  }
  for (const [key, value] of updates) {
    await prisma.siteSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
  await audit(prisma, {
    adminUser: admin.username,
    action: "settings.updated",
    details: { keys: updates.map(([k]) => k) },
  });
  sendJson(res, 200, { ok: true });
}

async function handleChangePassword(req, res, prisma, admin) {
  if (req.method !== "POST") {
    methodNotAllowed(res, ["POST"]);
    return;
  }
  if (!originOk(req)) {
    sendJson(res, 403, { error: "forbidden_origin" });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    invalidBody(res, ["body must be valid JSON"]);
    return;
  }
  const parsed = parseBody(adminChangePasswordSchema, body);
  if (!parsed.ok) {
    invalidBody(res, parsed.details);
    return;
  }
  const user = await prisma.adminUser.findUnique({ where: { id: admin.id } });
  if (!user || !verifyPassword(parsed.data.oldPassword, user.passwordHash)) {
    sendJson(res, 401, { error: "invalid_credentials" });
    return;
  }
  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { passwordHash: hashPassword(parsed.data.newPassword) },
  });
  // Keep this session, revoke every other one.
  const current = getAdminToken(req);
  await prisma.adminSession
    .deleteMany({
      where: {
        adminUserId: admin.id,
        ...(current ? { tokenHash: { not: hashToken(current) } } : {}),
      },
    })
    .catch(() => null);
  await audit(prisma, { adminUser: admin.username, action: "auth.password_changed" });
  sendJson(res, 200, { ok: true });
}

async function handleSessions(req, res, prisma, admin) {
  const current = getAdminToken(req);
  const currentHash = current ? hashToken(current) : null;
  if (req.method === "GET") {
    const rows = await prisma.adminSession.findMany({
      where: { adminUserId: admin.id },
      orderBy: { createdAt: "desc" },
    });
    sendJson(res, 200, {
      sessions: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        current: r.tokenHash === currentHash,
      })),
    });
    return;
  }
  if (req.method === "DELETE") {
    if (!originOk(req)) {
      sendJson(res, 403, { error: "forbidden_origin" });
      return;
    }
    await prisma.adminSession.deleteMany({
      where: {
        adminUserId: admin.id,
        ...(currentHash ? { tokenHash: { not: currentHash } } : {}),
      },
    });
    await audit(prisma, { adminUser: admin.username, action: "auth.sessions_revoked" });
    sendJson(res, 200, { ok: true });
    return;
  }
  methodNotAllowed(res, ["GET", "DELETE"]);
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ prisma?: any }} [deps] test injection only
 */
async function adminHandler(req, res, deps = {}) {
  try {
    if (!dbAvailable(res)) return;
    const prisma = deps.prisma || getPrisma();
    const segments = getPathSegments(req);
    // ["api", "admin", ...rest]
    const rest = segments.slice(2);

    // Public routes.
    if (rest.length === 1 && rest[0] === "setup") {
      await handleSetup(req, res, prisma);
      return;
    }
    if (rest.length === 1 && rest[0] === "login") {
      await handleLogin(req, res, prisma);
      return;
    }
    if (rest.length === 1 && rest[0] === "session") {
      await handleSession(req, res, prisma);
      return;
    }

    // Everything below needs the admin session.
    const admin = await requireAdmin(req, res, prisma);
    if (!admin) return;

    if (rest.length === 1 && rest[0] === "logout") {
      await handleLogout(req, res, prisma);
      return;
    }
    if (rest.length === 1 && rest[0] === "orders") {
      await handleOrdersList(req, res, prisma, admin);
      return;
    }
    if (rest.length === 2 && rest[0] === "orders") {
      await handleOrderDetail(req, res, prisma, admin, rest[1]);
      return;
    }
    if (rest.length === 3 && rest[0] === "orders" && rest[2] === "status") {
      await handleOrderStatus(req, res, prisma, admin, rest[1]);
      return;
    }
    if (rest.length === 3 && rest[0] === "orders" && rest[2] === "note") {
      await handleOrderNote(req, res, prisma, admin, rest[1]);
      return;
    }
    if (rest.length === 3 && rest[0] === "orders" && rest[2] === "shipping") {
      await handleOrderShipping(req, res, prisma, admin, rest[1]);
      return;
    }
    if (rest.length === 3 && rest[0] === "orders" && rest[2] === "print") {
      await handleOrderPrint(req, res, prisma, admin, rest[1]);
      return;
    }
    if (rest.length === 3 && rest[0] === "orders" && rest[2] === "invoice") {
      await handleOrderInvoice(req, res, prisma, admin, rest[1]);
      return;
    }
    if (rest.length === 1 && rest[0] === "invoices") {
      await handleInvoices(req, res, prisma, admin);
      return;
    }
    if (rest.length === 3 && rest[0] === "invoices" && rest[2] === "resolve") {
      await handleInvoiceResolve(req, res, prisma, admin, rest[1]);
      return;
    }
    if (rest.length === 1 && rest[0] === "print-queue") {
      await handlePrintQueue(req, res, prisma, admin);
      return;
    }
    if (rest.length === 1 && rest[0] === "stats") {
      await handleStats(req, res, prisma, admin);
      return;
    }
    if (rest.length === 1 && rest[0] === "webhooks") {
      await handleWebhooks(req, res, prisma, admin);
      return;
    }
    if (rest.length === 1 && rest[0] === "audit") {
      await handleAudit(req, res, prisma, admin);
      return;
    }
    if (rest.length === 1 && rest[0] === "settings") {
      await handleSettings(req, res, prisma, admin);
      return;
    }
    if (rest.length === 1 && rest[0] === "change-password") {
      await handleChangePassword(req, res, prisma, admin);
      return;
    }
    if (rest.length === 1 && rest[0] === "sessions") {
      await handleSessions(req, res, prisma, admin);
      return;
    }
    sendJson(res, 404, { error: "admin_route_not_found" });
  } catch (e) {
    console.error("adminHandler error", e);
    if (!res.writableEnded) sendJson(res, 500, { error: "internal_error" });
  }
}

// Vercel entry point (catch-all api/admin/[...admin].js). The optional
// third argument is test injection only (Vercel never passes it).
module.exports = async function handler(req, res, deps) {
  await adminHandler(req, res, deps);
};
