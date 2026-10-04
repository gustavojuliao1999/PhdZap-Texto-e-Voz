import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LineEvent, LineManager } from "./line-manager.js";
import { log } from "./log.js";
import type { Store } from "./store.js";

/**
 * Transcrição de áudio para texto. Desligada por padrão; no .env:
 *   TRANSCRIBE=local  → whisper.cpp dentro do próprio container (modelo baixado na 1ª vez)
 *   TRANSCRIBE=api    → API compatível com OpenAI (/v1/audio/transcriptions: OpenAI, Groq…)
 */
export type TranscribeMode = "off" | "local" | "api";

export const transcribeMode = (): TranscribeMode => {
  const m = process.env.TRANSCRIBE?.trim().toLowerCase();
  return m === "local" || m === "api" ? m : "off";
};

export const transcriptionConfigured = (): boolean => transcribeMode() !== "off";

const DEFAULT_API_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_LOCAL_MODEL = "small";

export const transcribeModel = (): string =>
  process.env.TRANSCRIBE_MODEL?.trim() || (transcribeMode() === "local" ? DEFAULT_LOCAL_MODEL : "whisper-1");

/** Trecho falado: início e fim em segundos. */
export type Segment = { start: number; end: number; text: string };
/** Fala de um dos lados da ligação. `at` em segundos desde o início da gravação. */
export type TranscriptTurn = { at: number; who: "contact" | "agent"; text: string };

/** Gravação com um lado em cada canal (esq. = contato, dir. = atendente/bot), usada só para transcrever. */
export const sidesFileOf = (recordingFile: string): string => recordingFile.replace(/\.ogg$/, ".sides.ogg");

// ─── utilitários ─────────────────────────────────────────────────────────

const run = (cmd: string, args: string[], opts: { nice?: boolean } = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    // Prioridade baixa: a transcrição não pode atrasar o áudio das ligações em andamento.
    if (opts.nice && proc.pid) { try { os.setPriority(proc.pid, 19); } catch {} }
    let out = "", err = "";
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; if (err.length > 20_000) err = err.slice(-10_000); });
    proc.on("error", (e) => reject(new Error(`${cmd} indisponível: ${e.message}`)));
    proc.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} saiu com código ${code}: ${err.trim().split("\n").slice(-3).join(" ")}`)));
  });

/** Converte o áudio para o formato do motor: wav 16 kHz mono (local) ou ogg/opus (api, arquivo pequeno). */
const convert = async (input: string, output: string, channel?: 0 | 1): Promise<void> => {
  const pick = channel === undefined ? ["-ac", "1"] : ["-af", `pan=mono|c0=c${channel}`];
  const codec = output.endsWith(".wav") ? ["-c:a", "pcm_s16le"] : ["-c:a", "libopus", "-b:a", "24k", "-application", "voip"];
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vn", ...pick, "-ar", "16000", ...codec, output]);
};

/** Frases que o Whisper "inventa" em trechos de silêncio ou ruído. */
const HALLUCINATIONS = [
  /amara\.org/i, /legendas? (pela|por)/i, /obrigad[oa] por assistir/i, /inscreva-se/i, /^\s*\[(música|musica|silêncio|risos|aplausos)\]\s*$/i,
  /^\s*\((música|musica|silêncio|risos)\)\s*$/i, /^[\s.…,!?-]*$/,
];
const clean = (segments: Segment[]): Segment[] =>
  segments
    .map((s) => ({ ...s, text: s.text.replace(/\s+/g, " ").trim() }))
    .filter((s) => s.text && !HALLUCINATIONS.some((re) => re.test(s.text)));

// ─── motor local (whisper.cpp) ───────────────────────────────────────────

const WHISPER_CLI = (): string => process.env.WHISPER_CLI?.trim() || "whisper-cli";
const MODELS_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const VAD_MODEL = "ggml-silero-v5.1.2.bin";
const VAD_URL = `https://huggingface.co/ggml-org/whisper-vad/resolve/main/${VAD_MODEL}`;

const modelsDir = (): string => path.join(process.env.DATA_DIR || "./data", "models");

/** TRANSCRIBE_MODEL pode ser um nome (small, large-v3-turbo-q5_0…) ou o caminho de um .bin. */
const localModelPath = (): string => {
  const m = transcribeModel();
  return m.endsWith(".bin") ? path.resolve(m) : path.join(modelsDir(), `ggml-${m}.bin`);
};

