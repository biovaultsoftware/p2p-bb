# Push (poke-only) server

This is OPTIONAL but required for WhatsApp-like wakeups.
It sends **poke notifications only** (no message content).

## Why a separate server?
GitHub Pages is static. Web Push requires a server to:
- host the VAPID public key
- accept subscriptions
- send push notifications to browser endpoints

## Run locally (dev)
1) `cd server/push`
2) `npm i`
3) `node push-server.js`

## Env
- `VAPID_SUBJECT` (mailto:you@domain.com)
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`

Generate keys:
`node gen-vapid.js`

## Endpoints
- GET  /push/vapidPublicKey   -> { publicKey }
- POST /push/subscribe        -> { hid, sub }
- POST /push/poke             -> { toHid, fromHid }  (sends notification)

## Wiring
- Deploy this server on any small VM / Cloud Run / Fly.io / Render.
- Put it under the same domain via reverse proxy OR keep it separate and update app.js fetch URLs.
