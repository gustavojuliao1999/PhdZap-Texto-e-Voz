import { HttpError } from "./line-manager.js";

const dayKey = (): string => new Date().toDateString();

/**
 * Limite de mensagens enviadas pelo gateway por linha (por minuto e por dia).
 * Protege o número de banimento por envio em massa. O contador do dia começa do
 * banco (sobrevive a reinícios); o do minuto fica em memória.
 */
export class SendLimiter {
  readonly #minute = new Map<string, number[]>();
  readonly #day = new Map<string, { day: string; count: number }>();

  constructor(private readonly countToday: (lineId: string) => Promise<number>) {}

  take = async (lineId: string, perMinute: number, perDay: number): Promise<void> => {
    let day = this.#day.get(lineId);
    if (perDay > 0 && (!day || day.day !== dayKey())) {
      day = { day: dayKey(), count: await this.countToday(lineId) };
      this.#day.set(lineId, day);
    }
    // Daqui em diante é síncrono: duas requisições ao mesmo tempo não passam juntas do limite.
    const now = Date.now();
    const recent = (this.#minute.get(lineId) ?? []).filter((t) => t > now - 60_000);
    if (perMinute > 0 && recent.length >= perMinute) {
      const wait = Math.ceil((recent[0] + 60_000 - now) / 1000);
      throw new HttpError(429, `Limite de ${perMinute} mensagens por minuto atingido nesta linha. Tente de novo em ${wait}s.`);
    }
    if (perDay > 0 && day && day.count >= perDay) {
      throw new HttpError(429, `Limite de ${perDay} mensagens por dia atingido nesta linha.`);
    }
    recent.push(now);
    this.#minute.set(lineId, recent);
    if (day) day.count++;
  };
}
