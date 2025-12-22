// Simple offline cache-first Service Worker (no build tools required)
const CACHE = 'balancechain-html-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './idb.js',
  './state.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
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

  // Only handle same-origin http/https. Avoid caching browser-extension / chrome-extension URLs.
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // GitHub Pages often serves assets with query strings; ignoreSearch improves hit rate.
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      if (req.mode === 'navigate') return cache.match('./index.html');
      throw;
    }
  })());
});
