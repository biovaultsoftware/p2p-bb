# BC Lightning Messaging (Production Zip)

**What works:**
- Local-first chat with deterministic state chain (STA).
- Contacts by HID (like phone numbers).
- Lightning semantics: sender holds message intents in outbox; receiver pulls when online.
- WebRTC (RTCDataChannel) for direct P2P transfer. Signaling via `/signal` WebSocket (Cloudflare Worker).
- Offline "Chat Brain" search over messages (on-device).

## Deploy
### Option A (Recommended): Custom domain + Cloudflare Worker
1. Host this folder on your domain (static hosting: Cloudflare Pages / GoDaddy / Nginx).
2. Deploy the worker in `/cloudflare-worker/worker.js` and route `YOUR_DOMAIN/signal*` to it.
3. Open the app. Add a contact HID on two devices. Tap contact → Send → Sync.

### Option B: GitHub Pages
GitHub Pages cannot host WebSocket endpoints.
- Deploy worker separately (Workers.dev or your domain) and set **Signal URL** inside the app UI to:
  `wss://YOUR_WORKER_SUBDOMAIN.workers.dev/signal`
