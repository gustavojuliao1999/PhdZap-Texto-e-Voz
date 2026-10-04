/**
 * Contatos ocultos de um telefone: as mensagens e ligações continuam gravadas, mas não aparecem
 * no painel, na API nem no webhook. A comparação ignora o 9º dígito dos celulares brasileiros
 * (o WhatsApp registra muitos números sem ele).
 */

/** Forma canônica de um número: só dígitos e, no Brasil, sem o 9º dígito. JIDs ficam como estão. */
export const phoneKey = (remote: string): string => {
  if (remote.includes("@")) return remote;
  const d = remote.replace(/\D/g, "");
  const br = /^55(\d{2})9(\d{8})$/.exec(d);
  return br ? `55${br[1]}${br[2]}` : d;
};

/** As formas como o número pode estar gravado (com e sem o 9º dígito). */
export const phoneVariants = (remote: string): string[] => {
  const key = phoneKey(remote);
  const br = /^55(\d{2})(\d{8})$/.exec(key);
  return br ? [key, `55${br[1]}9${br[2]}`] : [key];
};

/** Normaliza a lista digitada pelo admin: só dígitos, sem repetidos. */
export const normalizeHiddenList = (input: unknown): string[] => {
  const list = Array.isArray(input) ? input : String(input ?? "").split(/[\n,;]+/);
  const out = new Map<string, string>();
  for (const item of list) {
    const d = String(item).replace(/\D/g, "");
    if (d.length >= 8) out.set(phoneKey(d), d);
  }
  return [...out.values()];
};

/** Função que diz se um contato está oculto, para a lista de um telefone. */
export const hiddenMatcher = (list: string[]): ((remote: string | undefined | null) => boolean) => {
  if (!list.length) return () => false;
  const keys = new Set(list.map(phoneKey));
  return (remote) => !!remote && keys.has(phoneKey(remote));
};

/** Todas as formas gravadas dos números ocultos (para filtrar no banco com `notIn`). */
export const hiddenRemotes = (list: string[]): string[] => list.flatMap(phoneVariants);
