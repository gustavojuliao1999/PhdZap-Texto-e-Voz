import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";
import type { CallRecord } from "./session.js";
import type { Store } from "./store.js";
import { SendLimiter } from "./rate-limit.js";
import { WEBHOOK_EVENTS } from "./webhooks.js";
import type { WhatsAppState } from "./whatsapp.js";
import {
  RESTART_EXIT_CODE, type GatewayEvent, type LineConfig, type MessageRecord, type MessageStatus,
  type OutgoingContent, type WorkerCommand, type WorkerMessage,
} from "./worker/protocol.js";

// LINE_WORKER_ENTRY permite trocar o worker (testes).
const WORKER_ENTRY = process.env.LINE_WORKER_ENTRY || fileURLToPath(new URL("./worker/line-worker.ts", import.meta.url));
const REQUEST_TIMEOUT_MS = 45_000;

/** Chamada como vista pelos clientes: registro do worker + linha + quem atendeu. */
export type CallView = CallRecord & {
  lineId: string;
  lineName: string;
  /** Cliente (iframe/navegador) que ficou com a chamada. */
  ownerClientId?: string;
  ownerAgent?: string;
  /** Usuário do painel que ficou com a chamada (quando não foi pelo token). */
  ownerUserId?: string;
};

/** Mensagem como vista pelos clientes. */
export type MessageView = MessageRecord & {
  lineId: string;
  /** Quem enviou pelo gateway (usuário do painel ou "API"). */
  agent?: string;
};

/** Evento publicado para os WebSockets (de uma linha e do admin) e para o webhook. */
export type LineEvent =
  | { type: "dialing" | "incoming" | "connected" | "ended" | "answered"; lineId: string; call: CallView }
  | { type: "busy"; lineId: string; from: string }
  | { type: "message"; lineId: string; message: MessageView }
  | { type: "message-status"; lineId: string; message: MessageView }
  /** Conversa marcada como lida (zera o contador nos outros painéis). */
  | { type: "chat-read"; lineId: string; remote: string }
  | { type: "line"; lineId: string; line: LinePublic };

/** Visão da linha para quem tem só o token da linha (sem QR, sem segredos). */
export type LinePublic = {
  id: string;
  name: string;
  status: WhatsAppState["status"] | "stopped";
  phone?: string;
  current: CallView | null;
};

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Um telefone: processo worker + estado espelhado no principal. */
export class LineRuntime extends EventEmitter {
  wa: WhatsAppState = { status: "connecting" };
  current: CallView | null = null;
  #child: ChildProcess | null = null;
  #reqSeq = 0;
  readonly #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  #stopping = false;
  #crashDelay = 1000;
  /** Ids encerrados recentemente (o "ended" pode chegar antes da resposta do dial). */
  readonly #recentlyEnded: string[] = [];

  constructor(public config: LineConfig, private readonly authDir: string) {
    super();
  }

