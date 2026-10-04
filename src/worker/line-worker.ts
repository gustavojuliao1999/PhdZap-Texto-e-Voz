/**
 * Processo de uma linha (telefone). Roda o WhatsApp + stack de voz WASM, que só
 * pode existir uma vez por processo, e conversa com o processo principal via IPC.
 *
 * Variáveis: LINE_CONFIG (JSON de LineConfig), LINE_AUTH_DIR.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { VoipClient, type VideoCaptureRequest, type VideoFrame } from "baileys-caller";
import { recordCall } from "../audio/recorder.js";
import { transcriptionConfigured } from "../transcribe.js";
import { hiddenMatcher } from "../hidden.js";
import { VideoRelay, VideoSender } from "../video.js";
import type { CallSession } from "../session.js";
import { CallManager } from "../call-manager.js";
import { floatToPcm16, pcm16ToFloat } from "../audio/pcm.js";
import { echoHandler, silenceHandler } from "../handlers/echo.js";
import type { CallHandler } from "../handlers/types.js";
import { createWsBridgeHandler } from "../handlers/ws-bridge.js";
import { log } from "../log.js";
import { WhatsAppConnection } from "../whatsapp.js";
import { MessageService } from "./messages.js";
import {
  RESTART_EXIT_CODE, type LineConfig, type VideoSource, type ParentMessage, type WorkerCommand, type WorkerMessage,
} from "./protocol.js";

if (!process.send) throw new Error("line-worker deve ser iniciado pelo processo principal (fork)");

const send = (msg: WorkerMessage): void => { process.send!(msg); };

let line: LineConfig = JSON.parse(process.env.LINE_CONFIG ?? "{}");
const authDir = process.env.LINE_AUTH_DIR!;

let isHidden = hiddenMatcher(line.hiddenContacts ?? []);
const policy = {
  inboundMode: line.inboundMode,
  inboundAnswerDelayMs: line.inboundAnswerDelayMs,
  maxCallDurationMs: line.maxCallDurationMs,
  isHidden: (remote: string) => isHidden(remote),
  videoCalls: line.videoCalls,
};

/** Atendimento humano: o áudio vai/vem pelo navegador, via processo principal. */
const browserHandler: CallHandler = {
  name: "browser",
  start(session) {
    session.on("audio", (pcm: Float32Array) => {
      send({ t: "audio", callId: session.id, pcm: floatToPcm16(pcm) });
    });
  },
};

const handlers: Record<string, CallHandler> = {
  browser: browserHandler,
  echo: echoHandler,
  silence: silenceHandler,
  "ws-bridge": createWsBridgeHandler(line.bridgeUrl, line.bridgeSampleRate),
};

// Sem sessão salva = vai vincular agora. Como "computador" (Desktop), o celular envia o histórico
// completo; a escolha fica gravada para a sessão continuar se apresentando igual.
const desktopMarker = path.join(authDir, "..", "desktop-link");
const linkAsDesktop = !existsSync(path.join(authDir, "creds.json")) || existsSync(desktopMarker);
if (linkAsDesktop) { mkdirSync(path.dirname(desktopMarker), { recursive: true }); writeFileSync(desktopMarker, ""); }

const client = new VoipClient({
  authDir,
  printQrInTerminal: false,
  incomingAudioSource: "stream",
  incomingDurationMs: line.maxCallDurationMs,
  socketOptions: (baileys: any) => ({
    // Guarda todo histórico que o celular mandar (o padrão do Baileys descarta o FULL).
    shouldSyncHistoryMessage: () => true,
    syncFullHistory: true,
    ...(linkAsDesktop ? { browser: baileys.Browsers.macOS("Desktop") } : {}),
  }),
});
const whatsapp = new WhatsAppConnection(client, authDir);
const manager = new CallManager(client, policy, handlers, handlers[line.handler] ?? silenceHandler);

const messages = new MessageService(client, () => line.groupsEnabled);

