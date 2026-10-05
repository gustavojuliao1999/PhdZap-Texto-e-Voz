/**
 * Audio feeder.
 *
 * Spawns ffmpeg to decode `source` into f32le PCM at the requested rate, then
 * meters frames out at chunk-cadence to the WASM uplink.
 *
 * With `source === "stream"` no ffmpeg is spawned: PCM is supplied at runtime
 * via `push()` (already at the negotiated rate), and silence fills any gaps.
 *
 * @author ShellTear
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const LOW_WATERMARK_CHUNKS = 16;
const MAX_QUEUED_CHUNKS = 1024;
/** Stream mode: TTS engines often deliver faster than realtime, so allow ~5 min. */
const MAX_STREAM_QUEUED_CHUNKS = 15_000;
const DEFAULT_WARMUP_MS = 500;

export class AudioFeeder {
  #proc: ChildProcessWithoutNullStreams | null = null;
  #running = false;
  #pending = Buffer.alloc(0);
  #queue: Float32Array[] = [];
  #emitTimer: NodeJS.Timeout | null = null;
  #nextEmitAtMs = 0;
  #warmupUntilMs = 0;

  droppedChunks = 0;
  underflowChunks = 0;
  bytesProduced = 0;
  chunksEmitted = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly channels: number,
    private readonly framesPerChunk: number,
    private readonly onChunk: (chunk: Float32Array) => void,
    private readonly source: string = "silence",
  ) {}

  get isStream(): boolean { return this.source === "stream"; }

  /** Milliseconds of audio queued but not yet sent. */
  get queuedMs(): number {
    const samples = this.#queue.length * this.framesPerChunk +
      this.#pending.length / Float32Array.BYTES_PER_ELEMENT / this.channels;
    return (samples / this.sampleRate) * 1000;
  }

  start = (): void => {
    if (this.#running) return;
    this.#running = true;

    const chunkSamples = this.framesPerChunk * this.channels;
    const chunkIntervalMs = (this.framesPerChunk / this.sampleRate) * 1000;

    if (this.isStream) {
      this.#nextEmitAtMs = 0;
      this.#warmupUntilMs = 0;
      this.#scheduleNext(chunkSamples, chunkIntervalMs);
      return;
    }

    const chunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
    const inputArgs = this.#resolveInputArgs();

    this.#proc = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-thread_queue_size", "512",
      ...inputArgs,
      "-f", "f32le",
      "-ac", String(this.channels),
      "-ar", String(this.sampleRate),
      "pipe:1",
    ]);

    this.#proc.stdout.on("data", (chunk: Buffer) => {
      this.#pending = Buffer.concat([this.#pending, chunk]);
      while (this.#pending.length >= chunkBytes) {
        if (this.#queue.length >= MAX_QUEUED_CHUNKS) {
          this.#proc?.stdout.pause();
          break;
        }
        const frame = this.#pending.subarray(0, chunkBytes);
        this.#pending = this.#pending.subarray(chunkBytes);
        const out = new Float32Array(chunkSamples);
        out.set(new Float32Array(frame.buffer, frame.byteOffset, chunkSamples));
        this.bytesProduced += chunkBytes;
        this.#queue.push(out);
      }
    });

    this.#proc.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[AudioFeeder] ${chunk.toString().trim()}\n`);
    });

    this.#proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        process.stderr.write(`[AudioFeeder] ffmpeg exited with code=${code}\n`);
      }
      this.#proc = null;
    });

    this.#nextEmitAtMs = 0;
    this.#warmupUntilMs = Date.now() + DEFAULT_WARMUP_MS;
    this.#scheduleNext(chunkSamples, chunkIntervalMs);
  };

  /** Queue PCM (Float32, negotiated rate/channels) for the uplink. Stream mode only. */
  push = (pcm: Float32Array): void => {
    if (!this.isStream || !this.#running || pcm.length === 0) return;
    const chunkSamples = this.framesPerChunk * this.channels;
    const chunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
    this.#pending = Buffer.concat([
      this.#pending,
      Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    ]);
    while (this.#pending.length >= chunkBytes) {
      if (this.#queue.length >= MAX_STREAM_QUEUED_CHUNKS) {
        this.droppedChunks += 1;
        this.#queue.shift();
      }
      const out = new Float32Array(chunkSamples);
      out.set(new Float32Array(
        this.#pending.buffer.slice(this.#pending.byteOffset, this.#pending.byteOffset + chunkBytes),
      ));
      this.#pending = this.#pending.subarray(chunkBytes);
      this.bytesProduced += chunkBytes;
      this.#queue.push(out);
    }
  };

  /** Drop everything queued (e.g. caller barged in while the bot was talking). */
  clear = (): void => {
    this.#queue = [];
    this.#pending = Buffer.alloc(0);
  };

  stop = (): void => {
    this.#running = false;
    if (this.#emitTimer) {
      clearTimeout(this.#emitTimer);
      this.#emitTimer = null;
    }
    this.#proc?.kill("SIGTERM");
    this.#proc = null;
    this.#pending = Buffer.alloc(0);
    this.#queue = [];
    this.#warmupUntilMs = 0;
  };

  #resolveInputArgs = (): string[] => {
    if (!this.source || this.source === "silence") {
      return ["-f", "lavfi", "-i", `aevalsrc=0:d=3600:s=${this.sampleRate}`];
    }
    if (this.source.startsWith("lavfi:")) {
      return ["-f", "lavfi", "-i", this.source.slice("lavfi:".length)];
    }
    return ["-i", this.source];
  };

  #scheduleNext = (chunkSamples: number, chunkIntervalMs: number): void => {
    if (!this.#running) return;
    const now = Date.now();
    if (this.#nextEmitAtMs === 0) this.#nextEmitAtMs = now;
    const delayMs = Math.max(0, this.#nextEmitAtMs - now);

    this.#emitTimer = setTimeout(() => {
      this.#emitTimer = null;
      if (this.#queue.length < LOW_WATERMARK_CHUNKS && Date.now() < this.#warmupUntilMs) {
        this.#nextEmitAtMs = Date.now() + 10;
        this.#scheduleNext(chunkSamples, chunkIntervalMs);
        return;
      }
      this.#flushOne(chunkSamples);
      this.#nextEmitAtMs += chunkIntervalMs;
      this.#scheduleNext(chunkSamples, chunkIntervalMs);
    }, delayMs);
  };

  #flushOne = (chunkSamples: number): void => {
    let nextChunk = this.#queue.shift();
    if (!nextChunk) {
      nextChunk = new Float32Array(chunkSamples);
      this.underflowChunks += 1;
    }
    this.chunksEmitted += 1;
    this.onChunk(nextChunk);
    if (this.#proc?.stdout.isPaused() && this.#queue.length <= MAX_QUEUED_CHUNKS / 4) {
      this.#proc.stdout.resume();
    }
  };
}
