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
  /** URL que recebe os eventos (POST JSON). Vazio = desligado. */
  webhookUrl: string;
  /** Segredo da assinatura HMAC-SHA256 do webhook. */
  webhookSecret: string;
  /** Eventos enviados ao webhook (vazio = todos). */
  webhookEvents: string[];
};

export type MessageType =
  | "text" | "image" | "video" | "audio" | "document" | "sticker" | "location" | "contact" | "reaction" | "other";
export type MessageStatus = "error" | "pending" | "sent" | "delivered" | "read" | "played";

/** Mensagem como o worker a entrega (sem o JSON bruto do WhatsApp). */
export type MessageRecord = {
  /** Id da mensagem no WhatsApp. */
  id: string;
  direction: "incoming" | "outgoing";
  /** Número (dígitos) do contato quando conhecido, senão o JID. */
  remote: string;
  remoteJid: string;
  pushName?: string;
  type: MessageType;
  /** Texto, legenda da mídia ou emoji da reação. */
  text?: string;
  media?: { mimetype?: string; fileName?: string; size?: number; seconds?: number; ptt?: boolean };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contact?: { name?: string; vcard?: string };
  /** Id da mensagem respondida (ou reagida). */
  replyTo?: string;
  status: MessageStatus;
  timestamp: string;
};

/** Conteúdo a enviar. */
export type OutgoingContent =
  | { type: "text"; text: string }
  | {
      type: "image" | "video" | "audio" | "document" | "sticker";
      data: Uint8Array;
      mimetype: string;
      fileName?: string;
      caption?: string;
      /** Áudio de voz (já em ogg/opus). */
      ptt?: boolean;
      seconds?: number;
    }
  | { type: "location"; latitude: number; longitude: number; name?: string; address?: string }
  /** Reação à mensagem citada (`quotedRaw`); texto vazio remove a reação. */
  | { type: "reaction"; text: string };

export type GatewayEvent =
  | { type: "incoming"; call: CallRecord }
  | { type: "busy"; from: string; callId: string }
  | { type: "connected"; call: CallRecord }
  | { type: "ended"; call: CallRecord }
  /** `raw`: mensagem do WhatsApp serializada (para baixar mídia e responder). */
  | { type: "message"; message: MessageRecord; raw: string }
  | { type: "message-status"; id: string; remoteJid: string; status: MessageStatus };

export type WorkerCommand =
  | { cmd: "dial"; to: string; handler?: string }
  | { cmd: "accept"; callId: string; handler?: string }
  | { cmd: "reject"; callId: string }
  | { cmd: "hangup"; callId: string }
  | { cmd: "mute"; callId: string; muted: boolean }
  | { cmd: "clear"; callId: string }
  | { cmd: "play"; callId: string; url: string }
  | { cmd: "configure"; config: LineConfig }
  | { cmd: "send-message"; to: string; content: OutgoingContent; quotedRaw?: string }
  | { cmd: "download-media"; raw: string }
  | { cmd: "mark-read"; raws: string[] }
  | { cmd: "profile-picture"; jid: string }
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
