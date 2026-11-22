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
  try { r = JSON.parse(json); } catch (e) { p.rej(new Error('Ungültige Antwort')); return; }
  r.ok ? p.res(r.data) : p.rej(new Error(r.error));
};

function api(method, args) {
  return new Promise((res, rej) => {
    if (!window.Android) { rej(new Error('Nicht in der Android-App gestartet')); return; }
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
};
let sheetStack = [];

const KIND_OPTIONS = [['', 'Alle Typen'], ['spell', 'Zauber (Magier)'], ['talent', 'Talente (Krieger/Schurke)'],
  ['skill', 'Fertigkeiten'], ['trait', 'Immunitäten (experimentell)']];

// ------------------------------------------------------------------ native events
window.onNative = (name, payload) => {
  const p = payload ? JSON.parse(payload) : {};
  if (name === 'picked') onPicked(p);
  else if (name === 'exported' || name === 'writeback') {
    st.busy = false;
    toast(p.msg || (p.ok ? 'Gespeichert' : 'Fehlgeschlagen'), !p.ok);
    if (p.ok && p.final) closeSheets();
  } else if (name === 'cancel') { st.busy = false; }
};

// returns true when the back press was handled inside the page
window.onBack = () => {
  if (sheetStack.length) { closeSheet(); return true; }
  if (st.ov && st.area.openKey) { st.area.openKey = null; render(); return true; }
  if (st.ov && st.tab !== 'overview') { st.tab = 'overview'; render(); return true; }
  return false;
};
window.isDirty = () => st.dirty;

// ------------------------------------------------------------------ opening files
async function onPicked(p) {
  st.file = p;
  try {
    const saves = await api('list_saves', { zip_path: p.path });
    if (!saves.length) { toast('In dieser ZIP wurde kein Spielstand (.das) gefunden', true); return; }
    if (saves.length === 1) await openSave(saves[0].member);
    else chooseSave(saves);
  } catch (e) { toast(e.message, true); }
}

function chooseSave(saves) {
  sheet('Spielstand auswählen', h('div', {},
    h('p', { class: 'note' }, saves.length + ' Spielstände gefunden – der mit der längsten Spielzeit ist der neueste.'),
    saves.map(s => h('div', { class: 'listrow tap', role: 'button', tabindex: 0, onclick: () => { closeSheets(); openSave(s.member); } },
      h('div', { class: 't' }, s.title || s.character || 'Spielstand',
        h('small', {}, [s.character, s.area, s.played && ('Spielzeit ' + s.played), s.level && ('Level ' + s.level), s.saved].filter(Boolean).join(' · ')))))));
}

async function openSave(member) {
  loading(true);
  try {
    st.ov = await api('open_save', { zip_path: st.file.path, member });
    st.dirty = false; st.tab = 'overview'; st.inv = 'backpack'; st.q = ''; st.char = 0; st.seg = 'points';
    st.abil.rows = null; st.area = { ai: null, kind: 'placeables', empty: false, containers: null, openKey: null, openName: '' };
    render();
    toast('Spielstand geöffnet');
  } catch (e) { toast(e.message, true); }
  loading(false);
}

function loading(on) {
  st.busy = on;
  const m = $('main');
  if (on && m) m.prepend(h('div', { id: 'loading', class: 'empty' }, h('span', { class: 'spinner' }), ' Lade …'));
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
      h('button', { class: 'btn danger block', onclick: () => { closeSheet(); resolve(true); } }, okLabel || 'OK'),
      h('button', { class: 'btn block', onclick: () => { closeSheet(); resolve(false); } }, 'Abbrechen')));
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
    sheet('Gespeichert (CRC32 ' + crc + ')', h('div', {},
      h('p', { class: 'note' }, 'Die Änderungen stecken jetzt in der ZIP-Kopie der App, inklusive aktualisierter .x-Prüfsumme. Jetzt die Datei speichern:'),
      h('button', { class: 'btn primary block', onclick: () => { st.busy = true; window.Android.exportZip(); } }, 'Als neue ZIP speichern (empfohlen)'),
      h('button', { class: 'btn block', onclick: async () => {
        if (await confirmSheet('Original überschreiben?', 'Die ursprüngliche ZIP wird ersetzt. Lege vorher eine Sicherheitskopie an.', 'Überschreiben')) {
          st.busy = true; window.Android.writeBack();
        }
      } }, 'Original überschreiben'),
      h('button', { class: 'btn block', onclick: closeSheets }, 'Später')));
  } catch (e) { loading(false); toast(e.message, true); }
}

