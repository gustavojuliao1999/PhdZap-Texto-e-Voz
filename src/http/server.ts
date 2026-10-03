import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  HttpError, type CallView, type LineEvent, type LineManager, type LineRuntime,
} from "../line-manager.js";
import { log } from "../log.js";
import { newLineToken } from "../store.js";

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));
const EXAMPLES_DIR = fileURLToPath(new URL("../../examples/", import.meta.url));
const SESSION_COOKIE = "wvg_session";
const SESSION_TTL_MS = 7 * 24 * 3_600_000;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 10 * 60_000;

export type ServerOptions = { port: number; host: string; adminKey: string; secureCookies: boolean };

// ─── utilidades ──────────────────────────────────────────────────────────────

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

const readJson = async (req: http.IncomingMessage): Promise<any> => {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new HttpError(413, "Corpo muito grande");
  }
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new HttpError(400, "JSON inválido"); }
};

const sendJson = (res: http.ServerResponse, status: number, data: unknown): void => {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};

const parseCookies = (req: http.IncomingMessage): Record<string, string> =>
  Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => {
    const i = c.indexOf("=");
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }).filter(([k]) => k));

const bearer = (req: http.IncomingMessage, url: URL): string => {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : url.searchParams.get("token") ?? "";
};

const pageCache = new Map<string, string>();
const page = (name: string): string => {
  // Sem cache em dev seria melhor, mas os arquivos são pequenos: recarrega se mudar? mantém simples.
  if (!pageCache.has(name) || process.env.NODE_ENV !== "production") {
    pageCache.set(name, readFileSync(PUBLIC_DIR + name, "utf8"));
  }
  return pageCache.get(name)!;
};

const STATIC_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Visão completa de uma linha para o admin (inclui token e QR). */
const adminView = (line: LineRuntime) => ({
  ...line.config,
  status: line.publicInfo.status,
  phone: line.wa.me,
  qrSvg: line.wa.status === "qr" ? line.wa.qrSvg : undefined,
  error: line.wa.error,
  current: line.current,
});

// ─── servidor ────────────────────────────────────────────────────────────────

