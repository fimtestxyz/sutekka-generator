// Reader sheet magnifier (Amazon-style lens). Loads the real
// web_app/app.js in a vm sandbox with a stub DOM and a mocked fetch,
// then drives the lens:
//
//  - a circular lens follows the pointer over #setImg and shows the
//    same sheet at 0.8x; the zoomed view stays centred on the pointer
//    and is clamped so the lens never shows blank background
//    (below 1x, on a sheet small enough that the zoomed image fits
//    inside the lens, the image is centred in the lens instead)
//  - desktop hover shows/tracks/hides it; a plain click still opens
//    the fullscreen lightbox
//  - touch: the Magnify button toggles the mode; a finger drag moves
//    the lens (lifted above the finger), taps do not open the
//    lightbox while the mode is on
//  - Escape, or a tap outside the sheet, exits the mode
//  - while the mode is on, #magnifyControls offers a zoom stepper
//    (0.5x–1.5x, 0.1x steps) and S/M/L lens sizes, persisted per
//    device in localStorage under 'sutekka-magnifier-v1'
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
  return { doc, storage, calls, flush, wait, vis, label, badge, storedCart, fireStepper, cartPuts, win: sandbox, winHandlers };
}


// The sheet is a 1600x1600 PNG shown at 800x800 in the reader.
function rigSheet(app) {
  const img = app.doc.getElementById("setImg");
  img.naturalWidth = 1600;
  img.naturalHeight = 1600;
  img.offsetLeft = 0;
  img.offsetTop = 0;
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 800 });
  return img;
}

function fire(el, type, ev = {}) {
  (el._handlers[type] || []).forEach((fn) => fn(ev));
}

function fireDoc(app, type, ev = {}) {
  (app.doc._handlers[type] || []).forEach((fn) => fn(ev));
}

const lens = (app) => {
  const el = app.doc.getElementById("sheetLens");
  return {
    hidden: el.hidden,
    left: el.style.left,
    top: el.style.top,
    bgPos: el.style.backgroundPosition,
    bgSize: el.style.backgroundSize,
    bgImg: el.style.backgroundImage,
  };
};

const magnifyPressed = (app) => app.doc.getElementById("magnifyBtn").getAttribute("aria-pressed");
const lightboxHidden = (app) => app.doc.getElementById("imageModal").hidden;
// The stub builds every element with hidden=false, but the real page
// ships the lightbox hidden — set it so open/closed is observable.
const closeLightbox = (app) => {
  app.doc.getElementById("imageModal").hidden = true;
};

function closeAllLayers(app) {
  // The Escape chain closes the topmost layer first; make every layer
  // closed so Escape reaches the magnify-mode branch.
  for (const id of ["columnModal", "stickerModal", "imageModal", "removeModal"]) {
    app.doc.getElementById(id).hidden = true;
  }
}