// ------------------------------------------------------------------ top bar / shell
function updateTop() {
  const b = $('#savebtn');
  if (b) { b.classList.toggle('primary', st.dirty); const d = $('.dot', b); if (d) d.classList.toggle('hidden', !st.dirty); }
}

const TABS = [['overview', '🏰', 'Übersicht'], ['items', '🎒', 'Items'], ['char', '🧙', 'Charakter'], ['areas', '🗺️', 'Gebiete']];

function render() {
  const app = $('#app');
  app.replaceChildren();
  if (!st.ov) { app.append(homeView()); return; }
  app.append(
    h('header', { class: 'top' },
      h('h1', {}, 'Savegame Editor', h('span', { class: 'sub' }, st.file ? st.file.name : '')),
      h('button', { id: 'savebtn', class: 'btn small' + (st.dirty ? ' primary' : ''), onclick: doSave },
        'Speichern', h('span', { class: 'dot' + (st.dirty ? '' : ' hidden') }))),
    h('main', {}, ...[tabView()]),
    h('nav', { class: 'tabs', role: 'tablist' }, TABS.map(([id, ic, label]) =>
      h('button', { role: 'tab', 'aria-selected': st.tab === id, onclick: () => { st.tab = id; st.area.openKey = null; render(); } },
        h('span', { class: 'ic', 'aria-hidden': 'true' }, ic), label))));
  updateTop();
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
    h('p', {}, 'Spielstand-Editor für XDroid360. Öffne die ZIP, die du in XDroid360 exportiert hast.'),
    h('button', { class: 'btn primary', style: 'min-width:220px', onclick: () => { window.Android.pickZip(); } }, 'ZIP-Datei öffnen'),
    h('p', { class: 'note', style: 'margin-top:24px' }, 'Tipp: Vor dem Bearbeiten immer eine Sicherheitskopie des Spielstands anlegen.')));
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
      maxButton ? h('button', { class: 'btn', onclick: () => { input.value = max; commit(); } }, 'Max') : null));
}

function overviewTab() {
  const ov = st.ov;
  return h('div', {},
    h('div', { class: 'card' }, h('h2', {}, 'Inventar'),
      numberField('Geld (Kupfer)', ov.money, { min: 0, max: 999999999, maxButton: true,
        onChange: v => change('set_general', { money: v }) }),
      h('div', { style: 'height:12px' }),
      numberField('Max. Gewicht / Inventarplätze', ov.capacity, { min: 0, max: 999999999, maxButton: true,
        onChange: v => change('set_general', { capacity: v }) }),
      h('div', { class: 'row', style: 'margin-top:12px' }, h('span', { class: 'muted' }, 'Spielzeit'), h('b', {}, ov.played || 'unbekannt'))),
    ov.approvals.length ? h('div', { class: 'card' }, h('h2', {}, 'Zustimmung der Gefährten'),
      ov.approvals.map(a => approvalRow(a))) : null,
    h('div', { class: 'card' }, h('h2', {}, 'Datei'),
      h('button', { class: 'btn block', onclick: () => {
        const go = () => window.Android.pickZip();
        if (st.dirty) confirmSheet('Ungespeicherte Änderungen', 'Beim Öffnen einer anderen Datei gehen die Änderungen verloren.', 'Verwerfen').then(ok => ok && go());
        else go();
      } }, 'Andere ZIP öffnen')),
    h('p', { class: 'note' }, 'Ob geänderte Werte im Spiel überall wirken, ist nicht für jeden Fall geprüft. Immer mit Sicherheitskopie arbeiten.'));
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
      inv.name + ' (' + inv.count + ')'))), itemList(st.inv, true));
}

