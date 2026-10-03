import { createHmac, randomUUID } from "node:crypto";
import type { LineEvent, LineManager, MessageView } from "./line-manager.js";
import { log } from "./log.js";
import type { LineConfig } from "./worker/protocol.js";

/** Eventos que podem ser enviados ao webhook de uma linha. */
export const WEBHOOK_EVENTS = [
  "message.received", "message.sent", "message.status",
  "call.incoming", "call.dialing", "call.answered", "call.connected", "call.ended", "call.busy",
  "line.status",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | "ping";

/** Esperas entre tentativas (a 1ª é imediata). */
const RETRY_DELAYS_MS = [0, 5_000, 30_000, 120_000];
const TIMEOUT_MS = 10_000;
/** Fila máxima por linha; acima disso os eventos mais antigos são descartados. */
const MAX_QUEUE = 1000;

export type WebhookResult = { ok: boolean; status?: number; error?: string; ms: number };

type Job = { event: WebhookEvent; body: string };

/**
 * Envia os eventos das linhas para o webhook configurado em cada uma.
 * Entrega em ordem por linha, com novas tentativas; a fila fica em memória.
 *
 * Corpo: { id, event, timestamp, line: { id, name, phone }, data }
 * Assinatura (quando há segredo):
 *   X-Webhook-Signature: sha256=HMAC_SHA256(segredo, `${X-Webhook-Timestamp}.${corpo}`) em hex
 */
export class WebhookDispatcher {
  readonly #queues = new Map<string, Job[]>();
  readonly #running = new Set<string>();
  readonly #lastStatus = new Map<string, string>();

  constructor(private readonly lines: LineManager, private readonly publicUrl = "") {
    lines.on("event", (e: LineEvent) => this.#onEvent(e));
    lines.on("removed", (lineId: string) => {
      this.#queues.delete(lineId);
      this.#lastStatus.delete(lineId);
    });
  }

  /** Envia um evento de teste agora (uma tentativa) e devolve o resultado. */
  test = async (lineId: string): Promise<WebhookResult> => {
    const line = this.lines.get(lineId);
    if (!line?.config.webhookUrl) return { ok: false, error: "Webhook não configurado", ms: 0 };
    const body = this.#body(line.config, "ping", { message: "Teste do webhook" }, line.wa.me);
    return this.#post(line.config, "ping", body);
  };

  /** URL para baixar a mídia de uma mensagem (exige o token da linha). */
  mediaUrl = (m: MessageView): string | undefined =>
    m.media ? `${this.publicUrl}/api/v1/messages/${encodeURIComponent(m.id)}/media` : undefined;

  #onEvent = (e: LineEvent): void => {
    const line = this.lines.get(e.lineId);
    if (!line) return;
    let event: WebhookEvent;
    let data: unknown;
    switch (e.type) {
      case "message":
        event = e.message.direction === "incoming" ? "message.received" : "message.sent";
        data = { ...e.message, mediaUrl: this.mediaUrl(e.message) };
        break;
      case "message-status":
        event = "message.status";
        data = { id: e.message.id, remote: e.message.remote, status: e.message.status, timestamp: e.message.timestamp };
        break;
      case "busy": event = "call.busy"; data = { from: e.from }; break;
      case "chat-read": return;
      case "line": {
        // "line" também sai a cada mudança de chamada; só interessa a troca de status.
        const prev = this.#lastStatus.get(e.lineId);
        this.#lastStatus.set(e.lineId, e.line.status);
        if (prev === undefined || prev === e.line.status) return;
        event = "line.status";
        data = { status: e.line.status, previous: prev, phone: e.line.phone };
        break;
      }
      default: {
        const { ownerClientId: _, ...call } = e.call;
        event = `call.${e.type}`;
        data = call;
      }
    }
    const cfg = line.config;
    if (!cfg.webhookUrl || (cfg.webhookEvents.length && !cfg.webhookEvents.includes(event))) return;
    this.#enqueue(cfg.id, { event, body: this.#body(cfg, event, data, line.wa.me) });
  };

  #body = (cfg: LineConfig, event: WebhookEvent, data: unknown, phone?: string): string =>
    JSON.stringify({
      id: randomUUID(),
      event,
      timestamp: new Date().toISOString(),
      line: { id: cfg.id, name: cfg.name, phone },
      data,
    });

  #enqueue = (lineId: string, job: Job): void => {
    let q = this.#queues.get(lineId);
    if (!q) this.#queues.set(lineId, (q = []));
    q.push(job);
    if (q.length > MAX_QUEUE) {
      q.shift();
      log.warn(`webhook da linha ${lineId}: fila cheia, evento mais antigo descartado`);
    }
    void this.#drain(lineId);
  };

  #drain = async (lineId: string): Promise<void> => {
    if (this.#running.has(lineId)) return;
    this.#running.add(lineId);
    try {
      for (let job = this.#queues.get(lineId)?.[0]; job; job = this.#queues.get(lineId)?.[0]) {
        await this.#deliver(lineId, job);
        this.#queues.get(lineId)?.shift();
      }
    } finally {
      this.#running.delete(lineId);
    }
  };

  #deliver = async (lineId: string, job: Job): Promise<void> => {
    let last: WebhookResult | undefined;
    for (const delay of RETRY_DELAYS_MS) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      // Lê a configuração na hora: se o webhook mudou ou foi desligado, vale o atual.
      const cfg = this.lines.get(lineId)?.config;
      if (!cfg?.webhookUrl) return;
      last = await this.#post(cfg, job.event, job.body);
      if (last.ok) return;
    }
    log.warn(`webhook da linha ${lineId}: ${job.event} descartado após ${RETRY_DELAYS_MS.length} tentativas (${last?.error ?? `HTTP ${last?.status}`})`);
  };

  #post = async (cfg: LineConfig, event: WebhookEvent, body: string): Promise<WebhookResult> => {
    const ts = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "whatsapp-voice-gateway",
      "x-webhook-event": event,
      "x-webhook-timestamp": ts,
    };
    if (cfg.webhookSecret) {
      headers["x-webhook-signature"] = `sha256=${createHmac("sha256", cfg.webhookSecret).update(`${ts}.${body}`).digest("hex")}`;
    }
    const started = Date.now();
    try {
      const res = await fetch(cfg.webhookUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      await res.body?.cancel().catch(() => {});
      return { ok: res.ok, status: res.status, ms: Date.now() - started };
    } catch (err: any) {
      return { ok: false, error: err?.cause?.message ?? err?.message ?? String(err), ms: Date.now() - started };
    }
  };
}
