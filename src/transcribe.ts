import { readFile } from "node:fs/promises";
import type { LineEvent, LineManager } from "./line-manager.js";
import { log } from "./log.js";
import type { Store } from "./store.js";

const DEFAULT_URL = "https://api.openai.com/v1/audio/transcriptions";

/** Há serviço de transcrição? (chave, ou uma URL própria — ex.: whisper local sem chave). */
export const transcriptionConfigured = (): boolean => {
  const url = process.env.TRANSCRIBE_API_URL?.trim();
  return !!process.env.TRANSCRIBE_API_KEY?.trim() || (!!url && url !== DEFAULT_URL);
};

/** Transcreve um áudio pela API compatível com OpenAI (/v1/audio/transcriptions). */
export const transcribe = async (data: Buffer, fileName: string, mimetype: string): Promise<string> => {
  const url = process.env.TRANSCRIBE_API_URL?.trim() || DEFAULT_URL;
  const key = process.env.TRANSCRIBE_API_KEY?.trim();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)], { type: mimetype }), fileName);
  form.append("model", process.env.TRANSCRIBE_MODEL?.trim() || "whisper-1");
  const lang = process.env.TRANSCRIBE_LANGUAGE?.trim();
  if (lang) form.append("language", lang);
  form.append("response_format", "json");
  const res = await fetch(url, {
    method: "POST",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: form,
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string };
  return String(json.text ?? "").trim();
};

/**
 * Transcreve automaticamente, conforme a configuração da linha:
 * gravações de ligação (transcribeCalls) e áudios de voz recebidos (transcribeVoiceNotes).
 * Uma transcrição por vez, para não estourar limites do serviço.
 */
export class Transcriber {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly lines: LineManager, private readonly store: Store) {
    lines.on("event", (e: LineEvent) => {
      if (!transcriptionConfigured()) return;
      const cfg = this.lines.get(e.lineId)?.config;
      if (!cfg) return;
      if (e.type === "call-update" && e.kind === "recording" && cfg.transcribeCalls) this.#enqueue(() => this.#call(e.lineId, e.call.id, e.call.remote));
      if (e.type === "message" && cfg.transcribeVoiceNotes && e.message.type === "audio" && e.message.media?.ptt && e.message.direction === "incoming") {
        this.#enqueue(() => this.#voiceNote(e.lineId, e.message.id));
      }
    });
  }

  #enqueue = (job: () => Promise<void>): void => {
    this.#queue = this.#queue.then(job).catch((err) => log.warn(`transcrição falhou: ${err.message}`));
  };

  #call = async (lineId: string, callId: string, remote: string): Promise<void> => {
    const call = await this.store.getCall(lineId, callId);
    if (!call?.recordingFile) return;
    const text = await transcribe(await readFile(this.lines.lineFile(lineId, call.recordingFile)), `${callId}.ogg`, "audio/ogg");
    if (!text) return;
    await this.store.updateCall(lineId, callId, { transcript: text });
    this.lines.emit("event", { type: "call-update", lineId, kind: "transcript", call: { id: callId, remote, transcript: text } } satisfies LineEvent);
  };

  #voiceNote = async (lineId: string, waId: string): Promise<void> => {
    const { view, data } = await this.lines.downloadMedia(lineId, waId);
    const text = await transcribe(data, `${waId}.ogg`, view.media?.mimetype?.split(";")[0] ?? "audio/ogg");
    if (!text) return;
    const updated = await this.store.setMessageTranscript(lineId, waId, text);
    this.lines.emit("event", { type: "message-update", lineId, message: updated } satisfies LineEvent);
  };
}
