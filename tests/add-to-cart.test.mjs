// Add-to-cart stepper labelling, Buy-button toggle, and post-checkout
// cart clear. Loads the real web_app/app.js in a vm sandbox with a
// stub DOM and a mocked fetch, then drives the three fixes:
//
//  FIX 1 — the +/- stepper IS the add-to-cart control. At qty 0 an
//  "Add to cart" label (bag icon + text) sits beside the stepper so
//  a user knows the + is how you add; at qty >= 1 the label switches
//  to "In your bag" so the tap's result is visible. No separate button.
//  FIX 2 — the three Buy buttons hide behind the hide_buy_buttons
//  setting, hidden by default (an absent key means hidden).
//  FIX 3 — once the download lookup confirms a session's orders are
//  paid, only the purchased lines leave the cart.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SRC = fs.readFileSync(path.join(__dirname, "..", "web_app", "app.js"), "utf8");
// The app's UI strings live in the dictionaries (data/i18n/*.json),
// fetched by loadDicts() at boot. The mock fetch serves the real
// files, exactly as the browser would — without them t() falls back
// to the dictionary key and every label assertion sees 'cart.addToCart'.
const I18N_EN = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "web_app", "data", "i18n", "en.json"), "utf8"));
const I18N_ZH = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "web_app", "data", "i18n", "zh.json"), "utf8"));

function makeElement() {
  const el = {
    _attrs: {},
    _handlers: {},
    _children: [],
    innerHTML: "",
    textContent: "",
    hidden: false,
    value: "",
    open: false,
    style: {},
    dataset: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    setAttribute(k, v) {
      el._attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in el._attrs ? el._attrs[k] : null;
    },
    removeAttribute(k) {
      delete el._attrs[k];
    },
    hasAttribute(k) {
      return k in el._attrs;
    },
    addEventListener(t, fn) {
      (el._handlers[t] = el._handlers[t] || []).push(fn);
    },
    removeEventListener() {},
    appendChild(c) {
      el._children.push(c);
      return c;
    },
    insertAdjacentHTML() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    contains() {
      return true;
    },
    focus() {},
    click() {},
    remove() {},
  };
  return el;
}

function makeDocument() {
  const byId = new Map();
  const bySelector = new Map();
  const handlers = {};
  return {
    _byId: byId,
    _handlers: handlers,
    head: makeElement(),
    body: makeElement(),
    documentElement: makeElement(),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement());
      return byId.get(id);
    },
    querySelector(sel) {
      if (!bySelector.has(sel)) bySelector.set(sel, makeElement());
      return bySelector.get(sel);
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return makeElement();
    },
    addEventListener(t, fn) {
      (handlers[t] = handlers[t] || []).push(fn);
    },
    removeEventListener() {},
  };
}

function makeStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem(k) {
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      store.set(k, String(v));
    },
    removeItem(k) {
      store.delete(k);
    },
    clear() {
      store.clear();
    },
  };
}

const LINKS = {
  singles: {
    "riemann-rashomon-01": { url: "https://buy.example/s1", amount: 400, set_slug: "riemann-rashomon", title: "One" },
  },
  sets: {
    "riemann-rashomon": { url: "https://buy.example/set", amount: 1500, stickers: ["riemann-rashomon-01"], title: "Riemann" },
  },
  pack: { item_id: "complete-pack-30", url: "https://buy.example/pack", amount: 2900, stickers: ["riemann-rashomon-01"], title: "Complete Pack" },
};

const TEST_SET = {
  slug: "riemann-rashomon",
  title: "Riemann",
  batch: "2",
  date: "2026-11-25",
  qa: 8.3,
  image: "sheet.png",
  thumb: "sheet.png",
  angle: "One set, one point.",
  tags: ["math"],
  stickers: [{ n: "01", id: "riemann-rashomon-01", title: "One", ja: "x", zh: "y", point: "p", scene: "s", file: "f.png", thumb: "f.png" }],
};

