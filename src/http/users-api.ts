import type { Prisma, PrismaClient } from "@prisma/client";
import { hashPassword, validatePassword } from "../auth/passwords.js";
import { isPermission, type Principal } from "../auth/permissions.js";
import type { Sessions } from "../auth/sessions.js";
import { HttpError, type LineManager } from "../line-manager.js";

type Ctx = { db: PrismaClient; sessions: Sessions; lines: LineManager; onPermissionsChanged: () => void };

const USERNAME = /^[a-z0-9._-]{3,40}$/;

const userView = (u: Prisma.UserGetPayload<{ include: { groups: { include: { group: true } } } }>) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  isAdmin: u.isAdmin,
  active: u.active,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt,
  groups: u.groups.map((g) => ({ id: g.group.id, name: g.group.name })),
});

const groupView = (g: Prisma.GroupGetPayload<{ include: { members: true; lines: true } }>) => ({
  id: g.id,
  name: g.name,
  description: g.description,
  memberIds: g.members.map((m) => m.userId),
  lines: g.lines.map((l) => ({ lineId: l.lineId, permissions: l.permissions })),
});

const str = (v: unknown, field: string, max = 80): string => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `Campo '${field}' obrigatório`);
  if (v.trim().length > max) throw new HttpError(400, `Campo '${field}' muito longo`);
  return v.trim();
};

const ids = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.map(String))] : []);

/** Normaliza [{ lineId, permissions }] descartando linhas inexistentes e permissões inválidas. */
const lineGrants = (v: unknown, ctx: Ctx) =>
  (Array.isArray(v) ? v : [])
    .map((g: any) => ({
      lineId: String(g?.lineId ?? ""),
      permissions: [...new Set((Array.isArray(g?.permissions) ? g.permissions : []).filter(isPermission))] as string[],
    }))
    .filter((g) => g.permissions.length && ctx.lines.get(g.lineId));

const uniqueViolation = (err: any, msg: string): never => {
  if (err?.code === "P2002") throw new HttpError(409, msg);
  throw err;
};

/**
 * /admin/api/users e /admin/api/groups. Retorna o corpo da resposta, ou
 * `undefined` se a rota não for deste módulo.
 */
export const handleUsersApi = async (
  method: string, parts: string[], body: () => Promise<any>, me: Principal, ctx: Ctx,
): Promise<unknown | undefined> => {
  const { db } = ctx;
  const [resource, id] = parts;

  if (resource === "users") {
    const include = { groups: { include: { group: true } } } as const;
    if (!id && method === "GET") {
      return (await db.user.findMany({ include, orderBy: { name: "asc" } })).map(userView);
    }
    if (!id && method === "POST") {
      const b = await body();
      const username = str(b.username, "username", 40).toLowerCase();
      if (!USERNAME.test(username)) throw new HttpError(400, "Usuário: 3 a 40 caracteres (letras minúsculas, números, . _ -)");
      let password: string;
      try { password = validatePassword(b.password); } catch (e: any) { throw new HttpError(400, e.message); }
      const user = await db.user.create({
        data: {
          username,
          name: str(b.name, "name"),
          passwordHash: await hashPassword(password),
          isAdmin: !!b.isAdmin,
          groups: { create: ids(b.groupIds).map((groupId) => ({ groupId })) },
        },
        include,
      }).catch((e) => uniqueViolation(e, "Já existe um usuário com esse login"));
      ctx.onPermissionsChanged();
      return userView(user);
    }
    if (id && method === "PATCH") {
      const b = await body();
      const data: Prisma.UserUpdateInput = {};
      if (b.name !== undefined) data.name = str(b.name, "name");
      if (b.username !== undefined) {
        const username = str(b.username, "username", 40).toLowerCase();
        if (!USERNAME.test(username)) throw new HttpError(400, "Usuário: 3 a 40 caracteres (letras minúsculas, números, . _ -)");
        data.username = username;
      }
      if (b.password) {
        try { data.passwordHash = await hashPassword(validatePassword(b.password)); } catch (e: any) { throw new HttpError(400, e.message); }
      }
      if (b.isAdmin !== undefined) {
        if (me.kind === "user" && me.id === id && !b.isAdmin) throw new HttpError(400, "Você não pode remover seu próprio acesso de administrador");
        data.isAdmin = !!b.isAdmin;
      }
      if (b.active !== undefined) {
        if (me.kind === "user" && me.id === id && !b.active) throw new HttpError(400, "Você não pode desativar a si mesmo");
        data.active = !!b.active;
      }
      const user = await db.$transaction(async (tx) => {
        if (b.groupIds !== undefined) {
          await tx.groupMember.deleteMany({ where: { userId: id } });
          await tx.groupMember.createMany({ data: ids(b.groupIds).map((groupId) => ({ userId: id, groupId })) });
        }
        return tx.user.update({ where: { id }, data, include });
      }).catch((e) => uniqueViolation(e, "Já existe um usuário com esse login"));
      // Senha trocada ou usuário desativado: derruba as sessões abertas.
      if (b.password || b.active === false) await ctx.sessions.destroyForUser(id);
      ctx.onPermissionsChanged();
      return userView(user);
    }
    if (id && method === "DELETE") {
      if (me.kind === "user" && me.id === id) throw new HttpError(400, "Você não pode excluir a si mesmo");
      await db.user.delete({ where: { id } }).catch(() => { throw new HttpError(404, "Usuário não encontrado"); });
      ctx.onPermissionsChanged();
      return { ok: true };
    }
  }

  if (resource === "groups") {
    const include = { members: true, lines: true } as const;
    if (!id && method === "GET") {
      return (await db.group.findMany({ include, orderBy: { name: "asc" } })).map(groupView);
    }
    const save = async (groupId: string | null) => {
      const b = await body();
      const name = str(b.name, "name", 60);
      const description = typeof b.description === "string" ? b.description.trim().slice(0, 200) : "";
      const grants = lineGrants(b.lines, ctx);
      const memberIds = ids(b.memberIds);
      const group = await db.$transaction(async (tx) => {
        const g = groupId
          ? await tx.group.update({ where: { id: groupId }, data: { name, description } })
          : await tx.group.create({ data: { name, description } });
        if (b.memberIds !== undefined || !groupId) {
          await tx.groupMember.deleteMany({ where: { groupId: g.id } });
          await tx.groupMember.createMany({ data: memberIds.map((userId) => ({ userId, groupId: g.id })) });
        }
        if (b.lines !== undefined || !groupId) {
          await tx.groupLine.deleteMany({ where: { groupId: g.id } });
          await tx.groupLine.createMany({ data: grants.map((l) => ({ ...l, groupId: g.id })) });
        }
        return tx.group.findUniqueOrThrow({ where: { id: g.id }, include });
      }).catch((e) => uniqueViolation(e, "Já existe um grupo com esse nome"));
      ctx.onPermissionsChanged();
      return groupView(group);
    };
    if (!id && method === "POST") return save(null);
    if (id && method === "PATCH") return save(id);
    if (id && method === "DELETE") {
      await db.group.delete({ where: { id } }).catch(() => { throw new HttpError(404, "Grupo não encontrado"); });
      ctx.onPermissionsChanged();
      return { ok: true };
    }
  }

  return undefined;
};
