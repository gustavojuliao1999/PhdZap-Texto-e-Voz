import { spawn } from "node:child_process";

/**
 * Converte qualquer áudio suportado pelo ffmpeg em áudio de voz do WhatsApp
 * (ogg/opus mono 48 kHz). Retorna também a duração, que o WhatsApp mostra.
 */
export const toVoiceNote = (input: Uint8Array): Promise<{ data: Buffer; seconds: number }> =>
  new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-vn", "-ac", "1", "-ar", "48000",
      "-c:a", "libopus", "-b:a", "32k", "-application", "voip",
      "-f", "ogg", "pipe:1",
    ]);
    const out: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => out.push(d));
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", (err) => reject(new Error(`ffmpeg indisponível: ${err.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`não foi possível converter o áudio: ${stderr.trim() || `ffmpeg saiu com código ${code}`}`));
      const data = Buffer.concat(out);
      resolve({ data, seconds: oggSeconds(data) });
    });
    // O ffmpeg pode fechar a entrada antes do fim (arquivo inválido): o erro real vem no close.
    proc.stdin.on("error", () => {});
    proc.stdin.end(input);
  });

/** Duração de um ogg/opus pela granule position da última página (48 kHz). */
const oggSeconds = (ogg: Buffer): number => {
  const last = ogg.lastIndexOf("OggS");
  if (last < 0 || last + 14 > ogg.length) return 0;
  return Math.max(1, Math.round(Number(ogg.readBigUInt64LE(last + 6)) / 48000));
};
