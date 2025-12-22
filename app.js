import { openDB, txDone, reqDone } from './idb.js';
import {
  appendSTA,
  exportKeyJwk, importPubKeyJwk, randomHex, getChainHead, getChainLen
} from './state.js';

const DB_NAME = 'balancechain_html_pwa';
const DB_VER = 1;

let db;
let installPrompt = null;

const els = {
  chat: document.getElementById('chat'),
  msg: document.getElementById('msg'),
  send: document.getElementById('send'),
  hik: document.getElementById('hik'),
  head: document.getElementById('head'),
  len: document.getElementById('len'),
  btnReset: document.getElementById('btnReset'),
  btnExport: document.getElementById('btnExport'),
  btnImport: document.getElementById('btnImport'),
  btnInstall: document.getElementById('btnInstall'),
  pwaStatus: document.getElementById('pwaStatus'),
  swStatus: document.getElementById('swStatus'),
};

function bubble(text, meta, cls='me'){
  const d = document.createElement('div');
  d.className = `bubble ${cls}`;
  d.appendChild(document.createTextNode(text));
  const m = document.createElement('div');
  m.className = 'small';
  m.textContent = meta;
  d.appendChild(m);
  return d;
}

async function initDB() {
  db = await openDB(DB_NAME, DB_VER, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('state_chain')) db.createObjectStore('state_chain', { keyPath: 'seq' });
      if (!db.objectStoreNames.contains('sync_log')) db.createObjectStore('sync_log', { keyPath: 'nonce' });
      if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys', { keyPath: 'key' });
    }
  });
}

async function getOrCreateIdentity() {
  const tx = db.transaction(['keys'], 'readonly');
  const rec = await reqDone(tx.objectStore('keys').get('identity'));
  await txDone(tx);

  if (rec?.value?.privJwk && rec?.value?.pubJwk && rec?.value?.hik) {
    const priv = await crypto.subtle.importKey('jwk', rec.value.privJwk, { name:'ECDSA', namedCurve:'P-256' }, true, ['sign']);
    const pub = await importPubKeyJwk(rec.value.pubJwk);
    return { hik: rec.value.hik, privateKey: priv, publicKey: pub, pubJwk: rec.value.pubJwk };
  }

  const keypair = await crypto.subtle.generateKey({ name:'ECDSA', namedCurve:'P-256' }, true, ['sign','verify']);
  const pubJwk = await exportKeyJwk(keypair.publicKey);
  const privJwk = await crypto.subtle.exportKey('jwk', keypair.privateKey);
  const hik = 'HIK-' + randomHex(8);

  const wtx = db.transaction(['keys'], 'readwrite');
  wtx.objectStore('keys').put({ key: 'identity', value: { hik, pubJwk, privJwk } });
  await txDone(wtx);

  return { hik, privateKey: keypair.privateKey, publicKey: keypair.publicKey, pubJwk };
}

async function loadMessages() {
  els.chat.innerHTML = '';
  const tx = db.transaction(['messages'], 'readonly');
  const all = await reqDone(tx.objectStore('messages').getAll());
  await txDone(tx);

  all.sort((a,b) => a.seq - b.seq);
  for (const m of all) {
    els.chat.appendChild(bubble(m.text, new Date(m.ts).toLocaleString(), 'me'));
  }
  els.chat.scrollTop = els.chat.scrollHeight;
}

async function refreshStatus(hik) {
  els.hik.textContent = hik;
  const head = await getChainHead(db);
  els.head.textContent = head === 'GENESIS' ? 'GENESIS' : head.slice(0, 24) + '…';
  els.len.textContent = String(await getChainLen(db));
}

async function sendLocal(identity) {
  const text = els.msg.value.trim();
  if (!text) return;
  els.msg.value = '';

  // One call: appendSTA() handles deterministic STA construction, signing, replay guard, and atomic writes.
  const res = await appendSTA(db, identity, 'chat.append', { text });
  if (!res.ok) {
    els.chat.appendChild(bubble('Append rejected: ' + res.reason, new Date().toLocaleString(), 'sys'));
  } else {
    await loadMessages();
    await refreshStatus(identity.hik);
  }
}

async function resetAll() {
  if (!confirm('Reset local state? This deletes all local data for this PWA.')) return;
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => alert('Close other tabs using this app and try again.');
  });
  location.reload();
}

async function exportAll() {
  const exportObj = {};
  for (const storeName of ['state_chain','sync_log','messages','meta','keys']) {
    const tx = db.transaction([storeName], 'readonly');
    exportObj[storeName] = await reqDone(tx.objectStore(storeName).getAll());
    await txDone(tx);
  }
  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'balancechain-export.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function importAll() {
  alert('Import is intentionally minimal in this build. Use Export for backup. Full import/merge can be added later without breaking local determinism.');
}

function setupInstall() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  // iOS Safari does not support beforeinstallprompt. Install is via Share -> Add to Home Screen.
  if (isIOS) {
    els.btnInstall.style.display = 'none';
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    els.btnInstall.style.display = 'inline-flex';
  });
  els.btnInstall.onclick = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    els.btnInstall.style.display = 'none';
  };
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  els.pwaStatus.className = isStandalone ? 'ok' : 'warn';
  if (isStandalone) {
    els.pwaStatus.textContent = 'PWA: installed';
  } else if (isIOS) {
    els.pwaStatus.textContent = 'PWA: iOS (Share → Add to Home Screen)';
  } else {
    els.pwaStatus.textContent = 'PWA: not installed';
  }
}

async function setupSW() {
  if (!('serviceWorker' in navigator)) {
    els.swStatus.className = 'warn';
    els.swStatus.textContent = 'SW: not supported';
    return;
  }
  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
    els.swStatus.className = 'ok';
    els.swStatus.textContent = 'SW: registered';
  } catch (e) {
    els.swStatus.className = 'err';
    els.swStatus.textContent = 'SW: failed';
    console.warn('SW register failed', e);
  }
}

(async function main(){
  await initDB();
  const identity = await getOrCreateIdentity();
  await refreshStatus(identity.hik);
  await loadMessages();

  els.send.onclick = () => sendLocal(identity);
  els.msg.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendLocal(identity); });

  els.btnReset.onclick = resetAll;
  els.btnExport.onclick = exportAll;
  els.btnImport.onclick = importAll;

  setupInstall();
  await setupSW();
})();
