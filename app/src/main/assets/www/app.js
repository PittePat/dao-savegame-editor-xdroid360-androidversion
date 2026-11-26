'use strict';
/* Touch UI of the Dragon Age: Origins savegame editor. All data work happens in Python (bridge.py);
   this file only talks to it through window.Android.call(id, method, json). */

// ------------------------------------------------------------------ helpers
const $ = (sel, el = document) => el.querySelector(sel);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

let toastTimer = null;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, isErr ? 5000 : 2200);
}

const pending = {};
let nextId = 1;
window.__resolve = (id, json) => {
  const p = pending[id];
  delete pending[id];
  if (!p) return;
  let r;
  try { r = JSON.parse(json); } catch (e) { p.rej(new Error(t('err.bad_reply'))); return; }
  r.ok ? p.res(r.data) : p.rej(new Error(r.error));
};

function api(method, args) {
  return new Promise((res, rej) => {
    if (!window.Android) { rej(new Error(t('err.no_android'))); return; }
    const id = nextId++;
    pending[id] = { res, rej };
    window.Android.call(id, method, JSON.stringify(args || {}));
  });
}

// mutating call: marks the save as changed, reports errors as toast
async function change(method, args) {
  try {
    const data = await api(method, args);
    st.dirty = true;
    updateTop();
    return data;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ------------------------------------------------------------------ state
const st = {
  file: null,        // {path, name}
  saves: null,
  ov: null,          // overview from python
  tab: 'overview',
  dirty: false,
  inv: 'backpack',
  q: '',
  items: { rows: [], total: 0, size: 0 },
  char: 0,
  seg: 'points',
  abil: { rows: null, q: '', kind: '', learned: false, limit: 80 },
  area: { ai: null, kind: 'placeables', empty: false, containers: null, openKey: null, openName: '' },
  busy: false,
  langPref: 'auto',
  loaded: {},       // item list key -> rows loaded so far (so a re-render restores the same length)
};
let sheetStack = [];

const KIND_KEYS = ['', 'spell', 'talent', 'skill', 'trait'];

// ------------------------------------------------------------------ scroll position memory
const scrollMem = {};
let curView = null;
let restorePending = false;
let restored = true;   // false while a freshly rendered view has not yet been scrolled back (its scrollTop is not meaningful)

function viewKey() {
  if (!st.ov) return 'home';
  switch (st.tab) {
    case 'items': return 'items:' + st.inv;
    case 'char': return 'char:' + st.char + ':' + st.seg;
    case 'areas': return st.area.openKey ? 'area:' + st.area.openKey : 'areas';
    default: return 'overview';
  }
}
// called once the (possibly asynchronously loaded) content of a freshly rendered view is in the DOM
function restoreScroll() {
  if (!restorePending) return;
  restorePending = false;
  const key = curView;
  // wait a frame: views that draw synchronously call this before <main> is attached to the page
  requestAnimationFrame(() => {
    const m = $('main');
    if (m && curView === key) m.scrollTop = scrollMem[key] || 0;
    restored = true;
  });
}

// ------------------------------------------------------------------ language
function applyLang() {
  const device = window.Android ? window.Android.deviceLang() : navigator.language;
  currentLang = resolveLang(st.langPref, device);
  document.documentElement.lang = currentLang;
  api('set_lang', { lang: currentLang }).catch(() => {});
}
function langSelect() {
  const sel = h('select', { 'aria-label': t('lang.label') },
    h('option', { value: 'auto', selected: st.langPref === 'auto' }, t('lang.auto')),
    LANGUAGES.map(([code, name]) => h('option', { value: code, selected: st.langPref === code }, name)));
  sel.addEventListener('change', () => {
    st.langPref = sel.value;
    if (window.Android) window.Android.setLang(st.langPref);
    applyLang();
    st.abil.rows = null;      // ability list carries translated titles
    render();
  });
  return h('div', {}, h('label', { class: 'field-label' }, t('lang.label')), sel);
}
const invName = inv => (I18N[currentLang]['inv.' + inv.key] || I18N.en['inv.' + inv.key]) ? t('inv.' + inv.key) : inv.name;

// ------------------------------------------------------------------ native events
window.onNative = (name, payload) => {
  const p = payload ? JSON.parse(payload) : {};
  if (name === 'picked') onPicked(p);
  else if (name === 'exported' || name === 'writeback') {
    st.busy = false;
    toast(t('native.' + p.code, { arg: p.arg || '' }), !p.ok);
    if (p.ok && p.final) closeSheets();
  } else if (name === 'cancel') { st.busy = false; }
};

// returns true when the back press was handled inside the page
window.onBack = () => {
  if (sheetStack.length) { closeSheet(); return true; }
  if (st.ov && st.area.openKey) { st.area.openKey = null; render(); return true; }
  if (st.ov && st.tab !== 'overview') { st.tab = 'overview'; render(); return true; }
  if (st.dirty) {
    confirmSheet(t('exit.title'), t('exit.text'), t('exit.ok')).then(ok => { if (ok) window.Android.quit(); });
    return true;
  }
  return false;
};
window.isDirty = () => st.dirty;

// ------------------------------------------------------------------ opening files
async function onPicked(p) {
  st.file = p;
  try {
    const saves = await api('list_saves', { zip_path: p.path });
    if (!saves.length) { toast(t('no_saves'), true); return; }
    if (saves.length === 1) await openSave(saves[0].member);
    else chooseSave(saves);
  } catch (e) { toast(e.message, true); }
}

function chooseSave(saves) {
  sheet(t('pick.title'), h('div', {},
    h('p', { class: 'note' }, t('pick.hint', { n: saves.length })),
    saves.map(s => h('div', { class: 'listrow tap', role: 'button', tabindex: 0, onclick: () => { closeSheets(); openSave(s.member); } },
      h('div', { class: 't' }, s.title || s.character || t('pick.default'),
        h('small', {}, [s.character, s.area, s.played && t('pick.played', { v: s.played }), s.level && t('pick.level', { v: s.level }), s.saved].filter(Boolean).join(' · ')))))));
}

async function openSave(member) {
  loading(true);
  try {
    st.ov = await api('open_save', { zip_path: st.file.path, member });
    for (const k of Object.keys(scrollMem)) delete scrollMem[k];
    st.loaded = {};
    st.dirty = false; st.tab = 'overview'; st.inv = 'backpack'; st.q = ''; st.char = 0; st.seg = 'points';
    st.abil.rows = null; st.area = { ai: null, kind: 'placeables', empty: false, containers: null, openKey: null, openName: '' };
    render();
    toast(t('opened'));
  } catch (e) { toast(e.message, true); }
  loading(false);
}

function loading(on) {
  st.busy = on;
  const m = $('main');
  if (on && m) m.prepend(h('div', { id: 'loading', class: 'empty' }, h('span', { class: 'spinner' }), ' ' + t('loading')));
  else { const l = $('#loading'); if (l) l.remove(); }
}

// ------------------------------------------------------------------ sheets
function sheet(title, body) {
  const scrim = h('div', { class: 'scrim', onclick: e => { if (e.target === scrim) closeSheet(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h3', {}, title), body));
  document.body.append(scrim);
  sheetStack.push(scrim);
  return scrim;
}
function closeSheet() { const s = sheetStack.pop(); if (s) s.remove(); }
function closeSheets() { while (sheetStack.length) closeSheet(); }

function confirmSheet(title, text, okLabel) {
  return new Promise(resolve => {
    sheet(title, h('div', {}, h('p', {}, text),
      h('button', { class: 'btn danger block', onclick: () => { closeSheet(); resolve(true); } }, okLabel || t('btn.ok')),
      h('button', { class: 'btn block', onclick: () => { closeSheet(); resolve(false); } }, t('btn.cancel'))));
  });
}

// ------------------------------------------------------------------ saving
async function doSave() {
  if (!st.ov) return;
  try {
    loading(true);
    const crc = await api('save');
    st.dirty = false; updateTop();
    loading(false);
    sheet(t('saved.title', { crc }), h('div', {},
      h('p', { class: 'note' }, t('saved.text')),
      h('button', { class: 'btn primary block', onclick: () => { st.busy = true; window.Android.exportZip(); } }, t('saved.new')),
      h('button', { class: 'btn block', onclick: async () => {
        if (await confirmSheet(t('overwrite.title'), t('overwrite.text'), t('overwrite.ok'))) {
          st.busy = true; window.Android.writeBack();
        }
      } }, t('saved.overwrite')),
      h('button', { class: 'btn block', onclick: closeSheets }, t('saved.later'))));
  } catch (e) { loading(false); toast(e.message, true); }
}

// ------------------------------------------------------------------ top bar / shell
function updateTop() {
  const b = $('#savebtn');
  if (b) { b.classList.toggle('primary', st.dirty); const d = $('.dot', b); if (d) d.classList.toggle('hidden', !st.dirty); }
}

const TABS = [['overview', '🏰'], ['items', '🎒'], ['char', '🧙'], ['areas', '🗺️']];

function render() {
  const app = $('#app');
  const oldMain = $('main');
  if (oldMain && curView && restored) scrollMem[curView] = oldMain.scrollTop;   // remember where we were
  restored = false;
  setTimeout(() => { restored = true; }, 1500);   // safety net if a view never finishes loading
  app.replaceChildren();
  curView = viewKey();
  restorePending = true;
  if (!st.ov) { app.append(homeView()); restoreScroll(); return; }
  app.append(
    h('header', { class: 'top' },
      h('h1', {}, 'Savegame Editor', h('span', { class: 'sub' }, st.file ? st.file.name : '')),
      h('button', { id: 'savebtn', class: 'btn small' + (st.dirty ? ' primary' : ''), onclick: doSave },
        t('btn.save'), h('span', { class: 'dot' + (st.dirty ? '' : ' hidden') }))),
    h('main', {}, ...[tabView()]),
    h('nav', { class: 'tabs', role: 'tablist' }, TABS.map(([id, ic]) =>
      h('button', { role: 'tab', 'aria-selected': st.tab === id, onclick: () => { st.tab = id; st.area.openKey = null; render(); } },
        h('span', { class: 'ic', 'aria-hidden': 'true' }, ic), t('tab.' + id)))));
  updateTop();
  if (st.tab === 'overview') restoreScroll();   // the other tabs restore once their data has loaded
}

function tabView() {
  switch (st.tab) {
    case 'items': return itemsTab();
    case 'char': return charTab();
    case 'areas': return areasTab();
    default: return overviewTab();
  }
}

function homeView() {
  return h('main', {}, h('div', { class: 'hero' },
    h('div', { class: 'logo', 'aria-hidden': 'true' }, '🐉'),
    h('h2', {}, 'Dragon Age: Origins'),
    h('p', {}, t('home.text')),
    h('button', { class: 'btn primary', style: 'min-width:220px', onclick: () => { window.Android.pickZip(); } }, t('home.open')),
    h('p', { class: 'note', style: 'margin-top:24px' }, t('home.tip')),
    h('div', { style: 'max-width:280px;margin:24px auto 0;text-align:left' }, langSelect())));
}

// ------------------------------------------------------------------ overview tab
function numberField(label, value, { min, max, onChange, maxButton }) {
  const input = h('input', { type: 'number', inputmode: 'numeric', class: 'num', value, min, max, 'aria-label': label });
  const commit = () => {
    let v = parseInt(input.value, 10);
    if (isNaN(v)) { input.value = value; return; }
    if (max !== undefined) v = Math.min(v, max);
    if (min !== undefined) v = Math.max(v, min);
    input.value = v;
    value = v;
    onChange(v);
  };
  input.addEventListener('change', commit);
  return h('div', {},
    h('label', { class: 'field-label' }, label),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, input),
      maxButton ? h('button', { class: 'btn', onclick: () => { input.value = max; commit(); } }, t('btn.max')) : null));
}

function overviewTab() {
  const ov = st.ov;
  return h('div', {},
    h('div', { class: 'card' }, h('h2', {}, t('ov.inventory')),
      numberField(t('ov.money'), ov.money, { min: 0, max: 999999999, maxButton: true,
        onChange: v => change('set_general', { money: v }) }),
      h('div', { style: 'height:12px' }),
      numberField(t('ov.capacity'), ov.capacity, { min: 0, max: 999999999, maxButton: true,
        onChange: v => change('set_general', { capacity: v }) }),
      h('div', { class: 'row', style: 'margin-top:12px' }, h('span', { class: 'muted' }, t('ov.played')), h('b', {}, ov.played || t('ov.unknown')))),
    ov.approvals.length ? h('div', { class: 'card' }, h('h2', {}, t('ov.approval')),
      ov.approvals.map(a => approvalRow(a))) : null,
    h('div', { class: 'card' }, langSelect()),
    h('div', { class: 'card' }, h('h2', {}, t('ov.file')),
      h('button', { class: 'btn block', onclick: () => {
        const go = () => window.Android.pickZip();
        if (st.dirty) confirmSheet(t('exit.title'), t('discard.text'), t('discard.ok')).then(ok => ok && go());
        else go();
      } }, t('ov.open_other'))),
    h('p', { class: 'note' }, t('ov.note')));
}

function approvalRow(a) {
  const out = h('b', { style: 'min-width:3ch;text-align:right' }, a.level);
  const range = h('input', { type: 'range', min: -100, max: 100, step: 1, value: a.level, 'aria-label': a.name });
  range.addEventListener('input', () => { out.textContent = range.value; });
  range.addEventListener('change', () => change('set_approval', { pid: a.id, level: parseInt(range.value, 10) }).then(v => { a.level = v; }));
  return h('div', { style: 'margin-bottom:8px' }, h('div', { class: 'row' }, h('span', { class: 'grow' }, a.name), out), range);
}

// ------------------------------------------------------------------ items
function itemsTab() {
  return h('div', {}, h('div', { class: 'chips', role: 'tablist' }, st.ov.inventories.map(inv =>
    h('button', { class: 'chip', 'aria-pressed': st.inv === inv.key, onclick: () => { st.inv = inv.key; st.q = ''; render(); } },
      invName(inv) + ' (' + inv.count + ')'))), itemList(st.inv, true));
}

function itemList(key, withSearch) {
  const wrap = h('div', {});
  const list = h('div', {});
  const more = h('button', { class: 'btn block hidden', onclick: () => load(false) }, t('btn.more'));
  const info = h('p', { class: 'note' });
  let rows = [], total = 0;
  const search = h('input', { type: 'search', placeholder: t('items.search'), value: st.q, 'aria-label': 'Suche' });
  search.addEventListener('input', debounce(() => { st.q = search.value; st.loaded[key] = 0; load(true); }, 250));
  if (withSearch) wrap.append(h('div', { style: 'margin-bottom:10px' }, search));
  wrap.append(info, list, more);

  async function load(reset) {
    try {
      const d = await api('items', { key, query: withSearch ? search.value : '', offset: reset ? 0 : rows.length, limit: reset ? Math.max(50, st.loaded[key] || 0) : 50 });
      rows = reset ? d.rows : rows.concat(d.rows);
      total = d.total;
      st.loaded[key] = rows.length;
      list.replaceChildren(...rows.map(r => itemCard(key, r, reload)));
      info.textContent = total ? t('items.count', { n: total }) : '';
      if (!total) list.append(h('div', { class: 'empty' }, t('items.empty')));
      more.classList.toggle('hidden', rows.length >= total);
      restoreScroll();
    } catch (e) { toast(e.message, true); }
  }
  const reload = () => load(true).then(refreshCounts);
  load(true);
  return wrap;
}

async function refreshCounts() {
  try { const ov = await api('overview'); st.ov.inventories = ov.inventories; } catch (e) { /* ignore */ }
}

function itemCard(key, r, reload) {
  const cnt = h('input', { type: 'number', inputmode: 'numeric', class: 'num', value: r.count, min: 0, 'aria-label': t('items.qty') });
  cnt.addEventListener('change', () => change('item_set', { key, i: r.i, field: 'count', value: cnt.value }).then(x => { r.count = x.count; cnt.value = x.count; }, () => { cnt.value = r.count; }));
  const inf = h('input', { type: 'checkbox', checked: !!r.infinite, 'aria-label': t('items.infinite') });
  inf.addEventListener('change', () => change('item_set', { key, i: r.i, field: 'infinite', value: inf.checked ? 1 : 0 }).then(x => { r.infinite = x.infinite; }, () => { inf.checked = !!r.infinite; }));
  return h('div', { class: 'item' },
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', { class: 'name' }, r.name || r.resref, r.plot ? h('span', { class: 'badge' }, t('items.plot')) : null),
        h('div', { class: 'ref mono' }, r.resref)),
      h('button', { class: 'icon-btn', 'aria-label': t('items.actions'), onclick: () => itemActions(key, r, reload) }, '⋮')),
    h('div', { class: 'controls' },
      h('label', { class: 'cnt' }, t('items.qty'), cnt),
      h('label', { class: 'switch' }, inf, t('items.infinite'))));
}

function itemActions(key, r, reload) {
  const act = (label, fn, cls) => h('button', { class: 'btn block ' + (cls || ''), onclick: () => { closeSheet(); fn(); } }, label);
  sheet(r.name || r.resref, h('div', {},
    h('p', { class: 'mono muted' }, r.resref),
    act(t('act.pick'), () => pickItem(key, r, reload)),
    act(t('act.resref'), () => editResRef(key, r, reload)),
    act(t('act.dup'), async () => { await change('item_duplicate', { key, i: r.i }); toast(t('act.dup_done')); reload(); }),
    act(t('act.move'), () => moveItem(key, r, reload)),
    act(t('act.fields'), () => editFields(key, r, reload)),
    act(t('act.delete'), async () => { if (await confirmSheet(t('del.title'), t('del.text', { name: r.name || r.resref }), t('act.delete'))) { await change('item_delete', { key, i: r.i }); reload(); } }, 'danger')));
}

function editResRef(key, r, reload) {
  const input = h('input', { type: 'text', value: r.resref, autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false' });
  sheet(t('resref.title'), h('div', {}, h('p', { class: 'note' }, t('resref.hint')), input,
    h('button', { class: 'btn primary block', style: 'margin-top:12px', onclick: async () => {
      try { await change('item_set', { key, i: r.i, field: 'resref', value: input.value }); closeSheet(); reload(); } catch (e) { /* toast shown */ }
    } }, t('btn.apply'))));
  setTimeout(() => input.focus(), 50);
}

function pickItem(key, r, reload) {
  const results = h('div', {});
  const input = h('input', { type: 'search', placeholder: t('known.placeholder'), autocomplete: 'off' });
  const run = debounce(async () => {
    const q = input.value.trim();
    if (!q) { results.replaceChildren(h('p', { class: 'note' }, t('known.prompt'))); return; }
    try {
      const list = await api('search_known_items', { query: q });
      results.replaceChildren(...(list.length ? list.map(it => h('div', { class: 'listrow tap', role: 'button', tabindex: 0, onclick: async () => {
        try { await change('item_set', { key, i: r.i, field: 'resref', value: it.resref }); closeSheet(); reload(); } catch (e) { /* toast */ }
      } }, h('div', { class: 't' }, it.name, h('small', { class: 'mono' }, it.resref)))) : [h('div', { class: 'empty' }, t('known.none'))]));
      if (list.length >= 300) results.prepend(h('p', { class: 'note' }, t('known.limit')));
    } catch (e) { toast(e.message, true); }
  }, 250);
  input.addEventListener('input', run);
  sheet(t('known.title'), h('div', {}, input, h('div', { style: 'height:8px' }), results));
  run();
  setTimeout(() => input.focus(), 50);
}

function moveItem(key, r, reload) {
  const others = st.ov.inventories.filter(i => i.key !== key);
  sheet(t('move.title'), h('div', {}, others.map(i => h('button', { class: 'btn block', onclick: async () => {
    closeSheet();
    try { await change('item_move', { key, i: r.i, dest: i.key }); toast(t('act.moved', { to: invName(i) })); reload(); } catch (e) { /* toast */ }
  } }, invName(i)))));
}

async function editFields(key, r, reload) {
  let fields;
  try { fields = await api('item_fields', { key, i: r.i }); } catch (e) { toast(e.message, true); return; }
  const inputs = {};
  const rows = fields.map(f => {
    const el = f.editable ? h('input', { type: 'text', value: f.text, autocapitalize: 'none', spellcheck: 'false' }) : null;
    if (el) inputs[f.label] = { el, orig: f.text };
    return h('div', { style: 'margin-bottom:12px' },
      h('span', { class: 'field-label' }, f.label + ' · ' + f.name + ' · ' + f.type),
      el || h('div', { class: 'muted mono' }, f.text));
  });
  sheet(t('fields.title'), h('div', {}, h('p', { class: 'note' }, t('fields.hint')), rows,
    h('button', { class: 'btn primary block', onclick: async () => {
      const texts = {};
      for (const [label, { el, orig }] of Object.entries(inputs)) if (el.value !== orig) texts[label] = el.value;
      if (!Object.keys(texts).length) { closeSheet(); return; }
      try {
        const res = await change('item_apply_fields', { key, i: r.i, texts });
        closeSheet();
        if (res.errors.length) toast(t('fields.rejected', { e: res.errors.join('; ') }), true);
        reload();
      } catch (e) { /* toast */ }
    } }, t('btn.apply'))));
}

// ------------------------------------------------------------------ character tab
function charTab() {
  const sel = h('select', { 'aria-label': t('char.select'), onchange: e => { st.char = parseInt(e.target.value, 10); st.abil.rows = null; render(); } },
    st.ov.characters.map(c => h('option', { value: c.idx, selected: c.idx === st.char }, c.name)));
  const seg = h('div', { class: 'seg', role: 'tablist' }, ['points', 'abil', 'stats'].map(id =>
    h('button', { role: 'tab', 'aria-selected': st.seg === id, onclick: () => { st.seg = id; render(); } }, t('seg.' + id))));
  const body = st.seg === 'points' ? pointsView() : st.seg === 'abil' ? abilitiesView() : statsView();
  return h('div', {}, h('div', { style: 'margin-bottom:12px' }, sel), seg, body);
}

function pointsView() {
  const box = h('div', {});
  api('points', { ci: st.char }).then(d => {
    box.append(h('div', { class: 'card' }, h('h2', {}, t('pts.title')), d.points.map(p => {
      const input = h('input', { type: 'number', inputmode: 'numeric', value: p.value, min: 0, max: 9999, 'aria-label': t('pt.' + p.index) });
      const setv = async v => {
        v = Math.max(0, Math.min(9999, v));
        try { p.value = await change('points_set', { ci: st.char, index: p.index, value: v }); } catch (e) { /* toast */ }
        input.value = p.value;
      };
      input.addEventListener('change', () => setv(parseInt(input.value, 10) || 0));
      return h('div', { class: 'listrow' },
        h('div', { class: 't' }, t('pt.' + p.index), h('small', {}, t('pth.' + p.index))),
        h('div', { class: 'stepper' },
          h('button', { 'aria-label': t('pts.less'), onclick: () => setv(p.value - 1) }, '−'), input,
          h('button', { 'aria-label': t('pts.more'), onclick: () => setv(p.value + 1) }, '+')));
    })), h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'muted' }, t('pts.level')), h('b', {}, d.level)),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, t('pts.xp')), h('b', {}, d.xp))),
    h('p', { class: 'note' }, t('pts.note')));
    restoreScroll();
  }).catch(e => toast(e.message, true));
  return box;
}

