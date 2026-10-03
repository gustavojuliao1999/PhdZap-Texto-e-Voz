import type { CallSession } from "../session.js";

/**
 * Um handler conduz a conversa de uma chamada já conectada.
 * É aqui que entra a IA: receba `session.on("audio")`, responda com
 * `session.sendAudio()` e use `session.clearAudio()` quando o chamador interromper.
 */
export interface CallHandler {
  readonly name: string;
  /** Chamado quando a chamada conecta (entrada ou saída). */
  start(session: CallSession): void | Promise<void>;
}
