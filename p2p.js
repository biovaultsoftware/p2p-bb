// p2p.js — WebRTC DataChannel transport (no server persistence)
// Signaling is done via SignalClient (websocket). Messages are "pull-based": receiver pulls,
// sender responds with a batch from its outbox. Optional E2EE (ECDH -> AES-GCM) for payloads.

const DEFAULT_ICE = [{ urls: ["stun:stun.l.google.com:19302"] }];
const DEFAULT_RTC_CFG = { iceServers: DEFAULT_ICE, iceCandidatePoolSize: 4 };

function makeRtcCfg(override){
  if (override && Array.isArray(override.iceServers) && override.iceServers.length){
    return { ...DEFAULT_RTC_CFG, iceServers: override.iceServers };
  }
  return DEFAULT_RTC_CFG;
}

function j(x){ try{return JSON.stringify(x);}catch{return"";} }
function b64(bytes){ return btoa(String.fromCharCode(...bytes)); }
function unb64(s){ const bin=atob(s); const out=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i); return out; }

export class P2PManager {
  constructor({ myHid, signal, ecdh, rtcOverride, onPullRequest, onIntentBatch, onAck, onStatus }) {
    this.myHid = myHid;
    this.signal = signal;
    this.ecdh = ecdh; // {publicJwk, privateKey}
    this.rtcOverride = rtcOverride || null;

    this.onPullRequest = onPullRequest || (async ()=>({items:[]}));
    this.onIntentBatch = onIntentBatch || (async ()=>{});
    this.onAck = onAck || (async ()=>{});
    this.onStatus = onStatus || (()=>{});

    this.peers = new Map(); // hid -> session
  }

  async dial(peerHid){
    const s = await this._ensure(peerHid, true);
    await this._offer(s);
    return s;
  }

  hangup(peerHid){
    const s=this.peers.get(peerHid);
    if(s) this._close(s,"hangup");
  }

  isConnected(peerHid){
    const s=this.peers.get(peerHid);
    return !!s?.dc && s.dc.readyState==="open";
  }

  async waitConnected(peerHid, timeoutMs=5000){
    const start=Date.now();
    while(Date.now()-start < timeoutMs){
      if(this.isConnected(peerHid)) return true;
      await new Promise(r=>setTimeout(r, 60));
    }
    return this.isConnected(peerHid);
  }

  async onSignal({from, data}){
    const peerHid=from;
    const msg=data||{};
    if(msg.kind==="offer"){
      const s=await this._ensure(peerHid,false);
      await s.pc.setRemoteDescription(msg.sdp);
      const ans=await s.pc.createAnswer();
      await s.pc.setLocalDescription(ans);
      this.signal.send(peerHid,{kind:"answer", sdp:s.pc.localDescription});
      return;
    }
    if(msg.kind==="answer"){
      const s=this.peers.get(peerHid); if(!s) return;
      await s.pc.setRemoteDescription(msg.sdp);
      return;
    }
    if(msg.kind==="ice"){
      const s=this.peers.get(peerHid); if(!s) return;
      try{ await s.pc.addIceCandidate(msg.candidate);}catch{}
      return;
    }
  }

  async sendAck(peerHid, channelId, upToSeq){
    const s=this.peers.get(peerHid);
    if(!s?.dc || s.dc.readyState!=="open") return false;
    s.dc.send(j({t:"ack", channelId, upToSeq}));
    return true;
  }

  async sendPull(peerHid, channelId, sinceSeq){
    const s=this.peers.get(peerHid);
    if(!s?.dc || s.dc.readyState!=="open") return false;
    s.dc.send(j({t:"pull", channelId, sinceSeq}));
    return true;
  }