const download = async (url: string, file: string): Promise<void> => {
  if (existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  log.info(`transcrição: baixando ${path.basename(file)} (só na primeira vez)...`);
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`falha ao baixar ${url}: HTTP ${res.status}`);
  const part = `${file}.part`;
  await writeFile(part, res.body as unknown as AsyncIterable<Uint8Array>);
  await rename(part, file);
  log.info(`transcrição: ${path.basename(file)} pronto`);
};

let modelsReady: Promise<void> | null = null;
/** Baixa o modelo e o detector de voz (VAD) para DATA_DIR/models, uma vez. */
const ensureLocalModels = (): Promise<void> => {
  modelsReady ??= (async () => {
    const model = localModelPath();
    if (!existsSync(model)) {
      if (transcribeModel().endsWith(".bin")) throw new Error(`modelo não encontrado: ${model}`);
      await download(`${MODELS_URL}/ggml-${transcribeModel()}.bin`, model);
    }
    await download(VAD_URL, path.join(modelsDir(), VAD_MODEL));
  })().catch((err) => { modelsReady = null; throw err; });
  return modelsReady;
};

const transcribeLocal = async (wav: string): Promise<Segment[]> => {
  await ensureLocalModels();
  const threads = Number(process.env.TRANSCRIBE_THREADS) || os.availableParallelism();
  const base = wav.replace(/\.wav$/, "");
  await run(WHISPER_CLI(), [
    "-m", localModelPath(), "-f", wav,
    "-l", process.env.TRANSCRIBE_LANGUAGE?.trim() || "auto",
    "-t", String(threads),
    // VAD: pula o silêncio (mais rápido e evita texto inventado); os tempos continuam os do áudio original.
    "--vad", "-vm", path.join(modelsDir(), VAD_MODEL),
    // Tempo de cada palavra (-ml 1 -sow): o whisper junta falas separadas por silêncio num trecho só,
    // e na ligação isso embaralharia a ordem entre cliente e atendente. Reagrupa pelas pausas.
    "-ml", "1", "-sow",
    "-sns", "-np", "-oj", "-of", base,
  ], { nice: true });
  const json = JSON.parse(await readFile(`${base}.json`, "utf8")) as { transcription?: { offsets: { from: number; to: number }; text: string }[] };
  return clean(groupWords((json.transcription ?? []).map((s) => ({ start: s.offsets.from / 1000, end: s.offsets.to / 1000, text: s.text }))));
};

/**
 * Junta palavras em falas, cortando nas pausas. Com o VAD, o fim de uma palavra encosta no começo
 * da seguinte, então a pausa aparece como uma palavra "comprida": mais de `longWord` segundos.
 */
export const groupWords = (words: Segment[], gap = 1, longWord = 1.2): Segment[] => {
  const out: Segment[] = [];
  let prev: Segment | undefined;
  for (const w of words) {
    const last = out.at(-1);
    const paused = !!prev && prev.end - prev.start > longWord;
    if (last && prev && !paused && w.start - prev.end <= gap) { last.text += w.text; last.end = w.end; }
    else {
      if (last && paused && prev) last.end = Math.min(last.end, prev.start + 0.8);
      out.push({ ...w });
    }
    prev = w;
  }
  return out;
};

// ─── motor por API (compatível com OpenAI) ───────────────────────────────

const apiRequest = async (data: Buffer, format: "verbose_json" | "json"): Promise<Response> => {
  const key = process.env.TRANSCRIBE_API_KEY?.trim();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)], { type: "audio/ogg" }), "audio.ogg");
  form.append("model", transcribeModel());
  const lang = process.env.TRANSCRIBE_LANGUAGE?.trim();
  if (lang) form.append("language", lang);
  form.append("response_format", format);
  return fetch(process.env.TRANSCRIBE_API_URL?.trim() || DEFAULT_API_URL, {
    method: "POST",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: form,
    signal: AbortSignal.timeout(10 * 60_000),
  });
};

const transcribeApi = async (ogg: string): Promise<Segment[]> => {
  const data = await readFile(ogg);
  // verbose_json traz os tempos de cada trecho; alguns modelos (gpt-4o-transcribe) só aceitam json.
  let res = await apiRequest(data, "verbose_json");
  if (res.status === 400) res = await apiRequest(data, "json");
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string; segments?: { start: number; end: number; text: string }[] };
  if (json.segments?.length) return clean(json.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })));
  return clean([{ start: 0, end: 0, text: String(json.text ?? "") }]);
};

