// kb.js - offline "chat brain" index (no cloud)
// Stores a lightweight inverted index + entity index for fast offline search.

const STOP = new Set(["a","an","the","and","or","but","to","of","in","on","for","with","is","are","was","were","be","been","this","that","it","as","at","by","from"]);

export function normalizeText(s){
  return String(s||"")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g,'')
    .replace(/[^a-z0-9\u0600-\u06FF\s\.\-\_\@\#\$\%\/\:]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

export function tokenize(s){
  const t = normalizeText(s);
  if (!t) return [];
  const parts = t.split(' ');
  const out = [];
  for (const p of parts){
    if (!p) continue;
    if (p.length < 2) continue;
    if (STOP.has(p)) continue;
    out.push(p);
  }
  return out.slice(0, 2000);
}

export function extractEntities(raw){
  const s = String(raw||"");
  const out = { phones:[], emails:[], money:[], dates:[] };

  // emails
  const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
  out.emails = (s.match(emailRe) || []).slice(0,20);

  // phones (very loose)
  const phoneRe = /(?:\+?\d[\d\s\-]{7,}\d)/g;
  out.phones = (s.match(phoneRe) || []).slice(0,20);

  // money
  const moneyRe = /(?:\b(?:qar|usd|eur|gbp|sar|aed)\b\s*\d[\d,\.]*)|(?:\d[\d,\.]*\s*\b(?:qar|usd|eur|gbp|sar|aed)\b)/ig;
  out.money = (s.match(moneyRe) || []).slice(0,20);

  // dates (basic)
  const dateRe = /\b(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/g;
  out.dates = (s.match(dateRe) || []).slice(0,20);

  return out;
}

function uniq(arr){
  return Array.from(new Set(arr));
}

export async function kbUpsertMessage(db, doc){
  // doc: { id, peerHid, dir, ts, text }
  const text = String(doc.text||"");
  const norm = normalizeText(text);
  const tokens = tokenize(norm);
  const ent = extractEntities(text);

  const tx = db.transaction(["kb_docs","kb_terms","kb_entities"], "readwrite");
  const docs = tx.objectStore("kb_docs");
  const terms = tx.objectStore("kb_terms");
  const ents = tx.objectStore("kb_entities");

  // upsert doc
  docs.put({
    id: doc.id,
    peerHid: doc.peerHid || null,
    dir: doc.dir || null,
    ts: doc.ts || Date.now(),
    text,
    norm,
    tokens: uniq(tokens).slice(0,400),
    entities: ent
  });

  // update inverted index (term -> doc ids)
  // We keep a compact list per term (last N docs).
  const docId = doc.id;
  const uniqueTokens = uniq(tokens).slice(0,200);
  for (const term of uniqueTokens){
    const rec = await new Promise((res)=>{ const r=terms.get(term); r.onsuccess=()=>res(r.result); r.onerror=()=>res(null); });
    const ids = rec?.ids || [];
    if (!ids.includes(docId)) ids.push(docId);
    const trimmed = ids.slice(-250);
    terms.put({ term, ids: trimmed });
  }

  // entities index: key = type:value -> doc ids
  const pairs = [];
  for (const e of ent.emails) pairs.push(["email", e.toLowerCase()]);
  for (const e of ent.phones) pairs.push(["phone", e.replace(/\s+/g,'')]);
  for (const e of ent.money) pairs.push(["money", normalizeText(e)]);
  for (const e of ent.dates) pairs.push(["date", e]);

  for (const [k,v] of pairs.slice(0,40)){
    const key = `${k}:${v}`;
    const rec = await new Promise((res)=>{ const r=ents.get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>res(null); });
    const ids = rec?.ids || [];
    if (!ids.includes(docId)) ids.push(docId);
    ents.put({ key, ids: ids.slice(-250) });
  }

  await new Promise((resolve,reject)=>{ tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error); });
}

export async function kbSearch(db, query, { peerHid=null, limit=20 } = {}){
  const q = String(query||"").trim();
  if (!q) return [];
  const tokens = tokenize(q).slice(0,12);
  const ent = extractEntities(q);

  const tx = db.transaction(["kb_terms","kb_entities","kb_docs"], "readonly");
  const terms = tx.objectStore("kb_terms");
  const ents = tx.objectStore("kb_entities");
  const docs = tx.objectStore("kb_docs");

  const candidateIds = new Set();

  async function addFromIds(ids){ for (const id of (ids||[])) candidateIds.add(id); }

  // entity matches
  const entPairs = [];
  for (const e of ent.emails) entPairs.push(`email:${e.toLowerCase()}`);
  for (const e of ent.phones) entPairs.push(`phone:${e.replace(/\s+/g,'')}`);
  for (const e of ent.money) entPairs.push(`money:${normalizeText(e)}`);
  for (const e of ent.dates) entPairs.push(`date:${e}`);
  for (const key of entPairs.slice(0,6)){
    const rec = await new Promise((res)=>{ const r=ents.get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>res(null); });
    await addFromIds(rec?.ids);
  }

  // term matches
  for (const t of tokens){
    const rec = await new Promise((res)=>{ const r=terms.get(t); r.onsuccess=()=>res(r.result); r.onerror=()=>res(null); });
    await addFromIds(rec?.ids);
  }

  // fallback: if no candidates, scan recent docs (bounded)
  let idsArr = Array.from(candidateIds);
  if (!idsArr.length){
    const all = await new Promise((res)=>{ const r=docs.getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>res([]); });
    all.sort((a,b)=>(b.ts||0)-(a.ts||0));
    idsArr = all.slice(0,200).map(d=>d.id);
  }

  const results = [];
  for (const id of idsArr.slice(0,400)){
    const d = await new Promise((res)=>{ const r=docs.get(id); r.onsuccess=()=>res(r.result); r.onerror=()=>res(null); });
    if (!d) continue;
    if (peerHid && d.peerHid !== peerHid) continue;

    // score: term hits + entity hits + recency
    let score = 0;
    const docNorm = d.norm || "";
    for (const t of tokens) if (docNorm.includes(t)) score += 2;
    for (const e of ent.emails) if (docNorm.includes(e.toLowerCase())) score += 6;
    for (const e of ent.dates) if (docNorm.includes(e)) score += 5;
    for (const e of ent.money) if (docNorm.includes(normalizeText(e))) score += 5;
    score += Math.max(0, 3 - (Date.now() - (d.ts||0)) / (1000*60*60*24*14)); // + up to 3 for last 2 weeks
    results.push({ ...d, score });
  }

  results.sort((a,b)=>b.score-a.score);
  return results.slice(0, limit);
}

export async function kbRebuildFromMessages(db){
  // Build KB from existing rendered messages store (fast enough for typical sizes)
  const tx = db.transaction(["messages"], "readonly");
  const msgs = await new Promise((res)=>{ const r=tx.objectStore("messages").getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>res([]); });
  await new Promise((resolve)=>{ tx.oncomplete=()=>resolve(); tx.onerror=()=>resolve(); tx.onabort=()=>resolve(); });

  msgs.sort((a,b)=>(a.seq||0)-(b.seq||0));
  for (const m of msgs){
    await kbUpsertMessage(db, {
      id: m.id,
      peerHid: m.peer || null,
      dir: m.dir || null,
      ts: m.ts || Date.now(),
      text: m.text || ""
    });
  }
}


// Back-compat alias (older app.js expected this name)
export async function kbIndexMessage(db, doc){
  return kbUpsertMessage(db, doc);
}
