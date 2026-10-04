// Vídeo da ligação no navegador: o do cliente (recebido) e a câmera ou a tela do atendente (enviado).
import { api, authedUrl, clientId, wsUrl } from "/static/voice.js";

/** Quadros por segundo e largura máxima enviados ao servidor (JPEG). */
const FPS = 12;
const MAX_W = { camera: 640, screen: 1280 };
const LABEL = { camera: "📷 Câmera", screen: "🖥️ Tela", off: "🚫 Sem vídeo" };

/** Pede a câmera ou a tela. Chame dentro do clique: o navegador exige um gesto do usuário. */
export const captureSource = (source) => source === "screen"
  ? navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 1280 }, frameRate: { ideal: FPS } }, audio: false })
  : navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: FPS } }, audio: false });

/**
 * Bloco de vídeo de uma ligação. `el` é um elemento persistente: a página o recoloca a cada
 * renderização (o vídeo não reinicia). `onChange` avisa quando a fonte muda.
 */
export class CallVideo {
  constructor({ onChange = () => {}, onError = () => {} } = {}) {
    this.onChange = onChange;
    this.onError = onError;
    this.callId = null;
    this.source = "off";
    this.el = document.createElement("div");
    this.el.className = "vcall";
    this.el.innerHTML = `
      <div class="vcall-screens">
        <img class="vcall-remote" alt="Vídeo do cliente" hidden>
        <div class="vcall-wait" hidden>Aguardando o vídeo do cliente…</div>
        <video class="vcall-self" muted playsinline autoplay hidden></video>
      </div>
      <div class="vcall-ctl">${["camera", "screen", "off"].map((s) => `<button type="button" data-src="${s}">${LABEL[s]}</button>`).join("")}</div>`;
    this.remote = this.el.querySelector(".vcall-remote");
    this.wait = this.el.querySelector(".vcall-wait");
    this.self = this.el.querySelector(".vcall-self");
    this.el.querySelector(".vcall-ctl").onclick = (e) => {
      const b = e.target.closest("[data-src]");
      if (b) this.choose(b.dataset.src);
    };
    this.remote.onload = () => { this.wait.hidden = true; };
    this.remote.onerror = () => { this.remote.hidden = true; this.#retryRemote(); };
  }

  /** Liga o bloco à ligação atual (mostra o vídeo do cliente quando houver). */
  sync(call) {
    if (!call || call.status === "ended") return this.stop();
    if (this.callId !== call.id) { this.stop(); this.callId = call.id; }
    if (call.videoStream && !this.remoteOn) this.#openRemote();
    this.#paint();
  }

  /** Escolha nos botões: pede a câmera/tela (no gesto) e avisa o servidor. */
  async choose(source) {
    if (!this.callId || source === this.source) return;
    try {
      const stream = source === "off" ? null : await captureSource(source);
      await api("POST", `/calls/${encodeURIComponent(this.callId)}/video-source`, { source });
      this.#use(source, stream);
      if (source !== "off") this.#openRemote();
    } catch (err) {
      if (err?.name !== "NotAllowedError" && err?.name !== "AbortError") this.onError(err);
    }
  }

  /** Começa a enviar uma fonte já capturada (ex.: pedida antes de discar com vídeo). */
  start(callId, source, stream) {
    this.callId = callId;
    this.#use(source, stream);
    this.#openRemote();
  }

  stop() {
    this.#use("off", null);
    this.remote.removeAttribute("src");
    this.remote.hidden = true;
    this.wait.hidden = true;
    this.remoteOn = false;
    clearTimeout(this.retry);
    this.callId = null;
  }

  // ─── interno ──────────────────────────────────────────────────────────

  #use(source, stream) {
    clearInterval(this.loop);
    this.ws?.close();
    this.ws = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.source = stream ? source : "off";
    this.self.srcObject = stream;
    this.self.hidden = !stream;
    if (stream) {
      // Parou o compartilhamento pela barra do navegador: volta para sem vídeo.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => { if (this.stream === stream) this.choose("off"); });
      this.ws = new WebSocket(wsUrl("/api/v1/video-up", { call: this.callId, clientId }));
      this.ws.binaryType = "arraybuffer";
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      this.loop = setInterval(() => {
        const v = this.self, ws = this.ws;
        if (!v.videoWidth || ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount > 400_000) return;
        const scale = Math.min(1, MAX_W[source] / v.videoWidth);
        canvas.width = Math.round(v.videoWidth * scale) & ~1;
        canvas.height = Math.round(v.videoHeight * scale) & ~1;
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => b?.arrayBuffer().then((buf) => { if (ws.readyState === WebSocket.OPEN) ws.send(buf); }), "image/jpeg", 0.7);
      }, 1000 / FPS);
    }
    this.#paint();
    this.onChange(this.source);
  }

  #openRemote() {
    if (!this.callId) return;
    this.remoteOn = true;
    this.wait.hidden = false;
    this.remote.hidden = false;
    this.remote.src = authedUrl(`/api/v1/calls/${encodeURIComponent(this.callId)}/video`) + `&t=${Date.now()}`;
  }

  #retryRemote() {
    clearTimeout(this.retry);
    if (this.callId) this.retry = setTimeout(() => this.#openRemote(), 2000);
  }

  #paint() {
    for (const b of this.el.querySelectorAll("[data-src]")) b.classList.toggle("on", b.dataset.src === this.source);
    this.el.classList.toggle("sending", this.source !== "off");
  }
}

export const VIDEO_CSS = `
  .vcall { width: 100%; max-width: 380px; display: flex; flex-direction: column; gap: 8px; }
  .vcall-screens { position: relative; }
  .vcall-remote { width: 100%; max-height: 42vh; object-fit: contain; border-radius: 12px; background: #000; display: block; }
  .vcall-wait { color: var(--muted); font-size: 13px; padding: 8px; }
  .vcall-self { position: absolute; right: 8px; bottom: 8px; width: 30%; max-width: 120px; border-radius: 8px; border: 2px solid var(--green); background: #000; }
  .vcall-remote[hidden] ~ .vcall-self, .vcall-wait:not([hidden]) ~ .vcall-self { position: static; width: 45%; max-width: 160px; align-self: center; margin: 0 auto; display: block; }
  .vcall-self[hidden] { display: none !important; }
  .vcall-ctl { display: flex; gap: 6px; }
  .vcall-ctl button { flex: 1; padding: 8px 4px; font-size: 12.5px; background: var(--panel-2); }
  .vcall-ctl button.on { background: var(--green-dark); color: #fff; }
`;
