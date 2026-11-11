import { fetchAvailability } from '/lib/apple.js';
import { detectBridge, bridgeTransport, bridgeMarker } from './bridge.js';

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
  ntfy: $('#ntfy'),
  mode: $('#mode'),
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
  nightsky: '#22283a', starwhite: '#f2f1ec', softpink: '#f3d3d6',
};

const state = {
  catalog: null,
  selected: { color: new Set(), capacity: new Set(), carrier: new Set() },
  lastResult: null,
  previouslyAvailable: null, // Set of "store|part" from the previous check
  timer: null,
  busy: false,
  bridge: null, // { version } when the Apple bridge userscript is installed
  recent: null, // { key, at, stores } — avoid re-asking Apple within 30 s
};
const RECENT_MS = 30000;

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
    ntfy: els.ntfy.value.trim(),
    selected: Object.fromEntries(Object.entries(state.selected).map(([k, v]) => [k, [...v]])),
  });
}

// ---------- api ----------
async function api(path, params) {
  const res = await fetch(`${path}?${new URLSearchParams(params)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { code: body.code });
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
    const result = await getAvailability(els.country.value, loc, parts);
    const fresh = diffNew(result);
    state.lastResult = { ...result, configs, fresh };
    render();
    if (fresh.size && state.previouslyAvailable !== null) alertNew(result, fresh, configs);
    state.previouslyAvailable = availableKeys(result);
  } catch (err) {
    if (err.code === 'apple_blocked') showBlocked(err.message);
    else setStatus(esc(err.message), 'error');
  } finally {
    state.busy = false;
    els.check.disabled = false;
    schedule();
  }
}

async function getAvailability(country, location, parts) {
  if (DEMO) {
    return api('/api/availability', { country, location, parts: parts.join(','), demo: '1' });
  }
  if (!state.bridge) {
    state.bridge = await detectBridge(500);
    renderMode();
  }
  if (!state.bridge) {
    return { ...(await api('/api/availability', { country, location, parts: parts.join(',') })), via: 'server' };
  }
  // Browser mode: ask Apple from this browser via the userscript.
  const key = `${country}|${location.toLowerCase()}|${[...parts].sort().join(',')}`;
  let stores;
  if (state.recent?.key === key && Date.now() - state.recent.at < RECENT_MS) {
    stores = state.recent.stores;
  } else {
    stores = await fetchAvailability(country, location, parts, { transport: bridgeTransport });
    state.recent = { key, at: Date.now(), stores };
  }
  return { country, location, demo: false, via: 'browser', checkedAt: new Date().toISOString(), stores };
}

const INSTALL_STEPS = `
  <li>Install <a href="https://www.tampermonkey.net" target="_blank" rel="noopener">Tampermonkey</a> or <a href="https://violentmonkey.github.io" target="_blank" rel="noopener">Violentmonkey</a>.</li>
  <li><b>Chrome, Edge or Brave:</b> open the extensions page (<code>chrome://extensions</code>), click <i>Details</i> on Tampermonkey, and turn on <b>Allow User Scripts</b>. On older versions, turn on <b>Developer mode</b> at the top right instead. Without this, Chrome silently skips every userscript.</li>
  <li>Open the <a href="/apple-bridge.user.js" target="_blank">Apple bridge userscript</a> and click <b>Install</b> (or <b>Update</b>).</li>
  <li>Reload this page. The line under the form should say <b>Browser mode</b>.</li>`;

function showBlocked(message) {
  const marker = bridgeMarker();
  let help;
  if (state.bridge) {
    help = `<p>The browser bridge is working, but Apple still refused.</p><ol>
        <li>Open <a href="https://www.apple.com/shop/buy-iphone" target="_blank" rel="noopener">apple.com/shop/buy-iphone</a> in this browser, browse a page or two, then try again.</li>
        <li>If it keeps happening, use a slower auto-refresh interval. Apple may be rate-limiting you.</li>
      </ol>`;
  } else if (marker) {
    help = `<p>The Apple bridge userscript (v${esc(marker)}) is installed on this page but isn't answering. Update it to the latest version and reload:</p><ol>${INSTALL_STEPS}</ol>`;
  } else {
    help = `<p>The Apple bridge userscript isn't running on this page, so the request went through the local server instead.</p><ol>${INSTALL_STEPS}</ol>`;
  }
  setStatus(`<b>${esc(message)}</b>${help}`, 'error');
}

function renderMode() {
  if (DEMO) {
    els.mode.className = 'mode';
    els.mode.innerHTML = '<span class="dot"></span>Demo mode: availability is made up.';
  } else if (state.bridge) {
    els.mode.className = 'mode on';
    els.mode.innerHTML = `<span class="dot"></span>Browser mode: stock requests go through your browser (Apple bridge v${esc(state.bridge.version)}).`;
  } else {
    els.mode.className = 'mode';
    const marker = bridgeMarker();
    els.mode.innerHTML = marker
      ? `<span class="dot"></span>Apple bridge v${esc(marker)} is installed but not answering. <a href="/apple-bridge.user.js" target="_blank">Update it</a>, then reload.`
      : '<span class="dot"></span>Browser bridge not detected. Apple only answers stock requests from a real browser. <a href="/apple-bridge.user.js" target="_blank">Install the Apple bridge userscript</a> (needs Tampermonkey or Violentmonkey; on Chrome also turn on <i>Allow User Scripts</i>), then reload.';
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
  if (!els.notify.checked && !els.ntfy.value.trim()) return;
  if (els.notify.checked) beep();
  const byPart = Object.fromEntries(configs.map((c) => [c.partNumber, c]));
  const lines = [...fresh].slice(0, 4).map((k) => {
    const [storeNum, pn] = k.split('|');
    const s = result.stores.find((x) => x.storeNumber === storeNum);
    const c = byPart[pn];
    return `${c ? `${c.color} ${c.capacity}` : pn} @ ${s?.name ?? storeNum}`;
  });
  if (els.notify.checked && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(`${currentModel()?.name ?? 'iPhone'} in stock!`, { body: lines.join('\n'), tag: 'isc' });
    n.onclick = () => window.focus();
  }
  document.title = `(${fresh.size}) In stock! – iPhone Stock Checker`;
  sendNtfy(`${currentModel()?.name ?? 'iPhone'} in stock`, lines.join('\n') + (fresh.size > lines.length ? `\n…and ${fresh.size - lines.length} more` : ''), firstUrl(fresh, byPart));
}

function firstUrl(fresh, byPart) {
  const pn = [...fresh][0]?.split('|')[1];
  return byPart[pn]?.url;
}

async function sendNtfy(title, body, url) {
  const topic = els.ntfy.value.trim();
  if (!topic) return;
  const endpoint = /^https?:\/\//.test(topic) ? topic : `https://ntfy.sh/${encodeURIComponent(topic)}`;
  const headers = { Title: title, Tags: 'iphone', Priority: 'high' };
  if (url) headers.Click = url;
  try {
    await fetch(endpoint, { method: 'POST', headers, body });
  } catch (err) {
    console.warn('ntfy failed', err);
  }
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
els.ntfy.addEventListener('change', saveSettings);
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
  if (saved.ntfy) els.ntfy.value = saved.ntfy;
  state.bridge = DEMO ? null : await detectBridge();
  renderMode();
  await loadCatalog(saved);
})();
