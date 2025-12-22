const VERSION = 'bc-lightning-v1';
const STATIC_CACHE = `bc-static-${VERSION}`;
const BACKUP_CACHE = 'bc-backup';
const BACKUP_URL = '/__bc_backup.json';

const STATIC_ASSETS = [
  './',
  './index.html',
  './app.js',
  './idb.js',
  './state.js',
  './signal.js',
  './p2p.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(STATIC_ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k.startsWith('bc-static-') && k !== STATIC_CACHE) ? caches.delete(k) : Promise.resolve()));
    self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'SAVE_BACKUP') {
    event.waitUntil((async () => {
      const cache = await caches.open(BACKUP_CACHE);
      const body = JSON.stringify({ savedAt: Date.now(), data: msg.payload });
      await cache.put(BACKUP_URL, new Response(body, { headers: { 'Content-Type': 'application/json' } }));
      event.source?.postMessage?.({ type: 'BACKUP_SAVED', ok: true });
    })());
  }
  if (msg.type === 'CLEAR_BACKUP') {
    event.waitUntil((async () => {
      const cache = await caches.open(BACKUP_CACHE);
      await cache.delete(BACKUP_URL);
      event.source?.postMessage?.({ type:'BACKUP_CLEARED', ok:true });
    })());
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.endsWith('/__bc_backup.json')) {
    event.respondWith((async () => {
      const cache = await caches.open(BACKUP_CACHE);
      const hit = await cache.match(BACKUP_URL);
      return hit || new Response(JSON.stringify({ ok:false, reason:'no_backup' }), { headers:{'Content-Type':'application/json'}, status:404 });
    })());
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match('./index.html');
      try {
        const net = await fetch(event.request);
        return net;
      } catch {
        return cached;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      return await fetch(event.request);
    } catch {
      return cached || Response.error();
    }
  })());
});
