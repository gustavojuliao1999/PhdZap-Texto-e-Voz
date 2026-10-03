import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import QRCode from "qrcode";
import type { VoipClient } from "baileys-caller";
import { log } from "./log.js";

export type WhatsAppStatus = "connecting" | "qr" | "open" | "error";

export type WhatsAppState = {
  status: WhatsAppStatus;
  /** QR de pareamento em SVG (quando status = "qr"). */
  qrSvg?: string;
  /** Número conectado (dígitos). */
  me?: string;
  error?: string;
};

const RETRY_DELAY_MS = 3000;

/**
 * Mantém a conexão do WhatsApp e expõe o estado (incluindo o QR) para o painel.
 * Emite `state` (WhatsAppState) a cada mudança.
 */
export class WhatsAppConnection extends EventEmitter {
  #state: WhatsAppState = { status: "connecting" };
  #loggingOut = false;

  constructor(private readonly client: VoipClient, private readonly authDir: string) {
    super();
    client.on("qr", (qr: string) => {
      QRCode.toString(qr, { type: "svg", margin: 1, errorCorrectionLevel: "L" })
        .then((svg) => this.#set({ status: "qr", qrSvg: svg }))
        .catch((err) => log.error("falha ao gerar QR:", err));
    });
  }

  get state(): WhatsAppState { return this.#state; }
  get isOpen(): boolean { return this.#state.status === "open"; }

  /** Conecta, tentando de novo até abrir. Resolve quando conectado. */
  start = async (): Promise<void> => {
    for (;;) {
      this.#set({ status: "connecting" });
      try {
        await this.client.connect();
        const me = this.client.selfJid?.split("@")[0].split(":")[0];
        this.#set({ status: "open", me });
        log.info(`WhatsApp conectado${me ? ` como ${me}` : ""}`);
        return;
      } catch (err: any) {
        if (this.#loggingOut) return; // logout em andamento: o processo vai reiniciar
        const code = err?.output?.statusCode;
        const msg = err?.message ?? String(err);
        if (code === 401) {
          // Sessão desconectada pelo celular: guarda a antiga e gera um QR novo.
          const backup = this.#archiveAuthDir();
          log.warn(`sessão do WhatsApp desconectada${backup ? ` (antiga movida para ${backup})` : ""}; gerando novo QR`);
          this.#set({ status: "connecting", error: "Sessão desconectada. Escaneie o QR novamente." });
        } else {
          log.warn(`falha ao conectar ao WhatsApp${code ? ` (código ${code})` : ""}: ${msg}; tentando de novo`);
          this.#set({ status: "error", error: msg });
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  };

  /**
   * Desvincula o aparelho (some de "Aparelhos conectados" no celular) e apaga a
   * sessão local. Depois disso é preciso reiniciar o processo para parear de novo.
   */
  logout = async (): Promise<void> => {
    log.info("desconectando o WhatsApp...");
    this.#loggingOut = true;
    try {
      await this.client.logout();
    } catch (err: any) {
      log.warn("logout no servidor do WhatsApp falhou (remova o aparelho pelo celular se ainda aparecer):", err?.message ?? err);
    }
    rmSync(this.authDir, { recursive: true, force: true });
    this.#set({ status: "connecting", error: "WhatsApp desconectado. Reiniciando para gerar um novo QR…" });
  };

  #archiveAuthDir = (): string | null => {
    if (!existsSync(this.authDir) || readdirSync(this.authDir).length === 0) return null;
    const backup = `${this.authDir.replace(/\/+$/, "")}.desconectado-${Date.now()}`;
    renameSync(this.authDir, backup);
    return backup;
  };

  #set = (state: WhatsAppState): void => {
    this.#state = state;
    this.emit("state", state);
  };
}
