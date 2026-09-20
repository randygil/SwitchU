'use strict';

const $ = (s) => document.querySelector(s);

const el = {
  project: $('#project'), locale: $('#locale'), save: $('#save'),
  reorder: $('#reorder'), search: $('#search'), filters: $('#filters'),
  main: $('#main'), toast: $('#toast'), pathinfo: $('#pathinfo'),
  cov: $('#cov'), covfill: $('#covfill'), covtext: $('#covtext'),
};

let projects = [];
let data = null;            // last /api/locale payload
const edits = new Map();    // key -> edited string (only while dirty)
let filter = 'all';
let query = '';

const PLACEHOLDER = /\{[^}\s]*\}|%[sdfi]|\\n/g;

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function toast(msg, isErr) {
  el.toast.textContent = msg;
  el.toast.classList.toggle('err', !!isErr);
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.hidden = true; }, isErr ? 6000 : 2600);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({ error: 'respuesta no válida' }));
  if (!res.ok || body.error) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
}

/** Current value for a key: the pending edit if any, else what is on disk. */
function valueOf(row) {
  return edits.has(row.key) ? edits.get(row.key) : (row.value ?? '');
}

/** Recompute warnings live, so typing clears/raises them without a reload. */
function issuesFor(row, value) {
  const out = [];
  if (row.status === 'extra') out.push('extra');
  if (row.ref === null || value === '') return out;
  const a = (row.ref.match(PLACEHOLDER) || []).slice().sort().join('');
  const b = (value.match(PLACEHOLDER) || []).slice().sort().join('');
  if (a !== b) out.push('placeholder');
  if (row.ref.endsWith(' ') !== value.endsWith(' ')) out.push('trailing-space');
  if (row.ref.length >= 4 && value.length > Math.max(24, row.ref.length * 1.8)) out.push('long');
  return out;
}

function statusFor(row, value) {
  if (value === '') return 'missing';
  if (row.ref !== null && value === row.ref) return 'untranslated';
  if (row.status === 'extra') return 'extra';
  return 'done';
}

function matches(row) {
  const value = valueOf(row);
  const st = statusFor(row, value);
  const iss = issuesFor(row, value);

  if (filter === 'todo' && st !== 'missing' && st !== 'untranslated' && !iss.length) return false;
  if (filter === 'missing' && st !== 'missing') return false;
  if (filter === 'untranslated' && st !== 'untranslated') return false;
  if (filter === 'issues' && !iss.length) return false;
  if (filter === 'done' && st !== 'done') return false;

  if (query) {
    const hay = (row.key + '' + (row.ref || '') + '' + value).toLowerCase();
    if (!hay.includes(query)) return false;
  }
  return true;
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, 400) + 'px';
}

// --------------------------------------------------------------------------
// rendering
// --------------------------------------------------------------------------

function paintRow(node, row) {
  const value = valueOf(row);
  const st = statusFor(row, value);
  const iss = issuesFor(row, value);
  const dirty = edits.has(row.key) && edits.get(row.key) !== (row.value ?? '');

  node.classList.toggle('is-dirty', dirty);
  node.classList.toggle('bad', iss.length > 0);

  const badges = node.querySelector('.badges');
  badges.textContent = '';
  const labels = { missing: 'falta', untranslated: 'sin traducir' };
  const tags = [];
  if (labels[st]) tags.push([st, labels[st]]);
  for (const i of iss) {
    tags.push([i, { placeholder: 'placeholder', 'trailing-space': 'espacio final', long: 'largo', extra: 'sobra' }[i] || i]);
  }
  for (const [cls, text] of tags) {
    const b = document.createElement('span');
    b.className = 'badge b-' + cls;
    b.textContent = text;
    badges.appendChild(b);
  }

  const len = node.querySelector('.len');
  if (row.ref === null) {
    len.textContent = value.length + ' car.';
    len.classList.remove('over');
  } else {
    len.textContent = row.ref.length + ' → ' + value.length + ' car.';
    len.classList.toggle('over', iss.includes('long'));
  }
  node.querySelector('.revert').hidden = !dirty;
}

function buildRow(row) {
  const node = document.getElementById('row-tpl').content.firstElementChild.cloneNode(true);
  node.dataset.key = row.key;
  node.querySelector('.k').textContent = row.key;
  node.querySelector('.reftext').textContent = row.ref === null ? '— (no está en en-US)' : row.ref;

  const ph = node.querySelector('.ph');
  for (const p of row.placeholders) {
    const c = document.createElement('code');
    c.textContent = p;
    ph.appendChild(c);
  }

  const ta = node.querySelector('textarea');
  ta.value = valueOf(row);
  ta.addEventListener('input', () => {
    edits.set(row.key, ta.value);
    paintRow(node, row);
    autosize(ta);
    refreshSave();
  });
  ta.addEventListener('focus', () => autosize(ta));

  node.querySelector('.copy').addEventListener('click', () => {
    if (row.ref === null) return;
    ta.value = row.ref;
    edits.set(row.key, ta.value);
    paintRow(node, row);
    autosize(ta);
    refreshSave();
    ta.focus();
  });

  node.querySelector('.revert').addEventListener('click', () => {
    edits.delete(row.key);
    ta.value = row.value ?? '';
    paintRow(node, row);
    autosize(ta);
    refreshSave();
  });

  paintRow(node, row);
  requestAnimationFrame(() => autosize(ta));
  return node;
}

