import { openDB, txDone, reqDone } from './idb.js';
import { appendSTA, exportKeyJwk, randomHex, getChainHead, getChainLen, computeHID, deriveChannelId } from './state.js';
import { SignalClient } from './signal.js';
import { P2PManager } from './p2p.js';
import { kbUpsertMessage, kbSearch } from './kb.js';

const DB_NAME = 'bc_lightning_pwa';
const DB_VER = 6; // bump when schema changes

const DEFAULT_SIGNAL_PATH = '/signal';
const DEFAULT_SIGNAL_KEY = 'bc_signal_urls';

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302'] }];

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
  brainQuery: document.getElementById('brainQuery'),
  brainAsk: document.getElementById('brainAsk'),
  brainAnswer: document.getElementById('brainAnswer'),
  chat: document.getElementById('chat'),
  msg: document.getElementById('msg'),
  send: document.getElementById('send'),
  btnSync: document.getElementById('btnSync'),
  btnExport: document.getElementById('btnExport'),
  btnImport: document.getElementById('btnImport'),
  btnReset: document.getElementById('btnReset'),
  signalUrl: document.getElementById('signalUrl'),
  btnSaveSignal: document.getElementById('btnSaveSignal'),
};

function toast(msg){
  try{
    let t=document.getElementById('toast');
    if(!t){
      t=document.createElement('div');
      t.id='toast';
      t.style.position='fixed';
      t.style.left='50%';
      t.style.bottom='18px';
      t.style.transform='translateX(-50%)';
      t.style.padding='10px 14px';
      t.style.borderRadius='14px';
      t.style.background='rgba(0,0,0,.65)';
      t.style.border='1px solid rgba(255,255,255,.15)';
      t.style.color='white';
      t.style.fontWeight='800';
      t.style.zIndex='9999';
      t.style.maxWidth='86vw';
      t.style.textAlign='center';
      document.body.appendChild(t);
    }
    t.textContent=msg;
    t.style.opacity='1';
    clearTimeout(t._h);
    t._h=setTimeout(()=>{t.style.opacity='0';},1800);
  }catch{}
}

