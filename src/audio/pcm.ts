/** Taxa nativa do áudio da chamada (WASM do WhatsApp): 16 kHz mono Float32. */
export const CALL_SAMPLE_RATE = 16_000;

/** Float32 [-1, 1] -> PCM16 little-endian. */
export const floatToPcm16 = (input: Float32Array): Buffer => {
  const out = Buffer.alloc(input.length * 2);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), i * 2);
  }
  return out;
};

/** PCM16 little-endian -> Float32 [-1, 1]. Um byte ímpar no fim é ignorado. */
export const pcm16ToFloat = (input: Buffer): Float32Array => {
  const samples = Math.floor(input.length / 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = input.readInt16LE(i * 2) / 0x8000;
  return out;
};

/**
 * Reamostrador linear com estado (sem "cliques" entre chunks).
 * Qualidade suficiente para voz; troque por um polifásico se precisar.
 */
export class LinearResampler {
  readonly #ratio: number;
  #pos = 0;
  #last = 0;
  #primed = false;

  constructor(readonly fromRate: number, readonly toRate: number) {
    this.#ratio = fromRate / toRate;
  }

  get passthrough(): boolean { return this.fromRate === this.toRate; }

  process = (input: Float32Array): Float32Array => {
    if (this.passthrough || input.length === 0) return input;
    // Amostra virtual -1 = última do chunk anterior.
    const at = (i: number): number => (i < 0 ? this.#last : input[i]);
    if (!this.#primed) { this.#last = input[0]; this.#primed = true; }

    const out: number[] = [];
    let pos = this.#pos;
    while (pos < input.length - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      out.push(at(i) + (at(i + 1) - at(i)) * frac);
      pos += this.#ratio;
    }
    this.#pos = pos - input.length;
    this.#last = input[input.length - 1];
    return Float32Array.from(out);
  };
}
