import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const DOCS_DIR = fileURLToPath(new URL("../../docs/", import.meta.url));

/** Páginas públicas de documentação: rota -> arquivo e título. */
export const DOC_PAGES: Record<string, { file: string; title: string }> = {
  api: { file: "API.md", title: "API" },
  webhook: { file: "WEBHOOK.md", title: "Webhook" },
};

/** Âncora no padrão do GitHub (os links internos dos .md usam esse formato). */
const slug = (text: string): string =>
  text.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const render = (md: string): { html: string; toc: { level: number; id: string; text: string }[] } => {
  const toc: { level: number; id: string; text: string }[] = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth, text }) {
        const inner = this.parser.parseInline(tokens);
        const id = slug(text.replace(/`/g, ""));
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, text: inner.replace(/<[^>]+>/g, "") });
        return `<h${depth} id="${esc(id)}"><a class="anchor" href="#${esc(id)}">#</a>${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        // Links entre os .md viram as rotas públicas.
        const to = href.replace(/^(API|WEBHOOK)\.md/i, (_, n: string) => `/docs/${n.toLowerCase()}`);
        const external = /^https?:\/\//.test(to);
        return `<a href="${esc(to)}"${title ? ` title="${esc(title)}"` : ""}${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${inner}</a>`;
      },
    },
  });
  // Os documentos são do próprio projeto (não vêm de usuários).
  return { html: marked.parse(md, { async: false }) as string, toc };
};

const cache = new Map<string, string>();

/** HTML completo de uma página da documentação. `origin` = endereço deste gateway. */
export const docPage = (name: string, origin: string): string | null => {
  const page = DOC_PAGES[name];
  if (!page) return null;
  const key = `${name}|${origin}`;
  if (cache.has(key) && process.env.NODE_ENV === "production") return cache.get(key)!;

  const md = readFileSync(DOCS_DIR + page.file, "utf8")
    // Exemplos já com o endereço deste gateway.
    .replaceAll("http://localhost:3000", origin)
    .replaceAll("https://voz.suaempresa.com.br", origin)
    .replaceAll("https://GATEWAY", origin)
    .replaceAll("wss://GATEWAY", origin.replace(/^http/, "ws"));
  const { html, toc } = render(md);
  const nav = Object.entries(DOC_PAGES)
    .map(([k, p]) => `<a href="/docs/${k}" class="${k === name ? "active" : ""}">${p.title}</a>`).join("");
  const tocHtml = toc.map((t) => `<a href="#${esc(t.id)}" class="l${t.level}">${esc(t.text)}</a>`).join("");

  const out = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title} · Documentação · PhdZap</title>