describe("magnifier lens geometry (mouse hover, 800px display of a 1600px sheet)", () => {
  it("centres the 0.8x view on the pointer", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    rigSheet(app);
    fire(app.doc.getElementById("setImg"), "pointermove", { pointerType: "mouse", clientX: 400, clientY: 400 });
    assert.deepEqual(lens(app), {
      hidden: false,
      left: "310px",
      top: "310px",
      bgPos: "-550px -550px",
      bgSize: "1280px 1280px",
      bgImg: 'url("sheet.png")',
    });
  });

  it("clamps the lens and the zoomed view at the bottom-right corner", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    rigSheet(app);
    fire(app.doc.getElementById("setImg"), "pointermove", { pointerType: "mouse", clientX: 790, clientY: 790 });
    const l = lens(app);
    assert.equal(l.hidden, false);
    assert.equal(l.left, "620px");
    assert.equal(l.top, "620px");
    assert.equal(l.bgPos, "-1100px -1100px");
  });

  it("clamps at the left edge: lens at 0, zoomed view shows the edge", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    rigSheet(app);
    fire(app.doc.getElementById("setImg"), "pointermove", { pointerType: "mouse", clientX: 5, clientY: 400 });
    const l = lens(app);
    assert.equal(l.hidden, false);
    assert.equal(l.left, "0px");
    assert.equal(l.bgPos, "0px -550px");
  });

  it("mouseleave hides the lens", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    rigSheet(app);
    const img = app.doc.getElementById("setImg");
    fire(img, "pointermove", { pointerType: "mouse", clientX: 400, clientY: 400 });
    assert.equal(lens(app).hidden, false);
    fire(img, "pointerleave", {});
    assert.equal(lens(app).hidden, true);
  });

  it("phone-size lens (120px, S) lifts clear of the finger on a short sheet", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    // A wide sheet at phone width: 360x180 displayed, 3600x1800 natural.
    const img = app.doc.getElementById("setImg");
    img.naturalWidth = 3600;
    img.naturalHeight = 1800;
    img.offsetLeft = 0;
    img.offsetTop = 0;
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 180 });
    app.doc.getElementById("sheetLens").offsetWidth = 120;
    fire(app.doc.getElementById("magnifyBtn"), "click", {});
    assert.equal(magnifyPressed(app), "true");
    fire(img, "pointerdown", { pointerType: "touch", clientX: 180, clientY: 90, preventDefault() {} });
    assert.deepEqual(lens(app), {
      hidden: false,
      left: "120px",
      top: "0px",
      bgPos: "-1380px -660px",
      bgSize: "2880px 1440px",
      bgImg: 'url("sheet.png")',
    });
  });

  it("default L lens (240px) on a 180px-tall phone sheet pins to the corner and still shows the right region", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    // Same wide sheet, but the lens (240px) is taller than the sheet
    // (180px): left/top clamp to 0 and only the zoomed content moves.
    const img = app.doc.getElementById("setImg");
    img.naturalWidth = 3600;
    img.naturalHeight = 1800;
    img.offsetLeft = 0;
    img.offsetTop = 0;
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 180 });
    app.doc.getElementById("sheetLens").offsetWidth = 240;
    fire(app.doc.getElementById("magnifyBtn"), "click", {});
    fire(img, "pointerdown", { pointerType: "touch", clientX: 180, clientY: 90, preventDefault() {} });
    assert.deepEqual(lens(app), {
      hidden: false,
      left: "60px",
      top: "0px",
      bgPos: "-1320px -600px",
      bgSize: "2880px 1440px",
      bgImg: 'url("sheet.png")',
    });
    // Bottom-right corner: the lens pins to the image's far edge and
    // the zoomed view clamps to the sheet's far edge — no blank.
    fire(img, "pointermove", { pointerType: "touch", clientX: 350, clientY: 170 });
    const l = lens(app);
    assert.equal(l.hidden, false);
    assert.equal(l.left, "120px");
    assert.equal(l.top, "0px");
    assert.equal(l.bgPos, "-2640px -1200px");
  });

  it("no lens before the sheet has a natural size", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    const img = app.doc.getElementById("setImg");
    img.naturalWidth = 0;
    img.naturalHeight = 0;
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 800 });
    fire(img, "pointermove", { pointerType: "mouse", clientX: 400, clientY: 400 });
    assert.equal(lens(app).hidden, true);
  });
});

describe("zoom below 1x: the zoomed image can fit inside the lens", () => {
  const PREFS_KEY = "sutekka-magnifier-v1";
  // A small sheet: 300x150 natural, shown at 300x150, with the
  // 240px L lens. At 0.8x the zoomed image is 240x120; at 0.5x it
  // is 150x75 — smaller than the lens in both axes.
  function rigSmallSheet(app) {
    const img = app.doc.getElementById("setImg");
    img.naturalWidth = 300;
    img.naturalHeight = 150;
    img.offsetLeft = 0;
    img.offsetTop = 0;
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 150 });
    app.doc.getElementById("sheetLens").offsetWidth = 240;
    return img;
  }
  const finiteNums = (l) =>
    (l.bgPos + " " + l.bgSize).split(/px| /).filter(Boolean).map(Number).every((n) => Number.isFinite(n));

  it("at 0.8x the image fills the lens width and is centred vertically", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    const img = rigSmallSheet(app);
    fire(img, "pointermove", { pointerType: "mouse", clientX: 150, clientY: 75 });
    assert.deepEqual(lens(app), {
      hidden: false,
      left: "30px",
      top: "0px",
      bgPos: "0px 60px",
      bgSize: "240px 120px",
      bgImg: 'url("sheet.png")',
    });
  });

  it("at 0.5x the whole zoomed image is centred in the lens, at any pointer position", async () => {
    const app = boot({
      hash: "#/set/riemann-rashomon",
      indexSets: [TEST_SET],
      seedStorage: { [PREFS_KEY]: JSON.stringify({ zoom: 0.5, size: "L" }) },
    });
    await app.flush();
    assert.equal(app.doc.getElementById("magnifyZoomVal").textContent, "0.5×");
    const img = rigSmallSheet(app);
    fire(img, "pointermove", { pointerType: "mouse", clientX: 150, clientY: 75 });
    let l = lens(app);
    assert.deepEqual(l, {
      hidden: false,
      left: "30px",
      top: "0px",
      bgPos: "45px 82.5px",
      bgSize: "150px 75px",
      bgImg: 'url("sheet.png")',
    });
    assert.ok(finiteNums(l), "no NaN in the lens geometry");
    // Corner pointer: the image stays centred — it does not chase
    // the pointer, and no axis shows a blank margin on one side only.
    fire(img, "pointermove", { pointerType: "mouse", clientX: 290, clientY: 140 });
    l = lens(app);
    assert.equal(l.bgPos, "45px 82.5px");
    assert.equal(l.bgSize, "150px 75px");
    assert.equal(l.left, "60px");
    assert.equal(l.top, "0px");
    assert.ok(finiteNums(l), "no NaN in the lens geometry");
  });
});

