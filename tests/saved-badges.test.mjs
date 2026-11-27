// Nav count badges for the saved shelves (Bookmarks / Collections).
// Loads the real web_app/app.js in a vm sandbox with a stub DOM and a
// mocked fetch, then drives the badge update points: sign-in load,
// bookmark toggle, clear-all confirm, and signed-out hiding.
//
// The badge counts split the one server list the same way the two tabs
// do: a slug ending in -NN is an individual sticker (Collections),
// anything else is a whole set (Bookmarks).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SRC = fs.readFileSync(path.join(__dirname, "..", "web_app", "app.js"), "utf8");

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

// Boots the real app.js with a signed-in (or signed-out) session and a
// server bookmarks list of the given slugs. Returns handles to observe
// the nav badges and to fire delegated document clicks.
function boot({ session = true, bookmarks = [], hash = "#/", indexSets = [], seedStorage = {} } = {}) {
  const doc = makeDocument();
  const storage = makeStorage(seedStorage);
  const calls = [];
  let serverBookmarks = bookmarks.map((slug) => ({ sticker: { slug, title: slug, imageUrl: "x.png" } }));

  async function mockFetch(url, opts = {}) {
    const method = opts.method || "GET";
    calls.push({ url, method, body: opts.body || null });
    let data = {};
    if (url.startsWith("data/index.json")) data = { sets: indexSets };
    else if (url === "data/series.json") data = { batches: [] };
    else if (url === "data/config.json") data = {};
    else if (url.startsWith("data/payment-links.json")) data = { singles: {}, sets: {}, pack: { stickers: [] } };
    else if (url === "/api/auth/session") data = session ? { user: { id: "u1", name: "Test", email: "t@example.com" } } : {};
    else if (url === "/api/settings") data = {};
    else if (url === "/api/me/cart" && method === "GET") data = { items: [] };
    else if (url === "/api/me/cart" && method === "PUT") data = { items: JSON.parse(opts.body).items };
    else if (url.startsWith("/api/me/bookmarks?sort=")) data = { bookmarks: serverBookmarks };
    else if (url.startsWith("/api/me/bookmarks?stickerId=")) {
      const slug = decodeURIComponent(url.split("stickerId=")[1]);
      data = { bookmarked: serverBookmarks.some((b) => b.sticker.slug === slug) };
    } else if (url === "/api/me/bookmarks" && method === "POST") {
      const slug = JSON.parse(opts.body).stickerId;
      if (!serverBookmarks.some((b) => b.sticker.slug === slug)) {
        serverBookmarks.push({ sticker: { slug, title: slug, imageUrl: "x.png" } });
      }
      data = { ok: true };
    } else if (url === "/api/me/bookmarks?scope=sets" && method === "DELETE") {
      const before = serverBookmarks.length;
      serverBookmarks = serverBookmarks.filter((b) => /-\d{2}$/.test(b.sticker.slug));
      data = { ok: true, removed: before - serverBookmarks.length };
    } else if (url === "/api/me/bookmarks?scope=stickers" && method === "DELETE") {
      const before = serverBookmarks.length;
      serverBookmarks = serverBookmarks.filter((b) => !/-\d{2}$/.test(b.sticker.slug));
      data = { ok: true, removed: before - serverBookmarks.length };
    }
    return { ok: true, status: 200, json: async () => data };
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
  const badge = (id) => {
    const el = doc.getElementById(id);
    return { text: el.textContent, hidden: el.hidden };
  };
  const fireDocClick = (target) => {
    (doc._handlers.click || []).forEach((fn) => fn({ target, preventDefault() {} }));
  };
  const clickEl = (id) => {
    (doc.getElementById(id)._handlers.click || []).forEach((fn) => fn({}));
  };
  return { doc, storage, calls, flush, badge, fireDocClick, clickEl };
}

const TEST_SET = {
  slug: "riemann-rashomon",
  title: "Riemann",
  batch: "2",
  date: "2026-11-25",
  qa: 8.3,
  image: "sheet.png",
  angle: "One set, one point.",
  tags: ["math"],
  stickers: [{ n: "01", title: "One", ja: "x", zh: "y", file: "f.png" }],
};

describe("saved-shelf nav badges", () => {
  it("shows the set/sticker split from the server list on sign-in load", async () => {
    const app = boot({
      bookmarks: ["riemann-rashomon", "kakeya-wang-hong", "riemann-rashomon-01", "kakeya-wang-hong-02", "deng-yu-hilbert-sixth-03"],
    });
    await app.flush();
    assert.deepEqual(app.badge("bookmarksCount"), { text: "2", hidden: false });
    assert.deepEqual(app.badge("collectionsCount"), { text: "3", hidden: false });
  });

  it("hides both badges when signed out, even with a stale cached list", async () => {
    const app = boot({
      session: false,
      bookmarks: ["riemann-rashomon"],
      seedStorage: {
        "sticker-showcase-bookmarks-v1": JSON.stringify({
          sort: "recent",
          savedAt: Date.now(),
          bookmarks: [{ sticker: { slug: "riemann-rashomon", title: "R", imageUrl: "x.png" } }],
        }),
        "sticker-showcase-bookmarked-v1": JSON.stringify({ "riemann-rashomon": true }),
      },
    });
    await app.flush();
    // Signed-out: hidden, whatever the initial text is — a stale cached
    // count must never show. (updateSavedBadges hides without writing
    // a number when there is no session.)
    assert.equal(app.badge("bookmarksCount").hidden, true);
    assert.equal(app.badge("collectionsCount").hidden, true);
  });

  it("hides both badges when the signed-in shelves are empty", async () => {
    const app = boot({ bookmarks: [] });
    await app.flush();
    assert.deepEqual(app.badge("bookmarksCount"), { text: "0", hidden: true });
    assert.deepEqual(app.badge("collectionsCount"), { text: "0", hidden: true });
  });

  it("bookmarking a set on its page raises the Bookmarks badge at once", async () => {
    const app = boot({ bookmarks: [], hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    assert.deepEqual(app.badge("bookmarksCount"), { text: "0", hidden: true });
    app.fireDocClick({
      id: "",
      closest(sel) {
        return sel === "button" ? { id: "bookmarkBtn" } : null;
      },
    });
    await app.flush();
    assert.deepEqual(app.badge("bookmarksCount"), { text: "1", hidden: false });
    assert.deepEqual(app.badge("collectionsCount"), { text: "0", hidden: true });
    assert.ok(app.calls.some((c) => c.url === "/api/me/bookmarks" && c.method === "POST"));
  });

  it("a toggle on a fresh device keeps the counts it never toggled (map sync)", async () => {
    // Fresh device: the per-set map starts empty; the server list is
    // the only record of the 1 set + 1 sticker saved elsewhere. After
    // bookmarking a second set, the badges must read 2 and 1 — not
    // collapse to the one slug toggled in this session.
    const app = boot({
      bookmarks: ["kakeya-wang-hong", "kakeya-wang-hong-02"],
      hash: "#/set/riemann-rashomon",
      indexSets: [TEST_SET],
    });
    await app.flush();
    assert.deepEqual(app.badge("bookmarksCount"), { text: "1", hidden: false });
    assert.deepEqual(app.badge("collectionsCount"), { text: "1", hidden: false });
    app.fireDocClick({
      id: "",
      closest(sel) {
        return sel === "button" ? { id: "bookmarkBtn" } : null;
      },
    });
    await app.flush();
    assert.deepEqual(app.badge("bookmarksCount"), { text: "2", hidden: false });
    assert.deepEqual(app.badge("collectionsCount"), { text: "1", hidden: false });
  });

  it("clearing all bookmarks hides the Bookmarks badge and keeps Collections", async () => {
    const app = boot({
      bookmarks: ["riemann-rashomon", "kakeya-wang-hong", "riemann-rashomon-01"],
      hash: "#/bookmarks",
    });
    await app.flush();
    assert.deepEqual(app.badge("bookmarksCount"), { text: "2", hidden: false });
    assert.deepEqual(app.badge("collectionsCount"), { text: "1", hidden: false });
    // Tap "Clear all bookmarks" (opens the Lili confirm modal)…
    app.fireDocClick({
      id: "",
      closest(sel) {
        if (sel === "[data-clear-saved]") {
          return { getAttribute: (n) => (n === "data-clear-saved" ? "bookmarks" : null) };
        }
        return null;
      },
    });
    // …then confirm in the modal.
    app.clickEl("removeModalConfirm");
    await app.flush();
    assert.deepEqual(app.badge("bookmarksCount"), { text: "0", hidden: true });
    assert.deepEqual(app.badge("collectionsCount"), { text: "1", hidden: false });
    assert.ok(app.calls.some((c) => c.url === "/api/me/bookmarks?scope=sets" && c.method === "DELETE"));
  });
});
