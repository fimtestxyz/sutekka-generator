/* Sticker Showcase — vanilla JS, hash routing, cached index.
 *
 * Caching, in two layers:
 *  1. HTTP cache headers (vercel.json) — browser + Vercel Edge.
 *  2. localStorage copy of index.json — the grid renders instantly
 *     on a repeat visit, then revalidates in the background.
 *  3. Service worker (sw.js) — cache-first for images, so a set
 *     opened once never downloads again for a week.
 */
(function () {
  'use strict';

  var LS_KEY = 'sticker-showcase-index-v12';
  var LS_TTL_MS = 60 * 60 * 1000; // revalidate after 1 hour
  // DATA_V: bump whenever data/index.json changes in ANY way that must
  // reach users — not just a shape change. A content change (new batch,
  // new tags, a new set) leaves the old file in the localStorage copy
  // and the service-worker cache under the same ?v=, so browsers keep
  // rendering stale data after a deploy (seen 2026-11-26: the batch
  // split shipped but the homepage still showed one batch until this
  // bump). The fetch URL carries it, so no cache layer — HTTP, service
  // worker, or the localStorage copy above (its key carries the same
  // version) — can serve stale data after a deploy. The ?v= on
  // app.js/styles.css is the same idea for the shell; all three
  // numbers move together.
  var DATA_V = 12;
  // LINKS_V: bump whenever data/payment-links.json changes — a new
  // product, a new price, or a new link. Same cache-busting idea as
  // DATA_V; the service worker caches the file under this ?v= too.
  var LINKS_V = 1;
  var PAGE_SIZE = 12;

  var state = {
    sets: [],
    series: [],
    batch: 'all',
    lang: 'all', // CONTENT filter: which sets the grid shows (all / zh / en)
    uiLang: 'en', // UI language: which language the chrome speaks (en / zh).
    // The two "languages" are different things that share a word.
    // They never share a variable, a localStorage key, or a toggle:
    // state.lang is the content filter, state.uiLang is the UI.
    topic: null,
    q: '',
    shown: PAGE_SIZE,
    gaId: null,
    gaReady: false,
    lastSentHash: null,
    currentSlug: null,
    currentSticker: null, // sticker object shown in the modal, if any
    replyTo: null, // thread id a comment reply goes to, or null
    bookmarksSort: 'recent', // recent | oldest | title
    engageReady: null, // null = unknown, true = API up, false = API down
    session: null, // Auth.js session user, or null when signed out
    authAvailable: null, // null = unknown, true = /api/auth up, false = not configured
    links: null, // payment-links.json: shop prices + Stripe Payment Link URLs
    siteSettings: null, // GET /api/settings: shopClosed, announcement, hiddenItems
    admin: null, // admin session user ({ username }) or null
    adminSetupNeeded: false,
    adminOrdersPage: 1,
    adminOrdersFilter: { status: '', q: '' },
    cart: [], // [{ itemId, type }] — one of each item; localStorage (CART.md)
    lastSyncedCart: [], // cart as of the last successful server sync (CART_SYNC.md)
    magnifyMode: false, // reader sheet magnifier on/off (Magnify button)
    cartDrafts: [] // [{ name, items, createdAt }] — named snapshots, localStorage
  };

  var $ = function (id) { return document.getElementById(id); };
  var homeEl = $('home'), readerEl = $('reader'), aboutEl = $('about'), loginEl = $('login'), profileEl = $('profile'), bookmarksEl = $('bookmarks'), collectionsEl = $('collections'), galleryEl = $('gallery'), downloadEl = $('download'), adminEl = $('admin');

  /* ---------- bilingual UI (EN / 中文) ---------- */
  // The strings live in data/i18n/en.json + zh.json (flat
  // dictionaries, identical key sets, dotted keys — the same
  // pattern as the Gobblemon hub and the Sixth Panel comics site).
  // applyLang() re-renders every element carrying a data-i18n*
  // attribute, then re-renders the dynamic text via
  // renderDynamicText(). The language resolves, in order:
  //   1. ?lang=en|zh — a one-time override, then persisted
  //   2. localStorage "sutekka-ui-lang-v1"
  //   3. navigator.language (zh-* → zh, anything else → en)
  // UI-only: the sticker art, the columns and the set/sticker
  // titles stay Chinese. The admin (#/kangle) stays English-only,
  // and so do the transactional/legal strings (the refund-policy
  // line, the GST line, the invoice copy). The content filter
  // (state.lang) is untouched — an English UI does NOT narrow the
  // catalogue; the reader chooses that with the All / 中文 / EN
  // filter.
  var LS_UI_LANG_KEY = 'sutekka-ui-lang-v1';
  var dicts = { en: null, zh: null };
  function t(key) {
    if (dicts[state.uiLang] && dicts[state.uiLang][key] != null) return dicts[state.uiLang][key];
    if (dicts.en && dicts.en[key] != null) return dicts.en[key];
    return key;
  }
  function applyLang(lang) {
    // Both dictionaries failed to load (offline on first visit):
    // leave the page in its static English instead of writing
    // dictionary keys into the chrome.
    if (!dicts.en && !dicts.zh) return;
    state.uiLang = lang === 'zh' ? 'zh' : 'en';
    document.documentElement.lang = state.uiLang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('meta.title');
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    document.querySelectorAll('[data-i18n-alt]').forEach(function (el) {
      el.alt = t(el.getAttribute('data-i18n-alt'));
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    document.querySelectorAll('[data-i18n-content]').forEach(function (el) {
      el.setAttribute('content', t(el.getAttribute('data-i18n-content')));
    });
    document.querySelectorAll('.ui-lang-toggle [data-uilang]').forEach(function (btn) {
      var active = btn.getAttribute('data-uilang') === state.uiLang;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.classList.toggle('active', active);
    });
    renderDynamicText();
  }
  function resolveLang() {
    var q = null;
    try { q = new URLSearchParams(location.search).get('lang'); } catch (e) {}
    if (q === 'en' || q === 'zh') {
      try { localStorage.setItem(LS_UI_LANG_KEY, q); } catch (e) {}
      return q;
    }
    try {
      var saved = localStorage.getItem(LS_UI_LANG_KEY);
      if (saved === 'en' || saved === 'zh') return saved;
    } catch (e) {}
    var nav = (navigator.language || 'en').toLowerCase();
    return nav.indexOf('zh') === 0 ? 'zh' : 'en';
  }
  function setLang(lang) {
    try { localStorage.setItem(LS_UI_LANG_KEY, lang); } catch (e) {}
    applyLang(lang);
  }
  function loadDicts() {
    return Promise.all(['en', 'zh'].map(function (lang) {
      return fetch('data/i18n/' + lang + '.json', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) { dicts[lang] = d; })
        .catch(function () { /* stay in static English for this language */ });
    }));
  }
  // Re-render the dynamic text after a language switch, without
  // re-fetching what is already on the page where that is cheap:
  // the home grid rebuilds from state, the reader re-opens in place
  // (scroll position preserved), the cart drawer re-renders from
  // local state, and the signed-in views re-render from their
  // (cached) data. The download view re-renders from its cached
  // order only — renderDownload() would restart the lookup poll
  // and reset its 404-retry counter, so it is never called here.
  // The admin is deliberately NOT re-rendered — it stays English
  // in v1.
  function renderDynamicText() {
    renderChips();
    renderTopics();
    renderGrid();
    renderAuthArea();
    renderCartButtons();
    if (!readerEl.hidden && state.currentSlug) {
      var y = window.scrollY || 0;
      openSet(state.currentSlug);
      window.scrollTo(0, y);
      if (state.currentSticker) {
        var s = state.currentSticker;
        renderStickerLike(lsGet(LS_LIKE_COUNTS_KEY)[s.id] || 0, Boolean(lsGet(LS_LIKED_KEY)[s.id]));
        renderStickerBookmark(Boolean(lsGet(LS_BOOKMARKED_KEY)[s.id]));
        renderStickerBuyBtn();
        renderCartButtons();
      }
    }
    if ($('cartDrawer').classList.contains('open')) renderCart();
    if (!bookmarksEl.hidden) renderBookmarks();
    if (!collectionsEl.hidden) renderCollections();
    if (!galleryEl.hidden) renderGallery();
    if (!profileEl.hidden) renderProfile();
    if (!loginEl.hidden) renderLogin();
    if (!downloadEl.hidden && state.downloadOrder) renderOrderDownload(state.downloadOrder, state.downloadSessionId);
  }

  /* ---------- analytics (GA4) + engagement ---------- */

  var LS_LIKED_KEY = 'sticker-showcase-liked-v1';
  var LS_LIKE_COUNTS_KEY = 'sticker-showcase-like-counts-v1';
  var LS_BOOKMARKED_KEY = 'sticker-showcase-bookmarked-v1';
  var LS_BOOKMARKS_KEY = 'sticker-showcase-bookmarks-v1';

  function gaEvent(name, params) {
    if (!state.gaReady || typeof window.gtag !== 'function') return;
    try { window.gtag('event', name, params || {}); } catch (e) { /* analytics is optional */ }
  }

  function trackPageView() {
    if (!state.gaReady) return;
    var path = location.hash || '#/';
    if (path === state.lastSentHash) return;
    state.lastSentHash = path;
    gaEvent('page_view', { page_path: path, page_title: document.title });
  }

  function loadConfig() {
    fetchJson('data/config.json').then(function (cfg) {
      if (!cfg || !cfg.gaMeasurementId) return;
      state.gaId = cfg.gaMeasurementId;
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
      window.gtag('config', state.gaId, { send_page_view: false });
      state.gaReady = true;
      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(state.gaId);
      document.head.appendChild(s);
      trackPageView();
    }).catch(function () { /* no analytics configured — the site still works */ });
  }

  /* ---------- auth session ---------- */

  function loadSession() {
    fetch('/api/auth/session', { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 503) { state.authAvailable = false; return null; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        state.authAvailable = true;
        return r.json();
      })
      .then(function (d) {
        state.session = d && d.user ? d.user : null;
        renderAuthArea();
        updateSavedBadges();
        if (state.session) prefetchBookmarks();
        if (state.session) syncCartWithServer();
        var hash = location.hash || '#/';
        if (hash === '#/login') renderLogin();
        if (hash === '#/profile') renderProfile();
        if (hash === '#/bookmarks') renderBookmarks();
        if (hash === '#/collections') renderCollections();
      })
      .catch(function () {
        state.authAvailable = false;
        renderAuthArea();
        updateSavedBadges();
      });
  }

  function renderAuthArea() {
    var el = $('authArea');
    if (!el) return;
    var u = state.session;
    if (!u) { el.innerHTML = '<a href="#/login"><i class="fi fi-br-user"></i><span class="nav-label">' + t('nav.signIn') + '</span></a>'; return; }
    // The user area is its own block, separate from the main nav: an
    // avatar button that opens a dropdown (Profile / Bookmarks /
    // Collections / Sign out) instead of three same-weight links.
    var avatar = u.image
      ? '<img src="' + esc(u.image) + '" alt="" class="auth-avatar">'
      : '<span class="auth-avatar auth-avatar-fallback" aria-hidden="true">' + esc((u.name || u.email || '?').charAt(0).toUpperCase()) + '</span>';
    el.innerHTML =
      '<details class="user-menu">' +
      '<summary>' + avatar + '<span class="auth-name">' + esc(u.name || u.email || t('auth.signedIn')) + '</span><i class="fi fi-br-angle-down"></i></summary>' +
      '<div class="user-menu-list">' +
      '<a href="#/profile">' + t('auth.profile') + '</a>' +
      '<a href="#/bookmarks">' + t('auth.bookmarks') + '</a>' +
      '<a href="#/collections">' + t('auth.collections') + '</a>' +
      '<hr>' +
      '<a href="/api/auth/signout">' + t('auth.signOut') + '</a>' +
      '</div></details>';
  }

  function renderLogin() {
    var body = $('loginBody');
    if (!body) return;
    var u = state.session;
    if (u) {
      body.innerHTML = '';
      var p = document.createElement('p');
      p.textContent = t('login.signedInAs').replace('{name}', u.name || u.email || '');
      body.appendChild(p);
      var out = document.createElement('a');
      out.href = '/api/auth/signout';
      out.className = 'btn';
      out.textContent = t('auth.signOut');
      body.appendChild(out);
      return;
    }
    if (state.authAvailable === null) {
      body.innerHTML = '<p>' + t('login.checking') + '</p>';
      return;
    }
    if (state.authAvailable === false) {
      body.innerHTML = '<p>' + t('login.notSetup') + '</p>';
      return;
    }
    body.innerHTML = '<p>' + t('login.intro') + '</p>' +
      '<form id="googleSigninForm" method="POST" action="/api/auth/signin/google">' +
      '<input type="hidden" name="csrfToken" value="">' +
      '<input type="hidden" name="callbackUrl" value="/">' +
      '<button class="btn" type="submit" disabled>' + t('login.google') + '</button></form>' +
      '<p class="meta">' + t('login.googleNote') + '</p>';
    // Auth.js v5 signs in by POST with a CSRF token (a plain GET link to
    // /api/auth/signin/google is not a sign-in). Fetch the token first;
    // the fetch also sets the CSRF cookie the POST is checked against.
    fetch('/api/auth/csrf', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var f = $('googleSigninForm');
        if (!f) return;
        f.querySelector('input[name="csrfToken"]').value = d.csrfToken || '';
        f.querySelector('button[type="submit"]').disabled = false;
      })
      .catch(function () {
        var f = $('googleSigninForm');
        if (f) f.querySelector('button[type="submit"]').disabled = false;
      });
  }

  /* ---------- profile + preferences ---------- */

  function profileFetch(path, options) {
    return fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}));
  }

  function renderProfile() {
    var body = $('profileBody');
    if (!body) return;
    if (!state.session) {
      body.innerHTML = '<p>' + t('profile.signInFirst') + '</p><p><a class="btn" href="#/login">' + t('nav.signIn') + '</a></p>';
      return;
    }
    if (state.authAvailable === false) {
      body.innerHTML = '<p>' + t('profile.notSetup') + '</p>';
      return;
    }
    body.innerHTML = '<p>' + t('common.loading') + '</p>';
    Promise.all([
      profileFetch('/api/me/profile').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      profileFetch('/api/me/preferences').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    ]).then(function (res) {
      renderProfileForms(res[0], res[1]);
    }).catch(function () {
      body.innerHTML = '<p>' + t('profile.loadFailed') + '</p>';
    });
  }

  function renderProfileForms(me, prefs) {
    var body = $('profileBody');
    var u = me.user, p = me.profile || {};
    var avatar = p.customAvatar || u.image || '';
    var kwLines = (prefs.keywords || []).map(function (k) {
      return k.weight === 1 ? k.keyword : k.keyword + '=' + k.weight;
    }).join('\n');
    body.innerHTML =
      '<form id="profileForm" class="comment-form" onsubmit="return false;">' +
      '<img class="profile-deco" src="icons/smile.png" alt="" width="512" height="512">' +
      '<h2>' + t('profile.heading') + '</h2>' +
      (avatar ? '<p><img class="profile-avatar" src="' + esc(avatar) + '" alt=""></p>' : '') +
      '<label class="field"><span>' + t('profile.name') + '</span><input id="profileName" type="text" maxlength="100" value="' + esc(u.name || '') + '" autocomplete="nickname"></label>' +
      '<label class="field"><span>' + t('profile.bio') + '</span><textarea id="profileBio" rows="3" maxlength="280">' + esc(p.bio || '') + '</textarea></label>' +
      '<label class="field"><span>' + t('profile.avatar') + '</span><input id="profileAvatar" type="text" inputmode="url" maxlength="2048" value="' + esc(p.customAvatar || '') + '" autocomplete="off"></label>' +
      '<button type="submit">' + t('profile.save') + '</button>' +
      '<span id="profileMsg" class="comment-msg" aria-live="polite"></span>' +
      '</form>' +
      '<form id="prefsForm" class="comment-form" onsubmit="return false;">' +
      '<h2>' + t('profile.prefsHeading') + '</h2>' +
      '<p class="meta">' + t('profile.prefsHelp') + '</p>' +
      '<label class="field"><span>' + t('profile.keywords') + '</span><textarea id="prefsKeywords" rows="5">' + esc(kwLines) + '</textarea></label>' +
      '<button type="submit">' + t('profile.savePrefs') + '</button>' +
      '<span id="prefsMsg" class="comment-msg" aria-live="polite"></span>' +
      '</form>';
  }

  function saveProfile(e) {
    e.preventDefault();
    var msg = $('profileMsg');
    var body = {
      bio: $('profileBio').value,
      customAvatar: $('profileAvatar').value.trim()
    };
    var name = $('profileName').value.trim();
    if (name) body.name = name;
    msg.textContent = t('profile.saving');
    profileFetch('/api/me/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          msg.textContent = t('common.saveFailedDetails').replace('{details}', (res.d.details && res.d.details.join('; ')) || res.d.error || 'error');
          return;
        }
        if (res.d.user) { state.session = res.d.user; renderAuthArea(); }
        msg.textContent = t('common.saved');
      })
      .catch(function () { msg.textContent = t('common.saveFailed'); });
  }

  function parseKeywords(text) {
    var seen = {}, errors = [];
    text.split('\n').forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      var parts = t.split('=');
      var keyword = parts[0].trim();
      var weight = 1;
      if (parts.length > 1) {
        weight = parseFloat(parts.slice(1).join('='));
        if (isNaN(weight) || weight < 0 || weight > 2) { errors.push(t('profile.badWeight').replace('{v}', t)); return; }
      }
      if (!keyword || keyword.length > 40) { errors.push(t('profile.badKeyword').replace('{v}', t)); return; }
      seen[keyword] = weight;
    });
    var keywords = Object.keys(seen).map(function (k) { return { keyword: k, weight: seen[k] }; });
    return { keywords: keywords, errors: errors };
  }

  function savePreferences(e) {
    e.preventDefault();
    var msg = $('prefsMsg');
    var parsed = parseKeywords($('prefsKeywords').value);
    if (parsed.errors.length) { msg.textContent = parsed.errors[0]; return; }
    msg.textContent = t('profile.saving');
    profileFetch('/api/me/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keywords: parsed.keywords }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          msg.textContent = t('common.saveFailedDetails').replace('{details}', (res.d.details && res.d.details.join('; ')) || res.d.error || 'error');
          return;
        }
        msg.textContent = t('common.saved');
      })
      .catch(function () { msg.textContent = t('common.saveFailed'); });
  }

  function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
  }
  function lsSet(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) { /* storage full or private mode */ }
  }

  function renderLike(count, liked, localOnly) {
    var btn = $('likeBtn'), countEl = $('likeCount'), note = $('likeNote');
    if (!btn) return;
    state.likeCount = count;
    btn.innerHTML = '<i class="fi fi-br-heart"></i> ' + (liked ? t('reader.liked') : t('reader.like'));
    btn.setAttribute('aria-pressed', String(liked));
    countEl.textContent = count > 0 ? (count === 1 ? t('reader.likes.one') : t('reader.likes.other').replace('{n}', count)) : t('reader.noLikes');
    note.textContent = localOnly ? t('reader.likeLocal') : '';
  }

  function loadLikes(slug) {
    renderLike(lsGet(LS_LIKE_COUNTS_KEY)[slug] || 0, Boolean(lsGet(LS_LIKED_KEY)[slug]), false);
    fetch('/api/stickers/' + encodeURIComponent(slug) + '/like', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        state.engageReady = true;
        var counts = lsGet(LS_LIKE_COUNTS_KEY);
        counts[slug] = d.likes || 0;
        lsSet(LS_LIKE_COUNTS_KEY, counts);
        renderLike(d.likes || 0, d.liked || Boolean(lsGet(LS_LIKED_KEY)[slug]), false);
      })
      .catch(function () {
        state.engageReady = false;
        renderLike(lsGet(LS_LIKE_COUNTS_KEY)[slug] || 0, Boolean(lsGet(LS_LIKED_KEY)[slug]), true);
      });
  }

  function toggleLike() {
    var slug = state.currentSlug;
    if (!slug) return;
    if (!state.session) { location.hash = '#/login'; return; }
    var likedMap = lsGet(LS_LIKED_KEY);
    var liked = !likedMap[slug];
    // Optimistic: show the new state right away, so the tap feels instant;
    // the server call below only confirms it.
    var counts = lsGet(LS_LIKE_COUNTS_KEY);
    counts[slug] = Math.max(0, (state.likeCount || 0) + (liked ? 1 : -1));
    lsSet(LS_LIKE_COUNTS_KEY, counts);
    if (liked) likedMap[slug] = true; else delete likedMap[slug];
    lsSet(LS_LIKED_KEY, likedMap);
    renderLike(counts[slug], liked, state.engageReady === false);
    if (state.engageReady === false) return;
    fetch('/api/stickers/' + encodeURIComponent(slug) + '/like', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) { location.hash = '#/login'; throw new Error('signed out'); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (d.liked) likedMap[slug] = true; else delete likedMap[slug];
        lsSet(LS_LIKED_KEY, likedMap);
        counts[slug] = d.likes || 0;
        lsSet(LS_LIKE_COUNTS_KEY, counts);
        renderLike(d.likes || 0, d.liked, false);
        gaEvent('like', { slug: slug, liked: d.liked });
      })
      .catch(function (e) {
        if (e.message === 'signed out') {
          // Undo the optimistic update: the tap did not count.
          var m = lsGet(LS_LIKED_KEY);
          if (liked) delete m[slug]; else m[slug] = true;
          lsSet(LS_LIKED_KEY, m);
          var c = lsGet(LS_LIKE_COUNTS_KEY);
          c[slug] = Math.max(0, (state.likeCount || 0) + (liked ? -1 : 1));
          lsSet(LS_LIKE_COUNTS_KEY, c);
          renderLike(c[slug], !liked, false);
          return;
        }
        // Server unreachable: the optimistic state stays as the on-device
        // state, same as the old local-only fallback.
        state.engageReady = false;
      });
  }

  function commentHtml(c, threadId) {
    var thread = threadId || c.id;
    var mine = state.session && state.session.id === c.user.id;
    var when = c.createdAt ? new Date(c.createdAt).toLocaleString() : '';
    var avatar = c.user.customAvatar || c.user.image;
    var html = '<article class="comment" data-id="' + esc(c.id) + '" data-thread="' + esc(thread) + '">' +
      '<p class="c-head">' +
      (avatar ? '<img class="c-avatar" src="' + esc(avatar) + '" alt="">' : '') +
      '<strong>' + esc(c.user.name || t('comments.anonymous')) + '</strong>' +
      (when ? ' <span class="c-time">' + esc(when) + '</span>' : '') + '</p>' +
      '<p class="c-text">' + esc(c.content || '') + '</p>' +
      '<p class="c-actions">' +
      (state.session ? '<button type="button" data-act="reply">' + t('comments.reply') + '</button>' : '') +
      (mine ? ' <button type="button" data-act="edit">' + t('comments.edit') + '</button> <button type="button" data-act="delete">' + t('comments.delete') + '</button>' : '') +
      '</p>';
    if (c.replies && c.replies.length) {
      html += '<div class="c-replies">' + c.replies.map(function (r) { return commentHtml(r, thread); }).join('') + '</div>';
    }
    return html + '</article>';
  }

  function loadComments(slug) {
    var list = $('commentList'), msg = $('commentMsg');
    if (!list) return;
    list.innerHTML = '';
    if (msg) msg.textContent = t('comments.loading');
    fetch('/api/stickers/' + encodeURIComponent(slug) + '/comments', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        state.engageReady = true;
        var comments = d.comments || [];
        list.innerHTML = comments.length ? comments.map(function (c) { return commentHtml(c); }).join('') :
          '<p class="empty"><img class="empty-icon" src="icons/chat.png" alt="" width="512" height="512">' + t('comments.empty') + '</p>';
        if (msg) msg.textContent = '';
      })
      .catch(function () {
        state.engageReady = false;
        list.innerHTML = '';
        if (msg) {
          msg.textContent = t('comments.setup');
        }
      });
  }

  function setReplyTo(threadId, name) {
    state.replyTo = threadId;
    var hint = $('replyHint');
    if (!hint) return;
    if (!threadId) { hint.hidden = true; hint.innerHTML = ''; return; }
    hint.hidden = false;
    hint.innerHTML = esc(t('comments.replyingTo').replace('{name}', name || t('comments.thisThread'))) + ' <button type="button" id="replyCancel">' + t('comments.replyCancel') + '</button>';
  }

  function postComment(e) {
    e.preventDefault();
    var slug = state.currentSlug;
    var text = $('commentText').value.trim();
    var msg = $('commentMsg');
    if (!slug || !text) return;
    if (!state.session) { location.hash = '#/login'; return; }
    fetch('/api/stickers/' + encodeURIComponent(slug) + '/comments', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, parentId: state.replyTo || null })
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (res) {
        if (res.status === 401) { location.hash = '#/login'; return; }
        if (res.status === 429) { if (msg) msg.textContent = t('comments.rateLimit'); return; }
        if ((res.status !== 200 && res.status !== 201) || !res.d.comment) {
          if (msg) msg.textContent = (res.d.details && res.d.details.length)
            ? t('comments.postFailedDetails').replace('{details}', res.d.details.join('; '))
            : t('comments.failed');
          return;
        }
        var list = $('commentList');
        var c = res.d.comment;
        if (list) {
          var empty = list.querySelector('.empty');
          if (empty) empty.remove();
          if (c.parentId) {
            var thread = list.querySelector('article[data-id="' + c.parentId + '"]');
            if (thread) {
              var replies = thread.querySelector('.c-replies');
              if (!replies) {
                replies = document.createElement('div');
                replies.className = 'c-replies';
                thread.appendChild(replies);
              }
              replies.insertAdjacentHTML('beforeend', commentHtml(c, c.parentId));
            } else {
              list.insertAdjacentHTML('beforeend', commentHtml(c));
            }
          } else {
            list.insertAdjacentHTML('beforeend', commentHtml(c));
          }
        }
        $('commentText').value = '';
        setReplyTo(null);
        if (msg) msg.textContent = t('comments.posted');
        gaEvent('comment_post', { slug: slug });
      })
      .catch(function () { if (msg) msg.textContent = t('comments.failed'); });
  }

  function handleCommentAction(btn) {
    var article = btn.closest ? btn.closest('article.comment') : null;
    if (!article) return;
    var id = article.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    if (act === 'reply') {
      var nameEl = article.querySelector('.c-head strong');
      setReplyTo(article.getAttribute('data-thread'), nameEl ? nameEl.textContent : '');
      $('commentText').focus();
      return;
    }
    if (act === 'delete') {
      if (!window.confirm(t('comments.deleteConfirm'))) return;
      fetch('/api/comments/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function () { article.remove(); })
        .catch(function () { var msg = $('commentMsg'); if (msg) msg.textContent = t('comments.deleteFailed'); });
      return;
    }
    if (act === 'edit') {
      startEditComment(article, id);
      return;
    }
  }

  function startEditComment(article, id) {
    var textEl = article.querySelector('.c-text');
    if (!textEl || article.querySelector('.c-edit')) return;
    var current = textEl.textContent;
    var wrap = document.createElement('div');
    wrap.className = 'c-edit';
    wrap.innerHTML = '<textarea rows="3" maxlength="1000"></textarea> <button type="button" data-edit="save">' + t('comments.editSave') + '</button> <button type="button" data-edit="cancel">' + t('comments.editCancel') + '</button>';
    var area = wrap.querySelector('textarea');
    area.value = current;
    textEl.hidden = true;
    article.insertBefore(wrap, textEl.nextSibling);
    area.focus();
    wrap.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-edit]') : null;
      if (!b) return;
      if (b.getAttribute('data-edit') === 'cancel') { wrap.remove(); textEl.hidden = false; return; }
      var next = area.value.trim();
      if (!next) return;
      fetch('/api/comments/' + encodeURIComponent(id), {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: next })
      })
        .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
        .then(function (res) {
          if (res.status !== 200 || !res.d.comment) {
            var msg = $('commentMsg');
            if (msg) msg.textContent = t('comments.editFailed');
            return;
          }
          textEl.textContent = res.d.comment.content;
          wrap.remove();
          textEl.hidden = false;
        })
        .catch(function () {
          var msg = $('commentMsg');
          if (msg) msg.textContent = t('comments.editFailed');
        });
    });
  }

  /* ---------- bookmarks ---------- */

  function renderBookmarkBtn(bookmarked) {
    var btn = $('bookmarkBtn');
    if (btn) {
      btn.innerHTML = '<i class="fi fi-br-bookmark"></i> ' + (bookmarked ? t('reader.bookmarked') : t('reader.bookmark'));
      btn.setAttribute('aria-pressed', String(bookmarked));
      btn.setAttribute('data-bookmarked', String(bookmarked));
    }
    // The mobile bottom bar's Save button mirrors the same state.
    var m = $('mobileSaveBtn');
    if (m) {
      m.innerHTML = '<i class="fi fi-br-bookmark"></i> ' + (bookmarked ? t('reader.saved') : t('reader.save'));
      m.setAttribute('aria-pressed', String(bookmarked));
      m.setAttribute('data-bookmarked', String(bookmarked));
    }
  }

  function loadBookmarkState(slug) {
    renderBookmarkBtn(Boolean(lsGet(LS_BOOKMARKED_KEY)[slug]));
    if (!state.session) return;
    fetch('/api/me/bookmarks?stickerId=' + encodeURIComponent(slug), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { renderBookmarkBtn(Boolean(d.bookmarked)); })
      .catch(function () { renderBookmarkBtn(false); });
  }

  function toggleBookmark() {
    var slug = state.currentSlug;
    if (!slug) return;
    if (!state.session) { location.hash = '#/login'; return; }
    var btn = $('bookmarkBtn');
    var bookmarked = btn && btn.getAttribute('data-bookmarked') === 'true';
    var method = bookmarked ? 'DELETE' : 'POST';
    var url = bookmarked
      ? '/api/me/bookmarks?stickerId=' + encodeURIComponent(slug)
      : '/api/me/bookmarks';
    var options = { method: method, credentials: 'same-origin', cache: 'no-store' };
    if (!bookmarked) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify({ stickerId: slug });
    }
    // Optimistic: show the new state right away; the server confirms below.
    var map = lsGet(LS_BOOKMARKED_KEY);
    if (!bookmarked) map[slug] = true; else delete map[slug];
    lsSet(LS_BOOKMARKED_KEY, map);
    renderBookmarkBtn(!bookmarked);
    lsSet(LS_BOOKMARKS_KEY, {}); // the saved list changed — drop its cache
    updateSavedBadges();
    fetch(url, options)
      .then(function (r) {
        if (r.status === 401) { location.hash = '#/login'; throw new Error('signed out'); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function () {
        renderBookmarkBtn(!bookmarked);
        gaEvent('bookmark', { slug: slug, bookmarked: !bookmarked });
        prefetchBookmarks(); // the cache was dropped — re-cache the
        // post-toggle list so the map and badges converge on the truth
      })
      .catch(function (e) {
        // Undo the optimistic update, then report the failure.
        var m = lsGet(LS_BOOKMARKED_KEY);
        if (bookmarked) m[slug] = true; else delete m[slug];
        lsSet(LS_BOOKMARKED_KEY, m);
        renderBookmarkBtn(bookmarked);
        updateSavedBadges();
        if (e.message === 'signed out') return;
        var msg = $('shareMsg');
        if (msg) { msg.textContent = t('saved.bookmarkFailed'); setTimeout(function () { msg.textContent = ''; }, 2500); }
      });
  }

  // Warm the bookmarks endpoint + cache in the background, so opening
  // Bookmarks later renders instantly instead of waiting on a cold function.
  function prefetchBookmarks() {
    var cached = lsGet(LS_BOOKMARKS_KEY);
    if (cached && cached.sort === 'recent' && Date.now() - (cached.savedAt || 0) < 5 * 60 * 1000) return;
    fetch('/api/me/bookmarks?sort=recent', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        lsSet(LS_BOOKMARKS_KEY, { sort: 'recent', savedAt: Date.now(), bookmarks: d.bookmarks || [] });
        syncBookmarkedMap(d.bookmarks || []);
        updateSavedBadges();
      })
      .catch(function () { /* best effort only */ });
  }

  /* Keep the per-set map in step with the server list. The map is the
   * button state (is THIS slug saved) and the badge fallback when the
   * list cache was just dropped by a toggle — but on a fresh device it
   * starts empty, so after one toggle the badges would collapse to
   * only what was toggled here. Rebuilding it from every fresh list
   * keeps the map, the tabs and the badges on the same truth; the
   * toggles' own optimistic updates still land first, and the toggle
   * success handler refreshes the list below, so a list fetched
   * mid-toggle heals on the next refresh. */
  function syncBookmarkedMap(items) {
    var map = {};
    (items || []).forEach(function (b) { if (b && b.sticker && b.sticker.slug) map[b.sticker.slug] = true; });
    lsSet(LS_BOOKMARKED_KEY, map);
  }

  /* Nav count badges for the two saved shelves — the same treatment
   * as the cart badge. Bookmarks = whole sets, Collections =
   * individual stickers: the same split the two tabs use (a sticker
   * id ends in -NN, a set slug never does). Counts come from the
   * cached server list when it is there, else from the per-set map
   * the toggles keep — either way the badge follows the newest local
   * truth. The map is rebuilt from every fresh list (see
   * syncBookmarkedMap), so the fallback is only ever used right after
   * a toggle dropped the cache, never on a stale empty map.
   * Signed-out visitors see no badges at all: the shelves are
   * signed-in-only, so a stale cached count must never show. */
  function savedCounts() {
    var cached = lsGet(LS_BOOKMARKS_KEY);
    var list = cached && cached.bookmarks;
    if (list) {
      return {
        sets: list.filter(function (b) { return !isStickerBookmark(b); }).length,
        stickers: list.filter(isStickerBookmark).length,
      };
    }
    var map = lsGet(LS_BOOKMARKED_KEY);
    var sets = 0, stickers = 0;
    Object.keys(map).forEach(function (k) {
      if (/-\d{2}$/.test(k)) stickers++; else sets++;
    });
    return { sets: sets, stickers: stickers };
  }

  function updateSavedBadges() {
    var b = $('bookmarksCount'), c = $('collectionsCount');
    if (!b || !c) return;
    if (!state.session) { b.hidden = true; c.hidden = true; return; }
    var n = savedCounts();
    b.textContent = String(n.sets);
    b.hidden = n.sets === 0;
    c.textContent = String(n.stickers);
    c.hidden = n.stickers === 0;
  }

  function bookmarkCardHtml(b) {
    var slug = b.sticker.slug;
    // An individual sticker id is "<set-slug>-NN"; set slugs never end
    // in -NN, so the suffix tells the two apart.
    var m = slug.match(/^(.*)-(\d{2})$/);
    if (m) {
      var set = findSet(m[1]);
      return '<a class="card" href="#/set/' + m[1] + '/sticker/' + m[2] + '">' +
        '<img src="' + esc(b.sticker.imageUrl) + '" alt="' + esc(b.sticker.title) + '" loading="lazy" decoding="async" style="aspect-ratio:1600/1680">' +
        '<div class="card-body"><h2>' + esc(b.sticker.title) + '</h2>' +
        '<p class="card-meta">' + esc(set ? set.title : m[1]) + '</p></div></a>';
    }
    var set2 = findSet(slug);
    return set2 ? cardHtml(set2) : '';
  }

  function isStickerBookmark(b) {
    // Individual sticker ids are "<set-slug>-NN"; set slugs never end
    // in -NN, so the suffix tells the two apart.
    return /-\d{2}$/.test(b.sticker.slug);
  }

  function renderBookmarksList(items) {
    var body = $('bookmarksBody');
    if (!body) return;
    var labels = { recent: t('saved.sortRecent'), oldest: t('saved.sortOldest'), title: t('saved.sortTitle') };
    var sortHtml = '<div class="sort-row" role="group" aria-label="' + t('saved.sortBookmarksAria') + '">' +
      Object.keys(labels).map(function (s) {
        return '<button type="button" data-sort="' + s + '"' +
          (state.bookmarksSort === s ? ' class="active"' : '') + '>' + labels[s] + '</button>';
      }).join('') + '</div>';
    // Bookmarks = whole sets only; collected stickers live in Collections.
    var cards = (items || []).filter(function (b) { return !isStickerBookmark(b); }).map(bookmarkCardHtml).join('');
    body.innerHTML = sortHtml +
      (cards
        ? '<p class="clear-row"><button type="button" class="text-btn" data-clear-saved="bookmarks">' + t('saved.clearBookmarks') + '</button></p><div class="grid">' + cards + '</div>'
        : '<div class="empty-saved">' +
        '<svg class="empty-art" viewBox="0 0 220 180" role="img" aria-label="' + t('saved.emptyBookmarksArtAria') + '">' +
        '<path d="M46,44 L48.5,49.5 L54,52 L48.5,54.5 L46,60 L43.5,54.5 L38,52 L43.5,49.5 Z" fill="#f5c542"/>' +
        '<path d="M178,38 L180,43 L185,45 L180,47 L178,52 L176,47 L171,45 L176,43 Z" fill="#f5c542"/>' +
        '<ellipse cx="88" cy="16" rx="10" ry="22" fill="#fff" stroke="#2b2620" stroke-width="4" transform="rotate(-14 88 16)"/>' +
        '<ellipse cx="88" cy="18" rx="4.5" ry="15" fill="#f7b8c4" transform="rotate(-14 88 18)"/>' +
        '<ellipse cx="132" cy="20" rx="10" ry="20" fill="#fff" stroke="#2b2620" stroke-width="4" transform="rotate(22 132 20)"/>' +
        '<ellipse cx="132" cy="22" rx="4.5" ry="14" fill="#f7b8c4" transform="rotate(22 132 22)"/>' +
        '<path d="M72,22 L148,22 L148,152 L110,128 L72,152 Z" fill="#b3402a" stroke="#2b2620" stroke-width="4" stroke-linejoin="round"/>' +
        '<circle cx="98" cy="72" r="9" fill="#fff" stroke="#2b2620" stroke-width="3"/>' +
        '<circle cx="122" cy="72" r="9" fill="#fff" stroke="#2b2620" stroke-width="3"/>' +
        '<line x1="107" y1="72" x2="113" y2="72" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M93,74 Q98,67 103,74" fill="none" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M117,74 Q122,67 127,74" fill="none" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<ellipse cx="91" cy="84" rx="4" ry="2.5" fill="#f7b8c4"/>' +
        '<ellipse cx="129" cy="84" rx="4" ry="2.5" fill="#f7b8c4"/>' +
        '<path d="M106,90 Q110,93 114,90" fill="none" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M110,106 L112.5,111.5 L118,114 L112.5,116.5 L110,122 L107.5,116.5 L102,114 L107.5,111.5 Z" fill="#f5c542"/>' +
        '</svg>' +
        '<p class="empty-title">' + t('saved.emptyBookmarksTitle') + '</p>' +
        '<p class="empty-text">' + t('saved.emptyBookmarksText') + '</p>' +
        '<p class="empty-hint">' + t('saved.emptyBookmarksHint') + '</p>' +
        '<a class="btn" href="#/">' + t('saved.browseSets') + '</a>' +
        '</div>');
  }

  function renderCollectionsList(items) {
    var body = $('collectionsBody');
    if (!body) return;
    var labels = { recent: t('saved.sortRecent'), oldest: t('saved.sortOldest'), title: t('saved.sortTitle') };
    var sortHtml = '<div class="sort-row" role="group" aria-label="' + t('saved.sortCollectionAria') + '">' +
      Object.keys(labels).map(function (s) {
        return '<button type="button" data-sort="' + s + '"' +
          (state.bookmarksSort === s ? ' class="active"' : '') + '>' + labels[s] + '</button>';
      }).join('') + '</div>';
    var cards = (items || []).filter(isStickerBookmark).map(bookmarkCardHtml).join('');
    body.innerHTML = sortHtml +
      (cards
        ? '<p class="clear-row"><button type="button" class="text-btn" data-clear-saved="collections">' + t('saved.clearCollections') + '</button></p><div class="grid">' + cards + '</div>'
        : '<div class="empty-saved">' +
        '<svg class="empty-art" viewBox="0 0 220 180" role="img" aria-label="' + t('saved.emptyCollectionsArtAria') + '">' +
        '<path d="M40,50 L42.5,55.5 L48,58 L42.5,60.5 L40,66 L37.5,60.5 L32,58 L37.5,55.5 Z" fill="#f5c542"/>' +
        '<path d="M186,44 L188,49 L193,51 L188,53 L186,58 L184,53 L179,51 L184,49 Z" fill="#f5c542"/>' +
        '<rect x="48" y="42" width="124" height="88" rx="8" fill="#f5c542" stroke="#2b2620" stroke-width="4"/>' +
        '<ellipse cx="88" cy="34" rx="10" ry="22" fill="#fff" stroke="#2b2620" stroke-width="4" transform="rotate(-14 88 34)"/>' +
        '<ellipse cx="88" cy="36" rx="4.5" ry="15" fill="#f7b8c4" transform="rotate(-14 88 36)"/>' +
        '<ellipse cx="132" cy="40" rx="10" ry="20" fill="#fff" stroke="#2b2620" stroke-width="4" transform="rotate(22 132 40)"/>' +
        '<ellipse cx="132" cy="42" rx="4.5" ry="14" fill="#f7b8c4" transform="rotate(22 132 42)"/>' +
        '<circle cx="110" cy="50" r="28" fill="#fff" stroke="#2b2620" stroke-width="4"/>' +
        '<circle cx="98" cy="52" r="8" fill="#fff" stroke="#2b2620" stroke-width="3"/>' +
        '<circle cx="122" cy="52" r="8" fill="#fff" stroke="#2b2620" stroke-width="3"/>' +
        '<line x1="106" y1="52" x2="114" y2="52" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M93,54 Q98,47 103,54" fill="none" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M117,54 Q122,47 127,54" fill="none" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<ellipse cx="91" cy="60" rx="4" ry="2.5" fill="#f7b8c4"/>' +
        '<ellipse cx="129" cy="60" rx="4" ry="2.5" fill="#f7b8c4"/>' +
        '<path d="M106,64 Q110,67 114,64" fill="none" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<g transform="translate(152,64) rotate(-14)">' +
        '<rect x="-13" y="-14" width="26" height="28" rx="4" fill="#fff" stroke="#2b2620" stroke-width="3"/>' +
        '<path d="M0,-8 L2,-2 L8,0 L2,2 L0,8 L-2,2 L-8,0 L-2,-2 Z" fill="#f5c542"/>' +
        '</g>' +
        '<path d="M48,72 L172,72 L166,140 Q166,144 162,144 L58,144 Q54,144 54,140 Z" fill="#eab543" stroke="#2b2620" stroke-width="4" stroke-linejoin="round"/>' +
        '</svg>' +
        '<p class="empty-title">' + t('saved.emptyCollectionsTitle') + '</p>' +
        '<p class="empty-text">' + t('saved.emptyCollectionsText') + '</p>' +
        '<p class="empty-hint">' + t('saved.emptyCollectionsHint') + '</p>' +
        '<a class="btn" href="#/">' + t('saved.browseStickers') + '</a>' +
        '</div>');
  }

  function renderBookmarks() {
    var body = $('bookmarksBody');
    if (!body) return;
    if (!state.session) {
      body.innerHTML = '<p>' + t('saved.signInBookmarks') + '</p><p><a class="btn" href="#/login">' + t('nav.signIn') + '</a></p>';
      return;
    }
    if (state.authAvailable === false) {
      body.innerHTML = '<p>' + t('saved.notSetupBookmarks') + '</p>';
      return;
    }
    // Cache-first: show the last list instantly, refresh in the background.
    var cached = lsGet(LS_BOOKMARKS_KEY);
    var shownFromCache = false;
    if (cached && cached.sort === state.bookmarksSort && cached.bookmarks) {
      renderBookmarksList(cached.bookmarks);
      updateSavedBadges();
      shownFromCache = true;
    } else {
      body.innerHTML = '<p>' + t('common.loading') + '</p>';
    }
    fetch('/api/me/bookmarks?sort=' + encodeURIComponent(state.bookmarksSort), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var items = d.bookmarks || [];
        lsSet(LS_BOOKMARKS_KEY, { sort: state.bookmarksSort, savedAt: Date.now(), bookmarks: items });
        syncBookmarkedMap(items);
        renderBookmarksList(items);
        updateSavedBadges();
      })
      .catch(function () {
        if (!shownFromCache) {
          body.innerHTML = '<p>' + t('saved.loadFailedBookmarks') + '</p>';
        }
      });
  }

  function renderCollections() {
    var body = $('collectionsBody');
    if (!body) return;
    if (!state.session) {
      body.innerHTML = '<p>' + t('saved.signInCollections') + '</p><p><a class="btn" href="#/login">' + t('nav.signIn') + '</a></p>';
      return;
    }
    if (state.authAvailable === false) {
      body.innerHTML = '<p>' + t('saved.notSetupCollections') + '</p>';
      return;
    }
    // Same cache as Bookmarks (one list, two views); refresh in the
    // background.
    var cached = lsGet(LS_BOOKMARKS_KEY);
    var shownFromCache = false;
    if (cached && cached.sort === state.bookmarksSort && cached.bookmarks) {
      renderCollectionsList(cached.bookmarks);
      updateSavedBadges();
      shownFromCache = true;
    } else {
      body.innerHTML = '<p>' + t('common.loading') + '</p>';
    }
    fetch('/api/me/bookmarks?sort=' + encodeURIComponent(state.bookmarksSort), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var items = d.bookmarks || [];
        lsSet(LS_BOOKMARKS_KEY, { sort: state.bookmarksSort, savedAt: Date.now(), bookmarks: items });
        syncBookmarkedMap(items);
        renderCollectionsList(items);
        updateSavedBadges();
      })
      .catch(function () {
        if (!shownFromCache) {
          body.innerHTML = '<p>' + t('saved.loadFailedCollections') + '</p>';
        }
      });
  }

  /* Clear a whole shelf at once — one bulk DELETE, then drop the
   * caches and re-render from the server, so the tab shows the
   * true state. The per-set map keeps only the other shelf's
   * entries (sets vs -NN sticker ids). */
  function clearSaved(scope) {
    var body = scope === 'sets' ? $('bookmarksBody') : $('collectionsBody');
    fetch('/api/me/bookmarks?scope=' + scope, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function () {
        var map = lsGet(LS_BOOKMARKED_KEY);
        Object.keys(map).forEach(function (k) {
          if (scope === 'sets' ? !/-\d{2}$/.test(k) : /-\d{2}$/.test(k)) delete map[k];
        });
        lsSet(LS_BOOKMARKED_KEY, map);
        lsSet(LS_BOOKMARKS_KEY, {}); // the saved list changed — drop its cache
        updateSavedBadges();
        if (scope === 'sets') renderBookmarks(); else renderCollections();
      })
      .catch(function () {
        if (body) body.insertAdjacentHTML('afterbegin', '<p class="comment-msg">' + t('saved.clearFailed') + '</p>');
      });
  }

  /* ---------- personal gallery ---------- */

  function renderGallery() {
    var body = $('galleryBody');
    if (!body) return;
    if (!state.session) {
      body.innerHTML = '<p>' + t('gallery.signInFirst') + '</p><p><a class="btn" href="#/login">' + t('nav.signIn') + '</a></p>';
      return;
    }
    if (state.authAvailable === false) {
      body.innerHTML = '<p>' + t('gallery.notSetup') + '</p>';
      return;
    }
    body.innerHTML = '<p>' + t('common.loading') + '</p>';
    fetch('/api/me/photos', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { renderGalleryList(d.photos || []); })
      .catch(function () {
        body.innerHTML = '<p>' + t('gallery.loadFailed') + '</p>';
      });
  }

  function renderGalleryList(photos) {
    var body = $('galleryBody');
    if (!body) return;
    var enabled = uploadsEnabled();
    var uploadBtn = enabled
      ? '<label class="btn" for="photoFile">' + t('gallery.upload') + '</label><input id="photoFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>'
      : '<p class="meta">' + t('gallery.uploadsOff') + '</p>';
    var uploadFirstBtn = enabled
      ? '<label class="btn" for="photoFile">' + t('gallery.uploadFirst') + '</label><input id="photoFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>'
      : '<p class="meta">' + t('gallery.uploadsOff') + '</p>';
    var msgHtml = '<p id="photoMsg" class="comment-msg" aria-live="polite"></p>';
    if (!photos.length) {
      body.innerHTML = msgHtml + '<div class="empty-saved">' +
        '<svg class="empty-art" viewBox="0 0 220 180" role="img" aria-label="' + t('gallery.emptyArtAria') + '">' +
        '<path d="M36,44 L38.5,49.5 L44,52 L38.5,54.5 L36,60 L33.5,54.5 L28,52 L33.5,49.5 Z" fill="#f5c542"/>' +
        '<path d="M186,102 L188,107 L193,109 L188,111 L186,116 L184,111 L179,109 L184,107 Z" fill="#f5c542"/>' +
        '<ellipse cx="92" cy="28" rx="8" ry="20" fill="#fff" stroke="#2b2620" stroke-width="4" transform="rotate(-14 92 28)"/>' +
        '<ellipse cx="92" cy="30" rx="3.5" ry="12" fill="#f7b8c4" transform="rotate(-14 92 30)"/>' +
        '<ellipse cx="128" cy="32" rx="8" ry="18" fill="#fff" stroke="#2b2620" stroke-width="4" transform="rotate(20 128 32)"/>' +
        '<ellipse cx="128" cy="34" rx="3.5" ry="11" fill="#f7b8c4" transform="rotate(20 128 34)"/>' +
        '<rect x="45" y="30" width="130" height="110" rx="10" fill="#fff" stroke="#2b2620" stroke-width="4"/>' +
        '<rect x="57" y="42" width="106" height="86" rx="4" fill="#f6e8e4"/>' +
        '<circle cx="110" cy="88" r="24" fill="#fff" stroke="#2b2620" stroke-width="4"/>' +
        '<circle cx="100" cy="86" r="7" fill="#fff" stroke="#2b2620" stroke-width="3"/>' +
        '<circle cx="120" cy="86" r="7" fill="#fff" stroke="#2b2620" stroke-width="3"/>' +
        '<line x1="107" y1="86" x2="113" y2="86" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M95,88 Q100,81 105,88" fill="none" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M115,88 Q120,81 125,88" fill="none" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<ellipse cx="94" cy="94" rx="3.5" ry="2" fill="#f7b8c4"/>' +
        '<ellipse cx="126" cy="94" rx="3.5" ry="2" fill="#f7b8c4"/>' +
        '<path d="M106,98 Q110,101 114,98" fill="none" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M166,32 L168,38 L174,40 L168,42 L166,48 L164,42 L158,40 L164,38 Z" fill="#f5c542"/>' +
        '</svg>' +
        '<p class="empty-title">' + t('gallery.emptyTitle') + '</p>' +
        '<p class="empty-text">' + t('gallery.emptyText') + '</p>' +
        '<p class="empty-hint">' + t('gallery.emptyHint') + '</p>' +
        uploadFirstBtn +
        '</div>';
      return;
    }
    body.innerHTML = '<div class="upload-row">' + uploadBtn +
      '<button type="button" class="text-btn" data-clear-photos">' + t('gallery.clearAll') + '</button></div>' + msgHtml +
      '<div class="gallery-grid">' + photos.map(function (p) {
        return '<figure class="photo-card">' +
          '<button type="button" class="photo-view" data-photo-view="' + esc(p.url) + '" data-photo-title="' + esc(p.filename) + '" aria-label="' + esc(t('gallery.viewPhoto').replace('{name}', p.filename)) + '"><img src="' + esc(p.url) + '" alt="' + esc(p.filename) + '" loading="lazy" decoding="async"></button>' +
          '<button type="button" class="photo-del" data-photo-del="' + esc(p.id) + '" aria-label="' + esc(t('gallery.deletePhoto').replace('{name}', p.filename)) + '">×</button>' +
          '<figcaption>' + esc(p.filename) + '</figcaption></figure>';
      }).join('') + '</div>';
  }

  function uploadPhoto(file) {
    var msg = $('photoMsg');
    if (!file) return;
    if (file.type !== 'image/jpeg' && file.type !== 'image/png' && file.type !== 'image/webp' && file.type !== 'image/gif') {
      if (msg) msg.textContent = t('gallery.notPhoto');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      if (msg) msg.textContent = t('gallery.tooLarge');
      return;
    }
    if (msg) msg.textContent = t('gallery.uploading');
    fetch('/api/me/photos', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': file.type, 'X-Filename': file.name },
      body: file
    })
      .then(function (r) {
        if (r.status === 401) { location.hash = '#/login'; throw new Error('signed out'); }
        if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || 'HTTP ' + r.status); });
        return r.json();
      })
      .then(function () {
        gaEvent('photo_uploaded');
        renderGallery();
      })
      .catch(function (e) {
        if (e.message === 'signed out') return;
        if (msg) {
          msg.textContent = e.message === 'uploads_disabled' ? t('gallery.uploadsOff')
            : e.message === 'uploads_not_configured' ? t('gallery.uploadsNotConfigured')
            : e.message === 'photo_limit_reached' ? t('gallery.full')
            : e.message === 'photo_too_large' ? t('gallery.tooLarge')
            : t('gallery.uploadFailed');
        }
        var input = $('photoFile');
        if (input) input.value = '';
      });
  }

  function deletePhoto(id) {
    fetch('/api/me/photos?id=' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function () { renderGallery(); })
      .catch(function () {
        var msg = $('photoMsg');
        if (msg) msg.textContent = t('gallery.deleteFailed');
      });
  }

  function clearPhotos() {
    fetch('/api/me/photos?scope=all', { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function () { renderGallery(); })
      .catch(function () {
        var msg = $('photoMsg');
        if (msg) msg.textContent = t('gallery.clearFailed');
      });
  }

  function postFeedback(e) {
    e.preventDefault();
    var text = $('feedbackText').value.trim();
    var msg = $('feedbackMsg');
    if (!text) return;
    fetch('/api/engage?action=feedback', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('feedbackName').value, text: text, page: location.href })
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (res) {
        if (res.status === 200 && res.d.ok) {
          $('feedbackText').value = '';
          if (msg) msg.innerHTML = '<img class="empty-icon" src="icons/party.png" alt="" width="512" height="512">' + t('feedback.thanks');
          gaEvent('feedback', {});
        } else if (res.status === 429) {
          if (msg) msg.textContent = t('feedback.rateLimit');
        } else if (msg) {
          msg.textContent = t('feedback.setup');
        }
      })
      .catch(function () { if (msg) msg.textContent = t('feedback.failed'); });
  }

  /* ---------- data ---------- */

  function loadCached() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.data || !parsed.savedAt) return null;
      if (Date.now() - parsed.savedAt > LS_TTL_MS) return null;
      return parsed.data;
    } catch (e) { return null; }
  }

  function saveCached(data) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ savedAt: Date.now(), data: data }));
    } catch (e) { /* storage full or private mode — the site still works */ }
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'default' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      return r.json();
    });
  }

  function applyData(index, series) {
    state.sets = index.sets || [];
    state.series = (series && series.batches) || [];
    renderChips();
    renderTopics();
    route();
  }

  function init() {
    loadDicts().then(function () { applyLang(resolveLang()); });
    var cached = loadCached();
    var indexP = fetchJson('data/index.json?v=' + DATA_V);
    var seriesP = fetchJson('data/series.json');

    if (cached) {
      seriesP.then(function (series) { applyData(cached, series); })
        .catch(function () { applyData(cached, null); });
    }
    Promise.all([indexP, seriesP]).then(function (res) {
      var index = res[0], series = res[1];
      if (!cached || JSON.stringify(cached.sets) !== JSON.stringify(index.sets)) {
        saveCached(index);
        applyData(index, series);
      }
    }).catch(function (err) {
      if (!cached) {
        $('grid').innerHTML = '<p class="empty">' + t('grid.loadError') + '</p>';
        console.error(err);
      }
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* optional */ });
    }

    loadConfig();
    loadSession();
    loadCart();
    loadLinks();
    loadSettings();
  }

  /* ---------- filtering ---------- */

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return state.sets.filter(function (c) {
      if (state.batch !== 'all' && String(c.batch) !== String(state.batch)) return false;
      if (state.lang !== 'all' && c.lang !== state.lang) return false;
      if (state.topic && c.tags.indexOf(state.topic) === -1) return false;
      if (q) {
        var hay = (c.title + ' ' + c.slug + ' ' + c.angle + ' ' + c.tags.join(' ')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function seriesTitle(id) {
    var b = state.series.find(function (s) { return String(s.id) === String(id); });
    return b ? b.title : t('grid.seriesFallback').replace('{id}', id);
  }

  /* ---------- home grid ---------- */

  /* Descriptive alt text for a sticker: the title plus the scene, which
   * describes what the picture shows. A screen reader gets the picture,
   * not just its label. */
  function stickerAlt(s) {
    return s.scene ? s.title + '. ' + s.scene : s.title;
  }

  function cardHtml(c) {
    return '<a class="card" href="#/set/' + c.slug + '">' +
      '<img src="' + c.thumb + '" alt="' + esc(c.title + t('card.altSuffix')) + '" loading="lazy" decoding="async" style="aspect-ratio:' + c.ratio + '">' +
      '<div class="card-body"><h2>' + esc(c.title) + '</h2>' +
      '<p class="card-meta">' + esc(seriesTitle(c.batch)) + ' · ' + c.date + '</p></div></a>';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function renderGrid() {
    var list = filtered();
    var shown = list.slice(0, state.shown);
    $('grid').innerHTML = shown.map(cardHtml).join('');
    $('empty').hidden = list.length !== 0;
    $('count').textContent = list.length === 0 ? '' :
      (list.length === 1 ? t('grid.count.one') : t('grid.count.other').replace('{n}', list.length)) +
      (state.batch !== 'all' ? ' · ' + seriesTitle(state.batch) : '') +
      (state.topic ? ' · #' + state.topic : '');
    $('loadMore').hidden = list.length <= state.shown;
  }

  function renderChips() {
    var html = '<button data-batch="all"' + (state.batch === 'all' ? ' class="active"' : '') + '>' + t('filter.all') + '</button>';
    state.series.forEach(function (b) {
      html += '<button data-batch="' + b.id + '"' +
        (String(state.batch) === String(b.id) ? ' class="active"' : '') + '>' +
        esc(b.title) + '</button>';
    });
    $('chips').innerHTML = html;
  }

  function renderTopics() {
    var counts = {};
    state.sets.forEach(function (c) {
      c.tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    var tags = Object.keys(counts).filter(function (t) { return counts[t] >= 1; }).sort();
    var html = tags.map(function (t) {
      return '<button data-topic="' + esc(t) + '"' +
        (state.topic === t ? ' class="active"' : '') + '>#' + esc(t) + ' (' + counts[t] + ')</button>';
    }).join('');
    $('topics').innerHTML = html;
  }

  /* ---------- reader ---------- */

  function findSet(slug) {
    return state.sets.find(function (c) { return c.slug === slug; });
  }

  function stickerCellHtml(s) {
    return '<figure class="sticker-cell tappable" tabindex="0" role="button" data-n="' + esc(s.n) + '" aria-label="' + esc(s.title + t('sticker.cellAria')) + '">' +
      '<img src="' + s.file + '" alt="' + esc(stickerAlt(s)) + '" loading="lazy" decoding="async">' +
      '<span class="tap-badge"><i class="fi fi-br-cursor-finger"></i> ' + t('sticker.tapMe') + '</span>' +
      '<figcaption><span class="sticker-ja">' + esc(s.ja) + '</span>' +
      '<span class="sticker-zh">' + esc(s.zh) + '</span></figcaption></figure>';
  }

  function openSet(slug) {
    setMagnifyMode(false); // a new sheet starts with the lens off
    var c = findSet(slug);
    if (!c) {
      readerEl.innerHTML = '<p class="empty">' + t('grid.notFound') + ' <a href="#/">' + t('grid.notFoundBack') + '</a>.</p>';
      showView('reader');
      return;
    }
    // Restore the reader markup if it was replaced by the not-found message.
    if (!$('setTitle')) location.hash = '#/';
    $('setTitle').textContent = c.title;
    $('setMeta').textContent = seriesTitle(c.batch) + ' · ' + c.date + ' · QA ' + c.qa + '/10';
    $('crumbBatch').textContent = ' / ' + seriesTitle(c.batch);
    var img = $('setImg');
    img.src = c.image;
    img.alt = c.title + t('reader.setImgAltSuffix').replace('{n}', (c.stickers || []).length);
    img.setAttribute('aria-label', t('reader.setImgAriaWithTitle').replace('{title}', c.title));
    $('stickerGrid').innerHTML = (c.stickers || []).map(stickerCellHtml).join('');
    // Character sheet: collapsed by default; the reader's open/close
    // preference is remembered in localStorage (see init wiring).
    var cs = $('charSheet');
    if (c.character_sheet) {
      cs.hidden = false;
      $('charSheetImg').src = c.character_sheet;
      $('charSheetImg').alt = c.cast ? t('reader.charSheetCastPrefix') + c.cast : t('reader.charSheet');
      $('charSheetCast').textContent = c.cast || '';
    } else {
      cs.hidden = true;
    }
    $('behindAngle').textContent = c.angle || '';
    $('behindFacts').textContent = c.tags.length ? t('reader.behindTopics') + c.tags.join(', ') : '';
    $('behindQa').textContent = t('reader.behindQa').replace('{qa}', c.qa);

    var batchList = state.sets.filter(function (x) { return x.batch === c.batch; });
    var i = batchList.findIndex(function (x) { return x.slug === slug; });
    var prev = batchList[i - 1], next = batchList[i + 1];
    var prevLink = $('prevLink'), nextLink = $('nextLink');
    if (prev) { prevLink.href = '#/set/' + prev.slug; prevLink.removeAttribute('aria-disabled'); prevLink.textContent = '← ' + prev.title; }
    else { prevLink.href = '#'; prevLink.setAttribute('aria-disabled', 'true'); prevLink.textContent = t('reader.prev'); }
    if (next) { nextLink.href = '#/set/' + next.slug; nextLink.removeAttribute('aria-disabled'); nextLink.textContent = next.title + ' →'; }
    else { nextLink.href = '#'; nextLink.setAttribute('aria-disabled', 'true'); nextLink.textContent = t('reader.next'); }

    var strip = batchList.filter(function (x) { return x.slug !== slug; });
    $('seriesStrip').innerHTML = strip.map(cardHtml).join('');
    showView('reader');
    window.scrollTo(0, 0);

    state.currentSlug = slug;
    gaEvent('set_view', { slug: slug });
    loadLikes(slug);
    loadComments(slug);
    loadBookmarkState(slug);
    renderBuyButtons();
    renderCartButtons();
  }

  /* ---------- routing ---------- */

  function showView(name) {
    homeEl.hidden = name !== 'home';
    readerEl.hidden = name !== 'reader';
    aboutEl.hidden = name !== 'about';
    loginEl.hidden = name !== 'login';
    profileEl.hidden = name !== 'profile';
    bookmarksEl.hidden = name !== 'bookmarks';
    collectionsEl.hidden = name !== 'collections';
    galleryEl.hidden = name !== 'gallery';
    downloadEl.hidden = name !== 'download';
    adminEl.hidden = name !== 'admin';
    // Active nav state: the reader lives under Latest. The cart is a
    // drawer, not a page, so it never takes the active state.
    var nav = { home: 'home', reader: 'home', bookmarks: 'bookmarks', collections: 'collections', gallery: 'gallery', about: 'about' }[name] || null;
    document.querySelectorAll('.topnav a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === nav);
    });
    // Close the user menu on navigation.
    document.querySelectorAll('details.user-menu[open]').forEach(function (d) { d.open = false; });
  }

  function route() { routeInner(); trackPageView(); }

  function routeInner() {
    var hash = location.hash || '#/';
    // The download page carries its lookup in the hash query:
    // #/download?session_id=cs_... — split it off before routing.
    var hashParts = hash.split('?');
    var query = new URLSearchParams(hashParts[1] || '');
    var parts = hashParts[0].replace(/^#\//, '').split('/');
    if (parts[0] === 'download') { renderDownload(query); showView('download'); window.scrollTo(0, 0); return; }
    if (parts[0] === 'cart') { showView('home'); openCartDrawer(true); return; }
    if (parts[0] === 'kangle') { renderAdmin(parts.slice(1)); showView('admin'); window.scrollTo(0, 0); return; }
    if (parts[0] === 'set' && parts[1]) {
      openSet(parts[1]);
      // Deep link to one sticker: #/set/<slug>/sticker/<n> opens the set
      // with that sticker's modal already open (shared links use it).
      if (parts[2] === 'sticker' && parts[3]) openStickerModal(parts[3]);
      return;
    }
    if (parts[0] === 'about') { showView('about'); window.scrollTo(0, 0); return; }
    if (parts[0] === 'login') { renderLogin(); showView('login'); window.scrollTo(0, 0); return; }
    if (parts[0] === 'profile') { renderProfile(); showView('profile'); window.scrollTo(0, 0); return; }
    if (parts[0] === 'bookmarks') { renderBookmarks(); showView('bookmarks'); window.scrollTo(0, 0); return; }
    if (parts[0] === 'collections') { renderCollections(); showView('collections'); window.scrollTo(0, 0); return; }
    if (parts[0] === 'gallery') { renderGallery(); showView('gallery'); window.scrollTo(0, 0); return; }
    if (parts[0] === 'batch' && parts[1]) {
      state.batch = parts[1]; state.topic = null; state.shown = PAGE_SIZE;
      renderChips(); renderTopics(); renderGrid(); showView('home'); return;
    }
    if (parts[0] === 'topic' && parts[1]) {
      state.topic = decodeURIComponent(parts[1]); state.batch = 'all'; state.shown = PAGE_SIZE;
      renderChips(); renderTopics(); renderGrid(); showView('home'); return;
    }
    state.batch = 'all'; state.topic = null;
    renderChips(); renderTopics(); renderGrid(); showView('home');
  }

  /* ---------- shop ---------- */
  /* Buy buttons + the download page. Prices and Stripe Payment Link
   * URLs live in data/payment-links.json (generated by
   * scripts/create_stripe_links.py); the buttons stay hidden until
   * that file loads, so a tap can never open a dead link. Checkout
   * itself is Stripe-hosted — this page never sees card details. */

  function priceLabel(cents) {
    return 'S$' + (cents / 100);
  }

  function loadLinks() {
    fetchJson('data/payment-links.json?v=' + LINKS_V).then(function (d) {
      state.links = d;
      renderPackCard();
      renderBuyButtons();
      renderCartButtons();
      if (state.currentSticker) renderStickerBuyBtn();
    }).catch(function () {
      /* Shop links unavailable — the Buy buttons stay hidden and
       * the rest of the site still works. */
    });
  }

  /* Site settings (GET /api/settings, admin-controlled): shop closed
   * hides every Buy button; hiddenItems hides one item's button.
   * When the endpoint is down the shop stays open — the settings are
   * an admin control, not a dependency of the storefront. */
  function loadSettings() {
    fetch('/api/settings', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        state.siteSettings = d;
        var ann = $('announcement');
        if (ann) {
          if (d.announcement) { ann.textContent = d.announcement; ann.hidden = false; }
          else ann.hidden = true;
        }
        renderPackCard();
        renderBuyButtons();
        renderCartButtons();
        if ((location.hash || '') === '#/gallery') renderGallery();
        if (state.currentSticker) renderStickerBuyBtn();
      })
      .catch(function () { /* settings unavailable — the shop stays open */ });
  }

  function shopClosed() { return !!(state.siteSettings && state.siteSettings.shopClosed); }
  function uploadsEnabled() { return !!(state.siteSettings && state.siteSettings.uploadsEnabled); }
  /* The direct-purchase Buy buttons are hidden by default: the
   * setting is only false once the admin unchecks the toggle, so
   * an absent key — and settings that have not loaded yet — both
   * mean hidden. The cart checkout is the purchase path meanwhile. */
  function buyButtonsHidden() { return !(state.siteSettings && state.siteSettings.hideBuyButtons === false); }
  function itemHidden(itemId) {
    return !!(state.siteSettings && state.siteSettings.hiddenItems && state.siteSettings.hiddenItems.indexOf(itemId) !== -1);
  }

  function buyUrl(type, itemId) {
    var links = state.links;
    if (!links) return null;
    var entry = null;
    if (type === 'single') entry = links.singles[itemId];
    else if (type === 'set') entry = links.sets[itemId];
    else if (type === 'pack') entry = links.pack;
    return entry ? entry.url : null;
  }

  function openBuyLink(type, itemId) {
    var url = buyUrl(type, itemId);
    if (!url) return;
    if (shopClosed() || itemHidden(itemId) || buyButtonsHidden()) return;
    gaEvent('buy_click', { type: type, item: itemId });
    location.href = url;
  }

  function renderBuyButtons() {
    var btn = $('buySetBtn');
    if (!btn) return;
    var entry = state.links && state.currentSlug ? state.links.sets[state.currentSlug] : null;
    if (!entry || shopClosed() || itemHidden(state.currentSlug) || buyButtonsHidden()) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.innerHTML = '<i class="fi fi-br-credit-card"></i> ' + t('reader.buySet').replace('{amount}', priceLabel(entry.amount));
  }

  function renderStickerBuyBtn() {
    var btn = $('stickerBuyBtn');
    var s = state.currentSticker;
    if (!btn || !s) return;
    var entry = state.links ? state.links.singles[s.id] : null;
    if (!entry || shopClosed() || itemHidden(s.id) || buyButtonsHidden()) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.innerHTML = '<i class="fi fi-br-credit-card"></i> ' + t('sticker.buy').replace('{amount}', priceLabel(entry.amount));
  }

  /* The pack is the first 30 stickers in inventory order; describe it
   * from the data, not from a hardcoded list, so a different pack
   * composition shows up correctly. */
  var PACK_SET_NAMES = {
    'riemann-rashomon': 'Riemann', 'kakeya-wang-hong': 'Kakeya',
    'deng-yu-hilbert-sixth': 'Deng Yu', 'lauren-tan-20-agents': 'Lauren Tan',
    'ai-agent-four-faces': 'AI Agent'
  };

  function renderPackCard() {
    var card = $('packCard');
    if (!card || !state.links || !state.links.pack) return;
    if (shopClosed() || itemHidden('complete-pack-30')) { card.hidden = true; return; }
    var pack = state.links.pack;
    var counts = {};
    pack.stickers.forEach(function (id) {
      var entry = state.links.singles[id];
      var slug = entry ? entry.set_slug : null;
      if (slug) counts[slug] = (counts[slug] || 0) + 1;
    });
    var parts = Object.keys(counts).map(function (slug) {
      return t('pack.textPart').replace('{n}', counts[slug]).replace('{name}', PACK_SET_NAMES[slug] || slug);
    });
    $('packCardText').textContent = t('pack.text').replace('{n}', pack.stickers.length).replace('{parts}', parts.join(' · '));
    var btn = $('packBuyBtn');
    btn.innerHTML = '<i class="fi fi-br-credit-card"></i> ' + t('pack.buyAmount').replace('{amount}', priceLabel(pack.amount));
    btn.hidden = buyButtonsHidden();
    card.hidden = false;
  }

  /* ---------- cart ---------- */
  /* A cart holds one of each item (digital files — no quantities).
   * It auto-saves to localStorage on every change, so it survives
   * closing the page on the same device; named drafts are explicit
   * snapshots the buyer can restore or delete. Checkout creates one
   * Stripe Checkout Session for the whole cart (CART.md) — that step
   * needs STRIPE_SECRET_KEY on the server, and without it the page
   * says so instead of failing silently. */
  var CART_KEY = 'sutekka-cart-v1';
  var CART_DRAFTS_KEY = 'sutekka-cart-drafts-v1';
  var CART_SYNCED_KEY = 'sutekka-cart-synced-v1';

  /* Quantities are clamped 1–99; older saved carts and drafts
   * predate them and have no qty field, so they read as 1. */
  function clampQty(q) {
    q = parseInt(q, 10);
    if (!q || Number.isNaN(q)) return 1;
    return Math.max(1, Math.min(99, q));
  }

  function normaliseCartItems(items) {
    return items.filter(function (it) {
      return it && typeof it.itemId === 'string' && (it.type === 'single' || it.type === 'set' || it.type === 'pack');
    }).map(function (it) {
      return { itemId: it.itemId, type: it.type, qty: clampQty(it.qty) };
    });
  }

  function loadCart() {
    try {
      var raw = localStorage.getItem(CART_KEY);
      var items = raw ? JSON.parse(raw) : [];
      state.cart = Array.isArray(items) ? normaliseCartItems(items) : [];
    } catch (e) { state.cart = []; }
    try {
      var syncRaw = localStorage.getItem(CART_SYNCED_KEY);
      var synced = syncRaw ? JSON.parse(syncRaw) : [];
      state.lastSyncedCart = Array.isArray(synced) ? normaliseCartItems(synced) : [];
    } catch (e) { state.lastSyncedCart = []; }
    try {
      var draw = localStorage.getItem(CART_DRAFTS_KEY);
      var drafts = draw ? JSON.parse(draw) : [];
      state.cartDrafts = Array.isArray(drafts) ? drafts.map(function (d) {
        return { name: d.name || 'Untitled draft', items: Array.isArray(d.items) ? normaliseCartItems(d.items) : [], createdAt: d.createdAt || new Date().toISOString() };
      }) : [];
    } catch (e) { state.cartDrafts = []; }
    updateCartBadge();
  }

  function saveCart() {
    try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch (e) { /* private mode */ }
    updateCartBadge();
    scheduleCartSync();
  }

  /* ---------- server-synced cart (CART_SYNC.md) ---------- */
  /* A signed-in user's cart follows their account: on sign-in the
   * server cart merges with this device's local cart, and every
   * later change PUTs the full cart, debounced ~500 ms so stepper
   * taps don't fire one PUT each. The local cart is the fallback:
   * a failed fetch/PUT (or a 401 — session expired) never wipes
   * it, and the merge is retried on the next page load.
   * Signed-out users keep the local-only behaviour; sign-out
   * leaves the local cart as is.
   *
   * Idempotence matters: after a merge + PUT the server cart
   * equals the local cart, so merging the same server cart again
   * must be a no-op — otherwise every page load would double the
   * quantities. `lastSyncedCart` is the baseline: the cart as of
   * the last sync, persisted in localStorage. A merge only adds
   * the server's delta over that baseline (server qty minus
   * synced qty, when positive), so genuinely new server-side
   * additions still sum in, but an already-synced line never
   * counts twice. */
  var cartSyncTimer = null;

  function saveLastSynced(items) {
    try { localStorage.setItem(CART_SYNCED_KEY, JSON.stringify(items)); } catch (e) { /* private mode */ }
  }

  function mergeCarts(localItems, serverItems) {
    var byKey = {};
    var order = [];
    function add(it) {
      var key = it.type + ':' + it.itemId;
      if (byKey[key]) byKey[key].qty = Math.min(99, byKey[key].qty + (it.qty || 1));
      else {
        byKey[key] = { itemId: it.itemId, type: it.type, qty: clampQty(it.qty) };
        order.push(key);
      }
    }
    (localItems || []).forEach(add);
    (serverItems || []).forEach(add);
    return order.map(function (k) { return byKey[k]; });
  }

  // Lines the server has that the last sync didn't: the genuinely
  // new server-side additions. Per key, qty = server qty minus
  // synced qty, kept only when positive.
  function diffCarts(serverItems, syncedItems) {
    var syncedQty = {};
    (syncedItems || []).forEach(function (it) { syncedQty[it.type + ':' + it.itemId] = it.qty || 0; });
    var out = [];
    (serverItems || []).forEach(function (it) {
      var extra = (it.qty || 1) - (syncedQty[it.type + ':' + it.itemId] || 0);
      if (extra > 0) out.push({ itemId: it.itemId, type: it.type, qty: extra });
    });
    return out;
  }

  function syncCartWithServer() {
    if (!state.session) return;
    fetch('/api/me/cart', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        var serverItems = Array.isArray(d && d.items) ? normaliseCartItems(d.items) : [];
        var merged = mergeCarts(state.cart, diffCarts(serverItems, state.lastSyncedCart));
        // Record the merge optimistically: the server's delta is now
        // incorporated locally, so a reload before the PUT lands
        // must not add it again. The PUT (full replace, via
        // saveCart below) converges the server to the merged cart.
        state.lastSyncedCart = merged;
        saveLastSynced(merged);
        if (JSON.stringify(merged) !== JSON.stringify(state.cart)) {
          state.cart = merged;
          saveCart();
        }
      })
      .catch(function () { /* server unreachable — local cart untouched */ });
  }

  function scheduleCartSync() {
    if (!state.session) return;
    if (cartSyncTimer) clearTimeout(cartSyncTimer);
    cartSyncTimer = setTimeout(pushCartToServer, 500);
  }

  function pushCartToServer() {
    cartSyncTimer = null;
    if (!state.session) return;
    // Capture the cart being sent: state.cart may change again
    // while the PUT is in flight, and the baseline must record
    // what the server actually received.
    var sent = state.cart.map(function (it) { return { itemId: it.itemId, type: it.type, qty: it.qty }; });
    fetch('/api/me/cart', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: sent }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        state.lastSyncedCart = sent;
        saveLastSynced(sent);
      })
      .catch(function () { /* offline — local cart is the fallback */ });
  }

  function saveDrafts() {
    try { localStorage.setItem(CART_DRAFTS_KEY, JSON.stringify(state.cartDrafts)); } catch (e) { /* private mode */ }
  }

  function updateCartBadge() {
    var badge = $('cartCount');
    if (!badge) return;
    var n = state.cart.reduce(function (s, it) { return s + (it.qty || 1); }, 0);
    badge.textContent = String(n);
    badge.hidden = n === 0;
  }

  function cartEntry(itemId, type) {
    if (!state.links) return null;
    if (type === 'single') return state.links.singles[itemId] || null;
    if (type === 'set') return state.links.sets[itemId] || null;
    if (type === 'pack') return state.links.pack || null;
    return null;
  }

  function cartItemLabel(type) {
    return type === 'single' ? t('cart.single') : type === 'set' ? t('cart.set') : t('cart.pack');
  }

  function isInCart(itemId) {
    return state.cart.some(function (it) { return it.itemId === itemId; });
  }

  function cartTotal(items) {
    var list = items || state.cart;
    return list.reduce(function (sum, it) {
      var entry = cartEntry(it.itemId, it.type);
      return sum + (entry ? entry.amount * (it.qty || 1) : 0);
    }, 0);
  }

  function findCartItem(itemId) {
    var found = null;
    state.cart.forEach(function (it) { if (it.itemId === itemId) found = it; });
    return found;
  }

  function cartQty(itemId) {
    var it = findCartItem(itemId);
    return it ? (it.qty || 1) : 0;
  }

  /* The DCHToons-style quantity stepper: 0 means "not in the cart".
   * Setting 0 removes the line. Quantities multiply the price; the
   * download is still the one PNG file per item. */
  function setQty(type, itemId, qty) {
    if (shopClosed() || itemHidden(itemId)) return;
    qty = Math.max(0, Math.min(99, qty | 0));
    var it = findCartItem(itemId);
    if (qty === 0) {
      if (it) state.cart = state.cart.filter(function (x) { return x.itemId !== itemId; });
    } else if (it) {
      it.qty = qty;
    } else {
      if (!cartEntry(itemId, type)) return;
      state.cart.push({ itemId: itemId, type: type, qty: qty });
    }
    saveCart();
    renderCartButtons();
    renderCart();
    gaEvent('cart_qty', { type: type, item: itemId, qty: qty });
  }

  function removeFromCart(itemId) {
    state.cart = state.cart.filter(function (it) { return it.itemId !== itemId; });
    saveCart();
    renderCartButtons();
    renderCart();
  }

  function clearCart() {
    state.cart = [];
    saveCart();
    renderCartButtons();
    renderCart();
  }

  /* ---------- remove confirmation: Lili the rabbit asks first ---------- */
  /* Psychology, on purpose: (1) anthropomorphism — Lili asks in the
   * first person, and disappointing a character you like is harder
   * than tapping a button; (2) loss aversion + endowment — the copy
   * says the sticker is already in your bag, so removing it feels
   * like a loss, not a non-action; (3) default bias — "Keep it" is
   * the big warm button, "remove" is small muted text; (4) one
   * extra step of friction, so a stray tap can never delete. The
   * stepper reaching 0 is NOT gated — that is N deliberate taps
   * with the count visibly falling, not an accidental delete. */
  var pendingRemoval = null; // { kind: 'line', itemId } | { kind: 'clear' } | { kind: 'bookmarks' } | { kind: 'collections' } | { kind: 'photo', photoId } | { kind: 'photos-clear' }
  function openRemoveModal(kind, itemId, title) {
    if (kind === 'clear') pendingRemoval = { kind: 'clear' };
    else if (kind === 'bookmarks' || kind === 'collections' || kind === 'photos-clear') pendingRemoval = { kind: kind };
    else if (kind === 'photo') pendingRemoval = { kind: 'photo', photoId: itemId };
    else pendingRemoval = { kind: 'line', itemId: itemId };
    if (kind === 'clear') {
      $('removeModalTitle').textContent = t('remove.clearTitle');
      $('removeModalText').innerHTML = t('remove.clearText');
      $('removeModalKeep').textContent = t('remove.clearKeep');
      $('removeModalConfirm').textContent = t('remove.clearConfirm');
    } else if (kind === 'bookmarks') {
      $('removeModalTitle').textContent = t('remove.bookmarksTitle');
      $('removeModalText').innerHTML = t('remove.bookmarksText');
      $('removeModalKeep').textContent = t('remove.bookmarksKeep');
      $('removeModalConfirm').textContent = t('remove.bookmarksConfirm');
    } else if (kind === 'collections') {
      $('removeModalTitle').textContent = t('remove.collectionsTitle');
      $('removeModalText').innerHTML = t('remove.collectionsText');
      $('removeModalKeep').textContent = t('remove.collectionsKeep');
      $('removeModalConfirm').textContent = t('remove.collectionsConfirm');
    } else if (kind === 'photo') {
      $('removeModalTitle').textContent = t('remove.photoTitle');
      $('removeModalText').innerHTML = t('remove.photoText');
      $('removeModalKeep').textContent = t('remove.photoKeep');
      $('removeModalConfirm').textContent = t('remove.photoConfirm');
    } else if (kind === 'photos-clear') {
      $('removeModalTitle').textContent = t('remove.photosTitle');
      $('removeModalText').innerHTML = t('remove.photosText');
      $('removeModalKeep').textContent = t('remove.photosKeep');
      $('removeModalConfirm').textContent = t('remove.photosConfirm');
    } else {
      $('removeModalTitle').textContent = t('remove.lineTitle');
      $('removeModalText').innerHTML = t('remove.lineText').replace('{title}', esc(title));
      $('removeModalKeep').textContent = t('remove.lineKeep');
      $('removeModalConfirm').textContent = t('remove.lineConfirm');
    }
    $('removeModal').hidden = false;
    document.body.classList.add('modal-open');
    gaEvent(kind === 'photo' ? 'photo_delete_prompt' : kind === 'photos-clear' ? 'gallery_clear_prompt' : kind === 'bookmarks' || kind === 'collections' ? 'saved_clear_prompt' : 'cart_remove_prompt');
    $('removeModalKeep').focus();
  }
  function closeRemoveModal() {
    $('removeModal').hidden = true;
    pendingRemoval = null;
    // The drawer is open underneath, so the page stays locked.
    if (!$('cartDrawer').classList.contains('open')) document.body.classList.remove('modal-open');
  }

  /* One stepper per buyable item — the count shown is the cart
   * quantity, 0 when it is not in the cart. The stepper IS the
   * add-to-cart control: at qty 0 the label beside it reads
   * "Add to cart", and + puts one in the cart; at qty >= 1 the
   * label switches to "In your bag" so the tap's result is
   * visible next to the stepper (and the navbar bag badge). */
  function setStepper(el, itemId, type, label) {
    if (!el) return;
    var entry = itemId && state.links ? cartEntry(itemId, type) : null;
    if (!entry || shopClosed() || itemHidden(itemId)) {
      el.hidden = true;
      if (label) label.hidden = true;
      return;
    }
    el.hidden = false;
    var q = cartQty(itemId);
    if (label) {
      label.hidden = false;
      label.innerHTML = '<i class="fi fi-br-shopping-bag"></i> ' + (q === 0 ? t('cart.addToCart') : t('cart.inYourBag'));
    }
    var count = el.querySelector('.qty-count');
    if (count) count.textContent = String(q);
    var dec = el.querySelector('[data-step="dec"]');
    if (dec) dec.disabled = q === 0;
    var inc = el.querySelector('[data-step="inc"]');
    if (inc) inc.disabled = q >= 99;
  }

  function renderCartButtons() {
    setStepper($('cartSetStepper'), state.currentSlug, 'set', $('setAddLabel'));
    var s = state.currentSticker;
    setStepper($('stickerCartStepper'), s ? s.id : null, 'single', $('stickerAddLabel'));
    setStepper($('packCartStepper'), 'complete-pack-30', 'pack', $('packAddLabel'));
  }

  function refundLineHtml() {
    return '<p class="meta">Refund policy: digital files can\'t be returned once downloaded. We refund duplicate charges or a corrupt file, within 7 days of purchase — write in via the feedback form on the About page. Prices include GST.</p>';
  }

  /* Pack progress: the DCHToons-style threshold nudge — the complete
   * pack is the digital equivalent of a free-delivery minimum. */
  function packProgressHtml() {
    var pack = state.links && state.links.pack;
    if (!pack) return '';
    var total = cartTotal();
    var pct = Math.min(100, Math.round(total / pack.amount * 100));
    var bar = '<div class="pack-bar"><div class="pack-bar-fill" style="width:' + pct + '%"></div></div>';
    if (isInCart(pack.item_id)) {
      return '<div class="order-card"><p><strong>' + t('cart.packInCart') + '</strong></p>' +
        '<p class="meta">' + t('cart.packInCartMeta').replace('{n}', pack.stickers.length) + '</p>' + bar + '</div>';
    }
    var singles = state.links.singles || {};
    var keys = Object.keys(singles);
    var singleAmt = keys.length ? singles[keys[0]].amount : 400;
    var saving = pack.stickers.length * singleAmt - pack.amount;
    var addBtn = '<button data-pack-add="1">' + t('cart.addPack').replace('{amount}', priceLabel(pack.amount)) + '</button>';
    if (total >= pack.amount) {
      return '<div class="order-card"><p><strong>' + t('cart.alreadyWorth').replace('{amount}', priceLabel(total)) + '</strong></p>' +
        '<p class="meta">' + t('cart.packWorthMeta').replace('{n}', pack.stickers.length).replace('{amount}', priceLabel(pack.amount)).replace('{saving}', priceLabel(saving)) + '</p>' + bar + '<p>' + addBtn + '</p></div>';
    }
    return '<div class="order-card"><p><strong>' + t('cart.packAway').replace('{amount}', priceLabel(pack.amount - total)) + '</strong></p>' +
      '<p class="meta">' + t('cart.packAwayMeta').replace('{n}', pack.stickers.length).replace('{amount}', priceLabel(pack.amount)).replace('{saving}', priceLabel(saving)) + '</p>' + bar + '<p>' + addBtn + '</p></div>';
  }

  /* Thumbnail for a cart line: the sticker itself for a single, the
   * set cover for a set, the first sticker for the pack. `full` is
   * the original-size image the lightbox shows: the full PNG for a
   * sticker, the full sheet for a set. Null while the index has not
   * loaded yet — the cart re-renders when it does (applyData calls
   * route()). */
  function cartThumb(it) {
    if (it.type === 'single') {
      var rec = findStickerRecord(it.itemId);
      if (!rec) return null;
      return { src: rec.thumb || rec.file, full: rec.file, alt: rec.title };
    }
    if (it.type === 'set') {
      var set = findSet(it.itemId);
      if (!set) return null;
      return { src: set.thumb || set.image, full: set.image, alt: set.title };
    }
    var pack = state.links && state.links.pack;
    if (pack && pack.stickers && pack.stickers.length) {
      var first = findStickerRecord(pack.stickers[0]);
      if (first) return { src: first.thumb || first.file, full: first.file, alt: pack.title };
    }
    return null;
  }

  /* ---------- cart drawer ---------- */
  /* The cart slides in from the right (DCHToons-style) instead of
   * living on its own page. The bag button opens it over whatever
   * page is showing; the #/cart route (deep links, Stripe cancel)
   * opens it over the home view. */
  var cartDrawerFromRoute = false;
  function openCartDrawer(fromRoute) {
    cartDrawerFromRoute = !!fromRoute;
    renderCart();
    $('cartDrawer').classList.add('open');
    $('cartDrawerBackdrop').classList.add('open');
    document.body.classList.add('modal-open');
    $('cartDrawerClose').focus();
  }
  function closeCartDrawer() {
    $('cartDrawer').classList.remove('open');
    $('cartDrawerBackdrop').classList.remove('open');
    document.body.classList.remove('modal-open');
    if (cartDrawerFromRoute) {
      cartDrawerFromRoute = false;
      if ((location.hash || '') === '#/cart') history.replaceState(null, '', '#/');
    }
  }

  function renderCart() {
    var body = $('cartBody');
    if (!body) return;
    var items = state.cart;
    var html = '';
    if (!items.length) {
      html += '<div class="empty-cart">' +
        '<svg class="empty-art" viewBox="0 0 220 180" role="img" aria-label="' + t('cart.emptyArtAria') + '">' +
        '<path d="M48,34 L50.5,39.5 L56,42 L50.5,44.5 L48,50 L45.5,44.5 L40,42 L45.5,39.5 Z" fill="#f5c542"/>' +
        '<path d="M176,30 L178,35 L183,37 L178,39 L176,44 L174,39 L169,37 L174,35 Z" fill="#f5c542"/>' +
        '<ellipse cx="88" cy="32" rx="10" ry="24" fill="#fff" stroke="#2b2620" stroke-width="4" transform="rotate(-14 88 32)"/>' +
        '<ellipse cx="88" cy="34" rx="4.5" ry="16" fill="#f7b8c4" transform="rotate(-14 88 34)"/>' +
        '<ellipse cx="134" cy="38" rx="10" ry="22" fill="#fff" stroke="#2b2620" stroke-width="4" transform="rotate(24 134 38)"/>' +
        '<ellipse cx="134" cy="40" rx="4.5" ry="15" fill="#f7b8c4" transform="rotate(24 134 40)"/>' +
        '<circle cx="110" cy="60" r="30" fill="#fff" stroke="#2b2620" stroke-width="4"/>' +
        '<circle cx="98" cy="56" r="8" fill="#fff" stroke="#2b2620" stroke-width="3"/>' +
        '<circle cx="122" cy="56" r="8" fill="#fff" stroke="#2b2620" stroke-width="3"/>' +
        '<line x1="106" y1="56" x2="114" y2="56" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M93,58 Q98,51 103,58" fill="none" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M117,58 Q122,51 127,58" fill="none" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<ellipse cx="91" cy="64" rx="4" ry="2.5" fill="#f7b8c4"/>' +
        '<ellipse cx="129" cy="64" rx="4" ry="2.5" fill="#f7b8c4"/>' +
        '<path d="M106,66 Q110,69 114,66" fill="none" stroke="#2b2620" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M60,70 L160,70 L154,160 Q154,164 150,164 L70,164 Q66,164 66,160 Z" fill="#f6ecd7" stroke="#2b2620" stroke-width="4" stroke-linejoin="round"/>' +
        '<line x1="63" y1="86" x2="157" y2="86" stroke="#2b2620" stroke-width="3" stroke-dasharray="6 5" opacity="0.45"/>' +
        '<g transform="translate(150,28) rotate(20)">' +
        '<rect x="-5" y="-12" width="10" height="12" rx="2" fill="#f08080" stroke="#2b2620" stroke-width="3"/>' +
        '<rect x="-5" y="0" width="10" height="52" fill="#f5c542" stroke="#2b2620" stroke-width="3"/>' +
        '<polygon points="0,64 -5,52 5,52" fill="#f6e3c5" stroke="#2b2620" stroke-width="3" stroke-linejoin="round"/>' +
        '<polygon points="0,64 -2,58 2,58" fill="#2b2620"/>' +
        '</g></svg>' +
        '<p class="empty-title">' + t('cart.emptyTitle') + '</p>' +
        '<p class="empty-text">' + t('cart.emptyText') + '</p>' +
        '<p class="empty-hint">' + t('cart.emptyHint') + '</p>' +
        '<button id="emptyCartBrowse" class="btn">' + t('cart.browse') + '</button>' +
        '</div>';
    } else {
      html += '<ul class="cart-list">' + items.map(function (it) {
        var entry = cartEntry(it.itemId, it.type);
        var title = entry ? entry.title : it.itemId;
        var qty = it.qty || 1;
        var thumb = cartThumb(it);
        var thumbHtml = thumb
          ? '<button type="button" class="cart-thumb-btn" data-cart-img="' + esc(thumb.full) + '" data-cart-img-title="' + esc(title) + '" aria-label="' + esc(t('cart.viewFull').replace('{title}', title)) + '"><img class="cart-thumb" src="' + esc(thumb.src) + '" alt="' + esc(thumb.alt) + '" loading="lazy" decoding="async"></button>'
          : '';
        return '<li>' + thumbHtml + '<div class="cart-info"><strong class="cart-title">' + esc(title) + '</strong><br><span class="meta">' + cartItemLabel(it.type) + '</span></div>' +
          '<span class="cart-price">' + (entry ? priceLabel(entry.amount * qty) : '') + '</span>' +
          '<div class="cart-line"><span class="qty-stepper"><button data-qty-dec="' + esc(it.itemId) + '" aria-label="' + t('cart.oneFewer') + '">−</button><span class="qty-count">' + qty + '</span><button data-qty-inc="' + esc(it.itemId) + '" aria-label="' + t('cart.oneMore') + '">+</button></span>' +
          '<button class="cart-remove" data-cart-remove="' + esc(it.itemId) + '">' + t('cart.remove') + '</button></div></li>';
      }).join('') + '</ul>' +
      '<p><strong>' + t('cart.subtotal').replace('{amount}', priceLabel(cartTotal())) + '</strong></p>' +
      packProgressHtml() +
      '<p class="meta">' + t('cart.onePayment') + '</p>' +
      refundLineHtml() +
      '<p><button id="checkoutBtn">' + t('cart.checkout').replace('{amount}', priceLabel(cartTotal())) + '</button> ' +
      '<button id="clearCartBtn">' + t('cart.clear') + '</button></p>' +
      '<p id="checkoutMsg" class="comment-msg" aria-live="polite"></p>' +
      '<div class="order-card"><p><strong>' + t('cart.saveDraftHeading') + '</strong></p>' +
      '<p class="meta">' + t('cart.saveDraftHelp') + '</p>' +
      '<form id="draftForm" class="comment-form" onsubmit="return false;">' +
      '<input id="draftName" type="text" placeholder="' + t('cart.draftName') + '" maxlength="60" aria-label="' + t('cart.draftName') + '">' +
      '<button type="submit">' + t('cart.saveDraft') + '</button></form></div>';
    }
    var drafts = state.cartDrafts;
    if (drafts.length) {
      html += '<h2>' + t('cart.savedDrafts') + '</h2><ul class="cart-list">' + drafts.map(function (d, i) {
        return '<li><div><strong>' + esc(d.name || t('cart.untitledDraft')) + '</strong><br><span class="meta">' + (d.items.length === 1 ? t('cart.itemOne') : t('cart.itemsOther').replace('{n}', d.items.length)) + ' · ' + priceLabel(cartTotal(d.items)) + ' · ' + esc(new Date(d.createdAt).toLocaleDateString()) + '</span></div>' +
          '<div class="cart-line"><button data-draft-restore="' + i + '">' + t('cart.restore') + '</button> ' +
          '<button data-draft-delete="' + i + '">' + t('cart.delete') + '</button></div></li>';
      }).join('') + '</ul>';
    }
    body.innerHTML = html;
  }

  function saveDraft() {
    var input = $('draftName');
    var name = input ? (input.value || '').trim() : '';
    if (!state.cart.length) return;
    state.cartDrafts.push({ name: name || t('cart.untitledDraft'), items: state.cart.slice(), createdAt: new Date().toISOString() });
    saveDrafts();
    renderCart();
  }

  function restoreDraft(i) {
    var d = state.cartDrafts[i];
    if (!d) return;
    state.cart = d.items.filter(function (it) { return it && typeof it.itemId === 'string'; });
    saveCart();
    renderCartButtons();
    renderCart();
  }

  function deleteDraft(i) {
    state.cartDrafts.splice(i, 1);
    saveDrafts();
    renderCart();
  }

  function checkoutCart() {
    var msg = $('checkoutMsg');
    var btn = $('checkoutBtn');
    if (!state.cart.length) return;
    if (btn) btn.disabled = true;
    if (msg) msg.textContent = t('cart.creating');
    fetch('/api/orders/checkout', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: state.cart })
    }).then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (x) {
        if (x.status === 200 && x.d.url) {
          gaEvent('checkout_start', { items: state.cart.length });
          location.href = x.d.url;
          return;
        }
        if (btn) btn.disabled = false;
        if (!msg) return;
        if (x.status === 503 && x.d.error === 'checkout_not_configured') {
          msg.textContent = t('cart.checkoutNotConfigured');
        } else if (x.status === 400 && x.d.error === 'unknown_item') {
          msg.textContent = t('cart.unknownItem');
        } else if (x.status === 429) {
          msg.textContent = t('cart.tooMany');
        } else {
          msg.textContent = t('cart.checkoutFailed');
        }
      })
      .catch(function () {
        if (btn) btn.disabled = false;
        if (msg) msg.textContent = t('cart.checkoutFailed');
      });
  }

  function findStickerRecord(id) {
    var found = null;
    (state.sets || []).forEach(function (rec) {
      (rec.stickers || []).forEach(function (s) {
        if (s.id === id) found = { file: s.file, thumb: s.thumb || s.file, title: s.title, setSlug: rec.slug };
      });
    });
    return found;
  }

  function orderQtySuffix(order) {
    return order.quantity && order.quantity > 1 ? ' ×' + order.quantity : '';
  }

  function orderTitle(order) {
    if (!state.links) return order.itemId;
    if (order.itemType === 'single' && state.links.singles[order.itemId]) return state.links.singles[order.itemId].title;
    if (order.itemType === 'set' && state.links.sets[order.itemId]) return state.links.sets[order.itemId].title;
    if (order.itemType === 'pack' && state.links.pack) return state.links.pack.title;
    return order.itemId;
  }

  function orderFileIds(order) {
    if (!state.links) return [];
    if (order.itemType === 'single') return [order.itemId];
    if (order.itemType === 'set' && state.links.sets[order.itemId]) return state.links.sets[order.itemId].stickers;
    if (order.itemType === 'pack' && state.links.pack) return state.links.pack.stickers;
    return [];
  }

  function markDelivered(sessionId) {
    fetch('/api/orders/lookup', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId })
    }).catch(function () { /* the order stays 'paid' — harmless */ });
  }

  var downloadToken = 0;

  function renderDownload(query) {
    var body = $('downloadBody');
    var token = ++downloadToken;
    var sessionId = query.get('session_id');
    var orderId = query.get('order_id');
    var email = query.get('email');
    if (!sessionId && !orderId && !email) {
      body.innerHTML = '<p class="meta">' + t('download.noSession') + '</p>';
      return;
    }
    if (email && !orderId && !sessionId) {
      body.innerHTML = '<p>' + t('download.lookingUp').replace('{email}', esc(email)) + '</p>';
      fetch('/api/orders/lookup?email=' + encodeURIComponent(email), { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          if (token !== downloadToken) return;
          var orders = d.orders || [];
          if (!orders.length) {
            body.innerHTML = '<p>' + t('download.noOrdersEmail') + '</p>';
            return;
          }
          body.innerHTML = '<p>' + (orders.length === 1 ? t('download.ordersFoundOne') : t('download.ordersFoundOther').replace('{n}', orders.length)) + '</p>' +
            orders.map(function (o) {
              return '<p class="order-card"><a href="#/download?order_id=' + encodeURIComponent(o.id) + '">' + esc(orderTitle(o)) + '</a> · ' +
                priceLabel(o.amountTotal) + ' · ' + esc(o.status) + ' · ' + esc(o.id) + '</p>';
            }).join('');
        })
        .catch(function () {
          if (token !== downloadToken) return;
          body.innerHTML = '<p>' + t('download.lookupFailed') + '</p>';
        });
      return;
    }
    // session_id or order_id: one order. The webhook may lag the
    // redirect by a second or two, so a 404 is retried briefly.
    var url = sessionId
      ? '/api/orders/lookup?session_id=' + encodeURIComponent(sessionId)
      : '/api/orders/lookup?order_id=' + encodeURIComponent(orderId);
    var attempts = 0;
    body.innerHTML = '<p>' + t('download.confirming') + '</p>';
    (function poll() {
      fetch(url, { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) {
          if (r.status === 404) throw new Error('not_found');
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (d) {
          if (token !== downloadToken) return;
          renderOrdersDownload(d.orders || [d.order], sessionId);
        })
        .catch(function (e) {
          if (token !== downloadToken) return;
          attempts += 1;
          if (e.message === 'not_found' && attempts < 15) {
            setTimeout(poll, 2000);
            return;
          }
          body.innerHTML = e.message === 'not_found'
            ? '<p>' + t('download.noOrderYet') + '</p>'
            : '<p>' + t('download.loadFailed') + '</p>';
        });
    })();
  }

  /* After a cart checkout lands on the download page, the paid
   * lines leave the cart — only the lines this session bought,
   * never the whole cart: it may hold other items for a later
   * checkout. Called only once the lookup confirms the orders
   * are paid, and only for a session (the post-checkout redirect);
   * an unconfirmed lookup leaves the cart untouched. saveCart()
   * updates the badge and PUTs the trimmed cart when signed in. */
  function clearPurchasedCartLines(orders) {
    var paid = (orders || []).filter(function (o) { return o && o.status === 'paid'; });
    if (!paid.length || !state.cart.length) return;
    var bought = {};
    paid.forEach(function (o) { if (o.itemId) bought[o.itemId] = true; });
    var before = state.cart.length;
    state.cart = state.cart.filter(function (it) { return !bought[it.itemId]; });
    if (state.cart.length !== before) saveCart();
  }

  /* A cart payment owns one Order row per item (CART.md). One item
   * renders exactly like a single purchase; several items render one
   * card each, with their own files. The invoice/shipping forms live
   * on each item's own order page, linked from its card. */
  function renderOrdersDownload(orders, sessionId) {
    var body = $('downloadBody');
    var list = (orders || []).filter(Boolean);
    if (!list.length) {
      body.innerHTML = '<p>' + t('download.noOrder') + '</p>';
      return;
    }
    if (list.length === 1) {
      renderOrderDownload(list[0], sessionId);
      return;
    }
    if (!state.sets.length) {
      body.innerHTML = '<p>' + t('download.loadingFiles') + '</p>';
      setTimeout(function () { renderOrdersDownload(list, sessionId); }, 500);
      return;
    }
    var total = list.reduce(function (s, o) { return s + (o.amountTotal || 0); }, 0);
    var html = '<p><strong>' + t('download.itemsPaid').replace('{n}', list.length).replace('{amount}', priceLabel(total)) + '</strong></p>';
    list.forEach(function (order) {
      var ids = orderFileIds(order);
      var files = ids.map(findStickerRecord).filter(Boolean);
      html += '<div class="order-card"><p><strong>' + esc(orderTitle(order)) + orderQtySuffix(order) + '</strong></p>' +
        '<p class="meta">' + priceLabel(order.amountTotal) + ' · ' + esc(order.currency.toUpperCase()) +
        ' · Order ' + esc(order.id) + ' · ' + esc(order.status) + '</p>';
      if (files.length) {
        html += '<ul class="download-list">' + files.map(function (f) {
          return '<li><a href="' + esc(f.file) + '" download>' + esc(f.title) + t('download.pngSuffix') + '</a></li>';
        }).join('') + '</ul>';
      }
      html += '<p class="meta"><a href="#/download?order_id=' + encodeURIComponent(order.id) + '">' + t('download.orderPage') + '</a>' + t('download.orderPageHint') + '</p></div>';
    });
    html += '<p class="meta">' + t('download.keepFiles') + '</p>';
    html += refundLineHtml();
    body.innerHTML = html;
    if (sessionId && list.some(function (o) { return o.status === 'paid'; })) {
      markDelivered(sessionId);
      clearPurchasedCartLines(list);
    }
  }

  function renderOrderDownload(order, sessionId) {
    var body = $('downloadBody');
    if (!order) {
      body.innerHTML = '<p>' + t('download.noOrder') + '</p>';
      return;
    }
    // The file list needs the index data; it may still be loading on a
    // direct landing, so wait for it briefly instead of showing nothing.
    if (!state.sets.length) {
      body.innerHTML = '<p>' + t('download.loadingFiles') + '</p>';
      setTimeout(function () { renderOrderDownload(order, sessionId); }, 500);
      return;
    }
    var ids = orderFileIds(order);
    var files = ids.map(findStickerRecord).filter(Boolean);
    var html = '<div class="order-card"><p><strong>' + esc(orderTitle(order)) + orderQtySuffix(order) + '</strong></p>' +
      '<p class="meta">' + priceLabel(order.amountTotal) + ' · ' + esc(order.currency.toUpperCase()) +
      ' · Order ' + esc(order.id) + ' · ' + esc(order.status) + '</p></div>';
    if (!files.length) {
      html += '<p>' + t('download.noFileMatch').replace('{id}', esc(order.id)) + '</p>';
    } else {
      html += '<p>' + (files.length === 1 ? t('download.yourSticker') : t('download.yourStickers')) + '</p><ul class="download-list">' +
        files.map(function (f) {
          return '<li><a href="' + esc(f.file) + '" download>' + esc(f.title) + t('download.pngSuffix') + '</a></li>';
        }).join('') + '</ul>' +
        '<p class="meta">' + t('download.keepFiles') + '</p>' +
        refundLineHtml();
    }
    // Fulfilment: print status + tracking, formal invoice, print
    // shipping address. The buyer proves the order with the email
    // they used at checkout (the page never shows it back).
    if (order.printStatus && order.printStatus !== 'none') {
      html += '<p><strong>' + t('download.print') + '</strong> ' + esc(order.printStatus) + '</p>';
      if (order.trackingNumber) {
        html += '<p class="meta">' + t('download.tracking').replace('{text}', esc((order.trackingCourier || '') + ' ' + order.trackingNumber)) + '</p>';
      }
    }
    if (order.invoiceNumber) {
      html += '<p class="meta">Invoice ' + esc(order.invoiceNumber) + ' was issued — a copy was sent to your email.</p>';
    } else if (!order.invoiceRequestedAt) {
      html += '<div class="order-card"><p><strong>Need a formal invoice?</strong></p>' +
        '<form id="invoiceRequestForm" class="comment-form" onsubmit="return false;">' +
        '<input id="invoiceEmail" type="email" placeholder="Email used at checkout" required aria-label="Email used at checkout">' +
        '<button type="submit">Request invoice</button> <span id="invoiceMsg" class="comment-msg" aria-live="polite"></span></form></div>';
    } else {
      html += '<p class="meta">Invoice requested — the shop will send it to your email.</p>';
    }
    if (order.hasShippingAddress) {
      html += '<p class="meta">' + t('download.shippingOnFile') + '</p>';
    } else {
      html += '<div class="order-card"><p><strong>' + t('download.wantPrintedTitle') + '</strong> ' + t('download.wantPrintedBody') + '</p>' +
        '<form id="shippingForm" class="comment-form" onsubmit="return false;">' +
        '<input id="shipEmail" type="email" placeholder="' + t('download.emailPlaceholder') + '" required aria-label="' + t('download.emailPlaceholder') + '">' +
        '<input id="shipName" type="text" placeholder="' + t('download.fullName') + '" required aria-label="' + t('download.fullName') + '">' +
        '<input id="shipLine1" type="text" placeholder="' + t('download.street') + '" required aria-label="' + t('download.street') + '">' +
        '<input id="shipLine2" type="text" placeholder="' + t('download.apt') + '" aria-label="' + t('download.apt') + '">' +
        '<input id="shipCity" type="text" placeholder="' + t('download.city') + '" required aria-label="' + t('download.city') + '">' +
        '<input id="shipPostal" type="text" placeholder="' + t('download.postal') + '" required aria-label="' + t('download.postal') + '">' +
        '<input id="shipCountry" type="text" placeholder="' + t('download.country') + '" value="Singapore" required aria-label="' + t('download.country') + '">' +
        '<button type="submit">' + t('download.addShipping') + '</button> <span id="shipMsg" class="comment-msg" aria-live="polite"></span></form></div>';
    }
    state.downloadOrder = order;
    state.downloadSessionId = sessionId || null;
    body.innerHTML = html;
    if (sessionId && order.status === 'paid') {
      markDelivered(sessionId);
      clearPurchasedCartLines([order]);
    }
  }

  function downloadOrderKey() {
    var o = state.downloadOrder;
    if (!o) return null;
    if (state.downloadSessionId) return { sessionId: state.downloadSessionId };
    return { orderId: o.id };
  }

  function requestInvoice(e) {
    e.preventDefault();
    var email = ($('invoiceEmail').value || '').trim();
    var msg = $('invoiceMsg');
    var key = downloadOrderKey();
    if (!key || !email) return;
    key.email = email;
    fetch('/api/orders/invoice-request', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(key)
    }).then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (x) {
        if (!msg) return;
        if (x.status === 201) msg.textContent = 'Invoice requested — the shop will send it to your email.';
        else if (x.status === 409) msg.textContent = 'An invoice was already requested for this order.';
        else if (x.status === 403) msg.textContent = 'That email does not match this order.';
        else msg.textContent = 'Could not request the invoice right now.';
      })
      .catch(function () { if (msg) msg.textContent = 'Could not request the invoice right now.'; });
  }

  function submitShipping(e) {
    e.preventDefault();
    var msg = $('shipMsg');
    var key = downloadOrderKey();
    if (!key) return;
    var address = {
      line1: ($('shipLine1').value || '').trim(),
      line2: ($('shipLine2').value || '').trim(),
      city: ($('shipCity').value || '').trim(),
      postal: ($('shipPostal').value || '').trim(),
      country: ($('shipCountry').value || '').trim()
    };
    key.email = ($('shipEmail').value || '').trim();
    key.name = ($('shipName').value || '').trim();
    key.address = address;
    fetch('/api/orders/shipping', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(key)
    }).then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (x) {
        if (!msg) return;
        if (x.status === 200) {
          msg.textContent = t('download.shippingAdded');
          if (state.downloadOrder) { state.downloadOrder.hasShippingAddress = true; state.downloadOrder.printStatus = 'queued'; }
        }
        else if (x.status === 403) msg.textContent = t('download.emailMismatch');
        else msg.textContent = t('download.shippingFailed');
      })
      .catch(function () { if (msg) msg.textContent = t('download.shippingFailed'); });
  }

  function findOrder(e) {
    e.preventDefault();
    var email = ($('findOrderEmail').value || '').trim();
    var id = ($('findOrderId').value || '').trim();
    var msg = $('findOrderMsg');
    if (id) { location.hash = '#/download?order_id=' + encodeURIComponent(id); return; }
    if (email) { location.hash = '#/download?email=' + encodeURIComponent(email); return; }
    if (msg) {
      msg.textContent = t('download.enterEmailOrId');
      setTimeout(function () { msg.textContent = ''; }, 2500);
    }
  }

  /* ---------- admin (#/kangle) ---------- */
  /* Shop admin (ADMIN.md): password login, orders, print queue,
   * invoices, settings. The admin session is a cookie set by the
   * /api/admin/* endpoints — this page never sees the password
   * after it is typed, and never shows card details. */

  function adminApi(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    opts.cache = 'no-store';
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(opts.body);
    }
    return fetch('/api/admin/' + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { status: r.status, data: d };
      });
    });
  }

  function adminNav(active) {
    var links = [
      ['dashboard', 'Dashboard', '#/kangle'],
      ['orders', 'Orders', '#/kangle/orders'],
      ['print', 'Print queue', '#/kangle/print'],
      ['invoices', 'Invoices', '#/kangle/invoices'],
      ['settings', 'Settings', '#/kangle/settings']
    ];
    return '<p class="admin-nav">' + links.map(function (l) {
      return '<a href="' + l[2] + '"' + (l[0] === active ? ' class="active"' : '') + '>' + l[1] + '</a>';
    }).join(' · ') + ' · <button data-admin-act="logout">Log out</button></p>';
  }

  function renderAdmin(parts) {
    var body = $('adminBody');
    body.innerHTML = '<p>Loading…</p>';
    adminApi('session').then(function (x) {
      if (x.status !== 200) { body.innerHTML = '<p>Could not reach the admin service right now.</p>'; return; }
      state.admin = x.data.admin || null;
      state.adminSetupNeeded = !!x.data.setupNeeded;
      if (state.adminSetupNeeded) { renderAdminSetup(); return; }
      if (!state.admin) { renderAdminLogin(); return; }
      var view = parts[0] || 'dashboard';
      if (view === 'orders' && parts[1]) renderAdminOrderDetail(parts[1]);
      else if (view === 'orders') renderAdminOrders();
      else if (view === 'print') renderAdminPrintQueue();
      else if (view === 'invoices') renderAdminInvoices();
      else if (view === 'settings') renderAdminSettings();
      else renderAdminDashboard();
    }).catch(function () {
      body.innerHTML = '<p>Could not reach the admin service right now.</p>';
    });
  }

  function renderAdminSetup() {
    $('adminBody').innerHTML =
      '<p>This shop has no admin account yet. Create one — this form only appears once, and the password is stored on this site only.</p>' +
      '<form id="adminSetupForm" class="comment-form" onsubmit="return false;">' +
      '<input id="adminSetupUser" type="text" placeholder="Username (3–32 letters, digits, _ or -)" required minlength="3" maxlength="32" autocomplete="username" aria-label="Admin username">' +
      '<input id="adminSetupPass" type="password" placeholder="Password (at least 10 characters)" required minlength="10" autocomplete="new-password" aria-label="Admin password">' +
      '<button type="submit">Create admin account</button> <span id="adminSetupMsg" class="comment-msg" aria-live="polite"></span></form>';
  }

  function renderAdminLogin() {
    $('adminBody').innerHTML =
      '<p>Sign in to manage the shop.</p>' +
      '<form id="adminLoginForm" class="comment-form" onsubmit="return false;">' +
      '<input id="adminLoginUser" type="text" placeholder="Username" required autocomplete="username" aria-label="Admin username">' +
      '<input id="adminLoginPass" type="password" placeholder="Password" required autocomplete="current-password" aria-label="Admin password">' +
      '<button type="submit">Sign in</button> <span id="adminLoginMsg" class="comment-msg" aria-live="polite"></span></form>';
  }

  function adminSetup(e) {
    e.preventDefault();
    var msg = $('adminSetupMsg');
    adminApi('setup', { method: 'POST', body: {
      username: ($('adminSetupUser').value || '').trim(),
      password: $('adminSetupPass').value || ''
    } }).then(function (x) {
      if (!msg) return;
      if (x.status === 201) { state.admin = x.data.admin; location.hash = '#/kangle'; route(); }
      else if (x.status === 409) msg.textContent = 'An admin account already exists — sign in instead.';
      else msg.textContent = 'Could not create the account. Check the username and password rules.';
    }).catch(function () { if (msg) msg.textContent = 'Could not reach the admin service.'; });
  }

  function adminLogin(e) {
    e.preventDefault();
    var msg = $('adminLoginMsg');
    adminApi('login', { method: 'POST', body: {
      username: ($('adminLoginUser').value || '').trim(),
      password: $('adminLoginPass').value || ''
    } }).then(function (x) {
      if (!msg) return;
      if (x.status === 200) { state.admin = x.data.admin; location.hash = '#/kangle'; route(); }
      else if (x.status === 429) msg.textContent = 'Too many attempts — wait 15 minutes and try again.';
      else msg.textContent = 'Wrong username or password.';
    }).catch(function () { if (msg) msg.textContent = 'Could not reach the admin service.'; });
  }

  function adminLogout() {
    adminApi('logout', { method: 'POST' }).then(function () {
      state.admin = null;
      location.hash = '#/kangle';
      route();
    });
  }

  function money(cents) { return 'S$' + (cents / 100).toFixed(2); }

  function orderStatusLabel(o) {
    return esc(o.status) + (o.printStatus && o.printStatus !== 'none' ? ' · print: ' + esc(o.printStatus) : '');
  }

  function renderAdminDashboard() {
    var body = $('adminBody');
    body.innerHTML = adminNav('dashboard') + '<p>Loading…</p>';
    Promise.all([adminApi('stats'), adminApi('invoices'), adminApi('print-queue'), adminApi('webhooks')]).then(function (xs) {
      var stats = xs[0].data || {};
      var invoices = xs[1].data || {};
      var queue = xs[2].data || {};
      var hooks = xs[3].data || {};
      body.innerHTML = adminNav('dashboard') +
        '<div class="admin-cards">' +
        '<p class="order-card"><strong>' + (stats.paidOrders || 0) + '</strong> paid orders · <strong>' + money(stats.totalRevenue || 0) + '</strong> revenue</p>' +
        '<p class="order-card"><strong>' + (stats.refundedOrders || 0) + '</strong> refunded · <strong>' + (stats.totalOrders || 0) + '</strong> orders total</p>' +
        '<p class="order-card"><strong>' + ((invoices.requests || []).length) + '</strong> invoice requests open · <strong>' + ((queue.orders || []).length) + '</strong> in the print queue</p>' +
        '<p class="order-card">Webhook: ' + (hooks.lastOkAt ? 'last event ' + esc(new Date(hooks.lastOkAt).toLocaleString()) : 'no events yet') + '</p>' +
        '</div>' +
        '<h2>Top sellers</h2>' +
        '<ul>' + ((stats.topItems || []).map(function (t) {
          return '<li>' + esc(t.itemId) + ' — ' + t.orders + ' orders · ' + money(t.revenue) + '</li>';
        }).join('') || '<li>None yet.</li>') + '</ul>';
    }).catch(function () {
      body.innerHTML = adminNav('dashboard') + '<p>Could not load the dashboard right now.</p>';
    });
  }

  function renderAdminOrders() {
    var body = $('adminBody');
    var f = state.adminOrdersFilter;
    body.innerHTML = adminNav('orders') +
      '<form id="adminOrdersFilterForm" class="comment-form" onsubmit="return false;">' +
      '<select id="adminFilterStatus" aria-label="Filter by status">' +
      [''].concat(['paid', 'delivered', 'refunded', 'cancelled']).map(function (s) {
        return '<option value="' + s + '"' + (f.status === s ? ' selected' : '') + '>' + (s || 'All statuses') + '</option>';
      }).join('') + '</select>' +
      '<input id="adminFilterQ" type="search" placeholder="Search email, order id, session…" value="' + esc(f.q) + '" aria-label="Search orders">' +
      '<button type="submit">Filter</button></form>' +
      '<div id="adminOrdersList"><p>Loading…</p></div>';
    var q = 'orders?page=' + state.adminOrdersPage + '&take=20' +
      (f.status ? '&status=' + encodeURIComponent(f.status) : '') +
      (f.q ? '&q=' + encodeURIComponent(f.q) : '');
    adminApi(q).then(function (x) {
      var list = $('adminOrdersList');
      if (!list) return;
      var d = x.data || {};
      var orders = d.orders || [];
      if (!orders.length) { list.innerHTML = '<p>No orders match.</p>'; return; }
      list.innerHTML = '<table class="admin-table"><thead><tr><th>Order</th><th>Item</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
        orders.map(function (o) {
          return '<tr><td><a href="#/kangle/orders/' + esc(o.id) + '">' + esc(o.id) + '</a><br><span class="meta">' + esc(o.buyerEmail || '') + '</span></td>' +
            '<td>' + esc(o.itemId) + '</td><td>' + money(o.amountTotal) + '</td><td>' + orderStatusLabel(o) + '</td>' +
            '<td>' + esc(new Date(o.createdAt).toLocaleDateString()) + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<p class="meta">' + (d.total || 0) + ' orders · page ' + (d.page || 1) + '</p>' +
        '<p><button data-admin-act="page-prev"' + (state.adminOrdersPage <= 1 ? ' disabled' : '') + '>← Newer</button> ' +
        '<button data-admin-act="page-next"' + (orders.length < 20 ? ' disabled' : '') + '>Older →</button></p>';
    }).catch(function () {
      var list = $('adminOrdersList');
      if (list) list.innerHTML = '<p>Could not load orders right now.</p>';
    });
  }

  function adminFilterOrders(e) {
    e.preventDefault();
    state.adminOrdersFilter = {
      status: $('adminFilterStatus').value || '',
      q: ($('adminFilterQ').value || '').trim()
    };
    state.adminOrdersPage = 1;
    renderAdminOrders();
  }

  function renderAdminOrderDetail(orderId) {
    var body = $('adminBody');
    body.innerHTML = adminNav('orders') + '<p>Loading…</p>';
    adminApi('orders/' + encodeURIComponent(orderId)).then(function (x) {
      if (x.status === 404) { body.innerHTML = adminNav('orders') + '<p>Order not found.</p>'; return; }
      var o = x.data.order;
      var auditRows = x.data.audit || [];
      var files = o.files || [];
      body.innerHTML = adminNav('orders') +
        '<h2>Order ' + esc(o.id) + '</h2>' +
        '<p class="meta">' + esc(new Date(o.createdAt).toLocaleString()) + ' · ' + esc(o.status) + '</p>' +
        '<table class="admin-table"><tbody>' +
        '<tr><th>Buyer</th><td>' + esc(o.buyerEmail || '—') + '</td></tr>' +
        '<tr><th>Item</th><td>' + esc(o.itemId) + ' (' + esc(o.itemType) + ')</td></tr>' +
        '<tr><th>Amount</th><td>' + money(o.amountTotal) + ' ' + esc(o.currency.toUpperCase()) + '</td></tr>' +
        '<tr><th>Payment</th><td>' + esc(o.payMethodType || '—') + ' · session <a href="https://dashboard.stripe.com/payments/' + esc(o.stripePaymentIntentId || '') + '" target="_blank" rel="noopener">' + esc(o.stripePaymentIntentId || o.stripeSessionId || '') + '</a></td></tr>' +
        '<tr><th>Print</th><td>' + esc(o.printStatus) + (o.trackingNumber ? ' · ' + esc((o.trackingCourier || '') + ' ' + o.trackingNumber) : '') + '</td></tr>' +
        '<tr><th>Shipping</th><td>' + (o.shippingAddress ? esc((o.shippingName || '') + ' — ' + [o.shippingAddress.line1, o.shippingAddress.line2, o.shippingAddress.city, o.shippingAddress.postal, o.shippingAddress.country].filter(Boolean).join(', ')) : '—') + '</td></tr>' +
        '<tr><th>Invoice</th><td>' + esc(o.invoiceNumber || '—') + (o.invoiceRequestedAt ? ' · requested ' + esc(new Date(o.invoiceRequestedAt).toLocaleDateString()) : '') + '</td></tr>' +
        '<tr><th>Notes</th><td>' + esc(o.adminNotes || '—') + '</td></tr>' +
        '</tbody></table>' +
        '<h3>Files' + (files.length ? ' (' + files.length + ')' : '') + '</h3>' +
        (files.length ? '<ul class="download-list">' + files.map(function (f) {
          return '<li><a href="' + esc(f.file) + '" download>' + esc(f.file) + '</a> · ' + f.width + '×' + f.height + ' · ' + Math.round(f.width / 5) + ' DPI at 5"</li>';
        }).join('') + '</ul>' : '<p class="meta">Files were not pinned for this order (paid before pinning shipped). Resolve them from the item id above.</p>') +
        '<h3>Status</h3>' +
        '<form id="adminStatusForm" class="comment-form" onsubmit="return false;">' +
        '<input type="hidden" id="adminStatusOrderId" value="' + esc(o.id) + '">' +
        '<select id="adminStatusSelect" aria-label="New status">' +
        ['delivered', 'refunded', 'cancelled'].map(function (s) { return '<option value="' + s + '">' + s + '</option>'; }).join('') +
        '</select>' +
        '<input id="adminStatusReason" type="text" placeholder="Reason (required)" required aria-label="Reason">' +
        '<button type="submit">Change status</button> <span id="adminStatusMsg" class="comment-msg" aria-live="polite"></span></form>' +
        '<h3>Print</h3><p>' +
        ['queued', 'printing', 'shipped', 'delivered', 'none'].map(function (s) {
          return '<button data-admin-act="print" data-admin-order="' + esc(o.id) + '" data-admin-value="' + s + '"' + (o.printStatus === s ? ' disabled' : '') + '>' + s + '</button> ';
        }).join('') + '</p>' +
        '<h3>Shipping &amp; tracking</h3>' +
        '<form id="adminShipForm" class="comment-form" onsubmit="return false;">' +
        '<input type="hidden" id="adminShipOrderId" value="' + esc(o.id) + '">' +
        '<input id="adminShipName" type="text" placeholder="Recipient name" value="' + esc(o.shippingName || '') + '" aria-label="Recipient name">' +
        '<input id="adminShipCourier" type="text" placeholder="Courier" value="' + esc(o.trackingCourier || '') + '" aria-label="Courier">' +
        '<input id="adminShipTracking" type="text" placeholder="Tracking number" value="' + esc(o.trackingNumber || '') + '" aria-label="Tracking number">' +
        '<button type="submit">Save shipping</button> <span id="adminShipMsg" class="comment-msg" aria-live="polite"></span></form>' +
        '<h3>Invoice</h3><p class="meta">Issue the invoice in the <a href="https://dashboard.stripe.com/invoices/create" target="_blank" rel="noopener">Stripe Dashboard</a>, then record its id and number here.</p>' +
        '<form id="adminInvoiceForm" class="comment-form" onsubmit="return false;">' +
        '<input type="hidden" id="adminInvoiceOrderId" value="' + esc(o.id) + '">' +
        '<input id="adminInvoiceId" type="text" placeholder="Stripe invoice id (in_…)" value="' + esc(o.invoiceId || '') + '" aria-label="Stripe invoice id">' +
        '<input id="adminInvoiceNumber" type="text" placeholder="Invoice number" value="' + esc(o.invoiceNumber || '') + '" aria-label="Invoice number">' +
        '<button type="submit">Record invoice</button> <span id="adminInvoiceMsg" class="comment-msg" aria-live="polite"></span></form>' +
        '<h3>Notes</h3>' +
        '<form id="adminNoteForm" class="comment-form" onsubmit="return false;">' +
        '<input type="hidden" id="adminNoteOrderId" value="' + esc(o.id) + '">' +
        '<textarea id="adminNoteText" rows="2" maxlength="2000" placeholder="Admin-only note…" aria-label="Admin note">' + esc(o.adminNotes || '') + '</textarea>' +
        '<button type="submit">Save note</button> <span id="adminNoteMsg" class="comment-msg" aria-live="polite"></span></form>' +
        '<h3>History</h3>' +
        (auditRows.length ? '<ul>' + auditRows.map(function (a) {
          return '<li><span class="meta">' + esc(new Date(a.createdAt).toLocaleString()) + '</span> ' + esc(a.action) + ' — ' + esc(a.adminUser) + '</li>';
        }).join('') + '</ul>' : '<p class="meta">No admin actions recorded for this order yet.</p>');
    }).catch(function () {
      body.innerHTML = adminNav('orders') + '<p>Could not load that order right now.</p>';
    });
  }

  function adminOrderStatus(e) {
    e.preventDefault();
    var id = $('adminStatusOrderId').value;
    var msg = $('adminStatusMsg');
    adminApi('orders/' + encodeURIComponent(id) + '/status', { method: 'POST', body: {
      status: $('adminStatusSelect').value,
      reason: ($('adminStatusReason').value || '').trim()
    } }).then(function (x) {
      if (!msg) return;
      if (x.status === 200) { msg.textContent = 'Status updated.'; renderAdminOrderDetail(id); }
      else if (x.status === 409) msg.textContent = 'That change is not allowed from the current status.';
      else msg.textContent = 'Could not change the status.';
    }).catch(function () { if (msg) msg.textContent = 'Could not reach the admin service.'; });
  }

  function adminOrderNote(e) {
    e.preventDefault();
    var id = $('adminNoteOrderId').value;
    var msg = $('adminNoteMsg');
    adminApi('orders/' + encodeURIComponent(id) + '/note', { method: 'POST', body: {
      note: ($('adminNoteText').value || '').trim()
    } }).then(function (x) {
      if (msg) msg.textContent = x.status === 200 ? 'Note saved.' : 'Could not save the note.';
    }).catch(function () { if (msg) msg.textContent = 'Could not reach the admin service.'; });
  }

  function adminOrderShipping(e) {
    e.preventDefault();
    var id = $('adminShipOrderId').value;
    var msg = $('adminShipMsg');
    var body = {};
    var name = ($('adminShipName').value || '').trim();
    var courier = ($('adminShipCourier').value || '').trim();
    var tracking = ($('adminShipTracking').value || '').trim();
    if (name) body.name = name;
    if (courier) body.courier = courier;
    if (tracking) body.trackingNumber = tracking;
    adminApi('orders/' + encodeURIComponent(id) + '/shipping', { method: 'POST', body: body }).then(function (x) {
      if (!msg) return;
      if (x.status === 200) { msg.textContent = 'Saved.'; renderAdminOrderDetail(id); }
      else msg.textContent = 'Could not save shipping.';
    }).catch(function () { if (msg) msg.textContent = 'Could not reach the admin service.'; });
  }

  function adminOrderInvoice(e) {
    e.preventDefault();
    var id = $('adminInvoiceOrderId').value;
    var msg = $('adminInvoiceMsg');
    adminApi('orders/' + encodeURIComponent(id) + '/invoice', { method: 'POST', body: {
      invoiceId: ($('adminInvoiceId').value || '').trim(),
      invoiceNumber: ($('adminInvoiceNumber').value || '').trim()
    } }).then(function (x) {
      if (!msg) return;
      if (x.status === 200) { msg.textContent = 'Invoice recorded.'; renderAdminOrderDetail(id); }
      else msg.textContent = 'Could not record the invoice.';
    }).catch(function () { if (msg) msg.textContent = 'Could not reach the admin service.'; });
  }

  function renderAdminPrintQueue() {
    var body = $('adminBody');
    body.innerHTML = adminNav('print') + '<p>Loading…</p>';
    adminApi('print-queue').then(function (x) {
      var orders = (x.data && x.data.orders) || [];
      if (!orders.length) { body.innerHTML = adminNav('print') + '<p>The print queue is empty.</p>'; return; }
      body.innerHTML = adminNav('print') + orders.map(function (o) {
        var files = o.files || [];
        return '<div class="order-card"><p><strong>' + esc(o.itemId) + '</strong> · ' + money(o.amountTotal) + ' · ' + esc(o.status) + ' · print: <strong>' + esc(o.printStatus) + '</strong></p>' +
          '<p class="meta">Order ' + esc(o.id) + ' · ' + esc(o.buyerEmail || '') + ' · ' + esc(new Date(o.createdAt).toLocaleDateString()) + '</p>' +
          (o.shippingAddress ? '<p class="meta">' + esc((o.shippingName || '') + ' — ' + [o.shippingAddress.line1, o.shippingAddress.line2, o.shippingAddress.city, o.shippingAddress.postal, o.shippingAddress.country].filter(Boolean).join(', ')) + '</p>' : '<p class="meta">No shipping address yet.</p>') +
          (o.trackingNumber ? '<p class="meta">Tracking: ' + esc((o.trackingCourier || '') + ' ' + o.trackingNumber) + '</p>' : '') +
          (files.length ? '<ul class="download-list">' + files.map(function (f) {
            return '<li><a href="' + esc(f.file) + '" download>' + esc(f.file) + '</a> · ' + f.width + '×' + f.height + '</li>';
          }).join('') + '</ul>' : '') +
          '<p>' + ['queued', 'printing', 'shipped', 'delivered'].map(function (s) {
            return '<button data-admin-act="print" data-admin-order="' + esc(o.id) + '" data-admin-value="' + s + '"' + (o.printStatus === s ? ' disabled' : '') + '>' + s + '</button> ';
          }).join('') + '<a href="#/kangle/orders/' + esc(o.id) + '">Details</a></p></div>';
      }).join('');
    }).catch(function () {
      body.innerHTML = adminNav('print') + '<p>Could not load the print queue right now.</p>';
    });
  }

  function renderAdminInvoices() {
    var body = $('adminBody');
    body.innerHTML = adminNav('invoices') + '<p>Loading…</p>';
    adminApi('invoices').then(function (x) {
      var d = x.data || {};
      var requests = d.requests || [];
      var issued = d.issued || [];
      body.innerHTML = adminNav('invoices') +
        '<h2>Requests</h2>' +
        (requests.length ? requests.map(function (r) {
          return '<p class="order-card">Order <a href="#/kangle/orders/' + esc(r.orderId) + '">' + esc(r.orderId) + '</a> · ' + esc(r.buyerEmail || '') + ' · ' + esc(new Date(r.createdAt).toLocaleDateString()) +
            ' <button data-admin-act="resolve" data-admin-id="' + esc(r.id) + '" data-admin-value="issued">Mark issued</button> ' +
            '<button data-admin-act="resolve" data-admin-id="' + esc(r.id) + '" data-admin-value="declined">Decline</button></p>';
        }).join('') : '<p class="meta">No open requests.</p>') +
        '<h2>Issued</h2>' +
        (issued.length ? '<ul>' + issued.map(function (o) {
          return '<li><a href="#/kangle/orders/' + esc(o.id) + '">' + esc(o.id) + '</a> — ' + esc(o.invoiceNumber || '') + ' · ' + money(o.amountTotal) + '</li>';
        }).join('') + '</ul>' : '<p class="meta">None recorded yet.</p>');
    }).catch(function () {
      body.innerHTML = adminNav('invoices') + '<p>Could not load invoices right now.</p>';
    });
  }

  function renderAdminSettings() {
    var body = $('adminBody');
    body.innerHTML = adminNav('settings') + '<p>Loading…</p>';
    Promise.all([adminApi('settings'), adminApi('sessions')]).then(function (xs) {
      var s = xs[0].data || {};
      var sessions = (xs[1].data && xs[1].data.sessions) || [];
      var setSlugs = [];
      if (state.links) {
        setSlugs = Object.keys(state.links.sets || {});
      }
      body.innerHTML = adminNav('settings') +
        '<form id="adminSettingsForm" class="comment-form" onsubmit="return false;">' +
        '<label><input id="adminShopClosed" type="checkbox"' + (s.shopClosed ? ' checked' : '') + '> Shop closed (hides every Buy button)</label>' +
        '<label><input id="adminUploadsEnabled" type="checkbox"' + (s.uploadsEnabled ? ' checked' : '') + '> Allow photo uploads (personal gallery)</label>' +
        '<label><input id="adminHideBuyButtons" type="checkbox"' + (s.hideBuyButtons ? ' checked' : '') + '> Hide Buy buttons (direct purchase)</label>' +
        '<input id="adminAnnouncement" type="text" maxlength="280" placeholder="Announcement banner (optional)" value="' + esc(s.announcement || '') + '" aria-label="Announcement banner">' +
        '<p class="meta">Hide Buy buttons for:</p>' +
        setSlugs.map(function (slug) {
          var hidden = (s.hiddenItems || []).indexOf(slug) !== -1;
          return '<label><input type="checkbox" data-hidden-item="' + esc(slug) + '"' + (hidden ? ' checked' : '') + '> ' + esc(slug) + '</label> ';
        }).join('') +
        '<label><input type="checkbox" data-hidden-item="complete-pack-30"' + ((s.hiddenItems || []).indexOf('complete-pack-30') !== -1 ? ' checked' : '') + '> Complete pack</label>' +
        '<p><button type="submit">Save settings</button> <span id="adminSettingsMsg" class="comment-msg" aria-live="polite"></span></p></form>' +
        '<h2>Change password</h2>' +
        '<form id="adminPasswordForm" class="comment-form" onsubmit="return false;">' +
        '<input id="adminOldPass" type="password" placeholder="Current password" required autocomplete="current-password" aria-label="Current password">' +
        '<input id="adminNewPass" type="password" placeholder="New password (at least 10 characters)" required minlength="10" autocomplete="new-password" aria-label="New password">' +
        '<button type="submit">Change password</button> <span id="adminPasswordMsg" class="comment-msg" aria-live="polite"></span></form>' +
        '<h2>Sessions</h2><p class="meta">' + sessions.length + ' active session(s).</p>' +
        '<p><button data-admin-act="revoke-sessions">Log out everywhere else</button></p>';
    }).catch(function () {
      body.innerHTML = adminNav('settings') + '<p>Could not load settings right now.</p>';
    });
  }

  function adminSaveSettings(e) {
    e.preventDefault();
    var msg = $('adminSettingsMsg');
    var hidden = [];
    document.querySelectorAll('[data-hidden-item]').forEach(function (cb) {
      if (cb.checked) hidden.push(cb.getAttribute('data-hidden-item'));
    });
    adminApi('settings', { method: 'POST', body: {
      shopClosed: !!$('adminShopClosed').checked,
      announcement: ($('adminAnnouncement').value || '').trim(),
      hiddenItems: hidden,
      uploadsEnabled: !!$('adminUploadsEnabled').checked,
      hideBuyButtons: !!$('adminHideBuyButtons').checked
    } }).then(function (x) {
      if (!msg) return;
      if (x.status === 200) { msg.textContent = 'Settings saved.'; loadSettings(); }
      else msg.textContent = 'Could not save settings.';
    }).catch(function () { if (msg) msg.textContent = 'Could not reach the admin service.'; });
  }

  function adminChangePassword(e) {
    e.preventDefault();
    var msg = $('adminPasswordMsg');
    adminApi('change-password', { method: 'POST', body: {
      oldPassword: $('adminOldPass').value || '',
      newPassword: $('adminNewPass').value || ''
    } }).then(function (x) {
      if (!msg) return;
      if (x.status === 200) msg.textContent = 'Password changed. Other sessions were logged out.';
      else if (x.status === 401) msg.textContent = 'Current password is wrong.';
      else msg.textContent = 'Could not change the password.';
    }).catch(function () { if (msg) msg.textContent = 'Could not reach the admin service.'; });
  }

  /* ---------- events ---------- */

  $('search').addEventListener('input', function (e) {
    state.q = e.target.value; state.shown = PAGE_SIZE; renderGrid();
  });

  document.querySelector('.lang-toggle').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-lang]');
    if (!b) return;
    state.lang = b.dataset.lang; state.shown = PAGE_SIZE;
    document.querySelectorAll('.lang-toggle button').forEach(function (x) {
      x.classList.toggle('active', x === b);
    });
    renderGrid();
  });

  // The UI-language toggle: a separate control from the content
  // filter above, with its own variable (state.uiLang), its own
  // localStorage key, and its own data attribute (data-uilang).
  // It never touches state.lang — switching the UI to Chinese
  // does not narrow the catalogue. There are two of them (the
  // controls row on the home view, and the reader's crumbs line),
  // so bind every .ui-lang-toggle on the page.
  document.querySelectorAll('.ui-lang-toggle').forEach(function (group) {
    group.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-uilang]');
      if (!b) return;
      setLang(b.dataset.uilang);
    });
  });

  $('chips').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-batch]');
    if (!b) return;
    var id = b.dataset.batch;
    // Clicking the active category toggles the filter off; without this the
    // hash is set to the same value and no hashchange fires at all.
    location.hash = (id === 'all' || String(state.batch) === String(id)) ? '#/' : '#/batch/' + id;
  });

  $('topics').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-topic]');
    if (!b) return;
    var t = b.dataset.topic;
    location.hash = (state.topic === t) ? '#/' : '#/topic/' + encodeURIComponent(t);
  });

  $('loadMore').addEventListener('click', function () {
    state.shown += PAGE_SIZE; renderGrid();
  });

  $('zoomBtn').addEventListener('click', function () { openReaderImage(); });
  $('magnifyBtn').addEventListener('click', function () { setMagnifyMode(!state.magnifyMode); });
  // Magnifier controls (visible only while the mode is on): the zoom
  // stepper and the S/M/L lens sizes. Delegated on the row so the
  // buttons need no per-button binding.
  var magCtl = $('magnifyControls');
  if (magCtl) magCtl.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!t) return;
    if (t.id === 'magnifyZoomDec') setMagnifyZoom(MAGNIFY - MAGNIFY_STEP);
    else if (t.id === 'magnifyZoomInc') setMagnifyZoom(MAGNIFY + MAGNIFY_STEP);
    else if (t.getAttribute('data-mag-size')) applyMagnifierSize(t.getAttribute('data-mag-size'));
  });
  $('setImg').addEventListener('click', function () { if (state.magnifyMode) return; openReaderImage(); });
  $('setImg').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!state.magnifyMode) openReaderImage(); }
  });
  // Magnifier: a mouse hover shows the lens and it tracks the pointer;
  // in magnify mode a finger drag moves it (lifted above the finger).
  $('setImg').addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch') {
      if (state.magnifyMode && magnifyDrag) showLensAt(e.clientX, e.clientY, -LENS_LIFT);
      return;
    }
    if (state.magnifyMode) { showLensAt(e.clientX, e.clientY, 0); return; }
    if (!showLensAt(e.clientX, e.clientY, 0)) hideLens();
  });
  $('setImg').addEventListener('pointerdown', function (e) {
    if (!state.magnifyMode || e.pointerType !== 'touch') return;
    magnifyDrag = true;
    showLensAt(e.clientX, e.clientY, -LENS_LIFT);
    if (e.preventDefault) e.preventDefault();
  });
  $('setImg').addEventListener('pointerup', function () { magnifyDrag = false; });
  $('setImg').addEventListener('pointercancel', function () { magnifyDrag = false; });
  $('setImg').addEventListener('pointerleave', function () { if (!state.magnifyMode) hideLens(); });

  /* ---------- column modal ---------- */
  /* The news column is the backdrop of a set: the reader's 专栏原文
   * button opens the full researched column (brief.md, via the
   * record's column_md) as a modal overlay. */

  function mdInline(s) {
    return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  function mdToHtml(md) {
    var out = [], inList = false;
    function flushList() { if (inList) { out.push('</ul>'); inList = false; } }
    String(md || '').split('\n').forEach(function (raw) {
      var line = raw.trim();
      if (!line) { flushList(); return; }
      if (line.indexOf('## ') === 0) { flushList(); out.push('<h3>' + mdInline(line.slice(3)) + '</h3>'); return; }
      if (line.indexOf('### ') === 0) { flushList(); out.push('<h4>' + mdInline(line.slice(4)) + '</h4>'); return; }
      if (line.indexOf('|') === 0) {
        var cells = line.split('|').slice(1, -1).map(function (c) { return c.trim(); });
        if (cells.length && cells.every(function (c) { return /^[:\- ]*$/.test(c); })) return;
        flushList();
        out.push('<p>' + (cells.length > 1 ? '<strong>' + esc(cells[0]) + '</strong> — ' + mdInline(cells.slice(1).join(' ')) : mdInline(cells[0] || '')) + '</p>');
        return;
      }
      if (line.indexOf('- ') === 0 || line.indexOf('· ') === 0) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + mdInline(line.slice(2)) + '</li>');
        return;
      }
      if (/^\d+[.、]\s/.test(line)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + mdInline(line.replace(/^\d+[.、]\s*/, '')) + '</li>');
        return;
      }
      flushList();
      out.push('<p>' + mdInline(line) + '</p>');
    });
    flushList();
    return out.join('');
  }

  function openColumnModal() {
    var rec = state.currentSlug ? findSet(state.currentSlug) : null;
    if (!rec) return;
    $('columnModalTitle').textContent = rec.title;
    // The stored column text is the backdrop: it goes first, verbatim.
    // The researched brief follows under its own heading.
    var body = '';
    if (rec.column_source) {
      body += '<h3>' + t('reader.column') + '</h3>' + mdToHtml(rec.column_source);
      if (rec.column_md) body += '<h3>' + t('column.brief') + '</h3>' + mdToHtml(rec.column_md);
    } else {
      body = mdToHtml(rec.column_md || t('column.empty'));
    }
    $('columnModalBody').innerHTML = body;
    $('columnModal').hidden = false;
    document.body.classList.add('modal-open');
    gaEvent('column_modal', { slug: state.currentSlug || '' });
  }

  function closeColumnModal() {
    $('columnModal').hidden = true;
    document.body.classList.remove('modal-open');
  }

  /* ---------- sticker modal ---------- */
  /* Tapping one sticker pops up that sticker's script: the big image,
   * its Japanese line + Chinese, the point it makes and the scene. */

  function openStickerModal(n) {
    var rec = state.currentSlug ? findSet(state.currentSlug) : null;
    if (!rec) return;
    var s = null;
    (rec.stickers || []).forEach(function (x) { if (String(x.n) === String(n)) s = x; });
    if (!s) return;
    state.currentSticker = s;
    $('stickerModalTitle').textContent = s.title;
    var img = $('stickerModalImg');
    img.src = s.file;
    img.alt = stickerAlt(s);
    $('stickerModalJa').textContent = s.ja || '';
    $('stickerModalZh').textContent = s.zh || '';
    $('stickerModalPoint').textContent = s.point || '';
    $('stickerModalScene').textContent = s.scene || '';
    $('stickerModal').hidden = false;
    document.body.classList.add('modal-open');
    loadStickerLike(s.id);
    loadStickerBookmark(s.id);
    renderStickerBuyBtn();
    renderCartButtons();
    gaEvent('sticker_modal', { slug: state.currentSlug || '', n: String(n) });
  }

  /* Sticker lightbox: previous / next sticker, wrapping around the set.
   * The modal is the lightbox — arrows on the sides, ArrowLeft /
   * ArrowRight on the keyboard, Escape to close. */
  function stickerNav(dir) {
    var rec = state.currentSlug ? findSet(state.currentSlug) : null;
    var s = state.currentSticker;
    if (!rec || !s) return;
    var list = rec.stickers || [];
    var i = -1;
    list.forEach(function (x, idx) { if (String(x.n) === String(s.n)) i = idx; });
    if (i < 0 || list.length < 2) return;
    openStickerModal(list[(i + dir + list.length) % list.length].n);
  }

  function closeStickerModal() {
    $('stickerModal').hidden = true;
    document.body.classList.remove('modal-open');
    state.currentSticker = null;
    // A deep link (#/set/<slug>/sticker/<n>) brought the reader here:
    // leaving it in the address bar would reopen the modal on reload,
    // so step back to the plain set URL without triggering a route.
    var m = (location.hash || '').match(/^#\/set\/([^/]+)\/sticker\/\d+$/);
    if (m) history.replaceState(null, '', '#/set/' + m[1]);
  }

  /* ---------- image lightbox (cart thumbnails) ---------- */
  /* A cart thumbnail opens the original-size image — the full PNG
   * for a sticker, the full sheet for a set — in the same modal
   * pattern as the sticker and column modals. The reader's sheet
   * image uses the same modal (eventName 'reader_image_modal');
   * cart thumbnails and gallery photos keep the default. */
  function openImageModal(src, title, eventName) {
    $('imageModalTitle').textContent = title || '';
    var img = $('imageModalImg');
    img.src = src;
    img.alt = title || '';
    $('imageModal').hidden = false;
    document.body.classList.add('modal-open');
    gaEvent(eventName || 'cart_image_modal', { title: title || '' });
  }

  /* ---------- sheet magnifier (Amazon-style lens) ---------- */
  /* A circular lens follows the pointer over the sheet image and shows
   * the same sheet at 0.8x, so a detail can be inspected without
   * opening the fullscreen lightbox. The lens reuses the sheet src
   * already loaded in #setImg — no second download. Desktop: hover
   * shows it; a plain click still opens the lightbox. Touch: the
   * Magnify button toggles the mode, then a finger drag moves the
   * lens (lifted above the finger so it stays visible) and taps do
   * not open the lightbox until the mode is off. While the mode is
   * on, #magnifyControls offers a zoom stepper (0.5x–1.5x) and lens
   * sizes S/M/L; the visitor's choices persist per device in
   * localStorage under MAGNIFY_PREFS_KEY. */
  var MAGNIFY = 0.8; // default zoom; the stepper moves it 0.5x–1.5x
  var MAGNIFY_MIN = 0.5, MAGNIFY_MAX = 1.5, MAGNIFY_STEP = 0.1;
  var MAGNIFY_PREFS_KEY = 'sutekka-magnifier-v1';
  var MAGNIFY_SIZES = { S: 1, M: 1.5, L: 2 }; // multipliers on the base lens
  var magnifySize = 'L'; // default: the biggest lens
  var lastLensPos = null; // last {x, y, lift} shown, so a zoom/size change re-renders the lens
  var LENS_D = 180; // base (S) lens diameter on desktop; 120px on phones, see styles.css
  var LENS_R = LENS_D / 2;
  var LENS_LIFT = 90; // touch: lens centre sits this far above the finger
  var magnifyDrag = false;

  function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* Pure geometry, kept separate so it is unit-testable: rectW/H is the
   * displayed image size, natW/H the sheet's natural size, px/py the
   * pointer in displayed-image coords, liftY the lens-centre offset
   * (0 for a mouse, -LENS_LIFT for a finger), lensD the rendered lens
   * diameter (base 180px desktop, 120px on phones, x1.5 for M, x2 for
   * L — see styles.css). The zoomed view stays centred on the
   * pointer, clamped so the lens never shows blank background; the
   * lens itself stays inside the displayed image — when the lens is
   * bigger than the sheet (L on a phone: 240px lens, ~180px sheet)
   * it pins to the image's top-left and only the zoomed content
   * inside it moves. Zoom comes from the MAGNIFY global, so the
   * stepper changes it live. Zoom below 1x shrinks the background,
   * so on a small sheet the whole zoomed image can fit inside the
   * lens (bgW <= d): then it is centred in the lens instead of
   * clamped — the old clamp's range would invert (lo > hi) and pin
   * the image to the lens's top-left corner. The lens's own
   * background is the paper tone (styles.css), so the even margins
   * around a centred small image read as paper, not blank white. */
  function magnifierLens(rectW, rectH, natW, natH, px, py, liftY, lensD) {
    if (!rectW || !rectH || !natW || !natH) return null;
    var d = lensD || LENS_D, r = d / 2;
    var bgW = natW * MAGNIFY, bgH = natH * MAGNIFY;
    var pxNat = px * (natW / rectW) * MAGNIFY;
    var pyNat = py * (natH / rectH) * MAGNIFY;
    var bgX = bgW > d ? -(clampNum(pxNat, r, bgW - r) - r) : (d - bgW) / 2;
    var bgY = bgH > d ? -(clampNum(pyNat, r, bgH - r) - r) : (d - bgH) / 2;
    return {
      left: clampNum(px - r, 0, Math.max(0, rectW - d)),
      top: clampNum(py + (liftY || 0) - r, 0, Math.max(0, rectH - d)),
      bgX: bgX,
      bgY: bgY,
      bgW: bgW,
      bgH: bgH
    };
  }

  function showLensAt(clientX, clientY, liftY) {
    var img = $('setImg');
    if (!img) return false;
    var src = img.getAttribute('src') || img.src;
    if (!src || !img.getBoundingClientRect) return false;
    var rect = img.getBoundingClientRect();
    var lens = $('sheetLens');
    if (!lens) return false;
    // Unhide first: the rendered size (offsetWidth) is 0 while hidden,
    // and the phone media query shrinks it to 120px.
    lens.hidden = false;
    var m = magnifierLens(rect.width, rect.height, img.naturalWidth, img.naturalHeight, clientX - rect.left, clientY - rect.top, liftY, lens.offsetWidth || LENS_D);
    if (!m) { lens.hidden = true; return false; }
    lastLensPos = { x: clientX, y: clientY, lift: liftY || 0 };
    lens.style.backgroundImage = 'url("' + src + '")';
    lens.style.backgroundSize = m.bgW + 'px ' + m.bgH + 'px';
    lens.style.backgroundPosition = m.bgX + 'px ' + m.bgY + 'px';
    lens.style.left = ((img.offsetLeft || 0) + m.left) + 'px';
    lens.style.top = ((img.offsetTop || 0) + m.top) + 'px';
    return true;
  }

  function hideLens() {
    var lens = $('sheetLens');
    if (lens) lens.hidden = true;
  }

  function refreshLens() {
    // Re-render the lens at its last position after a zoom/size change.
    var lens = $('sheetLens');
    if (lens && !lens.hidden && lastLensPos) showLensAt(lastLensPos.x, lastLensPos.y, lastLensPos.lift);
  }

  function magnifierZoomText(z) { return (Math.round(z * 100) / 100) + '×'; }

  function saveMagnifierPrefs() {
    lsSet(MAGNIFY_PREFS_KEY, { zoom: MAGNIFY, size: magnifySize });
  }

  function setMagnifyZoom(next) {
    // Clamp to the range and snap to the 0.1x step; the lens (if
    // visible) re-renders at the new zoom right away.
    var z = clampNum(Math.round(next / MAGNIFY_STEP) * MAGNIFY_STEP, MAGNIFY_MIN, MAGNIFY_MAX);
    z = Math.round(z * 100) / 100;
    MAGNIFY = z;
    var val = $('magnifyZoomVal');
    if (val) val.textContent = magnifierZoomText(z);
    var dec = $('magnifyZoomDec'), inc = $('magnifyZoomInc');
    if (dec) dec.disabled = z <= MAGNIFY_MIN;
    if (inc) inc.disabled = z >= MAGNIFY_MAX;
    saveMagnifierPrefs();
    refreshLens();
  }

  function applyMagnifierSize(size) {
    if (!MAGNIFY_SIZES[size]) size = 'L';
    magnifySize = size;
    var lens = $('sheetLens');
    if (lens) {
      lens.classList.remove('lens-m', 'lens-l');
      if (size === 'M') lens.classList.add('lens-m');
      if (size === 'L') lens.classList.add('lens-l');
    }
    // The S/M/L buttons show which size is active.
    var sizes = ['S', 'M', 'L'];
    for (var i = 0; i < sizes.length; i++) {
      var sb = $('magnifySize' + sizes[i]);
      if (sb) sb.setAttribute('aria-pressed', sizes[i] === size ? 'true' : 'false');
    }
    saveMagnifierPrefs();
    refreshLens();
  }

  function loadMagnifierPrefs() {
    var p = lsGet(MAGNIFY_PREFS_KEY) || {};
    // In range: keep the visitor's zoom (snapped to the 0.1x step).
    // Out of range — e.g. 3.25x saved under an older range — fall
    // back to the default instead of clamping to a bound, so an old
    // preference never silently becomes the strongest zoom.
    var z = (typeof p.zoom === 'number' && isFinite(p.zoom) && p.zoom >= MAGNIFY_MIN && p.zoom <= MAGNIFY_MAX) ? p.zoom : MAGNIFY;
    MAGNIFY = clampNum(Math.round(z / MAGNIFY_STEP) * MAGNIFY_STEP, MAGNIFY_MIN, MAGNIFY_MAX);
    MAGNIFY = Math.round(MAGNIFY * 100) / 100;
    var val = $('magnifyZoomVal');
    if (val) val.textContent = magnifierZoomText(MAGNIFY);
    var dec = $('magnifyZoomDec'), inc = $('magnifyZoomInc');
    if (dec) dec.disabled = MAGNIFY <= MAGNIFY_MIN;
    if (inc) inc.disabled = MAGNIFY >= MAGNIFY_MAX;
    applyMagnifierSize(MAGNIFY_SIZES[p.size] ? p.size : 'L');
  }

  function setMagnifyMode(on) {
    state.magnifyMode = !!on;
    magnifyDrag = false;
    var btn = $('magnifyBtn');
    if (btn) btn.setAttribute('aria-pressed', state.magnifyMode ? 'true' : 'false');
    var controls = $('magnifyControls');
    if (controls) controls.hidden = !state.magnifyMode;
    // While the mode is on, a finger drag moves the lens instead of
    // scrolling the page; off restores the stage's normal panning.
    var stage = $('stage');
    if (stage) stage.style.touchAction = state.magnifyMode ? 'none' : '';
    if (!state.magnifyMode) hideLens();
  }

  // Apply the visitor's saved zoom/size now: this must run after the
  // magnifier vars above are assigned (init runs top to bottom, and
  // the wiring further up executes before this section).
  loadMagnifierPrefs();

  /* The reader's sheet image opens fullscreen in the image lightbox.
   * Both the Zoom in button and a click (or Enter/Space) on the sheet
   * itself open it; the old in-page 220% stage zoom is gone. While
   * magnify mode is on, a tap on the sheet does not open it — the
   * sheet belongs to the lens until the mode is off. */
  function openReaderImage() {
    var img = $('setImg');
    var src = img && (img.getAttribute('src') || img.src);
    if (!src) return;
    openImageModal(src, $('setTitle').textContent || '', 'reader_image_modal');
  }

  function closeImageModal() {
    $('imageModal').hidden = true;
    // The lightbox can open from the cart drawer: leave the page
    // locked while the drawer is still open underneath.
    if (!$('cartDrawer').classList.contains('open')) document.body.classList.remove('modal-open');
    $('imageModalImg').removeAttribute('src');
  }

  /* ---------- per-sticker like / collect / share ---------- */
  /* The modal's actions reuse the set-level endpoints with the
   * sticker id (<set-slug>-NN): the seed stores one Sticker row per
   * individual sticker, so findSticker resolves it. Optimistic
   * updates + localStorage maps are shared with the set-level
   * toggles (set slugs and sticker ids never collide). */

  function renderStickerLike(count, liked) {
    var btn = $('stickerLikeBtn'), countEl = $('stickerLikeCount');
    if (!btn) return;
    btn.innerHTML = '<i class="fi fi-br-heart"></i> ' + (liked ? t('reader.liked') : t('reader.like'));
    btn.setAttribute('aria-pressed', String(liked));
    if (countEl) countEl.textContent = count > 0 ? (count === 1 ? t('reader.likes.one') : t('reader.likes.other').replace('{n}', count)) : t('reader.noLikes');
  }

  function loadStickerLike(id) {
    var likedMap = lsGet(LS_LIKED_KEY);
    renderStickerLike(lsGet(LS_LIKE_COUNTS_KEY)[id] || 0, Boolean(likedMap[id]));
    fetch('/api/stickers/' + encodeURIComponent(id) + '/like', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var counts = lsGet(LS_LIKE_COUNTS_KEY);
        counts[id] = d.likes || 0;
        lsSet(LS_LIKE_COUNTS_KEY, counts);
        renderStickerLike(d.likes || 0, d.liked || Boolean(likedMap[id]));
      })
      .catch(function () {
        renderStickerLike(lsGet(LS_LIKE_COUNTS_KEY)[id] || 0, Boolean(likedMap[id]));
      });
  }

  function toggleStickerLike() {
    var s = state.currentSticker;
    if (!s) return;
    if (!state.session) { location.hash = '#/login'; return; }
    var id = s.id;
    var likedMap = lsGet(LS_LIKED_KEY);
    var liked = !likedMap[id];
    var counts = lsGet(LS_LIKE_COUNTS_KEY);
    counts[id] = Math.max(0, (counts[id] || 0) + (liked ? 1 : -1));
    lsSet(LS_LIKE_COUNTS_KEY, counts);
    if (liked) likedMap[id] = true; else delete likedMap[id];
    lsSet(LS_LIKED_KEY, likedMap);
    renderStickerLike(counts[id], liked);
    fetch('/api/stickers/' + encodeURIComponent(id) + '/like', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) { location.hash = '#/login'; throw new Error('signed out'); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (d.liked) likedMap[id] = true; else delete likedMap[id];
        lsSet(LS_LIKED_KEY, likedMap);
        counts[id] = d.likes || 0;
        lsSet(LS_LIKE_COUNTS_KEY, counts);
        renderStickerLike(d.likes || 0, d.liked);
        gaEvent('sticker_like', { sticker: id, liked: d.liked });
      })
      .catch(function (e) {
        if (e.message === 'signed out') {
          var m = lsGet(LS_LIKED_KEY);
          if (liked) delete m[id]; else m[id] = true;
          lsSet(LS_LIKED_KEY, m);
          var c = lsGet(LS_LIKE_COUNTS_KEY);
          c[id] = Math.max(0, (c[id] || 0) + (liked ? -1 : 1));
          lsSet(LS_LIKE_COUNTS_KEY, c);
          renderStickerLike(c[id], !liked);
          return;
        }
        // Server unreachable: the optimistic state stays on-device.
      });
  }

  function renderStickerBookmark(bookmarked) {
    var btn = $('stickerBookmarkBtn');
    if (!btn) return;
    btn.innerHTML = '<i class="fi fi-br-bookmark"></i> ' + (bookmarked ? t('sticker.collected') : t('sticker.collect'));
    btn.setAttribute('aria-pressed', String(bookmarked));
    btn.setAttribute('data-bookmarked', String(bookmarked));
  }

  function loadStickerBookmark(id) {
    renderStickerBookmark(Boolean(lsGet(LS_BOOKMARKED_KEY)[id]));
    if (!state.session) return;
    fetch('/api/me/bookmarks?stickerId=' + encodeURIComponent(id), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { renderStickerBookmark(Boolean(d.bookmarked)); })
      .catch(function () { /* keep the cached state */ });
  }

  function toggleStickerBookmark() {
    var s = state.currentSticker;
    if (!s) return;
    if (!state.session) { location.hash = '#/login'; return; }
    var id = s.id;
    var btn = $('stickerBookmarkBtn');
    var bookmarked = btn && btn.getAttribute('data-bookmarked') === 'true';
    var method = bookmarked ? 'DELETE' : 'POST';
    var url = bookmarked
      ? '/api/me/bookmarks?stickerId=' + encodeURIComponent(id)
      : '/api/me/bookmarks';
    var options = { method: method, credentials: 'same-origin', cache: 'no-store' };
    if (!bookmarked) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify({ stickerId: id });
    }
    var map = lsGet(LS_BOOKMARKED_KEY);
    if (!bookmarked) map[id] = true; else delete map[id];
    lsSet(LS_BOOKMARKED_KEY, map);
    renderStickerBookmark(!bookmarked);
    lsSet(LS_BOOKMARKS_KEY, {}); // the saved list changed — drop its cache
    updateSavedBadges();
    fetch(url, options)
      .then(function (r) {
        if (r.status === 401) { location.hash = '#/login'; throw new Error('signed out'); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function () {
        renderStickerBookmark(!bookmarked);
        gaEvent('sticker_bookmark', { sticker: id, bookmarked: !bookmarked });
        prefetchBookmarks(); // the cache was dropped — re-cache the
        // post-toggle list so the map and badges converge on the truth
      })
      .catch(function (e) {
        var m = lsGet(LS_BOOKMARKED_KEY);
        if (bookmarked) m[id] = true; else delete m[id];
        lsSet(LS_BOOKMARKED_KEY, m);
        renderStickerBookmark(bookmarked);
        updateSavedBadges();
        if (e.message === 'signed out') return;
        var msg = $('stickerShareMsg');
        if (msg) { msg.textContent = t('sticker.saveError'); setTimeout(function () { msg.textContent = ''; }, 2500); }
      });
  }

  /* Shared state (same for the set page and the sticker modal): after a
   * successful share the button turns green and reads Shared for a few
   * seconds, then reverts to its original label. */
  function markShared(btn, originalHtml) {
    if (!btn || btn.classList.contains('shared')) return; // already showing Shared
    btn.classList.add('shared');
    btn.innerHTML = '<i class="fi fi-br-share"></i> ' + t('sticker.shared');
    setTimeout(function () {
      btn.classList.remove('shared');
      btn.innerHTML = originalHtml;
    }, 2500);
  }

  function shareSticker() {
    var s = state.currentSticker;
    if (!s) return;
    var rec = state.currentSlug ? findSet(state.currentSlug) : null;
    // Deep link: the recipient opens this exact sticker in the modal.
    var url = location.origin + '/#/set/' + state.currentSlug + '/sticker/' + s.n;
    var title = s.title + (rec ? ' — ' + rec.title : '');
    var text = (s.zh || s.ja || '') + ' — Sutekka';
    var msg = $('stickerShareMsg');
    function done(t) { if (msg) { msg.textContent = t; setTimeout(function () { msg.textContent = ''; }, 2500); } }
    gaEvent('sticker_share', { sticker: s.id });
    if (navigator.share) {
      // Prefer sharing the image itself (WhatsApp and friends accept
      // it); fall back to sharing the link when files are unsupported.
      fetch(s.file).then(function (r) { return r.blob(); }).then(function (blob) {
        var file = new File([blob], s.id + '.png', { type: blob.type || 'image/png' });
        if (navigator.canShare && !navigator.canShare({ files: [file] })) throw new Error('files unsupported');
        return navigator.share({ files: [file], title: title, text: text });
      }).then(function () { markShared($('stickerShareBtn'), '<i class="fi fi-br-share"></i> ' + t('reader.shareShort')); done(t('share.shared')); }).catch(function (e) {
        if (e && e.name === 'AbortError') return; // user dismissed the sheet
        var payload = { title: title, url: url };
        if (text) payload.text = text;
        navigator.share(payload).then(function () { markShared($('stickerShareBtn'), '<i class="fi fi-br-share"></i> ' + t('reader.shareShort')); done(t('share.shared')); }, function () { /* dismissed */ });
      });
      return;
    }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () { markShared($('stickerShareBtn'), '<i class="fi fi-br-share"></i> ' + t('reader.shareShort')); done(t('share.copied')); }, function () { done(url); });
      return;
    }
    done(url);
  }

  /* Share this set — used by the reader-tools button and by the mobile
   * bottom bar (same action, same green Shared state). */
  function shareSet(btn) {
    // Clean share URL, not the hash URL: crawlers never see the
    // fragment, so /share/<slug>/ is the page with the OG tags.
    var url = state.currentSlug
      ? location.origin + '/share/' + state.currentSlug + '/'
      : location.href;
    // Clickbait hook for this set (index.json share_title /
    // share_teaser, from web_app/data/share.json): the native
    // share sheet gets the hook as title + message text, so the
    // recipient sees the hook before the link preview loads.
    var rec = state.currentSlug ? findSet(state.currentSlug) : null;
    var title = (rec && rec.share_title) || $('setTitle').textContent;
    var text = (rec && rec.share_teaser) || '';
    var msg = $('shareMsg');
    var original = btn ? btn.innerHTML : '';
    gaEvent('share', { slug: state.currentSlug || '' });
    function done(t) { if (msg) { msg.textContent = t; setTimeout(function () { msg.textContent = ''; }, 2500); } }
    if (navigator.share) {
      var payload = { title: title, url: url };
      if (text) payload.text = text;
      navigator.share(payload).then(function () { if (btn) markShared(btn, original); done(t('share.shared')); }, function () { /* dismissed */ });
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () { if (btn) markShared(btn, original); done(t('share.copied')); }, function () { done(url); });
    } else {
      done(url);
    }
  }

  $('shareBtn').addEventListener('click', function () { shareSet(this); });
  $('mobileShareBtn').addEventListener('click', function () { shareSet(this); });
  $('mobileSaveBtn').addEventListener('click', toggleBookmark);
  $('buySetBtn').addEventListener('click', function () { openBuyLink('set', state.currentSlug); });
  $('stickerBuyBtn').addEventListener('click', function () { var s = state.currentSticker; if (s) openBuyLink('single', s.id); });
  $('packBuyBtn').addEventListener('click', function () { openBuyLink('pack', 'complete-pack-30'); });
  /* Stepper wiring: one listener per stepper container; the item it
   * refers to is resolved at click time (current set / sticker). */
  function wireStepper(elId, getItem) {
    var el = $(elId);
    if (!el) return;
    el.addEventListener('click', function (e) {
      var t = e.target;
      var btn = t.closest ? t.closest('[data-step]') : null;
      if (!btn) return;
      var ref = getItem();
      if (!ref) return;
      var q = cartQty(ref.itemId);
      setQty(ref.type, ref.itemId, btn.getAttribute('data-step') === 'inc' ? q + 1 : q - 1);
    });
  }
  wireStepper('cartSetStepper', function () { return state.currentSlug ? { type: 'set', itemId: state.currentSlug } : null; });
  wireStepper('stickerCartStepper', function () { var s = state.currentSticker; return s ? { type: 'single', itemId: s.id } : null; });
  wireStepper('packCartStepper', function () { return { type: 'pack', itemId: 'complete-pack-30' }; });
  // Cart page actions are delegated — renderCart rebuilds the body.
  $('cartBody').addEventListener('click', function (e) {
    var t = e.target;
    var imgBtn = t.closest ? t.closest('[data-cart-img]') : null;
    if (imgBtn) { openImageModal(imgBtn.getAttribute('data-cart-img'), imgBtn.getAttribute('data-cart-img-title')); return; }
    var remove = t.closest ? t.closest('[data-cart-remove]') : null;
    if (remove) {
      var rId = remove.getAttribute('data-cart-remove');
      var rIt = findCartItem(rId);
      var rEntry = rIt ? cartEntry(rIt.itemId, rIt.type) : null;
      openRemoveModal('line', rId, rEntry ? rEntry.title : rId);
      return;
    }
    var dec = t.closest ? t.closest('[data-qty-dec]') : null;
    if (dec) { var dId = dec.getAttribute('data-qty-dec'); var dIt = findCartItem(dId); if (dIt) setQty(dIt.type, dId, (dIt.qty || 1) - 1); return; }
    var inc = t.closest ? t.closest('[data-qty-inc]') : null;
    if (inc) { var iId = inc.getAttribute('data-qty-inc'); var iIt = findCartItem(iId); if (iIt) setQty(iIt.type, iId, (iIt.qty || 1) + 1); return; }
    var packAdd = t.closest ? t.closest('[data-pack-add]') : null;
    if (packAdd) {
      var pack = state.links && state.links.pack;
      if (pack) { setQty('pack', pack.item_id, 1); }
      return;
    }
    var restore = t.closest ? t.closest('[data-draft-restore]') : null;
    if (restore) { restoreDraft(parseInt(restore.getAttribute('data-draft-restore'), 10)); return; }
    var del = t.closest ? t.closest('[data-draft-delete]') : null;
    if (del) { deleteDraft(parseInt(del.getAttribute('data-draft-delete'), 10)); return; }
    if (t.id === 'clearCartBtn') { openRemoveModal('clear'); return; }
    if (t.id === 'emptyCartBrowse') { closeCartDrawer(); return; }
    if (t.id === 'checkoutBtn') { checkoutCart(); return; }
  });
  $('cartBody').addEventListener('submit', function (e) {
    if (e.target && e.target.id === 'draftForm') { e.preventDefault(); saveDraft(); }
  });

  // Character sheet preference: collapsed by default, remembered in
  // localStorage so the reader's choice sticks across visits.
  var CHAR_KEY = 'sticker-showcase-charsheet-v1';
  var csEl = $('charSheet');
  try { csEl.open = localStorage.getItem(CHAR_KEY) === '1'; } catch (e) { /* default collapsed */ }
  csEl.addEventListener('toggle', function () {
    try { localStorage.setItem(CHAR_KEY, csEl.open ? '1' : '0'); } catch (e) { /* ignore */ }
  });

  $('columnBtn').addEventListener('click', openColumnModal);
  $('columnModalClose').addEventListener('click', closeColumnModal);
  $('columnModalBackdrop').addEventListener('click', closeColumnModal);
  $('stickerModalClose').addEventListener('click', closeStickerModal);
  $('stickerModalBackdrop').addEventListener('click', closeStickerModal);
  $('imageModalClose').addEventListener('click', closeImageModal);
  $('imageModalBackdrop').addEventListener('click', closeImageModal);
  $('cartBtn').addEventListener('click', function () { openCartDrawer(false); });
  $('cartDrawerClose').addEventListener('click', closeCartDrawer);
  $('cartDrawerBackdrop').addEventListener('click', closeCartDrawer);
  $('removeModalKeep').addEventListener('click', function () {
    var k = pendingRemoval && pendingRemoval.kind;
    gaEvent(k === 'photo' ? 'photo_delete_kept' : k === 'photos-clear' || k === 'bookmarks' || k === 'collections' ? 'saved_clear_kept' : 'cart_remove_kept');
    closeRemoveModal();
  });
  $('removeModalConfirm').addEventListener('click', function () {
    var p = pendingRemoval;
    closeRemoveModal();
    if (!p) return;
    if (p.kind === 'clear') { gaEvent('cart_remove_confirmed'); clearCart(); }
    else if (p.kind === 'bookmarks') { gaEvent('saved_clear_confirmed'); clearSaved('sets'); }
    else if (p.kind === 'collections') { gaEvent('saved_clear_confirmed'); clearSaved('stickers'); }
    else if (p.kind === 'photo') { gaEvent('photo_delete_confirmed'); deletePhoto(p.photoId); }
    else if (p.kind === 'photos-clear') { gaEvent('gallery_clear_confirmed'); clearPhotos(); }
    else { gaEvent('cart_remove_confirmed'); removeFromCart(p.itemId); }
  });
  $('removeModalClose').addEventListener('click', closeRemoveModal);
  $('removeModalBackdrop').addEventListener('click', closeRemoveModal);
  $('stickerModalPrev').addEventListener('click', function () { stickerNav(-1); });
  $('stickerModalNext').addEventListener('click', function () { stickerNav(1); });
  $('stickerGrid').addEventListener('click', function (e) {
    var cell = e.target.closest ? e.target.closest('.sticker-cell') : null;
    if (cell) openStickerModal(cell.getAttribute('data-n'));
  });
  $('stickerGrid').addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('sticker-cell')) {
      e.preventDefault();
      openStickerModal(e.target.getAttribute('data-n'));
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      // One press closes the topmost layer only.
      if (!$('columnModal').hidden) closeColumnModal();
      else if (!$('stickerModal').hidden) closeStickerModal();
      else if (!$('imageModal').hidden) closeImageModal();
      else if (!$('removeModal').hidden) closeRemoveModal();
      else if ($('cartDrawer').classList.contains('open')) closeCartDrawer();
      else if (state.magnifyMode) setMagnifyMode(false);
      return;
    }
    if (!$('stickerModal').hidden && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return; // typing, not navigating
      e.preventDefault();
      stickerNav(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });

  document.addEventListener('click', function (e) {
    // Close the user menu when the tap lands outside it.
    var menu = e.target && e.target.closest ? e.target.closest('.user-menu') : null;
    if (!menu) document.querySelectorAll('details.user-menu[open]').forEach(function (d) { d.open = false; });
    // Magnify mode: a tap outside the sheet (and not on the Magnify
    // button or its controls) exits the mode. A tap on the sheet
    // neither opens the lightbox nor exits while the mode is on.
    if (state.magnifyMode) {
      var t2 = e.target;
      var inStage = t2 && t2.closest ? (t2.closest('#stage') || t2.closest('#magnifyBtn') || t2.closest('#magnifyControls')) : false;
      if (!inStage) setMagnifyMode(false);
    }
    // closest('button'): the buttons contain <i> icons, and a tap on the
    // icon itself has the icon as e.target, not the button.
    var btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (btn && btn.id === 'likeBtn') toggleLike();
    if (btn && btn.id === 'bookmarkBtn') toggleBookmark();
    if (btn && btn.id === 'stickerLikeBtn') toggleStickerLike();
    if (btn && btn.id === 'stickerBookmarkBtn') toggleStickerBookmark();
    if (btn && btn.id === 'stickerShareBtn') shareSticker();
    // Admin buttons live inside #adminBody and are re-rendered often,
    // so they are handled here by delegation, not by direct binding.
    var adminBtn = e.target && e.target.closest ? e.target.closest('[data-admin-act]') : null;
    if (adminBtn && $('adminBody') && $('adminBody').contains(adminBtn)) {
      var act = adminBtn.getAttribute('data-admin-act');
      if (act === 'logout') adminLogout();
      if (act === 'page-prev' && state.adminOrdersPage > 1) { state.adminOrdersPage -= 1; renderAdminOrders(); }
      if (act === 'page-next') { state.adminOrdersPage += 1; renderAdminOrders(); }
      if (act === 'print') {
        var orderId = adminBtn.getAttribute('data-admin-order');
        var value = adminBtn.getAttribute('data-admin-value');
        adminApi('orders/' + encodeURIComponent(orderId) + '/print', { method: 'POST', body: { printStatus: value } })
          .then(function () { route(); });
      }
      if (act === 'resolve') {
        var reqId = adminBtn.getAttribute('data-admin-id');
        var status = adminBtn.getAttribute('data-admin-value');
        adminApi('invoices/' + encodeURIComponent(reqId) + '/resolve', { method: 'POST', body: { status: status } })
          .then(function () { renderAdminInvoices(); });
      }
      if (act === 'revoke-sessions') {
        adminApi('sessions', { method: 'DELETE' }).then(function () { renderAdminSettings(); });
      }
    }
    if (e.target && e.target.id === 'replyCancel') setReplyTo(null);
    var sortBtn = e.target && e.target.closest ? e.target.closest('[data-sort]') : null;
    if (sortBtn && $('bookmarksBody') && $('bookmarksBody').contains(sortBtn)) {
      state.bookmarksSort = sortBtn.getAttribute('data-sort');
      renderBookmarks();
      return;
    }
    if (sortBtn && $('collectionsBody') && $('collectionsBody').contains(sortBtn)) {
      state.bookmarksSort = sortBtn.getAttribute('data-sort');
      renderCollections();
      return;
    }
    var clearBtn = e.target && e.target.closest ? e.target.closest('[data-clear-saved]') : null;
    if (clearBtn) { openRemoveModal(clearBtn.getAttribute('data-clear-saved')); return; }
    var photoView = e.target && e.target.closest ? e.target.closest('[data-photo-view]') : null;
    if (photoView) { openImageModal(photoView.getAttribute('data-photo-view'), photoView.getAttribute('data-photo-title')); return; }
    var photoDel = e.target && e.target.closest ? e.target.closest('[data-photo-del]') : null;
    if (photoDel) { openRemoveModal('photo', photoDel.getAttribute('data-photo-del')); return; }
    var clearPhotosBtn = e.target && e.target.closest ? e.target.closest('[data-clear-photos]') : null;
    if (clearPhotosBtn) { openRemoveModal('photos-clear'); return; }
    var actBtn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (actBtn && $('commentList') && $('commentList').contains(actBtn)) handleCommentAction(actBtn);
  });
  document.addEventListener('change', function (e) {
    // The gallery's file input is re-rendered with the gallery, so
    // it is handled here by delegation, not by direct binding.
    if (e.target && e.target.id === 'photoFile') uploadPhoto(e.target.files && e.target.files[0]);
  });
  document.addEventListener('submit', function (e) {
    if (e.target && e.target.id === 'commentForm') postComment(e);
    if (e.target && e.target.id === 'feedbackForm') postFeedback(e);
    if (e.target && e.target.id === 'profileForm') saveProfile(e);
    if (e.target && e.target.id === 'prefsForm') savePreferences(e);
    if (e.target && e.target.id === 'findOrderForm') findOrder(e);
    if (e.target && e.target.id === 'invoiceRequestForm') requestInvoice(e);
    if (e.target && e.target.id === 'shippingForm') submitShipping(e);
    if (e.target && e.target.id === 'adminSetupForm') adminSetup(e);
    if (e.target && e.target.id === 'adminLoginForm') adminLogin(e);
    if (e.target && e.target.id === 'adminOrdersFilterForm') adminFilterOrders(e);
    if (e.target && e.target.id === 'adminStatusForm') adminOrderStatus(e);
    if (e.target && e.target.id === 'adminNoteForm') adminOrderNote(e);
    if (e.target && e.target.id === 'adminShipForm') adminOrderShipping(e);
    if (e.target && e.target.id === 'adminInvoiceForm') adminOrderInvoice(e);
    if (e.target && e.target.id === 'adminSettingsForm') adminSaveSettings(e);
    if (e.target && e.target.id === 'adminPasswordForm') adminChangePassword(e);
  });

  document.addEventListener('keydown', function (e) {
    if (readerEl.hidden) return;
    // When a modal is open, the arrow keys belong to the modal (the
    // sticker lightbox), not to the set underneath — otherwise one
    // keypress moves both the modal and the page behind it.
    if (!$('stickerModal').hidden || !$('columnModal').hidden) return;
    if (e.key === 'ArrowLeft' && !$('prevLink').hasAttribute('aria-disabled')) location.hash = $('prevLink').getAttribute('href');
    if (e.key === 'ArrowRight' && !$('nextLink').hasAttribute('aria-disabled')) location.hash = $('nextLink').getAttribute('href');
  });

  window.addEventListener('hashchange', route);

  init();
})();
