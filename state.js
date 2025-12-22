// BalanceChain local core: canonicalize + hashing + STA append/validate
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
  return await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
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
  return await getMeta(db, 'chain_head') || 'GENESIS';
}

export async function getChainLen(db) {
  return (await getMeta(db, 'chain_len')) || 0;
}

export async function createSTA({ hik, pubJwk }, prevHash, seq, type, payload) {
  const sta = {
    v: 1,
    hik,
    seq,
    timestamp: Date.now(),
    nonce: randomHex(16),
    type,
    payload,
    prev_hash: prevHash,
    author: { hik, pubJwk },
  };
  return sta;
}

export function staSignable(sta) {
  const clean = { ...sta };
  delete clean.signature;
  return canonicalize(clean);
}

export async function appendSTA(db, identity, payload) {
  // 1️⃣ Do ALL async work FIRST
  const canonical = canonicalize(payload);
  const hash = await sha256(canonical);
  const sig = await sign(identity.privateKey, hash);
  const sta = {
    payload,
    hash,
    sig,
    nonce: crypto.randomUUID(),
    ts: Date.now()
  };

  // 2️⃣ ONLY NOW open IndexedDB transaction
  return new Promise((resolve) => {
    const tx = db.transaction(['chain', 'nonces'], 'readwrite');
    const chain = tx.objectStore('chain');
    const nonces = tx.objectStore('nonces');

    nonces.get(sta.nonce).onsuccess = (e) => {
      if (e.target.result) {
        tx.abort();
        resolve(false);
        return;
      }

      chain.add(sta);
      nonces.add({ nonce: sta.nonce });

      tx.oncomplete = () => resolve(true);
      tx.onabort = () => resolve(false);
    };
  });
}


  // Atomic transaction: chain + nonce log + interpreted store (messages)
  const tx = db.transaction(['state_chain','sync_log','messages','meta'], 'readwrite');
  try {
    tx.objectStore('state_chain').add(sta);
    tx.objectStore('sync_log').add({ nonce: sta.nonce, ts: sta.timestamp });

    if (sta.type === 'chat.append') {
      tx.objectStore('messages').add({
        id: `${sta.seq}:${sta.nonce}`,
        seq: sta.seq,
        ts: sta.timestamp,
        text: String(sta.payload?.text ?? ''),
        hik: sta.hik
      });
    }

    const head = await sha256Hex(signable + '|' + sta.signature);
    tx.objectStore('meta').put({ key: 'chain_head', value: head });
    tx.objectStore('meta').put({ key: 'chain_len', value: sta.seq });

    await txDone(tx);
    return { ok: true, head, len: sta.seq };
  } catch (e) {
    try { tx.abort(); } catch {}
    return { ok: false, reason: 'tx_abort', error: String(e?.message ?? e) };
  }
}
