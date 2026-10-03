// Utilidades compartilhadas pelas páginas do painel admin.
import { esc, fmtPhone } from "/static/voice.js";

export const $ = (id) => document.getElementById(id);

export const STATUS = { connecting: "conectando…", qr: "aguardando QR", open: "conectado", error: "erro", stopped: "parada" };
export const CALL_STATUS = { dialing: "chamando", ringing: "tocando", connected: "em ligação", ended: "encerrada" };
export const INBOUND = { manual: "toca nos atendentes", auto: "bot atende", reject: "recusa" };

export const toast = (msg, ok = false) => {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.append(t); }
  t.textContent = msg; t.className = "toast" + (ok ? " ok" : ""); t.style.display = "block";
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.style.display = "none"), 3500);
};

export const api = async (method, path, body) => {
  const res = await fetch(`/admin/api${path}`, {
    method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/login"; throw new Error("Sessão expirada"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Erro ${res.status}`);
  return data;
};

/** Envolve um handler de clique: desabilita o botão e mostra erros em toast. */
export const act = (fn) => async (ev) => {
  const btn = ev?.currentTarget; if (btn) btn.disabled = true;
  try { await fn(ev); } catch (err) { toast(err.message); } finally { if (btn) btn.disabled = false; }
};

/** WebSocket de eventos do admin com reconexão. */
export const connectAdminEvents = (onEvent, liveBadge) => {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/admin/api/events`);
  ws.onopen = () => { if (liveBadge) { liveBadge.textContent = "ao vivo"; liveBadge.className = "badge open"; } };
  ws.onclose = () => {
    if (liveBadge) { liveBadge.textContent = "reconectando…"; liveBadge.className = "badge error"; }
    setTimeout(() => connectAdminEvents(onEvent, liveBadge), 2000);
  };
  ws.onmessage = (ev) => onEvent(JSON.parse(ev.data));
};

export const logout = async () => {
  await fetch("/admin/api/session", { method: "DELETE" });
  location.href = "/login";
};

export const callLabel = (c) =>
  c.pushName ? `${esc(c.pushName)} <span class="muted">${esc(fmtPhone(c.remote))}</span>` : esc(fmtPhone(c.remote));

export const callResult = (c) =>
  c.connectedAt ? "atendida" : c.endReason === "rejected" ? "recusada" : c.direction === "incoming" ? "não atendida" : "sem resposta";

/** Usuário logado: { kind, name, username, isAdmin, permissions, permissionLabels }. */
export const loadMe = () => api("GET", "/me");

/** Preenche <nav id="nav"> no cabeçalho com os links conforme o perfil. */
export const renderNav = (me, active) => {
  const nav = document.getElementById("nav");
  if (!nav) return;
  const link = (href, label, key) => `<a href="${href}" class="${active === key ? "active" : ""}">${label}</a>`;
  nav.innerHTML = `
    ${link("/admin", "Telefones", "lines")}
    ${me.isAdmin ? link("/admin/users", "Usuários e grupos", "users") : ""}
    <span class="spacer"></span>
    <span class="me" title="${me.kind === "super" ? "Entrou com a chave de acesso" : esc(me.username ?? "")}">
      ${me.kind === "super" ? "👑 " : "👤 "}${esc(me.name)}${me.isAdmin && me.kind !== "super" ? " · admin" : ""}
    </span>
    <button class="ghost small" id="navLogout">Sair</button>`;
  document.getElementById("navLogout").onclick = act(logout);
};