<link rel="icon" href="/static/icon.svg">
<style>
  :root { --bg: #0f1418; --panel: #182128; --panel-2: #1f2a33; --line: #26333c; --text: #e6edf1; --muted: #8a9ba6; --green: #25d366; --blue: #3b9eff; }
  @media (prefers-color-scheme: light) { :root { --bg: #ffffff; --panel: #f6f8fa; --panel-2: #eef2f5; --line: #d8dee4; --text: #1f2328; --muted: #59636e; --green: #1a8f4a; --blue: #0969da; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15.5px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 18px; padding: 12px 24px; background: var(--panel); border-bottom: 1px solid var(--line); }
  header .brand { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 800; color: var(--text); text-decoration: none; white-space: nowrap; }
  header .brand img { width: 26px; height: 26px; }
  header .brand b { background: linear-gradient(135deg, #4ff5a6, #14c98a); -webkit-background-clip: text; background-clip: text; color: transparent; }
  header .brand small { color: var(--muted); font-weight: 600; font-size: 14px; margin-left: 4px; }
  header nav { display: flex; gap: 4px; }
  header nav a { color: var(--muted); text-decoration: none; padding: 6px 12px; border-radius: 8px; font-weight: 600; font-size: 14px; }
  header nav a.active, header nav a:hover { color: var(--text); background: var(--panel-2); }
  header .dl { margin-left: auto; color: var(--text); text-decoration: none; font-weight: 600; font-size: 13px; padding: 5px 11px; border: 1px solid var(--line); border-radius: 8px; white-space: nowrap; }
  header .dl:hover { background: var(--panel-2); }
  header .base { color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  header .base code { color: var(--text); }
  .wrap { display: grid; grid-template-columns: 250px minmax(0, 1fr); max-width: 1280px; margin: 0 auto; }
  aside { position: sticky; top: 53px; align-self: start; max-height: calc(100vh - 53px); overflow-y: auto; padding: 24px 12px 40px 24px; border-right: 1px solid var(--line); }
  aside a { display: block; color: var(--muted); text-decoration: none; font-size: 13.5px; padding: 4px 8px; border-radius: 6px; line-height: 1.35; }
  aside a.l3 { padding-left: 20px; font-size: 13px; }
  aside a:hover, aside a.on { color: var(--text); background: var(--panel-2); }
  main { padding: 28px 40px 80px; min-width: 0; }
  h1 { font-size: 30px; margin: 0 0 12px; }
  h2 { font-size: 23px; margin: 44px 0 12px; padding-top: 8px; border-top: 1px solid var(--line); }
  h3 { font-size: 18px; margin: 30px 0 8px; }
  h4 { font-size: 15.5px; margin: 22px 0 6px; }
  h1, h2, h3, h4 { scroll-margin-top: 70px; position: relative; }
  .anchor { position: absolute; left: -20px; color: var(--muted); text-decoration: none; opacity: 0; font-weight: 400; }
  h2:hover .anchor, h3:hover .anchor, h4:hover .anchor { opacity: 1; }
  a { color: var(--blue); }
  hr { display: none; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: var(--panel-2); padding: 1px 5px; border-radius: 5px; }
  pre { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; overflow-x: auto; position: relative; }
  pre code { background: none; padding: 0; font-size: 13px; line-height: 1.55; }
  pre button { position: absolute; top: 8px; right: 8px; font: 600 12px system-ui; color: var(--muted); background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px; padding: 3px 9px; cursor: pointer; opacity: 0; }
  pre:hover button { opacity: 1; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; display: block; overflow-x: auto; }
  th, td { border: 1px solid var(--line); padding: 7px 11px; text-align: left; vertical-align: top; }
  th { background: var(--panel); }
  blockquote { margin: 14px 0; padding: 8px 16px; border-left: 4px solid var(--green); background: var(--panel); border-radius: 0 8px 8px 0; color: var(--text); }
  blockquote p { margin: 6px 0; }
  @media (max-width: 860px) {
    .wrap { grid-template-columns: 1fr; }
    aside { display: none; }
    main { padding: 20px 16px 60px; }
    header { padding: 10px 16px; flex-wrap: wrap; gap: 8px; }
    header .dl { margin-left: auto; }
    header .base { width: 100%; }
  }
</style>
</head>
<body>
<header>
  <a class="brand" href="/docs"><img src="/static/icon.svg" alt=""><span>Phd<b>Zap</b></span><small>Documentação</small></a>
  <nav>${nav}</nav>
  <a class="dl" href="/docs/postman.json" download title="Coleção com todas as rotas, para importar no Postman">⬇ Postman</a>
  <span class="base">URL base: <code>${esc(origin)}</code></span>
</header>
<div class="wrap">
  <aside>${tocHtml}</aside>
  <main>${html}</main>
</div>
<script>
  // Botão copiar nos blocos de código e destaque da seção atual no índice.
  for (const pre of document.querySelectorAll("pre")) {
    const b = document.createElement("button");
    b.textContent = "Copiar";
    b.onclick = async () => { await navigator.clipboard.writeText(pre.innerText.replace(/Copiar$/, "").trim()); b.textContent = "Copiado"; setTimeout(() => (b.textContent = "Copiar"), 1200); };
    pre.append(b);
  }
  const links = [...document.querySelectorAll("aside a")];
  const heads = links.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);
  const spy = () => {
    let cur = heads[0];
    for (const h of heads) if (h.getBoundingClientRect().top < 120) cur = h;
    links.forEach((a) => a.classList.toggle("on", cur && decodeURIComponent(a.hash.slice(1)) === cur.id));
  };
  addEventListener("scroll", spy, { passive: true }); spy();
</script>
</body>
</html>`;
  // A chave inclui o Host da requisição: limita para não crescer sem fim.
  if (cache.size > 20) cache.clear();
  cache.set(key, out);
  return out;
};
