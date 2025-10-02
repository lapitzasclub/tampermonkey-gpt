// ==UserScript==
// @name         ChatGPT: No FOUC + Poda (SPA + FAB UI)
// @namespace    https://tu-ns.example
// @version      1.9.3
// @description  Sin flash, mantiene los últimos N turnos. UI con FAB plegable y estilo contrastado para modo claro/oscuro.
// @match        *://chatgpt.com/*
// @match        *://*.chatgpt.com/*
// @match        *://chat.openai.com/*
// @match        *://*.chat.openai.com/*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  'use strict';
  const page = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  /*** Estado editable ***/
  let KEEP_LATEST = 60;
  let HARD_REMOVE = true;
  const OBSERVE_DELAY = 150;
  const INTERCEPT_API = false; // si quieres recortar JSON, pon true

  /*** Selectores ***/
  const THREAD_SELECTORS = ['#thread', 'main [data-testid="conversation"]', 'main'];
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';

  /*** Anti-flash ***/
  const html = document.documentElement;
  html.setAttribute('data-lean-lock', 'on');
  const lockStyle = document.createElement('style');
  lockStyle.textContent = `
    html[data-lean-lock="on"] #main { visibility: hidden !important; opacity: 0 !important; }
  `;
  (document.head || document.documentElement).prepend(lockStyle);

  /*** Estado interno ***/
  const removedMap = new WeakMap();
  let lastRun = 0;
  let threadObserver = null;
  let ui = null;

  /*** Utils ***/
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const resolveThreadRoot = () => THREAD_SELECTORS.map(s => $(s)).find(Boolean) || document;
  const getTurns = root => $$(TURN_SELECTOR, root).filter(n => n && !n.hasAttribute('data-collapsed-msg'));
  const countCollapsed = root => $$('[data-collapsed-msg]', root).length;
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v==null? d: JSON.parse(v);} catch{ return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch{} }
  };

  /*** Poda ***/
  function makePlaceholder(idx, total) {
    const ph = document.createElement('div');
    ph.setAttribute('data-collapsed-msg', '1');
    Object.assign(ph.style, {
      padding: '6px 10px', margin: '6px 0',
      border: '1px dashed var(--border, #555)', borderRadius: '8px',
      fontSize: '12px', opacity: '0.9', userSelect: 'none',
      cursor: HARD_REMOVE ? 'default' : 'pointer'
    });
    const label = `Mensaje antiguo colapsado (${idx}/${total}).`;
    ph.textContent = HARD_REMOVE ? label : `${label} Click para restaurar.`;
    if (!HARD_REMOVE) {
      ph.addEventListener('click', () => {
        const original = removedMap.get(ph);
        if (original && ph.parentNode) { ph.replaceWith(original); removedMap.delete(ph); updateUI(); }
      });
    }
    return ph;
  }

  function prune(root, { firstRun=false, force=false } = {}) {
    const now = Date.now();
    if (!firstRun && now - lastRun < OBSERVE_DELAY) return;
    lastRun = now;

    const nodes = getTurns(root);
    const total = nodes.length;

    if (!force && total <= KEEP_LATEST) { updateUI({ total, collapsed: countCollapsed(root) }); return; }

    const cutoff = Math.max(0, total - KEEP_LATEST);
    for (let i = 0; i < cutoff; i++) {
      const el = nodes[i];
      if (!el || el.dataset._leanCollapsed === '1') continue;
      const ph = makePlaceholder(i + 1, total);
      if (HARD_REMOVE) el.replaceWith(ph);
      else { removedMap.set(ph, el); el.replaceWith(ph); }
      el.dataset._leanCollapsed = '1';
    }
    updateUI({ total, collapsed: countCollapsed(root) });
  }

  /*** UI — FAB plegable con alto contraste ***/
  function computeTheme() {
    // Intento de respetar tema del sitio; fallback por scheme
    const body = document.body;
    const bg = body ? getComputedStyle(body).backgroundColor : 'rgb(30,30,30)';
    const isDark = (() => {
      const m = bg.match(/\d+/g)?.map(Number) || [30,30,30];
      const [r,g,b] = m; const yiq = (r*299 + g*587 + b*114)/1000;
      return yiq < 140; // umbral simple
    })();
    return isDark ? {
      bg: 'rgba(24,24,28,0.92)',
      fg: '#fff',
      border: 'rgba(255,255,255,.18)',
      panelShadow: '0 8px 24px rgba(0,0,0,.35)'
    } : {
      bg: 'rgba(255,255,255,0.92)',
      fg: '#111',
      border: 'rgba(0,0,0,.15)',
      panelShadow: '0 8px 24px rgba(0,0,0,.15)'
    };
  }

  function buttonBase(el) {
    Object.assign(el.style, {
      border: '1px solid var(--lc-border)',
      background: 'transparent',
      color: 'var(--lc-fg)',
      padding: '6px 8px',
      borderRadius: '8px',
      cursor: 'pointer',
      lineHeight: '1',
      fontSize: '12px',
      whiteSpace: 'nowrap'
    });
    el.onmouseenter = () => { el.style.background = 'var(--lc-hover)'; };
    el.onmouseleave = () => { el.style.background = 'transparent'; };
  }

  function showUI() {
    if ($('#lean-fab')) return;

    const theme = computeTheme();
    const root = document.createElement('div');
    root.id = 'lean-ui-root';
    root.style.setProperty('--lc-bg', theme.bg);
    root.style.setProperty('--lc-fg', theme.fg);
    root.style.setProperty('--lc-border', theme.border);
    root.style.setProperty('--lc-hover', theme.fg === '#fff' ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)');

    // FAB
    const fab = document.createElement('button');
    fab.id = 'lean-fab';
    Object.assign(fab.style, {
      position: 'fixed', bottom: '16px', right: '16px', zIndex: 999999,
      width: '48px', height: '48px', borderRadius: '50%',
      background: 'var(--lc-bg)', color: 'var(--lc-fg)',
      border: '1px solid var(--lc-border)', boxShadow: '0 6px 16px rgba(0,0,0,.25)',
      display: 'grid', placeItems: 'center', backdropFilter: 'blur(8px)'
    });
    fab.title = 'Herramientas de poda';
    fab.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
    buttonBase(fab);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'lean-panel';
    Object.assign(panel.style, {
      position: 'fixed', bottom: '72px', right: '16px', zIndex: 999999,
      minWidth: '280px', maxWidth: '340px',
      background: 'var(--lc-bg)', color: 'var(--lc-fg)',
      border: '1px solid var(--lc-border)', borderRadius: '12px',
      boxShadow: computeTheme().panelShadow, padding: '10px 10px 8px',
      display: 'none', backdropFilter: 'blur(10px)'
    });

    const header = document.createElement('div');
    Object.assign(header.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' });
    const title = document.createElement('strong');
    title.textContent = 'LeanChat';
    title.style.fontSize = '13px';

    const info = document.createElement('span');
    info.textContent = 'Detectados: —  Colapsados: —  Mantener: —';
    info.style.fontSize = '12px';
    info.style.opacity = '0.9';

    header.append(title);

    // Controles
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' });

    const inputKeep = document.createElement('input');
    Object.assign(inputKeep, { type: 'number', min: '0', step: '1', value: String(KEEP_LATEST), title: 'Mensajes a mantener' });
    Object.assign(inputKeep.style, {
      width: '78px', padding: '6px 8px', borderRadius: '8px',
      background: 'transparent', color: 'var(--lc-fg)', border: '1px solid var(--lc-border)'
    });

    const btnApply = document.createElement('button');
    btnApply.textContent = 'Aplicar';
    buttonBase(btnApply);

    const btnPrune = document.createElement('button');
    btnPrune.textContent = 'Colapsar';
    buttonBase(btnPrune);

    const btnRestore = document.createElement('button');
    btnRestore.textContent = 'Restaurar';
    buttonBase(btnRestore);

    const btnHard = document.createElement('button');
    btnHard.textContent = HARD_REMOVE ? 'Hard Remove: ON' : 'Hard Remove: OFF';
    buttonBase(btnHard);

    // Footer con info
    const footer = document.createElement('div');
    Object.assign(footer.style, { marginTop: '8px', fontSize: '11px', opacity: '0.8' });
    footer.append(info);

    row.append(
      document.createTextNode('Mantener: '), inputKeep,
      btnApply, btnPrune, btnRestore, btnHard
    );
    panel.append(header, row, footer);

    // Toggle FAB
    const OPEN_KEY = 'leanchat-panel-open';
    const setOpen = (open) => {
      panel.style.display = open ? 'block' : 'none';
      fab.innerHTML = open
        ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M6 18L18 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
        : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
      ls.set(OPEN_KEY, open);
    };
    fab.addEventListener('click', () => setOpen(panel.style.display === 'none'));
    setOpen(!!ls.get(OPEN_KEY, false)); // restaurar estado

    // Acciones
    const resolveRoot = resolveThreadRoot;
    const updateInputFromState = () => { if (String(KEEP_LATEST) !== inputKeep.value) inputKeep.value = String(KEEP_LATEST); };

    btnApply.addEventListener('click', () => {
      KEEP_LATEST = Math.max(0, parseInt(inputKeep.value || '0', 10));
      const root = resolveRoot();
      prune(root, { firstRun: true, force: true });
      updateUI();
    });
    btnPrune.addEventListener('click', () => {
      const root = resolveRoot();
      prune(root, { firstRun: true, force: true });
      updateUI();
    });
    btnRestore.addEventListener('click', () => {
      if (HARD_REMOVE) return;
      const root = resolveRoot();
      $$('[data-collapsed-msg]', root).forEach(ph => {
        const original = removedMap.get(ph);
        if (original && ph.parentNode) { ph.replaceWith(original); removedMap.delete(ph); }
      });
      updateUI();
    });
    btnHard.addEventListener('click', () => {
      HARD_REMOVE = !HARD_REMOVE;
      btnHard.textContent = HARD_REMOVE ? 'Hard Remove: ON' : 'Hard Remove: OFF';
      btnRestore.title = HARD_REMOVE ? 'HARD_REMOVE=true: no hay nada que restaurar' : '';
    });

    // Montaje
    root.append(fab, panel);
    document.body.appendChild(root);

    ui = { fab, panel, info, inputKeep, btnApply, btnPrune, btnRestore, btnHard };
    updateInputFromState();
    updateUI();
    // Recalcular contraste por si cambia el tema
    setTimeout(() => { const t = computeTheme();
      root.style.setProperty('--lc-bg', t.bg);
      root.style.setProperty('--lc-fg', t.fg);
      root.style.setProperty('--lc-border', t.border);
      root.style.setProperty('--lc-hover', t.fg === '#fff' ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)');
    }, 50);
  }

  function updateUI(forced) {
    if (!ui) return;
    const root = resolveThreadRoot();
    const total = forced?.total ?? (getTurns(root).length + countCollapsed(root));
    const collapsed = forced?.collapsed ?? countCollapsed(root);
    ui.info.textContent = `Detectados: ${total} — Colapsados: ${collapsed} — Mantener: ${KEEP_LATEST}`;
    ui.btnHard && (ui.btnHard.textContent = HARD_REMOVE ? 'Hard Remove: ON' : 'Hard Remove: OFF');
    ui.btnRestore && (ui.btnRestore.title = HARD_REMOVE ? 'HARD_REMOVE=true: no hay nada que restaurar' : '');
  }

  /*** Observadores / bootstrap ***/
  function detachThreadObserver() {
    if (threadObserver) { try { threadObserver.disconnect(); } catch {} threadObserver = null; }
  }

  function initOnThread() {
    const root = resolveThreadRoot();
    if (!root) return false;

    prune(root, { firstRun: true }); // respetará KEEP_LATEST
    detachThreadObserver();
    threadObserver = new MutationObserver(() => prune(root));
    threadObserver.observe(root, { childList: true, subtree: true });

    html.setAttribute('data-lean-lock', 'off');
    showUI();
    updateUI();
    return true;
  }

  const boot = setInterval(() => { if (initOnThread()) clearInterval(boot); }, 50);

  // Hooks SPA
  const reinitSoon = () => {
    html.setAttribute('data-lean-lock', 'on');
    setTimeout(() => { detachThreadObserver(); initOnThread(); }, 200);
  };
  const _ps = page.history && page.history.pushState;
  const _rs = page.history && page.history.replaceState;
  if (_ps) page.history.pushState = function(){ const r=_ps.apply(this,arguments); reinitSoon(); return r; };
  if (_rs) page.history.replaceState = function(){ const r=_rs.apply(this,arguments); reinitSoon(); return r; };
  page.addEventListener('popstate', reinitSoon);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reinitSoon(); });

  /*** (Opcional) Interceptor API ***/
  if (INTERCEPT_API && page.fetch) {
    const isConvUrl = url => {
      try { const u = typeof url === 'string' ? new URL(url, location.origin) : new URL(url.url, location.origin);
            return /\/backend-api\/conversation\/[a-f0-9-]+$/i.test(u.pathname); } catch { return false; }
    };
    const keepLastNTurnsFromMapping = (data, n) => {
      if (!data || !data.mapping || typeof data.mapping !== 'object') return data;
      const nodes = Object.values(data.mapping);
      const turns = nodes.filter(x => x?.message?.author && /^(user|assistant)$/.test(x.message.author.role));
      turns.sort((a,b) => (a.message?.create_time ?? a.create_time ?? 0) - (b.message?.create_time ?? b.create_time ?? 0));
      const keepTurns = turns.slice(-n);
      const keepIds = new Set(keepTurns.map(x => x.id));
      const extraParents = new Set();
      for (const t of keepTurns) {
        let p = t.parent, guard = 0;
        while (p && !keepIds.has(p) && !extraParents.has(p) && guard++ < 500) {
          extraParents.add(p);
          const pn = data.mapping[p]; p = pn ? pn.parent : null;
        }
      }
      const finalIds = new Set([...keepIds, ...extraParents]);
      const newMapping = {};
      for (const id of finalIds) if (data.mapping[id]) newMapping[id] = data.mapping[id];
      const last = keepTurns[keepTurns.length - 1];
      return { ...data, mapping: newMapping, current_node: last ? last.id : data.current_node };
    };
    const _fetch = page.fetch.bind(page);
    page.fetch = async function(input, init) {
      const p = _fetch(input, init);
      try {
        const req = input && input.url ? input.url : input;
        if (!isConvUrl(req)) return p;
        const res = await p;
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('application/json')) return res;
        const json = await res.clone().json();
        const trimmed = keepLastNTurnsFromMapping(json, KEEP_LATEST);
        return new Response(new Blob([JSON.stringify(trimmed)], { type: 'application/json' }), {
          status: res.status, statusText: res.statusText, headers: res.headers
        });
      } catch { return p; }
    };
  }
})();
