const CACHE_NAME = 'rabbit-music-v5';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Install — pre-cache the complete app shell so the app works offline.
// Cache each asset independently so one failure doesn't kill the whole install.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(SHELL.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

// Periodic version check (only when online)
let lastVersion = null;
async function checkForUpdate() {
  try {
    const res = await fetch('/api/version');
    const data = await res.json();
    if (lastVersion && data.version !== lastVersion) {
      const clients = await self.clients.matchAll();
      clients.forEach(c => c.postMessage({ type: 'UPDATE_AVAILABLE' }));
    }
    lastVersion = data.version;
  } catch (e) {}
}
setInterval(checkForUpdate, 60 * 1000);

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Cache a response under BOTH the exact request URL and its pathname (no ?ver=N)
function cacheResponse(url, response) {
  if (!response || !response.ok) return;
  const clone = response.clone();
  caches.open(CACHE_NAME).then((cache) => {
    cache.put(url.pathname, clone);
    cache.put(url.href, response);
  }).catch(() => {});
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle GET
  if (event.request.method !== 'GET') return;

  // Service worker itself — never cache, always network
  if (url.pathname.startsWith('/sw.js')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Version check (and stream proxy) — network only
  if (url.pathname === '/api/version') {
    event.respondWith(fetch(event.request).catch(() => new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // Stream requests (audio via yt-dlp proxy) — network only, cannot be SW-cached
  if (url.pathname.startsWith('/api/stream/')) {
    event.respondWith(fetch(event.request).catch(() => new Response(JSON.stringify({ error: 'Offline', offline: true }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // Other API requests — network first, offline fallback from cache, then friendly JSON
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).then((response) => {
        cacheResponse(url, response);
        return response;
      }).catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // try pathname-only too
        const byPath = await caches.match(url.pathname);
        if (byPath) return byPath;
        return new Response(JSON.stringify({ error: 'Offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      })
    );
    return;
  }

  // Same-origin static assets — cache FIRST (fast + offline), then network, then index.html fallback
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached && url.origin === self.location.origin) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          cacheResponse(url, response);
        }
        return response;
      }).catch(async () => {
        if (event.request.mode === 'navigate') {
          const page = await caches.match('/index.html');
          if (page) return page;
          return caches.match('/');
        }
        // try the query-stripped path (handles /app.js?ver=N offline)
        if (url.search) {
          const byPath = await caches.match(url.pathname);
          if (byPath) return byPath;
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});