function itemList(key, withSearch) {
  const wrap = h('div', {});
  const list = h('div', {});
  const more = h('button', { class: 'btn block hidden', onclick: () => load(false) }, 'Mehr laden');
  const info = h('p', { class: 'note' });
  let rows = [], total = 0;
  const search = h('input', { type: 'search', placeholder: 'Suchen (Name oder ResRef) …', value: st.q, 'aria-label': 'Suche' });
  search.addEventListener('input', debounce(() => { st.q = search.value; load(true); }, 250));
  if (withSearch) wrap.append(h('div', { style: 'margin-bottom:10px' }, search));
  wrap.append(info, list, more);

  async function load(reset) {
    try {
      const d = await api('items', { key, query: withSearch ? search.value : '', offset: reset ? 0 : rows.length, limit: 50 });
      rows = reset ? d.rows : rows.concat(d.rows);
      total = d.total;
      list.replaceChildren(...rows.map(r => itemCard(key, r, reload)));
      info.textContent = total ? total + ' Einträge' : '';
      if (!total) list.append(h('div', { class: 'empty' }, 'Keine Gegenstände'));
      more.classList.toggle('hidden', rows.length >= total);
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
  const cnt = h('input', { type: 'number', inputmode: 'numeric', class: 'num', value: r.count, min: 0, 'aria-label': 'Anzahl' });
  cnt.addEventListener('change', () => change('item_set', { key, i: r.i, field: 'count', value: cnt.value }).then(x => { r.count = x.count; cnt.value = x.count; }, () => { cnt.value = r.count; }));
  const inf = h('input', { type: 'checkbox', checked: !!r.infinite, 'aria-label': 'Unendlich' });
  inf.addEventListener('change', () => change('item_set', { key, i: r.i, field: 'infinite', value: inf.checked ? 1 : 0 }).then(x => { r.infinite = x.infinite; }, () => { inf.checked = !!r.infinite; }));
  return h('div', { class: 'item' },
    h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', { class: 'name' }, r.name || r.resref, r.plot ? h('span', { class: 'badge' }, 'Plot') : null),
        h('div', { class: 'ref mono' }, r.resref)),
      h('button', { class: 'icon-btn', 'aria-label': 'Aktionen', onclick: () => itemActions(key, r, reload) }, '⋮')),
    h('div', { class: 'controls' },
      h('label', { class: 'cnt' }, 'Anzahl', cnt),
      h('label', { class: 'switch' }, inf, 'Unendlich')));
}

function itemActions(key, r, reload) {
  const act = (label, fn, cls) => h('button', { class: 'btn block ' + (cls || ''), onclick: () => { closeSheet(); fn(); } }, label);
  sheet(r.name || r.resref, h('div', {},
    h('p', { class: 'mono muted' }, r.resref),
    act('Gegenstand aus Liste wählen …', () => pickItem(key, r, reload)),
    act('ResRef von Hand ändern …', () => editResRef(key, r, reload)),
    act('Duplizieren', async () => { await change('item_duplicate', { key, i: r.i }); toast('Dupliziert (ans Ende der Liste)'); reload(); }),
    act('Verschieben nach …', () => moveItem(key, r, reload)),
    act('Alle Felder bearbeiten …', () => editFields(key, r, reload)),
    act('Löschen', async () => { if (await confirmSheet('Gegenstand löschen?', (r.name || r.resref) + ' wird entfernt.', 'Löschen')) { await change('item_delete', { key, i: r.i }); reload(); } }, 'danger')));
}