function abilitiesView() {
  const A = st.abil;
  const box = h('div', {});
  const list = h('div', {});
  const info = h('p', { class: 'note' });
  const more = h('button', { class: 'btn block hidden' }, t('btn.show_more'));

  const search = h('input', { type: 'search', placeholder: t('abil.search'), value: A.q, 'aria-label': 'Suche' });
  const kind = h('select', { 'aria-label': 'Type' }, KIND_KEYS.map(v => h('option', { value: v, selected: v === A.kind }, t('kind.' + v))));
  const only = h('input', { type: 'checkbox', checked: A.learned });

  function draw() {
    if (!A.rows) return;
    const words = A.q.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = A.rows.filter(r => (!A.kind || r.kind === A.kind) && (!A.learned || r.learned) &&
      words.every(w => (r.name + ' ' + r.group + ' ' + r.id).toLowerCase().includes(w)));
    list.replaceChildren(...shown.slice(0, A.limit).map(abilityRow));
    info.textContent = t('abil.count', { n: shown.length });
    more.classList.toggle('hidden', shown.length <= A.limit);
    if (!shown.length) list.append(h('div', { class: 'empty' }, t('abil.none')));
    restoreScroll();
  }
  function abilityRow(r) {
    const cb = h('input', { type: 'checkbox', checked: r.learned, 'aria-label': r.name, style: 'width:26px;height:26px;accent-color:var(--accent)' });
    cb.addEventListener('change', async () => {
      const want = cb.checked;
      if (!r.known && !want && !(await confirmSheet(t('abil.unknown_title'), t('abil.unknown_text', { id: r.id }), t('abil.unknown_ok')))) { cb.checked = true; return; }
      try { await change('ability_set', { ci: st.char, kind: r.kind, ability_id: r.id, learned: want }); r.learned = want; }
      catch (e) { cb.checked = !want; }
    });
    return h('label', { class: 'listrow' }, cb, h('div', { class: 't' }, r.name, h('small', {}, r.group + ' · ' + t('kind1.' + r.kind) + ' · ID ' + r.id)));
  }
  search.addEventListener('input', debounce(() => { A.q = search.value; A.limit = 80; draw(); }, 200));
  kind.addEventListener('change', () => { A.kind = kind.value; A.limit = 80; draw(); });
  only.addEventListener('change', () => { A.learned = only.checked; A.limit = 80; draw(); });
  more.addEventListener('click', () => { A.limit += 120; draw(); });

  box.append(h('div', { style: 'margin-bottom:8px' }, search), h('div', { style: 'margin-bottom:8px' }, kind),
    h('div', { class: 'row', style: 'margin-bottom:8px' }, h('label', { class: 'switch grow' }, only, t('abil.learned_only')),
      h('button', { class: 'btn small', onclick: addAbilityById }, t('abil.add_id'))),
    info, list, more);

  if (A.rows) draw();
  else api('abilities', { ci: st.char }).then(rows => { A.rows = rows; draw(); }).catch(e => toast(e.message, true));
  return box;
}

