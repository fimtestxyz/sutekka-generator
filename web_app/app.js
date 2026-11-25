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

  var LS_KEY = 'sticker-showcase-index-v1';
  var LS_TTL_MS = 60 * 60 * 1000; // revalidate after 1 hour
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
    engageReady: null // null = unknown, true = API up, false = API down
  };

  var $ = function (id) { return document.getElementById(id); };
  var homeEl = $('home'), readerEl = $('reader'), aboutEl = $('about');

  /* ---------- analytics (GA4) + engagement ---------- */

  var LS_LIKED_KEY = 'sticker-showcase-liked-v1';
  var LS_LIKE_COUNTS_KEY = 'sticker-showcase-like-counts-v1';

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

  function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
  }
  function lsSet(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) { /* storage full or private mode */ }
  }

  function renderLike(count, liked, localOnly) {
    var btn = $('likeBtn'), countEl = $('likeCount'), note = $('likeNote');
    if (!btn) return;
    btn.textContent = liked ? '♥ Liked' : '♥ Like';
    btn.setAttribute('aria-pressed', String(liked));
    countEl.textContent = count > 0 ? count + (count === 1 ? ' like' : ' likes') : 'No likes yet';
    note.textContent = localOnly ? 'Saved on this device only.' : '';
  }

  function loadLikes(slug) {
    renderLike(0, Boolean(lsGet(LS_LIKED_KEY)[slug]), false);
    fetch('/api/engage?action=likes&slug=' + encodeURIComponent(slug), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        state.engageReady = true;
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
    var likedMap = lsGet(LS_LIKED_KEY);
    var liked = !likedMap[slug];
    if (state.engageReady === false) {
      // Server not configured: keep the like on this device.
      var counts = lsGet(LS_LIKE_COUNTS_KEY);
      counts[slug] = Math.max(0, (counts[slug] || 0) + (liked ? 1 : -1));
      lsSet(LS_LIKE_COUNTS_KEY, counts);
      if (liked) likedMap[slug] = true; else delete likedMap[slug];
      lsSet(LS_LIKED_KEY, likedMap);
      renderLike(counts[slug], liked, true);
      return;
    }
    fetch('/api/engage?action=' + (liked ? 'like' : 'unlike') + '&slug=' + encodeURIComponent(slug), { method: 'POST', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        if (d.liked) likedMap[slug] = true; else delete likedMap[slug];
        lsSet(LS_LIKED_KEY, likedMap);
        renderLike(d.likes || 0, d.liked, false);
        gaEvent('like', { slug: slug, liked: d.liked });
      })
      .catch(function () {
        state.engageReady = false;
        toggleLike(); // fall back to the on-device path once
      });
  }

  function commentHtml(c) {
    var when = c.ts ? new Date(c.ts).toLocaleString() : '';
    return '<article class="comment"><p class="c-head"><strong>' + esc(c.name || 'Anonymous') + '</strong>' +
      (when ? ' <span class="c-time">' + esc(when) + '</span>' : '') + '</p>' +
      '<p class="c-text">' + esc(c.text || '') + '</p></article>';
  }

  function loadComments(slug) {
    var list = $('commentList'), msg = $('commentMsg');
    if (!list) return;
    list.innerHTML = '';
    if (msg) msg.textContent = 'Loading comments…';
    fetch('/api/engage?action=comments&slug=' + encodeURIComponent(slug), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        state.engageReady = true;
        var comments = d.comments || [];
        list.innerHTML = comments.length ? comments.map(commentHtml).join('') :
          '<p class="empty">No comments yet. Be the first.</p>';
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

  function postComment(e) {
    e.preventDefault();
    var slug = state.currentSlug;
    var text = $('commentText').value.trim();
    var msg = $('commentMsg');
    if (!slug || !text) return;
    fetch('/api/engage?action=comment&slug=' + encodeURIComponent(slug), {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('commentName').value, text: text })
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (res) {
        if (res.status === 429) { if (msg) msg.textContent = 'Slow down — too many comments too fast.'; return; }
        if (res.status !== 200 || !res.d.comment) { if (msg) msg.textContent = 'Could not post the comment. Try again.'; return; }
        var list = $('commentList');
        if (list) {
          var empty = list.querySelector('.empty');
          if (empty) empty.remove();
          list.insertAdjacentHTML('afterbegin', commentHtml(res.d.comment));
        }
        $('commentText').value = '';
        if (msg) msg.textContent = 'Comment posted.';
        gaEvent('comment_post', { slug: slug });
      })
      .catch(function () { if (msg) msg.textContent = 'Could not post the comment. Try again.'; });
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
          if (msg) msg.textContent = 'Thanks — feedback received.';
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
    var indexP = fetchJson('data/index.json');
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
    var tags = Object.keys(counts).filter(function (t) { return counts[t] >= 2; }).sort();
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
      '<span class="tap-badge">👆 点我</span>' +
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
    zoomBtn.textContent = 'Zoom in';
    zoomBtn.setAttribute('aria-pressed', 'false');
    $('stickerGrid').innerHTML = (c.stickers || []).map(stickerCellHtml).join('');
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
  }

  /* ---------- routing ---------- */

  function showView(name) {
    homeEl.hidden = name !== 'home';
    readerEl.hidden = name !== 'reader';
    aboutEl.hidden = name !== 'about';
  }

  function route() { routeInner(); trackPageView(); }

  function routeInner() {
    var hash = location.hash || '#/';
    var parts = hash.replace(/^#\//, '').split('/');
    if (parts[0] === 'set' && parts[1]) { openSet(parts[1]); return; }
    if (parts[0] === 'about') { showView('about'); window.scrollTo(0, 0); return; }
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
    location.hash = b.dataset.batch === 'all' ? '#/' : '#/batch/' + b.dataset.batch;
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
    this.textContent = zoomed ? 'Zoom out' : 'Zoom in';
    this.setAttribute('aria-pressed', String(zoomed));
  });
  $('stage').addEventListener('click', function (e) {
    if (e.target.tagName === 'IMG' && this.classList.contains('zoomed')) {
      this.classList.remove('zoomed');
      $('zoomBtn').textContent = 'Zoom in';
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
    gaEvent('sticker_modal', { slug: state.currentSlug || '', n: String(n) });
  }

  function closeStickerModal() {
    $('stickerModal').hidden = true;
    document.body.classList.remove('modal-open');
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
    if (e.target && e.target.id === 'likeBtn') toggleLike();
  });
  document.addEventListener('submit', function (e) {
    if (e.target && e.target.id === 'commentForm') postComment(e);
    if (e.target && e.target.id === 'feedbackForm') postFeedback(e);
  });

  document.addEventListener('keydown', function (e) {
    if (readerEl.hidden) return;
    if (e.key === 'ArrowLeft' && !$('prevLink').hasAttribute('aria-disabled')) location.hash = $('prevLink').getAttribute('href');
    if (e.key === 'ArrowRight' && !$('nextLink').hasAttribute('aria-disabled')) location.hash = $('nextLink').getAttribute('href');
  });

  window.addEventListener('hashchange', route);

  init();
})();
