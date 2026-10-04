/**
 * Processo de uma linha (telefone). Roda o WhatsApp + stack de voz WASM, que só
 * pode existir uma vez por processo, e conversa com o processo principal via IPC.
 *
 * Variáveis: LINE_CONFIG (JSON de LineConfig), LINE_AUTH_DIR.
 */
import { VoipClient } from "baileys-caller";
import { CallManager } from "../call-manager.js";
import { floatToPcm16, pcm16ToFloat } from "../audio/pcm.js";
import { echoHandler, silenceHandler } from "../handlers/echo.js";
import type { CallHandler } from "../handlers/types.js";
import { createWsBridgeHandler } from "../handlers/ws-bridge.js";
import { log } from "../log.js";
import { WhatsAppConnection } from "../whatsapp.js";
import { MessageService } from "./messages.js";
import {
  RESTART_EXIT_CODE, type LineConfig, type ParentMessage, type WorkerCommand, type WorkerMessage,
} from "./protocol.js";

if (!process.send) throw new Error("line-worker deve ser iniciado pelo processo principal (fork)");

const send = (msg: WorkerMessage): void => { process.send!(msg); };

let line: LineConfig = JSON.parse(process.env.LINE_CONFIG ?? "{}");
const authDir = process.env.LINE_AUTH_DIR!;

const policy = {
  inboundMode: line.inboundMode,
  inboundAnswerDelayMs: line.inboundAnswerDelayMs,
  maxCallDurationMs: line.maxCallDurationMs,
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

const client = new VoipClient({
  authDir,
  printQrInTerminal: false,
  incomingAudioSource: "stream",
  incomingDurationMs: line.maxCallDurationMs,
});
const whatsapp = new WhatsAppConnection(client, authDir);
const manager = new CallManager(client, policy, handlers, handlers[line.handler] ?? silenceHandler);

const messages = new MessageService(client);

whatsapp.on("state", (state) => {
  if (state.status === "open") messages.attach();
  send({ t: "wa", state });
});
manager.on("event", (event) => send({ t: "event", event }));
// Conexão caiu depois de aberta: o stack WASM não se religa a um socket novo, então
// o processo sai e o principal sobe outro (que reconecta ou mostra o QR).
whatsapp.on("lost", () => setTimeout(() => process.exit(RESTART_EXIT_CODE), 500));
messages.on("message", (message, raw) => send({ t: "event", event: { type: "message", message, raw } }));
messages.on("status", (s) => send({ t: "event", event: { type: "message-status", ...s } }));

const requireSession = (callId: string) => {
  const s = manager.get(callId);
  if (!s) throw new Error("Chamada não encontrada ou já encerrada");
  return s;
};

const run = async (c: WorkerCommand): Promise<unknown> => {
  switch (c.cmd) {
    case "dial": {
      if (!whatsapp.isOpen) throw new Error("WhatsApp desta linha não está conectado");
      return (await manager.dial(c.to, c.handler)).record;
    }
    case "accept": manager.accept(c.callId, c.handler); return;
    case "reject": manager.reject(c.callId); return;
    case "hangup": manager.hangup(c.callId); return;
    case "mute": requireSession(c.callId).mute(c.muted); return;
    case "clear": requireSession(c.callId).clearAudio(); return;
    case "play": {
      const s = requireSession(c.callId);
      s.playFile(c.url).catch((err) => log.warn(`play falhou: ${err.message}`));
      return;
    }
    case "configure": {
      line = c.config;
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
