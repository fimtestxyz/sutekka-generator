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

  var LS_KEY = 'sticker-showcase-index-v11';
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
  var DATA_V = 11;
  // LINKS_V: bump whenever data/payment-links.json changes — a new
  // product, a new price, or a new link. Same cache-busting idea as
  // DATA_V; the service worker caches the file under this ?v= too.
  var LINKS_V = 1;
  var PAGE_SIZE = 12;

  var state = {
    sets: [],
    series: [],
    batch: 'all',
    lang: 'all',
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
    cartDrafts: [] // [{ name, items, createdAt }] — named snapshots, localStorage
  };

  var $ = function (id) { return document.getElementById(id); };
  var homeEl = $('home'), readerEl = $('reader'), aboutEl = $('about'), loginEl = $('login'), profileEl = $('profile'), bookmarksEl = $('bookmarks'), collectionsEl = $('collections'), downloadEl = $('download'), adminEl = $('admin'), cartEl = $('cart');

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
        if (state.session) prefetchBookmarks();
        var hash = location.hash || '#/';
        if (hash === '#/login') renderLogin();
        if (hash === '#/profile') renderProfile();
        if (hash === '#/bookmarks') renderBookmarks();
        if (hash === '#/collections') renderCollections();
      })
      .catch(function () {
        state.authAvailable = false;
        renderAuthArea();
      });
  }

  function renderAuthArea() {
    var el = $('authArea');
    if (!el) return;
    var u = state.session;
    if (!u) { el.innerHTML = '<a href="#/login">Sign in</a>'; return; }
    // The user area is its own block, separate from the main nav: an
    // avatar button that opens a dropdown (Profile / Bookmarks /
    // Collections / Sign out) instead of three same-weight links.
    var avatar = u.image
      ? '<img src="' + esc(u.image) + '" alt="" class="auth-avatar">'
      : '<span class="auth-avatar auth-avatar-fallback" aria-hidden="true">' + esc((u.name || u.email || '?').charAt(0).toUpperCase()) + '</span>';
    el.innerHTML =
      '<details class="user-menu">' +
      '<summary>' + avatar + '<span class="auth-name">' + esc(u.name || u.email || 'Signed in') + '</span><i class="fi fi-br-angle-down"></i></summary>' +
      '<div class="user-menu-list">' +
      '<a href="#/profile">Profile</a>' +
      '<a href="#/bookmarks">Bookmarks</a>' +
      '<a href="#/collections">Collections</a>' +
      '<hr>' +
      '<a href="/api/auth/signout">Sign out</a>' +
      '</div></details>';
  }

  function renderLogin() {
    var body = $('loginBody');
    if (!body) return;
    var u = state.session;
    if (u) {
      body.innerHTML = '';
      var p = document.createElement('p');
      p.textContent = 'Signed in as ' + (u.name || u.email || '') + '.';
      body.appendChild(p);
      var out = document.createElement('a');
      out.href = '/api/auth/signout';
      out.className = 'btn';
      out.textContent = 'Sign out';
      body.appendChild(out);
      return;
    }
    if (state.authAvailable === null) {
      body.innerHTML = '<p>Checking sign-in…</p>';
      return;
    }
    if (state.authAvailable === false) {
      body.innerHTML = '<p>Sign-in is not set up yet — the site works fine without an account. Likes and comments save on this device only for now.</p>';
      return;
    }
    body.innerHTML = '<p>Sign in to like, comment and bookmark sticker sets. Browsing works without an account.</p>' +
      '<form id="googleSigninForm" method="POST" action="/api/auth/signin/google">' +
      '<input type="hidden" name="csrfToken" value="">' +
      '<input type="hidden" name="callbackUrl" value="/">' +
      '<button class="btn" type="submit" disabled>Continue with Google</button></form>' +
      '<p class="meta">Google is only used to identify you here — no posts, no contacts. Sign-in asks for your Google profile and email, nothing else.</p>';
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
      body.innerHTML = '<p>Sign in first to edit your profile.</p><p><a class="btn" href="#/login">Sign in</a></p>';
      return;
    }
    if (state.authAvailable === false) {
      body.innerHTML = '<p>Profile editing is not set up yet — the site works fine without an account.</p>';
      return;
    }
    body.innerHTML = '<p>Loading…</p>';
    Promise.all([
      profileFetch('/api/me/profile').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      profileFetch('/api/me/preferences').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    ]).then(function (res) {
      renderProfileForms(res[0], res[1]);
    }).catch(function () {
      body.innerHTML = '<p>Could not load your profile. Check your connection and reload.</p>';
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
      '<h2>Profile</h2>' +
      (avatar ? '<p><img class="profile-avatar" src="' + esc(avatar) + '" alt=""></p>' : '') +
      '<label class="field"><span>Name</span><input id="profileName" type="text" maxlength="100" value="' + esc(u.name || '') + '" autocomplete="nickname"></label>' +
      '<label class="field"><span>Bio (max 280 characters)</span><textarea id="profileBio" rows="3" maxlength="280">' + esc(p.bio || '') + '</textarea></label>' +
      '<label class="field"><span>Custom avatar URL (https:// — leave empty to use your Google photo)</span><input id="profileAvatar" type="text" inputmode="url" maxlength="2048" value="' + esc(p.customAvatar || '') + '" autocomplete="off"></label>' +
      '<button type="submit">Save profile</button>' +
      '<span id="profileMsg" class="comment-msg" aria-live="polite"></span>' +
      '</form>' +
      '<form id="prefsForm" class="comment-form" onsubmit="return false;">' +
      '<h2>Keyword preferences</h2>' +
      '<p class="meta">One keyword per line, optionally with =weight (0–2, default 1), e.g. <code>AI=1.5</code>. Stored on your account for future personalisation — the listing does not use them yet.</p>' +
      '<label class="field"><span>Keywords</span><textarea id="prefsKeywords" rows="5">' + esc(kwLines) + '</textarea></label>' +
      '<button type="submit">Save preferences</button>' +
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
    msg.textContent = 'Saving…';
    profileFetch('/api/me/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          msg.textContent = 'Could not save: ' + ((res.d.details && res.d.details.join('; ')) || res.d.error || 'error');
          return;
        }
        if (res.d.user) { state.session = res.d.user; renderAuthArea(); }
        msg.textContent = 'Saved.';
      })
      .catch(function () { msg.textContent = 'Could not save. Check your connection.'; });
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
        if (isNaN(weight) || weight < 0 || weight > 2) { errors.push('Bad weight: ' + t); return; }
      }
      if (!keyword || keyword.length > 40) { errors.push('Bad keyword: ' + t); return; }
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
    msg.textContent = 'Saving…';
    profileFetch('/api/me/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keywords: parsed.keywords }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          msg.textContent = 'Could not save: ' + ((res.d.details && res.d.details.join('; ')) || res.d.error || 'error');
          return;
        }
        msg.textContent = 'Saved.';
      })
      .catch(function () { msg.textContent = 'Could not save. Check your connection.'; });
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
    btn.innerHTML = '<i class="fi fi-br-heart"></i> ' + (liked ? 'Liked' : 'Like');
    btn.setAttribute('aria-pressed', String(liked));
    countEl.textContent = count > 0 ? count + (count === 1 ? ' like' : ' likes') : 'No likes yet';
    note.textContent = localOnly ? 'Saved on this device only.' : '';
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
      '<strong>' + esc(c.user.name || 'Anonymous') + '</strong>' +
      (when ? ' <span class="c-time">' + esc(when) + '</span>' : '') + '</p>' +
      '<p class="c-text">' + esc(c.content || '') + '</p>' +
      '<p class="c-actions">' +
      (state.session ? '<button type="button" data-act="reply">Reply</button>' : '') +
      (mine ? ' <button type="button" data-act="edit">Edit</button> <button type="button" data-act="delete">Delete</button>' : '') +
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
    if (msg) msg.textContent = 'Loading comments…';
    fetch('/api/stickers/' + encodeURIComponent(slug) + '/comments', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        state.engageReady = true;
        var comments = d.comments || [];
        list.innerHTML = comments.length ? comments.map(function (c) { return commentHtml(c); }).join('') :
          '<p class="empty"><img class="empty-icon" src="icons/chat.png" alt="" width="512" height="512">No comments yet. Be the first.</p>';
        if (msg) msg.textContent = '';
      })
      .catch(function () {
        state.engageReady = false;
        list.innerHTML = '';
        if (msg) {
          msg.textContent = 'Comments are still being set up. Check back soon.';
        }
      });
  }

  function setReplyTo(threadId, name) {
    state.replyTo = threadId;
    var hint = $('replyHint');
    if (!hint) return;
    if (!threadId) { hint.hidden = true; hint.innerHTML = ''; return; }
    hint.hidden = false;
    hint.innerHTML = 'Replying to ' + esc(name || 'this thread') + ' <button type="button" id="replyCancel">Cancel</button>';
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
        if (res.status === 429) { if (msg) msg.textContent = 'Slow down — too many comments too fast.'; return; }
        if ((res.status !== 200 && res.status !== 201) || !res.d.comment) {
          if (msg) msg.textContent = 'Could not post the comment. ' + ((res.d.details && res.d.details.join('; ')) || 'Try again.');
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
        if (msg) msg.textContent = 'Comment posted.';
        gaEvent('comment_post', { slug: slug });
      })
      .catch(function () { if (msg) msg.textContent = 'Could not post the comment. Try again.'; });
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
      if (!window.confirm('Delete this comment? Replies to it are deleted too.')) return;
      fetch('/api/comments/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function () { article.remove(); })
        .catch(function () { var msg = $('commentMsg'); if (msg) msg.textContent = 'Could not delete the comment.'; });
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
    wrap.innerHTML = '<textarea rows="3" maxlength="1000"></textarea> <button type="button" data-edit="save">Save</button> <button type="button" data-edit="cancel">Cancel</button>';
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
            if (msg) msg.textContent = 'Could not save the edit.';
            return;
          }
          textEl.textContent = res.d.comment.content;
          wrap.remove();
          textEl.hidden = false;
        })
        .catch(function () {
          var msg = $('commentMsg');
          if (msg) msg.textContent = 'Could not save the edit.';
        });
    });
  }

  /* ---------- bookmarks ---------- */

  function renderBookmarkBtn(bookmarked) {
    var btn = $('bookmarkBtn');
    if (btn) {
      btn.innerHTML = '<i class="fi fi-br-bookmark"></i> ' + (bookmarked ? 'Saved' : 'Bookmark');
      btn.setAttribute('aria-pressed', String(bookmarked));
      btn.setAttribute('data-bookmarked', String(bookmarked));
    }
    // The mobile bottom bar's Save button mirrors the same state.
    var m = $('mobileSaveBtn');
    if (m) {
      m.innerHTML = '<i class="fi fi-br-bookmark"></i> ' + (bookmarked ? 'Saved' : 'Save');
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
    fetch(url, options)
      .then(function (r) {
        if (r.status === 401) { location.hash = '#/login'; throw new Error('signed out'); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function () {
        renderBookmarkBtn(!bookmarked);
        gaEvent('bookmark', { slug: slug, bookmarked: !bookmarked });
      })
      .catch(function (e) {
        // Undo the optimistic update, then report the failure.
        var m = lsGet(LS_BOOKMARKED_KEY);
        if (bookmarked) m[slug] = true; else delete m[slug];
        lsSet(LS_BOOKMARKED_KEY, m);
        renderBookmarkBtn(bookmarked);
        if (e.message === 'signed out') return;
        var msg = $('shareMsg');
        if (msg) { msg.textContent = 'Could not save the bookmark.'; setTimeout(function () { msg.textContent = ''; }, 2500); }
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
      })
      .catch(function () { /* best effort only */ });
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
    var labels = { recent: 'Recent', oldest: 'Oldest', title: 'Title A–Z' };
    var sortHtml = '<div class="sort-row" role="group" aria-label="Sort bookmarks">' +
      Object.keys(labels).map(function (s) {
        return '<button type="button" data-sort="' + s + '"' +
          (state.bookmarksSort === s ? ' class="active"' : '') + '>' + labels[s] + '</button>';
      }).join('') + '</div>';
    // Bookmarks = whole sets only; collected stickers live in Collections.
    var cards = (items || []).filter(function (b) { return !isStickerBookmark(b); }).map(bookmarkCardHtml).join('');
    body.innerHTML = sortHtml +
      (cards
        ? '<div class="grid">' + cards + '</div>'
        : '<p class="empty"><img class="empty-icon" src="icons/education.png" alt="" width="512" height="512">No bookmarks yet. Open a set and tap <i class="fi fi-br-bookmark"></i> Bookmark to save it here.</p>');
  }

  function renderCollectionsList(items) {
    var body = $('collectionsBody');
    if (!body) return;
    var labels = { recent: 'Recent', oldest: 'Oldest', title: 'Title A–Z' };
    var sortHtml = '<div class="sort-row" role="group" aria-label="Sort collection">' +
      Object.keys(labels).map(function (s) {
        return '<button type="button" data-sort="' + s + '"' +
          (state.bookmarksSort === s ? ' class="active"' : '') + '>' + labels[s] + '</button>';
      }).join('') + '</div>';
    var cards = (items || []).filter(isStickerBookmark).map(bookmarkCardHtml).join('');
    body.innerHTML = sortHtml +
      (cards
        ? '<div class="grid">' + cards + '</div>'
        : '<p class="empty"><img class="empty-icon" src="icons/education.png" alt="" width="512" height="512">No stickers collected yet. Open a sticker and tap <i class="fi fi-br-bookmark"></i> Collect to save it here.</p>');
  }

  function renderBookmarks() {
    var body = $('bookmarksBody');
    if (!body) return;
    if (!state.session) {
      body.innerHTML = '<p>Sign in first to see your bookmarks.</p><p><a class="btn" href="#/login">Sign in</a></p>';
      return;
    }
    if (state.authAvailable === false) {
      body.innerHTML = '<p>Bookmarks are not set up yet — the site works fine without an account.</p>';
      return;
    }
    // Cache-first: show the last list instantly, refresh in the background.
    var cached = lsGet(LS_BOOKMARKS_KEY);
    var shownFromCache = false;
    if (cached && cached.sort === state.bookmarksSort && cached.bookmarks) {
      renderBookmarksList(cached.bookmarks);
      shownFromCache = true;
    } else {
      body.innerHTML = '<p>Loading…</p>';
    }
    fetch('/api/me/bookmarks?sort=' + encodeURIComponent(state.bookmarksSort), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var items = d.bookmarks || [];
        lsSet(LS_BOOKMARKS_KEY, { sort: state.bookmarksSort, savedAt: Date.now(), bookmarks: items });
        renderBookmarksList(items);
      })
      .catch(function () {
        if (!shownFromCache) {
          body.innerHTML = '<p>Could not load your bookmarks. Check your connection and reload.</p>';
        }
      });
  }

  function renderCollections() {
    var body = $('collectionsBody');
    if (!body) return;
    if (!state.session) {
      body.innerHTML = '<p>Sign in first to see your collection.</p><p><a class="btn" href="#/login">Sign in</a></p>';
      return;
    }
    if (state.authAvailable === false) {
      body.innerHTML = '<p>Collections are not set up yet — the site works fine without an account.</p>';
      return;
    }
    // Same cache as Bookmarks (one list, two views); refresh in the
    // background.
    var cached = lsGet(LS_BOOKMARKS_KEY);
    var shownFromCache = false;
    if (cached && cached.sort === state.bookmarksSort && cached.bookmarks) {
      renderCollectionsList(cached.bookmarks);
      shownFromCache = true;
    } else {
      body.innerHTML = '<p>Loading…</p>';
    }
    fetch('/api/me/bookmarks?sort=' + encodeURIComponent(state.bookmarksSort), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var items = d.bookmarks || [];
        lsSet(LS_BOOKMARKS_KEY, { sort: state.bookmarksSort, savedAt: Date.now(), bookmarks: items });
        renderCollectionsList(items);
      })
      .catch(function () {
        if (!shownFromCache) {
          body.innerHTML = '<p>Could not load your collection. Check your connection and reload.</p>';
        }
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
          if (msg) msg.innerHTML = '<img class="empty-icon" src="icons/party.png" alt="" width="512" height="512">Thanks — feedback received.';
          gaEvent('feedback', {});
        } else if (res.status === 429) {
          if (msg) msg.textContent = 'Slow down — too many messages too fast.';
        } else if (msg) {
          msg.textContent = 'Feedback is still being set up. Check back soon.';
        }
      })
      .catch(function () { if (msg) msg.textContent = 'Could not send feedback. Try again.'; });
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
        $('grid').innerHTML = '<p class="empty">Could not load the sticker sets list. Check your connection and reload.</p>';
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
    return b ? b.title : 'Series ' + id;
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
      '<img src="' + c.thumb + '" alt="' + esc(c.title + ' — 贴纸合集') + '" loading="lazy" decoding="async" style="aspect-ratio:' + c.ratio + '">' +
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
      list.length + (list.length === 1 ? ' set' : ' sets') +
      (state.batch !== 'all' ? ' · ' + seriesTitle(state.batch) : '') +
      (state.topic ? ' · #' + state.topic : '');
    $('loadMore').hidden = list.length <= state.shown;
  }

  function renderChips() {
    var html = '<button data-batch="all"' + (state.batch === 'all' ? ' class="active"' : '') + '>All</button>';
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
    return '<figure class="sticker-cell tappable" tabindex="0" role="button" data-n="' + esc(s.n) + '" aria-label="' + esc(s.title) + ' — 点开看这张贴纸的脚本">' +
      '<img src="' + s.file + '" alt="' + esc(stickerAlt(s)) + '" loading="lazy" decoding="async">' +
      '<span class="tap-badge"><i class="fi fi-br-cursor-finger"></i> 点我</span>' +
      '<figcaption><span class="sticker-ja">' + esc(s.ja) + '</span>' +
      '<span class="sticker-zh">' + esc(s.zh) + '</span></figcaption></figure>';
  }

  function openSet(slug) {
    var c = findSet(slug);
    if (!c) {
      readerEl.innerHTML = '<p class="empty">That sticker set does not exist yet. <a href="#/">Back to all sets</a>.</p>';
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
    img.alt = c.title + ' — 贴纸合集，共 ' + (c.stickers || []).length + ' 张';
    $('stage').classList.remove('zoomed');
    var zoomBtn = $('zoomBtn');
    zoomBtn.innerHTML = '<i class="fi fi-br-zoom-in"></i> Zoom in';
    zoomBtn.setAttribute('aria-pressed', 'false');
    $('stickerGrid').innerHTML = (c.stickers || []).map(stickerCellHtml).join('');
    // Character sheet: collapsed by default; the reader's open/close
    // preference is remembered in localStorage (see init wiring).
    var cs = $('charSheet');
    if (c.character_sheet) {
      cs.hidden = false;
      $('charSheetImg').src = c.character_sheet;
      $('charSheetImg').alt = c.cast ? '角色介绍：' + c.cast : 'Character sheet';
      $('charSheetCast').textContent = c.cast || '';
    } else {
      cs.hidden = true;
    }
    $('behindAngle').textContent = c.angle || '';
    $('behindFacts').textContent = c.tags.length ? 'Topics: ' + c.tags.join(', ') : '';
    $('behindQa').textContent = 'QA score ' + c.qa + '/10 — the minimum to publish is 7.';

    var batchList = state.sets.filter(function (x) { return x.batch === c.batch; });
    var i = batchList.findIndex(function (x) { return x.slug === slug; });
    var prev = batchList[i - 1], next = batchList[i + 1];
    var prevLink = $('prevLink'), nextLink = $('nextLink');
    if (prev) { prevLink.href = '#/set/' + prev.slug; prevLink.removeAttribute('aria-disabled'); prevLink.textContent = '← ' + prev.title; }
    else { prevLink.href = '#'; prevLink.setAttribute('aria-disabled', 'true'); prevLink.textContent = '← Previous'; }
    if (next) { nextLink.href = '#/set/' + next.slug; nextLink.removeAttribute('aria-disabled'); nextLink.textContent = next.title + ' →'; }
    else { nextLink.href = '#'; nextLink.setAttribute('aria-disabled', 'true'); nextLink.textContent = 'Next →'; }

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
    downloadEl.hidden = name !== 'download';
    adminEl.hidden = name !== 'admin';
    cartEl.hidden = name !== 'cart';
    // Active nav state: the reader lives under Latest.
    var nav = { home: 'home', reader: 'home', bookmarks: 'bookmarks', collections: 'collections', about: 'about', cart: 'cart' }[name] || null;
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
    if (parts[0] === 'cart') { renderCart(); showView('cart'); window.scrollTo(0, 0); return; }
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
        if (state.currentSticker) renderStickerBuyBtn();
      })
      .catch(function () { /* settings unavailable — the shop stays open */ });
  }

  function shopClosed() { return !!(state.siteSettings && state.siteSettings.shopClosed); }
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
    if (shopClosed() || itemHidden(itemId)) return;
    gaEvent('buy_click', { type: type, item: itemId });
    location.href = url;
  }

  function renderBuyButtons() {
    var btn = $('buySetBtn');
    if (!btn) return;
    var entry = state.links && state.currentSlug ? state.links.sets[state.currentSlug] : null;
    if (!entry || shopClosed() || itemHidden(state.currentSlug)) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.innerHTML = '<i class="fi fi-br-credit-card"></i> Buy this set — ' + priceLabel(entry.amount);
  }

  function renderStickerBuyBtn() {
    var btn = $('stickerBuyBtn');
    var s = state.currentSticker;
    if (!btn || !s) return;
    var entry = state.links ? state.links.singles[s.id] : null;
    if (!entry || shopClosed() || itemHidden(s.id)) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.innerHTML = '<i class="fi fi-br-credit-card"></i> Buy — ' + priceLabel(entry.amount);
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
      return counts[slug] + ' from ' + (PACK_SET_NAMES[slug] || slug);
    });
    $('packCardText').textContent = pack.stickers.length + ' stickers — ' + parts.join(' · ') + '.';
    var btn = $('packBuyBtn');
    btn.innerHTML = '<i class="fi fi-br-credit-card"></i> Buy the pack — ' + priceLabel(pack.amount);
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

  function loadCart() {
    try {
      var raw = localStorage.getItem(CART_KEY);
      var items = raw ? JSON.parse(raw) : [];
      state.cart = Array.isArray(items) ? items.filter(function (it) {
        return it && typeof it.itemId === 'string' && (it.type === 'single' || it.type === 'set' || it.type === 'pack');
      }) : [];
    } catch (e) { state.cart = []; }
    try {
      var draw = localStorage.getItem(CART_DRAFTS_KEY);
      var drafts = draw ? JSON.parse(draw) : [];
      state.cartDrafts = Array.isArray(drafts) ? drafts : [];
    } catch (e) { state.cartDrafts = []; }
    updateCartBadge();
  }

  function saveCart() {
    try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch (e) { /* private mode */ }
    updateCartBadge();
  }

  function saveDrafts() {
    try { localStorage.setItem(CART_DRAFTS_KEY, JSON.stringify(state.cartDrafts)); } catch (e) { /* private mode */ }
  }

  function updateCartBadge() {
    var badge = $('cartCount');
    if (!badge) return;
    var n = state.cart.length;
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
    return type === 'single' ? 'Single sticker' : type === 'set' ? 'Full set' : 'Complete pack';
  }

  function isInCart(itemId) {
    return state.cart.some(function (it) { return it.itemId === itemId; });
  }

  function cartTotal(items) {
    var list = items || state.cart;
    return list.reduce(function (sum, it) {
      var entry = cartEntry(it.itemId, it.type);
      return sum + (entry ? entry.amount : 0);
    }, 0);
  }

  function toggleCart(type, itemId) {
    if (shopClosed() || itemHidden(itemId)) return;
    if (isInCart(itemId)) {
      state.cart = state.cart.filter(function (it) { return it.itemId !== itemId; });
    } else {
      if (!cartEntry(itemId, type)) return;
      state.cart.push({ itemId: itemId, type: type });
    }
    saveCart();
    renderCartButtons();
    gaEvent('cart_toggle', { type: type, item: itemId, in_cart: isInCart(itemId) });
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

  function cartButtonLabel(btn, itemId) {
    btn.innerHTML = isInCart(itemId)
      ? '<i class="fi fi-br-shopping-cart"></i> In cart ✓'
      : '<i class="fi fi-br-shopping-cart"></i> Add to cart';
  }

  function renderCartButtons() {
    var setBtn = $('cartSetBtn');
    if (setBtn) {
      var setEntry = state.links && state.currentSlug ? state.links.sets[state.currentSlug] : null;
      if (!setEntry || shopClosed() || itemHidden(state.currentSlug)) setBtn.hidden = true;
      else { setBtn.hidden = false; cartButtonLabel(setBtn, state.currentSlug); }
    }
    var stBtn = $('stickerCartBtn');
    var s = state.currentSticker;
    if (stBtn) {
      var stEntry = state.links && s ? state.links.singles[s.id] : null;
      if (!stEntry || !s || shopClosed() || itemHidden(s.id)) stBtn.hidden = true;
      else { stBtn.hidden = false; cartButtonLabel(stBtn, s.id); }
    }
    var packBtn = $('packCartBtn');
    if (packBtn) {
      if (!state.links || !state.links.pack || shopClosed() || itemHidden('complete-pack-30')) packBtn.hidden = true;
      else { packBtn.hidden = false; cartButtonLabel(packBtn, 'complete-pack-30'); }
    }
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
      return '<div class="order-card"><p><strong>Complete pack in your cart ✓</strong></p>' +
        '<p class="meta">All ' + pack.stickers.length + ' stickers — the whole collection in one payment.</p>' + bar + '</div>';
    }
    var singles = state.links.singles || {};
    var keys = Object.keys(singles);
    var singleAmt = keys.length ? singles[keys[0]].amount : 400;
    var saving = pack.stickers.length * singleAmt - pack.amount;
    var addBtn = '<button data-pack-add="1">Add the pack — ' + priceLabel(pack.amount) + '</button>';
    if (total >= pack.amount) {
      return '<div class="order-card"><p><strong>Your cart is already worth ' + priceLabel(total) + '.</strong></p>' +
        '<p class="meta">The complete ' + pack.stickers.length + '-sticker pack is ' + priceLabel(pack.amount) + ' — every sticker, one payment, save ' + priceLabel(saving) + ' vs buying singles.</p>' + bar + '<p>' + addBtn + '</p></div>';
    }
    return '<div class="order-card"><p><strong>' + priceLabel(pack.amount - total) + ' away from the complete pack</strong></p>' +
      '<p class="meta">The ' + pack.stickers.length + '-sticker pack is ' + priceLabel(pack.amount) + ' — save ' + priceLabel(saving) + ' vs buying singles one by one.</p>' + bar + '<p>' + addBtn + '</p></div>';
  }

  function renderCart() {
    var body = $('cartBody');
    if (!body) return;
    var items = state.cart;
    var html = '';
    if (!items.length) {
      html += '<p>Your cart is empty. Add a sticker, a set, or the complete pack — the buttons sit next to every Buy button.</p>';
    } else {
      html += '<ul class="cart-list">' + items.map(function (it) {
        var entry = cartEntry(it.itemId, it.type);
        var title = entry ? entry.title : it.itemId;
        return '<li><div><strong>' + esc(title) + '</strong><br><span class="meta">' + cartItemLabel(it.type) + '</span></div>' +
          '<div class="cart-line"><span>' + (entry ? priceLabel(entry.amount) : '') + '</span> ' +
          '<button data-cart-remove="' + esc(it.itemId) + '">Remove</button></div></li>';
      }).join('') + '</ul>' +
      '<p><strong>Subtotal: ' + priceLabel(cartTotal()) + ' SGD</strong></p>' +
      packProgressHtml() +
      '<p class="meta">One payment on Stripe — card, PayNow or Link. The files land on your download page right after payment.</p>' +
      refundLineHtml() +
      '<p><button id="checkoutBtn">Checkout — ' + priceLabel(cartTotal()) + '</button> ' +
      '<button id="clearCartBtn">Clear cart</button></p>' +
      '<p id="checkoutMsg" class="comment-msg" aria-live="polite"></p>' +
      '<div class="order-card"><p><strong>Save this cart as a draft</strong></p>' +
      '<p class="meta">Come back later and restore it — on this device.</p>' +
      '<form id="draftForm" class="comment-form" onsubmit="return false;">' +
      '<input id="draftName" type="text" placeholder="Draft name (e.g. for mum)" maxlength="60" aria-label="Draft name">' +
      '<button type="submit">Save draft</button></form></div>';
    }
    var drafts = state.cartDrafts;
    if (drafts.length) {
      html += '<h2>Saved drafts</h2><ul class="cart-list">' + drafts.map(function (d, i) {
        return '<li><div><strong>' + esc(d.name || 'Untitled draft') + '</strong><br><span class="meta">' + d.items.length + (d.items.length === 1 ? ' item' : ' items') + ' · ' + priceLabel(cartTotal(d.items)) + ' · ' + esc(new Date(d.createdAt).toLocaleDateString()) + '</span></div>' +
          '<div class="cart-line"><button data-draft-restore="' + i + '">Restore</button> ' +
          '<button data-draft-delete="' + i + '">Delete</button></div></li>';
      }).join('') + '</ul>';
    }
    body.innerHTML = html;
  }

  function saveDraft() {
    var input = $('draftName');
    var name = input ? (input.value || '').trim() : '';
    if (!state.cart.length) return;
    state.cartDrafts.push({ name: name || 'Untitled draft', items: state.cart.slice(), createdAt: new Date().toISOString() });
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
    if (msg) msg.textContent = 'Creating your checkout…';
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
          msg.textContent = 'Checkout is not connected yet — the shop owner is adding the payment key. Your cart is saved; come back a little later.';
        } else if (x.status === 400 && x.d.error === 'unknown_item') {
          msg.textContent = 'One item in your cart is no longer sold — remove it and try again.';
        } else if (x.status === 429) {
          msg.textContent = 'Too many tries — wait a minute and try again.';
        } else {
          msg.textContent = 'Checkout could not start right now. Try again in a moment.';
        }
      })
      .catch(function () {
        if (btn) btn.disabled = false;
        if (msg) msg.textContent = 'Checkout could not start right now. Try again in a moment.';
      });
  }

  function findStickerRecord(id) {
    var found = null;
    (state.sets || []).forEach(function (rec) {
      (rec.stickers || []).forEach(function (s) {
        if (s.id === id) found = { file: s.file, title: s.title, setSlug: rec.slug };
      });
    });
    return found;
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
      body.innerHTML = '<p class="meta">Paid for a sticker already? Your download link is on the page Stripe sent you to after checkout. If you lost it, look it up below.</p>';
      return;
    }
    if (email && !orderId && !sessionId) {
      body.innerHTML = '<p>Looking up orders for ' + esc(email) + '…</p>';
      fetch('/api/orders/lookup?email=' + encodeURIComponent(email), { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          if (token !== downloadToken) return;
          var orders = d.orders || [];
          if (!orders.length) {
            body.innerHTML = '<p>No orders found for that email. Check the spelling, or use the order id instead.</p>';
            return;
          }
          body.innerHTML = '<p>' + orders.length + (orders.length === 1 ? ' order' : ' orders') + ' found:</p>' +
            orders.map(function (o) {
              return '<p class="order-card"><a href="#/download?order_id=' + encodeURIComponent(o.id) + '">' + esc(orderTitle(o)) + '</a> · ' +
                priceLabel(o.amountTotal) + ' · ' + esc(o.status) + ' · ' + esc(o.id) + '</p>';
            }).join('');
        })
        .catch(function () {
          if (token !== downloadToken) return;
          body.innerHTML = '<p>Could not look that up right now. Try again in a moment.</p>';
        });
      return;
    }
    // session_id or order_id: one order. The webhook may lag the
    // redirect by a second or two, so a 404 is retried briefly.
    var url = sessionId
      ? '/api/orders/lookup?session_id=' + encodeURIComponent(sessionId)
      : '/api/orders/lookup?order_id=' + encodeURIComponent(orderId);
    var attempts = 0;
    body.innerHTML = '<p>Confirming your payment…</p>';
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
            ? '<p>No order matches that link yet. If you just paid, give it a few seconds and reload — or look the order up below by email or order id.</p>'
            : '<p>Could not load that order right now. Try again in a moment.</p>';
        });
    })();
  }

  /* A cart payment owns one Order row per item (CART.md). One item
   * renders exactly like a single purchase; several items render one
   * card each, with their own files. The invoice/shipping forms live
   * on each item's own order page, linked from its card. */
  function renderOrdersDownload(orders, sessionId) {
    var body = $('downloadBody');
    var list = (orders || []).filter(Boolean);
    if (!list.length) {
      body.innerHTML = '<p>No order found.</p>';
      return;
    }
    if (list.length === 1) {
      renderOrderDownload(list[0], sessionId);
      return;
    }
    if (!state.sets.length) {
      body.innerHTML = '<p>Payment confirmed — loading your files…</p>';
      setTimeout(function () { renderOrdersDownload(list, sessionId); }, 500);
      return;
    }
    var total = list.reduce(function (s, o) { return s + (o.amountTotal || 0); }, 0);
    var html = '<p><strong>' + list.length + ' items · ' + priceLabel(total) + ' · paid in one payment.</strong></p>';
    list.forEach(function (order) {
      var ids = orderFileIds(order);
      var files = ids.map(findStickerRecord).filter(Boolean);
      html += '<div class="order-card"><p><strong>' + esc(orderTitle(order)) + '</strong></p>' +
        '<p class="meta">' + priceLabel(order.amountTotal) + ' · ' + esc(order.currency.toUpperCase()) +
        ' · Order ' + esc(order.id) + ' · ' + esc(order.status) + '</p>';
      if (files.length) {
        html += '<ul class="download-list">' + files.map(function (f) {
          return '<li><a href="' + esc(f.file) + '" download>' + esc(f.title) + ' — Download PNG</a></li>';
        }).join('') + '</ul>';
      }
      html += '<p class="meta"><a href="#/download?order_id=' + encodeURIComponent(order.id) + '">Order page</a> — invoice requests and print shipping for this item live there.</p></div>';
    });
    html += '<p class="meta">The files are yours to keep. A copy of the link was also sent to your email.</p>';
    html += refundLineHtml();
    body.innerHTML = html;
    if (sessionId && list.some(function (o) { return o.status === 'paid'; })) markDelivered(sessionId);
  }

  function renderOrderDownload(order, sessionId) {
    var body = $('downloadBody');
    if (!order) {
      body.innerHTML = '<p>No order found.</p>';
      return;
    }
    // The file list needs the index data; it may still be loading on a
    // direct landing, so wait for it briefly instead of showing nothing.
    if (!state.sets.length) {
      body.innerHTML = '<p>Payment confirmed — loading your files…</p>';
      setTimeout(function () { renderOrderDownload(order, sessionId); }, 500);
      return;
    }
    var ids = orderFileIds(order);
    var files = ids.map(findStickerRecord).filter(Boolean);
    var html = '<div class="order-card"><p><strong>' + esc(orderTitle(order)) + '</strong></p>' +
      '<p class="meta">' + priceLabel(order.amountTotal) + ' · ' + esc(order.currency.toUpperCase()) +
      ' · Order ' + esc(order.id) + ' · ' + esc(order.status) + '</p></div>';
    if (!files.length) {
      html += '<p>We have your payment but could not match it to a sticker file. Write in via the feedback form on the About page with order id ' + esc(order.id) + ' and it will be sorted out.</p>';
    } else {
      html += '<p>' + (files.length === 1 ? 'Your sticker:' : 'Your stickers:') + '</p><ul class="download-list">' +
        files.map(function (f) {
          return '<li><a href="' + esc(f.file) + '" download>' + esc(f.title) + ' — Download PNG</a></li>';
        }).join('') + '</ul>' +
        '<p class="meta">The files are yours to keep. A copy of the link was also sent to your email.</p>' +
        refundLineHtml();
    }
    // Fulfilment: print status + tracking, formal invoice, print
    // shipping address. The buyer proves the order with the email
    // they used at checkout (the page never shows it back).
    if (order.printStatus && order.printStatus !== 'none') {
      html += '<p><strong>Print:</strong> ' + esc(order.printStatus) + '</p>';
      if (order.trackingNumber) {
        html += '<p class="meta">Tracking: ' + esc((order.trackingCourier || '') + ' ' + order.trackingNumber) + '</p>';
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
      html += '<p class="meta">Shipping address on file — this order is in the print queue.</p>';
    } else {
      html += '<div class="order-card"><p><strong>Want this printed?</strong> Add your shipping address and the order joins the print queue.</p>' +
        '<form id="shippingForm" class="comment-form" onsubmit="return false;">' +
        '<input id="shipEmail" type="email" placeholder="Email used at checkout" required aria-label="Email used at checkout">' +
        '<input id="shipName" type="text" placeholder="Full name" required aria-label="Full name">' +
        '<input id="shipLine1" type="text" placeholder="Street address" required aria-label="Street address">' +
        '<input id="shipLine2" type="text" placeholder="Apt / unit (optional)" aria-label="Apt or unit">' +
        '<input id="shipCity" type="text" placeholder="City" required aria-label="City">' +
        '<input id="shipPostal" type="text" placeholder="Postal code" required aria-label="Postal code">' +
        '<input id="shipCountry" type="text" placeholder="Country" value="Singapore" required aria-label="Country">' +
        '<button type="submit">Add shipping address</button> <span id="shipMsg" class="comment-msg" aria-live="polite"></span></form></div>';
    }
    state.downloadOrder = order;
    state.downloadSessionId = sessionId || null;
    body.innerHTML = html;
    if (sessionId && order.status === 'paid') markDelivered(sessionId);
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
          msg.textContent = 'Added — your order is in the print queue.';
          if (state.downloadOrder) { state.downloadOrder.hasShippingAddress = true; state.downloadOrder.printStatus = 'queued'; }
        }
        else if (x.status === 403) msg.textContent = 'That email does not match this order.';
        else msg.textContent = 'Could not save that address right now.';
      })
      .catch(function () { if (msg) msg.textContent = 'Could not save that address right now.'; });
  }

  function findOrder(e) {
    e.preventDefault();
    var email = ($('findOrderEmail').value || '').trim();
    var id = ($('findOrderId').value || '').trim();
    var msg = $('findOrderMsg');
    if (id) { location.hash = '#/download?order_id=' + encodeURIComponent(id); return; }
    if (email) { location.hash = '#/download?email=' + encodeURIComponent(email); return; }
    if (msg) {
      msg.textContent = 'Enter an email or an order id.';
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
      hiddenItems: hidden
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

  $('zoomBtn').addEventListener('click', function () {
    var stage = $('stage');
    var zoomed = stage.classList.toggle('zoomed');
    this.innerHTML = zoomed ? '<i class="fi fi-br-zoom-out"></i> Zoom out' : '<i class="fi fi-br-zoom-in"></i> Zoom in';
    this.setAttribute('aria-pressed', String(zoomed));
  });
  $('stage').addEventListener('click', function (e) {
    if (e.target.tagName === 'IMG' && this.classList.contains('zoomed')) {
      this.classList.remove('zoomed');
      $('zoomBtn').innerHTML = '<i class="fi fi-br-zoom-in"></i> Zoom in';
      $('zoomBtn').setAttribute('aria-pressed', 'false');
    }
  });

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
      body += '<h3>专栏原文</h3>' + mdToHtml(rec.column_source);
      if (rec.column_md) body += '<h3>调研简报</h3>' + mdToHtml(rec.column_md);
    } else {
      body = mdToHtml(rec.column_md || '（暂无专栏内容）');
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

  /* ---------- per-sticker like / collect / share ---------- */
  /* The modal's actions reuse the set-level endpoints with the
   * sticker id (<set-slug>-NN): the seed stores one Sticker row per
   * individual sticker, so findSticker resolves it. Optimistic
   * updates + localStorage maps are shared with the set-level
   * toggles (set slugs and sticker ids never collide). */

  function renderStickerLike(count, liked) {
    var btn = $('stickerLikeBtn'), countEl = $('stickerLikeCount');
    if (!btn) return;
    btn.innerHTML = '<i class="fi fi-br-heart"></i> ' + (liked ? 'Liked' : 'Like');
    btn.setAttribute('aria-pressed', String(liked));
    if (countEl) countEl.textContent = count > 0 ? count + (count === 1 ? ' like' : ' likes') : 'No likes yet';
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
    btn.innerHTML = '<i class="fi fi-br-bookmark"></i> ' + (bookmarked ? 'Collected' : 'Collect');
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
    fetch(url, options)
      .then(function (r) {
        if (r.status === 401) { location.hash = '#/login'; throw new Error('signed out'); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function () {
        renderStickerBookmark(!bookmarked);
        gaEvent('sticker_bookmark', { sticker: id, bookmarked: !bookmarked });
      })
      .catch(function (e) {
        var m = lsGet(LS_BOOKMARKED_KEY);
        if (bookmarked) m[id] = true; else delete m[id];
        lsSet(LS_BOOKMARKED_KEY, m);
        renderStickerBookmark(bookmarked);
        if (e.message === 'signed out') return;
        var msg = $('stickerShareMsg');
        if (msg) { msg.textContent = 'Could not save it. Try again.'; setTimeout(function () { msg.textContent = ''; }, 2500); }
      });
  }

  /* Shared state (same for the set page and the sticker modal): after a
   * successful share the button turns green and reads Shared for a few
   * seconds, then reverts to its original label. */
  function markShared(btn, originalHtml) {
    if (!btn || btn.classList.contains('shared')) return; // already showing Shared
    btn.classList.add('shared');
    btn.innerHTML = '<i class="fi fi-br-share"></i> Shared';
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
      }).then(function () { markShared($('stickerShareBtn'), '<i class="fi fi-br-share"></i> Share'); done('Shared.'); }).catch(function (e) {
        if (e && e.name === 'AbortError') return; // user dismissed the sheet
        var payload = { title: title, url: url };
        if (text) payload.text = text;
        navigator.share(payload).then(function () { markShared($('stickerShareBtn'), '<i class="fi fi-br-share"></i> Share'); done('Shared.'); }, function () { /* dismissed */ });
      });
      return;
    }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () { markShared($('stickerShareBtn'), '<i class="fi fi-br-share"></i> Share'); done('Link copied.'); }, function () { done(url); });
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
      navigator.share(payload).then(function () { if (btn) markShared(btn, original); done('Shared.'); }, function () { /* dismissed */ });
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () { if (btn) markShared(btn, original); done('Link copied.'); }, function () { done(url); });
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
  $('cartSetBtn').addEventListener('click', function () { if (state.currentSlug) toggleCart('set', state.currentSlug); });
  $('stickerCartBtn').addEventListener('click', function () { var s = state.currentSticker; if (s) toggleCart('single', s.id); });
  $('packCartBtn').addEventListener('click', function () { toggleCart('pack', 'complete-pack-30'); });
  // Cart page actions are delegated — renderCart rebuilds the body.
  $('cartBody').addEventListener('click', function (e) {
    var t = e.target;
    var remove = t.closest ? t.closest('[data-cart-remove]') : null;
    if (remove) { removeFromCart(remove.getAttribute('data-cart-remove')); return; }
    var packAdd = t.closest ? t.closest('[data-pack-add]') : null;
    if (packAdd) {
      var pack = state.links && state.links.pack;
      if (pack) { toggleCart('pack', pack.item_id); renderCart(); }
      return;
    }
    var restore = t.closest ? t.closest('[data-draft-restore]') : null;
    if (restore) { restoreDraft(parseInt(restore.getAttribute('data-draft-restore'), 10)); return; }
    var del = t.closest ? t.closest('[data-draft-delete]') : null;
    if (del) { deleteDraft(parseInt(del.getAttribute('data-draft-delete'), 10)); return; }
    if (t.id === 'clearCartBtn') { clearCart(); return; }
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
    if (e.key === 'Escape' && !$('columnModal').hidden) closeColumnModal();
    if (e.key === 'Escape' && !$('stickerModal').hidden) closeStickerModal();
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
    var actBtn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (actBtn && $('commentList') && $('commentList').contains(actBtn)) handleCommentAction(actBtn);
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
