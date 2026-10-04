import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync, type WriteStream } from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import type { CallSession } from "../session.js";
import { CALL_SAMPLE_RATE, floatToPcm16 } from "./pcm.js";

/** Limite da fila de saída (o que ainda não "tocou"): evita crescer sem fim. */
const MAX_OUT_QUEUE_SAMPLES = CALL_SAMPLE_RATE * 30;

export type RecordingResult = { file: string; seconds: number };

/**
 * Grava a ligação, sincronizada pelo áudio que chega: a cada bloco recebido do contato,
 * junta a mesma quantidade de amostras do que enviamos (na ordem em que foi para a fila
 * de saída). Grava os dois lados separados (estéreo) e no fim converte para ogg/opus:
 *
 * - `<dir>/<callId>.ogg`: mono, contato + atendente/bot (para ouvir);
 * - `<dir>/<callId>.sides.ogg` (se `keepSides`): esquerda = contato, direita = atendente/bot,
 *   para a transcrição saber quem falou.
 */
export const recordCall = (session: CallSession, dir: string, keepSides = false): Promise<RecordingResult | null> => {
  mkdirSync(dir, { recursive: true });
  const raw = path.join(dir, `${session.id}.pcm`);
  const out = path.join(dir, `${session.id}.ogg`);
  const sides = path.join(dir, `${session.id}.sides.ogg`);
  const stream: WriteStream = createWriteStream(raw);
  let outQueue: Float32Array[] = [];
  let queued = 0;
  let samples = 0;

  const takeOut = (n: number): Float32Array => {
    const mix = new Float32Array(n);
    let filled = 0;
    while (filled < n && outQueue.length) {
      const head = outQueue[0];
      const take = Math.min(n - filled, head.length);
      mix.set(head.subarray(0, take), filled);
      filled += take;
      queued -= take;
      if (take === head.length) outQueue.shift(); else outQueue[0] = head.subarray(take);
    }
    return mix;
  };

  const onRemote = (pcm: Float32Array): void => {
    const mine = takeOut(pcm.length);
    const stereo = new Float32Array(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) { stereo[2 * i] = pcm[i]; stereo[2 * i + 1] = mine[i]; }
    samples += pcm.length;
    stream.write(floatToPcm16(stereo));
  };
  const onSent = (pcm: Float32Array): void => {
    outQueue.push(pcm);
    queued += pcm.length;
    while (queued > MAX_OUT_QUEUE_SAMPLES && outQueue.length > 1) queued -= outQueue.shift()!.length;
  };
  const onCleared = (): void => { outQueue = []; queued = 0; };

  session.on("audio", onRemote);
  session.on("sent-audio", onSent);
  session.on("cleared", onCleared);

  return new Promise((resolve) => {
    session.once("ended", () => {
      session.off("audio", onRemote);
      session.off("sent-audio", onSent);
      session.off("cleared", onCleared);
      stream.end(() => {
        if (samples < CALL_SAMPLE_RATE) { rmSync(raw, { force: true }); return resolve(null); }
        const ff = spawn("ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-y",
          "-f", "s16le", "-ar", String(CALL_SAMPLE_RATE), "-ac", "2", "-i", raw,
          // alimiter: a soma dos dois lados não estoura.
          "-filter_complex", "[0:a]aformat=sample_fmts=flt,pan=mono|c0=c0+c1,alimiter=limit=0.97[m]",
          "-map", "[m]", "-c:a", "libopus", "-b:a", "24k", "-application", "voip", out,
          ...(keepSides ? ["-map", "0:a", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", sides] : []),
        ]);
        let err = "";
        ff.stderr.on("data", (d) => { err += d; });
        ff.on("error", (e) => { log.warn(`gravação: ffmpeg indisponível: ${e.message}`); resolve(null); });
        ff.on("close", (code) => {
          rmSync(raw, { force: true });
          if (code !== 0) {
            rmSync(sides, { force: true });
            log.warn(`gravação: falha ao converter (${err.trim()})`);
            return resolve(null);
          }
          resolve({ file: out, seconds: Math.round(samples / CALL_SAMPLE_RATE) });
        });
      });
    });
  });
};
