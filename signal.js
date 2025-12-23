export class SignalClient {
  constructor(urls, { hid, onMessage, onStatus }) {
    this.urls = Array.isArray(urls) ? urls : [urls];
    this.hid = hid;
    this.onMessage = onMessage || (()=>{});
    this.onStatus = onStatus || (()=>{});
    this.ws = null;
    this.i = 0;
    this.closed = false;
    this.backoff = 250;
    this.t = null;
  }

  start(){ this.closed=false; this._try(); }
  stop(){
    this.closed=true;
    try{ this.ws?.close(); }catch{}
    this.ws=null;
    if(this.t) clearTimeout(this.t);
  }

  _urlRaw(){ const u=this.urls[this.i % this.urls.length]; this.i++; return u; }

  // ✅ Normalize anything user pastes into a correct ws(s) URL
  _normalize(u){
    u = String(u || "").trim();
    if(!u) return "";

    // If user pasted a bare host, add scheme
    if(!/^[a-z]+:\/\//i.test(u)){
      // default to wss
      u = "wss://" + u;
    }

    // Convert http(s) -> ws(s)
    if(u.startsWith("https://")) u = "wss://" + u.slice("https://".length);
    if(u.startsWith("http://"))  u = "ws://"  + u.slice("http://".length);

    // Ensure it ends with /signal or /signal/
    const hasSignal = /\/signal\/?$/i.test(u);
    if(!hasSignal){
      u = u.replace(/\/+$/,"") + "/signal";
    }
    return u;
  }

  _sched(reason){
    if(this.closed) return;
    const w=Math.min(8000,this.backoff);
    this.backoff=Math.min(8000, Math.floor(this.backoff*1.8));
    this.onStatus({state:"retrying", reason, wait:w});
    this.t=setTimeout(()=>this._try(), w);
  }

  _try(){
    if(this.closed) return;

    const raw = this._urlRaw();
    const url = this._normalize(raw);

    this.onStatus({state:"connecting", url});

    let ws;
    try{
      ws = new WebSocket(url);
    }catch(e){
      this.onStatus({state:"error", url, error:String(e)});
      return this._sched("ctor");
    }

    this.ws=ws;

    ws.onopen=()=>{
      this.backoff=250;
      this.onStatus({state:"open", url});
      try{ ws.send(JSON.stringify({t:"hello", hid:this.hid})); }catch{}
    };

    ws.onmessage=(ev)=>{
      let m=null; try{ m=JSON.parse(ev.data);}catch{return;}
      if(m?.t==="msg") this.onMessage(m);
      if(m?.t==="nack") this.onStatus({state:"nack", to:m.to, reason:m.reason});
    };

    ws.onerror=()=>this.onStatus({state:"error", url, error:"ws_error"});

    ws.onclose=()=>{
      this.onStatus({state:"closed", url});
      this.ws=null;
      this._sched("close");
    };
  }

  isOpen(){ return this.ws && this.ws.readyState===WebSocket.OPEN; }

  send(to,data){
    if(!this.isOpen()) return false;
    try{ this.ws.send(JSON.stringify({t:"send", to, data})); return true; }catch{ return false; }
  }

  broadcast(toList,data){
    const uniq=[...new Set(toList||[])].slice(0,50);
    let ok=false;
    for(const to of uniq) ok = this.send(to,data) || ok;
    return ok;
  }
}

// Back-compat alias
SignalClient.prototype.isConnected = function(){ return this.isOpen(); };
