import { openDB, txDone, reqDone } from './idb.js';
import { appendSTA, exportKeyJwk, importPubKeyJwk, randomHex, getChainHead, getChainLen, computeHID, deriveChannelId } from './state.js';
import { SignalClient } from './signal.js';
import { P2PManager } from './p2p.js';

const DB_NAME = 'bc_lightning_pwa';
const DB_VER = 3;

let db;
let identity; // { hik, hid, pubJwk, privateKey, ecdhPubJwk, ecdhPrivKey }
let activePeer = null; // HID
let activeChannel = null; // CH-...

const els = {
  mePill: document.getElementById('mePill'),
  head: document.getElementById('head'),
  len: document.getElementById('len'),
  signalStatus: document.getElementById('signalStatus'),
  p2pStatus: document.getElementById('p2pStatus'),
  peerHid: document.getElementById('peerHid'),
  btnAdd: document.getElementById('btnAdd'),
  contacts: document.getElementById('contacts'),
  chatTitle: document.getElementById('chatTitle'),
  chat: document.getElementById('chat'),
  msg: document.getElementById('msg'),
  send: document.getElementById('send'),
  btnSync: document.getElementById('btnSync'),
  btnExport: document.getElementById('btnExport'),
  btnImport: document.getElementById('btnImport'),
  btnReset: document.getElementById('btnReset'),
};

function esc(s){ return String(s).replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

async function initDB(){
  db = await openDB(DB_NAME, DB_VER, {
    upgrade(db, oldV, newV){
      if(!db.objectStoreNames.contains('state_chain')) db.createObjectStore('state_chain', { keyPath:'seq' });
      if(!db.objectStoreNames.contains('sync_log')) db.createObjectStore('sync_log', { keyPath:'nonce' });
      if(!db.objectStoreNames.contains('messages')) {
        const s=db.createObjectStore('messages', { keyPath:'id' });
        s.createIndex('byChannelTs', ['channelId','ts']);
      }
      if(!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath:'key' });
      if(!db.objectStoreNames.contains('keys')) db.createObjectStore('keys', { keyPath:'name' });

      if(!db.objectStoreNames.contains('contacts')) db.createObjectStore('contacts', { keyPath:'hid' });
      if(!db.objectStoreNames.contains('channels')) db.createObjectStore('channels', { keyPath:'channelId' });

      if(!db.objectStoreNames.contains('outbox')) {
        const s=db.createObjectStore('outbox', { keyPath:'id' });
        s.createIndex('byChannelSeq', ['channelId','seqInChannel']);
        s.createIndex('byToChannel', ['toHid','channelId']);
      }
      if(!db.objectStoreNames.contains('presence')) db.createObjectStore('presence', { keyPath:'hid' });
      if(!db.objectStoreNames.contains('pokes')) db.createObjectStore('pokes', { keyPath:'id' });
    }
  });
}

async function ensureIdentity(){
  const tx=db.transaction(['keys','meta'], 'readwrite');
  const keys=tx.objectStore('keys');
  const meta=tx.objectStore('meta');

  const existing = await reqDone(keys.get('identity'));
  if(existing?.privateJwk && existing?.pubJwk){
    const privateKey = await crypto.subtle.importKey('jwk', existing.privateJwk, { name:'ECDSA', namedCurve:'P-256' }, true, ['sign']);
    const pubJwk = existing.pubJwk;
    const hid = existing.hid || await computeHID(pubJwk);

    let ecdhPrivKey=null, ecdhPubJwk=null;
    const ecdhRec = await reqDone(keys.get('ecdh'));
    if(ecdhRec?.privateJwk && ecdhRec?.pubJwk){
      ecdhPrivKey = await crypto.subtle.importKey('jwk', ecdhRec.privateJwk, { name:'ECDH', namedCurve:'P-256' }, true, ['deriveKey']);
      ecdhPubJwk = ecdhRec.pubJwk;
    } else {
      const kp = await crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, true, ['deriveKey']);
      ecdhPrivKey = kp.privateKey;
      ecdhPubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
      keys.put({ name:'ecdh', privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey), pubJwk: ecdhPubJwk });
    }

    identity = { hik: existing.hik, hid, pubJwk, privateKey, ecdhPubJwk, ecdhPrivKey };
    meta.put({ key:'hid', value: hid });
    await txDone(tx);
    return;
  }

  const hik = 'HIK-' + randomHex(12);
  const kp = await crypto.subtle.generateKey({ name:'ECDSA', namedCurve:'P-256' }, true, ['sign','verify']);
  const pubJwk = await exportKeyJwk(kp.publicKey);
  const privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const hid = await computeHID(pubJwk);

  const kp2 = await crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, true, ['deriveKey']);
  const ecdhPubJwk = await crypto.subtle.exportKey('jwk', kp2.publicKey);
  const ecdhPrivJwk = await crypto.subtle.exportKey('jwk', kp2.privateKey);

  keys.put({ name:'identity', hik, hid, pubJwk, privateJwk: privJwk });
  keys.put({ name:'ecdh', pubJwk: ecdhPubJwk, privateJwk: ecdhPrivJwk });
  meta.put({ key:'hid', value: hid });
  await txDone(tx);

  identity = { hik, hid, pubJwk, privateKey: kp.privateKey, ecdhPubJwk, ecdhPrivKey: kp2.privateKey };
}

