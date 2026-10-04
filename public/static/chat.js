// Chat de mensagens do painel (visual do WhatsApp). Usa a API da linha com a sessão do painel (?line=).
import { esc, fmtPhone, transcriptHtml } from "/static/voice.js";
import { toast } from "/static/admin.js";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const EMOJIS = ("😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😜 🤪 🤗 🤭 🤔 🤐 😐 😏 😒 🙄 😬 😌 😔 😴 😷 🤒 🤯 🥳 😎 🤓 😕 😟 😮 😲 😳 🥺 😢 😭 😱 😡 🤬 "
  + "👍 👎 👏 🙌 🙏 💪 👋 🤝 ✌️ 🤞 👌 👀 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💯 🔥 ✨ ⭐ 🎉 🎁 ✅ ❌ ⚠️ ❓ ❗ "
  + "📞 📱 💬 📍 🏠 🚗 ⏰ 📅 📷 🎤 🎧 💰 💳 📄 📦 🛒 ☕ 🍕 🍺 ⚽ 🌞 🌧️").split(" ");
const MAX_FILE = 25 * 1024 * 1024;
const PAGE = 60;

const ICON = {
  send: `<svg viewBox="0 0 24 24"><path d="M1.1 21.8 23 12 1.1 2.2 1.1 9.8 16.7 12 1.1 14.2z"/></svg>`,
  mic: `<svg viewBox="0 0 24 24"><path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 1 0-7 0v6A3.5 3.5 0 0 0 12 15zm6.2-3.5a.9.9 0 0 0-1.8 0 4.4 4.4 0 0 1-8.8 0 .9.9 0 0 0-1.8 0 6.2 6.2 0 0 0 5.3 6.1V20H8.7a.9.9 0 0 0 0 1.8h6.6a.9.9 0 0 0 0-1.8h-2.4v-2.4a6.2 6.2 0 0 0 5.3-6.1z"/></svg>`,
  emoji: `<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18.2a8.2 8.2 0 1 1 0-16.4 8.2 8.2 0 0 1 0 16.4zM8.6 10.8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm6.8 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm1.4 2.6H7.2a.4.4 0 0 0-.4.5 5.3 5.3 0 0 0 10.4 0 .4.4 0 0 0-.4-.5z"/></svg>`,
  clip: `<svg viewBox="0 0 24 24"><path d="M16.5 6.5v10.6a4.5 4.5 0 1 1-9 0V5.6a2.9 2.9 0 1 1 5.8 0v10.6a1.3 1.3 0 1 1-2.6 0V6.5H9.1v9.7a2.9 2.9 0 1 0 5.8 0V5.6a4.5 4.5 0 1 0-9 0v11.5a6.1 6.1 0 1 0 12.2 0V6.5z"/></svg>`,
  plus: `<svg viewBox="0 0 24 24"><path d="M19 11.1h-6.1V5h-1.8v6.1H5v1.8h6.1V19h1.8v-6.1H19z"/></svg>`,
  phone: `<svg viewBox="0 0 24 24"><path d="M20 15.5c-1.2 0-2.4-.2-3.6-.6a1 1 0 0 0-1 .2l-2.2 2.2a15 15 0 0 1-6.6-6.6l2.2-2.2a1 1 0 0 0 .3-1A11.4 11.4 0 0 1 8.5 4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1 17 17 0 0 0 17 17 1 1 0 0 0 1-1v-3.5a1 1 0 0 0-1-1z"/></svg>`,
  back: `<svg viewBox="0 0 24 24"><path d="M12 4l1.4 1.4L7.8 11H20v2H7.8l5.6 5.6L12 20l-8-8z"/></svg>`,
  play: `<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24"><path d="M6 4.5h4v15H6zm8 0h4v15h-4z"/></svg>`,
  reply: `<svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>`,
  down: `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 15.6 5.7 9.3l1.4-1.4 4.9 4.9 4.9-4.9 1.4 1.4z"/></svg>`,
  dl: `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 16l-5-5h3V4h4v7h3zm-7 2h14v2H5z"/></svg>`,
};

const tick = (status) => {
  if (status === "pending") return `<svg class="tick" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>`;
  if (status === "error") return `<svg class="tick err" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5v4.2M8 11v.3"/></svg>`;
  const cls = status === "read" || status === "played" ? " read" : "";
  if (status === "sent") return `<svg class="tick" viewBox="0 0 16 11"><path d="M2 6l3.2 3.2L13 1.5"/></svg>`;
  return `<svg class="tick${cls}" viewBox="0 0 18 11"><path d="M1 6l3.2 3.2L11 1.5"/><path d="M7.5 8.6l.6.6L16 1.5"/></svg>`;
};

// ─── formatação ─────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, "0");
const fmtTime = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayKey = (iso) => new Date(iso).toDateString();
const fmtDay = (iso) => {
  const d = new Date(iso), now = new Date();
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86_400_000);
  if (days === 0) return "Hoje";
  if (days === 1) return "Ontem";
  if (days < 7) return d.toLocaleDateString("pt-BR", { weekday: "long" });
  return d.toLocaleDateString("pt-BR");
};
const fmtListTime = (iso) => {
  const day = fmtDay(iso);
  return day === "Hoje" ? fmtTime(iso) : day;
};
const fmtDur = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
const fmtSize = (b) => (!b ? "" : b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} kB` : `${(b / 1048576).toFixed(1)} MB`);
const ext = (m) => (m.media?.fileName?.split(".").pop() || m.media?.mimetype?.split("/").pop()?.split(";")[0] || "arq").slice(0, 4).toUpperCase();

/** Formatação do WhatsApp: *negrito*, _itálico_, ~riscado~, ```mono``` e links. */
const formatText = (text) => {
  let h = esc(text);
  h = h.replace(/```([\s\S]+?)```/g, "<code>$1</code>");
  const wrap = (ch, tag) => {
    const c = ch.replace(/[*~]/g, "\\$&");
    h = h.replace(new RegExp(`(^|[\\s(>])${c}(\\S(?:[^${c}\\n]*\\S)?)${c}(?=[\\s).,!?:;<]|$)`, "g"), `$1<${tag}>$2</${tag}>`);
  };
  wrap("*", "b"); wrap("_", "i"); wrap("~", "s");
  return h.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
};
const onlyEmoji = (t) => !!t && t.length <= 12 && /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(t) && !/\d/.test(t);

export const preview = (m) => {
  if (!m) return "";
  switch (m.type) {
    case "text": return m.text ?? "";
    case "image": return `📷 ${m.text || "Foto"}`;
    case "video": return `🎥 ${m.text || "Vídeo"}`;
    case "audio": return `🎤 ${m.media?.ptt ? "Áudio" : "Arquivo de áudio"} ${m.media?.seconds ? fmtDur(m.media.seconds) : ""}`;
    case "document": return `📄 ${m.media?.fileName || m.text || "Documento"}`;
    case "sticker": return "💟 Figurinha";
    case "location": return `📍 ${m.location?.name || "Localização"}`;
    case "contact": return `👤 ${m.contact?.name || "Contato"}`;
    case "reaction": return `Reagiu ${m.text ?? ""}`;
    default: return "Mensagem";
  }
};

/** Barras do áudio: alturas fixas derivadas do id (o WhatsApp não manda a onda). */
const bars = (id, n = 38) => {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Array.from({ length: n }, (_, i) => {
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    const v = 0.25 + ((h % 1000) / 1000) * 0.75 * (0.6 + 0.4 * Math.sin(i / 3));
    return Math.round(Math.max(0.15, Math.min(1, v)) * 100);
  });
};

/** Tile do OpenStreetMap com o ponto centralizado. */
const osmTile = (lat, lng, z = 15) => {
  const n = 2 ** z, x = ((lng + 180) / 360) * n;
  const r = (lat * Math.PI) / 180, y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  const tx = Math.floor(x), ty = Math.floor(y);
  // 3×3 tiles em volta do ponto, deslocados para o ponto ficar no centro.
  const urls = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) urls.push(`https://tile.openstreetmap.org/${z}/${tx + dx}/${ty + dy}.png`);
  return { urls, left: -(x - tx) * 256 - 256, top: -(y - ty) * 256 - 256 };
};

const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error("Não foi possível ler o arquivo"));
  r.readAsDataURL(file);
});

