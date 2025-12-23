// BalanceChain local core: canonicalize + hashing + STA append (Safari/iOS safe)
import { txDone, reqDone } from './idb.js';

// DO NOT MODIFY: Locked for cross-runtime determinism
export function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  return [...bytes].map(b => b.toString(16).padStart(2,'0')).join('');
}

export function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2,'0')).join('');
}

export async function exportKeyJwk(publicKey) {
  return await crypto.subtle.exportKey('jwk', publicKey);
}

export async function importPubKeyJwk(jwk) {
  return await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
}

export async function sign(privateKey, dataStr) {
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(dataStr)
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function verify(publicKey, dataStr, sigB64) {
  try {
    const sigBytes = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      sigBytes,
      new TextEncoder().encode(dataStr)
    );
  } catch {
    return false;
  }
}

export async function getMeta(db, key) {
  const tx = db.transaction(['meta'], 'readonly');
  const store = tx.objectStore('meta');
  const val = await reqDone(store.get(key));
  await txDone(tx);
  return val?.value ?? null;
}

export async function setMeta(db, key, value) {
  const tx = db.transaction(['meta'], 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await txDone(tx);
}

export async function getChainHead(db) {
  return (await getMeta(db, 'chain_head')) || 'GENESIS';
}

export async function getChainLen(db) {
  return (await getMeta(db, 'chain_len')) || 0;
}

export function createSTA(identity, prevHash, seq, type, payload) {
  return {
    v: 1,
    hik: identity.hik,
    seq,
    timestamp: Date.now(),
    nonce: randomHex(16),
    type,
    payload,
    prev_hash: prevHash,
    author: { hik: identity.hik, pubJwk: identity.pubJwk },
  };
}

export function staSignable(sta) {
  const clean = { ...sta };
  delete clean.signature;
  return canonicalize(clean);
}

export async function appendSTA(db, identity, type, payload) {
  const prevHash = await getChainHead(db);
  const prevLen = await getChainLen(db);
  const seq = prevLen + 1;

  const sta = createSTA(identity, prevHash, seq, type, payload);
  const signable = staSignable(sta);

  const bodyHash = await sha256Hex(signable);
  const signature = await sign(identity.privateKey, bodyHash);
  sta.signature = signature;

  const newHead = await sha256Hex(`${prevHash}|${bodyHash}|${signature}|${sta.nonce}|${sta.seq}`);

  return new Promise((resolve) => {
    const tx = db.transaction(['state_chain','sync_log','messages','meta'], 'readwrite');
    const stateChain = tx.objectStore('state_chain');
    const syncLog = tx.objectStore('sync_log');
    const messages = tx.objectStore('messages');
    const meta = tx.objectStore('meta');

    const checkReq = syncLog.get(sta.nonce);
    checkReq.onsuccess = () => {
      if (checkReq.result) {
        try { tx.abort(); } catch {}
        resolve({ ok:false, reason:'replay' });
        return;
      }

      stateChain.add(sta);
      syncLog.add({ nonce: sta.nonce, ts: sta.timestamp });

      if (sta.type === 'chat.append') {
        messages.add({
          id: `${sta.seq}:${sta.nonce}`,
          seq: sta.seq,
          ts: sta.timestamp,
          text: String(sta.payload?.text ?? ''),
          hik: sta.hik
        });
      }

      meta.put({ key:'chain_head', value:newHead });
      meta.put({ key:'chain_len', value:sta.seq });
    };

    checkReq.onerror = () => {
      try { tx.abort(); } catch {}
      resolve({ ok:false, reason:'nonce_check_failed' });
    };

    tx.oncomplete = () => resolve({ ok:true, head:newHead, len:sta.seq });
    tx.onabort = () => resolve({ ok:false, reason:'tx_abort', error:String(tx.error || 'tx abort') });
    tx.onerror = () => resolve({ ok:false, reason:'tx_error', error:String(tx.error || 'tx error') });
  });
}


// Compute a stable Human ID (HID) from an ECDSA public JWK.
// Deterministic: canonical JSON of selected fields -> sha256 -> HID-<hex...>
export async function computeHID(pubJwk){
  const pick = {
    kty: pubJwk.kty, crv: pubJwk.crv,
    x: pubJwk.x, y: pubJwk.y
  };
  const h = await sha256Hex(canonicalize(pick));
  return 'HID-' + h.slice(0, 28) + h.slice(28, 44); // 44 hex chars (~176 bits)
}

// Derive a stable channel id for two HIDs (order-independent).
export async function deriveChannelId(hidA, hidB){
  const [a,b] = [String(hidA), String(hidB)].sort();
  const h = await sha256Hex(`${a}|${b}`);
  return 'CH-' + h.slice(0, 24);
}
