import type { Alerts } from "./alerts.js";
import type { LineManager } from "./line-manager.js";

/** Tempo fora do ar antes de alertar (quedas rápidas se resolvem sozinhas). */
const DOWN_ALERT_AFTER_MS = 2 * 60_000;
const STATUS_TEXT: Record<string, string> = {
  qr: "precisa ler o QR de novo", connecting: "tentando conectar", error: "com erro", stopped: "parado",
};

/** Alerta quando um telefone que estava conectado fica fora do ar, e quando volta. */
export const watchLines = (lines: LineManager, alerts: Alerts): void => {
  const downSince = new Map<string, number>();
  const alerted = new Set<string>();
  const seenOpen = new Set<string>();

  const check = (): void => {
    for (const line of lines.lines) {
      const id = line.config.id;
      const status = line.publicInfo.status;
      if (status === "open") {
        seenOpen.add(id);
        downSince.delete(id);
        if (alerted.delete(id)) {
          alerts.reset(`line:${id}`);
          alerts.send(`line-up:${id}`, `Telefone "${line.config.name}" conectado de novo.`, "info");
        }
        continue;
      }
      // Só alerta telefones que já estiveram conectados (um recém-criado esperando QR não é queda).
      if (!seenOpen.has(id)) continue;
      const since = downSince.get(id) ?? Date.now();
      downSince.set(id, since);
      if (!alerted.has(id) && (status === "qr" || Date.now() - since >= DOWN_ALERT_AFTER_MS)) {
        alerted.add(id);
        alerts.reset(`line-up:${id}`);
        alerts.send(`line:${id}`, `Telefone "${line.config.name}" fora do ar: ${STATUS_TEXT[status] ?? status}${line.wa.error ? ` (${line.wa.error})` : ""}.`);
      }
    }
    for (const id of [...seenOpen]) if (!lines.get(id)) { seenOpen.delete(id); downSince.delete(id); alerted.delete(id); }
  };

  lines.on("wa", check);
  lines.on("crashed", (lineId: string, detail: string) => {
    const line = lines.get(lineId);
    alerts.send(`crash:${lineId}`, `O processo do telefone "${line?.config.name ?? lineId}" caiu (${detail}) e está sendo reiniciado.`);
  });
  setInterval(check, 30_000).unref();
};
