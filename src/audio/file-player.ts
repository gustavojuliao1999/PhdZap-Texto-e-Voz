import { spawn } from "node:child_process";
import { CALL_SAMPLE_RATE } from "./pcm.js";

/** Mantém no máximo ~N ms na fila de envio para não estourar memória/latência. */
const MAX_AHEAD_MS = 1500;
const CHUNK_SAMPLES = 320;

export type AudioSink = {
  sendAudio: (pcm: Float32Array) => void;
  readonly queuedAudioMs: number;
};

/**
 * Decodifica qualquer arquivo/URL suportado pelo ffmpeg e envia para a chamada
 * em ritmo controlado. Resolve quando tudo foi enfileirado.
 */
export const playFile = (sink: AudioSink, source: string, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", source,
      "-f", "f32le", "-ac", "1", "-ar", String(CALL_SAMPLE_RATE),
      "pipe:1",
    ]);
    const chunkBytes = CHUNK_SAMPLES * 4;
    let pending = Buffer.alloc(0);
    let throttle: NodeJS.Timeout | null = null;

    const flush = (final = false): void => {
      while (pending.length >= chunkBytes || (final && pending.length >= 4)) {
        const n = Math.min(pending.length - (pending.length % 4), chunkBytes);
        const copy = Buffer.from(pending.subarray(0, n));
        sink.sendAudio(new Float32Array(copy.buffer, copy.byteOffset, n / 4));
        pending = pending.subarray(n);
      }
    };

    const waitForRoom = (): void => {
      if (throttle || sink.queuedAudioMs <= MAX_AHEAD_MS) return;
      proc.stdout.pause();
      throttle = setInterval(() => {
        if (sink.queuedAudioMs <= MAX_AHEAD_MS / 2) {
          clearInterval(throttle!);
          throttle = null;
          proc.stdout.resume();
        }
      }, 50);
    };

    const abort = (): void => { proc.kill("SIGTERM"); };
    signal?.addEventListener("abort", abort, { once: true });

    proc.stdout.on("data", (data: Buffer) => {
      pending = Buffer.concat([pending, data]);
      flush();
      waitForRoom();
    });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (throttle) clearInterval(throttle);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return resolve();
      flush(true);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.trim()}`));
    });
  });
