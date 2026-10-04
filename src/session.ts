import { EventEmitter } from "node:events";
import type { ActiveCall } from "baileys-caller";
import { playFile } from "./audio/file-player.js";
import { log } from "./log.js";

export type CallStatus = "ringing" | "connected" | "ended";

export type CallRecord = {
  id: string;
  direction: "incoming" | "outgoing";
  /** Número (dígitos) quando conhecido, senão o JID. */
  remote: string;
  remoteJid?: string;
  pushName?: string;
  /** Chamada de vídeo (recebida). */
  isVideo?: boolean;
  status: CallStatus;
  handler?: string;
  startedAt: string;
  connectedAt?: string;
  endedAt?: string;
  endReason?: string;
};

/**
 * Visão de alto nível de uma chamada, entregue aos handlers.
 * Áudio sempre em Float32 16 kHz mono.
 *
 * Eventos: `audio` (Float32Array, do outro lado), `sent-audio` (Float32Array, o que
 * enviamos), `cleared` (fala interrompida), `connected`, `ended` (reason).
 */
export class CallSession extends EventEmitter {
  readonly record: CallRecord;
  #playback: AbortController | null = null;

  constructor(readonly call: ActiveCall, remote: string, remoteJid?: string, pushName?: string) {
    super();
    this.record = {
      id: call.callId,
      direction: call.direction,
      remote,
      remoteJid,
      pushName,
      ...(call.incoming?.isVideo ? { isVideo: true } : {}),
      status: "ringing",
      startedAt: new Date().toISOString(),
    };
    call.on("audio", (pcm: Float32Array) => this.emit("audio", pcm));
    call.on("connected", () => {
      this.record.status = "connected";
      this.record.connectedAt = new Date().toISOString();
      this.emit("connected");
    });
    call.once("ended", (reason: string) => {
      this.#playback?.abort();
      this.record.status = "ended";
      this.record.endedAt = new Date().toISOString();
      this.record.endReason = reason;
      this.emit("ended", reason);
    });
  }

  get id(): string { return this.record.id; }
  get ended(): boolean { return this.record.status === "ended"; }
  get queuedAudioMs(): number { return this.call.queuedAudioMs; }

  sendAudio = (pcm: Float32Array): void => {
    this.call.sendAudio(pcm);
    this.emit("sent-audio", pcm);
  };

  /** Interrompe a fala atual (fila + arquivo em reprodução). */
  clearAudio = (): void => {
    this.#playback?.abort();
    this.#playback = null;
    this.call.clearAudio();
    this.emit("cleared");
  };

  /** Toca um arquivo/URL (qualquer formato do ffmpeg). Interrompe o anterior. */
  playFile = async (source: string): Promise<void> => {
    this.#playback?.abort();
    const ctrl = new AbortController();
    this.#playback = ctrl;
    try {
      await playFile(this, source, ctrl.signal);
    } finally {
      if (this.#playback === ctrl) this.#playback = null;
    }
  };

  /** Resolve quando a fila de saída esvaziar (útil p/ saber quando o bot terminou de falar). */
  waitForPlaybackDrain = async (): Promise<void> => {
    while (!this.ended && this.queuedAudioMs > 0) {
      await new Promise((r) => setTimeout(r, Math.min(200, Math.max(20, this.queuedAudioMs))));
    }
  };

  mute = (muted: boolean): void => this.call.mute(muted);

  hangup = (): void => {
    log.info(`[${this.id}] desligando`);
    this.call.end();
  };
}
