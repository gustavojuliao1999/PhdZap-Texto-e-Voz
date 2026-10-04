import type http from "node:http";
import type { Prisma, PrismaClient } from "@prisma/client";
import { displayName, type Principal } from "./auth/permissions.js";
import { log } from "./log.js";

/** Campos que nunca vão para a auditoria. */
const SECRET_FIELDS = new Set(["password", "passwordHash", "token", "webhookSecret", "key"]);

export const redact = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_FIELDS.has(k) ? "***" : redact(x)]));
  }
  return v;
};

/** IP de quem fez a requisição. Atrás de proxy (TRUST_PROXY=true), usa o X-Forwarded-For. */
export const clientIp = (req: http.IncomingMessage): string =>
  (process.env.TRUST_PROXY === "true" ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "")
  || req.socket.remoteAddress || "?";

export type AuditEntry = { lineId?: string; target?: string; details?: unknown };

/** Registra uma ação (não bloqueia a requisição; falha só vai para o log). */
export const makeAudit = (db: PrismaClient) =>
  (p: Principal | null | { kind: "anonymous"; name: string }, req: http.IncomingMessage | null, action: string, e: AuditEntry = {}): void => {
    const actorKind = !p ? "system" : p.kind;
    const actor = !p ? "Sistema" : p.kind === "anonymous" ? p.name : p.kind === "user" ? `${p.name} (${p.username})` : displayName(p as Principal);
    const actorId = p && p.kind === "user" ? p.id : undefined;
    db.auditLog.create({
      data: {
        actorKind, actorId, actor, action,
        lineId: e.lineId, target: e.target,
        details: e.details === undefined ? undefined : (redact(e.details) as Prisma.InputJsonValue),
        ip: req ? clientIp(req) : undefined,
      },
    }).catch((err) => log.warn(`falha ao gravar auditoria (${action}): ${err.message}`));
  };

export type Audit = ReturnType<typeof makeAudit>;
