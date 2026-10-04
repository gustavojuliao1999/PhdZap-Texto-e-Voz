import { EventEmitter } from "node:events";
import type { ActiveCall, IncomingCallInfo, VoipClient } from "baileys-caller";
import type { CallHandler } from "./handlers/types.js";
import { log } from "./log.js";
import { CallSession, type CallRecord } from "./session.js";

const HISTORY_LIMIT = 100;

/** Política de chamadas (mutável: o worker atualiza quando a linha é reconfigurada). */
export type CallPolicy = {
  inboundMode: "manual" | "auto" | "reject";
  inboundAnswerDelayMs: number;
  maxCallDurationMs: number;
  /** Contato oculto: o gateway não atende nem recusa (só o celular toca). */
  isHidden?: (remote: string) => boolean;
  /** Chamadas de vídeo recebidas: atender só com áudio, mostrar o vídeo ou recusar. */
  videoCalls?: "audio" | "video" | "reject";
};

export type GatewayEvent =
  | { type: "incoming"; call: CallRecord }
  | { type: "busy"; from: string; callId: string }
  | { type: "connected"; call: CallRecord }
  | { type: "ended"; call: CallRecord };

/**
 * Orquestra as chamadas: aplica a política de entrada, liga handlers e mantém
 * histórico. O baileys-caller só suporta UMA chamada por vez.
 *
 * Emite `event` (GatewayEvent).
 */
export class CallManager extends EventEmitter {
  #current: CallSession | null = null;
  readonly #history: CallRecord[] = [];
  /** Handler que vai rodar quando a chamada conectar (pode ser trocado até lá). */
  readonly #pendingHandler = new WeakMap<CallSession, CallHandler>();

  constructor(
    private readonly client: VoipClient,
    private readonly cfg: CallPolicy,
    private readonly handlers: Record<string, CallHandler>,
    private defaultHandler: CallHandler,
  ) {
    super();
    client.on("incoming", (call: ActiveCall) => this.#onIncoming(call));
    client.on("busy", (info: IncomingCallInfo) => {
      log.warn(`chamada de ${info.fromPhone ?? info.from} ignorada: já existe uma chamada ativa`);
      this.#emit({ type: "busy", from: info.fromPhone ?? info.from, callId: info.callId });
    });
  }

  get current(): CallSession | null { return this.#current; }
  setDefaultHandler = (handler: CallHandler): void => { this.defaultHandler = handler; };
  get history(): CallRecord[] { return [...this.#history]; }

  get = (id: string): CallSession | null => (this.#current?.id === id ? this.#current : null);

  /** Faz uma chamada de saída. O handler roda quando o destino atender. */
  dial = async (to: string, handlerName?: string): Promise<CallSession> => {
    if (this.#current) throw new Error("Já existe uma chamada ativa");
    const handler = this.#resolveHandler(handlerName);
    const number = to.replace(/\D/g, "");
    if (number.length < 8) throw new Error("Número inválido (use DDI+DDD+número, só dígitos)");
    log.info(`ligando para ${number} (handler=${handler.name})`);
    const call = await this.client.call(number, {
      audioSource: "stream",
      durationMs: this.cfg.maxCallDurationMs,
    });
    // O número discado pode diferir do digitado (ex.: 9º dígito no Brasil).
    return this.#track(new CallSession(call, call.remoteNumber ?? number), handler);
  };

  /** Atende; `handlerName` permite trocar o handler (ex.: "browser" p/ atender pelo painel). */
  accept = (id: string, handlerName?: string): void => {
    const session = this.#require(id);
    if (handlerName) this.#setHandler(session, this.#resolveHandler(handlerName));
    session.call.accept();
  };
  reject = (id: string): void => this.#require(id).call.reject();
  hangup = (id: string): void => this.#require(id).hangup();

  #onIncoming = (call: ActiveCall): void => {
    if (call.ended) return; // encerrou antes de chegar aqui: não deixa "tocando" para sempre
    const info = call.incoming!;
    const remote = info.fromPhone ?? info.from;
    const session = this.#track(new CallSession(call, remote, info.from, info.pushName), this.defaultHandler);
    log.info(`chamada recebida de ${remote}${info.pushName ? ` (${info.pushName})` : ""} id=${call.callId}`);
    this.#emit({ type: "incoming", call: session.record });
    if (this.cfg.isHidden?.(remote)) {
      log.info(`[${call.callId}] contato oculto: fica só no celular`);
      return;
    }
    if (info.isVideo && this.cfg.videoCalls === "reject") {
      log.info(`[${call.callId}] chamada de vídeo recusada (configuração do telefone)`);
      call.reject();
      return;
    }

    switch (this.cfg.inboundMode) {
      case "reject":
        log.info(`[${call.callId}] recusando (INBOUND_MODE=reject)`);
        call.reject();
        break;
      case "auto":
        setTimeout(() => {
          if (session.ended) return;
          log.info(`[${call.callId}] atendendo`);
          try { call.accept(); } catch (err) { log.error("falha ao atender:", err); }
        }, this.cfg.inboundAnswerDelayMs);
        break;
      case "manual":
        log.info(`[${call.callId}] aguardando POST /calls/${call.callId}/accept`);
        break;
    }
  };

  #resolveHandler = (name?: string): CallHandler => {
    if (!name) return this.defaultHandler;
    const handler = this.handlers[name];
    if (!handler) throw new Error(`Handler desconhecido: ${name} (use ${Object.keys(this.handlers).join(", ")})`);
    return handler;
  };

  #setHandler = (session: CallSession, handler: CallHandler): void => {
    this.#pendingHandler.set(session, handler);
    session.record.handler = handler.name;
  };

  #track = (session: CallSession, initialHandler: CallHandler): CallSession => {
    this.#current = session;
    this.#setHandler(session, initialHandler);
    this.#history.unshift(session.record);
    if (this.#history.length > HISTORY_LIMIT) this.#history.pop();

    session.once("connected", () => {
      const handler = this.#pendingHandler.get(session) ?? initialHandler;
      log.info(`[${session.id}] conectada; iniciando handler ${handler.name}`);
      this.#emit({ type: "connected", call: session.record });
      Promise.resolve()
        .then(() => handler.start(session))
        .catch((err) => {
          log.error(`[${session.id}] handler ${handler.name} falhou:`, err);
          session.hangup();
        });
    });
    session.once("ended", (reason: string) => {
      log.info(`[${session.id}] encerrada: ${reason}`);
      if (this.#current === session) this.#current = null;
      this.#emit({ type: "ended", call: session.record });
    });
    return session;
  };

  #require = (id: string): CallSession => {
    const s = this.get(id);
    if (!s) throw new Error(`Chamada ${id} não encontrada ou já encerrada`);
    return s;
  };

  #emit = (e: GatewayEvent): void => { this.emit("event", e); };
}