const initials = (name) => {
  const w = String(name ?? "").replace(/[^\p{L}\s]/gu, "").trim().split(/\s+/).filter(Boolean);
  return w.length ? (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase() : "👤";
};

// ─── componente ─────────────────────────────────────────────────────────

/**
 * Monta o chat em `root`. Um ou vários números (linhas) na mesma caixa de entrada.
 * opts: {
 *   lines: [{ id, name, phone }] (ou função que retorna a lista) — ou `lineId` para um número só,
 *   me: { id, name, kind } (ou função), canCall: (lineId) => bool, onCall: (numero, lineId) => void,
 *   onUnread: (conversasNãoLidas) => void,
 * }
 * Cada conversa é identificada por linha + contato (o mesmo cliente pode falar com dois números).
 */
export const mountChat = (root, { lineId, lines: linesOpt, me: meOpt = null, canCall = () => false, onCall = () => {}, onUnread = () => {} }) => {
  const linesList = () => (typeof linesOpt === "function" ? linesOpt() : linesOpt) ?? (lineId ? [{ id: lineId }] : []);
  const multi = () => linesList().length > 1;
  const lineName = (id) => { const l = linesList().find((x) => x.id === id); return l?.name ?? (l?.phone ? fmtPhone(l.phone) : "Número"); };
  const SEP = "~";
  const keyOf = (line, remote) => `${line}${SEP}${remote}`;
  const kOf = (x) => keyOf(x.lineId, x.remote);
  const lineOf = (key) => String(key).slice(0, String(key).indexOf(SEP));
  const remoteOf = (key) => String(key).slice(String(key).indexOf(SEP) + 1);
  const qs = (line) => `line=${encodeURIComponent(line)}`;
  /** Usuário logado ({ id, name, kind }); pode chegar depois da montagem. */
  const who = () => (typeof meOpt === "function" ? meOpt() : meOpt);
  const vapi = async (method, path, body, line) => {
    const res = await fetch(`/api/v1${path}${path.includes("?") ? "&" : "?"}${qs(line)}`, {
      method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { location.href = "/login"; throw new Error("Sessão expirada"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Erro ${res.status}`);
    return data;
  };
  const mediaSrc = (m) => `/api/v1/messages/${encodeURIComponent(m.id)}/media?${qs(m.lineId)}`;
  const photoSrc = (key, jid) =>
    `/api/v1/contacts/${encodeURIComponent(remoteOf(key))}/photo?${qs(lineOf(key))}${jid ? `&jid=${encodeURIComponent(jid)}` : ""}`;

  /** @type {{remote:string, remoteJid?:string, name?:string, unread:number, last:any}[]} */
  let chats = [];
  /** remote -> { list: mensagens em ordem crescente, hasMore, loading } */
  const convs = new Map();
  let active = null;
  let replyTo = null;
  /** lineId -> conectado? */
  const online = new Map();
  const isOnline = (line) => online.get(line) !== false;
  /** Filtro de número na lista ("" = todos). */
  let lineFilter = "";
  /** Números cujas conversas já foram carregadas. */
  const loadedLines = new Set();
  let filter = "";
  let tmpSeq = 0;
  /** Aba da lista: open (abertas e aguardando) | mine | unassigned | resolved. */
  let listFilter = "open";
  /** lineId -> atendentes / respostas rápidas daquele número. */
  const agents = new Map();
  const quickReplies = new Map();
  /** chave da conversa -> ligações com o contato (para a linha do tempo). */
  const callsOf = new Map();
  /** Contatos da agenda que batem com a pesquisa (de todos os números). */
  let contactHits = [];
  let searchTimer = null, searchSeq = 0;

  root.innerHTML = `
  <div class="wa">
    <aside class="wa-side">
      <div class="wa-side-head">
        <h3>Conversas</h3>
        <button class="wa-ico" data-a="new" title="Nova conversa">${ICON.plus}</button>
      </div>
      <form class="wa-new" hidden>
        <select name="line" class="wa-new-line" title="Enviar pelo número"></select>
        <input name="num" inputmode="tel" placeholder="Número com DDI e DDD (ex.: 5581999999999)" autocomplete="off">
        <button type="submit">Abrir</button>
      </form>
      <div class="wa-search"><input type="search" placeholder="Pesquisar conversa ou contato (nome ou número)"></div>
      <div class="wa-linebar" hidden><select class="wa-linesel" title="Número"></select></div>
      <div class="wa-filters">
        <button data-f="open" class="on">Abertas</button>
        <button data-f="mine">Minhas</button>
        <button data-f="unassigned">Sem responsável</button>
        <button data-f="resolved">Resolvidas</button>
      </div>
      <div class="wa-list"></div>
    </aside>
    <section class="wa-main">
      <div class="wa-placeholder">
        <div>
          <div style="font-size:64px">💬</div>
          <h2>Mensagens do WhatsApp</h2>
          <div>Escolha uma conversa ao lado ou comece uma nova com o <b>+</b>.<br>
          Envie textos, áudios, fotos, vídeos, documentos e figurinhas pelo WhatsApp da empresa.</div>
        </div>
      </div>
      <div class="wa-chat" hidden style="display:contents">
        <header class="wa-head">
          <button class="wa-ico wa-back" data-a="back" title="Voltar">${ICON.back}</button>
          <div class="wa-av small wa-head-av"></div>
          <div class="who"><b></b><small></small></div>
          <div class="wa-head-tools">
            <button class="wa-take" data-a="take" hidden>Assumir</button>
            <select class="wa-assign" title="Responsável"></select>
            <select class="wa-status" title="Situação">
              <option value="open">Aberta</option><option value="pending">Aguardando cliente</option><option value="resolved">Resolvida</option>
            </select>
          </div>
          <button class="wa-ico" data-a="call" title="Ligar pelo WhatsApp">${ICON.phone}</button>
          <button class="wa-ico" data-a="info" title="Dados do contato"><svg viewBox="0 0 24 24"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z"/></svg></button>
        </header>
        <aside class="wa-info" hidden>
          <div class="wa-info-head"><button class="wa-ico" data-a="info-close" title="Fechar">✕</button><b>Dados do contato</b></div>
          <div class="wa-info-body">
            <div class="wa-info-av"></div>
            <label>Nome na equipe<input class="wa-f-name" maxlength="80" placeholder="Nome do perfil no WhatsApp"></label>
            <div class="wa-info-sub"></div>
            <button class="wa-hide" data-a="hide-contact" hidden>Ocultar este contato</button>
            <label>Notas internas (o contato não vê)<textarea class="wa-f-notes" rows="5" placeholder="Ex.: cliente desde 2021, prefere contato à tarde"></textarea></label>
            <h5>Ligações</h5>
            <div class="wa-info-calls"></div>
          </div>
        </aside>
        <div class="wa-pop wa-qr" hidden></div>
        <div class="wa-msgs"></div>
        <button class="wa-ico wa-down" data-a="down" hidden>${ICON.down}</button>
        <div class="wa-offline" hidden>Telefone desconectado: não é possível enviar mensagens agora.</div>
        <div class="wa-reply" hidden><div class="wa-quote"></div><button class="wa-ico" data-a="cancel-reply" title="Cancelar">✕</button></div>
        <div class="wa-compose">
          <button class="wa-ico" data-a="emoji" title="Emojis">${ICON.emoji}</button>
          <button class="wa-ico" data-a="attach" title="Anexar">${ICON.clip}</button>
          <textarea rows="1" placeholder="Digite uma mensagem"></textarea>
          <button class="wa-ico wa-sendbtn" data-a="send" title="Gravar áudio">${ICON.mic}</button>
        </div>
        <div class="wa-rec" hidden>
          <button class="wa-ico" data-a="rec-cancel" title="Descartar">${ICON.trash}</button>
          <span class="dot"></span><span class="t">0:00</span>
          <button class="wa-ico wa-sendbtn" data-a="rec-send" title="Enviar áudio">${ICON.send}</button>
        </div>
        <div class="wa-pop wa-emoji" hidden>${EMOJIS.map((e) => `<button data-emoji="${e}">${e}</button>`).join("")}</div>
        <div class="wa-pop wa-attach" hidden>
          <button data-pick="media"><span class="i" style="background:#bf59cf">🖼️</span>Fotos e vídeos</button>
          <button data-pick="document"><span class="i" style="background:#7f66ff">📄</span>Documento</button>
          <button data-pick="audio"><span class="i" style="background:#f29f3a">🎵</span>Áudio (arquivo)</button>
          <button data-pick="sticker"><span class="i" style="background:#02a698">💟</span>Figurinha (.webp)</button>
        </div>
        <input type="file" class="wa-file" hidden>
      </div>
    </section>
  </div>`;

  const el = (s) => root.querySelector(s);
  const touch = matchMedia("(hover: none)").matches;
  // Sem rolar a página; em telas de toque não abre o teclado sozinho.
  const focusInput = (force = false) => { if (force || !touch) input.focus({ preventScroll: true }); };
  const wa = el(".wa"), list = el(".wa-list"), box = el(".wa-msgs"), input = el(".wa-compose textarea");
  const sendBtn = el('[data-a="send"]'), fileInput = el(".wa-file");

  // Fotos de perfil que não existem: some a imagem, ficam as iniciais e não pede de novo.
  const noPhoto = new Set();
  root.addEventListener("error", (e) => {
    if (!e.target.matches?.(".wa-av img")) return;
    noPhoto.add(e.target.dataset.key);
    e.target.remove();
  }, true);

  const chatOf = (key) => chats.find((c) => c.key === key);
  const isGroup = (remote) => String(remote).endsWith("@g.us");
  const nameOf = (key) => {
    const c = chatOf(key);
    const remote = remoteOf(key);
    return c?.name || c?.profileName || (isGroup(remote) ? "Grupo" : remote.includes("@") ? "Contato" : fmtPhone(remote));
  };
  const avatar = (key, cls = "") => {
    const c = chatOf(key);
    const img = noPhoto.has(key) ? "" : `<img alt="" loading="lazy" data-key="${esc(key)}" src="${photoSrc(key, c?.remoteJid)}">`;
    return `<div class="wa-av ${cls}">${isGroup(key) ? "👥" : esc(initials(c?.name || c?.profileName))}${img}</div>`;
  };
  /** Cria (se preciso) a conversa na lista. */
  const ensureChat = (line, remote, extra = {}) => {
    const key = keyOf(line, remote);
    let c = chatOf(key);
    if (!c) { c = { key, lineId: line, remote, unread: 0, last: null, status: "open", isGroup: isGroup(remote), ...extra }; chats.unshift(c); }
    return c;
  };
  /** Cor estável por pessoa (nomes nos grupos). */
  const hue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  const STATUS_LABEL = { open: "Aberta", pending: "Aguardando cliente", resolved: "Resolvida" };

  // ─── lista ────────────────────────────────────────────────────────────

  let renderList = () => {
    onUnread(chats.reduce((n, c) => n + (c.unread ? 1 : 0), 0));
    const f = filter.trim().toLowerCase();
    const byTab = (c) => {
      const st = c.status ?? "open";
      if (listFilter === "resolved") return st === "resolved";
      if (st === "resolved") return c.key === active;
      if (listFilter === "mine") return !!who()?.id && c.assignedUserId === who().id;
      if (listFilter === "unassigned") return !c.assignedUserId;
      return true;
    };
    const shown = chats.filter((c) => (!lineFilter || c.lineId === lineFilter) && (f
      ? (nameOf(c.key).toLowerCase().includes(f) || c.remote.includes(f.replace(/\D/g, "") || "§"))
      : byTab(c)));
    for (const b of root.querySelectorAll(".wa-filters button")) b.classList.toggle("on", !f && b.dataset.f === listFilter);
    // Pesquisa: contatos da agenda sem conversa na lista (como no WhatsApp Web).
    const hits = f ? contactHits.filter((h) => !shown.some((c) => c.key === h.key) && (!lineFilter || h.lineId === lineFilter)) : [];
    if (!shown.length && hits.length) { list.innerHTML = `<div class="wa-sect">Contatos</div>${hits.map(hitHtml).join("")}`; return; }
    if (!shown.length) {
      list.innerHTML = `<div class="wa-list-empty">${chats.length ? (f ? "Nenhuma conversa encontrada." : "Nenhuma conversa aqui.") :
        "Nenhuma mensagem ainda.<br>As mensagens recebidas por este número aparecem aqui.<br>Para começar, toque no <b>+</b>."}</div>`;
      return;
    }
    list.innerHTML = shown.map((c) => {
      const m = c.last;
      const mine = m?.direction === "outgoing";
      return `<div class="wa-item${c.key === active ? " active" : ""}" data-key="${esc(c.key)}">
        ${avatar(c.key)}
        <div class="wa-item-main">
          <div class="wa-item-top"><span class="wa-name">${esc(nameOf(c.key))}</span>
            ${multi() ? `<span class="wa-line" title="Número da empresa">${esc(lineName(c.lineId))}</span>` : ""}
            <span class="wa-time${c.unread ? " unread" : ""}">${m ? fmtListTime(m.timestamp) : ""}</span></div>
          <div class="wa-item-bot"><span class="wa-prev">${mine ? tick(m.status) : ""}${m?.deletedAt ? "🚫 Mensagem apagada" : esc((isGroup(c.remote) && m?.participantName ? `${m.participantName}: ` : "") + preview(m))}</span>
            ${c.status === "pending" ? `<span class="wa-who" title="Aguardando cliente">⏳</span>` : ""}
            ${c.assignedName ? `<span class="wa-who" title="Responsável">${esc(c.assignedName.split(" ")[0])}</span>` : ""}
            ${c.unread ? `<span class="wa-badge">${c.unread}</span>` : ""}</div>
        </div></div>`;
    }).join("") + (hits.length ? `<div class="wa-sect">Contatos</div>${hits.map(hitHtml).join("")}` : "");
    if (hits.length) list.insertAdjacentHTML("afterbegin", `<div class="wa-sect">Conversas</div>`);
  };

  /** Contato da agenda na pesquisa: nome, número e (com vários números) por qual número. */
  const hitHtml = (h) => `<div class="wa-item" data-key="${esc(h.key)}" data-hit="1">
      <div class="wa-av">${esc(initials(h.name))}${noPhoto.has(h.key) ? "" : `<img alt="" loading="lazy" data-key="${esc(h.key)}" src="${photoSrc(h.key, h.remoteJid)}">`}</div>
      <div class="wa-item-main">
        <div class="wa-item-top"><span class="wa-name">${esc(h.name || (h.remote.includes("@") ? "Contato" : fmtPhone(h.remote)))}</span>
          ${multi() ? `<span class="wa-line" title="Número da empresa">${esc(lineName(h.lineId))}</span>` : ""}</div>
        <div class="wa-item-bot"><span class="wa-prev">${esc([h.remote.includes("@") ? "" : fmtPhone(h.remote), h.pushName && h.pushName !== h.name ? `~${h.pushName}` : ""].filter(Boolean).join(" · "))}</span></div>
      </div></div>`;

  /** Busca na agenda de cada número (com atraso, enquanto digita). */
  const searchContacts = () => {
    clearTimeout(searchTimer);
    const q = filter.trim();
    if (q.length < 2) { contactHits = []; return; }
    const seq = ++searchSeq;
    searchTimer = setTimeout(async () => {
      const found = await Promise.all(linesList().filter((l) => !lineFilter || l.id === lineFilter).map((l) =>
        vapi("GET", `/contacts?q=${encodeURIComponent(q)}&limit=30`, undefined, l.id)
          .then((list) => list.map((h) => ({ ...h, lineId: l.id, key: keyOf(l.id, h.remote) })))
          .catch(() => [])));
      if (seq !== searchSeq) return;
      contactHits = found.flat();
      renderList();
    }, 250);
  };

  const touchChat = (m) => {
    let c = chatOf(kOf(m));
    if (!c) { c = { key: kOf(m), lineId: m.lineId, remote: m.remote, remoteJid: m.remoteJid, unread: 0, last: null, status: "open", isGroup: isGroup(m.remote) }; chats.push(c); }
    if (m.pushName) {
      // Nome definido pela equipe tem prioridade sobre o do perfil.
      if (!c.name || c.name === c.profileName) c.name = m.pushName;
      c.profileName = m.pushName;
    }
    c.remoteJid ??= m.remoteJid;
    if (m.type !== "reaction" && (!c.last || c.last.id === m.id || m.timestamp >= c.last.timestamp)) c.last = m;
    chats.sort((a, b) => (b.last?.timestamp ?? "9").localeCompare(a.last?.timestamp ?? "9"));
    return c;
  };

  // ─── conversa ─────────────────────────────────────────────────────────

  const conv = (key) => {
    let c = convs.get(key);
    if (!c) convs.set(key, (c = { list: [], hasMore: true, loading: false, loaded: false }));
    return c;
  };

  const upsert = (m) => {
    const c = conv(kOf(m));
    const i = c.list.findIndex((x) => x.id === m.id);
    if (i >= 0) c.list[i] = { ...c.list[i], ...m };
    else {
      c.list.push(m);
      c.list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }
  };

  const findMsg = (key, id) => convs.get(key)?.list.find((m) => m.id === id);

  const quoteHtml = (m, targetId, cls = "") => {
    const t = targetId ? findMsg(m ? kOf(m) : active, targetId) : m;
    const who = !t ? "" : t.direction === "outgoing" ? "Você" : nameOf(kOf(t));
    return `<div class="wa-quote ${t?.direction === "incoming" ? "in" : ""} ${cls}" data-jump="${esc(targetId ?? t?.id ?? "")}">
      <b>${esc(who || "Mensagem")}</b><span>${esc(t ? preview(t) : "Mensagem anterior")}</span></div>`;
  };

  const contentHtml = (m) => {
    const src = mediaSrc(m);
    // Ainda não enviada (ou falhou): não há mídia no servidor.
    const local = m.pending || m.id.startsWith("tmp-");
    const caption = m.text ? `<div class="wa-text">${formatText(m.text)}</div>` : "";
    if (m.deletedAt) return `<div class="wa-deleted">🚫 ${m.direction === "outgoing" ? "Você apagou esta mensagem" : "Mensagem apagada"}</div>`;
    switch (m.type) {
      case "text":
        return `<div class="wa-text${onlyEmoji(m.text) ? " big-emoji" : ""}">${formatText(m.text ?? "")}</div>`;
      case "image":
        return local ? `<div class="wa-missing">📷 ${m.pending ? "Enviando foto…" : "Foto"}</div>${caption}`
          : `<img class="wa-img" loading="lazy" src="${src}" data-zoom alt="Foto">${caption}`;
      case "video":
        return local ? `<div class="wa-missing">🎥 ${m.pending ? "Enviando vídeo…" : "Vídeo"}</div>${caption}`
          : `<video class="wa-video" controls preload="none" src="${src}"></video>${caption}`;
      case "sticker":
        return local ? `<div class="wa-missing">💟 Figurinha</div>` : `<img class="wa-sticker" loading="lazy" src="${src}" alt="Figurinha">`;
      case "audio": {
        const ptt = m.media?.ptt;
        const b = bars(m.id).map((h) => `<i style="height:${h}%"></i>`).join("");
        const av = ptt
          ? `<div class="wa-audio-av">${m.direction === "outgoing" ? `<div class="wa-av">🎧</div>` : avatar(kOf(m))}<span class="mic">🎤</span></div>`
          : `<div class="wa-audio-av">🎵</div>`;
        return `<div class="wa-audio${ptt ? "" : " file"}" data-audio="${esc(m.id)}" data-src="${local ? "" : src}">
          ${m.direction === "outgoing" ? "" : av}
          <button class="wa-play" data-a="play">${local ? "⏳" : ICON.play}</button>
          <div class="wa-wave"><div class="wa-bars">${b}</div>
            <div class="wa-audio-meta"><span class="cur">${fmtDur(m.media?.seconds)}</span></div></div>
          ${m.direction === "outgoing" ? av : ""}
        </div>${m.transcript ? `<div class="wa-transcript" title="Transcrição automática">📝 <b>${esc(m.direction === "incoming" ? (m.participantName || nameOf(kOf(m))) : (m.agent || "Atendente"))}:</b> ${esc(m.transcript)}</div>` : ""}`;
      }
      case "document": {
        const name = m.media?.fileName || "Documento";
        const e = ext(m);
        return `<a class="wa-doc" ${local ? "" : `href="${src}" download="${esc(name)}"`}>
          <span class="wa-doc-ico${e === "PDF" ? " pdf" : ""}">${esc(e)}</span>
          <span class="wa-doc-name"><b>${esc(name)}</b><small>${[fmtSize(m.media?.size), e].filter(Boolean).join(" · ")}</small></span>
          <span class="wa-doc-dl">${local ? "⏳" : ICON.dl}</span></a>${m.text && m.text !== name ? caption : ""}`;
      }
      case "location": {
        const { latitude: lat, longitude: lng, name, address } = m.location ?? {};
        const t = osmTile(lat, lng);
        return `<a class="wa-loc" href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener noreferrer">
          <div class="wa-loc-map"><div class="wa-loc-tiles" style="left:calc(50% + ${t.left}px);top:calc(50% + ${t.top}px)">${t.urls.map((u) => `<img src="${u}" alt="" loading="lazy">`).join("")}</div><span class="pin">📍</span></div>
          ${name || address ? `<div class="wa-loc-text">${esc(name ?? "")}<small>${esc(address ?? "")}</small></div>` : ""}</a>`;
      }
      case "contact": {
        const tel = /waid=(\d+)/.exec(m.contact?.vcard ?? "")?.[1] ?? /TEL[^:]*:([+\d\s()-]+)/.exec(m.contact?.vcard ?? "")?.[1]?.replace(/\D/g, "");
        return `<div class="wa-contact"><div class="wa-av small">${esc(initials(m.contact?.name))}</div>
          <div><b>${esc(m.contact?.name ?? "Contato")}</b><small>${tel ? esc(fmtPhone(tel)) : ""}</small></div></div>
          ${tel ? `<button class="wa-contact-btn" data-open="${esc(tel)}">Conversar</button>` : ""}`;
      }
      default:
        return `<div class="wa-unsupported">Mensagem não suportada neste painel${m.text ? ` (${esc(m.text)})` : ""}. Veja no celular.</div>`;
    }
  };

  /** Reações por mensagem: a mais recente de cada lado vale; vazia remove. */
  const reactionsOf = (items) => {
    const out = new Map();
    for (const r of items) {
      if (r.type !== "reaction" || !r.replyTo) continue;
      const per = out.get(r.replyTo) ?? new Map();
      if (r.text) per.set(r.direction, r.text); else per.delete(r.direction);
      out.set(r.replyTo, per);
    }
    return out;
  };

  const renderMessages = (keepScroll = false) => {
    const c = convs.get(active);
    if (!c) { box.innerHTML = ""; return; }
    const prevHeight = box.scrollHeight, prevTop = box.scrollTop;
    const reacts = reactionsOf(c.list);
    let html = c.hasMore && c.list.length ? `<div class="wa-more">${c.loading ? "Carregando…" : "Role para cima para ver mais"}</div>` : "";
    // Fim do que está no gateway: dá para pedir as mensagens mais antigas ao celular.
    if (!c.hasMore && c.loaded && c.list.some((m) => !m.pending)) {
      html = `<div class="wa-more">${c.fetching ? "Buscando mensagens antigas no celular…"
        : c.phoneDone ? "O celular não enviou mensagens mais antigas."
        : `<button class="wa-older" data-a="older-phone">Buscar mensagens mais antigas no celular</button>`}</div>`;
    }
    let lastDay = "", lastDir = "", lastTs = 0, lastWho = "";
    // Mensagens + ligações com o contato, em ordem de tempo.
    const oldest = c.hasMore ? c.list[0]?.timestamp ?? "" : "";
    const items = c.list.filter((m) => m.type !== "reaction").map((m) => ({ ts: m.timestamp, m }))
      .concat((callsOf.get(active) ?? []).filter((x) => x.startedAt >= oldest).map((call) => ({ ts: call.startedAt, call })))
      .sort((a, b) => a.ts.localeCompare(b.ts));
    for (const item of items) {
      const day = dayKey(item.ts);
      if (day !== lastDay) { html += `<div class="wa-day">${esc(fmtDay(item.ts))}</div>`; lastDir = ""; lastDay = day; }
      if (item.call) { html += callHtml(item.call); lastDir = ""; continue; }
      const m = item.m;
      const ts = new Date(m.timestamp).getTime();
      const who = m.participant ?? "";
      const first = m.direction !== lastDir || ts - lastTs > 10 * 60_000 || who !== lastWho;
      lastDir = m.direction; lastTs = ts; lastWho = who;
      const bare = m.type === "sticker" || (m.type === "text" && onlyEmoji(m.text));
      const media = ["image", "video"].includes(m.type);
      const metaOver = bare || (media && !m.text);
      const out = m.direction === "outgoing";
      const r = reacts.get(m.id);
      html += `<div class="wa-row ${out ? "out" : "in"}${first ? " first" : ""}" data-id="${esc(m.id)}">
        <div class="wa-bubble${bare ? " bare" : ""}${media ? " media" : ""}">
          ${out && m.agent && first ? `<div class="wa-agent">${esc(m.agent)}</div>` : ""}
          ${!out && first && isGroup(m.remote) ? `<div class="wa-agent" style="color:hsl(${hue(who)} 65% 70%)">${esc(m.participantName || (who ? fmtPhone(who) : "Participante"))}</div>` : ""}
          ${m.replyTo ? quoteHtml(m, m.replyTo) : ""}
          ${contentHtml(m)}
          <span class="wa-meta${metaOver ? " over" : ""}">${m.editedAt && !m.deletedAt ? "<i>editada</i> " : ""}${fmtTime(m.timestamp)}${out ? tick(m.status) : ""}</span>
          ${m.pending || m.status === "error" || m.deletedAt ? "" : `<div class="wa-actions">
            <button data-a="react" title="Reagir">😊</button>
            <button data-a="reply" title="Responder">${ICON.reply}</button>
          </div>`}
        </div>
        ${r?.size ? `<div class="wa-reacts" title="${esc([...r].map(([d, e]) => `${d === "outgoing" ? "Você" : nameOf(kOf(m))}: ${e}`).join("\n"))}">${[...new Set(r.values())].map((e) => `<span>${e}</span>`).join("")}${r.size > 1 ? `<small>&nbsp;${r.size}</small>` : ""}</div>` : ""}
      </div>`;
    }
    box.innerHTML = html || `<div class="wa-day">Nenhuma mensagem ainda. Diga oi! 👋</div>`;
    if (keepScroll) box.scrollTop = box.scrollHeight - prevHeight + prevTop;
    syncPlayerUi();
  };

  /** Ligação na linha do tempo (com gravação e transcrição quando houver). */
  const callHtml = (call) => {
    const answered = !!call.connectedAt;
    const incoming = call.direction === "incoming";
    const icon = answered ? (incoming ? "📞" : "📲") : "📵";
    const what = answered ? (incoming ? "Ligação recebida" : "Ligação feita") : (incoming ? "Ligação perdida" : "Ligação não atendida");
    const dur = answered && call.endedAt ? fmtDur((new Date(call.endedAt) - new Date(call.connectedAt)) / 1000) : "";
    const rec = call.hasRecording ? `<div class="wa-audio file" data-audio="call-${esc(call.id)}" data-src="/api/v1/calls/${encodeURIComponent(call.id)}/recording?${qs(call.lineId ?? lineOf(active))}">
        <button class="wa-play" data-a="play">${ICON.play}</button>
        <div class="wa-wave"><div class="wa-bars">${bars(call.id).map((h) => `<i style="height:${h}%"></i>`).join("")}</div>
          <div class="wa-audio-meta"><span class="cur">${fmtDur(call.recordingSeconds)}</span></div></div></div>` : "";
    return `<div class="wa-call${answered ? "" : " missed"}">
      <div class="wa-call-line">${icon} <b>${what}</b> · ${fmtTime(call.startedAt)}${dur ? ` · ${dur}` : ""}${call.ownerAgent ? ` · ${esc(call.ownerAgent)}` : ""}</div>
      ${rec}${call.transcript ? `<details class="wa-call-tr"><summary>📝 Transcrição</summary>${transcriptHtml(call, nameOf(keyOf(call.lineId ?? lineOf(active), call.remote)))}</details>` : ""}
    </div>`;
  };

  // ─── atendimento (responsável, situação, dados do contato) ────────────

  const patchContact = async (key, patch) => {
    try {
      const c = await vapi("PATCH", `/contacts/${encodeURIComponent(remoteOf(key))}`, patch, lineOf(key));
      applyContact({ ...c, lineId: lineOf(key) });
    } catch (err) { toast(err.message); renderHead(); }
  };

  /** `ct` precisa trazer o lineId (os eventos e respostas da API trazem só o contato). */
  const applyContact = (ct) => {
    const key = keyOf(ct.lineId, ct.remote);
    const c = chatOf(key);
    if (c) {
      const profile = c.profileName;
      Object.assign(c, { status: ct.status, assignedUserId: ct.assignedUserId, assignedName: ct.assignedName, notes: ct.notes });
      c.name = ct.name || c.phoneName || profile || c.name;
      c.customName = ct.name ?? null;
    }
    renderList();
    if (key === active) renderHead();
  };

  const renderHead = () => {
    const c = chatOf(active);
    if (!c) return;
    el(".wa-head .who b").textContent = nameOf(active);
    const sel = el(".wa-assign");
    const opts = [...(agents.get(c.lineId) ?? [])];
    if (c.assignedUserId && !opts.some((a) => a.id === c.assignedUserId)) opts.push({ id: c.assignedUserId, name: c.assignedName ?? "?" });
    sel.innerHTML = `<option value="">Sem responsável</option>` + opts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("");
    sel.value = c.assignedUserId ?? "";
    el(".wa-status").value = c.status ?? "open";
    el('[data-a="take"]').hidden = !who()?.id || c.assignedUserId === who().id || who().kind !== "user";
    if (!el(".wa-info").hidden) renderInfo();
  };

  const renderInfo = () => {
    const c = chatOf(active);
    if (!c) return;
    el(".wa-info-av").innerHTML = avatar(active) + `<b>${esc(nameOf(active))}</b>`;
    const name = el(".wa-f-name"), notes = el(".wa-f-notes");
    if (document.activeElement !== name) { name.value = c.customName ?? ""; name.placeholder = c.profileName || "Nome"; }
    if (document.activeElement !== notes) notes.value = c.notes ?? "";
    el(".wa-info-sub").textContent = (isGroup(active) ? "Grupo do WhatsApp" : [fmtPhone(remoteOf(active)),
      c.phoneName ? `agenda: ${c.phoneName}` : "", c.profileName ? `perfil: ${c.profileName}` : ""].filter(Boolean).join(" · "))
      + (multi() ? ` · número: ${lineName(c.lineId)}` : "");
    el(".wa-hide").hidden = !who()?.isAdmin || isGroup(active) || remoteOf(active).includes("@");
    const calls = callsOf.get(active) ?? [];
    el(".wa-info-calls").innerHTML = calls.length
      ? calls.slice().reverse().slice(0, 20).map((call) => `<div class="wa-info-call">${fmtDay(call.startedAt)} ${fmtTime(call.startedAt)} — ${callHtml(call)}</div>`).join("")
      : `<div class="wa-info-empty">Nenhuma ligação com este contato.</div>`;
  };

  const loadContact = async (key) => {
    try {
      const ct = await vapi("GET", `/contacts/${encodeURIComponent(remoteOf(key))}`, undefined, lineOf(key));
      callsOf.set(key, (ct.calls ?? []).slice().reverse());
      ensureChat(lineOf(key), remoteOf(key));
      applyContact({ ...ct, lineId: lineOf(key) });
      if (key === active) renderMessages(true);
    } catch (err) { toast(err.message); }
  };

  const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  const scrollBottom = () => { box.scrollTop = box.scrollHeight; el(".wa-down").hidden = true; };

  const loadOlder = async () => {
    const c = convs.get(active);
    if (!c || c.loading || !c.hasMore) return;
    c.loading = true;
    const key = active;
    try {
      const oldest = c.list[0]?.timestamp;
      const page = await vapi("GET", `/messages?contact=${encodeURIComponent(remoteOf(key))}&limit=${PAGE}${oldest ? `&before=${encodeURIComponent(oldest)}` : ""}`, undefined, lineOf(key));
      page.forEach(upsert);
      c.hasMore = page.length === PAGE;
      c.loaded = true;
    } catch (err) {
      toast(err.message);
    } finally {
      c.loading = false;
    }
    if (active === key) renderMessages(true);
  };

  /** Pede ao celular as mensagens anteriores da conversa; elas chegam pelo evento `history`. */
  const fetchOlderFromPhone = async () => {
    const key = active;
    const c = convs.get(key);
    if (!c || c.fetching) return;
    c.fetching = true;
    renderMessages(true);
    try {
      await vapi("POST", `/chats/${encodeURIComponent(remoteOf(key))}/sync`, {}, lineOf(key));
    } catch (err) {
      c.fetching = false;
      toast(err.message);
      if (active === key) renderMessages(true);
      return;
    }
    clearTimeout(c.fetchTimer);
    // Sem resposta (ou nada mais antigo no celular): para de esperar.
    c.fetchTimer = setTimeout(() => {
      if (!c.fetching) return;
      c.fetching = false;
      c.phoneDone = true;
      if (active === key) renderMessages(true);
    }, 30_000);
  };

  /** Recarrega a lista de conversas de um número (depois de chegar histórico), sem perder as novas. */
  const reloadTimers = new Map();
  const scheduleReload = (line) => {
    clearTimeout(reloadTimers.get(line));
    reloadTimers.set(line, setTimeout(async () => {
      const keep = chats.filter((c) => c.lineId === line && !c.last);
      await loadLine(line).catch(() => {});
      for (const c of keep) if (!chatOf(c.key)) chats.push(c);
      renderList();
    }, 1500));
  };

  const openChat = async (key) => {
    if (!key) return;
    active = key;
    const remote = remoteOf(key), line = lineOf(key);
    replyTo = null;
    el(".wa-reply").hidden = true;
    wa.classList.add("show-chat");
    el(".wa-placeholder").hidden = true;
    el(".wa-chat").hidden = false;
    el(".wa-head-av").outerHTML = avatar(key, "small wa-head-av");
    el(".wa-head .who b").textContent = nameOf(key);
    el(".wa-head .who small").textContent = (isGroup(remote) ? "Grupo" : remote.includes("@") ? "" : fmtPhone(remote))
      + (multi() ? ` · via ${lineName(line)}` : "");
    el('[data-a="call"]').hidden = !canCall(line) || remote.includes("@");
    syncOnline();
    renderList();
    renderHead();
    void loadContact(key);
    const c = conv(key);
    if (!c.loaded) { c.list = c.list.filter((m) => m.pending); c.hasMore = true; await loadOlder(); }
    renderMessages();
    scrollBottom();
    markRead();
    focusInput();
  };

  let readTimer = null;
  const markRead = () => {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const c = chatOf(active);
      if (!c?.unread || document.visibilityState !== "visible" || !root.offsetParent) return;
      c.unread = 0;
      renderList();
      vapi("POST", `/chats/${encodeURIComponent(c.remote)}/read`, undefined, c.lineId).catch(() => {});
    }, 400);
  };
  document.addEventListener("visibilitychange", markRead);

  // ─── envio ────────────────────────────────────────────────────────────

  /** Envia; `quoted` = mensagem citada (por padrão, a da barra "respondendo"). */
  const send = async (body, optimistic, quoted) => {
    const key = active;
    const line = lineOf(key), remote = remoteOf(key);
    if (!isOnline(line)) return toast("Este número está desconectado");
    const isReaction = optimistic.type === "reaction";
    if (!isReaction) { quoted = replyTo; replyTo = null; el(".wa-reply").hidden = true; }
    const tmp = {
      id: `tmp-${++tmpSeq}`, lineId: line, remote, direction: "outgoing", status: "pending", pending: true,
      timestamp: new Date().toISOString(), replyTo: quoted?.id, ...optimistic,
    };
    if (quoted) body.replyTo = quoted.id;
    if (!isReaction) { upsert(tmp); renderMessages(); scrollBottom(); }
    try {
      const m = await vapi("POST", "/messages", { to: remote, ...body }, line);
      const c = conv(key);
      c.list = c.list.filter((x) => x.id !== tmp.id);
      if (m.remote !== remote) {
        // O WhatsApp registrou o número com/sem o 9º dígito: a conversa passa a usar o número dele.
        const newKey = keyOf(line, m.remote);
        convs.delete(key);
        convs.set(newKey, c);
        chats = chats.filter((x) => x.key !== key || x.last);
        if (active === key) active = newKey;
      }
      upsert(m);
      touchChat(m);
    } catch (err) {
      const c = conv(key);
      if (isReaction) c.list = c.list.filter((x) => !(x.id.startsWith("tmp-r-") && x.replyTo === quoted?.id));
      const t = findMsg(key, tmp.id);
      if (t) { t.status = "error"; t.pending = false; }
      toast(`Não enviada: ${err.message}`);
    }
    renderList();
    if (active) { renderMessages(); if (nearBottom()) scrollBottom(); }
  };

  const sendText = () => {
    const text = input.value;
    if (!text.trim()) return;
    input.value = "";
    autosize();
    send({ text }, { type: "text", text });
  };

  const autosize = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    const has = input.value.trim().length > 0;
    sendBtn.innerHTML = has ? ICON.send : ICON.mic;
    sendBtn.title = has ? "Enviar" : "Gravar áudio";
  };

  // ─── anexos ───────────────────────────────────────────────────────────

  let pickKind = "media";
  const pick = (kind) => {
    pickKind = kind;
    fileInput.accept = { media: "image/*,video/*", document: "", audio: "audio/*", sticker: "image/webp" }[kind];
    fileInput.value = "";
    fileInput.click();
  };

  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE) return toast("Arquivo muito grande (máx. 25 MB)");
    const type = pickKind === "document" ? "document" : pickKind === "sticker" ? "sticker" : pickKind === "audio" ? "audio"
      : file.type.startsWith("video/") ? "video" : "image";
    if (type === "sticker" && file.type !== "image/webp") return toast("A figurinha precisa ser um arquivo .webp");
    if (type === "audio" || type === "sticker") {
      return sendFile(file, type, "");
    }
    showPreview(file, type);
  };

  const sendFile = async (file, type, caption) => {
    let base64;
    try { base64 = await fileToBase64(file); } catch (err) { return toast(err.message); }
    const media = { mimetype: file.type || undefined, fileName: file.name, size: file.size, ptt: false };
    send(
      { type, base64, fileName: file.name, mimetype: file.type || undefined, caption: caption || undefined, ...(type === "audio" ? { ptt: false } : {}) },
      { type, text: caption || undefined, media },
    );
  };

  const showPreview = (file, type) => {
    const url = URL.createObjectURL(file);
    const wrap = document.createElement("div");
    wrap.className = "wa-preview";
    const e = (file.name.split(".").pop() || "arq").slice(0, 4).toUpperCase();
    wrap.innerHTML = `
      <div class="wa-preview-head"><button class="wa-ico" data-p="close" title="Fechar">✕</button><b>${type === "document" ? "Documento" : "Pré-visualização"}</b></div>
      <div class="wa-preview-body">${type === "image" ? `<img src="${url}" alt="">` : type === "video" ? `<video src="${url}" controls></video>`
        : `<div class="wa-preview-file"><div class="wa-doc-ico${e === "PDF" ? " pdf" : ""}">${esc(e)}</div><b>${esc(file.name)}</b><br>${fmtSize(file.size)}</div>`}</div>
      <div class="wa-preview-foot"><input placeholder="Adicione uma legenda"><button class="wa-ico wa-sendbtn" data-p="send" title="Enviar">${ICON.send}</button></div>`;
    el(".wa-main").append(wrap);
    const cap = wrap.querySelector("input");
    cap.focus();
    const close = () => { URL.revokeObjectURL(url); wrap.remove(); };
    const go = () => { const c = cap.value; close(); sendFile(file, type, c); };
    wrap.querySelector('[data-p="close"]').onclick = close;
    wrap.querySelector('[data-p="send"]').onclick = go;
    cap.onkeydown = (ev) => { if (ev.key === "Enter") go(); if (ev.key === "Escape") close(); };
  };

  // ─── gravação de áudio ────────────────────────────────────────────────

  let rec = null;
  const startRec = async () => {
    if (!isOnline(lineOf(active))) return toast("Este número está desconectado");
    if (!navigator.mediaDevices?.getUserMedia) return toast("O navegador não permite gravar aqui (use HTTPS ou localhost)");
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { return toast("Permita o uso do microfone para gravar áudio"); }
    const mime = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm"].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) ?? "";
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    mr.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    const started = Date.now();
    rec = { mr, stream, chunks, started, cancel: false, timer: setInterval(() => {
      const s = (Date.now() - started) / 1000;
      el(".wa-rec .t").textContent = fmtDur(s);
      if (s > 15 * 60) stopRec(true);
    }, 250) };
    mr.start(250);
    el(".wa-rec .t").textContent = "0:00";
    el(".wa-compose").hidden = true;
    el(".wa-rec").hidden = false;
  };

  const stopRec = (sendIt) => {
    if (!rec) return;
    const r = rec;
    rec = null;
    clearInterval(r.timer);
    el(".wa-rec").hidden = true;
    el(".wa-compose").hidden = false;
    r.mr.onstop = async () => {
      r.stream.getTracks().forEach((t) => t.stop());
      const seconds = (Date.now() - r.started) / 1000;
      if (!sendIt || seconds < 0.8) return;
      const blob = new Blob(r.chunks, { type: r.mr.mimeType || "audio/webm" });
      const base64 = await fileToBase64(blob);
      send({ type: "audio", base64, mimetype: blob.type }, { type: "audio", media: { ptt: true, seconds: Math.round(seconds) } });
    };
    r.mr.stop();
  };

  // ─── player de áudio (um por vez, como no WhatsApp) ───────────────────

  const player = new Audio();
  let playingId = null;
  let speed = 1;
  const audioEl = () => (playingId ? box.querySelector(`[data-audio="${CSS.escape(playingId)}"]`) : null);
  const syncPlayerUi = () => {
    for (const a of box.querySelectorAll(".wa-audio")) {
      const me = a.dataset.audio === playingId;
      const btn = a.querySelector(".wa-play");
      if (btn.textContent !== "⏳") btn.innerHTML = me && !player.paused ? ICON.pause : ICON.play;
      const p = me && player.duration ? player.currentTime / player.duration : 0;
      const items = a.querySelectorAll(".wa-bars i");
      items.forEach((b, i) => b.classList.toggle("on", me && i / items.length < p));
      if (me) a.querySelector(".cur").textContent = fmtDur(player.paused && !player.currentTime ? player.duration : player.currentTime);
      let sp = a.querySelector(".wa-speed");
      if (me && !player.paused && !sp) {
        sp = document.createElement("button");
        sp.className = "wa-speed"; sp.dataset.a = "speed";
        a.append(sp);
      }
      if (sp) { if (!me) sp.remove(); else sp.textContent = `${speed}×`; }
    }
  };
  ["timeupdate", "play", "pause", "loadedmetadata"].forEach((ev) => player.addEventListener(ev, syncPlayerUi));
  player.addEventListener("ended", () => { player.currentTime = 0; syncPlayerUi(); });
  player.addEventListener("error", () => { if (playingId) toast("Não foi possível tocar o áudio"); });

  const togglePlay = (a) => {
    const id = a.dataset.audio;
    if (!a.dataset.src) return;
    if (playingId !== id) {
      playingId = id;
      player.src = a.dataset.src;
      player.playbackRate = speed;
    }
    if (player.paused) player.play().catch(() => {}); else player.pause();
    syncPlayerUi();
  };

  // ─── reações ──────────────────────────────────────────────────────────

  const showReactPicker = (row) => {
    root.querySelector(".wa-react-pick")?.remove();
    const id = row.dataset.id;
    const mine = reactionsOf(conv(active).list).get(id)?.get("outgoing");
    const pickEl = document.createElement("div");
    pickEl.className = "wa-react-pick";
    pickEl.innerHTML = QUICK_REACTIONS.map((e) => `<button data-react="${e}" class="${e === mine ? "mine" : ""}">${e}</button>`).join("");
    const main = el(".wa-main").getBoundingClientRect(), r = row.querySelector(".wa-bubble").getBoundingClientRect();
    pickEl.style.top = `${Math.max(64, r.top - main.top - 52)}px`;
    if (row.classList.contains("out")) pickEl.style.right = `${main.right - r.right}px`; else pickEl.style.left = `${r.left - main.left}px`;
    el(".wa-main").append(pickEl);
    pickEl.onclick = (ev) => {
      const b = ev.target.closest("[data-react]");
      if (!b) return;
      pickEl.remove();
      const emoji = b.dataset.react === mine ? "" : b.dataset.react;
      const target = findMsg(active, id);
      // Otimista: aparece na hora; o servidor confirma pelo evento.
      upsert({ id: `tmp-r-${++tmpSeq}`, lineId: lineOf(active), remote: remoteOf(active), direction: "outgoing", type: "reaction", text: emoji, replyTo: id, timestamp: new Date().toISOString(), status: "pending" });
      renderMessages(true);
      send({ type: "reaction", text: emoji }, { type: "reaction" }, target);
    };
  };

  // ─── eventos de interface ─────────────────────────────────────────────

  list.onclick = (ev) => {
    const item = ev.target.closest(".wa-item");
    if (!item) return;
    const hit = item.dataset.hit && contactHits.find((h) => h.key === item.dataset.key);
    if (hit) ensureChat(hit.lineId, hit.remote, { remoteJid: hit.remoteJid, name: hit.name, phoneName: hit.phoneName, profileName: hit.pushName });
    openChat(item.dataset.key);
  };
  el(".wa-search input").oninput = (ev) => { filter = ev.target.value; renderList(); searchContacts(); };
  el(".wa-filters").onclick = (ev) => {
    const b = ev.target.closest("[data-f]");
    if (!b) return;
    listFilter = b.dataset.f;
    renderList();
  };
  el(".wa-assign").onchange = (ev) => patchContact(active, { assignedUserId: ev.target.value || null });
  el(".wa-status").onchange = (ev) => patchContact(active, { status: ev.target.value });
  el(".wa-f-name").onchange = (ev) => patchContact(active, { name: ev.target.value.trim() || null });
  el(".wa-f-notes").onchange = (ev) => patchContact(active, { notes: ev.target.value });

  // ─── respostas rápidas ("/atalho") ────────────────────────────────────

  let qrIndex = 0;
  const qrMatches = () => {
    const m = /^\/([\p{L}\p{N}_-]*)$/u.exec(input.value);
    const list = quickReplies.get(lineOf(active)) ?? [];
    if (!m || !list.length) return null;
    const term = m[1].toLowerCase();
    return list.filter((r) => r.shortcut.startsWith(term) || r.text.toLowerCase().includes(term)).slice(0, 8);
  };
  const renderQr = () => {
    const pop = el(".wa-qr");
    const found = qrMatches();
    if (!found?.length) { pop.hidden = true; return; }
    qrIndex = Math.min(qrIndex, found.length - 1);
    pop.innerHTML = found.map((r, i) => `<button data-qr="${i}" class="${i === qrIndex ? "on" : ""}"><b>/${esc(r.shortcut)}</b><span>${esc(r.text)}</span></button>`).join("")
      + `<div class="wa-qr-hint">↑↓ escolher · Enter ou Tab usar · Esc fechar</div>`;
    pop.hidden = false;
  };
  const useQr = (i) => {
    const r = qrMatches()?.[i];
    if (!r) return;
    const c = chatOf(active);
    const first = (c?.customName || c?.profileName || "").split(" ")[0];
    input.value = r.text.replaceAll("{nome}", first).replaceAll("{atendente}", who()?.name ?? "").replace(/\s+([,!.?])/g, "$1");
    el(".wa-qr").hidden = true;
    autosize();
    focusInput(true);
  };
  el(".wa-qr").onclick = (ev) => { const b = ev.target.closest("[data-qr]"); if (b) useQr(Number(b.dataset.qr)); };
  el(".wa-new").onsubmit = (ev) => {
    ev.preventDefault();
    const num = ev.target.num.value.replace(/\D/g, "");
    if (num.length < 10) return toast("Informe o número com DDI e DDD, ex.: 5581999999999");
    ev.target.hidden = true;
    ev.target.num.value = "";
    const line = ev.target.line.value || linesList()[0]?.id;
    ensureChat(line, num);
    openChat(keyOf(line, num));
  };

  input.addEventListener("input", () => { autosize(); qrIndex = 0; renderQr(); });
  input.addEventListener("keydown", (ev) => {
    if (!el(".wa-qr").hidden) {
      const n = qrMatches()?.length ?? 0;
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); qrIndex = (qrIndex + (ev.key === "ArrowDown" ? 1 : n - 1)) % n; renderQr(); return; }
      if (ev.key === "Enter" || ev.key === "Tab") { ev.preventDefault(); useQr(qrIndex); return; }
      if (ev.key === "Escape") { el(".wa-qr").hidden = true; return; }
    }
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); sendText(); }
  });
  input.addEventListener("paste", (ev) => {
    const file = [...(ev.clipboardData?.files ?? [])][0];
    if (file && /^(image|video)\//.test(file.type)) { ev.preventDefault(); showPreview(file, file.type.startsWith("video/") ? "video" : "image"); }
  });

  box.addEventListener("scroll", () => {
    if (box.scrollTop < 80) loadOlder();
    if (nearBottom()) el(".wa-down").hidden = true;
  });

  root.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!t.closest(".wa-emoji, [data-a='emoji']")) el(".wa-emoji").hidden = true;
    if (!t.closest(".wa-attach, [data-a='attach']")) el(".wa-attach").hidden = true;
    if (!t.closest(".wa-react-pick, [data-a='react']")) root.querySelector(".wa-react-pick")?.remove();

    const emoji = t.closest("[data-emoji]");
    if (emoji) {
      const s = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, s) + emoji.dataset.emoji + input.value.slice(input.selectionEnd ?? s);
      input.selectionStart = input.selectionEnd = s + emoji.dataset.emoji.length;
      autosize(); focusInput(true);
      return;
    }
    const pk = t.closest("[data-pick]");
    if (pk) { el(".wa-attach").hidden = true; pick(pk.dataset.pick); return; }
    const jump = t.closest("[data-jump]");
    if (jump && jump.closest(".wa-msgs")) {
      const row = box.querySelector(`[data-id="${CSS.escape(jump.dataset.jump)}"]`);
      if (row) { row.scrollIntoView({ block: "center", behavior: "smooth" }); row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 1300); }
      return;
    }
    const zoom = t.closest("[data-zoom]");
    if (zoom) {
      const lb = document.createElement("div");
      lb.className = "wa-lightbox";
      lb.innerHTML = `<img src="${zoom.src}" alt="">`;
      lb.onclick = () => lb.remove();
      document.body.append(lb);
      return;
    }
    const open = t.closest("[data-open]");
    if (open) { ensureChat(lineOf(active), open.dataset.open); openChat(keyOf(lineOf(active), open.dataset.open)); return; }
    const bar = t.closest(".wa-bars");
    if (bar) {
      const a = bar.closest(".wa-audio");
      if (playingId !== a.dataset.audio) togglePlay(a);
      const r = bar.getBoundingClientRect();
      const seek = () => { if (player.duration) player.currentTime = ((ev.clientX - r.left) / r.width) * player.duration; };
      if (player.readyState >= 1) seek(); else player.addEventListener("loadedmetadata", seek, { once: true });
      return;
    }

    const a = t.closest("[data-a]")?.dataset.a;
    switch (a) {
      case "new": {
        const f = el(".wa-new");
        f.hidden = !f.hidden;
        if (!f.hidden) {
          f.line.innerHTML = linesList().map((l) => `<option value="${esc(l.id)}">${esc(lineName(l.id))}</option>`).join("");
          if (lineFilter) f.line.value = lineFilter;
          f.line.hidden = !multi();
          f.num.focus();
        }
        break;
      }
      case "back": wa.classList.remove("show-chat"); active = null; renderList(); break;
      case "call": onCall(remoteOf(active), lineOf(active)); break;
      case "down": scrollBottom(); break;
      case "emoji": el(".wa-emoji").hidden = !el(".wa-emoji").hidden; break;
      case "attach": el(".wa-attach").hidden = !el(".wa-attach").hidden; break;
      case "send": input.value.trim() ? sendText() : startRec(); break;
      case "rec-cancel": stopRec(false); break;
      case "rec-send": stopRec(true); break;
      case "play": togglePlay(t.closest(".wa-audio")); break;
      case "speed": speed = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1; player.playbackRate = speed; syncPlayerUi(); break;
      case "cancel-reply": replyTo = null; el(".wa-reply").hidden = true; break;
      case "take": patchContact(active, { assignedUserId: "me", ...(chatOf(active)?.status === "resolved" ? { status: "open" } : {}) }); break;
      case "info": el(".wa-info").hidden = !el(".wa-info").hidden; renderInfo(); break;
      case "info-close": el(".wa-info").hidden = true; break;
      case "older-phone": fetchOlderFromPhone(); break;
      case "hide-contact": hideContact(); break;
      case "reply": {
        replyTo = findMsg(active, t.closest(".wa-row").dataset.id);
        if (!replyTo) break;
        el(".wa-reply .wa-quote").outerHTML = quoteHtml(replyTo, null);
        el(".wa-reply").hidden = false;
        focusInput();
        break;
      }
      case "react": showReactPicker(t.closest(".wa-row")); break;
    }
  });

  /** Admin: oculta o contato neste número (some do painel, da API e do webhook). */
  const hideContact = async () => {
    const key = active;
    if (!key || !confirm(`Ocultar ${nameOf(key)} neste número?\n\nAs mensagens e ligações continuam gravadas, mas somem do painel, do atendimento, da API e do webhook. Para mostrar de novo, tire o número da lista em Configurações › Contatos ocultos.`)) return;
    try {
      const res = await fetch(`/admin/api/lines/${encodeURIComponent(lineOf(key))}/hidden-contacts`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ remote: remoteOf(key) }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Erro ${res.status}`);
    } catch (err) { return toast(err.message); }
    chats = chats.filter((c) => c.key !== key);
    convs.delete(key);
    el(".wa-info").hidden = true;
    wa.classList.remove("show-chat");
    el(".wa-chat").hidden = true;
    el(".wa-placeholder").hidden = false;
    active = null;
    renderList();
    toast("Contato ocultado neste número", true);
  };

  // Toque (sem mouse): tocar na bolha mostra as ações.
  if (matchMedia("(hover: none)").matches) {
    box.addEventListener("click", (ev) => {
      if (ev.target.closest("a, button, video, img, .wa-bars")) return;
      const acts = ev.target.closest(".wa-bubble")?.querySelector(".wa-actions");
      box.querySelectorAll(".wa-actions.open").forEach((x) => x !== acts && x.classList.remove("open"));
      acts?.classList.toggle("open");
    });
  }

  // ─── API pública ──────────────────────────────────────────────────────

  // ─── números (linhas) ─────────────────────────────────────────────────

  const sel = el(".wa-linesel");
  /** Atualiza o seletor de número (só aparece com mais de um). */
  const renderLineBar = () => {
    el(".wa-linebar").hidden = !multi();
    if (!multi()) { lineFilter = ""; return; }
    const unreadBy = new Map();
    for (const c of chats) if (c.unread) unreadBy.set(c.lineId, (unreadBy.get(c.lineId) ?? 0) + 1);
    const total = [...unreadBy.values()].reduce((a, b) => a + b, 0);
    const label = (txt, n) => (n ? `${txt} (${n})` : txt);
    sel.innerHTML = `<option value="">${esc(label("Todos os números", total))}</option>`
      + linesList().map((l) => `<option value="${esc(l.id)}">${esc(label(`${lineName(l.id)}${isOnline(l.id) ? "" : " · desconectado"}`, unreadBy.get(l.id)))}</option>`).join("");
    sel.value = lineFilter;
  };
  sel.onchange = () => { lineFilter = sel.value; renderList(); };
  const baseRenderList = renderList;
  renderList = () => { baseRenderList(); renderLineBar(); };

  /** Composer liberado conforme o número da conversa aberta estar conectado. */
  const syncOnline = () => {
    const ok = !active || isOnline(lineOf(active));
    el(".wa-offline").hidden = ok;
    el(".wa-offline").textContent = `${multi() && active ? `${lineName(lineOf(active))}: ` : ""}telefone desconectado, não é possível enviar mensagens agora.`;
    input.disabled = !ok;
  };

  const loadLine = async (line) => {
    const [list, ag, qr] = await Promise.all([
      vapi("GET", "/chats", undefined, line),
      vapi("GET", "/agents", undefined, line).catch(() => []),
      vapi("GET", "/quick-replies", undefined, line).catch(() => []),
    ]);
    agents.set(line, ag);
    quickReplies.set(line, qr);
    chats = chats.filter((c) => c.lineId !== line).concat(list.map((c) => ({
      ...c, lineId: line, key: keyOf(line, c.remote), customName: c.teamName ?? null,
    })));
    chats.sort((a, b) => (b.last?.timestamp ?? "").localeCompare(a.last?.timestamp ?? ""));
  };

  return {
    /** Abre a conversa com um contato (no número `line`; padrão: o primeiro). */
    open: (remote, line = linesList()[0]?.id) => { ensureChat(line, remote); openChat(keyOf(line, remote)); },
    /** A conversa (linha + contato) está aberta? */
    isOpen: (line, remote) => active === keyOf(line, remote),
    /** Nome a mostrar para um contato. */
    nameOf: (remote, line = linesList()[0]?.id) => nameOf(keyOf(line, remote)),
    /** Carrega as conversas de todos os números (na primeira vez ou quando a lista muda). */
    activate: async () => {
      if (active) markRead();
      const want = linesList().map((l) => l.id);
      const missing = want.filter((id) => !loadedLines.has(id));
      // Número removido da lista (permissão mudou): some da caixa de entrada.
      chats = chats.filter((c) => want.includes(c.lineId));
      for (const id of [...loadedLines]) if (!want.includes(id)) loadedLines.delete(id);
      if (!missing.length) { renderList(); return; }
      missing.forEach((id) => loadedLines.add(id));
      const results = await Promise.allSettled(missing.map(loadLine));
      results.forEach((r, i) => { if (r.status === "rejected") { loadedLines.delete(missing[i]); toast(r.reason?.message ?? String(r.reason)); } });
      renderList();
    },
    /** Número conectado ou não (bloqueia o envio nas conversas dele). */
    setOnline: (v, line = linesList()[0]?.id) => {
      online.set(line, !!v);
      syncOnline();
      renderLineBar();
    },
    /** Recarrega as conversas de um número (ex.: depois de mudar os contatos ocultos). */
    reloadLine: (line) => scheduleReload(line),
    /** Recarrega as respostas rápidas (depois de editar nas configurações). */
    reloadQuickReplies: async () => {
      for (const l of linesList()) quickReplies.set(l.id, await vapi("GET", "/quick-replies", undefined, l.id).catch(() => quickReplies.get(l.id) ?? []));
    },
    onEvent: (e) => {
      if (e.lineId && !linesList().some((l) => l.id === e.lineId)) return;
      if (e.type === "contact") { applyContact({ ...e.contact, lineId: e.lineId }); return; }
      if (e.type === "history") {
        // Mensagens antigas chegaram do celular: as conversas abertas buscam a página nova.
        for (const remote of e.remotes ?? []) {
          const key = keyOf(e.lineId, remote);
          const c = convs.get(key);
          if (!c?.loaded) continue;
          c.fetching = false; c.phoneDone = false; c.hasMore = true;
          clearTimeout(c.fetchTimer);
          if (key === active) void loadOlder();
        }
        scheduleReload(e.lineId);
        return;
      }
      if (e.type === "sync") return;
      if ((e.type === "ended" || e.type === "call-update") && e.call) {
        // Ligação terminou (ou gravação/transcrição ficou pronta): entra na linha do tempo da conversa.
        const key = keyOf(e.lineId, e.call.remote);
        const list = callsOf.get(key);
        if (!list) return;
        const i = list.findIndex((x) => x.id === e.call.id);
        if (i >= 0) list[i] = { ...list[i], ...e.call }; else if (e.type === "ended") list.push(e.call);
        if (key === active) { renderMessages(true); if (!el(".wa-info").hidden) renderInfo(); }
        return;
      }
      if (e.type === "chat-read") {
        const c = chatOf(keyOf(e.lineId, e.remote));
        if (c) { c.unread = 0; renderList(); }
        return;
      }
      if (!e.message) return;
      const m = { ...e.message, lineId: e.message.lineId ?? e.lineId };
      const key = kOf(m);
      if (e.type === "message-status") {
        const known = findMsg(key, m.id);
        if (known) known.status = m.status;
        const c = chatOf(key);
        if (c?.last?.id === m.id) c.last.status = m.status;
      } else if (e.type === "message-update") {
        if (findMsg(key, m.id)) upsert(m);
        const c = chatOf(key);
        if (c?.last?.id === m.id) c.last = { ...c.last, ...m };
      } else {
        const c = convs.get(key);
        // Reação que nós mesmos enviamos: troca a otimista pela real.
        if (c && m.type === "reaction" && m.direction === "outgoing") c.list = c.list.filter((x) => !(x.id.startsWith("tmp-r-") && x.replyTo === m.replyTo));
        if (c?.loaded || key === active) upsert(m);
        const chat = touchChat(m);
        if (m.direction === "incoming" && m.type !== "reaction" && m.status === "delivered") {
          chat.unread += 1;
          if (key === active) markRead();
        }
      }
      renderList();
      if (key === active) {
        const stick = nearBottom() || m.direction === "outgoing";
        renderMessages(true);
        if (stick) scrollBottom();
        else if (e.type === "message" && m.type !== "reaction") el(".wa-down").hidden = false;
      }
    },
  };
};