describe("plain click still opens the fullscreen lightbox", () => {
  it("click on the sheet opens it when magnify mode is off", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    rigSheet(app);
    assert.equal(magnifyPressed(app), "false");
    closeLightbox(app);
    fire(app.doc.getElementById("setImg"), "click", {});
    assert.equal(lightboxHidden(app), false);
  });

  it("Enter on the focused sheet opens it when magnify mode is off", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    rigSheet(app);
    closeLightbox(app);
    fire(app.doc.getElementById("setImg"), "keydown", { key: "Enter", preventDefault() {} });
    assert.equal(lightboxHidden(app), false);
  });
});

describe("Magnify mode (touch)", () => {
  async function bootedInMode() {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    rigSheet(app);
    fire(app.doc.getElementById("magnifyBtn"), "click", {});
    assert.equal(magnifyPressed(app), "true");
    assert.equal(app.doc.getElementById("stage").style.touchAction, "none");
    return app;
  }

  it("toggle button flips aria-pressed and the stage touch-action, and off hides the lens", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    rigSheet(app);
    assert.equal(magnifyPressed(app), "false");
    fire(app.doc.getElementById("magnifyBtn"), "click", {});
    assert.equal(magnifyPressed(app), "true");
    assert.equal(app.doc.getElementById("stage").style.touchAction, "none");
    fire(app.doc.getElementById("magnifyBtn"), "click", {});
    assert.equal(magnifyPressed(app), "false");
    assert.equal(app.doc.getElementById("stage").style.touchAction, "");
    assert.equal(lens(app).hidden, true);
  });

  it("finger drag shows the lens lifted above the finger and tracks it", async () => {
    const app = await bootedInMode();
    const img = app.doc.getElementById("setImg");
    fire(img, "pointerdown", { pointerType: "touch", clientX: 400, clientY: 400, preventDefault() {} });
    let l = lens(app);
    assert.equal(l.hidden, false);
    assert.equal(l.left, "310px");
    assert.equal(l.top, "220px"); // 400 - 90 (lift) - 90 (radius)
    assert.equal(l.bgPos, "-550px -550px"); // zoomed view still centred on the finger
    fire(img, "pointermove", { pointerType: "touch", clientX: 600, clientY: 200 });
    l = lens(app);
    assert.equal(l.left, "510px");
    assert.equal(l.top, "20px"); // 200 - 90 - 90
    fire(img, "pointerup", {});
    // The lens stays put after the finger lifts, for inspection.
    assert.equal(lens(app).hidden, false);
  });

  it("a touch move without a drag does nothing", async () => {
    const app = await bootedInMode();
    const img = app.doc.getElementById("setImg");
    fire(img, "pointermove", { pointerType: "touch", clientX: 400, clientY: 400 });
    assert.equal(lens(app).hidden, true);
  });

  it("a tap on the sheet does not open the lightbox while the mode is on", async () => {
    const app = await bootedInMode();
    const img = app.doc.getElementById("setImg");
    closeLightbox(app);
    fire(img, "pointerdown", { pointerType: "touch", clientX: 400, clientY: 400, preventDefault() {} });
    fire(img, "pointerup", {});
    fire(img, "click", {});
    assert.equal(lightboxHidden(app), true);
    fire(img, "keydown", { key: "Enter", preventDefault() {} });
    assert.equal(lightboxHidden(app), true);
  });

  it("a mouse hover still moves the lens while the mode is on, but a click does not open the lightbox", async () => {
    const app = await bootedInMode();
    const img = app.doc.getElementById("setImg");
    closeLightbox(app);
    fire(img, "pointermove", { pointerType: "mouse", clientX: 100, clientY: 100 });
    assert.equal(lens(app).left, "10px");
    fire(img, "click", {});
    assert.equal(lightboxHidden(app), true);
  });

  it("Escape exits the mode and hides the lens", async () => {
    const app = await bootedInMode();
    closeAllLayers(app);
    fireDoc(app, "keydown", { key: "Escape" });
    assert.equal(magnifyPressed(app), "false");
    assert.equal(lens(app).hidden, true);
    assert.equal(app.doc.getElementById("stage").style.touchAction, "");
  });

  it("a tap outside the sheet exits the mode; a tap on the sheet does not", async () => {
    const app = await bootedInMode();
    closeAllLayers(app);
    const outside = { closest: () => null };
    fireDoc(app, "click", { target: outside });
    assert.equal(magnifyPressed(app), "false");
    // Re-enter and tap the sheet itself: the mode stays on.
    fire(app.doc.getElementById("magnifyBtn"), "click", {});
    assert.equal(magnifyPressed(app), "true");
    const onSheet = { closest: (sel) => (sel === "#stage" ? {} : null) };
    fireDoc(app, "click", { target: onSheet });
    assert.equal(magnifyPressed(app), "true");
  });

  it("opening another set turns the mode off", async () => {
    const app = await bootedInMode();
    assert.equal(magnifyPressed(app), "true");
    // Navigate to another set: openSet runs again and resets the mode.
    app.win.location.hash = "#/set/other-set";
    (app.winHandlers.hashchange || []).forEach((fn) => fn({}));
    await app.flush();
    assert.equal(magnifyPressed(app), "false");
    assert.equal(lens(app).hidden, true);
  });
});

