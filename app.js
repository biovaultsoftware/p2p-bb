import { openDB, txDone, reqDone } from './idb.js';
import { appendSTA, exportKeyJwk, importPubKeyJwk, randomHex, getChainHead, getChainLen } from './state.js';

const DB_NAME = 'balancechain_html_pwa';
const DB_VER = 2;

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
  iosSheet: document.getElementById('iosSheet'),
  btnCloseSheet: document.getElementById('btnCloseSheet'),
};

const BACKUP_URL = './__bc_backup.json';

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

function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
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

  const standalone = isStandalone();
  const ios = isIOS();
  els.pwaStatus.className = standalone ? 'ok' : 'warn';
  if (standalone) els.pwaStatus.textContent = 'PWA: installed';
  else if (ios) els.pwaStatus.textContent = 'PWA: iOS (Share → Add to Home Screen)';
  else els.pwaStatus.textContent = 'PWA: not installed';
}

async function sendLocal(identity) {
  const text = els.msg.value.trim();
  if (!text) return;
  els.msg.value = '';

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

async function exportAllToObject() {
  const exportObj = {};
  for (const storeName of ['state_chain','sync_log','messages','meta','keys']) {
    const tx = db.transaction([storeName], 'readonly');
    exportObj[storeName] = await reqDone(tx.objectStore(storeName).getAll());
    await txDone(tx);
  }
  return exportObj;
}

async function downloadExport(exportObj) {
  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'balancechain-export.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function exportAll() {
  const exportObj = await exportAllToObject();
  await downloadExport(exportObj);
  return exportObj;
}

async function importFromObject(obj) {
  const stores = ['state_chain','sync_log','messages','meta','keys'];
  const tx = db.transaction(stores, 'readwrite');
  try {
    for (const s of stores) tx.objectStore(s).clear();

    (obj.state_chain || []).sort((a,b)=>a.seq-b.seq).forEach(r => tx.objectStore('state_chain').put(r));
    (obj.sync_log || []).forEach(r => tx.objectStore('sync_log').put(r));
    (obj.messages || []).sort((a,b)=>a.seq-b.seq).forEach(r => tx.objectStore('messages').put(r));
    (obj.meta || []).forEach(r => tx.objectStore('meta').put(r));
    (obj.keys || []).forEach(r => tx.objectStore('keys').put(r));
  } catch (e) {
    try { tx.abort(); } catch {}
    throw e;
  }
  await txDone(tx);
}

async function importAll() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const txt = await file.text();
    const obj = JSON.parse(txt);
    await importFromObject(obj.data ? obj.data : obj);
    location.reload();
  };
  input.click();
}

async function hasAnyMessages() {
  const tx = db.transaction(['messages'], 'readonly');
  const count = await reqDone(tx.objectStore('messages').count());
  await txDone(tx);
  return (count || 0) > 0;
}

// ---------- Service Worker ----------
async function setupSW() {
  if (!('serviceWorker' in navigator)) {
    els.swStatus.className = 'warn';
    els.swStatus.textContent = 'SW: not supported';
    return;
  }
  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    els.swStatus.className = 'ok';
    els.swStatus.textContent = 'SW: registered';
  } catch (e) {
    els.swStatus.className = 'err';
    els.swStatus.textContent = 'SW: failed';
    console.warn('SW register failed', e);
  }
}

function swPost(msg) {
  return new Promise((resolve) => {
    if (!navigator.serviceWorker?.controller) return resolve({ ok:false, reason:'no_controller' });
    const onMsg = (ev) => {
      const d = ev.data || {};
      if (d.type === 'BACKUP_SAVED' || d.type === 'BACKUP_CLEARED') {
        navigator.serviceWorker.removeEventListener('message', onMsg);
        resolve(d);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    navigator.serviceWorker.controller.postMessage(msg);
    setTimeout(() => {
      navigator.serviceWorker.removeEventListener('message', onMsg);
      resolve({ ok:false, reason:'timeout' });
    }, 3000);
  });
}

async function saveBackupToSW(exportObj) {
  const res = await swPost({ type:'SAVE_BACKUP', payload: exportObj });
  return !!res.ok;
}

async function tryAutoRestoreFromSW() {
  const any = await hasAnyMessages();
  if (any) return false;

  try {
    const r = await fetch(BACKUP_URL, { cache: 'no-store' });
    if (!r.ok) return false;
    const j = await r.json();
    const obj = j.data || j;
    if (!obj || !obj.messages || obj.messages.length === 0) return false;

    await importFromObject(obj);
    await swPost({ type:'CLEAR_BACKUP' });
    return true;
  } catch (e) {
    console.warn('Auto-restore failed', e);
    return false;
  }
}

// ---------- Install Flow ----------
function setupInstall() {
  const ios = isIOS();

  if (ios) {
    els.btnInstall.style.display = 'inline-flex';
    els.btnInstall.textContent = 'Install (iOS)';
    els.btnInstall.onclick = () => { els.iosSheet.style.display = 'flex'; };
    els.btnCloseSheet.onclick = () => { els.iosSheet.style.display = 'none'; };
    return;
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    els.btnInstall.style.display = 'inline-flex';
  });

  els.btnInstall.onclick = async () => {
    if (!installPrompt) return;

    els.btnInstall.disabled = true;
    els.btnInstall.textContent = 'Preparing…';

    // ✅ One-click automation:
    // 1) Export (downloads file)
    // 2) Save the same backup into SW cache
    // 3) Trigger install prompt
    try {
      const exportObj = await exportAllToObject();
      await downloadExport(exportObj);
      await saveBackupToSW(exportObj);
    } catch (e) {
      console.warn('Pre-install backup failed', e);
    }

    els.btnInstall.textContent = 'Installing…';
    installPrompt.prompt();
    await installPrompt.userChoice;

    installPrompt = null;
    els.btnInstall.style.display = 'none';
    els.btnInstall.disabled = false;
    els.btnInstall.textContent = 'Install';
  };
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && db) {
    try { await loadMessages(); } catch {}
  }
});

(async function main(){
  await initDB();

  // SW first (needed for backup bridge)
  await setupSW();

  // Auto-restore if this is a fresh install
  const restored = await tryAutoRestoreFromSW();
  if (restored) {
    location.reload();
    return;
  }

  const identity = await getOrCreateIdentity();
  await refreshStatus(identity.hik);
  await loadMessages();

  els.send.onclick = () => sendLocal(identity);
  els.msg.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendLocal(identity); });

  els.btnReset.onclick = resetAll;
  els.btnExport.onclick = exportAll;
  els.btnImport.onclick = importAll;

  setupInstall();
})();
