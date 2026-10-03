import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Prisma, type Call, type Line, type Message, type PrismaClient } from "@prisma/client";
import type { CallView, MessageView } from "./line-manager.js";
import { log } from "./log.js";
import type { HandlerName, LineConfig, MessageRecord, MessageStatus } from "./worker/protocol.js";

export const newLineToken = (): string => `wvl_${randomBytes(24).toString("base64url")}`;
export const newAdminKey = (): string => `wva_${randomBytes(24).toString("base64url")}`;
export const newWebhookSecret = (): string => `whs_${randomBytes(24).toString("base64url")}`;

/** Ordem dos status: um "delivered" atrasado não volta uma mensagem já lida. */
const STATUS_RANK: Record<MessageStatus, number> = { error: 0, pending: 1, sent: 2, delivered: 3, read: 4, played: 5 };

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
  webhookUrl: l.webhookUrl,
  webhookSecret: l.webhookSecret,
  webhookEvents: l.webhookEvents,
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
  webhookUrl: c.webhookUrl,
  webhookSecret: c.webhookSecret,
  webhookEvents: c.webhookEvents,
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

const toMessageView = (m: Message): MessageView => {
  const extra = (m.extra ?? {}) as Pick<MessageRecord, "media" | "location" | "contact">;
  return {
    id: m.waId,
    lineId: m.lineId,
    direction: m.direction as MessageView["direction"],
    remote: m.remote,
    remoteJid: m.remoteJid,
    pushName: m.pushName ?? undefined,
    type: m.type as MessageView["type"],
    text: m.text ?? undefined,
    ...extra,
    replyTo: m.replyTo ?? undefined,
    status: m.status as MessageStatus,
    agent: m.agent ?? undefined,
    timestamp: m.timestamp.toISOString(),
  };
};

/** Conversa (contato) de uma linha. */
export type ChatView = { remote: string; remoteJid: string; name?: string; unread: number; last: MessageView };

const date = (iso?: string): Date | undefined => (iso ? new Date(iso) : undefined);

/** Persistência: PostgreSQL (Prisma) + sessões do WhatsApp em arquivos dentro de DATA_DIR. */
export class Store {
  constructor(readonly dataDir: string, private readonly db: PrismaClient) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  authDirFor = (lineId: string): string => path.join(this.dataDir, "lines", lineId, "auth");

  /** Arquivo de cache da mídia de uma mensagem (evita baixar do WhatsApp toda vez). */
  mediaFileFor = (lineId: string, waId: string): string =>
    path.join(this.dataDir, "lines", lineId, "media", createHash("sha1").update(waId).digest("hex"));

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
    webhookUrl: "",
    webhookSecret: newWebhookSecret(),
    webhookEvents: [],
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

  // ─── mensagens ──────────────────────────────────────────────────────────

  /** Grava a mensagem. Retorna null se ela já existia (o WhatsApp pode repetir eventos). */
  insertMessage = async (lineId: string, rec: MessageRecord, raw: string, agent?: string): Promise<MessageView | null> => {
    const extra = { media: rec.media, location: rec.location, contact: rec.contact };
    try {
      const row = await this.db.message.create({
        data: {
          lineId,
          waId: rec.id,
          direction: rec.direction,
          remote: rec.remote,
          remoteJid: rec.remoteJid,
          pushName: rec.pushName,
          type: rec.type,
          text: rec.text,
          extra: Object.values(extra).some(Boolean) ? (JSON.parse(JSON.stringify(extra)) as Prisma.InputJsonObject) : undefined,
          replyTo: rec.replyTo,
          status: rec.status,
          agent,
          timestamp: new Date(rec.timestamp),
          raw,
        },
      });
      return toMessageView(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
      throw err;
    }
  };

  /** Atualiza o status só se ele avançou. Retorna a mensagem atualizada ou null. */
  updateMessageStatus = async (lineId: string, waId: string, status: MessageStatus): Promise<MessageView | null> => {
    const row = await this.db.message.findUnique({ where: { lineId_waId: { lineId, waId } } });
    if (!row || STATUS_RANK[status] <= (STATUS_RANK[row.status as MessageStatus] ?? -1)) return null;
    return toMessageView(await this.db.message.update({ where: { id: row.id }, data: { status } }));
  };

  /** Mensagens mais recentes primeiro. `remote` filtra por contato; `before` pagina. */
  listMessages = async (
    lineId: string,
    opts: { remote?: string; before?: Date; limit?: number } = {},
  ): Promise<MessageView[]> => {
    const rows = await this.db.message.findMany({
      where: {
        lineId,
        ...(opts.remote ? { remote: opts.remote } : {}),
        ...(opts.before ? { timestamp: { lt: opts.before } } : {}),
      },
      orderBy: { timestamp: "desc" },
      take: Math.min(Math.max(opts.limit ?? 50, 1), 500),
    });
    return rows.map(toMessageView);
  };

  /** Conversas: última mensagem, nome do contato e não lidas. Mais recentes primeiro. */
  listChats = async (lineId: string): Promise<ChatView[]> => {
    const [last, names, unread] = await Promise.all([
      this.db.$queryRaw<Message[]>`
        SELECT DISTINCT ON ("remote") * FROM "Message"
        WHERE "lineId" = ${lineId} AND "type" <> 'reaction'
        ORDER BY "remote", "timestamp" DESC`,
      this.db.$queryRaw<{ remote: string; pushName: string }[]>`
        SELECT DISTINCT ON ("remote") "remote", "pushName" FROM "Message"
        WHERE "lineId" = ${lineId} AND "pushName" IS NOT NULL
        ORDER BY "remote", "timestamp" DESC`,
      this.db.message.groupBy({
        by: ["remote"],
        where: { lineId, direction: "incoming", status: "delivered", type: { not: "reaction" } },
        _count: { _all: true },
      }),
    ]);
    const nameOf = new Map(names.map((n) => [n.remote, n.pushName]));
    const unreadOf = new Map(unread.map((u) => [u.remote, u._count._all]));
    return last
      .map((m) => ({
        remote: m.remote,
        remoteJid: m.remoteJid,
        name: nameOf.get(m.remote),
        unread: unreadOf.get(m.remote) ?? 0,
        last: toMessageView(m),
      }))
      .sort((a, b) => b.last.timestamp.localeCompare(a.last.timestamp));
  };

  /**
   * Marca como lidas as mensagens recebidas de um contato (até `upTo`, se vier).
   * Retorna o JSON bruto delas, para avisar o WhatsApp.
   */
  markRead = async (lineId: string, remote: string, upTo?: Date): Promise<string[]> => {
    const where = {
      lineId, remote, direction: "incoming", status: "delivered",
      ...(upTo ? { timestamp: { lte: upTo } } : {}),
    };
    const rows = await this.db.message.findMany({ where, select: { id: true, raw: true }, orderBy: { timestamp: "desc" }, take: 300 });
    if (!rows.length) return [];
    await this.db.message.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: "read" } });
    return rows.map((r) => r.raw).filter((r): r is string => !!r);
  };

  getMessage = async (lineId: string, waId: string): Promise<{ view: MessageView; raw: string | null } | null> => {
    const row = await this.db.message.findUnique({ where: { lineId_waId: { lineId, waId } } });
    return row ? { view: toMessageView(row), raw: row.raw } : null;
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
