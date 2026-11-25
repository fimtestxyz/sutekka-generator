/* Sticker Showcase service worker.
 *
 * Goal: a reader who opened a set once never downloads it again
 * for a week, and the app shell works on a repeat visit even with
 * a flaky connection. HTTP cache headers (vercel.json) are the
 * first layer; this is the second.
 *
 * - App shell + index.json: stale-while-revalidate.
 * - thumbs/ + comics/ images: cache-first, revalidate in the
 *   background when the cached copy is older than 7 days
 *   (a sticker can be redrawn — the URL stays the same).
 * - Navigation: network-first, fall back to cached index.html.
 *   Only the app shell itself is cached under '/index.html' —
 *   caching any other navigation (e.g. a /share/<slug>/ page)
 *   under that key would poison the offline shell.
 * - Anything else: cache-first, then network.
 *
 * Bump CACHE when the shell changes in a way old caches must not
 * serve (e.g. a new app.js with a different data shape).
 *
 * /api/* is never cached: likes and comments are live data.
 */
var CACHE = 'sticker-showcase-v5';
var CORE = ['/', '/index.html', '/app.js?v=4', '/styles.css?v=4', '/data/index.json', '/data/series.json', '/data/config.json'];
var IMAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(CORE); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () { /* offline on first install — try again next visit */ })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isImage(url) {
  return url.pathname.indexOf('/thumbs/') === 0 || url.pathname.indexOf('/stickers/') === 0 || url.pathname.indexOf('/og/') === 0;
}

function cachedAgeMs(response) {
  var date = response.headers.get('date');
  if (!date) return Infinity;
  return Date.now() - new Date(date).getTime();
}

function fetchAndCache(request) {
  return fetch(request).then(function (response) {
    if (response && response.ok) {
      var copy = response.clone();
      caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
    }
    return response;
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Engagement API: always network, never cached.
  if (url.pathname.indexOf('/api/') === 0) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(function (response) {
        if (response.ok && (url.pathname === '/' || url.pathname === '/index.html')) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put('/index.html', copy); });
        }
        return response;
      }).catch(function () {
        return caches.match('/index.html');
      })
    );
    return;
  }

  if (isImage(url)) {
    event.respondWith(
      caches.match(request).then(function (cached) {
        if (cached && cachedAgeMs(cached) < IMAGE_MAX_AGE_MS) return cached;
        return fetchAndCache(request).catch(function () { return cached; });
      })
    );
    return;
  }

  // app shell + data: stale-while-revalidate
  event.respondWith(
    caches.match(request).then(function (cached) {
      var network = fetchAndCache(request).catch(function () { return cached; });
      return cached || network;
    })
  );
});