function signalUrls(){
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return [
    proto + location.host + '/signal', // Cloudflare Worker endpoint recommended
  ];
}

let signal, p2p;

async function initNetwork(){
  signal = new SignalClient(signalUrls(), {
    hid: identity.hid,
    onMessage: async (m) => {
      const from = m.from;
      const data = m.data || {};
      if(data.kind === 'offer' || data.kind === 'answer' || data.kind === 'ice'){
        await p2p.onSignal({from, data});
        return;
      }
      if(data.kind === 'poke'){
        // auto-sync from this contact if it's one of ours
        await maybeSync(from);
        return;
      }
      if(data.kind === 'presence'){
        // cache presence
        await putPresence(from, data.ts, data.ttl||120, data.hints||null);
        return;
      }
    },
    onStatus: (s) => {
      const txt = s.state + (s.url ? ` (${s.url.replace(/^wss?:\/\//,'')})` : '');
      els.signalStatus.textContent = txt;
    }
  });

  p2p = new P2PManager({
    myHid: identity.hid,
    signal,
    ecdh: { publicJwk: identity.ecdhPubJwk, privateKey: identity.ecdhPrivKey },
    onPullRequest: async ({from, channelId, sinceSeq}) => {
      return { items: await getOutboxItems(channelId, from, sinceSeq) };
    },
    onIntentBatch: async ({from, channelId, items}) => {
      let maxSeq = 0;
      for(const it of items){
        maxSeq = Math.max(maxSeq, Number(it.seq||0));
        await appendSTA(db, identity, 'msg.delivered', {
          channelId,
          fromHid: from,
          msgId: it.msgId,
          seqInChannel: it.seq,
          text: it.text
        });
      }
      if(maxSeq>0){
        await appendSTA(db, identity, 'msg.ack', { channelId, peerHid: from, upToSeq: maxSeq });
        await p2p.sendAck(from, channelId, maxSeq);
      }
      await refreshChat();
    },
    onAck: async ({from, channelId, upToSeq}) => {
      await markOutboxDelivered(channelId, from, upToSeq);
      await refreshChat();
    },
    onStatus: (s) => {
      els.p2pStatus.textContent = s.peerHid ? `${s.peerHid.slice(0,10)}… ${s.state}` : String(s.state||'');
    }
  });

  signal.start();

  // presence heartbeat to contacts (best-effort)
  setInterval(async ()=>{
    const cs = await listContacts();
    if(cs.length && signal.isOpen()){
      const payload = { kind:'presence', ts: Date.now(), ttl: 120, hints: null };
      signal.broadcast(cs.map(x=>x.hid), payload);
    }
  }, 45000);
}

async function putPresence(hid, ts, ttl, hints){
  const tx=db.transaction(['presence'], 'readwrite');
  tx.objectStore('presence').put({ hid, ts, expiresAt: ts + ttl*1000, hints });
  await txDone(tx);
}

async function listContacts(){
  const tx=db.transaction(['contacts'],'readonly');
  const store=tx.objectStore('contacts');
  const all = await reqDone(store.getAll());
  await txDone(tx);
  return all || [];
}

async function ensureChannel(peerHid){
  const channelId = await deriveChannelId(identity.hid, peerHid);
  const tx=db.transaction(['channels'],'readwrite');
  const store=tx.objectStore('channels');
  const existing = await reqDone(store.get(channelId));
  if(!existing){
    await appendSTA(db, identity, 'channel.open', { channelId, peerHid });
    store.put({ channelId, peerHid, lastPulledSeq: 0, lastAckedSeq: 0, createdAt: Date.now() });
  }
  await txDone(tx);
  return channelId;
}

