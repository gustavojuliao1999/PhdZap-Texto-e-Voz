// Chat de mensagens do painel (visual do WhatsApp). Usa a API da linha com a sessão do painel (?line=).
import { esc, fmtPhone } from "/static/voice.js";
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
 * Monta o chat em `root`.
 * opts: { lineId, canCall: () => bool, onCall: (numero) => void, onUnread: (conversasNãoLidas) => void }
 * Retorna { activate(), onEvent(evento), setOnline(bool) }.
 */
export const mountChat = (root, { lineId, canCall = () => false, onCall = () => {}, onUnread = () => {} }) => {
  const q = `line=${encodeURIComponent(lineId)}`;
  const vapi = async (method, path, body) => {
    const res = await fetch(`/api/v1${path}${path.includes("?") ? "&" : "?"}${q}`, {
      method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { location.href = "/login"; throw new Error("Sessão expirada"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Erro ${res.status}`);
    return data;
  };
  const mediaSrc = (m) => `/api/v1/messages/${encodeURIComponent(m.id)}/media?${q}`;
  const photoSrc = (remote, jid) =>
    `/api/v1/contacts/${encodeURIComponent(remote)}/photo?${q}${jid ? `&jid=${encodeURIComponent(jid)}` : ""}`;

  /** @type {{remote:string, remoteJid?:string, name?:string, unread:number, last:any}[]} */
  let chats = [];
  /** remote -> { list: mensagens em ordem crescente, hasMore, loading } */
  const convs = new Map();
  let active = null;
  let replyTo = null;
  let online = true;
  let loaded = false;
  let filter = "";
  let tmpSeq = 0;

  root.innerHTML = `
  <div class="wa">
    <aside class="wa-side">
      <div class="wa-side-head">
        <h3>Conversas</h3>
        <button class="wa-ico" data-a="new" title="Nova conversa">${ICON.plus}</button>
      </div>
      <form class="wa-new" hidden>
        <input name="num" inputmode="tel" placeholder="Número com DDI e DDD (ex.: 5581999999999)" autocomplete="off">
        <button type="submit">Abrir</button>
      </form>
      <div class="wa-search"><input type="search" placeholder="Pesquisar conversa"></div>
      <div class="wa-list"></div>
    </aside>
    <section class="wa-main">
      <div class="wa-placeholder">
        <div>
          <div style="font-size:64px">💬</div>
          <h2>Mensagens do WhatsApp</h2>
          <div>Escolha uma conversa ao lado ou comece uma nova com o <b>+</b>.<br>
          Envie textos, áudios, fotos, vídeos, documentos e figurinhas pelo número desta linha.</div>
        </div>
      </div>
      <div class="wa-chat" hidden style="display:contents">
        <header class="wa-head">
          <button class="wa-ico wa-back" data-a="back" title="Voltar">${ICON.back}</button>
          <div class="wa-av small wa-head-av"></div>
          <div class="who"><b></b><small></small></div>
          <button class="wa-ico" data-a="call" title="Ligar pelo WhatsApp">${ICON.phone}</button>
        </header>
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
    noPhoto.add(e.target.dataset.remote);
    e.target.remove();
  }, true);

  const chatOf = (remote) => chats.find((c) => c.remote === remote);
  const nameOf = (remote) => {
    const c = chatOf(remote);
    return c?.name || (remote.includes("@") ? "Contato" : fmtPhone(remote));
  };
  const avatar = (remote, cls = "") => {
    const c = chatOf(remote);
    const img = noPhoto.has(remote) ? "" : `<img alt="" loading="lazy" data-remote="${esc(remote)}" src="${photoSrc(remote, c?.remoteJid)}">`;
    return `<div class="wa-av ${cls}">${esc(initials(c?.name))}${img}</div>`;
  };

  // ─── lista ────────────────────────────────────────────────────────────

  const renderList = () => {
    onUnread(chats.reduce((n, c) => n + (c.unread ? 1 : 0), 0));
    const f = filter.trim().toLowerCase();
    const shown = chats.filter((c) => !f || (c.name ?? "").toLowerCase().includes(f) || c.remote.includes(f.replace(/\D/g, "") || "§"));
    if (!shown.length) {
      list.innerHTML = `<div class="wa-list-empty">${chats.length ? "Nenhuma conversa encontrada." :
        "Nenhuma mensagem ainda.<br>As mensagens recebidas por este número aparecem aqui.<br>Para começar, toque no <b>+</b>."}</div>`;
      return;
    }
    list.innerHTML = shown.map((c) => {
      const m = c.last;
      const mine = m?.direction === "outgoing";
      return `<div class="wa-item${c.remote === active ? " active" : ""}" data-remote="${esc(c.remote)}">
        ${avatar(c.remote)}
        <div class="wa-item-main">
          <div class="wa-item-top"><span class="wa-name">${esc(nameOf(c.remote))}</span>
            <span class="wa-time${c.unread ? " unread" : ""}">${m ? fmtListTime(m.timestamp) : ""}</span></div>
          <div class="wa-item-bot"><span class="wa-prev">${mine ? tick(m.status) : ""}${esc(preview(m))}</span>
            ${c.unread ? `<span class="wa-badge">${c.unread}</span>` : ""}</div>
        </div></div>`;
    }).join("");
  };

  const touchChat = (m) => {
    let c = chatOf(m.remote);
    if (!c) { c = { remote: m.remote, remoteJid: m.remoteJid, unread: 0, last: null }; chats.push(c); }
    if (m.pushName) c.name = m.pushName;
    c.remoteJid ??= m.remoteJid;
    if (m.type !== "reaction" && (!c.last || c.last.id === m.id || m.timestamp >= c.last.timestamp)) c.last = m;
    chats.sort((a, b) => (b.last?.timestamp ?? "9").localeCompare(a.last?.timestamp ?? "9"));
    return c;
  };

  // ─── conversa ─────────────────────────────────────────────────────────

  const conv = (remote) => {
    let c = convs.get(remote);
    if (!c) convs.set(remote, (c = { list: [], hasMore: true, loading: false, loaded: false }));
    return c;
  };

  const upsert = (m) => {
    const c = conv(m.remote);
    const i = c.list.findIndex((x) => x.id === m.id);
    if (i >= 0) c.list[i] = { ...c.list[i], ...m };
    else {
      c.list.push(m);
      c.list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }
  };

  const findMsg = (remote, id) => convs.get(remote)?.list.find((m) => m.id === id);

  const quoteHtml = (m, targetId, cls = "") => {
    const t = targetId ? findMsg(m?.remote ?? active, targetId) : m;
    const who = !t ? "" : t.direction === "outgoing" ? "Você" : nameOf(t.remote);
    return `<div class="wa-quote ${t?.direction === "incoming" ? "in" : ""} ${cls}" data-jump="${esc(targetId ?? t?.id ?? "")}">
      <b>${esc(who || "Mensagem")}</b><span>${esc(t ? preview(t) : "Mensagem anterior")}</span></div>`;
  };

  const contentHtml = (m) => {
    const src = mediaSrc(m);
    // Ainda não enviada (ou falhou): não há mídia no servidor.
    const local = m.pending || m.id.startsWith("tmp-");
    const caption = m.text ? `<div class="wa-text">${formatText(m.text)}</div>` : "";
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
          ? `<div class="wa-audio-av">${m.direction === "outgoing" ? `<div class="wa-av">🎧</div>` : avatar(m.remote)}<span class="mic">🎤</span></div>`
          : `<div class="wa-audio-av">🎵</div>`;
        return `<div class="wa-audio${ptt ? "" : " file"}" data-audio="${esc(m.id)}" data-src="${local ? "" : src}">
          ${m.direction === "outgoing" ? "" : av}
          <button class="wa-play" data-a="play">${local ? "⏳" : ICON.play}</button>
          <div class="wa-wave"><div class="wa-bars">${b}</div>
            <div class="wa-audio-meta"><span class="cur">${fmtDur(m.media?.seconds)}</span></div></div>
          ${m.direction === "outgoing" ? av : ""}
        </div>`;
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
    let lastDay = "", lastDir = "", lastTs = 0;
    for (const m of c.list) {
      if (m.type === "reaction") continue;
      const day = dayKey(m.timestamp);
      if (day !== lastDay) { html += `<div class="wa-day">${esc(fmtDay(m.timestamp))}</div>`; lastDir = ""; }
      const ts = new Date(m.timestamp).getTime();
      const first = m.direction !== lastDir || ts - lastTs > 10 * 60_000;
      lastDay = day; lastDir = m.direction; lastTs = ts;
      const bare = m.type === "sticker" || (m.type === "text" && onlyEmoji(m.text));
      const media = ["image", "video"].includes(m.type);
      const metaOver = bare || (media && !m.text);
      const out = m.direction === "outgoing";
      const r = reacts.get(m.id);
      html += `<div class="wa-row ${out ? "out" : "in"}${first ? " first" : ""}" data-id="${esc(m.id)}">
        <div class="wa-bubble${bare ? " bare" : ""}${media ? " media" : ""}">
          ${out && m.agent && first ? `<div class="wa-agent">${esc(m.agent)}</div>` : ""}
          ${m.replyTo ? quoteHtml(m, m.replyTo) : ""}
          ${contentHtml(m)}
          <span class="wa-meta${metaOver ? " over" : ""}">${fmtTime(m.timestamp)}${out ? tick(m.status) : ""}</span>
          ${m.pending || m.status === "error" ? "" : `<div class="wa-actions">
            <button data-a="react" title="Reagir">😊</button>
            <button data-a="reply" title="Responder">${ICON.reply}</button>
          </div>`}
        </div>
        ${r?.size ? `<div class="wa-reacts" title="${esc([...r].map(([d, e]) => `${d === "outgoing" ? "Você" : nameOf(m.remote)}: ${e}`).join("\n"))}">${[...new Set(r.values())].map((e) => `<span>${e}</span>`).join("")}${r.size > 1 ? `<small>&nbsp;${r.size}</small>` : ""}</div>` : ""}
      </div>`;
    }
    box.innerHTML = html || `<div class="wa-day">Nenhuma mensagem ainda. Diga oi! 👋</div>`;
    if (keepScroll) box.scrollTop = box.scrollHeight - prevHeight + prevTop;
    syncPlayerUi();
  };

  const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  const scrollBottom = () => { box.scrollTop = box.scrollHeight; el(".wa-down").hidden = true; };

  const loadOlder = async () => {
    const c = convs.get(active);
    if (!c || c.loading || !c.hasMore) return;
    c.loading = true;
    const remote = active;
    try {
      const oldest = c.list[0]?.timestamp;
      const page = await vapi("GET", `/messages?contact=${encodeURIComponent(remote)}&limit=${PAGE}${oldest ? `&before=${encodeURIComponent(oldest)}` : ""}`);
      page.forEach(upsert);
      c.hasMore = page.length === PAGE;
      c.loaded = true;
    } catch (err) {
      toast(err.message);
    } finally {
      c.loading = false;
    }
    if (active === remote) renderMessages(true);
  };

  const openChat = async (remote) => {
    if (!remote) return;
    active = remote;
    replyTo = null;
    el(".wa-reply").hidden = true;
    wa.classList.add("show-chat");
    el(".wa-placeholder").hidden = true;
    el(".wa-chat").hidden = false;
    el(".wa-head-av").outerHTML = avatar(remote, "small wa-head-av");
    el(".wa-head .who b").textContent = nameOf(remote);
    el(".wa-head .who small").textContent = remote.includes("@") ? "" : fmtPhone(remote);
    el('[data-a="call"]').hidden = !canCall() || remote.includes("@");
    renderList();
    const c = conv(remote);
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
      vapi("POST", `/chats/${encodeURIComponent(c.remote)}/read`).catch(() => {});
    }, 400);
  };
  document.addEventListener("visibilitychange", markRead);

  // ─── envio ────────────────────────────────────────────────────────────

  /** Envia; `quoted` = mensagem citada (por padrão, a da barra "respondendo"). */
  const send = async (body, optimistic, quoted) => {
    const remote = active;
    if (!online) return toast("Telefone desconectado");
    const isReaction = optimistic.type === "reaction";
    if (!isReaction) { quoted = replyTo; replyTo = null; el(".wa-reply").hidden = true; }
    const tmp = {
      id: `tmp-${++tmpSeq}`, remote, direction: "outgoing", status: "pending", pending: true,
      timestamp: new Date().toISOString(), replyTo: quoted?.id, ...optimistic,
    };
    if (quoted) body.replyTo = quoted.id;
    if (!isReaction) { upsert(tmp); renderMessages(); scrollBottom(); }
    try {
      const m = await vapi("POST", "/messages", { to: remote, ...body });
      const c = conv(remote);
      c.list = c.list.filter((x) => x.id !== tmp.id);
      if (m.remote !== remote) {
        // O WhatsApp registrou o número com/sem o 9º dígito: a conversa passa a usar o número dele.
        const from = convs.get(remote);
        convs.delete(remote);
        convs.set(m.remote, from);
        chats = chats.filter((x) => x.remote !== remote || x.last);
        if (active === remote) active = m.remote;
      }
      upsert(m);
      touchChat(m);
    } catch (err) {
      const c = conv(remote);
      if (isReaction) c.list = c.list.filter((x) => !(x.id.startsWith("tmp-r-") && x.replyTo === quoted?.id));
      const t = findMsg(remote, tmp.id);
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
    if (!online) return toast("Telefone desconectado");
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
      upsert({ id: `tmp-r-${++tmpSeq}`, remote: active, direction: "outgoing", type: "reaction", text: emoji, replyTo: id, timestamp: new Date().toISOString(), status: "pending" });
      renderMessages(true);
      send({ type: "reaction", text: emoji }, { type: "reaction" }, target);
    };
  };

  // ─── eventos de interface ─────────────────────────────────────────────

  list.onclick = (ev) => {
    const item = ev.target.closest(".wa-item");
    if (item) openChat(item.dataset.remote);
  };
  el(".wa-search input").oninput = (ev) => { filter = ev.target.value; renderList(); };
  el(".wa-new").onsubmit = (ev) => {
    ev.preventDefault();
    const num = ev.target.num.value.replace(/\D/g, "");
    if (num.length < 10) return toast("Informe o número com DDI e DDD, ex.: 5581999999999");
    ev.target.hidden = true;
    ev.target.num.value = "";
    if (!chatOf(num)) chats.unshift({ remote: num, unread: 0, last: null });
    openChat(num);
  };

  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (ev) => {
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
    if (open) { if (!chatOf(open.dataset.open)) chats.unshift({ remote: open.dataset.open, unread: 0, last: null }); openChat(open.dataset.open); return; }
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
      case "new": { const f = el(".wa-new"); f.hidden = !f.hidden; if (!f.hidden) f.num.focus(); break; }
      case "back": wa.classList.remove("show-chat"); active = null; renderList(); break;
      case "call": onCall(active); break;
      case "down": scrollBottom(); break;
      case "emoji": el(".wa-emoji").hidden = !el(".wa-emoji").hidden; break;
      case "attach": el(".wa-attach").hidden = !el(".wa-attach").hidden; break;
      case "send": input.value.trim() ? sendText() : startRec(); break;
      case "rec-cancel": stopRec(false); break;
      case "rec-send": stopRec(true); break;
      case "play": togglePlay(t.closest(".wa-audio")); break;
      case "speed": speed = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1; player.playbackRate = speed; syncPlayerUi(); break;
      case "cancel-reply": replyTo = null; el(".wa-reply").hidden = true; break;
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

  return {
    /** Abre a conversa com um contato. */
    open: (remote) => openChat(remote),
    /** Contato da conversa aberta (null se nenhuma). */
    get active() { return active; },
    /** Nome a mostrar para um contato. */
    nameOf: (remote) => nameOf(remote),
    /** Carrega as conversas na primeira vez que a aba abre. */
    activate: async () => {
      if (active) markRead();
      if (loaded) return;
      loaded = true;
      try {
        chats = await vapi("GET", "/chats");
      } catch (err) {
        loaded = false;
        toast(err.message);
      }
      renderList();
    },
    setOnline: (v) => {
      online = v;
      el(".wa-offline").hidden = v;
      input.disabled = !v;
    },
    onEvent: (e) => {
      if (e.type === "chat-read") {
        const c = chatOf(e.remote);
        if (c) { c.unread = 0; renderList(); }
        return;
      }
      const m = e.message;
      if (!m) return;
      if (e.type === "message-status") {
        const known = findMsg(m.remote, m.id);
        if (known) known.status = m.status;
        const c = chatOf(m.remote);
        if (c?.last?.id === m.id) c.last.status = m.status;
      } else {
        const c = convs.get(m.remote);
        // Reação que nós mesmos enviamos: troca a otimista pela real.
        if (c && m.type === "reaction" && m.direction === "outgoing") c.list = c.list.filter((x) => !(x.id.startsWith("tmp-r-") && x.replyTo === m.replyTo));
        if (c?.loaded || m.remote === active) upsert(m);
        const chat = touchChat(m);
        if (m.direction === "incoming" && m.type !== "reaction" && m.status === "delivered") {
          chat.unread += 1;
          if (m.remote === active) markRead();
        }
      }
      renderList();
      if (m.remote === active) {
        const stick = nearBottom() || m.direction === "outgoing";
        renderMessages(true);
        if (stick) scrollBottom();
        else if (e.type === "message" && m.type !== "reaction") el(".wa-down").hidden = false;
      }
    },
  };
};
