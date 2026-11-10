const $ = (sel) => document.querySelector(sel);
const els = {
  form: $('#controls'),
  country: $('#country'),
  location: $('#location'),
  model: $('#model'),
  check: $('#check'),
  auto: $('#auto'),
  interval: $('#interval'),
  notify: $('#notify'),
  onlyAvail: $('#onlyAvail'),
  status: $('#status'),
  results: $('#results'),
};
const FILTERS = { color: '#f-color', capacity: '#f-capacity', carrier: '#f-carrier' };
const DEMO = new URLSearchParams(location.search).get('demo') === '1';

const SWATCH = {
  black: '#1d1d1f', white: '#f5f5f0', silver: '#e3e4e5', gold: '#e8d2a6', blue: '#5b7a9a',
  deepblue: '#2f3c55', cosmicorange: '#e46b2b', orange: '#e46b2b', lavender: '#d8cdea', sage: '#bfc9b0',
  mistblue: '#b9c9d9', skyblue: '#cfe0ee', lightgold: '#efe3c8', cloudwhite: '#f4f4f2', spaceblack: '#2a2a2c',
  pink: '#f5c6d0', teal: '#9fcfcf', ultramarine: '#5a6fd6', green: '#cfe3cf', yellow: '#f7e8a4',
  burgundy: '#6d2533', glacier: '#d7e6ee', naturaltitanium: '#c2bcb2', deserttitanium: '#c9b49a',
  whitetitanium: '#ecebe7', blacktitanium: '#3c3c3d',
};

const state = {
  catalog: null,
  selected: { color: new Set(), capacity: new Set(), carrier: new Set() },
  lastResult: null,
  previouslyAvailable: null, // Set of "store|part" from the previous check
  timer: null,
  busy: false,
};

// ---------- persistence ----------
const store = {
  get() { try { return JSON.parse(localStorage.getItem('isc-settings') || '{}'); } catch { return {}; } },
  set(v) { try { localStorage.setItem('isc-settings', JSON.stringify({ ...store.get(), ...v })); } catch {} },
};

function saveSettings() {
  store.set({
    country: els.country.value,
    location: els.location.value,
    model: els.model.value,
    interval: els.interval.value,
    onlyAvail: els.onlyAvail.checked,
    selected: Object.fromEntries(Object.entries(state.selected).map(([k, v]) => [k, [...v]])),
  });
}