async function getOutboxItems(channelId, toHid, sinceSeq){
  const tx=db.transaction(['outbox'],'readonly');
  const store=tx.objectStore('outbox');
  const all = await reqDone(store.getAll());
  await txDone(tx);
  return (all||[])
    .filter(x => x.channelId===channelId && x.toHid===toHid && Number(x.seqInChannel)>Number(sinceSeq||0) && x.status!=='delivered')
    .sort((a,b)=>a.seqInChannel-b.seqInChannel)
    .slice(0,200)
    .map(x => ({ seq: x.seqInChannel, msgId: x.id, text: x.text, ts: x.createdAt }));
}

async function nextSeq(channelId, toHid){
  const tx=db.transaction(['outbox'],'readonly');
  const store=tx.objectStore('outbox');
  const all = await reqDone(store.getAll());
  await txDone(tx);
  const mx = (all||[]).filter(x=>x.channelId===channelId && x.toHid===toHid).reduce((m,x)=>Math.max(m, Number(x.seqInChannel||0)), 0);
  return mx+1;
}

async function markOutboxDelivered(channelId, toHid, upToSeq){
  const tx=db.transaction(['outbox'],'readwrite');
  const store=tx.objectStore('outbox');
  const all = await reqDone(store.getAll());
  for(const x of (all||[])){
    if(x.channelId===channelId && x.toHid===toHid && Number(x.seqInChannel)<=Number(upToSeq)){
      x.status='delivered';
      store.put(x);
    }
  }
  await txDone(tx);
}

async function refreshMeta(){
  els.head.textContent = await getChainHead(db);
  els.len.textContent = await getChainLen(db);
  els.mePill.textContent = `Me: ${identity.hid}`;
}

async function renderContacts(){
  const cs = await listContacts();
  els.contacts.innerHTML = cs.map(c => `
    <div class="item" data-hid="${esc(c.hid)}">
      <div>
        <div class="a">${esc(c.nickname || c.hid)}</div>
        <div class="b">${esc(c.hid)}</div>
      </div>
      <div class="b">tap</div>
    </div>
  `).join('') || `<div class="b">No contacts yet. Add a HID.</div>`;

  for(const el of els.contacts.querySelectorAll('.item')){
    el.onclick = async ()=>{
      activePeer = el.getAttribute('data-hid');
      activeChannel = await ensureChannel(activePeer);
      els.chatTitle.textContent = `Chat • ${activePeer.slice(0,12)}…`;
      await refreshChat();
      await maybeSync(activePeer);
    };
  }
}

async function refreshChat(){
  if(!activeChannel){
    els.chat.innerHTML = `<div class="meta">Pick a contact.</div>`;
    return;
  }
  const tx=db.transaction(['messages','outbox'],'readonly');
  const msgsStore=tx.objectStore('messages');
  const outStore=tx.objectStore('outbox');
  const msgs = await reqDone(msgsStore.getAll());
  const outb = await reqDone(outStore.getAll());
  await txDone(tx);

  const m = (msgs||[]).filter(x=>x.channelId===activeChannel).sort((a,b)=>a.ts-b.ts);
  const o = (outb||[]).filter(x=>x.channelId===activeChannel && x.toHid===activePeer).sort((a,b)=>a.createdAt-b.createdAt);

  // merge: show settled incoming + local outgoing pending/sent
  const bubbles = [];
  for(const x of m){
    const me = x.dir==='out';
    bubbles.push({me, text:x.text, ts:x.ts, meta: me ? 'delivered' : 'received'});
  }
  for(const x of o){
    bubbles.push({me:true, text:x.text, ts:x.createdAt, meta: x.status});
  }
  bubbles.sort((a,b)=>a.ts-b.ts);

  els.chat.innerHTML = bubbles.map(b=>`
    <div class="bubble ${b.me?'me':''}">
      ${esc(b.text)}
      <div class="meta">${esc(new Date(b.ts).toLocaleString())} • ${esc(b.meta)}</div>
    </div>
  `).join('') || `<div class="meta">No messages yet.</div>`;

  els.chat.scrollTop = els.chat.scrollHeight;
}