export const startServer = (lines: LineManager, opts: ServerOptions): http.Server => {
  const sessions = new Map<string, number>(); // sid -> expira em
  const loginFailures = new Map<string, { count: number; since: number }>();

  const isAdmin = (req: http.IncomingMessage, url: URL): boolean => {
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (sid) {
      const exp = sessions.get(sid);
      if (exp && exp > Date.now()) return true;
      if (exp) sessions.delete(sid);
    }
    const key = bearer(req, url);
    return !!key && safeEqual(key, opts.adminKey);
  };

  /** Linha autenticada pelo token + checagem de origem (se a linha restringe origens). */
  const lineFromRequest = (req: http.IncomingMessage, url: URL): LineRuntime => {
    const line = lines.byToken(bearer(req, url));
    if (!line) throw new HttpError(401, "Token da linha inválido");
    const origin = req.headers.origin;
    if (origin && line.config.allowedOrigins.length && !line.config.allowedOrigins.includes(origin)) {
      const self = `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host}`;
      if (origin !== self && origin.replace(/^http:/, "https:") !== self.replace(/^http:/, "https:")) {
        throw new HttpError(403, `Origem não permitida para esta linha: ${origin}`);
      }
    }
    return line;
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const p = url.pathname;

    // ── páginas ──
    if (method === "GET" && p === "/") {
      res.writeHead(302, { location: isAdmin(req, url) ? "/admin" : "/login" });
      return void res.end();
    }
    if (method === "GET" && p === "/login") {
      if (isAdmin(req, url)) { res.writeHead(302, { location: "/admin" }); return void res.end(); }
      return html(res, page("login.html"));
    }
    if (method === "GET" && p === "/admin") {
      if (!isAdmin(req, url)) { res.writeHead(302, { location: "/login" }); return void res.end(); }
      return html(res, page("admin.html"));
    }
    const linePage = method === "GET" && /^\/admin\/lines\/[\w-]+$/.test(p);
    if (linePage) {
      if (!isAdmin(req, url)) { res.writeHead(302, { location: "/login" }); return void res.end(); }
      if (!lines.get(p.split("/")[3])) { res.writeHead(302, { location: "/admin" }); return void res.end(); }
      return html(res, page("line.html"));
    }
    if (method === "GET" && (p === "/embed/receiver" || p === "/embed/dialer")) {
      const line = lines.byToken(url.searchParams.get("token") ?? "");
      if (!line) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        return void res.end("Token da linha inválido");
      }
      const ancestors = line.config.allowedOrigins.length ? `'self' ${line.config.allowedOrigins.join(" ")}` : "*";
      return html(res, page(p === "/embed/receiver" ? "embed-receiver.html" : "embed-dialer.html"), {
        "content-security-policy": `frame-ancestors ${ancestors}`,
      });
    }
    if (method === "GET" && p.startsWith("/static/")) {
      const name = p.slice("/static/".length);
      const ext = name.slice(name.lastIndexOf("."));
      if (!/^[\w.-]+$/.test(name) || !STATIC_TYPES[ext]) throw new HttpError(404, "Não encontrado");
      let body: string;
      try { body = readFileSync(PUBLIC_DIR + "static/" + name, "utf8"); } catch { throw new HttpError(404, "Não encontrado"); }
      res.writeHead(200, { "content-type": STATIC_TYPES[ext], "cache-control": "no-cache" });
      return void res.end(body);
    }
    // SDK JavaScript (incluído em sites de terceiros: precisa de CORS).
    const sdkFiles: Record<string, string> = { "/sdk.js": "sdk.js", "/sdk/worklet.js": "sdk-worklet.js" };
    if (method === "GET" && sdkFiles[p]) {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=300",
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      });
      return void res.end(page(sdkFiles[p]));
    }
    if (method === "GET" && p === "/sdk/exemplo.html") {
      // Exemplo HTML+CSS pronto para baixar, já com a URL do gateway e o token da linha.
      const token = url.searchParams.get("token") ?? "";
      if (!lines.byToken(token)) throw new HttpError(403, "Token da linha inválido");
      const origin = `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host}`;
      const body = readFileSync(EXAMPLES_DIR + "sdk-exemplo.html", "utf8")
        .replaceAll("GATEWAY_URL", origin)
        .replaceAll("TOKEN_DA_LINHA", token);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": 'attachment; filename="telefone-whatsapp.html"',
        "cache-control": "no-store",
      });
      return void res.end(body);
    }
    if (method === "GET" && p === "/sdk/demo") {
      if (!lines.byToken(url.searchParams.get("token") ?? "")) throw new HttpError(403, "Token da linha inválido");
      return html(res, page("sdk-demo.html"));
    }
    if (method === "GET" && p === "/health") return sendJson(res, 200, { ok: true, lines: lines.lines.length });

    // ── sessão admin ──
    if (p === "/admin/api/session") {
      if (method === "POST") {
        const ip = req.socket.remoteAddress ?? "?";
        const f = loginFailures.get(ip);
        if (f && Date.now() - f.since < LOGIN_WINDOW_MS && f.count >= LOGIN_MAX_FAILURES) {
          throw new HttpError(429, "Muitas tentativas. Aguarde alguns minutos.");
        }
        const { key } = await readJson(req);
        if (typeof key !== "string" || !safeEqual(key.trim(), opts.adminKey)) {
          const cur = f && Date.now() - f.since < LOGIN_WINDOW_MS ? f : { count: 0, since: Date.now() };
          cur.count += 1;
          loginFailures.set(ip, cur);
          await new Promise((r) => setTimeout(r, 600));
          throw new HttpError(401, "Chave de acesso inválida");
        }
        loginFailures.delete(ip);
        const sid = randomBytes(32).toString("base64url");
        sessions.set(sid, Date.now() + SESSION_TTL_MS);
        res.setHeader("set-cookie", `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${opts.secureCookies ? "; Secure" : ""}`);
        return sendJson(res, 200, { ok: true });
      }
      if (method === "DELETE") {
        const sid = parseCookies(req)[SESSION_COOKIE];
        if (sid) sessions.delete(sid);
        res.setHeader("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        return sendJson(res, 200, { ok: true });
      }
    }

    // ── API admin ──
    if (p.startsWith("/admin/api/")) {
      if (!isAdmin(req, url)) throw new HttpError(401, "Não autenticado");
      const parts = p.slice("/admin/api/".length).split("/").filter(Boolean);
      if (parts[0] === "lines" && parts.length === 1) {
        if (method === "GET") return sendJson(res, 200, lines.lines.map(adminView));
        if (method === "POST") {
          const body = await readJson(req);
          const line = lines.create(String(body.name ?? "").trim() || `Linha ${lines.lines.length + 1}`, body);
          log.info(`linha criada: ${line.config.name} (${line.config.id})`);
          return sendJson(res, 201, adminView(line));
        }
      }
      if (parts[0] === "lines" && parts.length >= 2) {
        const id = parts[1];
        const action = parts[2];
        if (!action && method === "PATCH") return sendJson(res, 200, adminView(await lines.update(id, await readJson(req))));
        if (!action && method === "DELETE") { await lines.remove(id); return sendJson(res, 200, { ok: true }); }
        if (method === "POST" && action === "rotate-token") return sendJson(res, 200, adminView(lines.rotateToken(id, newLineToken())));
        if (method === "POST" && action === "logout") { await lines.logout(id); return sendJson(res, 200, { ok: true }); }
        if (method === "POST" && action === "restart") {
          const line = lines.get(id);
          if (!line) throw new HttpError(404, "Linha não encontrada");
          await line.restart();
          return sendJson(res, 200, { ok: true });
        }
      }
      if (parts[0] === "calls" && method === "GET") return sendJson(res, 200, lines.history.slice(0, 200));
      throw new HttpError(404, "Rota não encontrada");
    }

    // ── API da linha (token da linha) ──
    if (p.startsWith("/api/v1/")) {
      const line = lineFromRequest(req, url);
      const parts = p.slice("/api/v1/".length).split("/").filter(Boolean);

      if (method === "GET" && parts[0] === "line" && parts.length === 1) return sendJson(res, 200, line.publicInfo);

      if (parts[0] === "calls" && parts.length === 1) {
        if (method === "GET") {
          return sendJson(res, 200, {
            current: line.current,
            history: lines.history.filter((c) => c.lineId === line.config.id).slice(0, 100),
          });
        }
        if (method === "POST") {
          const { to, handler, clientId, agent } = await readJson(req);
          if (typeof to !== "string" && typeof to !== "number") throw new HttpError(400, "Campo 'to' obrigatório");
          const call = await line.dial(String(to), {
            handler: handler ?? (clientId ? "browser" : undefined),
            clientId: clientId ? String(clientId) : undefined,
            agent: agent ? String(agent).slice(0, 60) : undefined,
          });
          return sendJson(res, 201, call);
        }
      }

      if (parts[0] === "calls" && parts.length === 3 && method === "POST") {
        const [, callId, action] = parts;
        const body = await readJson(req);
        if (line.current?.id !== callId) throw new HttpError(404, "Chamada não encontrada ou já encerrada");
        switch (action) {
          case "accept": {
            // Quem atende primeiro leva. Sem clientId = atendimento pela API (bot/handler).
            const clientId = body.clientId ? String(body.clientId) : `api-${randomBytes(4).toString("hex")}`;
            const agent = body.agent ? String(body.agent).slice(0, 60) : body.clientId ? undefined : "API";
            line.claim(callId, clientId, agent);
            const handler = body.handler ?? (body.clientId ? "browser" : undefined);
            try {
              await line.request({ cmd: "accept", callId, handler });
            } catch (err) {
              line.releaseClaim(callId, clientId);
              throw err;
            }
            return sendJson(res, 200, line.current);
          }
          case "reject": await line.request({ cmd: "reject", callId }); break;
          case "hangup": await line.request({ cmd: "hangup", callId }); break;
          case "clear": await line.request({ cmd: "clear", callId }); break;
          case "mute": await line.request({ cmd: "mute", callId, muted: !!body.muted }); break;
          case "play":
            if (typeof body.url !== "string") throw new HttpError(400, "Campo 'url' obrigatório");
            await line.request({ cmd: "play", callId, url: body.url });
            break;
          default: throw new HttpError(404, "Ação desconhecida");
        }
        return sendJson(res, 200, { ok: true });
      }
      throw new HttpError(404, "Rota não encontrada");
    }

    throw new HttpError(404, "Não encontrado");
  };

  const html = (res: http.ServerResponse, body: string, headers: Record<string, string> = {}): void => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...(headers["content-security-policy"] ? {} : { "x-frame-options": "DENY" }),
      ...headers,
    });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    // CORS da API da linha: autenticação é por Bearer token (sem cookies).
    if (req.url?.startsWith("/api/v1/")) {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      if (req.method === "OPTIONS") { res.writeHead(204); return void res.end(); }
    }
    handle(req, res).catch((err: any) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log.error("erro na requisição:", err);
      sendJson(res, status, { error: err?.message ?? String(err) });
    });
  });

  attachWebSockets(server, lines, isAdmin, lineFromRequest);

  server.listen(opts.port, opts.host, () => {
    const shown = opts.host === "0.0.0.0" ? "localhost" : opts.host;
    log.info(`painel: http://${shown}:${opts.port}/`);
  });
  return server;
};

