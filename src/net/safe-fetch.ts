import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Downloads de URLs informadas por quem usa a API (mídia, áudio para tocar).
 * Bloqueia endereços internos (loopback, rede privada, link-local, metadados de
 * nuvem…) para o gateway não virar uma porta para a rede interna (SSRF).
 * ALLOW_PRIVATE_URLS=true libera (ex.: arquivos num servidor da mesma rede).
 */

export class UnsafeUrlError extends Error {}

const allowPrivate = (): boolean => process.env.ALLOW_PRIVATE_URLS === "true";

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const blockList = new net.BlockList();
for (const [addr, prefix] of V4_BLOCKED) blockList.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) {
  blockList.addSubnet(addr, prefix, "ipv6");
}

/** IP interno/reservado? (IPv4 mapeado em IPv6 e NAT64 são verificados como IPv4.) */
export const isPrivateIp = (ip: string): boolean => {
  if (net.isIPv4(ip)) return blockList.check(ip, "ipv4");
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return blockList.check(mapped[1], "ipv4");
  return blockList.check(lower, "ipv6");
};

/** `lookup` que recusa endereços internos (vale também para o DNS resolvido na hora da conexão). */
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as any)(err);
    const list = addresses as dns.LookupAddress[];
    const bad = !allowPrivate() && list.find((a) => isPrivateIp(a.address));
    if (bad) return (callback as any)(new UnsafeUrlError(`Endereço interno não permitido: ${hostname} (${bad.address})`));
    if ((options as dns.LookupOptions).all) return (callback as any)(null, list);
    (callback as any)(null, list[0].address, list[0].family);
  });
};

/** Valida a URL (protocolo e endereço) sem baixar. */
export const assertPublicUrl = async (raw: string): Promise<URL> => {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UnsafeUrlError("URL inválida"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("A URL deve começar com http:// ou https://");
  if (url.username || url.password) throw new UnsafeUrlError("URL com usuário/senha não é permitida");
  if (allowPrivate()) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ips = net.isIP(host) ? [host] : (await dns.promises.lookup(host, { all: true }).catch(() => {
    throw new UnsafeUrlError(`Não foi possível resolver ${host}`);
  })).map((a) => a.address);
  const bad = ips.find(isPrivateIp);
  if (bad) throw new UnsafeUrlError(`Endereço interno não permitido: ${host} (${bad})`);
  return url;
};

export type SafeFetchResult = { data: Buffer; contentType?: string; contentLength?: number };

/** GET com limite de tamanho e de tempo, seguindo até `maxRedirects` redirecionamentos (cada um validado). */
export const safeFetch = async (
  raw: string,
  opts: { maxBytes: number; timeoutMs?: number; maxRedirects?: number },
): Promise<SafeFetchResult> => {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const res = await get(url, opts.timeoutMs ?? 30_000);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      url = await assertPublicUrl(new URL(res.headers.location, url).toString());
      continue;
    }
    if (status < 200 || status >= 300) { res.resume(); throw new Error(`HTTP ${status}`); }
    const length = Number(res.headers["content-length"] ?? 0) || undefined;
    if (length && length > opts.maxBytes) { res.destroy(); throw new RangeError("Arquivo grande demais"); }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res) {
      size += (chunk as Buffer).length;
      if (size > opts.maxBytes) { res.destroy(); throw new RangeError("Arquivo grande demais"); }
      chunks.push(chunk as Buffer);
    }
    return { data: Buffer.concat(chunks), contentType: res.headers["content-type"], contentLength: length };
  }
  throw new Error("Redirecionamentos demais");
};

const get = (url: URL, timeoutMs: number): Promise<http.IncomingMessage> =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.get(url, { lookup: safeLookup, timeout: timeoutMs, headers: { "user-agent": "whatsapp-voice-gateway" } }, resolve);
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado")));
    req.on("error", reject);
  });
