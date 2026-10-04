import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hiddenMatcher, hiddenRemotes, normalizeHiddenList } from "./hidden.js";
import { log } from "./log.js";
import type { CallRecord } from "./session.js";
import type { ContactView, Store } from "./store.js";
import { SendLimiter } from "./rate-limit.js";
import { WEBHOOK_EVENTS } from "./webhooks.js";
import type { WhatsAppState } from "./whatsapp.js";
import {
  RESTART_EXIT_CODE, VIDEO_CALL_MODES, type ContactRecord, type VideoSource, type GatewayEvent, type LineConfig, type MessageRecord, type MessageStatus,
  type OutgoingContent, type WorkerCommand, type WorkerMessage,
} from "./worker/protocol.js";

/** Sincronização do histórico: rodadas por conversa (50 mensagens cada) e espera pela resposta do celular. */
const SYNC_MAX_ROUNDS = 100;
// O celular não responde quando a conversa já chegou ao início: a espera encerra a conversa.
const SYNC_WAIT_MS = Number(process.env.SYNC_WAIT_MS || 15_000);
const HISTORY_PAGE = 50;

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
  /** Histórico: há gravação (GET /api/v1/calls/:id/recording) e a transcrição. */
  hasRecording?: boolean;
  recordingSeconds?: number;
  transcript?: string;
  /** Chamada de vídeo com o vídeo do cliente disponível em GET /api/v1/calls/:id/video. */
  videoStream?: boolean;
  /** Vídeo enviado pelo atendente: câmera, tela ou nenhum. */
  videoSource?: VideoSource;
};

/** Mensagem como vista pelos clientes. */
export type MessageView = MessageRecord & {
  lineId: string;
  /** Quem enviou pelo gateway (usuário do painel ou "API"). */
  agent?: string;
  editedAt?: string;
  deletedAt?: string;
  /** Transcrição (áudio de voz). */
  transcript?: string;
};

/** Evento publicado para os WebSockets (de uma linha e do admin) e para o webhook. */
export type LineEvent =
  | { type: "dialing" | "incoming" | "connected" | "ended" | "answered"; lineId: string; call: CallView }
  | { type: "busy"; lineId: string; from: string }
  | { type: "message"; lineId: string; message: MessageView }
  | { type: "message-status"; lineId: string; message: MessageView }
  /** Conversa marcada como lida (zera o contador nos outros painéis). */
  | { type: "chat-read"; lineId: string; remote: string }
  /** Mensagem editada, apagada ou transcrita. */
  | { type: "message-update"; lineId: string; message: MessageView }
  /** Dados de atendimento da conversa mudaram (status, responsável, nome, notas). */
  | { type: "contact"; lineId: string; contact: ContactView }
  /** Gravação ou transcrição de uma ligação ficou pronta. */
  | { type: "call-update"; lineId: string; kind: "recording" | "transcript"; call: CallUpdate }
  /** Chegou histórico do celular: `remotes` = conversas com mensagens novas (antigas). */
  | { type: "history"; lineId: string; remotes: string[]; added: number; syncType: string; progress?: number }
  /** Andamento da sincronização completa do histórico. */
  | { type: "sync"; lineId: string; sync: SyncStatus }
  | { type: "line"; lineId: string; line: LinePublic };

/** Sincronização completa do histórico de uma linha. */
export type SyncStatus = {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  /** Conversas a percorrer e já percorridas. */
  chats: number;
  done: number;
  /** Mensagens antigas gravadas nesta sincronização. */
  added: number;
  /** Contatos recebidos da agenda do celular. */
  contacts: number;
  error?: string;
};