// ─── WebSockets ──────────────────────────────────────────────────────────────

const attachWebSockets = (
  server: http.Server,
  lines: LineManager,
  isAdmin: (req: http.IncomingMessage, url: URL) => boolean,
  lineFromRequest: (req: http.IncomingMessage, url: URL) => LineRuntime,
): void => {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const adminClients = new Set<WebSocket>();
  const lineClients = new Map<string, Set<WebSocket>>();      // lineId -> eventos
  const mediaClients = new Map<string, Set<WebSocket>>();     // callId -> áudio

  const sendTo = (set: Iterable<WebSocket> | undefined, msg: object): void => {
    if (!set) return;
    const data = JSON.stringify(msg);
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data);
  };

  // Eventos -> clientes da linha (sem campos internos) e admin (com visão completa da linha).
  lines.on("event", (e: LineEvent) => {
    sendTo(lineClients.get(e.lineId), e);
    const line = lines.get(e.lineId);
    sendTo(adminClients, e);
    if (line) sendTo(adminClients, { type: "line-admin", line: adminView(line) });
    if (e.type === "ended") for (const ws of mediaClients.get(e.call.id) ?? []) ws.close(1000, "chamada encerrada");
  });
  lines.on("removed", (lineId: string) => {
    sendTo(adminClients, { type: "line-removed", lineId });
    for (const ws of lineClients.get(lineId) ?? []) ws.close(4001, "linha removida");
  });
  lines.on("token-rotated", (lineId: string) => {
    for (const ws of lineClients.get(lineId) ?? []) ws.close(4001, "token alterado");
    const line = lines.get(lineId);
    if (line) sendTo(adminClients, { type: "line-admin", line: adminView(line) });
  });
  lines.on("audio", (_lineId: string, callId: string, pcm: Buffer) => {
    for (const ws of mediaClients.get(callId) ?? []) if (ws.readyState === ws.OPEN) ws.send(pcm);
  });

  const add = <K>(map: Map<K, Set<WebSocket>>, key: K, ws: WebSocket): void => {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(ws);
    ws.on("close", () => { set!.delete(ws); if (!set!.size) map.delete(key); });
  };

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const fail = (status: number, msg: string): void => {
      socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    try {
      if (url.pathname === "/admin/api/events") {
        if (!isAdmin(req, url)) return fail(401, "Unauthorized");
        return wss.handleUpgrade(req, socket, head, (ws) => {
          adminClients.add(ws);
          ws.on("close", () => adminClients.delete(ws));
          ws.send(JSON.stringify({ type: "lines", lines: lines.lines.map(adminView) }));
        });
      }

      if (url.pathname === "/api/v1/events") {
        const line = lineFromRequest(req, url);
        return wss.handleUpgrade(req, socket, head, (ws) => {
          add(lineClients, line.config.id, ws);
          ws.send(JSON.stringify({ type: "hello", line: line.publicInfo }));
        });
      }

      if (url.pathname === "/api/v1/media") {
        const line = lineFromRequest(req, url);
        const callId = url.searchParams.get("call") ?? "";
        const clientId = url.searchParams.get("clientId") ?? "";
        if (!clientId) return fail(400, "Bad Request");
        let call: CallView;
        try {
          call = line.claim(callId, clientId, url.searchParams.get("agent") ?? undefined);
        } catch (err: any) {
          return fail(err?.status ?? 409, "Conflict");
        }
        return wss.handleUpgrade(req, socket, head, (ws) => {
          add(mediaClients, call.id, ws);
          ws.on("message", (data, isBinary) => {
            if (!isBinary || line.current?.id !== call.id) return;
            line.sendAudio(call.id, Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
          });
        });
      }
      fail(404, "Not Found");
    } catch (err: any) {
      fail(err instanceof HttpError ? err.status : 500, "Error");
    }
  });

  // Mantém conexões vivas atrás de proxies.
  setInterval(() => {
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.ping();
  }, 25_000).unref();
};
