import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { log } from "./log.js";

export type MaintenanceOptions = {
  dataDir: string;
  /** Apaga mídia em cache sem uso há mais de N dias (0 = nunca). */
  mediaCacheDays: number;
  /** Tamanho máximo do cache de mídia, em MB (0 = sem limite). */
  mediaCacheMaxMb: number;
  /** Tarefas extras (ex.: limpar o histórico do webhook). */
  tasks: (() => Promise<void>)[];
};

type CachedFile = { file: string; size: number; at: number };

const listMedia = (dataDir: string): CachedFile[] => {
  const out: CachedFile[] = [];
  const linesDir = path.join(dataDir, "lines");
  let lineIds: string[] = [];
  try { lineIds = readdirSync(linesDir); } catch { return out; }
  for (const id of lineIds) {
    const dir = path.join(linesDir, id, "media");
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const st = statSync(file);
        // atime pode estar desligado (noatime): usa o mais recente entre acesso e escrita.
        out.push({ file, size: st.size, at: Math.max(st.atimeMs, st.mtimeMs) });
      } catch {}
    }
  }
  return out;
};

/** Limpa o cache de mídia por idade e por tamanho total (remove os menos usados primeiro). */
export const cleanMediaCache = (dataDir: string, days: number, maxMb: number): { removed: number; freedMb: number } => {
  const files = listMedia(dataDir).sort((a, b) => a.at - b.at);
  let total = files.reduce((n, f) => n + f.size, 0);
  const limit = maxMb > 0 ? maxMb * 1024 * 1024 : Infinity;
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : -Infinity;
  let removed = 0, freed = 0;
  for (const f of files) {
    if (f.at >= cutoff && total <= limit) break;
    try { rmSync(f.file, { force: true }); } catch { continue; }
    removed++; freed += f.size; total -= f.size;
  }
  return { removed, freedMb: Math.round((freed / 1048576) * 10) / 10 };
};

/** Roda a manutenção agora e depois a cada hora. */
export const startMaintenance = (opts: MaintenanceOptions): void => {
  const run = async (): Promise<void> => {
    const { removed, freedMb } = cleanMediaCache(opts.dataDir, opts.mediaCacheDays, opts.mediaCacheMaxMb);
    if (removed) log.info(`cache de mídia: ${removed} arquivo(s) removido(s), ${freedMb} MB liberados`);
    for (const task of opts.tasks) await task().catch((err) => log.warn(`manutenção: ${err.message}`));
  };
  setTimeout(() => void run(), 60_000).unref();
  setInterval(() => void run(), 3_600_000).unref();
};
