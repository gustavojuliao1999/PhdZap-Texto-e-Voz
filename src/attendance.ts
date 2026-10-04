import type { PrismaClient } from "@prisma/client";
import { isPermission } from "./auth/permissions.js";
import { HttpError, type LineEvent, type LineManager, type MessageView } from "./line-manager.js";
import { log } from "./log.js";
import { toContactView, type ContactView, type Store } from "./store.js";
import type { BusinessHours } from "./worker/protocol.js";

/** Não repete a resposta automática para o mesmo contato antes disso. */
const AUTO_REPLY_EVERY_MS = 12 * 3_600_000;
const STATUSES = ["open", "pending", "resolved"] as const;

const pad = (n: number): string => String(n).padStart(2, "0");

/** Está dentro do horário de atendimento? (fuso do servidor: variável TZ) */
export const isWithinHours = (hours: BusinessHours, at = new Date()): boolean => {
  const ranges = hours[String(at.getDay()) as keyof BusinessHours] ?? [];
  const now = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return ranges.some(([from, to]) => now >= from && now < to);
};

export type Agent = { id: string; name: string };

export type ContactPatch = {
  name?: string | null;
  notes?: string;
  status?: string;
  /** id do usuário, "me" (quem pede) ou null (ninguém). */
  assignedUserId?: string | null;
};

/**
 * Atendimento das conversas: responsável, status (aberta/pendente/resolvida), nome e
 * notas do contato; reabre a conversa quando o cliente escreve; responde fora do horário.
 */
export class Attendance {
  constructor(private readonly lines: LineManager, private readonly store: Store, private readonly db: PrismaClient) {
    lines.on("event", (e: LineEvent) => {
      if (e.type === "message") void this.#onMessage(e.lineId, e.message).catch((err) => log.warn(`atendimento: ${err.message}`));
    });
  }

  get = async (lineId: string, remote: string): Promise<ContactView> => toContactView(await this.store.getContact(lineId, remote), remote);

  /** Quem pode atender as mensagens desta linha (administradores e grupos com "messages"). */
  agents = async (lineId: string): Promise<Agent[]> => {
    const users = await this.db.user.findMany({
      where: { active: true },
      include: { groups: { include: { group: { include: { lines: true } } } } },
      orderBy: { name: "asc" },
    });
    return users
      .filter((u) => u.isAdmin || u.groups.some((g) => g.group.lines.some((l) => l.lineId === lineId && l.permissions.filter(isPermission).includes("messages"))))
      .map((u) => ({ id: u.id, name: u.name }));
  };

  update = async (lineId: string, remote: string, patch: ContactPatch, me?: { id: string; name: string }): Promise<ContactView> => {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      const name = patch.name === null ? null : String(patch.name).trim().slice(0, 80) || null;
      data.name = name;
    }
    if (patch.notes !== undefined) {
      if (String(patch.notes).length > 10_000) throw new HttpError(400, "Notas muito longas (máx. 10.000)");
      data.notes = String(patch.notes);
    }
    if (patch.status !== undefined) {
      if (!STATUSES.includes(patch.status as any)) throw new HttpError(400, `status: use ${STATUSES.join(", ")}`);
      data.status = patch.status;
    }
    if (patch.assignedUserId !== undefined) {
      if (patch.assignedUserId === null || patch.assignedUserId === "") {
        data.assignedUserId = null;
        data.assignedName = null;
      } else {
        const id = patch.assignedUserId === "me" ? me?.id : patch.assignedUserId;
        if (!id) throw new HttpError(400, "'me' só vale para usuários do painel");
        const agent = (await this.agents(lineId)).find((a) => a.id === id);
        if (!agent) throw new HttpError(400, "Usuário não encontrado ou sem permissão de mensagens neste telefone");
        data.assignedUserId = agent.id;
        data.assignedName = agent.name;
      }
    }
    const view = toContactView(await this.store.upsertContact(lineId, remote, data), remote);
    this.lines.emit("event", { type: "contact", lineId, contact: view } satisfies LineEvent);
    return view;
  };

  #onMessage = async (lineId: string, m: MessageView): Promise<void> => {
    if (m.direction !== "incoming" || m.type === "reaction") return;
    const contact = await this.store.getContact(lineId, m.remote);
    // O cliente escreveu: conversa resolvida ou aguardando cliente volta a ficar aberta.
    if (contact && contact.status !== "open") await this.update(lineId, m.remote, { status: "open" });
    await this.#autoReply(lineId, m, contact?.lastAutoReplyAt ?? null);
  };

  #autoReply = async (lineId: string, m: MessageView, last: Date | null): Promise<void> => {
    const cfg = this.lines.get(lineId)?.config;
    if (!cfg?.businessHoursEnabled || !cfg.offHoursMessage.trim() || m.remoteJid.endsWith("@g.us")) return;
    if (isWithinHours(cfg.businessHours)) return;
    if (last && Date.now() - last.getTime() < AUTO_REPLY_EVERY_MS) return;
    await this.store.upsertContact(lineId, m.remote, { lastAutoReplyAt: new Date() });
    const name = m.pushName?.split(" ")[0] ?? "";
    const text = cfg.offHoursMessage.replaceAll("{nome}", name).replace(/\s+([,!.?])/g, "$1");
    await this.lines.sendMessage(lineId, m.remote, { type: "text", text }, { agent: "Resposta automática" })
      .catch((err) => log.warn(`resposta fora do horário não enviada: ${err.message}`));
  };
}
