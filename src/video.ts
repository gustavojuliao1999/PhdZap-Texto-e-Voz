import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { VideoFrame } from "baileys-caller";
import { log } from "./log.js";

/** Formato do quadro (WAWebVoipVideoFormat) -> pix_fmt do ffmpeg. */
const PIX_FMT: Record<number, { fmt: string; bytes: (w: number, h: number) => number }> = {
  0: { fmt: "nv12", bytes: (w, h) => w * h * 1.5 },
  1: { fmt: "yuv420p", bytes: (w, h) => w * h * 1.5 },
  2: { fmt: "rgb24", bytes: (w, h) => w * h * 3 },
  3: { fmt: "rgba", bytes: (w, h) => w * h * 4 },
};

/** Rotação pedida pelo WhatsApp (orientation) -> filtro do ffmpeg. */
const ROTATE: Record<number, string> = { 2: "transpose=1,", 3: "transpose=1,transpose=1,", 4: "transpose=2," };

/** Quadros por segundo enviados ao navegador (o resto é descartado). */
const MAX_FPS = 10;
/** Largura máxima da imagem enviada ao navegador. */
const MAX_WIDTH = 640;

/**
 * Converte os quadros de vídeo do cliente (crus, decodificados pelo WhatsApp) em JPEGs para o
 * painel, com um ffmpeg por formato/tamanho. Só recebe: o gateway nunca envia vídeo.
 *
 * Emite `jpeg` (Buffer).
 */
export class VideoRelay extends EventEmitter {
  #ff: ChildProcessWithoutNullStreams | null = null;
  #key = "";
  #out = Buffer.alloc(0);
  #lastAt = 0;
  #busy = false;
  #stopped = false;
  #warned = false;

  push = (frame: VideoFrame): void => {
    if (this.#stopped || !frame.width || !frame.height) return;
    const pix = PIX_FMT[frame.format];
    if (!pix || frame.data.byteLength < pix.bytes(frame.width, frame.height)) {
      if (!this.#warned) log.warn(`vídeo: quadro ignorado (formato ${frame.format}, ${frame.width}x${frame.height}, ${frame.data.byteLength} bytes)`);
      this.#warned = true;
      return;
    }
    const now = Date.now();
    if (this.#busy || now - this.#lastAt < 1000 / MAX_FPS) return;
    this.#lastAt = now;
    const key = `${pix.fmt}:${frame.width}x${frame.height}:${frame.orientation}`;
    if (key !== this.#key) this.#start(key, pix.fmt, frame.width, frame.height, frame.orientation);
    const size = pix.bytes(frame.width, frame.height);
    const ok = this.#ff!.stdin.write(frame.data.subarray(0, size));
    if (!ok) {
      this.#busy = true;
      this.#ff!.stdin.once("drain", () => { this.#busy = false; });
    }
  };

  stop = (): void => {
    this.#stopped = true;
    this.#kill();
  };

  #start = (key: string, fmt: string, w: number, h: number, orientation: number): void => {
    this.#kill();
    this.#key = key;
    const filter = `${ROTATE[orientation] ?? ""}scale='min(${MAX_WIDTH},iw)':-2`;
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", fmt, "-s", `${w}x${h}`, "-i", "pipe:0",
      "-vf", filter, "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "6", "pipe:1",
    ]);
    ff.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
    ff.stderr.on("data", (d: Buffer) => log.warn(`vídeo (ffmpeg): ${d.toString().trim()}`));
    ff.stdin.on("error", () => {});
    ff.on("error", (err) => log.warn(`vídeo: ffmpeg não iniciou: ${err.message}`));
    this.#ff = ff;
  };

  /** Separa os JPEGs da saída do ffmpeg (início FFD8, fim FFD9). */
  #onData = (chunk: Buffer): void => {
    this.#out = Buffer.concat([this.#out, chunk]);
    for (;;) {
      const start = this.#out.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { this.#out = Buffer.alloc(0); return; }
      const end = this.#out.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) { this.#out = this.#out.subarray(start); return; }
      this.emit("jpeg", Buffer.from(this.#out.subarray(start, end + 2)));
      this.#out = this.#out.subarray(end + 2);
    }
  };

  #kill = (): void => {
    this.#ff?.stdin.end();
    this.#ff?.kill("SIGKILL");
    this.#ff = null;
    this.#out = Buffer.alloc(0);
    this.#busy = false;
  };
}
