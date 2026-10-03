import type { CallPolicy } from "../call-manager.js";
import type { CallRecord } from "../session.js";
import type { WhatsAppState } from "../whatsapp.js";

export const HANDLER_NAMES = ["browser", "echo", "silence", "ws-bridge"] as const;
export type HandlerName = (typeof HANDLER_NAMES)[number];

/** Configuração de uma linha (telefone), persistida em data/lines.json. */
export type LineConfig = CallPolicy & {
  id: string;
  name: string;
  token: string;
  createdAt: string;
  /** Handler das chamadas atendidas automaticamente / feitas pela API sem handler. */
  handler: HandlerName;
  bridgeUrl: string;
  bridgeSampleRate: number;
  /** Origens que podem incorporar os iframes desta linha (vazio = qualquer). */
  allowedOrigins: string[];
};

export type GatewayEvent =
  | { type: "incoming"; call: CallRecord }
  | { type: "busy"; from: string; callId: string }
  | { type: "connected"; call: CallRecord }
  | { type: "ended"; call: CallRecord };

export type WorkerCommand =
  | { cmd: "dial"; to: string; handler?: string }
  | { cmd: "accept"; callId: string; handler?: string }
  | { cmd: "reject"; callId: string }
  | { cmd: "hangup"; callId: string }
  | { cmd: "mute"; callId: string; muted: boolean }
  | { cmd: "clear"; callId: string }
  | { cmd: "play"; callId: string; url: string }
  | { cmd: "configure"; config: LineConfig }
  | { cmd: "logout" };

/** Principal -> worker */
export type ParentMessage =
  | ({ t: "req"; reqId: number } & WorkerCommand)
  | { t: "audio"; callId: string; pcm: Uint8Array };

/** Worker -> principal */
export type WorkerMessage =
  | { t: "res"; reqId: number; ok: true; data?: unknown }
  | { t: "res"; reqId: number; ok: false; error: string }
  | { t: "wa"; state: WhatsAppState }
  | { t: "event"; event: GatewayEvent }
  /** Áudio do outro lado (PCM16 16 kHz mono) para chamadas atendidas pelo navegador. */
  | { t: "audio"; callId: string; pcm: Uint8Array };

/** Código de saída que pede ao principal para reiniciar o worker (após logout). */
export { RESTART_EXIT_CODE } from "../restart.js";
