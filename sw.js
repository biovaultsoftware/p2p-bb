// Service Worker (GitHub Pages-safe)
const CACHE = 'balancechain-html-v2';

function u(path) {
  return new URL(path, self.registration.scope).toString();
}

const ASSETS = [
  u('index.html'),
  u('app.js'),
  u('idb.js'),
  u('state.js'),
  u('manifest.webmanifest'),
  u('icons/icon-192.png'),
  u('icons/icon-512.png'),
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE) ? caches.delete(k) : Promise.resolve()));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      // Offline fallback for navigations
      if (req.mode === 'navigate') return cache.match(u('index.html'));
      throw;
    }
  })());
});