whatsapp.on("state", (state) => {
  if (state.status === "open") messages.attach();
  send({ t: "wa", state });
});
manager.on("event", (event) => {
  send({ t: "event", event });
  // Recebida: o vídeo do cliente só aparece no painel com "mostrar o vídeo" (ou se o atendente ligar o dele).
  if (event.type === "incoming") {
    const session = manager.get(event.call.id);
    if (session) trackVideo(session, !!event.call.isVideo && line.videoCalls === "video");
  }
  // Gravação: toda ligação atendida é gravada (só áudio). Com a transcrição ligada, guarda também
  // os lados separados, para saber quem falou.
  if (event.type === "connected") {
    const session = manager.get(event.call.id);
    const lineDir = path.dirname(authDir);
    if (session) {
      recordCall(session, path.join(lineDir, "recordings"), transcriptionConfigured())
        .then((r) => {
          if (r) send({ t: "event", event: { type: "recording", callId: session.id, file: path.relative(lineDir, r.file), seconds: r.seconds } });
        })
        .catch((err) => log.warn(`gravação falhou: ${err.message}`));
    }
  }
});
// Conexão caiu depois de aberta: o stack WASM não se religa a um socket novo, então
// o processo sai e o principal sobe outro (que reconecta ou mostra o QR).
whatsapp.on("lost", () => setTimeout(() => process.exit(RESTART_EXIT_CODE), 500));
messages.on("message", (message, raw) => send({ t: "event", event: { type: "message", message, raw } }));
messages.on("status", (s) => send({ t: "event", event: { type: "message-status", ...s } }));
messages.on("update", (u) => send({ t: "event", event: { type: "message-update", ...u } }));
messages.on("history", (h) => send({ t: "event", event: { type: "history", ...h } }));
messages.on("contacts", (contacts) => send({ t: "event", event: { type: "contacts", contacts } }));

// ─── vídeo ─────────────────────────────────────────────────────────────────

type CallVideo = {
  relay: VideoRelay; sender: VideoSender | null; show: boolean;
  /** Fonte pedida pelo atendente e a que já foi aplicada no WhatsApp. */
  want: VideoSource; applied: VideoSource;
};
const videos = new Map<string, CallVideo>();

/**
 * Vídeo de uma ligação: o do cliente (quadros -> JPEG para o painel, se `show`) e o do atendente
 * (JPEGs do navegador -> NV12 no tamanho que o WhatsApp pedir, enquanto ele pedir).
 */
const trackVideo = (session: CallSession, show: boolean, initial: VideoSource = "off"): CallVideo => {
  const v: CallVideo = { relay: new VideoRelay(), sender: null, show, want: initial, applied: initial };
  videos.set(session.id, v);
  v.relay.on("jpeg", (jpeg: Buffer) => { if (v.show) send({ t: "video", callId: session.id, jpeg }); });
  v.relay.once("jpeg", () => log.info(`[${session.id}] vídeo do cliente chegando`));
  session.call.on("video", v.relay.push);
  session.call.once("video", (f: VideoFrame) =>
    log.info(`[${session.id}] primeiro quadro de vídeo: ${f.width}x${f.height} formato ${f.format} rotação ${f.orientation}`));
  session.call.on("video-capture", (req: VideoCaptureRequest) => {
    log.info(`[${session.id}] WhatsApp pediu vídeo (${req.kind === "screen" ? "tela" : "câmera"}) ${req.width}x${req.height} a ${req.maxFps} fps`);
    v.sender?.stop();
    v.sender = new VideoSender(req.width, req.height, req.maxFps);
    v.sender.on("frame", (frame: Uint8Array, w: number, h: number) => session.call.sendVideoFrame(frame, w, h));
  });
  session.call.on("video-capture-stop", () => { v.sender?.stop(); v.sender = null; });
  // O WhatsApp só aceita trocar câmera/tela com a ligação atendida: aplica o que ficou pendente.
  session.once("connected", () => applyVideoSource(session, v));
  session.once("ended", () => { v.relay.stop(); v.sender?.stop(); videos.delete(session.id); });
  return v;
};

/** Tamanho do compartilhamento de tela enviado ao cliente. */
const SCREEN_W = 1280, SCREEN_H = 720;

