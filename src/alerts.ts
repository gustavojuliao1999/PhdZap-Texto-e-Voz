import { log } from "./log.js";

/** Não repete o mesmo alerta (mesma chave) antes disso. */
const REPEAT_AFTER_MS = 10 * 60_000;

/**
 * Alertas operacionais (telefone caiu, webhook falhando, linha travando).
 * Sempre vão para o log; com ALERT_WEBHOOK_URL também são enviados como POST JSON
 * `{ text, content, level, key, timestamp }` — formato aceito por Slack e Discord.
 */
export class Alerts {
  readonly #lastSent = new Map<string, number>();

  constructor(private readonly url = "") {}

  send = (key: string, text: string, level: "warn" | "info" = "warn"): void => {
    const last = this.#lastSent.get(key) ?? 0;
    if (Date.now() - last < REPEAT_AFTER_MS) return;
    this.#lastSent.set(key, Date.now());
    (level === "warn" ? log.warn : log.info)(`ALERTA: ${text}`);
    if (!this.url) return;
    const body = JSON.stringify({ text, content: text, level, key, timestamp: new Date().toISOString() });
    fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000) })
      .then((r) => { if (!r.ok) log.warn(`envio de alerta respondeu HTTP ${r.status}`); })
      .catch((err) => log.warn(`falha ao enviar alerta: ${err?.cause?.message ?? err?.message ?? err}`));
  };

  /** Esquece a chave: o próximo alerta igual sai na hora (ex.: telefone voltou). */
  reset = (key: string): void => { this.#lastSent.delete(key); };
}
