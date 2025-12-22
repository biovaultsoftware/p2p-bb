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


// Public address: HID derived from public key (stable, shareable)
export async function computeHID(pubJwk) {
  const body = canonicalize(pubJwk);
  const h = await sha256Hex(body);
  return 'HID-' + h.slice(0, 24);
}

export async function deriveChannelId(hidA, hidB, genesis='1736565605') {
  const a = String(hidA||'');
  const b = String(hidB||'');
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return 'CH-' + (await sha256Hex(`${lo}|${hi}|${genesis}`)).slice(0, 32);
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
    const tx = db.transaction(['state_chain','sync_log','messages','meta','contacts','channels','outbox','presence','pokes'], 'readwrite');
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

      // Lightning Messaging interpreter (deterministic, store-only)
      if (sta.type === 'chat.append') {
        messages.add({
          id: `${sta.seq}:${sta.nonce}`,
          seq: sta.seq,
          ts: sta.timestamp,
          text: String(sta.payload?.text ?? ''),
          hik: sta.hik,
          channelId: null,
          peer: null,
          dir: 'local'
        });
      }

      if (sta.type === 'contact.add') {
        const hid = String(sta.payload?.hid ?? '');
        if (hid) {
          tx.objectStore('contacts').put({ hid, nickname: null, addedAt: sta.timestamp });
        }
      }

      if (sta.type === 'channel.open') {
        const channelId = String(sta.payload?.channelId ?? '');
        const peerHid = String(sta.payload?.peerHid ?? '');
        if (channelId && peerHid) {
          tx.objectStore('channels').put({ channelId, peerHid, lastPulledSeq: 0, lastAckedSeq: 0, createdAt: sta.timestamp });
        }
      }

      // Sender-held message intent: stored in outbox (not in messages) until receiver settles
      if (sta.type === 'msg.intent') {
        const channelId = String(sta.payload?.channelId ?? '');
        const toHid = String(sta.payload?.toHid ?? '');
        const msgId = String(sta.payload?.msgId ?? '');
        const seqInChannel = Number(sta.payload?.seqInChannel ?? 0);
        const text = String(sta.payload?.text ?? '');
        if (channelId && toHid && msgId) {
          tx.objectStore('outbox').put({
            id: msgId,
            channelId,
            toHid,
            seqInChannel,
            text,
            createdAt: sta.timestamp,
            status: 'pending'
          });
        }
      }

      // Receiver settlement: becomes the visible message in messages
      if (sta.type === 'msg.delivered') {
        const channelId = String(sta.payload?.channelId ?? '');
        const fromHid = String(sta.payload?.fromHid ?? '');
        const msgId = String(sta.payload?.msgId ?? '');
        const seqInChannel = Number(sta.payload?.seqInChannel ?? 0);
        const text = String(sta.payload?.text ?? '');
        if (channelId && fromHid && msgId) {
          messages.add({
            id: `${sta.seq}:${sta.nonce}`,
            seq: sta.seq,
            ts: sta.timestamp,
            text,
            hik: sta.hik,
            channelId,
            peer: fromHid,
            seqInChannel,
            msgId,
            dir: 'in'
          });
        }
      }

      if (sta.type === 'msg.sent') {
        // Optional: local echo when sender commits intent (shown as pending)
        const channelId = String(sta.payload?.channelId ?? '');
        const toHid = String(sta.payload?.toHid ?? '');
        const msgId = String(sta.payload?.msgId ?? '');
        const seqInChannel = Number(sta.payload?.seqInChannel ?? 0);
        const text = String(sta.payload?.text ?? '');
        if (channelId && toHid && msgId) {
          messages.add({
            id: `${sta.seq}:${sta.nonce}`,
            seq: sta.seq,
            ts: sta.timestamp,
            text,
            hik: sta.hik,
            channelId,
            peer: toHid,
            seqInChannel,
            msgId,
            dir: 'out'
          });
        }
      }

      if (sta.type === 'msg.ack') {
        const channelId = String(sta.payload?.channelId ?? '');
        const peerHid = String(sta.payload?.peerHid ?? '');
        const upToSeq = Number(sta.payload?.upToSeq ?? 0);
        if (channelId && peerHid) {
          tx.objectStore('channels').put({ channelId, peerHid, lastPulledSeq: upToSeq, lastAckedSeq: upToSeq, createdAt: sta.timestamp });
        }
      }

      if (sta.type === 'presence.self') {
        const ttl = Number(sta.payload?.ttl ?? 120);
        tx.objectStore('presence').put({
          hid: String(sta.payload?.hid ?? sta.hik ?? ''),
          ts: sta.timestamp,
          expiresAt: sta.timestamp + ttl*1000,
          hints: sta.payload?.hints ?? null
        });
      }

      if (sta.type === 'poke.recv') {
        const id = String(sta.payload?.id ?? sta.nonce);
        tx.objectStore('pokes').put({
          id,
          fromHid: String(sta.payload?.fromHid ?? ''),
          toHid: String(sta.payload?.toHid ?? ''),
          channelId: String(sta.payload?.channelId ?? ''),
          ts: sta.timestamp,
          expiresAt: sta.timestamp + Number(sta.payload?.ttl ?? 300)*1000
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