// ─── entrada ─────────────────────────────────────────────────────────────

/** Transcreve um arquivo de áudio (qualquer formato do ffmpeg). `channel`: só um canal de um estéreo. */
export const transcribeFile = async (file: string, channel?: 0 | 1): Promise<Segment[]> => {
  const mode = transcribeMode();
  if (mode === "off") return [];
  const dir = mkdtempSync(path.join(os.tmpdir(), "phdzap-tr-"));
  try {
    const out = path.join(dir, mode === "local" ? "audio.wav" : "audio.ogg");
    await convert(file, out, channel);
    return mode === "local" ? await transcribeLocal(out) : await transcribeApi(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Junta as falas dos dois lados em ordem de tempo; falas seguidas do mesmo lado viram uma só. */
export const mergeTurns = (contact: Segment[], agent: Segment[]): TranscriptTurn[] => {
  const all = [
    ...contact.map((s) => ({ ...s, who: "contact" as const })),
    ...agent.map((s) => ({ ...s, who: "agent" as const })),
  ].sort((a, b) => a.start - b.start);
  const turns: (TranscriptTurn & { end: number })[] = [];
  for (const s of all) {
    const last = turns.at(-1);
    if (last && last.who === s.who) { last.text += ` ${s.text}`; last.end = s.end; continue; }
    turns.push({ at: Math.round(s.start * 10) / 10, who: s.who, text: s.text, end: s.end });
  }
  return turns.map(({ at, who, text }) => ({ at, who, text }));
};

/** Texto corrido da conversa ("Cliente: …" / "Atendente: …"), para quem lê só `transcript`. */
export const turnsToText = (turns: TranscriptTurn[], agentName = "Atendente"): string =>
  turns.map((t) => `${t.who === "contact" ? "Cliente" : agentName}: ${t.text}`).join("\n");

/**
 * Transcreve automaticamente as gravações das ligações (separando quem falou)
 * e os áudios de voz das conversas (recebidos e enviados).
 * Uma transcrição por vez, para não pesar no servidor nem estourar limites da API.
 */
export class Transcriber {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly lines: LineManager, private readonly store: Store) {
    const mode = transcribeMode();
    if (mode === "off") return;
    log.info(`transcrição ligada (${mode}, modelo ${transcribeModel()})`);
    if (mode === "local") ensureLocalModels().catch((err) => log.warn(`transcrição: ${err.message}`));
    lines.on("event", (e: LineEvent) => {
      if (e.type === "call-update" && e.kind === "recording") this.#enqueue(() => this.#call(e.lineId, e.call.id, e.call.remote));
      if (e.type === "message" && e.message.type === "audio" && e.message.media?.ptt && !e.message.deletedAt) {
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
    const sides = this.lines.lineFile(lineId, sidesFileOf(call.recordingFile));
    let turns: TranscriptTurn[] | undefined;
    let transcript: string;
    if (existsSync(sides)) {
      turns = mergeTurns(await transcribeFile(sides, 0), await transcribeFile(sides, 1));
      transcript = turnsToText(turns, call.ownerAgent ?? "Atendente");
      await rm(sides, { force: true });
    } else {
      // Gravação sem os lados separados (feita com a transcrição desligada): não dá para saber quem falou.
      transcript = (await transcribeFile(this.lines.lineFile(lineId, call.recordingFile))).map((s) => s.text).join(" ");
    }
    if (!transcript) return;
    const segments = turns ? { transcriptSegments: turns } : {};
    await this.store.updateCall(lineId, callId, { transcript, ...segments });
    this.lines.emit("event", { type: "call-update", lineId, kind: "transcript", call: { id: callId, remote, transcript, ...segments } } satisfies LineEvent);
  };

  #voiceNote = async (lineId: string, waId: string): Promise<void> => {
    const file = await this.lines.audioFile(lineId, waId);
    if (!file) return;
    const text = (await transcribeFile(file)).map((s) => s.text).join(" ");
    if (!text) return;
    const updated = await this.store.setMessageTranscript(lineId, waId, text);
    this.lines.emit("event", { type: "message-update", lineId, message: updated } satisfies LineEvent);
  };
}