const applyVideoSource = (session: CallSession, v: CallVideo): void => {
  if (session.ended || v.want === v.applied) return;
  const call = session.call;
  const from = v.applied, to = v.want;
  // Tela -> outra coisa: encerra o compartilhamento (o WhatsApp volta para a câmera).
  if (from === "screen") call.stopScreenShare();
  // Compartilhar a tela não desliga a câmera: desligar silenciaria o vídeo da ligação inteira.
  if (to === "camera") call.startCamera();
  if (to === "screen") { call.startCamera(); call.startScreenShare(SCREEN_W, SCREEN_H); }
  if (to === "off") call.stopCamera();
  v.applied = to;
  log.info(`[${session.id}] vídeo do atendente: ${to === "camera" ? "câmera" : to === "screen" ? "tela" : "desligado"}`);
};

const setVideoSource = (session: CallSession, source: VideoSource): void => {
  const v = videos.get(session.id) ?? trackVideo(session, false);
  v.want = source;
  // Quem liga o próprio vídeo também vê o do cliente.
  if (source !== "off") v.show = true;
  if (session.record.status === "connected") applyVideoSource(session, v);
  else log.info(`[${session.id}] vídeo do atendente (${source}) será aplicado quando atenderem`);
};

const requireSession = (callId: string) => {
  const s = manager.get(callId);
  if (!s) throw new Error("Chamada não encontrada ou já encerrada");
  return s;
};

const run = async (c: WorkerCommand): Promise<unknown> => {
  switch (c.cmd) {
    case "dial": {
      if (!whatsapp.isOpen) throw new Error("WhatsApp desta linha não está conectado");
      const session = await manager.dial(c.to, c.handler, !!c.video);
      // Ligação de vídeo já sai com a câmera ligada.
      trackVideo(session, !!c.video, c.video ? "camera" : "off");
      return session.record;
    }
    case "accept": manager.accept(c.callId, c.handler); return;
    case "reject": manager.reject(c.callId); return;
    case "hangup": manager.hangup(c.callId); return;
    case "mute": requireSession(c.callId).mute(c.muted); return;
    case "video-source": setVideoSource(requireSession(c.callId), c.source); return;
    case "clear": requireSession(c.callId).clearAudio(); return;
    case "play": {
      const s = requireSession(c.callId);
      s.playFile(c.url).catch((err) => log.warn(`play falhou: ${err.message}`));
      return;
    }
    case "configure": {
      line = c.config;
      isHidden = hiddenMatcher(line.hiddenContacts ?? []);
      policy.videoCalls = line.videoCalls;
      Object.assign(policy, {
        inboundMode: line.inboundMode,
        inboundAnswerDelayMs: line.inboundAnswerDelayMs,
        maxCallDurationMs: line.maxCallDurationMs,
      });
      handlers["ws-bridge"] = createWsBridgeHandler(line.bridgeUrl, line.bridgeSampleRate);
      manager.setDefaultHandler(handlers[line.handler] ?? silenceHandler);
      return;
    }
    case "send-message": {
      if (!whatsapp.isOpen) throw new Error("WhatsApp desta linha não está conectado");
      return messages.send(c.to, c.content, c.quotedRaw);
    }
    case "download-media": return messages.download(c.raw);
    case "mark-read": return messages.markRead(c.raws);
    case "profile-picture": return messages.profilePicture(c.jid);
    case "fetch-history": return messages.fetchHistory(c.raw, c.count);
    case "sync-contacts": return messages.syncContacts();
    case "logout": {
      await whatsapp.logout();
      // O stack WASM não reinicializa no mesmo processo: o principal sobe outro.
      setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
      return;
    }
  }
};

process.on("message", (msg: ParentMessage) => {
  if (msg.t === "audio") {
    const buf = Buffer.from(msg.pcm.buffer, msg.pcm.byteOffset, msg.pcm.byteLength);
    manager.get(msg.callId)?.sendAudio(pcm16ToFloat(buf));
    return;
  }
  if (msg.t === "video-up") {
    videos.get(msg.callId)?.sender?.push(msg.jpeg);
    return;
  }
  if (msg.t !== "req") return;
  const { reqId } = msg;
  run(msg)
    .then((data) => send({ t: "res", reqId, ok: true, data }))
    .catch((err) => send({ t: "res", reqId, ok: false, error: err?.message ?? String(err) }));
});

// Principal morreu: não deixa o WhatsApp órfão.
process.on("disconnect", () => {
  client.disconnect();
  process.exit(0);
});

void whatsapp.start();