describe("magnifier zoom + lens size controls", () => {
  const PREFS_KEY = "sutekka-magnifier-v1";
  const zoomVal = (app) => app.doc.getElementById("magnifyZoomVal").textContent;
  const sizePressed = (app, s) => app.doc.getElementById("magnifySize" + s).getAttribute("aria-pressed");
  const storedPrefs = (app) => JSON.parse(app.storage.getItem(PREFS_KEY) || "{}");
  const controlsHidden = (app) => app.doc.getElementById("magnifyControls").hidden;
  // The stub DOM carries no HTML attributes, so rig the control
  // buttons' ids / data attributes before firing their clicks.
  const rigControls = (app) => {
    for (const s of ["S", "M", "L"]) {
      const el = app.doc.getElementById("magnifySize" + s);
      el.id = "magnifySize" + s;
      el.setAttribute("data-mag-size", s);
    }
    app.doc.getElementById("magnifyZoomDec").id = "magnifyZoomDec";
    app.doc.getElementById("magnifyZoomInc").id = "magnifyZoomInc";
  };
  const fireControl = (app, el) => {
    const target = { closest: (sel) => (sel === "button" ? el : null) };
    fire(app.doc.getElementById("magnifyControls"), "click", { target });
  };

  it("defaults to 0.8x and size L, persisted on first load", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    assert.equal(zoomVal(app), "0.8×");
    assert.equal(sizePressed(app, "L"), "true");
    assert.equal(sizePressed(app, "S"), "false");
    assert.equal(sizePressed(app, "M"), "false");
    assert.deepEqual(storedPrefs(app), { zoom: 0.8, size: "L" });
  });

  it("zoom stepper moves in 0.1x steps and clamps at 0.5x and 1.5x", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    rigControls(app);
    const inc = app.doc.getElementById("magnifyZoomInc");
    const dec = app.doc.getElementById("magnifyZoomDec");
    fireControl(app, inc);
    assert.equal(zoomVal(app), "0.9×");
    assert.equal(storedPrefs(app).zoom, 0.9);
    fireControl(app, dec);
    fireControl(app, dec);
    assert.equal(zoomVal(app), "0.7×");
    for (let i = 0; i < 8; i++) fireControl(app, inc);
    assert.equal(zoomVal(app), "1.5×");
    assert.equal(inc.disabled, true);
    fireControl(app, inc);
    assert.equal(zoomVal(app), "1.5×");
    for (let i = 0; i < 10; i++) fireControl(app, dec);
    assert.equal(zoomVal(app), "0.5×");
    assert.equal(dec.disabled, true);
    fireControl(app, dec);
    assert.equal(zoomVal(app), "0.5×");
    assert.equal(storedPrefs(app).zoom, 0.5);
  });

  it("a zoom change re-renders a visible lens at the new zoom", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    rigSheet(app);
    rigControls(app);
    fire(app.doc.getElementById("magnifyBtn"), "click", {});
    const img = app.doc.getElementById("setImg");
    fire(img, "pointerdown", { pointerType: "touch", clientX: 400, clientY: 400, preventDefault() {} });
    assert.equal(lens(app).bgSize, "1280px 1280px");
    fireControl(app, app.doc.getElementById("magnifyZoomInc"));
    const l = lens(app);
    assert.equal(l.bgSize, "1440px 1440px");
    assert.equal(l.bgPos, "-630px -630px");
    assert.equal(l.left, "310px");
  });

  it("size buttons switch the active size and persist it", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    rigControls(app);
    fireControl(app, app.doc.getElementById("magnifySizeM"));
    assert.equal(sizePressed(app, "M"), "true");
    assert.equal(sizePressed(app, "L"), "false");
    assert.equal(storedPrefs(app).size, "M");
    fireControl(app, app.doc.getElementById("magnifySizeS"));
    assert.equal(sizePressed(app, "S"), "true");
    assert.equal(sizePressed(app, "M"), "false");
    assert.equal(storedPrefs(app).size, "S");
  });

  it("desktop L lens (360px) geometry follows the rendered size", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    rigSheet(app);
    app.doc.getElementById("sheetLens").offsetWidth = 360;
    fire(app.doc.getElementById("setImg"), "pointermove", { pointerType: "mouse", clientX: 400, clientY: 400 });
    assert.deepEqual(lens(app), {
      hidden: false,
      left: "220px",
      top: "220px",
      bgPos: "-460px -460px",
      bgSize: "1280px 1280px",
      bgImg: 'url("sheet.png")',
    });
  });

  it("stored prefs load on boot; out-of-range values fall back to the 0.8x default", async () => {
    const seeded = boot({
      hash: "#/set/riemann-rashomon",
      indexSets: [TEST_SET],
      seedStorage: { [PREFS_KEY]: JSON.stringify({ zoom: 1.4, size: "M" }) },
    });
    await seeded.flush();
    assert.equal(zoomVal(seeded), "1.4×");
    assert.equal(sizePressed(seeded, "M"), "true");
    assert.equal(sizePressed(seeded, "L"), "false");
    const bad = boot({
      hash: "#/set/riemann-rashomon",
      indexSets: [TEST_SET],
      seedStorage: { [PREFS_KEY]: JSON.stringify({ zoom: 99, size: "X" }) },
    });
    await bad.flush();
    assert.equal(zoomVal(bad), "0.8×");
    assert.equal(sizePressed(bad, "L"), "true");
    // A zoom saved under an older range (e.g. the old 3.25x default)
    // falls back to 0.8x, not to the 1.5x bound.
    const old = boot({
      hash: "#/set/riemann-rashomon",
      indexSets: [TEST_SET],
      seedStorage: { [PREFS_KEY]: JSON.stringify({ zoom: 3.25, size: "L" }) },
    });
    await old.flush();
    assert.equal(zoomVal(old), "0.8×");
    assert.equal(sizePressed(old, "L"), "true");
    // A stored 1.3x is still inside the new 0.5x–1.5x range, so it stays.
    const kept = boot({
      hash: "#/set/riemann-rashomon",
      indexSets: [TEST_SET],
      seedStorage: { [PREFS_KEY]: JSON.stringify({ zoom: 1.3, size: "L" }) },
    });
    await kept.flush();
    assert.equal(zoomVal(kept), "1.3×");
    assert.equal(sizePressed(kept, "L"), "true");
    const junk = boot({
      hash: "#/set/riemann-rashomon",
      indexSets: [TEST_SET],
      seedStorage: { [PREFS_KEY]: "not json{" },
    });
    await junk.flush();
    assert.equal(zoomVal(junk), "0.8×");
    assert.equal(sizePressed(junk, "L"), "true");
  });

  it("controls show only while magnify mode is on, and tapping them does not exit the mode", async () => {
    const app = boot({ hash: "#/set/riemann-rashomon", indexSets: [TEST_SET] });
    await app.flush();
    rigSheet(app);
    // The stub ships hidden=false; the real page ships the row hidden.
    app.doc.getElementById("magnifyControls").hidden = true;
    assert.equal(controlsHidden(app), true);
    fire(app.doc.getElementById("magnifyBtn"), "click", {});
    assert.equal(controlsHidden(app), false);
    closeAllLayers(app);
    const onControls = { closest: (sel) => (sel === "#magnifyControls" ? {} : null) };
    fireDoc(app, "click", { target: onControls });
    assert.equal(magnifyPressed(app), "true");
    assert.equal(controlsHidden(app), false);
    fire(app.doc.getElementById("magnifyBtn"), "click", {});
    assert.equal(controlsHidden(app), true);
    assert.equal(lens(app).hidden, true);
  });
});