function esc(s){ return String(s).replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

async function initDB(){
  db = await openDB(DB_NAME, DB_VER, {
    upgrade(db, oldV){
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

      // Offline "chat brain"
      if(!db.objectStoreNames.contains('kb_docs')) db.createObjectStore('kb_docs', { keyPath:'id' });
      if(!db.objectStoreNames.contains('kb_terms')) db.createObjectStore('kb_terms', { keyPath:'term' });
      if(!db.objectStoreNames.contains('kb_entities')) db.createObjectStore('kb_entities', { keyPath:'key' });
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

function getSavedSignalUrls(){
  try{
    const raw=localStorage.getItem(DEFAULT_SIGNAL_KEY);
    if(!raw) return null;
    const arr=JSON.parse(raw);
    if(Array.isArray(arr) && arr.length) return arr;
  }catch{}
  return null;
}

function signalUrls(){
  const saved = getSavedSignalUrls();
  if(saved) return saved;

  // same-origin route (requires a WebSocket endpoint at /signal, e.g. Cloudflare Worker)
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return [ proto + location.host + DEFAULT_SIGNAL_PATH ];
}

let signal, p2p;

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

  // IMPORTANT: never keep an IndexedDB transaction open across an await
  // (it may auto-close, causing TransactionInactiveError).
  const tx1 = db.transaction(['channels'], 'readonly');
  const store1 = tx1.objectStore('channels');
  const existing = await reqDone(store1.get(channelId));
  await txDone(tx1);

  if(!existing){
    await appendSTA(db, identity, 'channel.open', { channelId, peerHid });

    const tx2 = db.transaction(['channels'], 'readwrite');
    tx2.objectStore('channels').put({
      channelId,
      peerHid,
      lastPulledSeq: 0,
      lastAckedSeq: 0,
      createdAt: Date.now()
    });
    await txDone(tx2);
  }

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
  `).join('') || `<div class="tiny">No contacts yet. Add a HID.</div>`;

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
    els.chat.innerHTML = `<div class="tiny">Pick a contact.</div>`;
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
  `).join('') || `<div class="tiny">No messages yet.</div>`;

  els.chat.scrollTop = els.chat.scrollHeight;
}

async function getChannelRec(channelId){
  const tx=db.transaction(['channels'],'readonly');
  const s=tx.objectStore('channels');
  const ch=await reqDone(s.get(channelId));
  await txDone(tx);
  return ch || null;
}

async function setChannelRec(channelId, patch){
  const tx=db.transaction(['channels'],'readwrite');
  const s=tx.objectStore('channels');
  const ch=await reqDone(s.get(channelId));
  if(ch){
    Object.assign(ch, patch);
    s.put(ch);
  }
  await txDone(tx);
}

async function maybeSync(peerHid){
  if(!peerHid) return;
  const channelId = await ensureChannel(peerHid);

  // dial if needed
  try{
    if(!p2p.isConnected(peerHid)){
      await p2p.dial(peerHid);
      await p2p.waitConnected(peerHid, 6000);
    }
  }catch{}

  if(!p2p.isConnected(peerHid)){
    toast('Saved locally. P2P offline (will deliver when receiver is online).');
    return;
  }

  const ch = await getChannelRec(channelId);
  const since = Number(ch?.lastPulledSeq || 0);
  await p2p.sendPull(peerHid, channelId, since);
}

async function addContact(hid){
  hid = String(hid||'').trim();
  if(!hid.startsWith('HID-')) { toast('Invalid HID'); return; }
  if(hid === identity.hid) { toast('That is your HID'); return; }

  await appendSTA(db, identity, 'contact.add', { hid });
  const tx=db.transaction(['contacts'],'readwrite');
  tx.objectStore('contacts').put({ hid, nickname:null, addedAt: Date.now() });
  await txDone(tx);
  els.peerHid.value='';
  await renderContacts();
}

async function sendPoke(toHid, channelId){
  // Best-effort: poke via signaling (no message content).
  try{ signal.send(toHid, { kind:'poke', channelId, ts: Date.now() }); }catch{}
}

async function commitIntent(peerHid, text){
  const channelId = await ensureChannel(peerHid);
  const seqInChannel = await nextSeq(channelId, peerHid);
  const msgId = `${channelId}:${seqInChannel}:${randomHex(10)}`;
  await appendSTA(db, identity, 'msg.intent', { channelId, toHid: peerHid, msgId, seqInChannel, text });
  // index locally for offline search
  try{ await kbUpsertMessage(db, { id: msgId, peerHid, dir:'out', ts: Date.now(), text }); }catch{}
  return { channelId, peerHid, msgId, seqInChannel };
}

async function sendMessage(){
  const text = (els.msg.value || '').trim();
  if(!text) return;
  if(!activePeer){ toast('Select a contact first.'); return; }

  els.msg.value='';

  try{
    const intent = await commitIntent(activePeer, text);
    await refreshMeta();
    await refreshChat();

    // notify receiver (no content), then try immediate sync
    await sendPoke(activePeer, intent.channelId);
    await maybeSync(activePeer);
  }catch(e){
    console.error(e);
    toast('Failed to save message.');
  }
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
  await new Promise((res)=>{
    const req=indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess=()=>res();
    req.onerror=()=>res();
    req.onblocked=()=>res();
  });
  location.reload();
}

// ---- Network ----
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
        // receiver got poke -> sync that peer
        if(await isContact(from)) await maybeSync(from);
        return;
      }
      if(data.kind === 'presence'){
        await putPresence(from, data.ts || Date.now(), data.ttl||120, data.hints||null);
        return;
      }
    },
    onStatus: (s) => {
      const txt = s.state + (s.url ? ` (${String(s.url).replace(/^wss?:\/\//,'')})` : '');
      els.signalStatus.textContent = txt;
    }
  });

  const turn = (window.__TURN && window.__TURN.urls) ? [window.__TURN] : [];
  const iceServers = ICE_SERVERS.concat(turn);

  p2p = new P2PManager({
    myHid: identity.hid,
    signal,
    rtcOverride: { iceServers },
    ecdh: { publicJwk: identity.ecdhPubJwk, privateKey: identity.ecdhPrivKey },

    // Sender: receiver pulls from us -> return outbox items
    onPullRequest: async ({from, channelId, sinceSeq}) => {
      return { items: await getOutboxItems(channelId, from, sinceSeq) };
    },

    // Receiver: we got batch of intents from sender -> settle locally + ack
    onIntentBatch: async ({from, channelId, items}) => {
      let maxSeq = 0;
      for(const it of (items||[])){
        maxSeq = Math.max(maxSeq, Number(it.seq||0));
        await appendSTA(db, identity, 'msg.delivered', {
          channelId,
          fromHid: from,
          msgId: it.msgId,
          seqInChannel: it.seq,
          text: it.text
        });
        try{ await kbUpsertMessage(db, { id: it.msgId, peerHid: from, dir:'in', ts: it.ts||Date.now(), text: it.text }); }catch{}
      }

      if(maxSeq>0){
        await setChannelRec(channelId, { lastPulledSeq: maxSeq });
        await appendSTA(db, identity, 'msg.ack', { channelId, peerHid: from, upToSeq: maxSeq });
        await p2p.sendAck(from, channelId, maxSeq);
      }

      if(from === activePeer) await refreshChat();
      await refreshMeta();
    },

    // Sender: receiver acked -> mark delivered
    onAck: async ({from, channelId, upToSeq}) => {
      await markOutboxDelivered(channelId, from, upToSeq);
      if(from === activePeer) await refreshChat();
    },

    onStatus: (s) => {
      els.p2pStatus.textContent = s.peerHid ? `${s.peerHid.slice(0,10)}… ${s.state}` : String(s.state||'');
    }
  });

  signal.start();

  // presence heartbeat (best effort)
  setInterval(async ()=>{
    const cs = await listContacts();
    if(cs.length && signal.isOpen()){
      const payload = { kind:'presence', ts: Date.now(), ttl: 120, hints: null };
      signal.broadcast(cs.map(x=>x.hid), payload);
    }
  }, 45000);
}

