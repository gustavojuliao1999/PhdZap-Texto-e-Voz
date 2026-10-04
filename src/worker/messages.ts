import { EventEmitter } from "node:events";
import { phoneNumberCandidates, type VoipClient } from "baileys-caller";
import { log } from "../log.js";
import type { MessageRecord, MessageStatus, MessageType, OutgoingContent } from "./protocol.js";

/** Status do proto do WhatsApp (WebMessageInfo.Status) -> nosso. */
const STATUS: MessageStatus[] = ["error", "pending", "sent", "delivered", "read", "played"];

/** Conteúdos que não são mensagens para o usuário (chaves, apagar, editar, sincronização…). */
const IGNORED = new Set([
  "protocolMessage", "senderKeyDistributionMessage", "messageContextInfo", "pollUpdateMessage",
  "keepInChatMessage", "encReactionMessage", "callLogMesssage", "pinInChatMessage",
]);

const silentLogger: any = {
  level: "silent", child: () => silentLogger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

const num = (v: unknown): number | undefined => (v == null ? undefined : Number(v));
const isUserJid = (jid: string): boolean => /@(s\.whatsapp\.net|lid)$/.test(jid);
const isGroupJid = (jid: string): boolean => jid.endsWith("@g.us");

/** Tipos do protocolMessage (proto ProtocolMessage.Type). */
const REVOKE = 0;
const MESSAGE_EDIT = 14;

/** Texto de um conteúdo (para mensagens editadas). */
const textOf = (c: any): string | undefined =>
  c?.conversation ?? c?.extendedTextMessage?.text ?? c?.imageMessage?.caption ?? c?.videoMessage?.caption ?? c?.documentMessage?.caption;

/**
 * Mensagens da linha pelo MESMO socket do Baileys usado nas chamadas
 * (o WhatsApp só aceita uma conexão por aparelho vinculado).
 *
 * Emite `message` (MessageRecord, raw), `status` ({ id, remoteJid, status }) e
 * `update` ({ id, remoteJid, text?, deleted? }) para mensagens editadas/apagadas.
 * Conversas individuais sempre; grupos só se `groups()` for verdadeiro; status e canais nunca.
 */
export class MessageService extends EventEmitter {
  #sock: any = null;
  readonly #jidCache = new Map<string, string>();
  readonly #groupNames = new Map<string, { name: string; at: number }>();
  /** Processa em fila para manter a ordem de chegada (achar o telefone de um LID é assíncrono). */
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly client: VoipClient, private readonly groups: () => boolean = () => false) {
    super();
  }

  #allowed = (jid: string): boolean => isUserJid(jid) || (isGroupJid(jid) && this.groups());

  get #b(): any { return this.client.baileys; }

  /** Liga os listeners no socket atual. Chamar depois de cada conexão. */
  attach = (): void => {
    const sock = this.client.socket;
    if (!sock || sock === this.#sock) return;
    this.#sock = sock;

    sock.ev.on("messages.upsert", ({ messages, type }: { messages: any[]; type: string }) => {
      // "append" = histórico/sincronização e as próprias mensagens enviadas pela API
      // (essas já são registradas pelo send). "notify" = mensagens novas.
      if (type !== "notify") return;
      for (const m of messages) {
        if (this.#handleProtocol(m)) continue;
        this.#queue = this.#queue
          .then(() => this.#toRecord(m))
          .then((rec) => { if (rec) this.emit("message", rec, this.#serialize(m)); })
          .catch((err) => log.warn(`mensagem ignorada: ${err?.message ?? err}`));
      }
    });

    sock.ev.on("messages.update", (updates: any[]) => {
      for (const { key, update } of updates) {
        if (!key?.id || !this.#allowed(key.remoteJid ?? "")) continue;
        // Apagada para todos (o Baileys troca a mensagem por um "stub" de revogação).
        if (update?.message === null && Number(update.messageStubType) === 1) {
          this.emit("update", { id: key.id, remoteJid: key.remoteJid, deleted: true });
          continue;
        }
        const edited = textOf(this.#b.normalizeMessageContent(update?.message?.editedMessage?.message ?? update?.message?.editedMessage));
        if (edited !== undefined) {
          this.emit("update", { id: key.id, remoteJid: key.remoteJid, text: edited });
          continue;
        }
        if (!key.fromMe || update?.status == null) continue;
        const status = STATUS[Number(update.status)];
        if (status) this.emit("status", { id: key.id, remoteJid: key.remoteJid, status });
      }
    });
  };

  send = async (to: string, content: OutgoingContent, quotedRaw?: string): Promise<{ message: MessageRecord; raw: string }> => {
    const sock = this.#requireSock();
    const jid = await this.#resolveJid(to);
    const quoted = quotedRaw ? this.#parse(quotedRaw) : undefined;
    let sent: any;
    if (content.type === "reaction") {
      if (!quoted?.key) throw new Error("Reação precisa da mensagem reagida");
      sent = await sock.sendMessage(jid, { react: { text: content.text, key: quoted.key } });
    } else {
      sent = await sock.sendMessage(jid, this.#build(content), quoted ? { quoted } : undefined);
    }
    const rec = await this.#toRecord(sent);
    if (!rec) throw new Error("Falha ao montar a mensagem enviada");
    // O retorno do sendMessage vem como PENDING; o servidor já aceitou.
    if (rec.status === "pending") rec.status = "sent";
    // Áudio de voz: o tempo que mandamos é o que o WhatsApp mostra.
    if (content.type === "audio" && rec.media) rec.media.seconds ??= content.seconds;
    return { message: rec, raw: this.#serialize(sent) };
  };

  download = async (raw: string): Promise<Uint8Array> => {
    const sock = this.#requireSock();
    const buf: Buffer = await this.#b.downloadMediaMessage(this.#parse(raw), "buffer", {}, {
      reuploadRequest: sock.updateMediaMessage,
      logger: silentLogger,
    });
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  };

  markRead = async (raws: string[]): Promise<void> => {
    if (raws.length) await this.#requireSock().readMessages(raws.map((r) => this.#parse(r).key));
  };

  /** URL (temporária) da foto de perfil, ou null se não houver / for privada. */
  profilePicture = async (jid: string): Promise<string | null> => {
    try {
      return (await this.#requireSock().profilePictureUrl(jid, "preview")) ?? null;
    } catch {
      return null;
    }
  };

  // ─── interno ────────────────────────────────────────────────────────────

  #requireSock = (): any => {
    const sock = this.client.socket;
    if (!sock) throw new Error("WhatsApp desta linha não está conectado");
    return sock;
  };

  #serialize = (m: any): string => JSON.stringify(m, this.#b.BufferJSON.replacer);
  #parse = (raw: string): any => JSON.parse(raw, this.#b.BufferJSON.reviver);

  /** Apagar/editar chegam como protocolMessage: vira evento `update`. Retorna true se tratou. */
  #handleProtocol = (m: any): boolean => {
    const pm = this.#b.normalizeMessageContent(m?.message)?.protocolMessage;
    if (!pm) return false;
    const remoteJid = pm.key?.remoteJid || m.key?.remoteJid;
    const id = pm.key?.id;
    if (!id || !this.#allowed(remoteJid ?? "")) return true;
    if (Number(pm.type) === REVOKE) this.emit("update", { id, remoteJid, deleted: true });
    else if (Number(pm.type) === MESSAGE_EDIT) {
      const text = textOf(this.#b.normalizeMessageContent(pm.editedMessage));
      if (text !== undefined) this.emit("update", { id, remoteJid, text });
    }
    return true;
  };

  /** Nome (assunto) do grupo, guardado por 1 hora. */
  #groupName = async (jid: string): Promise<string | undefined> => {
    const hit = this.#groupNames.get(jid);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.name;
    try {
      const meta = await this.#requireSock().groupMetadata(jid);
      if (meta?.subject) this.#groupNames.set(jid, { name: meta.subject, at: Date.now() });
      return meta?.subject;
    } catch {
      return hit?.name;
    }
  };

  /** Número -> JID do WhatsApp (testa com e sem o 9º dígito no Brasil). */
  #resolveJid = async (to: string): Promise<string> => {
    if (to.includes("@")) {
      if (!this.#allowed(to)) {
        throw new Error(isGroupJid(to) ? "Grupos estão desativados nesta linha (Configurações)" : "Destino inválido (use um número ou um JID de contato/grupo)");
      }
      return to;
    }
    const digits = to.replace(/\D/g, "");
    if (digits.length < 8) throw new Error("Número inválido (use DDI+DDD+número, só dígitos)");
    const cached = this.#jidCache.get(digits);
    if (cached) return cached;
    for (const candidate of phoneNumberCandidates(digits)) {
      const [result] = (await this.#requireSock().onWhatsApp(`${candidate}@s.whatsapp.net`)) ?? [];
      if (result?.exists) {
        const jid = this.#b.jidNormalizedUser(String(result.jid));
        this.#jidCache.set(digits, jid);
        return jid;
      }
    }
    throw new Error(`O número ${digits} não foi encontrado no WhatsApp`);
  };

  #build = (c: OutgoingContent): Record<string, unknown> => {
    switch (c.type) {
      case "text": return { text: c.text };
      case "location":
        return { location: { degreesLatitude: c.latitude, degreesLongitude: c.longitude, name: c.name, address: c.address } };
      case "audio":
        return { audio: Buffer.from(c.data), mimetype: c.mimetype, ptt: !!c.ptt, ...(c.seconds ? { seconds: c.seconds } : {}) };
      case "sticker": return { sticker: Buffer.from(c.data) };
      case "reaction": throw new Error("reação é enviada à parte");
      case "document":
        return { document: Buffer.from(c.data), mimetype: c.mimetype, fileName: c.fileName ?? "arquivo", caption: c.caption };
      default:
        return { [c.type]: Buffer.from(c.data), mimetype: c.mimetype, caption: c.caption };
    }
  };

  /** Número do contato: o JID pode ser um LID (sem telefone); tenta achar o telefone. */
  #phoneOf = async (jid: string, alt?: string): Promise<string> => {
    const pn = [jid, alt].find((j) => j?.endsWith("@s.whatsapp.net"));
    if (pn) return this.#b.jidNormalizedUser(pn).split("@")[0];
    try {
      const mapped = await this.#sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
      if (mapped) return this.#b.jidNormalizedUser(mapped).split("@")[0];
    } catch {}
    return jid;
  };

  #toRecord = async (m: any): Promise<MessageRecord | null> => {
    const key = m?.key;
    const remoteJid: string = key?.remoteJid ?? "";
    if (!key?.id || !this.#allowed(remoteJid)) return null;
    const group = isGroupJid(remoteJid);

    const content = this.#b.normalizeMessageContent(m.message);
    const kind: string | undefined = content ? this.#b.getContentType(content) : undefined;
    if (!kind || IGNORED.has(kind)) return null;
    const body = typeof content[kind] === "object" && content[kind] ? content[kind] : {};

    const rec: MessageRecord = {
      id: key.id,
      direction: key.fromMe ? "outgoing" : "incoming",
      remote: group ? remoteJid : await this.#phoneOf(remoteJid, key.remoteJidAlt),
      remoteJid,
      pushName: key.fromMe || group ? undefined : m.pushName || undefined,
      ...(group ? {
        participant: key.fromMe ? undefined : await this.#phoneOf(key.participant ?? "", key.participantAlt),
        participantName: key.fromMe ? undefined : m.pushName || undefined,
        chatName: await this.#groupName(remoteJid),
      } : {}),
      type: "other",
      status: key.fromMe ? STATUS[Number(m.status ?? 2)] ?? "sent" : "delivered",
      timestamp: new Date((num(m.messageTimestamp) ?? Date.now() / 1000) * 1000).toISOString(),
      replyTo: body?.contextInfo?.stanzaId || undefined,
    };
    const media = (extra: MessageRecord["media"] = {}): MessageRecord["media"] => ({
      mimetype: body.mimetype || undefined,
      size: num(body.fileLength),
      ...extra,
    });
    const type = (t: MessageType): void => { rec.type = t; };

    switch (kind) {
      case "conversation": type("text"); rec.text = content.conversation; break;
      case "extendedTextMessage": type("text"); rec.text = body.text; break;
      case "imageMessage": type("image"); rec.text = body.caption || undefined; rec.media = media(); break;
      case "videoMessage": type("video"); rec.text = body.caption || undefined; rec.media = media({ seconds: num(body.seconds) }); break;
      case "audioMessage": type("audio"); rec.media = media({ seconds: num(body.seconds), ptt: !!body.ptt }); break;
      case "documentMessage":
        type("document"); rec.text = body.caption || undefined; rec.media = media({ fileName: body.fileName || undefined });
        break;
      case "stickerMessage": type("sticker"); rec.media = media(); break;
      case "locationMessage":
      case "liveLocationMessage":
        type("location");
        rec.location = {
          latitude: Number(body.degreesLatitude), longitude: Number(body.degreesLongitude),
          name: body.name || undefined, address: body.address || undefined,
        };
        break;
      case "contactMessage": type("contact"); rec.contact = { name: body.displayName, vcard: body.vcard }; break;
      case "reactionMessage": type("reaction"); rec.text = body.text || undefined; rec.replyTo = body.key?.id; break;
      default: rec.text = kind; // tipo não tratado (enquete, botão…): o nome do tipo ajuda a depurar
    }
    return rec;
  };
}