/** Parte da ligação que mudou depois de encerrada. */
export type CallUpdate = { id: string; remote: string; hasRecording?: boolean; recordingSeconds?: number; transcript?: string };

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
  /** Ligações de contatos ocultos: vão para o histórico, mas não para o painel. */
  readonly #hiddenCalls = new Set<string>();
  /** Último quadro do vídeo do cliente, por ligação (quem abre o vídeo já vê a imagem). */
  readonly lastVideo = new Map<string, Buffer>();

  constructor(public config: LineConfig, private readonly authDir: string) {
    super();
  }

  get running(): boolean { return !!this.#child; }

  /** O contato está na lista de ocultos deste telefone? */
  isHidden = (remote: string | undefined | null): boolean => hiddenMatcher(this.config.hiddenContacts ?? [])(remote);

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
    opts: { handler?: string; clientId?: string; agent?: string; userId?: string; video?: boolean } = {},
  ): Promise<CallView> => {
    if (this.current) throw new HttpError(409, "Linha ocupada: já existe uma chamada");
    if (this.wa.status !== "open") throw new HttpError(503, "WhatsApp desta linha não está conectado");
    const record = await this.request<CallRecord>({ cmd: "dial", to, handler: opts.handler, video: !!opts.video });
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
      ...(opts.video ? { videoStream: true, videoSource: "camera" as const } : {}),
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

  /** Quadro JPEG da câmera/tela do atendente. */
  sendVideoUp = (callId: string, jpeg: Buffer): void => {
    this.#child?.send({ t: "video-up", callId, jpeg: new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength) });
  };

  /** Liga a câmera ou a tela do atendente (ou desliga o vídeo) na ligação atual. */
  setVideoSource = async (callId: string, source: VideoSource): Promise<CallView> => {
    const call = this.current;
    if (!call || call.id !== callId) throw new HttpError(404, "Chamada não encontrada ou já encerrada");
    await this.request({ cmd: "video-source", callId, source });
    // Com o vídeo ligado, o atendente também vê o do cliente.
    Object.assign(call, { videoSource: source, ...(source !== "off" ? { videoStream: true, isVideo: true } : {}) });
    this.#emitLine();
    return call;
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
      case "video":
        if (this.#hiddenCalls.has(msg.callId)) return;
        this.lastVideo.set(msg.callId, Buffer.from(msg.jpeg.buffer, msg.jpeg.byteOffset, msg.jpeg.byteLength));
        this.emit("video", msg.callId, this.lastVideo.get(msg.callId));
        return;
      case "event":
        this.#onCallEvent(msg.event);
        return;
    }
  };

  #onCallEvent = (e: GatewayEvent): void => {
    const lineId = this.config.id;
    if (e.type === "busy") {
      if (!this.isHidden(e.from)) this.emit("event", { type: "busy", lineId, from: e.from } satisfies LineEvent);
      return;
    }
    // Mensagens: o LineManager grava no banco antes de publicar.
    if (e.type === "message") { this.emit("wa-message", e.message, e.raw); return; }
    if (e.type === "message-update") { this.emit("wa-message-update", e.id, e); return; }
    if (e.type === "recording") { this.emit("wa-recording", e.callId, e.file, e.seconds); return; }
    if (e.type === "message-status") { this.emit("wa-message-status", e.id, e.status); return; }
    if (e.type === "history") { this.emit("wa-history", e); return; }
    if (e.type === "contacts") { this.emit("wa-contacts", e.contacts); return; }
    // Contato oculto: a ligação fica só no celular (e no histórico do banco).
    if (this.#hiddenCalls.has(e.call.id) || (e.type === "incoming" && this.isHidden(e.call.remote))) {
      this.#hiddenCalls.add(e.call.id);
      if (e.type === "ended") {
        this.#hiddenCalls.delete(e.call.id);
        this.emit("ended-call", { ...e.call, lineId, lineName: this.config.name } satisfies CallView);
      }
      return;
    }
    // Preserva quem atendeu entre atualizações do worker.
    const prev = this.current?.id === e.call.id ? this.current : null;
    const view: CallView = {
      ...e.call,
      lineId,
      lineName: this.config.name,
      ownerClientId: prev?.ownerClientId,
      ownerAgent: prev?.ownerAgent,
      ownerUserId: prev?.ownerUserId,
      ...(e.call.isVideo && this.config.videoCalls === "video" ? { videoStream: true } : {}),
      // Vídeo ligado pelo atendente (ou ligação com vídeo) continua valendo entre atualizações.
      ...(prev?.videoStream ? { videoStream: true, isVideo: true } : {}),
      ...(prev?.videoSource ? { videoSource: prev.videoSource } : {}),
    };
    if (e.type === "ended") { this.#finishCall(view); return; }
    this.current = view;
    this.emit("event", { type: e.type, lineId, call: view } satisfies LineEvent);
  };

  #finishCall = (view: CallView): void => {
    this.current = null;
    this.lastVideo.delete(view.id);
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
  /** Sincronização completa do histórico, por linha. */
  readonly #sync = new Map<string, SyncStatus>();
  /** Quem espera a próxima resposta de histórico sob pedido (ON_DEMAND), por linha. */
  readonly #historyWaiters = new Map<string, Set<(added: number) => void>>();

  constructor(private readonly store: Store) {
    super();
    // Cada vídeo aberto no painel escuta `video` e `event` enquanto a ligação durar.
    this.setMaxListeners(200);
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

  // ─── contatos ocultos ────────────────────────────────────────────────────

  /** O contato está oculto neste telefone? */
  isHidden = (id: string, remote: string | undefined | null): boolean => !!this.#lines.get(id)?.isHidden(remote);

  /** Formas gravadas dos números ocultos (para filtrar consultas no banco). */
  hiddenRemotes = (id: string): string[] => hiddenRemotes(this.#lines.get(id)?.config.hiddenContacts ?? []);

  /** Recusa operar com um contato oculto (API e painel não o enxergam). */
  assertVisible = (id: string, remote: string): void => {
    if (this.isHidden(id, remote)) throw new HttpError(404, "Contato não encontrado");
  };

  // ─── histórico e agenda ─────────────────────────────────────────────────

  /** Pede ao celular mensagens anteriores da conversa (chegam pelo evento `history`). */
  requestOlder = async (id: string, remote: string): Promise<void> => {
    const line = this.#require(id);
    if (line.wa.status !== "open") throw new HttpError(503, "WhatsApp desta linha não está conectado");
    const oldest = await this.store.oldestMessage(id, remote);
    if (!oldest) throw new HttpError(409, "Ainda não há mensagens desta conversa no gateway para servir de referência");
    await line.request({ cmd: "fetch-history", raw: oldest.raw, count: HISTORY_PAGE });
  };

  syncStatus = (id: string): SyncStatus =>
    this.#sync.get(id) ?? { running: false, chats: 0, done: 0, added: 0, contacts: 0 };

  /**
   * Sincronização completa: baixa a agenda do celular e, conversa por conversa, pede as mensagens
   * antigas até o celular não ter mais. Roda em segundo plano; o andamento sai no evento `sync`.
   */
  syncAll = (id: string): SyncStatus => {
    const line = this.#require(id);
    if (line.wa.status !== "open") throw new HttpError(503, "WhatsApp desta linha não está conectado");
    if (this.#sync.get(id)?.running) throw new HttpError(409, "A sincronização deste telefone já está em andamento");
    const st: SyncStatus = { running: true, startedAt: new Date().toISOString(), chats: 0, done: 0, added: 0, contacts: 0 };
    this.#sync.set(id, st);
    const publish = () => this.emit("event", { type: "sync", lineId: id, sync: { ...st } } satisfies LineEvent);
    const onContacts = (n: number) => { st.contacts += n; };
    line.on("contacts-saved", onContacts);
    void (async () => {
      try {
        await line.request({ cmd: "sync-contacts" }).catch((err) => log.warn(`agenda do celular não sincronizou: ${err.message}`));
        const remotes = (await this.store.chatRemotes(id)).filter((r) => line.config.groupsEnabled || !r.endsWith("@g.us"));
        st.chats = remotes.length;
        publish();
        for (const remote of remotes) {
          for (let round = 0; round < SYNC_MAX_ROUNDS; round++) {
            if (line.wa.status !== "open") throw new Error("o telefone desconectou");
            const oldest = await this.store.oldestMessage(id, remote);
            if (!oldest) break;
            const reply = this.#nextHistory(id);
            await line.request({ cmd: "fetch-history", raw: oldest.raw, count: HISTORY_PAGE });
            const added = await reply;
            st.added += added;
            if (added === 0) break;
          }
          st.done += 1;
          publish();
        }
      } catch (err: any) {
        st.error = err?.message ?? String(err);
        log.warn(`sincronização do histórico (${line.config.name}) parou: ${st.error}`);
      } finally {
        line.off("contacts-saved", onContacts);
        st.running = false;
        st.finishedAt = new Date().toISOString();
        publish();
        log.info(`sincronização do histórico (${line.config.name}): ${st.added} mensagem(ns) em ${st.done} conversa(s), ${st.contacts} contato(s)`);
      }
    })();
    return { ...st };
  };

  /** Promessa da próxima resposta ON_DEMAND (mensagens gravadas); 0 se o celular não responder. */
  #nextHistory = (id: string): Promise<number> => new Promise((resolve) => {
    let set = this.#historyWaiters.get(id);
    if (!set) this.#historyWaiters.set(id, (set = new Set()));
    const done = (n: number) => { clearTimeout(timer); set!.delete(done); resolve(n); };
    const timer = setTimeout(() => done(0), SYNC_WAIT_MS);
    set.add(done);
  });

  /** Histórico vindo do celular: grava em lote e avisa os painéis uma vez por bloco. */
  #onHistory = async (line: LineRuntime, h: Extract<GatewayEvent, { type: "history" }>): Promise<void> => {
    const id = line.config.id;
    const added = await this.store.insertHistory(id, h.messages);
    // Nomes de perfil que vieram nas mensagens antigas.
    const names = new Map<string, ContactRecord>();
    for (const { message: m } of h.messages) {
      if (m.direction === "incoming" && m.pushName && !m.remoteJid.endsWith("@g.us")) {
        names.set(m.remote, { remote: m.remote, remoteJid: m.remoteJid, pushName: m.pushName });
      }
    }
    if (names.size) await this.store.saveContacts(id, [...names.values()]);
    const total = [...added.values()].reduce((a, b) => a + b, 0);
    if (h.syncType === "ON_DEMAND") for (const w of [...(this.#historyWaiters.get(id) ?? [])]) w(total);
    const remotes = [...added.keys()].filter((r) => !line.isHidden(r));
    if (remotes.length) {
      const visible = remotes.reduce((n, r) => n + (added.get(r) ?? 0), 0);
      this.emit("event", { type: "history", lineId: id, remotes, added: visible, syncType: h.syncType, progress: h.progress } satisfies LineEvent);
    }
  };

  // ─── mensagens ──────────────────────────────────────────────────────────

  /** Envia uma mensagem; `replyTo` = id de uma mensagem desta linha para citar. */
  sendMessage = async (
    id: string, to: string, content: OutgoingContent, opts: { agent?: string; replyTo?: string } = {},
  ): Promise<MessageView> => {
    const line = this.#require(id);
    if (line.wa.status !== "open") throw new HttpError(503, "WhatsApp desta linha não está conectado");
    if (line.isHidden(to)) throw new HttpError(403, "Este contato está oculto neste telefone");
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
    this.assertVisible(id, found.view.remote);
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
    this.assertVisible(id, found.view.remote);
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

  /** Caminho absoluto de um arquivo da linha (gravações). */
  lineFile = (id: string, file: string): string => path.join(path.dirname(this.store.authDirFor(id)), file);

  /** Liga a gravação à ligação no histórico (que pode ainda estar sendo gravado no banco). */
  #saveRecording = async (lineId: string, callId: string, file: string, seconds: number): Promise<void> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const n = await this.store.updateCall(lineId, callId, { recordingFile: file, recordingSeconds: seconds });
      if (n) {
        const call = await this.store.getCall(lineId, callId);
        const update: CallUpdate = { id: callId, remote: call?.remote ?? "", hasRecording: true, recordingSeconds: seconds };
        this.emit("event", { type: "call-update", lineId, kind: "recording", call: update } satisfies LineEvent);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    log.warn(`gravação ${file}: ligação ${callId} não encontrada no histórico`);
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
    line.on("video", (callId: string, jpeg: Buffer) => this.emit("video", config.id, callId, jpeg));
    line.on("ended-call", (view: CallView) => {
      this.store.appendCall(view).catch((err) => log.error(`falha ao gravar ligação no histórico: ${err.message}`));
    });
    line.on("wa-message", (rec: MessageRecord, raw: string) => {
      if (rec.chatName) this.store.ensureContactName(config.id, rec.remote, rec.chatName).catch(() => {});
      if (rec.direction === "incoming" && rec.pushName && !rec.remoteJid.endsWith("@g.us")) {
        this.store.saveContacts(config.id, [{ remote: rec.remote, remoteJid: rec.remoteJid, pushName: rec.pushName }]).catch(() => {});
      }
      this.store.insertMessage(config.id, rec, raw)
        .then((view) => { if (view && !line.isHidden(view.remote)) this.emit("event", { type: "message", lineId: config.id, message: view } satisfies LineEvent); })
        .catch((err) => log.error(`falha ao gravar mensagem: ${err.message}`));
    });
    // Em fila: os blocos do histórico são gravados na ordem em que chegam.
    let historyQueue = Promise.resolve();
    line.on("wa-history", (h: Extract<GatewayEvent, { type: "history" }>) => {
      historyQueue = historyQueue
        .then(() => this.#onHistory(line, h))
        .catch((err) => log.error(`falha ao gravar histórico: ${err.message}`));
    });
    line.on("wa-contacts", (contacts: ContactRecord[]) => {
      historyQueue = historyQueue
        .then(() => this.store.saveContacts(config.id, contacts))
        .then(() => { line.emit("contacts-saved", contacts.length); })
        .catch((err) => log.error(`falha ao gravar contatos: ${err.message}`));
    });
    line.on("wa-message-update", (waId: string, u: { text?: string; deleted?: boolean }) => {
      this.store.applyMessageUpdate(config.id, waId, u)
        .then((view) => {
          if (!view) return;
          if (u.deleted) rmSync(this.store.mediaFileFor(config.id, waId), { force: true });
          if (line.isHidden(view.remote)) return;
          this.emit("event", { type: "message-update", lineId: config.id, message: view } satisfies LineEvent);
        })
        .catch((err) => log.error(`falha ao atualizar mensagem: ${err.message}`));
    });
    line.on("wa-recording", (callId: string, file: string, seconds: number) => {
      void this.#saveRecording(config.id, callId, file, seconds);
    });
    line.on("wa-message-status", (waId: string, status: MessageStatus) => {
      this.store.updateMessageStatus(config.id, waId, status)
        .then((view) => { if (view && !line.isHidden(view.remote)) this.emit("event", { type: "message-status", lineId: config.id, message: view } satisfies LineEvent); })
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
  for (const k of ["businessHoursEnabled", "groupsEnabled", "recordCalls", "transcribeCalls", "transcribeVoiceNotes"] as const) {
    if (p[k] !== undefined) out[k] = !!p[k];
  }
  if (p.offHoursMessage !== undefined) {
    const msg = String(p.offHoursMessage);
    if (msg.length > 4096) throw new HttpError(400, "Mensagem fora do horário muito longa (máx. 4096)");
    out.offHoursMessage = msg;
  }
  if (p.businessHours !== undefined) {
    const hours: LineConfig["businessHours"] = {};
    const src = (p.businessHours ?? {}) as Record<string, unknown>;
    for (const day of ["0", "1", "2", "3", "4", "5", "6"] as const) {
      const ranges = Array.isArray(src[day]) ? (src[day] as unknown[]) : [];
      hours[day] = ranges.map((r) => {
        const [a, b] = Array.isArray(r) ? r.map(String) : [];
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(a ?? "") || !/^([01]\d|2[0-4]):[0-5]\d$/.test(b ?? "") || a >= b) {
          throw new HttpError(400, `Horário inválido (dia ${day}): use ["08:00","18:00"] com início antes do fim`);
        }
        return [a, b] as [string, string];
      });
    }
    out.businessHours = hours;
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
  if (p.hiddenContacts !== undefined) out.hiddenContacts = normalizeHiddenList(p.hiddenContacts);
  if (p.videoCalls !== undefined) {
    if (!VIDEO_CALL_MODES.includes(p.videoCalls)) throw new HttpError(400, `videoCalls: use ${VIDEO_CALL_MODES.join(", ")}`);
    out.videoCalls = p.videoCalls;
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
