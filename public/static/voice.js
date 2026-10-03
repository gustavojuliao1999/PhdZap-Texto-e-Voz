// Módulo compartilhado pelos iframes (receptor/discador): API da linha, eventos,
// áudio do navegador (PCM16 16 kHz) e toque de chamada.

export const params = new URLSearchParams(location.search);
export const lineToken = params.get("token") ?? "";
export const agentName = (params.get("agent") ?? "").slice(0, 60);

/** Identifica este iframe/aba (o "primeiro a atender" é por cliente). */
export const clientId = (() => {
  const k = "wvg_client_id";
  let id = sessionStorage.getItem(k);
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(k, id); }
  return id;
})();

export const api = async (method, path, body) => {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${lineToken}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
};

const wsUrl = (path, extra = {}) => {
  const q = new URLSearchParams({ token: lineToken, ...extra });
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}?${q}`;
};

/** WebSocket de eventos da linha com reconexão automática. */
export const connectEvents = (onEvent, onStatus = () => {}) => {
  let ws, closed = false, delay = 1000;
  const open = () => {
    ws = new WebSocket(wsUrl("/api/v1/events"));
    ws.onopen = () => { delay = 1000; onStatus(true); };
    ws.onmessage = (e) => onEvent(JSON.parse(e.data));
    ws.onclose = (e) => {
      onStatus(false, e.code === 4001 ? e.reason : "");
      if (closed || e.code === 4001) return;
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 15000);
    };
  };
  open();
  return { close: () => { closed = true; ws?.close(); } };
};

/** Avisa a página que incorporou o iframe (window.addEventListener("message", ...)). */
export const notifyParent = (type, call) => {
  if (window.parent === window) return;
  window.parent.postMessage({ source: "whatsapp-voice-gateway", type, call }, "*");
};

export const fmtPhone = (s) => {
  const d = String(s ?? "").replace(/\D/g, "");
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4), n = d.slice(4);
    return `+55 (${ddd}) ${n.length === 9 ? n.slice(0, 5) + "-" + n.slice(5) : n.slice(0, 4) + "-" + n.slice(4)}`;
  }
  return d ? `+${d}` : String(s ?? "");
};

export const fmtDuration = (fromIso, toIso) => {
  if (!fromIso) return "0:00";
  const s = Math.max(0, Math.round(((toIso ? new Date(toIso) : new Date()) - new Date(fromIso)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ─── áudio ────────────────────────────────────────────────────────────────

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0][0]; if (ch) this.port.postMessage(ch.slice()); return true; }
}
class Playback extends AudioWorkletProcessor {
  constructor() {
    super(); this.q = []; this.off = 0; this.size = 0;
    this.port.onmessage = (e) => {
      this.q.push(e.data); this.size += e.data.length;
      // Limita a latência a ~400 ms descartando o mais antigo.
      while (this.size > sampleRate * 0.4 && this.q.length > 1) { this.size -= this.q.shift().length - this.off; this.off = 0; }
    };
  }
  process(_, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      const buf = this.q[0];
      if (!buf) { out[i] = 0; continue; }
      out[i] = buf[this.off++]; this.size--;
      if (this.off >= buf.length) { this.q.shift(); this.off = 0; }
    }
    return true;
  }
}
registerProcessor("capture", Capture);
registerProcessor("playback", Playback);`;

/**
 * Microfone -> chamada e chamada -> alto-falante.
 * `onLevel(kind, 0..1)` para medidores ("mic" | "remote").
 */
export class CallAudio {
  active = false;
  muted = false;
  #ctx = null; #ws = null; #stream = null;

  constructor(onLevel = () => {}, onClose = () => {}) {
    this.onLevel = onLevel;
    this.onClose = onClose;
  }

  /** Pede o microfone. Chame dentro de um clique (exigência dos navegadores). */
  async prepare() {
    if (this.#ctx) return;
    const ctx = new AudioContext({ sampleRate: 16000 });
    this.#ctx = ctx;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (err) {
      this.stop();
      throw new Error("Sem acesso ao microfone. Libere a permissão do navegador" +
        (window.parent !== window ? ' (o iframe precisa de allow="microphone").' : "."));
    }
  }