function addAbilityById() {
  const id = h('input', { type: 'number', inputmode: 'numeric', min: 0, max: 999999, placeholder: 'ID' });
  const kind = h('select', {}, ['spell', 'talent', 'skill'].map(v => h('option', { value: v }, t('abil.kind_' + v))));
  sheet(t('abil.add_title'), h('div', {}, h('p', { class: 'note' }, t('abil.add_hint')), id,
    h('div', { style: 'height:10px' }), kind,
    h('button', { class: 'btn primary block', style: 'margin-top:12px', onclick: async () => {
      const v = parseInt(id.value, 10);
      if (isNaN(v)) { toast(t('abil.id_missing'), true); return; }
      try { await change('ability_set', { ci: st.char, kind: kind.value, ability_id: v, learned: true }); closeSheet(); st.abil.rows = null; render(); toast(t('abil.added')); } catch (e) { /* toast */ }
    } }, t('btn.add'))));
}

function statsView() {
  const box = h('div', {});
  const list = h('div', {});
  let data = null;
  const COLS = ['base', 'mod', 'cur', 'regen', 'comregen'];
  function row(r) {
    return h('div', { class: 'item' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, r.name), h('div', { class: 'ref mono' }, t('stat.index', { i: r.id })))),
      h('div', { class: 'statgrid' }, COLS.filter(c => r[c] !== null).map(c => {
        const label = t('stat.' + c);
        const input = h('input', { type: 'text', inputmode: 'decimal', value: String(r[c]), 'aria-label': r.name + ' ' + label });
        input.addEventListener('change', () => change('stat_set', { ci: st.char, i: r.i, col: c, value: input.value }).then(v => { r[c] = v; input.value = String(v); }, () => { input.value = String(r[c]); }));
        return h('label', {}, h('span', { class: 'field-label' }, label), input);
      })));
  }
  function draw() { list.replaceChildren(...data.rows.map(row)); restoreScroll(); }
  api('stats', { ci: st.char }).then(d => { data = d; draw(); }).catch(e => toast(e.message, true));
  const add = h('button', { class: 'btn block', style: 'margin-bottom:12px', onclick: () => {
    if (!data) return;
    const sel = h('select', {}, data.addable.map(a => h('option', { value: a.id }, a.name)));
    const idx = h('input', { type: 'number', inputmode: 'numeric', min: 1, max: 255, placeholder: t('stat.index_ph') });
    sheet(t('stat.add_title'), h('div', {}, h('p', { class: 'note' }, t('stat.add_hint')), sel,
      h('button', { class: 'btn primary block', style: 'margin-top:10px', onclick: async () => {
        try { await change('stat_add', { ci: st.char, index: parseInt(sel.value, 10) }); closeSheet(); render(); toast(t('stat.added0')); } catch (e) { /* toast */ }
      } }, t('btn.add')),
      h('p', { class: 'note', style: 'margin-top:16px' }, t('stat.add_by_index')), idx,
      h('button', { class: 'btn danger block', style: 'margin-top:10px', onclick: async () => {
        const v = parseInt(idx.value, 10);
        if (isNaN(v) || v < 1) { toast(t('stat.index_missing'), true); return; }
        try { await change('stat_add', { ci: st.char, index: v }); closeSheet(); render(); toast(t('abil.added')); } catch (e) { /* toast */ }
      } }, t('stat.add_idx_btn'))));
  } }, t('stat.add'));
  box.append(add, list);
  return box;
}

