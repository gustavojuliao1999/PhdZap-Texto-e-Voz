import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { loadUserPrincipal, type Principal } from "./permissions.js";

const TTL_MS = 7 * 24 * 3_600_000;
const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Sessões do painel no banco. O cookie leva o token; o banco guarda só o hash. */
export class Sessions {
  constructor(private readonly db: PrismaClient) {
    setInterval(() => { void this.cleanup(); }, 3_600_000).unref();
  }

  readonly ttlSeconds = TTL_MS / 1000;

  create = async (who: { userId: string } | { super: true }): Promise<string> => {
    const token = randomBytes(32).toString("base64url");
    await this.db.session.create({
      data: {
        id: hash(token),
        userId: "userId" in who ? who.userId : null,
        isSuper: "super" in who,
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    });
    return token;
  };

  resolve = async (token: string | undefined): Promise<Principal | null> => {
    if (!token) return null;
    const s = await this.db.session.findUnique({ where: { id: hash(token) } });
    if (!s) return null;
    if (s.expiresAt.getTime() < Date.now()) {
      await this.db.session.delete({ where: { id: s.id } }).catch(() => {});
      return null;
    }
    if (s.isSuper) return { kind: "super", name: "Super admin" };
    return s.userId ? loadUserPrincipal(this.db, s.userId) : null;
  };

  destroy = async (token: string | undefined): Promise<void> => {
    if (token) await this.db.session.deleteMany({ where: { id: hash(token) } });
  };

  destroyForUser = async (userId: string): Promise<void> => {
    await this.db.session.deleteMany({ where: { userId } });
  };

  cleanup = async (): Promise<void> => {
    await this.db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
  };
}