// Boots the real app.js. `settings` is the /api/settings payload;
// `lookup` answers /api/orders/lookup as { status, data }.
function boot({ session = true, settings = {}, hash = "#/", indexSets = [], seedStorage = {}, serverCart = [], lookup = null } = {}) {
  const doc = makeDocument();
  const storage = makeStorage(seedStorage);
  const calls = [];
  let lookupCalls = 0;

  async function mockFetch(url, opts = {}) {
    const method = opts.method || "GET";
    calls.push({ url, method, body: opts.body || null });
    let status = 200;
    let data = {};
    if (url.startsWith("data/index.json")) data = { sets: indexSets };
    else if (url === "data/series.json") data = { batches: [] };
    else if (url === "data/config.json") data = {};
    else if (url === "data/i18n/en.json") data = I18N_EN;
    else if (url === "data/i18n/zh.json") data = I18N_ZH;
    else if (url.startsWith("data/payment-links.json")) data = LINKS;
    else if (url === "/api/auth/session") data = session ? { user: { id: "u1", name: "Test", email: "t@example.com" } } : {};
    else if (url === "/api/settings") data = settings;
    else if (url === "/api/me/cart" && method === "GET") data = { items: serverCart };
    else if (url === "/api/me/cart" && method === "PUT") data = { items: JSON.parse(opts.body).items };
    else if (url.startsWith("/api/me/bookmarks?sort=")) data = { bookmarks: [] };
    else if (url.startsWith("/api/me/bookmarks?stickerId=")) data = { bookmarked: false };
    else if (url.startsWith("/api/orders/lookup")) {
      lookupCalls += 1;
      if (lookup) {
        const r = lookup(url, method, opts.body, lookupCalls);
        status = r.status;
        data = r.data;
      }
    }
    return { ok: status >= 200 && status < 300, status, json: async () => data };
  }

  const winHandlers = {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Date,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    URL,
    URLSearchParams,
    Map,
    Set,
    WeakMap,
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    document: doc,
    localStorage: storage,
    location: { hash, href: "https://sutekka.gobblemon.com/" + hash },
    navigator: {},
    history: { replaceState() {}, pushState() {} },
    fetch: mockFetch,
    scrollTo() {},
    addEventListener(t, fn) {
      (winHandlers[t] = winHandlers[t] || []).push(fn);
    },
    removeEventListener() {},
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC, sandbox, { filename: "app.js" });

  const flush = async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (id) => {
    const el = doc.getElementById(id);
    return { hidden: el.hidden };
  };
  // The label text is written via innerHTML (the stub has no DOM
  // parsing, so textContent would not follow it).
  const label = (id) => {
    const el = doc.getElementById(id);
    return { hidden: el.hidden, html: el.innerHTML };
  };
  const badge = () => {
    const el = doc.getElementById("cartCount");
    return { text: el.textContent, hidden: el.hidden };
  };
  const storedCart = () => JSON.parse(storage.getItem("sutekka-cart-v1") || "[]");
  // Fire a stepper's delegated click: the handler reads
  // e.target.closest('[data-step]') for the direction.
  const fireStepper = (id, step) => {
    const target = { closest: (sel) => (sel === "[data-step]" ? { getAttribute: () => step } : null) };
    (doc.getElementById(id)._handlers.click || []).forEach((fn) => fn({ target }));
  };
  const cartPuts = () => calls.filter((c) => c.url === "/api/me/cart" && c.method === "PUT");
  return { doc, storage, calls, flush, wait, vis, label, badge, storedCart, fireStepper, cartPuts };
}

const SET_CART = JSON.stringify([{ itemId: "riemann-rashomon", type: "set", qty: 1 }]);

