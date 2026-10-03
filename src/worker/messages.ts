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

/**
 * Mensagens da linha pelo MESMO socket do Baileys usado nas chamadas
 * (o WhatsApp só aceita uma conexão por aparelho vinculado).
 *
 * Emite `message` (MessageRecord, raw) e `status` ({ id, remoteJid, status }).
 * Só conversas individuais: grupos, status e canais são ignorados.
 */
export class MessageService extends EventEmitter {
  #sock: any = null;
  readonly #jidCache = new Map<string, string>();
  /** Processa em fila para manter a ordem de chegada (achar o telefone de um LID é assíncrono). */
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly client: VoipClient) {
    super();
  }

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
        this.#queue = this.#queue
          .then(() => this.#toRecord(m))
          .then((rec) => { if (rec) this.emit("message", rec, this.#serialize(m)); })
          .catch((err) => log.warn(`mensagem ignorada: ${err?.message ?? err}`));
      }
    });

    sock.ev.on("messages.update", (updates: any[]) => {
      for (const { key, update } of updates) {
        if (!key?.fromMe || update?.status == null || !isUserJid(key.remoteJid ?? "")) continue;
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

  /** Número -> JID do WhatsApp (testa com e sem o 9º dígito no Brasil). */
  #resolveJid = async (to: string): Promise<string> => {
    if (to.includes("@")) {
      if (!isUserJid(to)) throw new Error("Só é possível enviar para contatos (não para grupos ou listas)");
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
    if (!key?.id || !isUserJid(remoteJid)) return null;

    const content = this.#b.normalizeMessageContent(m.message);
    const kind: string | undefined = content ? this.#b.getContentType(content) : undefined;
    if (!kind || IGNORED.has(kind)) return null;
    const body = typeof content[kind] === "object" && content[kind] ? content[kind] : {};

    const rec: MessageRecord = {
      id: key.id,
      direction: key.fromMe ? "outgoing" : "incoming",
      remote: await this.#phoneOf(remoteJid, key.remoteJidAlt),
      remoteJid,
      pushName: key.fromMe ? undefined : m.pushName || undefined,
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
