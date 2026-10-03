import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Call, Line, PrismaClient } from "@prisma/client";
import type { CallView } from "./line-manager.js";
import { log } from "./log.js";
import type { HandlerName, LineConfig } from "./worker/protocol.js";

export const newLineToken = (): string => `wvl_${randomBytes(24).toString("base64url")}`;
export const newAdminKey = (): string => `wva_${randomBytes(24).toString("base64url")}`;

const toConfig = (l: Line): LineConfig => ({
  id: l.id,
  name: l.name,
  token: l.token,
  createdAt: l.createdAt.toISOString(),
  inboundMode: l.inboundMode as LineConfig["inboundMode"],
  inboundAnswerDelayMs: l.inboundAnswerDelayMs,
  maxCallDurationMs: l.maxCallDurationMs,
  handler: l.handler as HandlerName,
  bridgeUrl: l.bridgeUrl,
  bridgeSampleRate: l.bridgeSampleRate,
  allowedOrigins: l.allowedOrigins,
});

const fromConfig = (c: LineConfig) => ({
  name: c.name,
  token: c.token,
  inboundMode: c.inboundMode,
  inboundAnswerDelayMs: c.inboundAnswerDelayMs,
  maxCallDurationMs: c.maxCallDurationMs,
  handler: c.handler,
  bridgeUrl: c.bridgeUrl,
  bridgeSampleRate: c.bridgeSampleRate,
  allowedOrigins: c.allowedOrigins,
});

const toView = (c: Call): CallView => ({
  id: c.callId,
  lineId: c.lineId ?? "",
  lineName: c.lineName,
  direction: c.direction as CallView["direction"],
  remote: c.remote,
  remoteJid: c.remoteJid ?? undefined,
  pushName: c.pushName ?? undefined,
  handler: c.handler ?? undefined,
  ownerAgent: c.ownerAgent ?? undefined,
  ownerUserId: c.ownerUserId ?? undefined,
  status: "ended",
  startedAt: c.startedAt.toISOString(),
  connectedAt: c.connectedAt?.toISOString(),
  endedAt: c.endedAt?.toISOString(),
  endReason: c.endReason ?? undefined,
});

const date = (iso?: string): Date | undefined => (iso ? new Date(iso) : undefined);

/** Persistência: PostgreSQL (Prisma) + sessões do WhatsApp em arquivos dentro de DATA_DIR. */
export class Store {
  constructor(readonly dataDir: string, private readonly db: PrismaClient) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  authDirFor = (lineId: string): string => path.join(this.dataDir, "lines", lineId, "auth");

  /** Chave do super admin: env ADMIN_API_KEY ou gerada e salva em DATA_DIR/admin.json. */
  adminKey = (fromEnv?: string): { key: string; generated: boolean } => {
    if (fromEnv) return { key: fromEnv, generated: false };
    const file = path.join(this.dataDir, "admin.json");
    if (existsSync(file)) return { key: JSON.parse(readFileSync(file, "utf8")).key, generated: false };
    const key = newAdminKey();
    writeFileSync(file, JSON.stringify({ key }, null, 2), { mode: 0o600 });
    return { key, generated: true };
  };

  // ─── linhas ─────────────────────────────────────────────────────────────

  listLines = async (): Promise<LineConfig[]> =>
    (await this.db.line.findMany({ orderBy: { createdAt: "asc" } })).map(toConfig);

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

  insertLine = async (c: LineConfig): Promise<void> => {
    await this.db.line.create({ data: { id: c.id, createdAt: new Date(c.createdAt), ...fromConfig(c) } });
  };

  updateLine = async (c: LineConfig): Promise<void> => {
    await this.db.line.update({ where: { id: c.id }, data: fromConfig(c) });
  };

  deleteLine = async (id: string): Promise<void> => {
    await this.db.line.delete({ where: { id } });
  };

  // ─── histórico ──────────────────────────────────────────────────────────

  appendCall = async (v: CallView): Promise<void> => {
    await this.db.call.create({
      data: {
        callId: v.id,
        lineId: v.lineId || null,
        lineName: v.lineName,
        direction: v.direction,
        remote: v.remote,
        remoteJid: v.remoteJid,
        pushName: v.pushName,
        handler: v.handler,
        ownerAgent: v.ownerAgent,
        ownerUserId: v.ownerUserId,
        startedAt: date(v.startedAt) ?? new Date(),
        connectedAt: date(v.connectedAt),
        endedAt: date(v.endedAt),
        endReason: v.endReason,
      },
    });
  };

  /** Últimas ligações (mais recentes primeiro). `lineIds` null = todas. */
  recentCalls = async (lineIds: string[] | null, limit = 200): Promise<CallView[]> => {
    const rows = await this.db.call.findMany({
      where: lineIds ? { lineId: { in: lineIds } } : undefined,
      orderBy: { startedAt: "desc" },
      take: limit,
    });
    return rows.map(toView);
  };

  // ─── migração da versão em arquivos ─────────────────────────────────────

  /**
   * Importa data/lines.json e data/calls.jsonl (versão anterior) se o banco
   * ainda não tiver linhas. Os arquivos são renomeados para *.importado.
   */
  importLegacyFiles = async (): Promise<void> => {
    const linesFile = path.join(this.dataDir, "lines.json");
    if (!existsSync(linesFile) || (await this.db.line.count()) > 0) return;
    const lines: LineConfig[] = JSON.parse(readFileSync(linesFile, "utf8"));
    for (const l of lines) await this.insertLine(l);
    let calls = 0;
    const callsFile = path.join(this.dataDir, "calls.jsonl");
    if (existsSync(callsFile)) {
      for (const row of readFileSync(callsFile, "utf8").split("\n").filter(Boolean)) {
        try { await this.appendCall(JSON.parse(row)); calls++; } catch {}
      }
      renameSync(callsFile, `${callsFile}.importado`);
    }
    renameSync(linesFile, `${linesFile}.importado`);
    log.info(`importado para o banco: ${lines.length} linha(s) e ${calls} ligação(ões) dos arquivos antigos`);
  };
}