describe("Add to cart label on the stepper (stepper is the control)", () => {
  it("set page: label reads Add to cart at qty 0, In your bag once added", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    assert.deepEqual(app.label("setAddLabel"), { hidden: false, html: '<i class="fi fi-br-shopping-bag"></i> Add to cart' });
    assert.deepEqual(app.vis("cartSetStepper"), { hidden: false });
    app.fireStepper("cartSetStepper", "inc");
    await app.flush();
    assert.deepEqual(app.label("setAddLabel"), { hidden: false, html: '<i class="fi fi-br-shopping-bag"></i> In your bag' });
    assert.deepEqual(app.vis("cartSetStepper"), { hidden: false });
    assert.deepEqual(app.badge(), { text: "1", hidden: false });
    assert.deepEqual(app.storedCart(), [{ itemId: "riemann-rashomon", type: "set", qty: 1 }]);
  });

  it("stepper + raises qty and − back to 0 switches the label back", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET], seedStorage: { "sutekka-cart-v1": SET_CART } });
    await app.flush();
    assert.deepEqual(app.label("setAddLabel"), { hidden: false, html: '<i class="fi fi-br-shopping-bag"></i> In your bag' });
    assert.deepEqual(app.vis("cartSetStepper"), { hidden: false });
    app.fireStepper("cartSetStepper", "inc");
    await app.flush();
    assert.deepEqual(app.badge(), { text: "2", hidden: false });
    app.fireStepper("cartSetStepper", "dec");
    app.fireStepper("cartSetStepper", "dec");
    await app.flush();
    assert.deepEqual(app.badge(), { text: "0", hidden: true });
    assert.deepEqual(app.storedCart(), []);
    assert.deepEqual(app.label("setAddLabel"), { hidden: false, html: '<i class="fi fi-br-shopping-bag"></i> Add to cart' });
    assert.deepEqual(app.vis("cartSetStepper"), { hidden: false });
  });

  it("pack card: label switches to In your bag once the pack is added", async () => {
    const app = boot({ hash: "#/", indexSets: [TEST_SET] });
    await app.flush();
    assert.deepEqual(app.label("packAddLabel"), { hidden: false, html: '<i class="fi fi-br-shopping-bag"></i> Add to cart' });
    assert.deepEqual(app.vis("packCartStepper"), { hidden: false });
    app.fireStepper("packCartStepper", "inc");
    await app.flush();
    assert.deepEqual(app.label("packAddLabel"), { hidden: false, html: '<i class="fi fi-br-shopping-bag"></i> In your bag' });
    assert.deepEqual(app.storedCart(), [{ itemId: "complete-pack-30", type: "pack", qty: 1 }]);
  });

  it("sticker modal: label switches to In your bag once the single is added", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon/sticker/01", indexSets: [TEST_SET] });
    await app.flush();
    assert.deepEqual(app.label("stickerAddLabel"), { hidden: false, html: '<i class="fi fi-br-shopping-bag"></i> Add to cart' });
    assert.deepEqual(app.vis("stickerCartStepper"), { hidden: false });
    app.fireStepper("stickerCartStepper", "inc");
    await app.flush();
    assert.deepEqual(app.label("stickerAddLabel"), { hidden: false, html: '<i class="fi fi-br-shopping-bag"></i> In your bag' });
    assert.deepEqual(app.storedCart(), [{ itemId: "riemann-rashomon-01", type: "single", qty: 1 }]);
  });
});

describe("Buy buttons behind hide_buy_buttons (default hidden)", () => {
  it("hides all three Buy buttons when the setting key is absent", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon/sticker/01", indexSets: [TEST_SET] });
    await app.flush();
    assert.deepEqual(app.vis("buySetBtn"), { hidden: true });
    assert.deepEqual(app.vis("stickerBuyBtn"), { hidden: true });
    assert.deepEqual(app.vis("packBuyBtn"), { hidden: true });
  });

  it("hides them when the setting is true", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET], settings: { hideBuyButtons: true } });
    await app.flush();
    assert.deepEqual(app.vis("buySetBtn"), { hidden: true });
  });

  it("shows them when the admin unchecks the toggle", async () => {
    const app = boot({
      hash: "#/set/riemann-rashomon/sticker/01",
      indexSets: [TEST_SET],
      settings: { hideBuyButtons: false, shopClosed: false, hiddenItems: [] },
    });
    await app.flush();
    assert.deepEqual(app.vis("buySetBtn"), { hidden: false });
    assert.deepEqual(app.vis("stickerBuyBtn"), { hidden: false });
    assert.deepEqual(app.vis("packBuyBtn"), { hidden: false });
    // …while the Add to cart labels still read Add to cart at qty 0.
    assert.deepEqual(app.label("setAddLabel"), { hidden: false, html: '<i class="fi fi-br-shopping-bag"></i> Add to cart' });
    assert.deepEqual(app.label("stickerAddLabel"), { hidden: false, html: '<i class="fi fi-br-shopping-bag"></i> Add to cart' });
  });
});

