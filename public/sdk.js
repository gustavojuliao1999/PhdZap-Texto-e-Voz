/*!
 * WhatsApp Voice Gateway — SDK JavaScript (sem iframe).
 *
 *   <script src="https://SEU_GATEWAY/sdk.js"></script>
 *   <script>
 *     const phone = WhatsAppVoice.connect({ token: "TOKEN_DA_LINHA", agent: "Maria" });
 *     phone.on("incoming", (call) => mostrarTela(call));
 *     botaoAtender.onclick = () => phone.answer();
 *     botaoLigar.onclick   = () => phone.dial("5581992338229");
 *   </script>
 *
 * Eventos: ready, line, incoming, dialing, answered, answered-elsewhere, connected,
 *          ended, busy, levels, error, disconnected, reconnected, message, message-status.
 * Métodos: answer(), reject(), dial(numero), hangup(), mute(bool), unlockAudio(), destroy(),
 *          sendMessage(numero, texto | conteúdo), messages({ contact, limit, before }), markRead(id).
 */
(function (global) {
  "use strict";

  var SCRIPT_ORIGIN = (function () {
    try { return new URL(document.currentScript.src).origin; } catch (e) { return location.origin; }
  })();

  // ─── utilidades ──────────────────────────────────────────────────────────

  function Emitter() { this._h = {}; }
  Emitter.prototype.on = function (ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; };
  Emitter.prototype.off = function (ev, fn) {
    this._h[ev] = (this._h[ev] || []).filter(function (f) { return f !== fn && f._orig !== fn; }); return this;
  };
  Emitter.prototype.once = function (ev, fn) {
    var self = this, w = function () { self.off(ev, w); fn.apply(this, arguments); };
    w._orig = fn; return this.on(ev, w);
  };
  Emitter.prototype.emit = function (ev) {
    var args = Array.prototype.slice.call(arguments, 1);
    (this._h[ev] || []).slice().forEach(function (fn) {
      try { fn.apply(null, args); } catch (e) { setTimeout(function () { throw e; }); }
    });
  };

  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "c-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  /** "5581992338229" -> "+55 (81) 99233-8229" (Brasil); outros: "+<dígitos>". */
  function formatPhone(s) {
    var d = String(s == null ? "" : s).replace(/\D/g, "");
    if (d.indexOf("55") === 0 && (d.length === 12 || d.length === 13)) {
      var ddd = d.slice(2, 4), n = d.slice(4);
      return "+55 (" + ddd + ") " + (n.length === 9 ? n.slice(0, 5) + "-" + n.slice(5) : n.slice(0, 4) + "-" + n.slice(4));
    }
    return d ? "+" + d : String(s == null ? "" : s);
  }

  // ─── sons: toque de chamada recebida e "chamando" ────────────────────────

  var sound = {
    ctx: null, master: null,
    unlock: function () {
      try {
        if (!this.ctx) {
          this.ctx = new (global.AudioContext || global.webkitAudioContext)();
          var c = this.ctx.createDynamicsCompressor();
          c.threshold.value = -18; c.knee.value = 6; c.ratio.value = 6; c.attack.value = 0.003; c.release.value = 0.15;
          c.connect(this.ctx.destination);
          this.master = c;
        }
        if (this.ctx.state === "suspended") { var p = this.ctx.resume(); if (p && p.catch) p.catch(function () {}); }
      } catch (e) {}
    },
    note: function (dest, freq, at) {
      var ctx = this.ctx;
      [[1, 0.55, "sine"], [2, 0.19, "triangle"], [3, 0.07, "sine"]].forEach(function (h) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = h[2]; o.frequency.value = freq * h[0];
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(h[1], at + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
        o.connect(g).connect(dest); o.start(at); o.stop(at + 0.24);
      });
    },
    tone: function (dest, freq, at, dur, vol) {
      var o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(vol, at + 0.02);
      g.gain.setValueAtTime(vol, at + dur - 0.03);
      g.gain.linearRampToValueAtTime(0.0001, at + dur);
      o.connect(g).connect(dest); o.start(at); o.stop(at + dur + 0.02);
    },
  };

  function looper(pattern, periodMs) {
    return {
      timer: null, bus: null,
      start: function () {
        if (this.timer) return;
        sound.unlock();
        if (!sound.ctx) return;
        var bus = sound.ctx.createGain(); bus.connect(sound.master); this.bus = bus;
        var period = periodMs / 1000, next = sound.ctx.currentTime + 0.05;
        var tick = function () { while (next < sound.ctx.currentTime + period * 2) { pattern(bus, next); next += period; } };
        tick(); this.timer = setInterval(tick, 250);
      },
      stop: function () {
        clearInterval(this.timer); this.timer = null;
        if (this.bus) { var b = this.bus; b.gain.setValueAtTime(0, sound.ctx.currentTime); setTimeout(function () { b.disconnect(); }, 100); this.bus = null; }
      },
    };
  }
  var RING = [[1318.5, 0], [987.8, 0.13], [1318.5, 0.26], [1661.2, 0.39]];
  var ringtone = looper(function (bus, t) {
    [0, 0.62].forEach(function (rep) { RING.forEach(function (n) { sound.note(bus, n[0], t + rep + n[1]); }); });
  }, 2400);
  var ringback = looper(function (bus, t) { sound.tone(bus, 425, t, 1.0, 0.22); }, 5000);

  // ─── áudio da ligação (microfone <-> PCM16 16 kHz) ───────────────────────

  var WORKLET_SRC =
    "class Capture extends AudioWorkletProcessor{process(i){const c=i[0][0];if(c)this.port.postMessage(c.slice());return true}}" +
    "class Playback extends AudioWorkletProcessor{constructor(){super();this.q=[];this.off=0;this.size=0;" +
    "this.port.onmessage=e=>{this.q.push(e.data);this.size+=e.data.length;" +
    "while(this.size>sampleRate*0.4&&this.q.length>1){this.size-=this.q.shift().length-this.off;this.off=0}}}" +
    "process(_,o){const out=o[0][0];for(let i=0;i<out.length;i++){const b=this.q[0];if(!b){out[i]=0;continue}" +
    "out[i]=b[this.off++];this.size--;if(this.off>=b.length){this.q.shift();this.off=0}}return true}}" +
    "registerProcessor('capture',Capture);registerProcessor('playback',Playback);";

  function peak(f32) {
    var p = 0; for (var i = 0; i < f32.length; i++) { var a = Math.abs(f32[i]); if (a > p) p = a; }
    return Math.min(1, Math.sqrt(p) * 1.4);
  }

  function CallAudio(server, token, clientId, agent, onLevel, onClose) {
    this.server = server; this.token = token; this.clientId = clientId; this.agent = agent;
    this.onLevel = onLevel; this.onClose = onClose;
    this.active = false; this.muted = false; this.ctx = null; this.ws = null; this.stream = null;
  }

  CallAudio.prototype.prepare = async function () {
    if (this.ctx) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Este navegador/página não permite microfone (é preciso HTTPS).");
    }
    var ctx = new AudioContext({ sampleRate: 16000 });
    this.ctx = ctx;
    // Worklet pelo gateway (funciona com CSP que bloqueia blob:); se falhar, via blob.
    try { await ctx.audioWorklet.addModule(this.server + "/sdk/worklet.js"); }
    catch (e) { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SRC], { type: "text/javascript" }))); }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      this.stop();
      throw new Error("Sem acesso ao microfone. Libere a permissão no navegador.");
    }
  };

  CallAudio.prototype.start = async function (callId) {
    await this.prepare();
    if (this.active) return;
    var self = this, ctx = this.ctx;
    var playback = new AudioWorkletNode(ctx, "playback"); playback.connect(ctx.destination);
    var capture = new AudioWorkletNode(ctx, "capture");
    ctx.createMediaStreamSource(this.stream).connect(capture);

    var q = new URLSearchParams({ token: this.token, call: callId, clientId: this.clientId });
    if (this.agent) q.set("agent", this.agent);
    var ws = new WebSocket(this.server.replace(/^http/, "ws") + "/api/v1/media?" + q);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    var pending = [], pendingLen = 0;
    capture.port.onmessage = function (e) {
      var f32 = e.data;
      self.onLevel("mic", self.muted ? 0 : peak(f32));
      if (ws.readyState !== 1 || self.muted) return;
      pending.push(f32); pendingLen += f32.length;
      if (pendingLen < 320) return;
      var pcm = new Int16Array(pendingLen), o = 0;
      pending.forEach(function (b) { for (var i = 0; i < b.length; i++) { var s = Math.max(-1, Math.min(1, b[i])); pcm[o++] = s < 0 ? s * 0x8000 : s * 0x7fff; } });
      pending = []; pendingLen = 0;
      ws.send(pcm.buffer);
    };
    ws.onmessage = function (e) {
      var i16 = new Int16Array(e.data), f32 = new Float32Array(i16.length);
      for (var i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
      self.onLevel("remote", peak(f32));
      playback.port.postMessage(f32, [f32.buffer]);
    };
    await new Promise(function (resolve, reject) {
      ws.onopen = resolve;
      ws.onerror = function () { reject(new Error("Não foi possível conectar o áudio (outra pessoa já atendeu?)")); };
    });
    ws.onclose = function () { if (self.ws === ws) { self.stop(); self.onClose(); } };
    this.active = true;
  };

  CallAudio.prototype.stop = function () {
    var ws = this.ws; this.ws = null; if (ws) ws.close();
    if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); });
    if (this.ctx) this.ctx.close().catch(function () {});
    this.ctx = null; this.stream = null; this.active = false; this.muted = false;
    this.onLevel("mic", 0); this.onLevel("remote", 0);
  };

  // ─── cliente da linha ────────────────────────────────────────────────────

  /**
   * @param {object} opts
   * @param {string} opts.token     token da linha (obrigatório)
   * @param {string} [opts.agent]   nome do atendente (aparece no histórico e para os outros)
   * @param {string} [opts.server]  URL do gateway (padrão: de onde o sdk.js foi carregado)
   * @param {boolean} [opts.ringtone=true]  tocar o toque ao receber
   * @param {boolean} [opts.ringback=true]  tocar o "chamando" ao ligar
   */
  /**
   * Libera o som no primeiro clique/toque/tecla em qualquer lugar da página
   * (os navegadores só tocam áudio depois de uma interação), sem botão.
   */
  var autoUnlockBound = false;
  function bindAutoUnlock() {
    if (autoUnlockBound || typeof document === "undefined") return;
    autoUnlockBound = true;
    var tryUnlock = function () { if (!sound.ctx || sound.ctx.state !== "running") sound.unlock(); };
    ["pointerdown", "keydown", "touchend"].forEach(function (ev) { document.addEventListener(ev, tryUnlock, true); });
    global.addEventListener("focus", tryUnlock);
  }

  function Phone(opts) {
    Emitter.call(this);
    if (!opts || !opts.token) throw new Error("WhatsAppVoice.connect: informe { token }");
    this.token = opts.token;
    this.agent = opts.agent ? String(opts.agent).slice(0, 60) : "";
    this.server = (opts.server || SCRIPT_ORIGIN).replace(/\/+$/, "");
    this.useRingtone = opts.ringtone !== false;
    this.useRingback = opts.ringback !== false;
    this.clientId = uuid();
    this.line = null;
    this.call = null;
    this.levels = { mic: 0, remote: 0 };
    this._ignored = {};
    this._closed = false;
    var self = this;
    this._audio = new CallAudio(this.server, this.token, this.clientId, this.agent, function (kind, v) {
      self.levels[kind] = v; self.emit("levels", self.levels);
    }, function () { self._sync(); });
    if (this.useRingtone) bindAutoUnlock();
    this._connect(1000);
  }
  Phone.prototype = Object.create(Emitter.prototype);
  Phone.prototype.constructor = Phone;

  /** A ligação pertence a esta instância (foi atendida/feita aqui)? */
  Phone.prototype.isMine = function (call) {
    call = call || this.call;
    return !!call && call.ownerClientId === this.clientId;
  };
  Object.defineProperty(Phone.prototype, "status", { get: function () { return this.line ? this.line.status : "connecting"; } });
  Object.defineProperty(Phone.prototype, "muted", { get: function () { return this._audio.muted; } });

  Phone.prototype._api = async function (method, path, body) {
    var res = await fetch(this.server + "/api/v1" + path, {
      method: method,
      headers: { authorization: "Bearer " + this.token, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) { var err = new Error(data.error || "HTTP " + res.status); err.status = res.status; throw err; }
    return data;
  };

  Phone.prototype._connect = function (delay) {
    if (this._closed) return;
    var self = this;
    var ws = new WebSocket(this.server.replace(/^http/, "ws") + "/api/v1/events?" + new URLSearchParams({ token: this.token }));
    this._ws = ws;
    var wasConnected = false;
    ws.onopen = function () { wasConnected = true; if (self._everConnected) self.emit("reconnected"); self._everConnected = true; delay = 1000; };
    ws.onmessage = function (e) { self._onEvent(JSON.parse(e.data)); };
    ws.onclose = function (e) {
      if (self._closed) return;
      if (wasConnected) self.emit("disconnected", e.reason || "");
      if (e.code === 4001) { self.emit("error", new Error("Token inválido ou alterado: " + (e.reason || ""))); return; }
      setTimeout(function () { self._connect(Math.min(delay * 2, 15000)); }, delay);
    };
  };

  Phone.prototype._onEvent = function (e) {
    var prev = this.call;
    switch (e.type) {
      case "hello":
        this.line = e.line; this.call = e.line.current;
        this.emit("ready", this.line);
        break;
      case "line":
        this.line = Object.assign({}, this.line, e.line); this.call = e.line.current;
        this.emit("line", this.line);
        break;
      case "incoming":
        this.call = e.call; this.emit("incoming", e.call); break;
      case "dialing":
        this.call = e.call; this.emit("dialing", e.call); break;
      case "answered":
        this.call = e.call;
        this.emit(this.isMine(e.call) ? "answered" : "answered-elsewhere", e.call);
        break;
      case "connected":
        this.call = e.call; this.emit("connected", e.call); break;
      case "ended":
        if (this.call && this.call.id === e.call.id) this.call = null;
        if (this.isMine(e.call)) this._audio.stop();
        this.emit("ended", e.call);
        break;
      case "busy":
        this.emit("busy", { from: e.from }); break;
      case "message":
      case "message-status":
        this.emit(e.type, e.message); break;
    }
    this._sync(prev);
  };

  /** Liga/desliga toques conforme o estado. */
  Phone.prototype._sync = function () {
    var c = this.call;
    var ringingForMe = c && c.direction === "incoming" && c.status === "ringing" && !c.ownerClientId && !this._ignored[c.id];
    if (this.useRingtone && ringingForMe) ringtone.start(); else ringtone.stop();
    var myOutgoing = c && c.direction === "outgoing" && this.isMine(c) && c.status !== "connected";
    if (this.useRingback && myOutgoing) ringback.start(); else ringback.stop();
  };

  /** Libera o som do toque (chame num clique; exigência dos navegadores). */
  Phone.prototype.unlockAudio = function () { sound.unlock(); return sound.ctx ? sound.ctx.state === "running" : false; };
  Object.defineProperty(Phone.prototype, "audioUnlocked", { get: function () { return !!sound.ctx && sound.ctx.state === "running"; } });

  /** Atende (o primeiro a atender fica com a ligação; os outros recebem erro 409). */
  Phone.prototype.answer = async function (callId) {
    callId = callId || (this.call && this.call.id);
    if (!callId) throw new Error("Não há ligação para atender");
    ringtone.stop();
    await this._audio.prepare(); // pede o microfone antes de pegar a ligação
    var call;
    try {
      call = await this._api("POST", "/calls/" + encodeURIComponent(callId) + "/accept", { clientId: this.clientId, agent: this.agent || undefined });
    } catch (err) { this._audio.stop(); this._sync(); throw err; }
    this.call = call;
    await this._audio.start(callId);
    return call;
  };

  /** Recusa a ligação para todos. */
  Phone.prototype.reject = function (callId) {
    callId = callId || (this.call && this.call.id);
    if (!callId) return Promise.reject(new Error("Não há ligação"));
    return this._api("POST", "/calls/" + encodeURIComponent(callId) + "/reject");
  };

  /** Para de tocar só nesta instância (os outros atendentes continuam vendo a ligação). */
  Phone.prototype.ignore = function (callId) {
    callId = callId || (this.call && this.call.id);
    if (callId) this._ignored[callId] = true;
    this._sync();
  };

  /** Liga para um número internacional só com dígitos (ex.: "5581992338229"). */
  Phone.prototype.dial = async function (number) {
    var to = String(number || "").replace(/\D/g, "");
    if (to.length < 8) throw new Error("Número inválido: use DDI + DDD + número");
    await this._audio.prepare();
    if (this.useRingback) ringback.start();
    var call;
    try {
      call = await this._api("POST", "/calls", { to: to, clientId: this.clientId, agent: this.agent || undefined });
    } catch (err) { ringback.stop(); this._audio.stop(); throw err; }
    this.call = call;
    this._sync();
    await this._audio.start(call.id);
    return call;
  };

  /** Desliga (ou cancela) a ligação atual. */
  Phone.prototype.hangup = function (callId) {
    callId = callId || (this.call && this.call.id);
    if (!callId) return Promise.resolve();
    return this._api("POST", "/calls/" + encodeURIComponent(callId) + "/hangup");
  };

  /** Muta/desmuta o microfone desta instância. */
  Phone.prototype.mute = function (muted) {
    this._audio.muted = muted === undefined ? !this._audio.muted : !!muted;
    if (this.call) this._api("POST", "/calls/" + encodeURIComponent(this.call.id) + "/mute", { muted: this._audio.muted }).catch(function () {});
    return this._audio.muted;
  };

  /** Histórico e ligação atual da linha. */
  Phone.prototype.history = function () { return this._api("GET", "/calls"); };

  /**
   * Envia uma mensagem. `content` é o texto ou um objeto da API, ex.:
   * { type: "audio", url: "https://…/recado.mp3" } ou { type: "image", base64: "data:image/png;base64,…", caption: "…" }.
   */
  Phone.prototype.sendMessage = function (number, content) {
    var body = typeof content === "string" ? { text: content } : Object.assign({}, content);
    body.to = String(number);
    if (this.agent && !body.agent) body.agent = this.agent;
    return this._api("POST", "/messages", body);
  };

  /** Mensagens (mais recentes primeiro). opts: { contact, limit, before }. */
  Phone.prototype.messages = function (opts) {
    var q = new URLSearchParams();
    Object.keys(opts || {}).forEach(function (k) { if (opts[k] != null) q.set(k, String(opts[k])); });
    var qs = q.toString();
    return this._api("GET", "/messages" + (qs ? "?" + qs : ""));
  };

  /** Marca a mensagem recebida (e as anteriores da conversa) como lida. */
  Phone.prototype.markRead = function (messageId) {
    return this._api("POST", "/messages/" + encodeURIComponent(messageId) + "/read");
  };

  /** Encerra a conexão (não desliga a ligação em andamento de outros atendentes). */
  Phone.prototype.destroy = function () {
    this._closed = true;
    ringtone.stop(); ringback.stop();
    this._audio.stop();
    if (this._ws) this._ws.close();
  };

  global.WhatsAppVoice = {
    version: "1.0.0",
    connect: function (opts) { return new Phone(opts); },
    formatPhone: formatPhone,
  };
})(typeof window !== "undefined" ? window : this);
