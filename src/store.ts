import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Prisma, type Call, type Contact, type Line, type Message, type PrismaClient, type QuickReply } from "@prisma/client";
import type { CallView, MessageView } from "./line-manager.js";
import { log } from "./log.js";
import type { ContactRecord, HandlerName, LineConfig, MessageRecord, MessageStatus } from "./worker/protocol.js";

export const newLineToken = (): string => `wvl_${randomBytes(24).toString("base64url")}`;
export const newAdminKey = (): string => `wva_${randomBytes(24).toString("base64url")}`;
export const newWebhookSecret = (): string => `whs_${randomBytes(24).toString("base64url")}`;

/** Seg–sex 8h–18h, sáb 8h–12h. */
const DEFAULT_HOURS: LineConfig["businessHours"] = {
  "1": [["08:00", "18:00"]], "2": [["08:00", "18:00"]], "3": [["08:00", "18:00"]],
  "4": [["08:00", "18:00"]], "5": [["08:00", "18:00"]], "6": [["08:00", "12:00"]], "0": [],
};

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
  rateLimitPerMinute: l.rateLimitPerMinute,
  rateLimitPerDay: l.rateLimitPerDay,
  businessHoursEnabled: l.businessHoursEnabled,
  businessHours: (l.businessHours ?? {}) as LineConfig["businessHours"],
  offHoursMessage: l.offHoursMessage,
  groupsEnabled: l.groupsEnabled,
  recordCalls: l.recordCalls,
  transcribeCalls: l.transcribeCalls,
  transcribeVoiceNotes: l.transcribeVoiceNotes,
  hiddenContacts: l.hiddenContacts,
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
  rateLimitPerMinute: c.rateLimitPerMinute,
  rateLimitPerDay: c.rateLimitPerDay,
  businessHoursEnabled: c.businessHoursEnabled,
  businessHours: c.businessHours as Prisma.InputJsonObject,
  offHoursMessage: c.offHoursMessage,
  groupsEnabled: c.groupsEnabled,
  recordCalls: c.recordCalls,
  transcribeCalls: c.transcribeCalls,
  transcribeVoiceNotes: c.transcribeVoiceNotes,
  hiddenContacts: c.hiddenContacts,
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
  hasRecording: !!c.recordingFile,
  recordingSeconds: c.recordingSeconds ?? undefined,
  transcript: c.transcript ?? undefined,
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
    ...(m.participant ? { participant: m.participant } : {}),
    ...(m.participantName ? { participantName: m.participantName } : {}),
    ...(m.editedAt ? { editedAt: m.editedAt.toISOString() } : {}),
    ...(m.deletedAt ? { deletedAt: m.deletedAt.toISOString() } : {}),
    ...(m.transcript ? { transcript: m.transcript } : {}),
  };
};

/** Conversa vista pela equipe (dados do atendimento). */
export type ContactView = {
  remote: string;
  name?: string;
  notes: string;
  status: "open" | "pending" | "resolved";
  assignedUserId?: string;
  assignedName?: string;
  updatedAt?: string;
};

export const toContactView = (c: Contact | null, remote: string): ContactView => ({
  remote,
  name: c?.name ?? undefined,
  notes: c?.notes ?? "",
  status: (c?.status ?? "open") as ContactView["status"],
  assignedUserId: c?.assignedUserId ?? undefined,
  assignedName: c?.assignedName ?? undefined,
  updatedAt: c?.updatedAt.toISOString(),
});

/** Contato da agenda (pesquisa por nome e número). */
export type ContactSearchView = {
  remote: string;
  remoteJid?: string;
  /** Nome a mostrar: o da equipe, o da agenda do celular ou o do perfil. */
  name?: string;
  phoneName?: string;
  pushName?: string;
  /** Já há mensagens com o contato. */
  hasChat: boolean;
};

