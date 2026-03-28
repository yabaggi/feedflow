const CACHE_NAME = 'feedflow-v1';

// Files to cache immediately on install (app shell)
const SHELL_ASSETS = [
  '/',
  '/index.html',
];

// ── Install: cache the app shell ─────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching app shell');
      return cache.addAll(SHELL_ASSETS);
    })
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches ────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first for API, cache-first for app shell ──────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip browser extensions and chrome-extension URLs
  if (!url.protocol.startsWith('http')) return;

  // API calls (Netlify function + Reddit direct) → network first, no caching
  const isApi = url.pathname.includes('/.netlify/functions/') ||
                url.hostname.includes('reddit.com') ||
                url.hostname.includes('rss2json.com');

  if (isApi) {
    event.respondWith(
      fetch(event.request).catch(() => {
        // If network fails for API, return a friendly error JSON
        return new Response(
          JSON.stringify({ error: 'Offline — no cached data available', items: [] }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // Google Fonts — cache first, network fallback
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        });
      })
    );
    return;
  }

  // App shell (HTML, assets) → cache first, network fallback
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((res) => {
        // Cache successful responses for app shell files
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return res;
      }).catch(() => {
        // Offline fallback → serve index.html for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

// ── Background sync placeholder (future use) ─────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});