  /** Conecta o áudio à chamada `callId` (o servidor confirma que este cliente é o dono). */
  async start(callId) {
    await this.prepare();
    if (this.active) return;
    const ctx = this.#ctx;
    const playback = new AudioWorkletNode(ctx, "playback");
    playback.connect(ctx.destination);
    const capture = new AudioWorkletNode(ctx, "capture");
    ctx.createMediaStreamSource(this.#stream).connect(capture);

    const ws = new WebSocket(wsUrl("/api/v1/media", { call: callId, clientId, ...(agentName ? { agent: agentName } : {}) }));
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    let pending = [], pendingLen = 0;
    capture.port.onmessage = (e) => {
      const f32 = e.data;
      this.onLevel("mic", this.muted ? 0 : peak(f32));
      if (ws.readyState !== 1 || this.muted) return;
      pending.push(f32); pendingLen += f32.length;
      if (pendingLen < 320) return; // blocos de 20 ms
      const pcm = new Int16Array(pendingLen);
      let o = 0;
      for (const b of pending) for (let i = 0; i < b.length; i++) {
        const s = Math.max(-1, Math.min(1, b[i])); pcm[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      pending = []; pendingLen = 0;
      ws.send(pcm.buffer);
    };
    ws.onmessage = (e) => {
      const i16 = new Int16Array(e.data);
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
      this.onLevel("remote", peak(f32));
      playback.port.postMessage(f32, [f32.buffer]);
    };
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("Não foi possível conectar o áudio (outra pessoa já atendeu?)"));
    });
    ws.onclose = () => { if (this.#ws === ws) { this.stop(); this.onClose(); } };
    this.active = true;
  }

  setMuted(m) { this.muted = m; }

  stop() {
    const ws = this.#ws; this.#ws = null; ws?.close();
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#ctx?.close().catch(() => {});
    this.#ctx = null; this.#stream = null; this.active = false; this.muted = false;
    this.onLevel("mic", 0); this.onLevel("remote", 0);
  }
}

const peak = (f32) => {
  let p = 0;
  for (let i = 0; i < f32.length; i++) p = Math.max(p, Math.abs(f32[i]));
  return Math.min(1, Math.sqrt(p) * 1.4);
};

// ─── sons (toque de chamada recebida e "chamando") ────────────────────────

/** AudioContext compartilhado pelos sons (navegadores só liberam após uma interação). */
const sound = {
  ctx: null, master: null,
  unlock() {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        // Compressor: deixa o toque alto sem distorcer.
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -18; comp.knee.value = 6; comp.ratio.value = 6;
        comp.attack.value = 0.003; comp.release.value = 0.15;
        comp.connect(this.ctx.destination);
        this.master = comp;
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
    } catch {}
  },
  get unlocked() { return this.ctx?.state === "running"; },
  /** Nota curta tipo marimba: fundamental + harmônicos, ataque rápido e decaimento. */
  note(dest, freq, at, { dur = 0.22, vol = 0.55 } = {}) {
    const ctx = this.ctx;
    for (const [mult, v, wave] of [[1, vol, "sine"], [2, vol * 0.35, "triangle"], [3, vol * 0.12, "sine"]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = wave; o.frequency.value = freq * mult;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(v, at + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g).connect(dest);
      o.start(at); o.stop(at + dur + 0.02);
    }
  },
  /** Tom contínuo (para o "chamando"). */
  tone(dest, freq, at, dur, vol = 0.25) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(vol, at + 0.02);
    g.gain.setValueAtTime(vol, at + dur - 0.03);
    g.gain.linearRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(dest);
    o.start(at); o.stop(at + dur + 0.02);
  },
};

/**
 * Repete `pattern(bus, t)` a cada `periodMs`, agendando com antecedência (não falha
 * com a aba em segundo plano). Cada execução usa um canal próprio, cortado no stop().
 */
const looper = (pattern, periodMs) => ({
  timer: null, bus: null,
  get playing() { return !!this.timer; },
  start() {
    if (this.timer) return;
    sound.unlock();
    if (!sound.ctx) return;
    const bus = sound.ctx.createGain();
    bus.connect(sound.master);
    this.bus = bus;
    const period = periodMs / 1000;
    let next = sound.ctx.currentTime + 0.05;
    const tick = () => {
      while (next < sound.ctx.currentTime + period * 2) { pattern(bus, next); next += period; }
    };
    tick();
    this.timer = setInterval(tick, 250);
  },
  stop() {
    clearInterval(this.timer); this.timer = null;
    if (this.bus) {
      this.bus.gain.setValueAtTime(0, sound.ctx.currentTime); // silencia o que já estava agendado
      const bus = this.bus; setTimeout(() => bus.disconnect(), 100);
      this.bus = null;
    }
  },
});

/**
 * Toque de chamada recebida: arpejo brilhante (Mi–Si–Mi–Sol#) tocado duas vezes,
 * depois uma pausa curta. Alto e fácil de notar.
 */
const RING = [[1318.5, 0], [987.8, 0.13], [1318.5, 0.26], [1661.2, 0.39]];
export const ringtone = looper((bus, t) => {
  for (const rep of [0, 0.62]) for (const [f, at] of RING) sound.note(bus, f, t + rep + at);
}, 2400);
ringtone.unlock = () => sound.unlock();
Object.defineProperty(ringtone, "unlocked", { get: () => sound.unlocked });

/** "Chamando" (ringback) no padrão brasileiro: 425 Hz, 1 s ligado / 4 s desligado. */
export const ringback = looper((bus, t) => sound.tone(bus, 425, t, 1.0, 0.22), 5000);