  // ---- internal ----
  async _ensure(peerHid, initiator){
    let s=this.peers.get(peerHid);
    if(s) return s;

    const pc=new RTCPeerConnection(makeRtcCfg(this.rtcOverride));
    s={peerHid, pc, dc:null, initiator, sharedKey:null, peerPubJwk:null};
    this.peers.set(peerHid,s);
    this.onStatus({peerHid, state:"created"});

    pc.onicecandidate=(ev)=>{ if(ev.candidate) this.signal.send(peerHid,{kind:"ice", candidate:ev.candidate}); };
    pc.onconnectionstatechange=()=>{
      this.onStatus({peerHid, state:pc.connectionState});
      if(["failed","disconnected","closed"].includes(pc.connectionState)) this._close(s, pc.connectionState);
    };
    pc.ondatachannel=(ev)=>{ if(!s.dc) this._wire(s, ev.channel); };

    if(initiator){
      const dc=pc.createDataChannel("bc",{ordered:true});
      this._wire(s, dc);
    }
    return s;
  }

  async _offer(s){
    const offer=await s.pc.createOffer();
    await s.pc.setLocalDescription(offer);
    this.signal.send(s.peerHid,{kind:"offer", sdp:s.pc.localDescription});
  }

  _close(s, reason){
    try{s.dc?.close();}catch{}
    try{s.pc?.close();}catch{}
    this.peers.delete(s.peerHid);
    this.onStatus({peerHid:s.peerHid, state:"closed", reason});
  }

  _wire(s, dc){
    s.dc=dc;
    this.onStatus({peerHid:s.peerHid, state:`dc:${dc.readyState}`});

    dc.onopen=async ()=>{
      this.onStatus({peerHid:s.peerHid, state:"connected"});
      // Key exchange (optional): exchange ECDH public keys, derive AES-GCM key
      try{ dc.send(j({t:"k", pub:this.ecdh.publicJwk})); }catch{}
    };

    dc.onmessage=async (ev)=>{
      let m=null; try{ m=JSON.parse(ev.data);}catch{ return; }

      if(m.t==="k" && m.pub){
        s.peerPubJwk=m.pub;
        try{
          const peerPub=await crypto.subtle.importKey("jwk", m.pub, {name:"ECDH", namedCurve:"P-256"}, true, []);
          const key=await crypto.subtle.deriveKey(
            {name:"ECDH", public: peerPub},
            this.ecdh.privateKey,
            {name:"AES-GCM", length:256},
            false,
            ["encrypt","decrypt"]
          );
          s.sharedKey=key;
          this.onStatus({peerHid:s.peerHid, state:"e2ee:ready"});
        }catch(e){
          this.onStatus({peerHid:s.peerHid, state:"e2ee:error", error:String(e)});
        }
        return;
      }

      if(m.t==="pull"){
        const {channelId, sinceSeq}=m;
        const resp = await this.onPullRequest({from:s.peerHid, channelId, sinceSeq});
        const items = [];
        for(const it of (resp.items||[])){
          const payload = {seq:it.seq,msgId:it.msgId,text:it.text,ts:it.ts||Date.now()};
          if(s.sharedKey){
            const iv=crypto.getRandomValues(new Uint8Array(12));
            const pt=new TextEncoder().encode(JSON.stringify(payload));
            const ct=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv}, s.sharedKey, pt));
            items.push({seq:payload.seq, msgId:payload.msgId, iv:b64(iv), ct:b64(ct), ts:payload.ts});
          }else{
            items.push(payload);
          }
        }
        dc.send(j({t:"batch", channelId, items, e2ee:!!s.sharedKey}));
        return;
      }

      if(m.t==="ack"){
        await this.onAck({from:s.peerHid, channelId:m.channelId, upToSeq:Number(m.upToSeq||0)});
        return;
      }

      if(m.t==="batch"){
        const out=[];
        for(const it of (m.items||[])){
          if(m.e2ee && s.sharedKey && it.iv && it.ct){
            try{
              const iv=unb64(it.iv);
              const ct=unb64(it.ct);
              const pt=new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM", iv}, s.sharedKey, ct));
              out.push(JSON.parse(new TextDecoder().decode(pt)));
            }catch{}
          }else if(it.text){
            out.push({seq:it.seq,msgId:it.msgId,text:it.text,ts:it.ts||Date.now()});
          }
        }
        await this.onIntentBatch({from:s.peerHid, channelId:m.channelId, items:out});
        return;
      }
    };
  }
}
