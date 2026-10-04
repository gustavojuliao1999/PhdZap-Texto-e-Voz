import type { PrismaClient } from "@prisma/client";

/** Permissões por telefone (concedidas a grupos). */
export const PERMISSIONS = ["view", "receive", "dial", "messages", "connection", "settings", "integrations"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  view: "Ver telefone e histórico",
  receive: "Receber/atender ligações",
  dial: "Fazer ligações",
  messages: "Ver e enviar mensagens",
  connection: "Conectar/desconectar telefone (QR)",
  settings: "Alterar configurações",
  integrations: "Token, iframes, SDK e API",
};

/** O token da linha (iframes/SDK/API) dá acesso de atendente, não de administração. */
const TOKEN_PERMISSIONS = new Set<Permission>(["view", "receive", "dial", "messages"]);

/** Quem está fazendo a requisição. */
export type Principal =
  | { kind: "super"; name: string }
  | { kind: "user"; id: string; username: string; name: string; isAdmin: boolean; lines: Map<string, Set<Permission>> }
  | { kind: "token"; lineId: string };

export const isPermission = (p: unknown): p is Permission => PERMISSIONS.includes(p as Permission);

/** Administrador global: super admin ou usuário marcado como administrador. */
export const isAdmin = (p: Principal | null | undefined): boolean =>
  !!p && (p.kind === "super" || (p.kind === "user" && p.isAdmin));

export const can = (p: Principal | null | undefined, lineId: string, perm: Permission): boolean => {
  if (!p) return false;
  if (p.kind === "super") return true;
  if (p.kind === "token") return p.lineId === lineId && TOKEN_PERMISSIONS.has(perm);
  return p.isAdmin || !!p.lines.get(lineId)?.has(perm);
};

/** Lista de permissões efetivas de um principal numa linha. */
export const permissionsOn = (p: Principal | null | undefined, lineId: string): Permission[] =>
  PERMISSIONS.filter((perm) => can(p, lineId, perm));

/**
 * Só atende (sem administrar nada): vai direto para /atendimento.
 * Quem administra algum telefone (conectar, configurar, integrações) usa o painel.
 */
export const isAttendantOnly = (p: Principal | null | undefined): boolean =>
  !!p && p.kind === "user" && !p.isAdmin &&
  ![...p.lines.values()].some((perms) => perms.has("connection") || perms.has("settings") || perms.has("integrations"));

export const displayName = (p: Principal): string =>
  p.kind === "super" ? p.name : p.kind === "user" ? p.name : "API";

/** Carrega um usuário ativo com as permissões somadas de todos os seus grupos. */
export const loadUserPrincipal = async (prisma: PrismaClient, userId: string): Promise<Principal | null> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { groups: { include: { group: { include: { lines: true } } } } },
  });
  if (!user || !user.active) return null;
  const lines = new Map<string, Set<Permission>>();
  for (const { group } of user.groups) {
    for (const gl of group.lines) {
      const set = lines.get(gl.lineId) ?? new Set<Permission>();
      for (const perm of gl.permissions) if (isPermission(perm)) set.add(perm);
      // Qualquer permissão implica poder ver o telefone.
      if (set.size) set.add("view");
      lines.set(gl.lineId, set);
    }
  }
  return { kind: "user", id: user.id, username: user.username, name: user.name, isAdmin: user.isAdmin, lines };
};