const PAID_SET_ORDER = {
  id: "ord-set",
  itemId: "riemann-rashomon",
  itemType: "set",
  amountTotal: 1500,
  quantity: 1,
  currency: "sgd",
  status: "paid",
};
const PAID_SINGLE_ORDER = {
  id: "ord-single",
  itemId: "riemann-rashomon-01",
  itemType: "single",
  amountTotal: 400,
  quantity: 1,
  currency: "sgd",
  status: "paid",
};

describe("download page clears purchased lines only", () => {
  it("confirmed paid session removes the bought lines, keeps the rest, and syncs", async () => {
    const cart = JSON.stringify([
      { itemId: "riemann-rashomon", type: "set", qty: 1 },
      { itemId: "riemann-rashomon-01", type: "single", qty: 1 },
      { itemId: "complete-pack-30", type: "pack", qty: 1 },
    ]);
    const app = boot({
      hash: "#/download?session_id=cs_test_x",
      indexSets: [TEST_SET],
      seedStorage: { "sutekka-cart-v1": cart },
      lookup: () => ({ status: 200, data: { orders: [PAID_SET_ORDER, PAID_SINGLE_ORDER] } }),
    });
    await app.flush();
    await app.wait(700);
    assert.deepEqual(app.storedCart(), [{ itemId: "complete-pack-30", type: "pack", qty: 1 }]);
    assert.deepEqual(app.badge(), { text: "1", hidden: false });
    // The trimmed cart reaches the server too (signed-in sync PUT).
    const puts = app.cartPuts();
    assert.ok(puts.length >= 1);
    assert.deepEqual(JSON.parse(puts[puts.length - 1].body).items, [{ itemId: "complete-pack-30", type: "pack", qty: 1 }]);
  });

  it("a 404 lookup clears nothing; the retry's confirmation clears it then", async () => {
    const cart = JSON.stringify([
      { itemId: "riemann-rashomon", type: "set", qty: 1 },
      { itemId: "riemann-rashomon-01", type: "single", qty: 1 },
    ]);
    const app = boot({
      hash: "#/download?session_id=cs_test_x",
      indexSets: [TEST_SET],
      seedStorage: { "sutekka-cart-v1": cart },
      lookup: (url, method, body, n) =>
        n === 1 ? { status: 404, data: {} } : { status: 200, data: { orders: [PAID_SET_ORDER] } },
    });
    await app.flush();
    // First lookup 404'd; the retry is still pending — cart untouched.
    assert.deepEqual(app.storedCart(), [
      { itemId: "riemann-rashomon", type: "set", qty: 1 },
      { itemId: "riemann-rashomon-01", type: "single", qty: 1 },
    ]);
    await app.wait(2600);
    assert.deepEqual(app.storedCart(), [{ itemId: "riemann-rashomon-01", type: "single", qty: 1 }]);
  });

  it("an order_id lookup (no session) never clears the cart", async () => {
    const cart = JSON.stringify([{ itemId: "riemann-rashomon", type: "set", qty: 1 }]);
    const app = boot({
      hash: "#/download?order_id=ord-set",
      indexSets: [TEST_SET],
      seedStorage: { "sutekka-cart-v1": cart },
      lookup: () => ({ status: 200, data: { order: PAID_SET_ORDER } }),
    });
    await app.flush();
    await app.wait(700);
    assert.deepEqual(app.storedCart(), [{ itemId: "riemann-rashomon", type: "set", qty: 1 }]);
  });
});
