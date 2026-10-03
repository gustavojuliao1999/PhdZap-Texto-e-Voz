// Seletor de país com busca (bandeira + nome + código), acessível por teclado.
import { byIso, searchCountries } from "/static/countries.js";

const STYLE = `
.cp { position: relative; flex: none; }
.cp-btn {
  display: flex; align-items: center; gap: 6px; height: 100%; padding: 0 10px; background: var(--bg);
  border: 1px solid var(--line); border-radius: 8px; color: var(--text); font-size: 16px; font-weight: 600;
}
.cp-btn .cp-flag { font-size: 20px; line-height: 1; }
.cp-btn .cp-caret { color: var(--muted); font-size: 11px; }
.cp-panel {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 50; width: min(300px, 92vw);
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0,0,0,.45); overflow: hidden;
}
.cp-panel input { border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: var(--panel-2); padding: 11px 12px; }
.cp-panel input:focus { outline: none; }
.cp-list { max-height: 230px; overflow-y: auto; margin: 0; padding: 4px 0; list-style: none; }
.cp-list li { display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; font-size: 14px; text-align: left; }
.cp-list li .cp-flag { font-size: 18px; width: 24px; text-align: center; }
.cp-list li .cp-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-list li .cp-code { color: var(--muted); font-variant-numeric: tabular-nums; }
.cp-list li.active { background: rgba(59, 158, 255, .18); }
.cp-list li.selected .cp-name { font-weight: 600; }
.cp-empty { padding: 14px 12px; color: var(--muted); font-size: 13.5px; }
`;

let styleInjected = false;

/**
 * Cria o seletor dentro de `host`. `onChange(country)` é chamado ao escolher.
 * Retorna { get country, set(iso), open(), close() }.
 */
export const createCountryPicker = (host, { initial = "BR", onChange = () => {} } = {}) => {
  if (!styleInjected) {
    const st = document.createElement("style"); st.textContent = STYLE; document.head.append(st);
    styleInjected = true;
  }
  let country = byIso(initial) ?? byIso("BR");
  let results = [];
  let active = 0;

  host.classList.add("cp");
  host.innerHTML = `
    <button type="button" class="cp-btn" aria-haspopup="listbox" aria-expanded="false" title="Escolher país">
      <span class="cp-flag"></span><span class="cp-code"></span><span class="cp-caret">▼</span>
    </button>
    <div class="cp-panel" hidden>
      <input type="search" placeholder="Buscar país, sigla ou código…" aria-label="Buscar país" autocomplete="off">
      <ul class="cp-list" role="listbox"></ul>
    </div>`;
  const btn = host.querySelector(".cp-btn");
  const panel = host.querySelector(".cp-panel");
  const input = panel.querySelector("input");
  const list = panel.querySelector(".cp-list");

  const paintButton = () => {
    btn.querySelector(".cp-flag").textContent = country.flag;
    btn.querySelector(".cp-code").textContent = `+${country.code}`;
    btn.title = `${country.name} (+${country.code})`;
  };

  const paintList = () => {
    if (!results.length) { list.innerHTML = `<li class="cp-empty">Nenhum país encontrado</li>`; return; }
    list.innerHTML = results.map((c, i) => `
      <li role="option" data-i="${i}" class="${i === active ? "active" : ""} ${c.iso === country.iso ? "selected" : ""}"
          aria-selected="${c.iso === country.iso}">
        <span class="cp-flag">${c.flag}</span><span class="cp-name">${c.name}</span><span class="cp-code">+${c.code}</span>
      </li>`).join("");
    list.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
  };

  const filter = () => { results = searchCountries(input.value); active = 0; paintList(); };

  const choose = (c) => {
    if (!c) return;
    const changed = c.iso !== country.iso;
    country = c;
    paintButton();
    close();
    if (changed) onChange(country);
  };

  const open = () => {
    panel.hidden = false; btn.setAttribute("aria-expanded", "true");
    input.value = ""; filter();
    active = Math.max(0, results.findIndex((c) => c.iso === country.iso)); paintList();
    input.focus();
  };
  const close = () => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); };

  btn.addEventListener("click", () => (panel.hidden ? open() : close()));
  input.addEventListener("input", filter);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { active = Math.min(results.length - 1, active + 1); paintList(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); paintList(); e.preventDefault(); }
    else if (e.key === "Enter") { choose(results[active]); e.preventDefault(); }
    else if (e.key === "Escape") { close(); btn.focus(); }
  });
  list.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) choose(results[Number(li.dataset.i)]);
  });
  document.addEventListener("pointerdown", (e) => { if (!host.contains(e.target)) close(); });

  paintButton();
  return {
    get country() { return country; },
    set(iso) { const c = byIso(iso); if (c) { country = c; paintButton(); } },
    open, close,
  };
};