function render() {
  el.main.textContent = '';
  if (!data) return;

  const rows = data.rows.filter(matches);
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Nada coincide con este filtro.';
    el.main.appendChild(p);
    return;
  }

  const frag = document.createDocumentFragment();
  let group = null;
  for (const row of rows) {
    const g = row.key.split('.')[0];
    if (g !== group) {
      group = g;
      const h = document.createElement('div');
      h.className = 'group';
      h.textContent = g;
      frag.appendChild(h);
    }
    frag.appendChild(buildRow(row));
  }
  el.main.appendChild(frag);
}

function refreshSave() {
  let n = 0;
  if (data) {
    for (const row of data.rows) {
      if (edits.has(row.key) && edits.get(row.key) !== (row.value ?? '')) n++;
    }
  }
  el.save.disabled = n === 0;
  el.save.textContent = n ? 'Guardar (' + n + ')' : 'Guardar';
  updateCoverage();
  return n;
}

function updateCoverage() {
  if (!data) { el.cov.hidden = true; return; }
  const real = data.rows.filter((r) => r.ref !== null);
  const done = real.filter((r) => {
    const v = valueOf(r);
    return v !== '' && v !== r.ref;
  }).length;
  const pct = real.length ? (100 * done / real.length) : 0;
  el.covfill.style.width = pct.toFixed(1) + '%';
  el.covtext.textContent = done + '/' + real.length + ' (' + pct.toFixed(1) + '%)';
  el.cov.hidden = false;
}

// --------------------------------------------------------------------------
// loading / saving
// --------------------------------------------------------------------------

function fillLocales() {
  const p = projects.find((x) => x.id === el.project.value);
  el.locale.textContent = '';
  if (!p) return;
  for (const l of p.locales) {
    const o = document.createElement('option');
    o.value = l.locale;
    o.textContent = l.locale + (l.isReference ? '  (referencia)' : '  · ' + l.coverage + '%');
    o.disabled = l.isReference;
    el.locale.appendChild(o);
  }
  const preferred = p.locales.find((l) => l.locale === 'es-ES' && !l.isReference)
    || p.locales.find((l) => !l.isReference);
  if (preferred) el.locale.value = preferred.locale;
}

async function loadLocale() {
  const project = el.project.value;
  const locale = el.locale.value;
  if (!project || !locale) return;
  edits.clear();
  el.main.innerHTML = '<p class="empty">Cargando…</p>';
  try {
    data = await api('/api/locale?project=' + encodeURIComponent(project) +
                     '&locale=' + encodeURIComponent(locale));
    el.pathinfo.textContent = data.path + '  ·  ' + data.newline +
      '  ·  ref ' + data.reference;
    render();
    refreshSave();
  } catch (e) {
    data = null;
    el.main.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Error: ' + e.message;
    el.main.appendChild(p);
    toast(e.message, true);
  }
}

async function doSave() {
  if (!data || refreshSave() === 0) return;
  // Send every key, blanks included: the server reads a blank as an explicit
  // delete (the runtime then falls back to en-US for that string).
  const values = {};
  for (const row of data.rows) values[row.key] = valueOf(row);
  el.save.disabled = true;
  el.save.textContent = 'Guardando…';
  try {
    const r = await api('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: el.project.value,
        locale: el.locale.value,
        values,
        reorder: el.reorder.checked,
      }),
    });
    toast('Guardado · ' + r.path + ' (' + r.keys + ' claves)');
    const keep = { f: filter, q: query, y: window.scrollY };
    projects = (await api('/api/projects')).projects;
    await loadLocale();
    filter = keep.f; query = keep.q;
    window.scrollTo(0, keep.y);
  } catch (e) {
    toast('No se pudo guardar: ' + e.message, true);
    refreshSave();
  }
}

// --------------------------------------------------------------------------
// wiring
// --------------------------------------------------------------------------

el.project.addEventListener('change', () => { fillLocales(); loadLocale(); });
el.locale.addEventListener('change', loadLocale);
el.save.addEventListener('click', doSave);

el.filters.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  filter = b.dataset.f;
  for (const x of el.filters.querySelectorAll('button')) x.classList.toggle('on', x === b);
  render();
});

let searchTimer;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { query = el.search.value.trim().toLowerCase(); render(); }, 130);
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); }
  if (e.key === '/' && document.activeElement.tagName !== 'TEXTAREA' &&
      document.activeElement !== el.search) {
    e.preventDefault();
    el.search.focus();
    el.search.select();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!el.save.disabled) { e.preventDefault(); e.returnValue = ''; }
});

(async function init() {
  try {
    const info = await api('/api/projects');
    projects = info.projects;
    for (const p of projects) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      el.project.appendChild(o);
    }
    fillLocales();
    await loadLocale();
  } catch (e) {
    el.main.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No se pudo contactar al servidor: ' + e.message;
    el.main.appendChild(p);
  }
})();
