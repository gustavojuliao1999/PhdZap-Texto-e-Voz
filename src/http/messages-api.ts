import path from "node:path";
import { toVoiceNote } from "../audio/voice-note.js";
import { HttpError } from "../line-manager.js";
import type { OutgoingContent } from "../worker/protocol.js";

/** Tamanho máximo de um arquivo enviado (URL ou base64). */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
/** Corpo JSON de envio de mensagem (base64 ocupa ~4/3 do arquivo). */
export const MAX_MESSAGE_BODY_BYTES = Math.ceil(MAX_MEDIA_BYTES * 1.4) + 64 * 1024;

const MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".3gp": "video/3gpp", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".aac": "audio/aac",
  ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".zip": "application/zip",
  ".doc": "application/msword", ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const typeFromMime = (mime: string): MediaType =>
  mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "document";

const str = (v: unknown, max: number, field: string): string | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new HttpError(400, `Campo '${field}' deve ser texto`);
  if (v.length > max) throw new HttpError(400, `Campo '${field}' muito longo (máx. ${max})`);
  return v;
};

const download = async (url: string): Promise<{ data: Uint8Array; mimetype?: string }> => {
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, "Campo 'url' deve começar com http:// ou https://");
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (err: any) {
    throw new HttpError(400, `Não foi possível baixar a mídia: ${err?.cause?.message ?? err?.message ?? err}`);
  }
  if (!res.ok) throw new HttpError(400, `Não foi possível baixar a mídia: HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_MEDIA_BYTES) throw new HttpError(413, "Mídia muito grande (máx. 25 MB)");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_MEDIA_BYTES) throw new HttpError(413, "Mídia muito grande (máx. 25 MB)");
    chunks.push(chunk);
  }
  const mimetype = res.headers.get("content-type")?.split(";")[0].trim();
  return { data: Buffer.concat(chunks), mimetype: mimetype && mimetype !== "application/octet-stream" ? mimetype : undefined };
};

const decodeBase64 = (b64: string): { data: Uint8Array; mimetype?: string } => {
  const m = /^data:([^;,]+)?(?:;[^,]*)?,(.*)$/s.exec(b64);
  const data = Buffer.from(m ? m[2] : b64, "base64");
  if (!data.length) throw new HttpError(400, "Campo 'base64' vazio ou inválido");
  if (data.length > MAX_MEDIA_BYTES) throw new HttpError(413, "Mídia muito grande (máx. 25 MB)");
  return { data, mimetype: m?.[1] };
};

/**
 * Monta o conteúdo a partir do corpo da API:
 *   { text }
 *   { type: image|video|audio|document|sticker, url | base64, mimetype?, fileName?, caption?, ptt? }
 *   { type: "location", latitude, longitude, name?, address? }
 * Áudio sai como áudio de voz (ptt) por padrão, convertido para ogg/opus.
 */
export const parseOutgoing = async (b: any): Promise<OutgoingContent> => {
  const type = b.type ?? (b.url || b.base64 ? undefined : "text");

  if (type === "text") {
    const text = str(b.text, 65_536, "text");
    if (!text?.trim()) throw new HttpError(400, "Campo 'text' obrigatório");
    return { type: "text", text };
  }

  if (type === "reaction") {
    const text = str(b.text ?? b.emoji ?? "", 32, "text") ?? "";
    return { type: "reaction", text };
  }

  if (type === "location") {
    const latitude = Number(b.latitude), longitude = Number(b.longitude);
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
      throw new HttpError(400, "Campos 'latitude' e 'longitude' obrigatórios");
    }
    return { type: "location", latitude, longitude, name: str(b.name, 200, "name"), address: str(b.address, 500, "address") };
  }

  if (type !== undefined && !MEDIA_TYPES.includes(type)) {
    throw new HttpError(400, `Campo 'type': use text, location, reaction ou ${MEDIA_TYPES.join(", ")}`);
  }
  const url = str(b.url, 4096, "url");
  const base64 = typeof b.base64 === "string" ? b.base64 : undefined;
  if (!url === !base64) throw new HttpError(400, "Envie a mídia em 'url' ou em 'base64' (um dos dois)");
  const file = url ? await download(url) : decodeBase64(base64!);

  let fileName = str(b.fileName, 255, "fileName");
  if (!fileName && url) fileName = decodeURIComponent(path.basename(new URL(url).pathname)) || undefined;
  const ext = fileName ? path.extname(fileName).toLowerCase() : "";
  const mimetype = str(b.mimetype, 200, "mimetype") ?? file.mimetype ?? EXT_MIME[ext] ?? "application/octet-stream";
  const mediaType: MediaType = type ?? typeFromMime(mimetype);
  const caption = str(b.caption ?? b.text, 4096, "caption");

  if (mediaType === "audio" && b.ptt !== false) {
    const voice = await toVoiceNote(file.data).catch((err) => { throw new HttpError(400, err.message); });
    return { type: "audio", data: voice.data, mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: voice.seconds };
  }
  if (mediaType === "sticker" && mimetype !== "image/webp") throw new HttpError(400, "Figurinha deve ser image/webp");
  return { type: mediaType, data: file.data, mimetype, fileName, caption };
};
