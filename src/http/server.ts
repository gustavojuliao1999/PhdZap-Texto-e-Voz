import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { WebSocketServer, type WebSocket } from "ws";
import { clientIp, makeAudit } from "../audit.js";
import { verifyPassword } from "../auth/passwords.js";
import {
  PERMISSION_LABELS, PERMISSIONS, can, displayName, isAdmin, isAttendantOnly, permissionsOn,
  type Permission, type Principal,
} from "../auth/permissions.js";
import type { Sessions } from "../auth/sessions.js";
import {
  HttpError, type CallView, type LineEvent, type LineManager, type LineRuntime,
} from "../line-manager.js";
import { log } from "../log.js";
import { newLineToken, type Store } from "../store.js";
import type { WebhookDispatcher } from "../webhooks.js";
import type { Attendance } from "../attendance.js";
import { assertPublicUrl } from "../net/safe-fetch.js";
import { transcriptionConfigured } from "../transcribe.js";
import { computeMetrics } from "../metrics.js";
import { docPage } from "./docs.js";
import { MAX_MESSAGE_BODY_BYTES, parseOutgoing } from "./messages-api.js";
import { handleUsersApi } from "./users-api.js";

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));
const EXAMPLES_DIR = fileURLToPath(new URL("../../examples/", import.meta.url));
const SESSION_COOKIE = "wvg_session";
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 10 * 60_000;

export type ServerDeps = {
  lines: LineManager;
  store: Store;
  webhooks: WebhookDispatcher;
  attendance: Attendance;
  db: PrismaClient;
  sessions: Sessions;
  port: number;
  host: string;
  adminKey: string;
  secureCookies: boolean;
};

// ─── utilidades ──────────────────────────────────────────────────────────────

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

const readJson = async (req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<any> => {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxBytes) throw new HttpError(413, "Corpo muito grande");
  }
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new HttpError(400, "JSON inválido"); }
};

const sendJson = (res: http.ServerResponse, status: number, data: unknown): void => {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};

/** Envia um arquivo com suporte a Range (players de áudio precisam para avançar/voltar). */
const sendFile = async (req: http.IncomingMessage, res: http.ServerResponse, file: string, type: string, name: string): Promise<void> => {
  let size: number;
  try { size = (await stat(file)).size; } catch { throw new HttpError(404, "Arquivo não encontrado"); }
  const headers: Record<string, string | number> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    "cache-control": "private, max-age=86400",
    "x-content-type-options": "nosniff",
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return void res.end();
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "content-length": size });
  createReadStream(file).pipe(res);
};

