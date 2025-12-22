// BalanceChain PWA Service Worker (safe + GitHub Pages friendly)
const CACHE = 'balancechain-html-v2';

const ASSETS = [
  './',
  './index.html',
  './app.js',
  './idb.js',
  './state.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
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
    await Promise.all(keys.map((k) => (k !== CACHE ? caches.delete(k) : Promise.resolve())));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle real web requests
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const res = await fetch(req);
      // Only cache successful basic/cors responses
      if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
        await cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      if (req.mode === 'navigate') return cache.match('./index.html');
      throw e;
    }
  })());
});
