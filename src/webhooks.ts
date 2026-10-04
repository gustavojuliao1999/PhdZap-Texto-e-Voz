import { createHmac, randomUUID } from "node:crypto";
import type { PrismaClient, WebhookDelivery } from "@prisma/client";
import type { Alerts } from "./alerts.js";
import type { LineEvent, LineManager, MessageView } from "./line-manager.js";
import { log } from "./log.js";
import type { LineConfig } from "./worker/protocol.js";

/** Eventos que podem ser enviados ao webhook de uma linha. */
export const WEBHOOK_EVENTS = [
  "message.received", "message.sent", "message.status", "message.updated", "message.deleted",
  "conversation.updated",
  "call.incoming", "call.dialing", "call.answered", "call.connected", "call.ended", "call.busy",
  "call.recording", "call.transcript",
  "line.status",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | "ping";

/** Espera antes de cada nova tentativa (após a 1ª, 2ª e 3ª falha). Total: 4 tentativas. */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const TIMEOUT_MS = 10_000;

export type WebhookResult = { ok: boolean; status?: number; error?: string; ms: number };

/** Entrega como vista no painel (sem o corpo). */
export type DeliveryView = Omit<WebhookDelivery, "body" | "seq">;

/**
 * Envia os eventos das linhas para o webhook configurado em cada uma.
 *
 * A fila fica no banco (WebhookDelivery): sobrevive a reinícios e serve de histórico.
 * Entrega em ordem por linha (um evento por vez), com novas tentativas; eventos que
 * esgotam as tentativas ficam como "failed" e podem ser reenviados pelo painel/API.
 *
 * Corpo: { id, event, timestamp, line: { id, name, phone }, data }
 * Assinatura (quando há segredo):
 *   X-Webhook-Signature: sha256=HMAC_SHA256(segredo, `${X-Webhook-Timestamp}.${corpo}`) em hex
 */
export class WebhookDispatcher {
  readonly #lastStatus = new Map<string, string>();
  readonly #running = new Set<string>();
  /** Uma nova rodada foi pedida enquanto a linha já estava entregando. */
  readonly #again = new Set<string>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  /** Inserções em ordem por linha (o evento seguinte espera o anterior gravar). */
  readonly #inserts = new Map<string, Promise<unknown>>();

  constructor(
    private readonly lines: LineManager,
    private readonly db: PrismaClient,
    private readonly alerts: Alerts,
    private readonly publicUrl = "",
  ) {
    lines.on("event", (e: LineEvent) => this.#onEvent(e));
    lines.on("removed", (lineId: string) => {
      this.#lastStatus.delete(lineId);
      clearTimeout(this.#timers.get(lineId));
    });
  }

  /** Retoma o que ficou pendente (ex.: o gateway reiniciou no meio de uma entrega). */
  start = async (): Promise<void> => {
    // Gateway acabou de subir: o que estava esperando nova tentativa tenta já.
    await this.db.webhookDelivery.updateMany({ where: { status: "pending" }, data: { nextAttemptAt: new Date() } });
    const pending = await this.db.webhookDelivery.groupBy({ by: ["lineId"], where: { status: "pending" }, _count: { _all: true } });
    for (const p of pending) {
      log.info(`webhook da linha ${p.lineId}: retomando ${p._count._all} evento(s) pendente(s)`);
      void this.#drain(p.lineId);
    }
  };

  /** Envia um evento de teste agora (uma tentativa, fora da fila) e devolve o resultado. */
  test = async (lineId: string): Promise<WebhookResult> => {
    const line = this.lines.get(lineId);
    if (!line?.config.webhookUrl) return { ok: false, error: "Webhook não configurado", ms: 0 };
    const { body } = this.#body(line.config, "ping", { message: "Teste do webhook" }, line.wa.me);
    return this.#post(line.config, "ping", body);
  };

  /** URL para baixar a mídia de uma mensagem (exige o token da linha). */
  mediaUrl = (m: MessageView): string | undefined =>
    m.media ? `${this.publicUrl}/api/v1/messages/${encodeURIComponent(m.id)}/media` : undefined;

  /** Publica um evento qualquer (usado por outros módulos, ex.: gravação de ligação). */
  emit = (lineId: string, event: string, data: unknown): void => {
    const line = this.lines.get(lineId);
    if (!line) return;
    const cfg = line.config;
    if (!cfg.webhookUrl || (cfg.webhookEvents.length && !cfg.webhookEvents.includes(event))) return;
    this.#enqueue(cfg, event, this.#body(cfg, event, data, line.wa.me));
  };

  // ─── histórico / reenvio ────────────────────────────────────────────────

  list = async (lineId: string, opts: { status?: string; limit?: number } = {}): Promise<DeliveryView[]> => {
    const rows = await this.db.webhookDelivery.findMany({
      where: { lineId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: { seq: "desc" },
      take: Math.min(Math.max(opts.limit ?? 50, 1), 500),
      omit: { body: true, seq: true },
    });
    return rows;
  };

  summary = async (lineId: string): Promise<Record<string, number>> => {
    const rows = await this.db.webhookDelivery.groupBy({ by: ["status"], where: { lineId }, _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
  };

  /** Volta entregas para a fila. `ids` vazio = todas as que falharam. */
  retry = async (lineId: string, ids?: string[]): Promise<number> => {
    const { count } = await this.db.webhookDelivery.updateMany({
      where: { lineId, ...(ids?.length ? { id: { in: ids } } : { status: "failed" }) },
      data: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null },
    });
    if (count) void this.#drain(lineId);
    return count;
  };

  /** Apaga o histórico antigo (chamado pela manutenção periódica). */
  prune = async (): Promise<void> => {
    const day = 86_400_000;
    const { count: a } = await this.db.webhookDelivery.deleteMany({ where: { status: "delivered", createdAt: { lt: new Date(Date.now() - 7 * day) } } });
    const { count: b } = await this.db.webhookDelivery.deleteMany({ where: { status: "failed", createdAt: { lt: new Date(Date.now() - 30 * day) } } });
    if (a + b) log.info(`webhook: ${a + b} entrega(s) antiga(s) removida(s) do histórico`);
  };

  // ─── eventos ────────────────────────────────────────────────────────────

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
      case "message-update":
        event = e.message.deletedAt ? "message.deleted" : "message.updated";
        data = { ...e.message, mediaUrl: e.message.deletedAt ? undefined : this.mediaUrl(e.message) };
        break;
      case "contact": event = "conversation.updated"; data = e.contact; break;
      case "call-update":
        event = e.kind === "transcript" ? "call.transcript" : "call.recording";
        data = {
          ...e.call,
          ...(e.kind === "recording" ? { recordingUrl: `${this.publicUrl}/api/v1/calls/${encodeURIComponent(e.call.id)}/recording` } : {}),
        };
        break;
      case "busy": event = "call.busy"; data = { from: e.from }; break;
      // Avisos do painel (histórico antigo e sincronização) não vão para o webhook.
      case "chat-read": case "history": case "sync": return;
      case "line": {
        // "line" também sai quando a linha é reconfigurada; só interessa a troca de status.
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
    this.emit(e.lineId, event, data);
  };

  #body = (cfg: LineConfig, event: string, data: unknown, phone?: string): { id: string; body: string } => {
    const id = randomUUID();
    const body = JSON.stringify({ id, event, timestamp: new Date().toISOString(), line: { id: cfg.id, name: cfg.name, phone }, data });
    return { id, body };
  };

  #enqueue = (cfg: LineConfig, event: string, { id, body }: { id: string; body: string }): void => {
    const lineId = cfg.id;
    const prev = this.#inserts.get(lineId) ?? Promise.resolve();
    const next = prev
      .then(() => this.db.webhookDelivery.create({ data: { id, lineId, event, body } }))
      .then(() => this.#drain(lineId))
      .catch((err) => log.error(`webhook da linha ${lineId}: falha ao enfileirar ${event}: ${err.message}`));
    this.#inserts.set(lineId, next);
  };

  // ─── entrega ────────────────────────────────────────────────────────────

  #drain = async (lineId: string): Promise<void> => {
    if (this.#running.has(lineId)) { this.#again.add(lineId); return; }
    this.#running.add(lineId);
    clearTimeout(this.#timers.get(lineId));
    try {
      for (;;) {
        this.#again.delete(lineId);
        const row = await this.db.webhookDelivery.findFirst({ where: { lineId, status: "pending" }, orderBy: { seq: "asc" } });
        if (!row) break;
        const wait = row.nextAttemptAt.getTime() - Date.now();
        if (wait > 0) {
          // Ordem por linha: os próximos esperam este (em nova tentativa).
          this.#timers.set(lineId, setTimeout(() => void this.#drain(lineId), wait));
          break;
        }
        await this.#deliver(row);
      }
    } catch (err: any) {
      log.error(`webhook da linha ${lineId}: ${err.message}`);
      this.#timers.set(lineId, setTimeout(() => void this.#drain(lineId), 10_000));
    } finally {
      this.#running.delete(lineId);
    }
    if (this.#again.has(lineId)) void this.#drain(lineId);
  };

  #deliver = async (row: WebhookDelivery): Promise<void> => {
    // Lê a configuração na hora: se o webhook mudou, vale o atual.
    const line = this.lines.get(row.lineId);
    const cfg = line?.config;
    if (!cfg?.webhookUrl) {
      await this.db.webhookDelivery.update({ where: { id: row.id }, data: { status: "failed", lastError: "Webhook desativado" } });
      return;
    }
    const r = await this.#post(cfg, row.event, row.body);
    const attempts = row.attempts + 1;
    if (r.ok) {
      await this.db.webhookDelivery.update({
        where: { id: row.id },
        data: { status: "delivered", attempts, lastStatus: r.status, lastError: null, deliveredAt: new Date() },
      });
      this.alerts.reset(`webhook:${row.lineId}`);
      return;
    }
    const error = r.error ?? `HTTP ${r.status}`;
    const failed = attempts >= MAX_ATTEMPTS;
    await this.db.webhookDelivery.update({
      where: { id: row.id },
      data: {
        status: failed ? "failed" : "pending",
        attempts,
        lastStatus: r.status ?? null,
        lastError: error,
        nextAttemptAt: new Date(Date.now() + (RETRY_DELAYS_MS[attempts - 1] ?? 0)),
      },
    });
    if (failed) {
      log.warn(`webhook da linha ${row.lineId}: ${row.event} falhou após ${attempts} tentativas (${error})`);
      this.alerts.send(`webhook:${row.lineId}`, `Webhook do telefone "${cfg.name}" está falhando: ${error}. Eventos não entregues ficam em Configurações › Webhook para reenviar.`);
    }
  };

  #post = async (cfg: LineConfig, event: string, body: string): Promise<WebhookResult> => {
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
