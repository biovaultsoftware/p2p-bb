
// Push poke (best-effort) - stores subscriptions by HID (metadata only).
// NOTE: For production/scalability, move these maps into a Durable Object / KV.
const subs = new Map(); // hid -> PushSubscription JSON
const VAPID_PUBLIC_KEY = (globalThis.VAPID_PUBLIC_KEY || null); // set in worker env

// Minimal WebSocket signaling relay for BC Lightning Messaging
// - routes messages by "to" HID
// - does NOT store message payloads
// Deploy on Cloudflare Workers (or adapt for Node/ws)

const clients = new Map(); // hid -> ws

function safeJson(x){ try{return JSON.stringify(x);}catch{return '{"t":"err"}';} }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/signal") return new Response("ok", { status: 200 });

    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") return new Response("Expected websocket", { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    let hid = null;

    server.accept();

    server.addEventListener("message", (ev) => {
      let m=null; try{ m=JSON.parse(ev.data);}catch{ return; }

      if(m.t==="hello" && typeof m.hid==="string"){
        hid = m.hid;
        clients.set(hid, server);
        server.send(safeJson({t:"hello", ok:true, hid}));
        return;
      }

      if(m.t==="send" && hid && typeof m.to==="string"){
        const to = m.to;
        const dst = clients.get(to);
        if(dst){
          dst.send(safeJson({t:"msg", from: hid, data: m.data || null}));
        }else{
          server.send(safeJson({t:"nack", to, reason:"offline"}));
        }
        return;
      }
    });

    server.addEventListener("close", ()=>{ if(hid) clients.delete(hid); });
    server.addEventListener("error", ()=>{ if(hid) clients.delete(hid); });

    return new Response(null, { status: 101, webSocket: client });
  }
};