async function isContact(hid){
  const tx=db.transaction(['contacts'],'readonly');
  const rec=await reqDone(tx.objectStore('contacts').get(hid));
  await txDone(tx);
  return !!rec;
}

// ---- Chat Brain ----
async function runBrain(){
  const q = (els.brainQuery.value||'').trim();
  if(!q){ els.brainAnswer.textContent='—'; return; }
  const peer = activePeer || null;
  const hits = await kbSearch(db, q, { peerHid: peer, limit: 12 });
  if(!hits.length){
    els.brainAnswer.textContent = 'No matches (offline).';
    return;
  }
  const lines = hits.map(h=>{
    const when = new Date(h.ts||Date.now()).toLocaleString();
    const who = h.dir==='out' ? 'Me →' : '← Peer';
    const text = String(h.text||'').slice(0,200);
    return `• ${when}  ${who}  ${text}`;
  });
  els.brainAnswer.textContent = lines.join('\n');
}

// ---- UI wiring ----
els.btnAdd.onclick = ()=> addContact(els.peerHid.value);
els.send.onclick = ()=> sendMessage();
els.btnSync.onclick = ()=> { if(activePeer) maybeSync(activePeer); };
els.btnExport.onclick = ()=> exportAll();
els.btnImport.onclick = ()=> importAll();
els.btnReset.onclick = ()=> hardReset();

els.brainAsk.onclick = ()=> runBrain();
els.brainQuery.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); runBrain(); } });

els.msg.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); sendMessage(); } });

els.btnSaveSignal.onclick = ()=>{
  const v = String(els.signalUrl.value||'').trim();
  if(!v){
    localStorage.removeItem(DEFAULT_SIGNAL_KEY);
    toast('Signal URL cleared. Using same-origin /signal.');
    return;
  }
  const arr = v.split(',').map(s=>s.trim()).filter(Boolean);
  localStorage.setItem(DEFAULT_SIGNAL_KEY, JSON.stringify(arr));
  toast('Signal URL saved. Reloading…');
  location.reload();
};

// ---- boot ----
(async function main(){
  await initDB();
  await ensureIdentity();
  await refreshMeta();

  // show saved signal url (if any)
  const saved = getSavedSignalUrls();
  els.signalUrl.value = saved ? saved.join(',') : '';

  await renderContacts();

  // register SW
  if('serviceWorker' in navigator){
    try{ await navigator.serviceWorker.register('./sw.js'); }catch{}
  }

  await initNetwork();
})();