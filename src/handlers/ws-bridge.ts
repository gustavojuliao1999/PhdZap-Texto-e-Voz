import WebSocket from "ws";
import { CALL_SAMPLE_RATE, LinearResampler, floatToPcm16, pcm16ToFloat } from "../audio/pcm.js";
import { log } from "../log.js";
import type { CallSession } from "../session.js";
import type { CallHandler } from "./types.js";

/**
 * Ponte de mídia: para cada chamada abre um WebSocket com o seu serviço (ex.: agente de IA)
 * e troca áudio em tempo real. Protocolo (veja README):
 *
 *  gateway -> serviço
 *    texto  {"event":"start", callId, direction, from, pushName, sampleRate, encoding:"pcm_s16le"}
 *    binário PCM16 LE mono (áudio do chamador)
 *    texto  {"event":"mark", "name": "..."}   quando o áudio até a marca terminou de tocar
 *    texto  {"event":"stop", "reason": "..."}
 *
 *  serviço -> gateway
 *    binário PCM16 LE mono (áudio a ser falado na chamada)
 *    texto  {"event":"clear"}                 interrompe a fala (barge-in)
 *    texto  {"event":"mark", "name": "..."}   pede aviso quando o áudio enviado até aqui terminar
 *    texto  {"event":"play", "url": "..."}    toca um arquivo/URL via ffmpeg
 *    texto  {"event":"hangup"}                desliga
 */
export const createWsBridgeHandler = (url: string, sampleRate: number): CallHandler => ({
  name: "ws-bridge",
  start(session: CallSession) {
    const tag = `[${session.id}][ws-bridge]`;
    const ws = new WebSocket(url);
    const toBridge = new LinearResampler(CALL_SAMPLE_RATE, sampleRate);
    const fromBridge = new LinearResampler(sampleRate, CALL_SAMPLE_RATE);
    let markSeq = 0;

    const sendJson = (msg: object): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    const onAudio = (pcm: Float32Array): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(floatToPcm16(toBridge.process(pcm)));
    };

    ws.on("open", () => {
      log.info(`${tag} conectado a ${url}`);
      sendJson({
        event: "start",
        callId: session.id,
        direction: session.record.direction,
        from: session.record.remote,
        fromJid: session.record.remoteJid,
        pushName: session.record.pushName,
        sampleRate,
        encoding: "pcm_s16le",
        channels: 1,
      });
      session.on("audio", onAudio);
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        session.sendAudio(fromBridge.process(pcm16ToFloat(buf)));
        return;
      }
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      switch (msg?.event) {
        case "clear":
          session.clearAudio();
          break;
        case "mark": {
          const name = String(msg.name ?? `mark-${++markSeq}`);
          void session.waitForPlaybackDrain().then(() => sendJson({ event: "mark", name }));
          break;
        }
        case "play":
          if (typeof msg.url === "string") {
            session.playFile(msg.url).catch((err) => log.warn(`${tag} play falhou:`, err.message));
          }
          break;
        case "hangup":
          void session.waitForPlaybackDrain().then(() => session.hangup());
          break;
      }
    });

    ws.on("error", (err) => log.warn(`${tag} erro:`, err.message));
    ws.on("close", () => {
      session.off("audio", onAudio);
      if (!session.ended) {
        log.warn(`${tag} ponte fechou durante a chamada; desligando`);
        session.hangup();
      }
    });

    session.once("ended", (reason: string) => {
      sendJson({ event: "stop", reason });
      ws.close();
    });
  },
});