function editResRef(key, r, reload) {
  const input = h('input', { type: 'text', value: r.resref, autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false' });
  sheet('ResRef ändern', h('div', {}, h('p', { class: 'note' }, 'Nur Buchstaben, Ziffern und _ .'), input,
    h('button', { class: 'btn primary block', style: 'margin-top:12px', onclick: async () => {
      try { await change('item_set', { key, i: r.i, field: 'resref', value: input.value }); closeSheet(); reload(); } catch (e) { /* toast shown */ }
    } }, 'Übernehmen')));
  setTimeout(() => input.focus(), 50);
}

function pickItem(key, r, reload) {
  const results = h('div', {});
  const input = h('input', { type: 'search', placeholder: 'z. B. ring, staff, cold …', autocomplete: 'off' });
  const run = debounce(async () => {
    const q = input.value.trim();
    if (!q) { results.replaceChildren(h('p', { class: 'note' }, 'Begriff eingeben, um die ' + '8000+ bekannten Gegenstände zu durchsuchen.')); return; }
    try {
      const list = await api('search_known_items', { query: q });
      results.replaceChildren(...(list.length ? list.map(it => h('div', { class: 'listrow tap', role: 'button', tabindex: 0, onclick: async () => {
        try { await change('item_set', { key, i: r.i, field: 'resref', value: it.resref }); closeSheet(); reload(); } catch (e) { /* toast */ }
      } }, h('div', { class: 't' }, it.name, h('small', { class: 'mono' }, it.resref)))) : [h('div', { class: 'empty' }, 'Keine Treffer')]));
      if (list.length >= 300) results.prepend(h('p', { class: 'note' }, 'Erste 300 Treffer – Suche verfeinern.'));
    } catch (e) { toast(e.message, true); }
  }, 250);
  input.addEventListener('input', run);
  sheet('Gegenstand wählen', h('div', {}, input, h('div', { style: 'height:8px' }), results));
  run();
  setTimeout(() => input.focus(), 50);
}

function moveItem(key, r, reload) {
  const others = st.ov.inventories.filter(i => i.key !== key);
  sheet('Verschieben nach', h('div', {}, others.map(i => h('button', { class: 'btn block', onclick: async () => {
    closeSheet();
    try { await change('item_move', { key, i: r.i, dest: i.key }); toast('Verschoben nach ' + i.name); reload(); } catch (e) { /* toast */ }
  } }, i.name))));
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
  sheet('Alle Felder', h('div', {}, h('p', { class: 'note' }, 'Zahlen und Texte sind änderbar, Listen und Strukturen nicht.'), rows,
    h('button', { class: 'btn primary block', onclick: async () => {
      const texts = {};
      for (const [label, { el, orig }] of Object.entries(inputs)) if (el.value !== orig) texts[label] = el.value;
      if (!Object.keys(texts).length) { closeSheet(); return; }
      try {
        const res = await change('item_apply_fields', { key, i: r.i, texts });
        closeSheet();
        if (res.errors.length) toast('Nicht übernommen: ' + res.errors.join('; '), true);
        reload();
      } catch (e) { /* toast */ }
    } }, 'Übernehmen')));
}

// ------------------------------------------------------------------ character tab
function charTab() {
  const sel = h('select', { 'aria-label': 'Charakter', onchange: e => { st.char = parseInt(e.target.value, 10); st.abil.rows = null; render(); } },
    st.ov.characters.map(c => h('option', { value: c.idx, selected: c.idx === st.char }, c.name)));
  const seg = h('div', { class: 'seg', role: 'tablist' }, [['points', 'Punkte'], ['abil', 'Fähigkeiten'], ['stats', 'Werte']].map(([id, label]) =>
    h('button', { role: 'tab', 'aria-selected': st.seg === id, onclick: () => { st.seg = id; render(); } }, label)));
  const body = st.seg === 'points' ? pointsView() : st.seg === 'abil' ? abilitiesView() : statsView();
  return h('div', {}, h('div', { style: 'margin-bottom:12px' }, sel), seg, body);
}

function pointsView() {
  const box = h('div', {});
  api('points', { ci: st.char }).then(d => {
    box.append(h('div', { class: 'card' }, h('h2', {}, 'Nicht ausgegebene Punkte'), d.points.map(p => {
      const input = h('input', { type: 'number', inputmode: 'numeric', value: p.value, min: 0, max: 9999, 'aria-label': p.label });
      const setv = async v => {
        v = Math.max(0, Math.min(9999, v));
        try { p.value = await change('points_set', { ci: st.char, index: p.index, value: v }); } catch (e) { /* toast */ }
        input.value = p.value;
      };
      input.addEventListener('change', () => setv(parseInt(input.value, 10) || 0));
      return h('div', { class: 'listrow' },
        h('div', { class: 't' }, p.label, h('small', {}, p.hint)),
        h('div', { class: 'stepper' },
          h('button', { 'aria-label': 'weniger', onclick: () => setv(p.value - 1) }, '−'), input,
          h('button', { 'aria-label': 'mehr', onclick: () => setv(p.value + 1) }, '+')));
    })), h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Level'), h('b', {}, d.level)),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Erfahrung'), h('b', {}, d.xp))),
    h('p', { class: 'note' }, 'Nicht vorhandene Einträge werden beim Ändern automatisch angelegt.'));
  }).catch(e => toast(e.message, true));
  return box;
}