// ---------- api ----------
async function api(path, params) {
  const res = await fetch(`${path}?${new URLSearchParams(params)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// ---------- status ----------
function setStatus(html, kind = '') {
  els.status.innerHTML = kind ? `<div class="msg ${kind}">${html}</div>` : html;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- catalog / filters ----------
function currentModel() {
  return state.catalog?.models.find((m) => m.name === els.model.value);
}

function uniqueBy(configs, key, labelKey) {
  const seen = new Map();
  for (const c of configs) if (!seen.has(c[key])) seen.set(c[key], c[labelKey]);
  return [...seen].map(([value, label]) => ({ value, label }));
}

function renderFilters(restore) {
  const model = currentModel();
  const configs = model?.configs || [];
  const dims = {
    color: uniqueBy(configs, 'colorKey', 'color'),
    capacity: uniqueBy(configs, 'capacityKey', 'capacity'),
    carrier: uniqueBy(configs, 'carrierKey', 'carrier'),
  };
  for (const [dim, options] of Object.entries(dims)) {
    const fs = $(FILTERS[dim]);
    const box = fs.querySelector('.chips');
    const valid = new Set(options.map((o) => o.value));
    const keep = [...(restore?.[dim] || state.selected[dim])].filter((v) => valid.has(v));
    // Default: every option selected, except carrier where "Unlocked" is the sensible default.
    let sel = keep.length ? keep : options.map((o) => o.value);
    if (!keep.length && dim === 'carrier' && valid.has('unlocked')) sel = ['unlocked'];
    state.selected[dim] = new Set(sel);
    fs.hidden = options.length <= 1;
    box.innerHTML = options
      .map((o) => {
        const sw = dim === 'color' ? `<span class="swatch" style="background:${SWATCH[o.value.replace(/[^a-z]/g, '')] || '#bbb'}"></span>` : '';
        return `<button type="button" class="chip" data-dim="${dim}" data-value="${esc(o.value)}" aria-pressed="${state.selected[dim].has(o.value)}">${sw}${esc(o.label)}</button>`;
      })
      .join('');
  }
}

function selectedConfigs() {
  const model = currentModel();
  if (!model) return [];
  const { color, capacity, carrier } = state.selected;
  return model.configs.filter((c) => color.has(c.colorKey) && capacity.has(c.capacityKey) && carrier.has(c.carrierKey));
}

async function loadCatalog(restore) {
  els.model.disabled = true;
  els.model.innerHTML = '<option>Loading models…</option>';
  els.check.disabled = true;
  setStatus('Loading the current iPhone lineup from Apple…');
  try {
    state.catalog = await api('/api/catalog', { country: els.country.value });
    const models = state.catalog.models;
    if (!models.length) throw new Error('No iPhone models found for this country.');
    els.model.innerHTML = models.map((m) => `<option>${esc(m.name)}</option>`).join('');
    if (restore?.model && models.some((m) => m.name === restore.model)) els.model.value = restore.model;
    els.model.disabled = false;
    els.check.disabled = false;
    renderFilters(restore?.selected);
    setStatus(`${models.length} models loaded. Enter your location and press <b>Check availability</b>.`);
  } catch (err) {
    els.model.innerHTML = '<option>Unavailable</option>';
    setStatus(esc(err.message), 'error');
  }
}

// ---------- checking ----------
async function check() {
  if (state.busy) return;
  const configs = selectedConfigs();
  const loc = els.location.value.trim();
  if (!loc) return setStatus('Enter a postal code or city to search near.', 'warn');
  if (!configs.length) return setStatus('Select at least one finish, storage size and carrier.', 'warn');

  const parts = [...new Set(configs.map((c) => c.partNumber))];
  state.busy = true;
  els.check.disabled = true;
  setStatus(`Checking ${parts.length} configuration${parts.length === 1 ? '' : 's'} near ${esc(loc)}…`);
  try {
    const result = await api('/api/availability', {
      country: els.country.value,
      location: loc,
      parts: parts.join(','),
      ...(DEMO ? { demo: '1' } : {}),
    });
    const fresh = diffNew(result);
    state.lastResult = { ...result, configs, fresh };
    render();
    if (fresh.size && state.previouslyAvailable !== null) alertNew(result, fresh, configs);
    state.previouslyAvailable = availableKeys(result);
  } catch (err) {
    setStatus(esc(err.message), 'error');
  } finally {
    state.busy = false;
    els.check.disabled = false;
    schedule();
  }
}

function availableKeys(result) {
  const keys = new Set();
  for (const s of result.stores) for (const [pn, a] of Object.entries(s.availability)) if (a.available) keys.add(`${s.storeNumber}|${pn}`);
  return keys;
}

function diffNew(result) {
  const now = availableKeys(result);
  if (!state.previouslyAvailable) return new Set();
  return new Set([...now].filter((k) => !state.previouslyAvailable.has(k)));
}

// ---------- rendering ----------
function render() {
  const r = state.lastResult;
  if (!r) return;
  const configs = r.configs;
  let stores = r.stores;
  const hasStock = (s) => configs.some((c) => s.availability[c.partNumber]?.available);
  const storesWithStock = stores.filter(hasStock);
  if (els.onlyAvail.checked) stores = storesWithStock;

  const availCount = configs.filter((c) => r.stores.some((s) => s.availability[c.partNumber]?.available)).length;
  const time = new Date(r.checkedAt).toLocaleTimeString();
  setStatus(
    `<div class="summary">
      <strong class="${availCount ? 'good' : ''}">${availCount ? `${availCount} of ${configs.length} configurations in stock` : 'Nothing in stock right now'}</strong>
      <span>${storesWithStock.length} of ${r.stores.length} nearby stores have stock</span>
      <span>Checked ${time}${r.demo ? ' · <b>demo data</b>' : ''}</span>
    </div>`,
  );

  if (!r.stores.length) {
    els.results.innerHTML = '<div class="empty panel">Apple didn’t return any stores near that location. Try a different postal code.</div>';
    return;
  }
  if (!stores.length) {
    els.results.innerHTML = '<div class="empty panel">No nearby store has any of the selected configurations right now.</div>';
    return;
  }

  // Each column is a (part, carrier) config; carrier variants usually share one
  // part number and therefore share availability.
  const head = configs
    .map((c) => {
      const sw = SWATCH[c.colorKey.replace(/[^a-z]/g, '')] || '#bbb';
      const showCarrier = state.selected.carrier.size > 1;
      return `<th class="cfg" title="${esc(c.partNumber)}"><span class="color"><span class="swatch" style="background:${sw}"></span>${esc(c.color)}</span><span class="cap">${esc(c.capacity)}</span>${showCarrier ? `<span class="car">${esc(c.carrier)}</span>` : ''}</th>`;
    })
    .join('');

  const rows = stores
    .map((s) => {
      const cells = configs
        .map((c) => {
          const a = s.availability[c.partNumber];
          if (a?.available) {
            const isNew = r.fresh.has(`${s.storeNumber}|${c.partNumber}`);
            return `<td class="cell yes${isNew ? ' new' : ''}"><a href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(a.quote)}">${esc(shortQuote(a.quote))}</a></td>`;
          }
          return `<td class="cell no"><span title="${esc(a?.quote || 'Not offered at this store')}">—</span></td>`;
        })
        .join('');
      const place = [s.city, s.state].filter(Boolean).join(', ');
      return `<tr><td class="store"><div class="name">${esc(s.name)}</div><div class="meta">${esc([place, s.distance].filter(Boolean).join(' · '))}</div></td>${cells}</tr>`;
    })
    .join('');

  els.results.innerHTML = `<div class="table-wrap"><table><thead><tr><th class="store">Store</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function shortQuote(q) {
  if (!q) return 'In stock';
  const m = /today|tomorrow|\b(mon|tue|wed|thu|fri|sat|sun)\w*/i.exec(q);
  return m ? m[0][0].toUpperCase() + m[0].slice(1).toLowerCase() : 'In stock';
}

// ---------- alerts ----------
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.15);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.16);
    });
  } catch {}
}

function alertNew(result, fresh, configs) {
  if (!els.notify.checked) return;
  beep();
  const byPart = Object.fromEntries(configs.map((c) => [c.partNumber, c]));
  const lines = [...fresh].slice(0, 4).map((k) => {
    const [storeNum, pn] = k.split('|');
    const s = result.stores.find((x) => x.storeNumber === storeNum);
    const c = byPart[pn];
    return `${c ? `${c.color} ${c.capacity}` : pn} @ ${s?.name ?? storeNum}`;
  });
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(`${currentModel()?.name ?? 'iPhone'} in stock!`, { body: lines.join('\n'), tag: 'isc' });
    n.onclick = () => window.focus();
  }
  document.title = `(${fresh.size}) In stock! – iPhone Stock Checker`;
}

// ---------- auto refresh ----------
function schedule() {
  clearTimeout(state.timer);
  state.timer = null;
  if (els.auto.checked && state.lastResult) state.timer = setTimeout(check, Number(els.interval.value) * 1000);
}

// ---------- wiring ----------
function resetResults() {
  state.lastResult = null;
  state.previouslyAvailable = null;
  els.results.innerHTML = '';
  document.title = 'iPhone Stock Checker';
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  saveSettings();
  check();
});

els.form.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const { dim, value } = chip.dataset;
  const set = state.selected[dim];
  if (set.has(value)) set.delete(value);
  else set.add(value);
  chip.setAttribute('aria-pressed', set.has(value));
  saveSettings();
  resetResults();
});

els.country.addEventListener('change', () => {
  const c = state.countries.find((x) => x.code === els.country.value);
  els.location.placeholder = c?.postal || '';
  els.location.value = '';
  resetResults();
  saveSettings();
  loadCatalog();
});
els.model.addEventListener('change', () => {
  state.selected = { color: new Set(), capacity: new Set(), carrier: new Set() };
  renderFilters();
  resetResults();
  saveSettings();
});
els.location.addEventListener('change', () => { resetResults(); saveSettings(); });
els.onlyAvail.addEventListener('change', () => { saveSettings(); render(); });
els.interval.addEventListener('change', () => { saveSettings(); schedule(); });
els.auto.addEventListener('change', () => {
  if (els.auto.checked && !state.lastResult) check();
  else schedule();
});
els.notify.addEventListener('change', async () => {
  if (els.notify.checked && 'Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
});
window.addEventListener('focus', () => { document.title = 'iPhone Stock Checker'; });

(async function init() {
  const saved = store.get();
  try {
    state.countries = await api('/api/countries', {});
  } catch (err) {
    return setStatus(esc(err.message), 'error');
  }
  els.country.innerHTML = state.countries.map((c) => `<option value="${c.code}">${esc(c.name)}</option>`).join('');
  if (saved.country && state.countries.some((c) => c.code === saved.country)) els.country.value = saved.country;
  els.location.placeholder = state.countries.find((c) => c.code === els.country.value)?.postal || '';
  if (saved.location) els.location.value = saved.location;
  if (saved.interval) els.interval.value = saved.interval;
  els.onlyAvail.checked = !!saved.onlyAvail;
  await loadCatalog(saved);
})();