/** Conversa (contato) de uma linha. */
export type ChatView = ContactView & {
  remoteJid: string;
  /** Nome do perfil no WhatsApp (o `name` pode ter sido definido pela equipe). */
  profileName?: string;
  /** Nome salvo na agenda do celular. */
  phoneName?: string;
  /** Nome definido pela equipe (o `name` cai para a agenda e o perfil quando vazio). */
  teamName?: string;
  isGroup: boolean;
  unread: number;
  last: MessageView;
};

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
    rateLimitPerMinute: 20,
    rateLimitPerDay: 1000,
    businessHoursEnabled: false,
    businessHours: DEFAULT_HOURS,
    offHoursMessage: "",
    groupsEnabled: false,
    recordCalls: false,
    transcribeCalls: false,
    transcribeVoiceNotes: false,
    hiddenContacts: [],
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
          participant: rec.participant,
          participantName: rec.participantName,
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
    opts: { remote?: string; before?: Date; limit?: number; exclude?: string[] } = {},
  ): Promise<MessageView[]> => {
    const rows = await this.db.message.findMany({
      where: {
        lineId,
        ...(opts.remote ? { remote: opts.remote } : opts.exclude?.length ? { remote: { notIn: opts.exclude } } : {}),
        ...(opts.before ? { timestamp: { lt: opts.before } } : {}),
      },
      orderBy: { timestamp: "desc" },
      take: Math.min(Math.max(opts.limit ?? 50, 1), 500),
    });
    return rows.map(toMessageView);
  };

  /** Mensagem editada (novo texto) ou apagada. Retorna a mensagem se mudou algo. */
  applyMessageUpdate = async (lineId: string, waId: string, u: { text?: string; deleted?: boolean }): Promise<MessageView | null> => {
    const row = await this.db.message.findUnique({ where: { lineId_waId: { lineId, waId } } });
    if (!row || row.deletedAt) return null;
    if (u.deleted) {
      return toMessageView(await this.db.message.update({
        where: { id: row.id },
        // Apagada para todos: não guarda mais o conteúdo.
        data: { deletedAt: new Date(), text: null, raw: null, extra: Prisma.DbNull, transcript: null },
      }));
    }
    if (u.text === undefined || u.text === row.text) return null;
    return toMessageView(await this.db.message.update({ where: { id: row.id }, data: { text: u.text, editedAt: new Date() } }));
  };

  setMessageTranscript = async (lineId: string, waId: string, transcript: string): Promise<MessageView> =>
    toMessageView(await this.db.message.update({ where: { lineId_waId: { lineId, waId } }, data: { transcript } }));

  // ─── contatos / atendimento ─────────────────────────────────────────────

  getContact = (lineId: string, remote: string): Promise<Contact | null> =>
    this.db.contact.findUnique({ where: { lineId_remote: { lineId, remote } } });

  upsertContact = async (lineId: string, remote: string, data: Partial<Omit<Contact, "lineId" | "remote" | "createdAt" | "updatedAt">>): Promise<Contact> =>
    this.db.contact.upsert({ where: { lineId_remote: { lineId, remote } }, create: { lineId, remote, ...data }, update: data });

  /** Dá nome ao contato só se ainda não tiver (ex.: assunto do grupo). */
  ensureContactName = async (lineId: string, remote: string, name: string): Promise<void> => {
    const c = await this.getContact(lineId, remote);
    if (!c) await this.upsertContact(lineId, remote, { name });
    else if (!c.name) await this.db.contact.update({ where: { lineId_remote: { lineId, remote } }, data: { name } });
  };

  /**
   * Grava contatos da agenda / perfil. Só sobrescreve o que veio (o nome da equipe nunca muda).
   * Em lote, numa transação por bloco.
   */
  saveContacts = async (lineId: string, list: ContactRecord[]): Promise<void> => {
    for (let i = 0; i < list.length; i += 200) {
      await this.db.$transaction(list.slice(i, i + 200).map((c) => {
        const data = {
          remoteJid: c.remoteJid,
          ...(c.phoneName ? { phoneName: c.phoneName.slice(0, 200) } : {}),
          ...(c.pushName ? { pushName: c.pushName.slice(0, 200) } : {}),
        };
        return this.db.contact.upsert({
          where: { lineId_remote: { lineId, remote: c.remote } },
          create: { lineId, remote: c.remote, ...data },
          update: data,
        });
      }));
    }
  };

  /**
   * Pesquisa na agenda por nome (equipe, agenda do celular ou perfil) ou número, como no
   * WhatsApp Web. Contatos com conversa vêm primeiro.
   */
  searchContacts = async (lineId: string, q: string, opts: { limit?: number; exclude?: string[] } = {}): Promise<ContactSearchView[]> => {
    const term = q.trim();
    const digits = term.replace(/\D/g, "");
    const or: Prisma.ContactWhereInput[] = [];
    if (term) {
      for (const field of ["name", "phoneName", "pushName"] as const) or.push({ [field]: { contains: term, mode: "insensitive" } });
    }
    if (digits.length >= 2) or.push({ remote: { contains: digits } });
    const rows = await this.db.contact.findMany({
      where: {
        lineId,
        ...(term ? { OR: or.length ? or : [{ remote: "§" }] } : {}),
        ...(opts.exclude?.length ? { remote: { notIn: opts.exclude } } : {}),
        NOT: { remote: { endsWith: "@g.us" } },
      },
      take: 2000,
    });
    const withChat = new Set((await this.db.message.groupBy({
      by: ["remote"], where: { lineId, remote: { in: rows.map((r) => r.remote) } },
    })).map((g) => g.remote));
    const display = (c: Contact) => c.name ?? c.phoneName ?? c.pushName ?? undefined;
    return rows
      .map((c) => ({
        remote: c.remote,
        remoteJid: c.remoteJid ?? undefined,
        name: display(c),
        phoneName: c.phoneName ?? undefined,
        pushName: c.pushName ?? undefined,
        hasChat: withChat.has(c.remote),
      }))
      .sort((a, b) => Number(b.hasChat) - Number(a.hasChat)
        || Number(!!b.name) - Number(!!a.name)
        || (a.name ?? a.remote).localeCompare(b.name ?? b.remote, "pt-BR"))
      .slice(0, Math.min(Math.max(opts.limit ?? 50, 1), 500));
  };

  /**
   * Grava o histórico enviado pelo celular, sem repetir o que já existe. As recebidas entram
   * como lidas (não viram "não lidas" no painel). Retorna quantas entraram, por contato.
   */
  insertHistory = async (lineId: string, items: { message: MessageRecord; raw: string }[]): Promise<Map<string, number>> => {
    const added = new Map<string, number>();
    for (let i = 0; i < items.length; i += 500) {
      const chunk = items.slice(i, i + 500);
      const known = new Set((await this.db.message.findMany({
        where: { lineId, waId: { in: chunk.map((x) => x.message.id) } }, select: { waId: true },
      })).map((r) => r.waId));
      const fresh = chunk.filter((x) => !known.has(x.message.id));
      if (!fresh.length) continue;
      await this.db.message.createMany({
        skipDuplicates: true,
        data: fresh.map(({ message: rec, raw }) => {
          const extra = { media: rec.media, location: rec.location, contact: rec.contact };
          return {
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
            status: rec.direction === "incoming" && rec.status === "delivered" ? "read" : rec.status,
            timestamp: new Date(rec.timestamp),
            raw,
            participant: rec.participant,
            participantName: rec.participantName,
          };
        }),
      });
      for (const x of fresh) added.set(x.message.remote, (added.get(x.message.remote) ?? 0) + 1);
    }
    return added;
  };

  /** Mensagem mais antiga da conversa que serve de referência para pedir o histórico ao celular. */
  oldestMessage = async (lineId: string, remote: string): Promise<{ waId: string; raw: string; timestamp: Date } | null> => {
    const row = await this.db.message.findFirst({
      where: { lineId, remote, raw: { not: null } },
      orderBy: { timestamp: "asc" },
      select: { waId: true, raw: true, timestamp: true },
    });
    return row?.raw ? { waId: row.waId, raw: row.raw, timestamp: row.timestamp } : null;
  };

  /** Contatos com conversa (para a sincronização completa), do mais recente para o mais antigo. */
  chatRemotes = async (lineId: string): Promise<string[]> =>
    (await this.db.$queryRaw<{ remote: string }[]>`
      SELECT "remote" FROM "Message" WHERE "lineId" = ${lineId}
      GROUP BY "remote" ORDER BY max("timestamp") DESC`).map((r) => r.remote);

  /** Ligações com um contato (mais recentes primeiro). */
  callsWith = async (lineId: string, remote: string, limit = 50): Promise<CallView[]> =>
    (await this.db.call.findMany({ where: { lineId, remote }, orderBy: { startedAt: "desc" }, take: limit })).map(toView);

  getCall = (lineId: string, callId: string): Promise<Call | null> =>
    this.db.call.findFirst({ where: { lineId, callId } });

  /** Retorna quantas linhas mudaram (0 = a ligação ainda não está no histórico). */
  updateCall = async (lineId: string, callId: string, data: Prisma.CallUpdateManyMutationInput): Promise<number> =>
    (await this.db.call.updateMany({ where: { lineId, callId }, data })).count;

  // ─── respostas rápidas ──────────────────────────────────────────────────

  /** Respostas da linha + as globais (lineId vazio). */
  quickReplies = (lineId?: string): Promise<QuickReply[]> =>
    this.db.quickReply.findMany({
      where: lineId ? { OR: [{ lineId }, { lineId: null }] } : {},
      orderBy: { shortcut: "asc" },
    });

  /** Conversas: última mensagem, nome do contato e não lidas. Mais recentes primeiro. */
  /** Conversas da linha; `exclude` = contatos ocultos (todas as formas gravadas do número). */
  listChats = async (lineId: string, exclude: string[] = []): Promise<ChatView[]> => {
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
        where: { lineId, direction: "incoming", status: "delivered", type: { not: "reaction" }, deletedAt: null },
        _count: { _all: true },
      }),
    ]);
    const nameOf = new Map(names.map((n) => [n.remote, n.pushName]));
    const unreadOf = new Map(unread.map((u) => [u.remote, u._count._all]));
    const contacts = new Map((await this.db.contact.findMany({ where: { lineId } })).map((c) => [c.remote, c]));
    const hidden = new Set(exclude);
    return last
      .filter((m) => !hidden.has(m.remote))
      .map((m) => {
        const c = contacts.get(m.remote) ?? null;
        const profile = nameOf.get(m.remote) ?? c?.pushName ?? undefined;
        return {
          ...toContactView(c, m.remote),
          remoteJid: m.remoteJid,
          name: c?.name ?? c?.phoneName ?? profile,
          profileName: profile,
          phoneName: c?.phoneName ?? undefined,
          teamName: c?.name ?? undefined,
          isGroup: m.remoteJid.endsWith("@g.us"),
          unread: unreadOf.get(m.remote) ?? 0,
          last: toMessageView(m),
        };
      })
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

  /** Mensagens enviadas pelo gateway (API/painel) desde `since` — base do limite diário. */
  countSentSince = async (lineId: string, since: Date): Promise<number> =>
    this.db.message.count({ where: { lineId, direction: "outgoing", agent: { not: null }, type: { not: "reaction" }, createdAt: { gte: since } } });

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
