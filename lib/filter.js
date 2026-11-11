// Shared helpers for picking configurations out of a catalog by loose,
// human-typed names ("iphone 18 pro", "silver", "256gb", "unlocked").

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function findModel(catalog, name) {
  const want = norm(name);
  const models = catalog.models;
  return (
    models.find((m) => norm(m.name) === want) ||
    models.find((m) => norm(m.slug) === want) ||
    // "18 pro" -> "iPhone 18 Pro"; prefer the shortest match so "18 pro" doesn't pick "18 Pro Max".
    models.filter((m) => norm(m.name).includes(want)).sort((a, b) => a.name.length - b.name.length)[0] ||
    null
  );
}

/** values: arrays of loose names; an empty/undefined array means "any". */
export function filterConfigs(configs, { colors, capacities, carriers } = {}) {
  const match = (list, key, label) => (c) => {
    if (!list?.length) return true;
    const wanted = list.map(norm);
    return wanted.includes(norm(c[key])) || wanted.includes(norm(c[label]));
  };
  return configs
    .filter(match(colors, 'colorKey', 'color'))
    .filter(match(capacities, 'capacityKey', 'capacity'))
    .filter(match(carriers, 'carrierKey', 'carrier'));
}

export function optionsOf(configs) {
  const uniq = (k) => [...new Set(configs.map((c) => c[k]))];
  return { colors: uniq('color'), capacities: uniq('capacity'), carriers: uniq('carrier') };
}

/** Flatten an availability result into in-stock (store, config) hits. */
export function inStock(stores, configs) {
  const hits = [];
  for (const s of stores) {
    for (const c of configs) {
      const a = s.availability[c.partNumber];
      if (a?.available) hits.push({ key: `${s.storeNumber}|${c.partNumber}`, store: s, config: c, quote: a.quote });
    }
  }
  // Carrier variants often share one part number; keep one hit per (store, part).
  const seen = new Set();
  return hits.filter((h) => !seen.has(h.key) && seen.add(h.key));
}
