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
    authAvailable: null // null = unknown, true = /api/auth up, false = not configured
  };

  var $ = function (id) { return document.getElementById(id); };
  var homeEl = $('home'), readerEl = $('reader'), aboutEl = $('about'), loginEl = $('login'), profileEl = $('profile'), bookmarksEl = $('bookmarks');

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
    el.innerHTML = '';
    if (u.image) {
      var img = document.createElement('img');
      img.src = u.image; img.alt = ''; img.className = 'auth-avatar';
      el.appendChild(img);
    }
    var name = document.createElement('a');
    name.href = '#/profile';
    name.className = 'auth-name';
    name.textContent = u.name || u.email || 'Signed in';
    el.appendChild(name);
    var out = document.createElement('a');
    out.href = '/api/auth/signout';
    out.textContent = 'Sign out';
    el.appendChild(out);
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
          msg.innerHTML = 'Comments are still being set up. You can also discuss this sticker set on GitHub: ' +
            '<a href="https://github.com/fimtestxyz/sutekka-generator/issues/new?title=' +
            encodeURIComponent('Comment: ' + slug) + '">open an issue</a>.';
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
    if (!btn) return;
    btn.innerHTML = '<i class="fi fi-br-bookmark"></i> ' + (bookmarked ? 'Saved' : 'Bookmark');
    btn.setAttribute('aria-pressed', String(bookmarked));
    btn.setAttribute('data-bookmarked', String(bookmarked));
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

  function renderBookmarksList(items) {
    var body = $('bookmarksBody');
    if (!body) return;
    var labels = { recent: 'Recent', oldest: 'Oldest', title: 'Title A–Z' };
    var sortHtml = '<div class="sort-row" role="group" aria-label="Sort bookmarks">' +
      Object.keys(labels).map(function (s) {
        return '<button type="button" data-sort="' + s + '"' +
          (state.bookmarksSort === s ? ' class="active"' : '') + '>' + labels[s] + '</button>';
      }).join('') + '</div>';
    var cards = (items || []).map(bookmarkCardHtml).join('');
    body.innerHTML = sortHtml +
      (cards
        ? '<div class="grid">' + cards + '</div>'
        : '<p class="empty"><img class="empty-icon" src="icons/education.png" alt="" width="512" height="512">No bookmarks yet. Open a set and tap <i class="fi fi-br-bookmark"></i> Bookmark to save it here.</p>');
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
          msg.innerHTML = 'Feedback is still being set up. You can also <a href="https://github.com/fimtestxyz/sutekka-generator/issues/new">open an issue on GitHub</a>.';
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

  function cardHtml(c) {
    return '<a class="card" href="#/set/' + c.slug + '">' +
      '<img src="' + c.thumb + '" alt="' + esc(c.title) + '" loading="lazy" decoding="async" style="aspect-ratio:' + c.ratio + '">' +
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
      '<img src="' + s.file + '" alt="' + esc(s.title) + '" loading="lazy" decoding="async">' +
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
    img.alt = c.title;
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
  }

  /* ---------- routing ---------- */

  function showView(name) {
    homeEl.hidden = name !== 'home';
    readerEl.hidden = name !== 'reader';
    aboutEl.hidden = name !== 'about';
    loginEl.hidden = name !== 'login';
    profileEl.hidden = name !== 'profile';
    bookmarksEl.hidden = name !== 'bookmarks';
  }

  function route() { routeInner(); trackPageView(); }

  function routeInner() {
    var hash = location.hash || '#/';
    var parts = hash.replace(/^#\//, '').split('/');
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
    img.alt = s.title;
    $('stickerModalJa').textContent = s.ja || '';
    $('stickerModalZh').textContent = s.zh || '';
    $('stickerModalPoint').textContent = s.point || '';
    $('stickerModalScene').textContent = s.scene || '';
    $('stickerModal').hidden = false;
    document.body.classList.add('modal-open');
    loadStickerLike(s.id);
    loadStickerBookmark(s.id);
    gaEvent('sticker_modal', { slug: state.currentSlug || '', n: String(n) });
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
      }).then(function () { done('Shared.'); }).catch(function (e) {
        if (e && e.name === 'AbortError') return; // user dismissed the sheet
        var payload = { title: title, url: url };
        if (text) payload.text = text;
        navigator.share(payload).then(function () { done('Shared.'); }, function () { /* dismissed */ });
      });
      return;
    }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () { done('Link copied.'); }, function () { done(url); });
      return;
    }
    done(url);
  }

  $('shareBtn').addEventListener('click', function () {
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
    gaEvent('share', { slug: state.currentSlug || '' });
    function done(text) { msg.textContent = text; setTimeout(function () { msg.textContent = ''; }, 2500); }
    if (navigator.share) {
      var payload = { title: title, url: url };
      if (text) payload.text = text;
      navigator.share(payload).then(function () { done('Shared.'); }, function () { /* dismissed */ });
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () { done('Link copied.'); }, function () { done(url); });
    } else {
      done(url);
    }
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
  });

  document.addEventListener('click', function (e) {
    // closest('button'): the buttons contain <i> icons, and a tap on the
    // icon itself has the icon as e.target, not the button.
    var btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (btn && btn.id === 'likeBtn') toggleLike();
    if (btn && btn.id === 'bookmarkBtn') toggleBookmark();
    if (btn && btn.id === 'stickerLikeBtn') toggleStickerLike();
    if (btn && btn.id === 'stickerBookmarkBtn') toggleStickerBookmark();
    if (btn && btn.id === 'stickerShareBtn') shareSticker();
    if (e.target && e.target.id === 'replyCancel') setReplyTo(null);
    var sortBtn = e.target && e.target.closest ? e.target.closest('[data-sort]') : null;
    if (sortBtn && $('bookmarksBody') && $('bookmarksBody').contains(sortBtn)) {
      state.bookmarksSort = sortBtn.getAttribute('data-sort');
      renderBookmarks();
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
  });

  document.addEventListener('keydown', function (e) {
    if (readerEl.hidden) return;
    if (e.key === 'ArrowLeft' && !$('prevLink').hasAttribute('aria-disabled')) location.hash = $('prevLink').getAttribute('href');
    if (e.key === 'ArrowRight' && !$('nextLink').hasAttribute('aria-disabled')) location.hash = $('nextLink').getAttribute('href');
  });

  window.addEventListener('hashchange', route);

  init();
})();