  get running(): boolean { return !!this.#child; }

  get publicInfo(): LinePublic {
    return {
      id: this.config.id,
      name: this.config.name,
      status: this.#child ? this.wa.status : "stopped",
      phone: this.wa.me,
      current: this.current,
    };
  }

  start = (): void => {
    if (this.#child) return;
    this.#stopping = false;
    const startedAt = Date.now();
    const child = fork(WORKER_ENTRY, [], {
      execArgv: process.execArgv, // loader do tsx
      serialization: "advanced",
      env: {
        ...process.env,
        LINE_CONFIG: JSON.stringify(this.config),
        LINE_AUTH_DIR: this.authDir,
        LOG_PREFIX: `[${this.config.name}]`,
      },
    });
    this.#child = child;
    this.#setWa({ status: "connecting" });

    child.on("message", (msg: WorkerMessage) => this.#onMessage(msg));
    child.on("exit", (code, signal) => {
      this.#child = null;
      for (const [, p] of this.#pending) { clearTimeout(p.timer); p.reject(new Error("linha reiniciou")); }
      this.#pending.clear();
      if (this.current) this.#finishCall({ ...this.current, status: "ended", endReason: "line_restart", endedAt: new Date().toISOString() });

      if (this.#stopping) { this.#emitLine(); return; }
      if (code === RESTART_EXIT_CODE) {
        // Reinício pedido (logout ou conexão caiu). Se repetir muito rápido, espera mais.
        const quick = Date.now() - startedAt < 30_000;
        const delay = quick ? this.#crashDelay : 1000;
        this.#crashDelay = quick ? Math.min(this.#crashDelay * 2, 30_000) : 1000;
        log.info(`[${this.config.name}] reiniciando linha${delay > 1000 ? ` em ${delay / 1000}s` : ""}`);
        setTimeout(() => { if (!this.#stopping) this.start(); }, delay);
        return;
      }
      if (Date.now() - startedAt > 60_000) this.#crashDelay = 1000;
      log.error(`[${this.config.name}] processo da linha caiu (code=${code} signal=${signal}); reiniciando em ${this.#crashDelay / 1000}s`);
      this.emit("crashed", signal ? `sinal ${signal}` : `código ${code}`);
      this.#setWa({ status: "error", error: "Processo da linha caiu; reiniciando…" });
      setTimeout(() => { if (!this.#stopping) this.start(); }, this.#crashDelay);
      this.#crashDelay = Math.min(this.#crashDelay * 2, 30_000);
    });
  };

  stop = async (): Promise<void> => {
    this.#stopping = true;
    const child = this.#child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    });
  };

  restart = async (): Promise<void> => {
    await this.stop();
    this.start();
  };

  request = <T = unknown>(command: WorkerCommand): Promise<T> => {
    const child = this.#child;
    if (!child) return Promise.reject(new HttpError(503, "Linha parada"));
    const reqId = ++this.#reqSeq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(reqId);
        reject(new HttpError(504, "A linha não respondeu a tempo"));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(reqId, { resolve, reject, timer });
      child.send({ t: "req", reqId, ...command });
    });
  };

  /** Liga; se `clientId` vier, a chamada já nasce pertencendo a esse cliente (discador). */
  dial = async (
    to: string,
    opts: { handler?: string; clientId?: string; agent?: string; userId?: string } = {},
  ): Promise<CallView> => {
    if (this.current) throw new HttpError(409, "Linha ocupada: já existe uma chamada");
    if (this.wa.status !== "open") throw new HttpError(503, "WhatsApp desta linha não está conectado");
    const record = await this.request<CallRecord>({ cmd: "dial", to, handler: opts.handler });
    // Durante o await o worker pode já ter mandado eventos desta chamada.
    const latest = this.current as CallView | null;
    const view: CallView = {
      ...record,
      ...(latest?.id === record.id ? latest : {}),
      lineId: this.config.id,
      lineName: this.config.name,
      ownerClientId: opts.clientId,
      ownerAgent: opts.agent,
      ownerUserId: opts.userId,
    };
    if (view.status !== "ended" && !this.#recentlyEnded.includes(view.id)) {
      this.current = view;
      this.emit("event", { type: "dialing", lineId: this.config.id, call: view } satisfies LineEvent);
    }
    return view;
  };

  sendAudio = (callId: string, pcm: Buffer): void => {
    this.#child?.send({ t: "audio", callId, pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) });
  };

  /**
   * Reserva a chamada para um cliente (o primeiro a atender leva).
   * Lança 409 se outro cliente já pegou.
   */
  claim = (callId: string, clientId: string, agent?: string, userId?: string): CallView => {
    const call = this.current;
    if (!call || call.id !== callId) throw new HttpError(404, "Chamada não encontrada ou já encerrada");
    if (call.ownerClientId && call.ownerClientId !== clientId) {
      throw new HttpError(409, `Chamada já atendida${call.ownerAgent ? ` por ${call.ownerAgent}` : ""}`);
    }
    if (!call.ownerClientId) {
      call.ownerClientId = clientId;
      call.ownerAgent = agent;
      call.ownerUserId = userId;
      this.emit("event", { type: "answered", lineId: this.config.id, call } satisfies LineEvent);
    }
    return call;
  };

  releaseClaim = (callId: string, clientId: string): void => {
    const call = this.current;
    if (call?.id === callId && call.ownerClientId === clientId && call.status === "ringing") {
      call.ownerClientId = undefined;
      call.ownerAgent = undefined;
      call.ownerUserId = undefined;
    }
  };

  #onMessage = (msg: WorkerMessage): void => {
    switch (msg.t) {
      case "res": {
        const p = this.#pending.get(msg.reqId);
        if (!p) return;
        this.#pending.delete(msg.reqId);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new HttpError(409, msg.error));
        return;
      }
      case "wa":
        this.#setWa(msg.state);
        return;
      case "audio":
        this.emit("audio", msg.callId, Buffer.from(msg.pcm.buffer, msg.pcm.byteOffset, msg.pcm.byteLength));
        return;
      case "event":
        this.#onCallEvent(msg.event);
        return;
    }
  };

  #onCallEvent = (e: GatewayEvent): void => {
    const lineId = this.config.id;
    if (e.type === "busy") {
      this.emit("event", { type: "busy", lineId, from: e.from } satisfies LineEvent);
      return;
    }
    // Mensagens: o LineManager grava no banco antes de publicar.
    if (e.type === "message") { this.emit("wa-message", e.message, e.raw); return; }
    if (e.type === "message-status") { this.emit("wa-message-status", e.id, e.status); return; }
    // Preserva quem atendeu entre atualizações do worker.
    const prev = this.current?.id === e.call.id ? this.current : null;
    const view: CallView = {
      ...e.call,
      lineId,
      lineName: this.config.name,
      ownerClientId: prev?.ownerClientId,
      ownerAgent: prev?.ownerAgent,
      ownerUserId: prev?.ownerUserId,
    };
    if (e.type === "ended") { this.#finishCall(view); return; }
    this.current = view;
    this.emit("event", { type: e.type, lineId, call: view } satisfies LineEvent);
  };

  #finishCall = (view: CallView): void => {
    this.current = null;
    this.#recentlyEnded.push(view.id);
    if (this.#recentlyEnded.length > 20) this.#recentlyEnded.shift();
    this.emit("ended-call", view);
    this.emit("event", { type: "ended", lineId: this.config.id, call: view } satisfies LineEvent);
  };

  #setWa = (state: WhatsAppState): void => {
    this.wa = state;
    this.emit("wa", state);
    this.#emitLine();
  };

  #emitLine = (): void => {
    this.emit("event", { type: "line", lineId: this.config.id, line: this.publicInfo } satisfies LineEvent);
  };
}

/**
 * Conjunto de linhas: CRUD, persistência e histórico.
 * Emite `event` (LineEvent), `wa` (lineId), `audio` (lineId, callId, pcm16), `removed`, `token-rotated`.
 */
export class LineManager extends EventEmitter {
  readonly #lines = new Map<string, LineRuntime>();
  /** Fotos de perfil: lineId:remote -> URL (as URLs do WhatsApp expiram). */
  readonly #photos = new Map<string, { url: string | null; at: number }>();

  readonly #limiter: SendLimiter;

  constructor(private readonly store: Store) {
    super();
    this.#limiter = new SendLimiter((lineId) => {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      return store.countSentSince(lineId, midnight);
    });
  }

  get lines(): LineRuntime[] { return [...this.#lines.values()]; }

  get = (id: string): LineRuntime | undefined => this.#lines.get(id);
  byToken = (token: string): LineRuntime | undefined =>
    token ? this.lines.find((l) => l.config.token === token) : undefined;

  startAll = async (): Promise<void> => {
    for (const config of await this.store.listLines()) this.#add(config).start();
  };

  create = async (name: string, patch: Partial<LineConfig> = {}): Promise<LineRuntime> => {
    const config = { ...this.store.newLine(name), ...sanitizePatch(patch) };
    await this.store.insertLine(config);
    const line = this.#add(config);
    line.start();
    this.emit("event", { type: "line", lineId: config.id, line: line.publicInfo } satisfies LineEvent);
    return line;
  };

  update = async (id: string, patch: Partial<LineConfig>): Promise<LineRuntime> => {
    const line = this.#require(id);
    const config = { ...line.config, ...sanitizePatch(patch) };
    await this.store.updateLine(config);
    line.config = config;
    if (line.running) await line.request({ cmd: "configure", config: line.config }).catch(() => {});
    this.emit("event", { type: "line", lineId: id, line: line.publicInfo } satisfies LineEvent);
    return line;
  };

  rotateToken = async (id: string, token: string): Promise<LineRuntime> => {
    const line = this.#require(id);
    const config = { ...line.config, token };
    await this.store.updateLine(config);
    line.config = config;
    this.emit("token-rotated", id);
    return line;
  };

  /** Desvincula o telefone (logout) e apaga a sessão; a linha reinicia com QR novo. */
  logout = async (id: string): Promise<void> => {
    const line = this.#require(id);
    if (line.running) {
      await line.request({ cmd: "logout" });
    } else {
      rmSync(this.store.authDirFor(id), { recursive: true, force: true });
      line.start();
    }
  };

  remove = async (id: string): Promise<void> => {
    const line = this.#require(id);
    if (line.running && line.wa.status === "open") {
      await line.request({ cmd: "logout" }).catch((err) => log.warn(`logout ao remover linha falhou: ${err.message}`));
    }
    await line.stop();
    line.removeAllListeners();
    this.#lines.delete(id);
    await this.store.deleteLine(id);
    rmSync(path.dirname(this.store.authDirFor(id)), { recursive: true, force: true });
    this.emit("removed", id);
  };

  stopAll = async (): Promise<void> => { await Promise.all(this.lines.map((l) => l.stop())); };

  // ─── mensagens ──────────────────────────────────────────────────────────

  /** Envia uma mensagem; `replyTo` = id de uma mensagem desta linha para citar. */
  sendMessage = async (
    id: string, to: string, content: OutgoingContent, opts: { agent?: string; replyTo?: string } = {},
  ): Promise<MessageView> => {
    const line = this.#require(id);
    if (line.wa.status !== "open") throw new HttpError(503, "WhatsApp desta linha não está conectado");
    let quotedRaw: string | undefined;
    if (content.type === "reaction" && !opts.replyTo) throw new HttpError(400, "Reação precisa de 'replyTo' (a mensagem reagida)");
    if (content.type !== "reaction") await this.#limiter.take(id, line.config.rateLimitPerMinute, line.config.rateLimitPerDay);
    if (opts.replyTo) {
      const quoted = await this.store.getMessage(id, opts.replyTo);
      if (!quoted?.raw) throw new HttpError(404, "Mensagem citada (replyTo) não encontrada");
      quotedRaw = quoted.raw;
    }
    const { message, raw } = await line.request<{ message: MessageRecord; raw: string }>(
      { cmd: "send-message", to, content, quotedRaw },
    );
    if ("data" in content) await this.#cacheMedia(id, message.id, content.data);
    const view = await this.store.insertMessage(id, message, raw, opts.agent);
    if (!view) return { ...message, lineId: id, agent: opts.agent }; // o evento do WhatsApp chegou antes
    this.emit("event", { type: "message", lineId: id, message: view } satisfies LineEvent);
    return view;
  };

  /** Baixa a mídia de uma mensagem (do WhatsApp, pela linha). */
  downloadMedia = async (id: string, waId: string): Promise<{ view: MessageView; data: Buffer }> => {
    const line = this.#require(id);
    const found = await this.store.getMessage(id, waId);
    if (!found) throw new HttpError(404, "Mensagem não encontrada");
    if (!found.view.media || !found.raw) throw new HttpError(404, "Esta mensagem não tem mídia");
    const file = this.store.mediaFileFor(id, waId);
    const cached = await readFile(file).catch(() => null);
    if (cached) return { view: found.view, data: cached };
    const data = await line.request<Uint8Array>({ cmd: "download-media", raw: found.raw });
    await this.#cacheMedia(id, waId, data);
    return { view: found.view, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength) };
  };

  /** Marca como lida a mensagem recebida e as anteriores da mesma conversa. */
  markRead = async (id: string, waId: string): Promise<void> => {
    const found = await this.store.getMessage(id, waId);
    if (!found) throw new HttpError(404, "Mensagem não encontrada");
    if (found.view.direction !== "incoming") throw new HttpError(400, "Só mensagens recebidas podem ser marcadas como lidas");
    await this.markChatRead(id, found.view.remote, new Date(found.view.timestamp));
  };

  /** Marca a conversa como lida (no banco e no WhatsApp: o contato vê os ✓✓ azuis). */
  markChatRead = async (id: string, remote: string, upTo?: Date): Promise<void> => {
    const line = this.#require(id);
    const raws = await this.store.markRead(id, remote, upTo);
    if (!raws.length) return;
    this.emit("event", { type: "chat-read", lineId: id, remote } satisfies LineEvent);
    if (line.wa.status === "open") {
      await line.request({ cmd: "mark-read", raws }).catch((err) => log.warn(`falha ao enviar confirmação de leitura: ${err.message}`));
    }
  };

  /** URL da foto de perfil do contato (null se não houver). Guardada por 6 horas. */
  profilePicture = async (id: string, remote: string, remoteJid?: string): Promise<string | null> => {
    const line = this.#require(id);
    const key = `${id}:${remote}`;
    const hit = this.#photos.get(key);
    if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.url;
    if (line.wa.status !== "open") return hit?.url ?? null;
    const jid = remoteJid ?? `${remote.replace(/\D/g, "")}@s.whatsapp.net`;
    const url = await line.request<string | null>({ cmd: "profile-picture", jid }).catch(() => null);
    this.#photos.set(key, { url, at: Date.now() });
    return url;
  };

  #cacheMedia = async (id: string, waId: string, data: Uint8Array): Promise<void> => {
    const file = this.store.mediaFileFor(id, waId);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      await writeFile(file, data);
    } catch (err: any) {
      log.warn(`falha ao guardar mídia em cache: ${err.message}`);
    }
  };

  #add = (config: LineConfig): LineRuntime => {
    const line = new LineRuntime(config, this.store.authDirFor(config.id));
    this.#lines.set(config.id, line);
    line.on("event", (e: LineEvent) => this.emit("event", e));
    line.on("wa", () => this.emit("wa", config.id));
    line.on("crashed", (detail: string) => this.emit("crashed", config.id, detail));
    line.on("audio", (callId: string, pcm: Buffer) => this.emit("audio", config.id, callId, pcm));
    line.on("ended-call", (view: CallView) => {
      this.store.appendCall(view).catch((err) => log.error(`falha ao gravar ligação no histórico: ${err.message}`));
    });
    line.on("wa-message", (rec: MessageRecord, raw: string) => {
      this.store.insertMessage(config.id, rec, raw)
        .then((view) => { if (view) this.emit("event", { type: "message", lineId: config.id, message: view } satisfies LineEvent); })
        .catch((err) => log.error(`falha ao gravar mensagem: ${err.message}`));
    });
    line.on("wa-message-status", (waId: string, status: MessageStatus) => {
      this.store.updateMessageStatus(config.id, waId, status)
        .then((view) => { if (view) this.emit("event", { type: "message-status", lineId: config.id, message: view } satisfies LineEvent); })
        .catch((err) => log.error(`falha ao atualizar status da mensagem: ${err.message}`));
    });
    return line;
  };

  #require = (id: string): LineRuntime => {
    const line = this.#lines.get(id);
    if (!line) throw new HttpError(404, "Linha não encontrada");
    return line;
  };
}

const INBOUND = ["manual", "auto", "reject"];
const HANDLERS = ["browser", "echo", "silence", "ws-bridge"];

/** Valida campos editáveis; ignora o resto (id, token, createdAt). */
const sanitizePatch = (p: Partial<LineConfig>): Partial<LineConfig> => {
  const out: Partial<LineConfig> = {};
  if (typeof p.name === "string") {
    const name = p.name.trim();
    if (!name || name.length > 60) throw new HttpError(400, "Nome deve ter de 1 a 60 caracteres");
    out.name = name;
  }
  if (p.inboundMode !== undefined) {
    if (!INBOUND.includes(p.inboundMode)) throw new HttpError(400, `inboundMode: use ${INBOUND.join(", ")}`);
    out.inboundMode = p.inboundMode;
  }
  if (p.handler !== undefined) {
    if (!HANDLERS.includes(p.handler)) throw new HttpError(400, `handler: use ${HANDLERS.join(", ")}`);
    out.handler = p.handler;
  }
  const num = (k: "inboundAnswerDelayMs" | "maxCallDurationMs" | "bridgeSampleRate" | "rateLimitPerMinute" | "rateLimitPerDay", min: number, max: number) => {
    if (p[k] === undefined) return;
    const v = Number(p[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `${k} fora do intervalo ${min}–${max}`);
    out[k] = v;
  };
  num("inboundAnswerDelayMs", 0, 60_000);
  num("maxCallDurationMs", 0, 24 * 3_600_000);
  num("bridgeSampleRate", 8000, 48000);
  num("rateLimitPerMinute", 0, 1000);
  num("rateLimitPerDay", 0, 1_000_000);
  if (p.bridgeUrl !== undefined) {
    if (typeof p.bridgeUrl !== "string" || (p.bridgeUrl && !/^wss?:\/\//.test(p.bridgeUrl))) {
      throw new HttpError(400, "bridgeUrl deve começar com ws:// ou wss://");
    }
    out.bridgeUrl = p.bridgeUrl;
  }
  if (p.allowedOrigins !== undefined) {
    const list = Array.isArray(p.allowedOrigins) ? p.allowedOrigins : String(p.allowedOrigins).split(/[\s,]+/);
    out.allowedOrigins = list.map((o) => String(o).trim().replace(/\/+$/, "")).filter(Boolean);
    for (const o of out.allowedOrigins) {
      if (!/^https?:\/\/[^\s/]+$/.test(o)) throw new HttpError(400, `Origem inválida: ${o} (ex.: https://meusite.com)`);
    }
  }
  if (p.webhookUrl !== undefined) {
    const u = String(p.webhookUrl).trim();
    if (u && !/^https?:\/\/\S+$/.test(u)) throw new HttpError(400, "URL do webhook deve começar com http:// ou https://");
    out.webhookUrl = u;
  }
  if (p.webhookSecret !== undefined) {
    const sec = String(p.webhookSecret).trim();
    if (sec.length > 200) throw new HttpError(400, "Segredo do webhook muito longo (máx. 200)");
    out.webhookSecret = sec;
  }
  if (p.webhookEvents !== undefined) {
    if (!Array.isArray(p.webhookEvents)) throw new HttpError(400, "webhookEvents deve ser uma lista");
    for (const ev of p.webhookEvents) {
      if (!WEBHOOK_EVENTS.includes(ev as any)) throw new HttpError(400, `Evento de webhook inválido: ${ev} (use ${WEBHOOK_EVENTS.join(", ")})`);
    }
    out.webhookEvents = [...new Set(p.webhookEvents.map(String))];
  }
  return out;
};