function abilitiesView() {
  const A = st.abil;
  const box = h('div', {});
  const list = h('div', {});
  const info = h('p', { class: 'note' });
  const more = h('button', { class: 'btn block hidden' }, 'Mehr anzeigen');

  const search = h('input', { type: 'search', placeholder: 'Suchen (Name, Gruppe, ID) …', value: A.q, 'aria-label': 'Suche' });
  const kind = h('select', { 'aria-label': 'Typ' }, KIND_OPTIONS.map(([v, l]) => h('option', { value: v, selected: v === A.kind }, l)));
  const only = h('input', { type: 'checkbox', checked: A.learned });

  function draw() {
    if (!A.rows) return;
    const words = A.q.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = A.rows.filter(r => (!A.kind || r.kind === A.kind) && (!A.learned || r.learned) &&
      words.every(w => (r.name + ' ' + r.group + ' ' + r.id).toLowerCase().includes(w)));
    list.replaceChildren(...shown.slice(0, A.limit).map(abilityRow));
    info.textContent = shown.length + ' Einträge';
    more.classList.toggle('hidden', shown.length <= A.limit);
    if (!shown.length) list.append(h('div', { class: 'empty' }, 'Keine Treffer'));
  }
  function abilityRow(r) {
    const cb = h('input', { type: 'checkbox', checked: r.learned, 'aria-label': r.name, style: 'width:26px;height:26px;accent-color:var(--accent)' });
    cb.addEventListener('change', async () => {
      const want = cb.checked;
      if (!r.known && !want && !(await confirmSheet('Unbekannte Fähigkeit entfernen?', 'Eintrag ' + r.id + ' ist dem Editor nicht bekannt (vermutlich intern). Das Entfernen kann Nebenwirkungen haben.', 'Trotzdem entfernen'))) { cb.checked = true; return; }
      try { await change('ability_set', { ci: st.char, kind: r.kind, ability_id: r.id, learned: want }); r.learned = want; }
      catch (e) { cb.checked = !want; }
    });
    return h('label', { class: 'listrow' }, cb, h('div', { class: 't' }, r.name, h('small', {}, r.group + ' · ' + r.kind_title + ' · ID ' + r.id)));
  }
  search.addEventListener('input', debounce(() => { A.q = search.value; A.limit = 80; draw(); }, 200));
  kind.addEventListener('change', () => { A.kind = kind.value; A.limit = 80; draw(); });
  only.addEventListener('change', () => { A.learned = only.checked; A.limit = 80; draw(); });
  more.addEventListener('click', () => { A.limit += 120; draw(); });

  box.append(h('div', { style: 'margin-bottom:8px' }, search), h('div', { style: 'margin-bottom:8px' }, kind),
    h('div', { class: 'row', style: 'margin-bottom:8px' }, h('label', { class: 'switch grow' }, only, 'Nur gelernte'),
      h('button', { class: 'btn small', onclick: addAbilityById }, 'ID hinzufügen')),
    info, list, more);

  if (A.rows) draw();
  else api('abilities', { ci: st.char }).then(rows => { A.rows = rows; draw(); }).catch(e => toast(e.message, true));
  return box;
}

function addAbilityById() {
  const id = h('input', { type: 'number', inputmode: 'numeric', min: 0, max: 999999, placeholder: 'ID' });
  const kind = h('select', {}, [['spell', 'Zauber (Magier)'], ['talent', 'Talent (Krieger/Schurke)'], ['skill', 'Fertigkeit']].map(([v, l]) => h('option', { value: v }, l)));
  sheet('Fähigkeit per ID hinzufügen', h('div', {}, h('p', { class: 'note' }, 'ID wie beim Konsolenbefehl „runscript addtalent <id>“.'), id,
    h('div', { style: 'height:10px' }), kind,
    h('button', { class: 'btn primary block', style: 'margin-top:12px', onclick: async () => {
      const v = parseInt(id.value, 10);
      if (isNaN(v)) { toast('ID fehlt', true); return; }
      try { await change('ability_set', { ci: st.char, kind: kind.value, ability_id: v, learned: true }); closeSheet(); st.abil.rows = null; render(); toast('Hinzugefügt'); } catch (e) { /* toast */ }
    } }, 'Hinzufügen')));
}