const redirect = (res: http.ServerResponse, location: string): void => {
  res.writeHead(302, { location });
  res.end();
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

const requirePerm = (p: Principal, lineId: string, perm: Permission): void => {
  if (!can(p, lineId, perm)) throw new HttpError(403, `Sem permissão: ${PERMISSION_LABELS[perm]}`);
};

const requireAdmin = (p: Principal): void => {
  if (!isAdmin(p)) throw new HttpError(403, "Apenas administradores");
};

/** Visão de uma linha para o painel, conforme as permissões de quem pede. */
const lineView = (line: LineRuntime, p: Principal) => {
  const perms = permissionsOn(p, line.config.id);
  const c = line.config;
  return {
    id: c.id,
    name: c.name,
    createdAt: c.createdAt,
    inboundMode: c.inboundMode,
    handler: c.handler,
    allowedOrigins: c.allowedOrigins,
    status: line.publicInfo.status,
    phone: line.wa.me,
    error: line.wa.error,
    current: line.current,
    permissions: perms,
    qrSvg: perms.includes("connection") && line.wa.status === "qr" ? line.wa.qrSvg : undefined,
    token: perms.includes("integrations") ? c.token : undefined,
    ...(perms.includes("settings") ? {
      inboundAnswerDelayMs: c.inboundAnswerDelayMs,
      maxCallDurationMs: c.maxCallDurationMs,
      bridgeUrl: c.bridgeUrl,
      bridgeSampleRate: c.bridgeSampleRate,
      webhookUrl: c.webhookUrl,
      webhookSecret: c.webhookSecret,
      webhookEvents: c.webhookEvents,
      rateLimitPerMinute: c.rateLimitPerMinute,
      rateLimitPerDay: c.rateLimitPerDay,
      businessHoursEnabled: c.businessHoursEnabled,
      businessHours: c.businessHours,
      offHoursMessage: c.offHoursMessage,
      groupsEnabled: c.groupsEnabled,
      recordCalls: c.recordCalls,
      transcribeCalls: c.transcribeCalls,
      transcribeVoiceNotes: c.transcribeVoiceNotes,
    } : {}),
  };
};

// ─── servidor ────────────────────────────────────────────────────────────────

export const startServer = (deps: ServerDeps): http.Server => {
  const { lines, store, db, sessions, webhooks, attendance } = deps;
  const audit = makeAudit(db);
  const loginFailures = new Map<string, { count: number; since: number }>();

  /** Quem está logado no painel (cookie) ou o super admin via `Authorization: Bearer <chave>`. */
  const panelPrincipal = async (req: http.IncomingMessage, url: URL): Promise<Principal | null> => {
    const fromCookie = await sessions.resolve(parseCookies(req)[SESSION_COOKIE]);
    if (fromCookie) return fromCookie;
    const key = bearer(req, url);
    return key && safeEqual(key, deps.adminKey) ? { kind: "super", name: "Super admin" } : null;
  };

  /**
   * Autenticação da API da linha (/api/v1, iframes, SDK):
   *   - token da linha (Bearer ou ?token=), com checagem de origem; ou
   *   - sessão do painel + linha em `?line=` / header `x-line-id`.
   */
  const lineAuth = async (req: http.IncomingMessage, url: URL): Promise<{ line: LineRuntime; principal: Principal }> => {
    const token = bearer(req, url);
    if (token) {
      const line = lines.byToken(token);
      if (!line) throw new HttpError(401, "Token da linha inválido");
      const origin = req.headers.origin;
      if (origin && line.config.allowedOrigins.length && !line.config.allowedOrigins.includes(origin)) {
        const self = `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host}`;
        if (origin !== self && origin.replace(/^http:/, "https:") !== self.replace(/^http:/, "https:")) {
          throw new HttpError(403, `Origem não permitida para esta linha: ${origin}`);
        }
      }
      return { line, principal: { kind: "token", lineId: line.config.id } };
    }
    const principal = await sessions.resolve(parseCookies(req)[SESSION_COOKIE]);
    if (!principal) throw new HttpError(401, "Não autenticado");
    const lineId = url.searchParams.get("line") ?? String(req.headers["x-line-id"] ?? "");
    const line = lines.get(lineId);
    if (!line) throw new HttpError(404, "Linha não encontrada");
    requirePerm(principal, lineId, "view");
    return { line, principal };
  };

  /** Nome do atendente: usuários do painel usam o próprio nome; token/super podem informar. */
  const agentFor = (p: Principal, requested: unknown): string | undefined => {
    if (p.kind === "user") return p.name;
    const a = typeof requested === "string" ? requested.trim().slice(0, 60) : "";
    return a || (p.kind === "super" ? "Super admin" : undefined);
  };

  const html = (res: http.ServerResponse, body: string, headers: Record<string, string> = {}): void => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...(headers["content-security-policy"] ? {} : { "x-frame-options": "DENY" }),
      ...(deps.secureCookies ? { "strict-transport-security": "max-age=31536000" } : {}),
      ...headers,
    });
    res.end(body);
  };

  let notifyPermissionsChanged = (): void => {};

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const p = url.pathname;

    // ── páginas ──
    // Quem só atende vai para /atendimento; quem administra, para o painel.
    const home = (me: Principal) => (isAttendantOnly(me) ? "/atendimento" : "/admin");
    if (method === "GET" && p === "/") {
      const me = await panelPrincipal(req, url);
      return redirect(res, me ? home(me) : "/login");
    }
    if (method === "GET" && p === "/login") {
      const me = await panelPrincipal(req, url);
      if (me) return redirect(res, home(me));
      return html(res, page("login.html"));
    }
    if (method === "GET" && p === "/admin") {
      const me = await panelPrincipal(req, url);
      if (!me) return redirect(res, "/login");
      if (isAttendantOnly(me)) return redirect(res, "/atendimento");
      return html(res, page("admin.html"));
    }
    if (method === "GET" && p === "/atendimento") {
      if (!(await panelPrincipal(req, url))) return redirect(res, "/login");
      return html(res, page("atendimento.html"));
    }
    if (method === "GET" && p === "/admin/metrics") {
      if (!(await panelPrincipal(req, url))) return redirect(res, "/login");
      return html(res, page("metrics.html"));
    }
    if (method === "GET" && p === "/admin/audit") {
      const me = await panelPrincipal(req, url);
      if (!me) return redirect(res, "/login");
      if (!isAdmin(me)) return redirect(res, "/admin");
      return html(res, page("audit.html"));
    }
    if (method === "GET" && p === "/admin/users") {
      const me = await panelPrincipal(req, url);
      if (!me) return redirect(res, "/login");
      if (!isAdmin(me)) return redirect(res, "/admin");
      return html(res, page("users.html"));
    }
    if (method === "GET" && /^\/admin\/lines\/[\w-]+$/.test(p)) {
      const me = await panelPrincipal(req, url);
      if (!me) return redirect(res, "/login");
      const lineId = p.split("/")[3];
      if (!lines.get(lineId) || !can(me, lineId, "view")) return redirect(res, "/admin");
      return html(res, page("line.html"));
    }
    if (method === "GET" && (p === "/embed/receiver" || p === "/embed/dialer")) {
      const file = p === "/embed/receiver" ? "embed-receiver.html" : "embed-dialer.html";
      const needed: Permission = p === "/embed/receiver" ? "receive" : "dial";
      const token = url.searchParams.get("token");
      if (token) {
        const line = lines.byToken(token);
        if (!line) return void res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Token da linha inválido");
        const ancestors = line.config.allowedOrigins.length ? `'self' ${line.config.allowedOrigins.join(" ")}` : "*";
        return html(res, page(file), { "content-security-policy": `frame-ancestors ${ancestors}` });
      }
      // Modo painel (?line=): exige login e permissão; só pode ser incorporado no próprio gateway.
      const me = await sessions.resolve(parseCookies(req)[SESSION_COOKIE]);
      const lineId = url.searchParams.get("line") ?? "";
      if (!me || !lines.get(lineId) || !can(me, lineId, needed)) {
        return void res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Sem permissão para este telefone");
      }
      return html(res, page(file), { "content-security-policy": "frame-ancestors 'self'" });
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

    // ── SDK JavaScript (incluído em sites de terceiros: precisa de CORS) ──
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
    // ── documentação pública (sem login) ──
    if (method === "GET" && (p === "/docs" || p === "/docs/")) return redirect(res, "/docs/api");
    if (method === "GET" && p.startsWith("/docs/")) {
      const origin = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "")
        || `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host}`;
      const body = docPage(p.slice("/docs/".length), origin);
      if (!body) throw new HttpError(404, "Página não encontrada");
      return html(res, body);
    }
    if (method === "GET" && p === "/health") {
      await db.$queryRaw`SELECT 1`;
      return sendJson(res, 200, { ok: true, lines: lines.lines.length });
    }

    // ── sessão do painel ──
    if (p === "/admin/api/session") {
      if (method === "POST") {
        const ip = clientIp(req);
        const f = loginFailures.get(ip);
        if (f && Date.now() - f.since < LOGIN_WINDOW_MS && f.count >= LOGIN_MAX_FAILURES) {
          throw new HttpError(429, "Muitas tentativas. Aguarde alguns minutos.");
        }
        const b = await readJson(req);
        let token: string | null = null;
        if (typeof b.key === "string") {
          if (safeEqual(b.key.trim(), deps.adminKey)) token = await sessions.create({ super: true });
        } else if (typeof b.username === "string" && typeof b.password === "string") {
          const user = await db.user.findUnique({ where: { username: b.username.trim().toLowerCase() } });
          if (user?.active && (await verifyPassword(b.password, user.passwordHash))) {
            token = await sessions.create({ userId: user.id });
            await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
          }
        }
        const who = typeof b.key === "string" ? "chave de acesso" : String(b.username ?? "").slice(0, 60);
        if (!token) {
          audit({ kind: "anonymous", name: who }, req, "session.login-failed");
          const cur = f && Date.now() - f.since < LOGIN_WINDOW_MS ? f : { count: 0, since: Date.now() };
          cur.count += 1;
          loginFailures.set(ip, cur);
          await new Promise((r) => setTimeout(r, 600));
          throw new HttpError(401, typeof b.key === "string" ? "Chave de acesso inválida" : "Usuário ou senha inválidos");
        }
        loginFailures.delete(ip);
        audit(await sessions.resolve(token), req, "session.login");
        res.setHeader("set-cookie",
          `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessions.ttlSeconds}${deps.secureCookies ? "; Secure" : ""}`);
        return sendJson(res, 200, { ok: true });
      }
      if (method === "DELETE") {
        audit(await sessions.resolve(parseCookies(req)[SESSION_COOKIE]), req, "session.logout");
        await sessions.destroy(parseCookies(req)[SESSION_COOKIE]);
        res.setHeader("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        return sendJson(res, 200, { ok: true });
      }
    }

    // ── API do painel ──
    if (p.startsWith("/admin/api/")) {
      const me = await panelPrincipal(req, url);
      if (!me) throw new HttpError(401, "Não autenticado");
      const parts = p.slice("/admin/api/".length).split("/").filter(Boolean);

      if (parts[0] === "me" && method === "GET") {
        return sendJson(res, 200, {
          kind: me.kind,
          id: me.kind === "user" ? me.id : undefined,
          name: displayName(me),
          transcriptionAvailable: transcriptionConfigured(),
          username: me.kind === "user" ? me.username : undefined,
          isAdmin: isAdmin(me),
          attendantOnly: isAttendantOnly(me),
          permissionLabels: PERMISSION_LABELS,
          permissions: PERMISSIONS,
        });
      }

      if (parts[0] === "lines" && parts.length === 1) {
        if (method === "GET") return sendJson(res, 200, lines.lines.filter((l) => can(me, l.config.id, "view")).map((l) => lineView(l, me)));
        if (method === "POST") {
          requireAdmin(me);
          const body = await readJson(req);
          const line = await lines.create(String(body.name ?? "").trim() || `Telefone ${lines.lines.length + 1}`, body);
          audit(me, req, "line.create", { lineId: line.config.id, target: line.config.name, details: body });
          log.info(`telefone criado: ${line.config.name} (${line.config.id}) por ${displayName(me)}`);
          return sendJson(res, 201, lineView(line, me));
        }
      }
      if (parts[0] === "lines" && parts.length >= 2) {
        const id = parts[1];
        const action = parts[2];
        if (!lines.get(id)) throw new HttpError(404, "Telefone não encontrado");
        if (!action && method === "PATCH") {
          requirePerm(me, id, "settings");
          const before = { ...lines.get(id)!.config };
          const body = await readJson(req);
          const after = (await lines.update(id, body)).config;
          const changed = Object.fromEntries(Object.keys(after)
            .filter((k) => JSON.stringify((before as any)[k]) !== JSON.stringify((after as any)[k]))
            .map((k) => [k, { de: (before as any)[k], para: (after as any)[k] }]));
          if (Object.keys(changed).length) audit(me, req, "line.update", { lineId: id, target: after.name, details: changed });
          return sendJson(res, 200, lineView(lines.get(id)!, me));
        }
        if (!action && method === "DELETE") {
          requireAdmin(me);
          const name = lines.get(id)!.config.name;
          await lines.remove(id);
          audit(me, req, "line.delete", { lineId: id, target: name });
          return sendJson(res, 200, { ok: true });
        }
        if (method === "POST" && action === "rotate-token") {
          requirePerm(me, id, "integrations");
          const view = lineView(await lines.rotateToken(id, newLineToken()), me);
          audit(me, req, "line.rotate-token", { lineId: id, target: view.name });
          return sendJson(res, 200, view);
        }
        if (method === "POST" && action === "webhook-test") {
          requirePerm(me, id, "settings");
          return sendJson(res, 200, await webhooks.test(id));
        }
        if (action === "webhook-deliveries") {
          requirePerm(me, id, "settings");
          const sub = parts[3];
          if (method === "GET" && !sub) {
            const status = url.searchParams.get("status") ?? undefined;
            const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
            return sendJson(res, 200, { summary: await webhooks.summary(id), deliveries: await webhooks.list(id, { status, limit }) });
          }
          if (method === "POST" && (sub === "retry-failed" || (sub && parts[4] === "retry"))) {
            const requeued = await webhooks.retry(id, sub === "retry-failed" ? undefined : [sub]);
            audit(me, req, "webhook.retry", { lineId: id, target: sub === "retry-failed" ? "todas as falhas" : sub, details: { requeued } });
            return sendJson(res, 200, { requeued });
          }
        }
        if (method === "POST" && action === "logout") {
          requirePerm(me, id, "connection");
          await lines.logout(id);
          audit(me, req, "line.logout", { lineId: id, target: lines.get(id)?.config.name });
          return sendJson(res, 200, { ok: true });
        }
        if (method === "POST" && action === "restart") {
          requirePerm(me, id, "connection");
          await lines.get(id)!.restart();
          audit(me, req, "line.restart", { lineId: id, target: lines.get(id)?.config.name });
          return sendJson(res, 200, { ok: true });
        }
      }
      if (parts[0] === "calls" && method === "GET") {
        const visible = isAdmin(me) ? null : lines.lines.filter((l) => can(me, l.config.id, "view")).map((l) => l.config.id);
        const lineId = url.searchParams.get("line");
        if (lineId && !can(me, lineId, "view")) throw new HttpError(403, "Sem permissão para este telefone");
        return sendJson(res, 200, await store.recentCalls(lineId ? [lineId] : visible, 200));
      }
      if (parts[0] === "quick-replies") {
        const lineIdOf = async (id: string): Promise<string | null> => {
          const q = await db.quickReply.findUnique({ where: { id } });
          if (!q) throw new HttpError(404, "Resposta rápida não encontrada");
          return q.lineId;
        };
        // Respostas de um telefone: permissão "settings" nele. Globais: só administradores.
        const requireManage = (lineId: string | null): void => { if (lineId) requirePerm(me, lineId, "settings"); else requireAdmin(me); };
        const clean = (b: any) => {
          const shortcut = String(b.shortcut ?? "").trim().replace(/^\//, "").toLowerCase();
          const text = String(b.text ?? "");
          if (!/^[\p{L}\p{N}_-]{1,30}$/u.test(shortcut)) throw new HttpError(400, "Atalho: 1 a 30 letras, números, _ ou -");
          if (!text.trim() || text.length > 4096) throw new HttpError(400, "Texto: 1 a 4096 caracteres");
          return { shortcut, text };
        };
        if (method === "GET" && !parts[1]) {
          const lineId = url.searchParams.get("line") ?? undefined;
          if (lineId) requirePerm(me, lineId, "view");
          return sendJson(res, 200, (await store.quickReplies(lineId)).filter((q) => !q.lineId || can(me, q.lineId, "view")));
        }
        if (method === "POST" && !parts[1]) {
          const b = await readJson(req);
          const lineId = b.lineId ? String(b.lineId) : null;
          if (lineId && !lines.get(lineId)) throw new HttpError(404, "Telefone não encontrado");
          requireManage(lineId);
          const q = await db.quickReply.create({ data: { lineId, ...clean(b) } });
          audit(me, req, "quick-reply.create", { lineId: lineId ?? undefined, target: `/${q.shortcut}` });
          return sendJson(res, 201, q);
        }
        if (parts[1] && (method === "PATCH" || method === "DELETE")) {
          const lineId = await lineIdOf(parts[1]);
          requireManage(lineId);
          if (method === "DELETE") {
            const q = await db.quickReply.delete({ where: { id: parts[1] } });
            audit(me, req, "quick-reply.delete", { lineId: lineId ?? undefined, target: `/${q.shortcut}` });
            return sendJson(res, 200, { ok: true });
          }
          const q = await db.quickReply.update({ where: { id: parts[1] }, data: clean(await readJson(req)) });
          audit(me, req, "quick-reply.update", { lineId: lineId ?? undefined, target: `/${q.shortcut}` });
          return sendJson(res, 200, q);
        }
      }
      if (parts[0] === "metrics" && method === "GET") {
        const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 7) || 7, 1), 366);
        const lineId = url.searchParams.get("line");
        if (lineId && !can(me, lineId, "view")) throw new HttpError(403, "Sem permissão para este telefone");
        const ids = lineId ? [lineId] : lines.lines.filter((l) => can(me, l.config.id, "view")).map((l) => l.config.id);
        return sendJson(res, 200, await computeMetrics(db, ids, days));
      }
      if (parts[0] === "audit" && method === "GET") {
        requireAdmin(me);
        const before = url.searchParams.get("before");
        const lineId = url.searchParams.get("line") || undefined;
        const action = url.searchParams.get("action") || undefined;
        const q = url.searchParams.get("q")?.trim() || undefined;
        const rows = await db.auditLog.findMany({
          where: {
            ...(lineId ? { lineId } : {}),
            ...(action ? { action: { startsWith: action } } : {}),
            ...(q ? { OR: [{ actor: { contains: q, mode: "insensitive" } }, { target: { contains: q, mode: "insensitive" } }] } : {}),
            ...(before ? { at: { lt: new Date(before) } } : {}),
          },
          orderBy: { at: "desc" },
          take: Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500),
        });
        return sendJson(res, 200, rows);
      }
      if (parts[0] === "users" || parts[0] === "groups") {
        requireAdmin(me);
        let body: any;
        // Na exclusão, guarda o nome antes (depois não existe mais).
        const deletedName = method === "DELETE" && parts[1]
          ? (parts[0] === "users"
            ? (await db.user.findUnique({ where: { id: parts[1] } }))?.username
            : (await db.group.findUnique({ where: { id: parts[1] } }))?.name)
          : undefined;
        const result = await handleUsersApi(method, parts, async () => (body = await readJson(req)), me, {
          db, sessions, lines, onPermissionsChanged: () => notifyPermissionsChanged(),
        });
        if (result !== undefined && method !== "GET") {
          const kind = parts[0] === "users" ? "user" : "group";
          const verb = method === "POST" ? "create" : method === "PATCH" ? "update" : "delete";
          const r = result as any;
          audit(me, req, `${kind}.${verb}`, { target: deletedName ?? r?.username ?? r?.name ?? parts[1], details: body });
        }
        if (result !== undefined) return sendJson(res, 200, result);
      }
      throw new HttpError(404, "Rota não encontrada");
    }

    // ── API da linha (token da linha ou sessão do painel) ──
    if (p.startsWith("/api/v1/")) {
      const { line, principal } = await lineAuth(req, url);
      const lineId = line.config.id;
      const parts = p.slice("/api/v1/".length).split("/").filter(Boolean);

      if (method === "GET" && parts[0] === "line" && parts.length === 1) {
        return sendJson(res, 200, { ...line.publicInfo, permissions: permissionsOn(principal, lineId) });
      }

      if (parts[0] === "calls" && parts.length === 1) {
        if (method === "GET") {
          const contact = url.searchParams.get("contact");
          if (contact) return sendJson(res, 200, { current: line.current, history: await store.callsWith(lineId, contact, 100) });
          return sendJson(res, 200, { current: line.current, history: await store.recentCalls([lineId], 100) });
        }
        if (method === "POST") {
          requirePerm(principal, lineId, "dial");
          const { to, handler, clientId, agent } = await readJson(req);
          if (typeof to !== "string" && typeof to !== "number") throw new HttpError(400, "Campo 'to' obrigatório");
          const call = await line.dial(String(to), {
            handler: handler ?? (clientId ? "browser" : undefined),
            clientId: clientId ? String(clientId) : undefined,
            agent: agentFor(principal, agent),
            userId: principal.kind === "user" ? principal.id : undefined,
          });
          return sendJson(res, 201, call);
        }
      }

      if (parts[0] === "calls" && parts.length === 3 && parts[2] === "recording" && method === "GET") {
        requirePerm(principal, lineId, "view");
        const call = await store.getCall(lineId, decodeURIComponent(parts[1]));
        if (!call?.recordingFile) throw new HttpError(404, "Ligação sem gravação");
        return sendFile(req, res, lines.lineFile(lineId, call.recordingFile), "audio/ogg", `ligacao-${call.remote}-${call.startedAt.toISOString().slice(0, 16).replace(/[:T]/g, "-")}.ogg`);
      }

      if (parts[0] === "calls" && parts.length === 3 && method === "POST") {
        const [, callId, action] = parts;
        const body = await readJson(req);
        const call = line.current;
        if (call?.id !== callId) throw new HttpError(404, "Chamada não encontrada ou já encerrada");
        const ownsOrCan = (perm: Permission) => {
          // Quem está na ligação controla a própria ligação; senão precisa da permissão.
          if (principal.kind === "user" && call.ownerUserId === principal.id) return;
          requirePerm(principal, lineId, perm);
        };
        const callPerm: Permission = call.direction === "incoming" ? "receive" : "dial";
        switch (action) {
          case "accept": {
            requirePerm(principal, lineId, "receive");
            const clientId = body.clientId ? String(body.clientId) : `api-${randomBytes(4).toString("hex")}`;
            const agent = agentFor(principal, body.agent) ?? (body.clientId ? undefined : "API");
            line.claim(callId, clientId, agent, principal.kind === "user" ? principal.id : undefined);
            const handler = body.handler ?? (body.clientId ? "browser" : undefined);
            try {
              await line.request({ cmd: "accept", callId, handler });
            } catch (err) {
              line.releaseClaim(callId, clientId);
              throw err;
            }
            return sendJson(res, 200, line.current);
          }
          case "reject": requirePerm(principal, lineId, "receive"); await line.request({ cmd: "reject", callId }); break;
          case "hangup": ownsOrCan(callPerm); await line.request({ cmd: "hangup", callId }); break;
          case "clear": ownsOrCan(callPerm); await line.request({ cmd: "clear", callId }); break;
          case "mute": ownsOrCan(callPerm); await line.request({ cmd: "mute", callId, muted: !!body.muted }); break;
          case "play":
            ownsOrCan(callPerm);
            if (typeof body.url !== "string") throw new HttpError(400, "Campo 'url' obrigatório");
            // O ffmpeg abriria qualquer caminho/URL: só http(s) para endereços públicos.
            await assertPublicUrl(body.url).catch((err) => { throw new HttpError(400, err.message); });
            await line.request({ cmd: "play", callId, url: body.url });
            break;
          default: throw new HttpError(404, "Ação desconhecida");
        }
        return sendJson(res, 200, { ok: true });
      }
      if ((parts[0] === "agents" || parts[0] === "quick-replies") && parts.length === 1 && method === "GET") {
        requirePerm(principal, lineId, "messages");
        if (parts[0] === "agents") return sendJson(res, 200, await attendance.agents(lineId));
        return sendJson(res, 200, (await store.quickReplies(lineId)).map((q) => ({ id: q.id, shortcut: q.shortcut, text: q.text, global: !q.lineId })));
      }

      if (parts[0] === "chats" || parts[0] === "contacts") {
        requirePerm(principal, lineId, "messages");
        if (parts[0] === "chats" && parts.length === 1 && method === "GET") {
          const chats = await store.listChats(lineId);
          return sendJson(res, 200, chats.map((c) => ({ ...c, last: { ...c.last, mediaUrl: webhooks.mediaUrl(c.last) } })));
        }
        const remote = decodeURIComponent(parts[1] ?? "");
        if (parts[0] === "chats" && parts.length === 3 && parts[2] === "read" && method === "POST") {
          await lines.markChatRead(lineId, remote);
          return sendJson(res, 200, { ok: true });
        }
        if (parts[0] === "contacts" && parts.length === 2 && method === "GET") {
          const [contact, calls] = await Promise.all([attendance.get(lineId, remote), store.callsWith(lineId, remote, 20)]);
          return sendJson(res, 200, { ...contact, calls });
        }
        if (parts[0] === "contacts" && parts.length === 2 && method === "PATCH") {
          const me = principal.kind === "user" ? { id: principal.id, name: principal.name } : undefined;
          return sendJson(res, 200, await attendance.update(lineId, remote, await readJson(req), me));
        }
        if (parts[0] === "contacts" && parts.length === 3 && parts[2] === "photo" && method === "GET") {
          const jid = url.searchParams.get("jid") ?? undefined;
          const photo = await lines.profilePicture(lineId, remote, jid && /^[\w.:-]+@(s\.whatsapp\.net|lid)$/.test(jid) ? jid : undefined);
          if (!photo) {
            // Sem foto (ou privada) não é erro: o painel mostra as iniciais.
            res.writeHead(204, { "cache-control": "private, max-age=3600" });
            return void res.end();
          }
          res.writeHead(302, { location: photo, "cache-control": "private, max-age=3600" });
          return void res.end();
        }
      }

      if (parts[0] === "messages") {
        requirePerm(principal, lineId, "messages");
        if (parts.length === 1 && method === "GET") {
          const before = url.searchParams.get("before");
          const beforeDate = before ? new Date(before) : undefined;
          if (beforeDate && Number.isNaN(beforeDate.getTime())) throw new HttpError(400, "Parâmetro 'before' inválido (use data ISO)");
          // Número (só dígitos) ou JID (grupos e contatos só com LID).
          const rawContact = url.searchParams.get("contact")?.trim() ?? "";
          const contact = (rawContact.includes("@") ? rawContact : rawContact.replace(/\D/g, "")) || undefined;
          const list = await store.listMessages(lineId, {
            remote: contact,
            before: beforeDate,
            limit: Number(url.searchParams.get("limit") ?? 50) || 50,
          });
          return sendJson(res, 200, list.map((m) => ({ ...m, mediaUrl: webhooks.mediaUrl(m) })));
        }
        if (parts.length === 1 && method === "POST") {
          const body = await readJson(req, MAX_MESSAGE_BODY_BYTES);
          if (typeof body.to !== "string" && typeof body.to !== "number") throw new HttpError(400, "Campo 'to' obrigatório");
          const content = await parseOutgoing(body);
          const message = await lines.sendMessage(lineId, String(body.to), content, {
            agent: agentFor(principal, body.agent) ?? "API",
            replyTo: typeof body.replyTo === "string" ? body.replyTo : undefined,
          });
          return sendJson(res, 201, { ...message, mediaUrl: webhooks.mediaUrl(message) });
        }
        if (parts.length === 3 && parts[2] === "media" && method === "GET") {
          const { view, data } = await lines.downloadMedia(lineId, decodeURIComponent(parts[1]));
          const fileName = view.media?.fileName ?? `${view.id}`;
          const mime = view.media?.mimetype ?? "application/octet-stream";
          // O arquivo vem do contato: só mídia comum abre no navegador; o resto (HTML, SVG…)
          // é baixado, e o sandbox impede script na origem do painel.
          const inline = /^(image\/(jpeg|png|gif|webp)|video\/|audio\/)/.test(mime);
          const headers = {
            "content-type": mime,
            "accept-ranges": "bytes",
            "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
            "content-security-policy": "default-src 'none'; sandbox",
            "cache-control": "private, max-age=86400",
            "x-content-type-options": "nosniff",
          };
          // Range: players de áudio/vídeo pedem pedaços para avançar/voltar.
          const r = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
          if (r && Number(r[1]) < data.length) {
            const start = Number(r[1]);
            const end = r[2] ? Math.min(Number(r[2]), data.length - 1) : data.length - 1;
            res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${data.length}`, "content-length": end - start + 1 });
            return void res.end(data.subarray(start, end + 1));
          }
          res.writeHead(200, { ...headers, "content-length": data.length });
          return void res.end(data);
        }
        if (parts.length === 3 && parts[2] === "read" && method === "POST") {
          await lines.markRead(lineId, decodeURIComponent(parts[1]));
          return sendJson(res, 200, { ok: true });
        }
      }
      throw new HttpError(404, "Rota não encontrada");
    }

    throw new HttpError(404, "Não encontrado");
  };

  const server = http.createServer((req, res) => {
    // CORS da API da linha: autenticação por Bearer token (cookies não vão cross-site: SameSite=Strict).
    if (req.url?.startsWith("/api/v1/")) {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "authorization, content-type, x-line-id");
      res.setHeader("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
      if (req.method === "OPTIONS") { res.writeHead(204); return void res.end(); }
    }
    handle(req, res).catch((err: any) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log.error("erro na requisição:", err);
      sendJson(res, status, { error: status === 500 ? "Erro interno" : err?.message ?? String(err) });
    });
  });

  notifyPermissionsChanged = attachWebSockets(server, deps, panelPrincipal, lineAuth, agentFor);

  server.listen(deps.port, deps.host, () => {
    const shown = deps.host === "0.0.0.0" ? "localhost" : deps.host;
    log.info(`painel: http://${shown}:${deps.port}/`);
  });
  return server;
};

// ─── WebSockets ──────────────────────────────────────────────────────────────

/** Retorna a função que derruba conexões de painel para recarregar permissões. */
const attachWebSockets = (
  server: http.Server,
  deps: ServerDeps,
  panelPrincipal: (req: http.IncomingMessage, url: URL) => Promise<Principal | null>,
  lineAuth: (req: http.IncomingMessage, url: URL) => Promise<{ line: LineRuntime; principal: Principal }>,
  agentFor: (p: Principal, requested: unknown) => string | undefined,
): (() => void) => {
  const { lines } = deps;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const adminClients = new Map<WebSocket, Principal>();
  const lineClients = new Map<string, Map<WebSocket, Principal>>();   // lineId -> eventos
  const mediaClients = new Map<string, Set<WebSocket>>();             // callId -> áudio

  const sendOne = (ws: WebSocket, msg: object): void => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

  lines.on("event", (e: LineEvent) => {
    // Mensagens só para quem tem a permissão; elas não mudam o estado da linha.
    if (e.type === "message" || e.type === "message-status" || e.type === "message-update" || e.type === "chat-read" || e.type === "contact") {
      const msg = e.type === "chat-read" || e.type === "contact" ? e : { ...e, message: { ...e.message, mediaUrl: deps.webhooks.mediaUrl(e.message) } };
      for (const [ws, p] of lineClients.get(e.lineId) ?? []) if (can(p, e.lineId, "messages")) sendOne(ws, msg);
      for (const [ws, p] of adminClients) if (can(p, e.lineId, "messages")) sendOne(ws, msg);
      return;
    }
    for (const [ws] of lineClients.get(e.lineId) ?? []) sendOne(ws, e);
    const line = lines.get(e.lineId);
    for (const [ws, p] of adminClients) {
      if (!can(p, e.lineId, "view")) continue;
      sendOne(ws, e);
      // call-update não muda o estado da linha.
      if (line && e.type !== "call-update") sendOne(ws, { type: "line-admin", line: lineView(line, p) });
    }
    if (e.type === "ended") for (const ws of mediaClients.get(e.call.id) ?? []) ws.close(1000, "chamada encerrada");
  });
  lines.on("removed", (lineId: string) => {
    for (const [ws] of adminClients) sendOne(ws, { type: "line-removed", lineId });
    for (const [ws] of lineClients.get(lineId) ?? []) ws.close(4001, "linha removida");
  });
  lines.on("token-rotated", (lineId: string) => {
    for (const [ws, p] of lineClients.get(lineId) ?? []) if (p.kind === "token") ws.close(4001, "token alterado");
    const line = lines.get(lineId);
    if (line) for (const [ws, p] of adminClients) if (can(p, lineId, "view")) sendOne(ws, { type: "line-admin", line: lineView(line, p) });
  });
  lines.on("audio", (_lineId: string, callId: string, pcm: Buffer) => {
    for (const ws of mediaClients.get(callId) ?? []) if (ws.readyState === ws.OPEN) ws.send(pcm);
  });

  const track = <K, V>(map: Map<K, Map<WebSocket, V>>, key: K, ws: WebSocket, value: V): void => {
    let m = map.get(key);
    if (!m) map.set(key, (m = new Map()));
    m.set(ws, value);
    ws.on("close", () => { m!.delete(ws); if (!m!.size) map.delete(key); });
  };

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const fail = (status: number, msg: string): void => {
      socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    void (async () => {
      try {
        if (url.pathname === "/admin/api/events") {
          const p = await panelPrincipal(req, url);
          if (!p) return fail(401, "Unauthorized");
          return wss.handleUpgrade(req, socket, head, (ws) => {
            adminClients.set(ws, p);
            ws.on("close", () => adminClients.delete(ws));
            sendOne(ws, { type: "lines", lines: lines.lines.filter((l) => can(p, l.config.id, "view")).map((l) => lineView(l, p)) });
          });
        }

        if (url.pathname === "/api/v1/events") {
          const { line, principal } = await lineAuth(req, url);
          return wss.handleUpgrade(req, socket, head, (ws) => {
            track(lineClients, line.config.id, ws, principal);
            sendOne(ws, { type: "hello", line: { ...line.publicInfo, permissions: permissionsOn(principal, line.config.id) } });
          });
        }

        if (url.pathname === "/api/v1/media") {
          const { line, principal } = await lineAuth(req, url);
          const callId = url.searchParams.get("call") ?? "";
          const clientId = url.searchParams.get("clientId") ?? "";
          if (!clientId) return fail(400, "Bad Request");
          const current = line.current;
          if (!current || current.id !== callId) return fail(404, "Not Found");
          const isOwner = current.ownerClientId === clientId;
          if (!isOwner && !can(principal, line.config.id, current.direction === "incoming" ? "receive" : "dial")) {
            return fail(403, "Forbidden");
          }
          let call: CallView;
          try {
            call = line.claim(callId, clientId, agentFor(principal, url.searchParams.get("agent")),
              principal.kind === "user" ? principal.id : undefined);
          } catch (err: any) {
            return fail(err?.status ?? 409, "Conflict");
          }
          return wss.handleUpgrade(req, socket, head, (ws) => {
            let set = mediaClients.get(call.id);
            if (!set) mediaClients.set(call.id, (set = new Set()));
            set.add(ws);
            ws.on("close", () => { set!.delete(ws); if (!set!.size) mediaClients.delete(call.id); });
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
    })();
  });

  setInterval(() => {
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.ping();
  }, 25_000).unref();

  // Permissões mudaram: derruba conexões do painel (elas reconectam com as permissões novas).
  return () => {
    for (const [ws] of adminClients) ws.close(4002, "permissões alteradas");
    for (const [, m] of lineClients) for (const [ws, p] of m) if (p.kind === "user") ws.close(4002, "permissões alteradas");
  };
};
