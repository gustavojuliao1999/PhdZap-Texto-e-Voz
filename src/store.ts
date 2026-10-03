import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CallView } from "./line-manager.js";
import type { LineConfig } from "./worker/protocol.js";

const HISTORY_LOAD_LIMIT = 1000;

export const newLineToken = (): string => `wvl_${randomBytes(24).toString("base64url")}`;
export const newAdminKey = (): string => `wva_${randomBytes(24).toString("base64url")}`;

/** Persistência simples em arquivos JSON dentro de DATA_DIR. */
export class Store {
  readonly #linesFile: string;
  readonly #callsFile: string;
  readonly #adminFile: string;

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.#linesFile = path.join(dataDir, "lines.json");
    this.#callsFile = path.join(dataDir, "calls.jsonl");
    this.#adminFile = path.join(dataDir, "admin.json");
  }

  authDirFor = (lineId: string): string => path.join(this.dataDir, "lines", lineId, "auth");

  /** Chave de acesso do painel/API admin: env ADMIN_API_KEY ou gerada e salva no 1º uso. */
  adminKey = (fromEnv?: string): { key: string; generated: boolean } => {
    if (fromEnv) return { key: fromEnv, generated: false };
    if (existsSync(this.#adminFile)) {
      return { key: JSON.parse(readFileSync(this.#adminFile, "utf8")).key, generated: false };
    }
    const key = newAdminKey();
    this.#writeJson(this.#adminFile, { key });
    return { key, generated: true };
  };

  loadLines = (): LineConfig[] =>
    existsSync(this.#linesFile) ? JSON.parse(readFileSync(this.#linesFile, "utf8")) : [];

  saveLines = (lines: LineConfig[]): void => this.#writeJson(this.#linesFile, lines);

  newLine = (name: string): LineConfig => ({
    id: randomUUID().slice(0, 8),
    name,
    token: newLineToken(),
    createdAt: new Date().toISOString(),
    inboundMode: "manual",
    inboundAnswerDelayMs: 1500,
    maxCallDurationMs: 3_600_000,
    handler: "silence",
    bridgeUrl: "ws://127.0.0.1:8090/media",
    bridgeSampleRate: 16000,
    allowedOrigins: [],
  });

  appendCall = (call: CallView): void => {
    appendFileSync(this.#callsFile, JSON.stringify(call) + "\n", { mode: 0o600 });
  };

  /** Últimas chamadas (mais recentes primeiro). */
  loadCalls = (): CallView[] => {
    if (!existsSync(this.#callsFile)) return [];
    const lines = readFileSync(this.#callsFile, "utf8").trim().split("\n").filter(Boolean);
    const out: CallView[] = [];
    for (const l of lines.slice(-HISTORY_LOAD_LIMIT).reverse()) {
      try { out.push(JSON.parse(l)); } catch {}
    }
    return out;
  };

  #writeJson = (file: string, data: unknown): void => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  };
}