function statsView() {
  const box = h('div', {});
  const list = h('div', {});
  let data = null;
  const COLS = [['base', 'Basis'], ['mod', 'Modifikator'], ['cur', 'Aktuell'], ['regen', 'Regen.'], ['comregen', 'Kampf-Regen.']];
  function row(r) {
    return h('div', { class: 'item' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, r.name), h('div', { class: 'ref mono' }, 'Index ' + r.id))),
      h('div', { class: 'statgrid' }, COLS.filter(([c]) => r[c] !== null).map(([c, label]) => {
        const input = h('input', { type: 'text', inputmode: 'decimal', value: String(r[c]), 'aria-label': r.name + ' ' + label });
        input.addEventListener('change', () => change('stat_set', { ci: st.char, i: r.i, col: c, value: input.value }).then(v => { r[c] = v; input.value = String(v); }, () => { input.value = String(r[c]); }));
        return h('label', {}, h('span', { class: 'field-label' }, label), input);
      })));
  }
  function draw() { list.replaceChildren(...data.rows.map(row)); }
  api('stats', { ci: st.char }).then(d => { data = d; draw(); }).catch(e => toast(e.message, true));
  const add = h('button', { class: 'btn block', style: 'margin-bottom:12px', onclick: () => {
    if (!data) return;
    const sel = h('select', {}, data.addable.map(a => h('option', { value: a.id }, a.name)));
    const idx = h('input', { type: 'number', inputmode: 'numeric', min: 1, max: 255, placeholder: 'Index (1–255)' });
    sheet('Eigenschaft hinzufügen', h('div', {}, h('p', { class: 'note' }, 'Bekannte Eigenschaften, die der Charakter noch nicht hat (z. B. Resistenzen):'), sel,
      h('button', { class: 'btn primary block', style: 'margin-top:10px', onclick: async () => {
        try { await change('stat_add', { ci: st.char, index: parseInt(sel.value, 10) }); closeSheet(); render(); toast('Hinzugefügt (Wert 0)'); } catch (e) { /* toast */ }
      } }, 'Hinzufügen'),
      h('p', { class: 'note', style: 'margin-top:16px' }, 'Oder per Index – unbekannte Indizes kann das Spiel ignorieren oder den Spielstand ablehnen.'), idx,
      h('button', { class: 'btn danger block', style: 'margin-top:10px', onclick: async () => {
        const v = parseInt(idx.value, 10);
        if (isNaN(v) || v < 1) { toast('Index fehlt', true); return; }
        try { await change('stat_add', { ci: st.char, index: v }); closeSheet(); render(); toast('Hinzugefügt'); } catch (e) { /* toast */ }
      } }, 'Per Index hinzufügen')));
  } }, '+ Eigenschaft hinzufügen');
  box.append(add, list);
  return box;
}

// ------------------------------------------------------------------ areas tab
function areasTab() {
  const A = st.area;
  if (A.openKey) {
    return h('div', {}, h('div', { class: 'row', style: 'margin-bottom:10px' },
      h('button', { class: 'btn small', onclick: () => { A.openKey = null; render(); } }, '← Zurück'), h('b', { class: 'grow' }, A.openName)),
      itemList(A.openKey, false));
  }
  const areaSel = h('select', { 'aria-label': 'Gebiet' }, h('option', { value: '' }, 'Gebiet wählen …'),
    st.ov.areas.map(a => h('option', { value: a.idx, selected: A.ai === a.idx }, (a.name ? a.name + ' – ' : '') + a.tag)));
  const typeSel = h('select', { 'aria-label': 'Typ' }, st.ov.area_types.map(t => h('option', { value: t.key, selected: A.kind === t.key }, t.name)));
  const empty = h('input', { type: 'checkbox', checked: A.empty });
  const list = h('div', {});
  async function load() {
    list.replaceChildren();
    if (A.ai === null) return;
    try {
      const cs = await api('area_containers', { ai: A.ai, kind: A.kind, show_empty: A.empty });
      list.replaceChildren(...(cs.length ? cs.map(c => h('div', { class: 'listrow tap', role: 'button', tabindex: 0,
        onclick: () => { A.openKey = c.key; A.openName = c.name; render(); } },
        h('div', { class: 't' }, c.name, h('small', { class: 'mono' }, c.resref)), h('span', { class: 'badge' }, c.count))) : [h('div', { class: 'empty' }, 'Keine Container mit Inhalt')]));
    } catch (e) { toast(e.message, true); }
  }
  areaSel.addEventListener('change', () => { A.ai = areaSel.value === '' ? null : parseInt(areaSel.value, 10); load(); });
  typeSel.addEventListener('change', () => { A.kind = typeSel.value; load(); });
  empty.addEventListener('change', () => { A.empty = empty.checked; load(); });
  load();
  return h('div', {}, h('div', { class: 'card' }, h('div', { style: 'margin-bottom:10px' }, areaSel), h('div', { style: 'margin-bottom:6px' }, typeSel),
    h('label', { class: 'switch' }, empty, 'Leere Container anzeigen')), list,
    h('p', { class: 'note' }, 'Truhen, Händler und Kreaturen in einzelnen Gebieten. Tippe einen Container an, um seinen Inhalt zu bearbeiten.'));
}

// ------------------------------------------------------------------ start
render();