// ------------------------------------------------------------------ areas tab
function areasTab() {
  const A = st.area;
  if (A.openKey) {
    return h('div', {}, h('div', { class: 'row', style: 'margin-bottom:10px' },
      h('button', { class: 'btn small', onclick: () => { A.openKey = null; render(); } }, t('btn.back')), h('b', { class: 'grow' }, A.openName)),
      itemList(A.openKey, false));
  }
  const areaSel = h('select', { 'aria-label': 'Area' }, h('option', { value: '' }, t('area.pick')),
    st.ov.areas.map(a => h('option', { value: a.idx, selected: A.ai === a.idx }, (a.name ? a.name + ' – ' : '') + a.tag)));
  const typeSel = h('select', { 'aria-label': 'Type' }, st.ov.area_types.map(t_ => h('option', { value: t_.key, selected: A.kind === t_.key }, t('at.' + t_.key))));
  const empty = h('input', { type: 'checkbox', checked: A.empty });
  const list = h('div', {});
  async function load() {
    list.replaceChildren();
    if (A.ai === null) { restoreScroll(); return; }
    try {
      const cs = await api('area_containers', { ai: A.ai, kind: A.kind, show_empty: A.empty });
      list.replaceChildren(...(cs.length ? cs.map(c => h('div', { class: 'listrow tap', role: 'button', tabindex: 0,
        onclick: () => { A.openKey = c.key; A.openName = c.name; render(); } },
        h('div', { class: 't' }, c.name, h('small', { class: 'mono' }, c.resref)), h('span', { class: 'badge' }, c.count))) : [h('div', { class: 'empty' }, t('area.none'))]));
    restoreScroll();
    } catch (e) { toast(e.message, true); }
  }
  areaSel.addEventListener('change', () => { A.ai = areaSel.value === '' ? null : parseInt(areaSel.value, 10); load(); });
  typeSel.addEventListener('change', () => { A.kind = typeSel.value; load(); });
  empty.addEventListener('change', () => { A.empty = empty.checked; load(); });
  load();
  return h('div', {}, h('div', { class: 'card' }, h('div', { style: 'margin-bottom:10px' }, areaSel), h('div', { style: 'margin-bottom:6px' }, typeSel),
    h('label', { class: 'switch' }, empty, t('area.empty'))), list,
    h('p', { class: 'note' }, t('area.note')));
}

// ------------------------------------------------------------------ start
st.langPref = window.Android ? window.Android.getLang() : 'auto';
applyLang();
render();