async function maybeSync(peerHid){
  if(!peerHid) return;
  const channelId = await ensureChannel(peerHid);
  // dial + pull
  try{
    if(!p2p.isConnected(peerHid)) await p2p.dial(peerHid);
  }catch{}
  const since = await getLastPulled(channelId);
  await p2p.sendPull(peerHid, channelId, since);
  await setLastPulled(channelId, since); // will be bumped by ack later
}

async function getLastPulled(channelId){
  const tx=db.transaction(['channels'],'readonly');
  const s=tx.objectStore('channels');
  const ch=await reqDone(s.get(channelId));
  await txDone(tx);
  return Number(ch?.lastPulledSeq || 0);
}

async function setLastPulled(channelId, v){
  const tx=db.transaction(['channels'],'readwrite');
  const s=tx.objectStore('channels');
  const ch=await reqDone(s.get(channelId));
  if(ch){
    ch.lastPulledSeq = Number(v||0);
    s.put(ch);
  }
  await txDone(tx);
}

async function addContact(hid){
  hid = String(hid||'').trim();
  if(!hid.startsWith('HID-')) return;
  await appendSTA(db, identity, 'contact.add', { hid });
  const tx=db.transaction(['contacts'],'readwrite');
  tx.objectStore('contacts').put({ hid, nickname:null, addedAt: Date.now() });
  await txDone(tx);
  await renderContacts();
}

async function sendMessage(){
  if(!activePeer || !activeChannel) return;
  const text = String(els.msg.value||'').trim();
  if(!text) return;
  els.msg.value='';

  const msgId = 'MSG-' + randomHex(10);
  const seqInChannel = await nextSeq(activeChannel, activePeer);

  // commit intent locally (sender-held)
  await appendSTA(db, identity, 'msg.intent', { channelId: activeChannel, toHid: activePeer, msgId, seqInChannel, text });
  // local echo
  await appendSTA(db, identity, 'msg.sent', { channelId: activeChannel, toHid: activePeer, msgId, seqInChannel, text });

  // poke receiver (no content)
  if(signal.isOpen()){
    signal.send(activePeer, { kind:'poke', channelId: activeChannel, ts: Date.now(), ttl: 300 });
  }

  await refreshChat();
}

async function exportAll(){
  const dump = {};
  for(const name of db.objectStoreNames){
    const tx=db.transaction([name],'readonly');
    dump[name]=await reqDone(tx.objectStore(name).getAll());
    await txDone(tx);
  }
  const blob = new Blob([JSON.stringify({ v:1, at: Date.now(), dump }, null, 2)], {type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='bc_lightning_backup.json';
  a.click();
}

async function importAll(){
  const inp=document.createElement('input');
  inp.type='file';
  inp.accept='application/json';
  inp.onchange=async ()=>{
    const file=inp.files[0];
    if(!file) return;
    const text=await file.text();
    const parsed=JSON.parse(text);
    const dump=parsed.dump||{};
    // clear & restore
    const stores=[...db.objectStoreNames];
    const tx=db.transaction(stores,'readwrite');
    for(const s of stores) tx.objectStore(s).clear();
    for(const [s,rows] of Object.entries(dump)){
      if(!db.objectStoreNames.contains(s)) continue;
      const os=tx.objectStore(s);
      for(const r of (rows||[])) os.put(r);
    }
    await txDone(tx);
    location.reload();
  };
  inp.click();
}

async function hardReset(){
  db.close();
  await new Promise((res, rej)=>{
    const req=indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess=()=>res();
    req.onerror=()=>res();
    req.onblocked=()=>res();
  });
  location.reload();
}

// ---- UI wiring ----
els.btnAdd.onclick = ()=> addContact(els.peerHid.value);
els.send.onclick = ()=> sendMessage();
els.btnSync.onclick = ()=> { if(activePeer) maybeSync(activePeer); };
els.btnExport.onclick = ()=> exportAll();
els.btnImport.onclick = ()=> importAll();
els.btnReset.onclick = ()=> hardReset();

window.addEventListener('keydown', (e)=>{
  if(e.key==='Enter' && document.activeElement===els.msg){
    e.preventDefault(); sendMessage();
  }
});

// ---- boot ----
(async function main(){
  await initDB();
  await ensureIdentity();
  await refreshMeta();
  await renderContacts();
  await initNetwork();

  // register SW if available
  if('serviceWorker' in navigator){
    try{ await navigator.serviceWorker.register('./sw.js'); }catch{}
  }
})();
