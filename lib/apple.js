// Talks to the Apple Online Store:
//  - the "buy iPhone" pages, which embed the product catalog (part numbers per
//    model / finish / storage / carrier) as window.PRODUCT_SELECTION_BOOTSTRAP
//  - the fulfillment-messages endpoint, which reports in-store pickup
//    availability for up to a handful of part numbers near a location.
import { storefront } from './countries.js';

const TIMEOUT_MS = 15000;

export class AppleError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function get(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  } catch (err) {
    throw new AppleError(`Could not reach Apple (${err.cause?.code || err.name}).`);
  }
  return res;
}

// ---------- text helpers ----------

export function stripHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/<as-footnote[\s\S]*?<\/as-footnote>/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleFromSlug(slug) {
  return slug
    .split('-')
    .map((w) => (w === 'iphone' ? 'iPhone' : /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/(\d+) e\b/, '$1e');
}

// Pull a balanced JSON object literal out of a string, starting at `start`.
function extractObject(src, start) {
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

// ---------- catalog ----------

export function parseModelSlugs(html, country) {
  const prefix = storefront(country).replace('https://www.apple.com', '');
  const re = new RegExp(`${prefix.replace(/[/-]/g, '\\$&')}/shop/buy-iphone/(iphone-[a-z0-9-]+)`, 'g');
  return [...new Set([...html.matchAll(re)].map((m) => m[1]))];
}

/**
 * Turn one buy-iphone page into a flat list of configurations.
 * Each entry: { partNumber, model, color, colorKey, capacity, capacityKey,
 *               carrier, carrierKey, url }
 */
export function parseProductPage(html, slug, base) {
  const marker = html.indexOf('productSelectionData');
  if (marker < 0) return [];
  const json = extractObject(html, marker);
  if (!json) return [];
  const data = JSON.parse(json);
  const dv = data.displayValues || {};
  const label = (dim, key) => stripHtml(dv[dim]?.[key]?.value) || null;
  const fallbackModel = titleFromSlug(slug);

  const seen = new Set();
  const out = [];
  for (const p of data.products || []) {
    if (!p.partNumber) continue;
    // Carrier variants of the same part number are listed separately; keep
    // each (part, carrier) once so the UI can filter by carrier.
    const key = `${p.partNumber}|${p.carrierModel || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const screen = label('dimensionScreensize', p.dimensionScreensize);
    // e.g. "iPhone 18 Pro 6.3-inch display" -> "iPhone 18 Pro"
    const model = screen ? screen.replace(/\s*[\d.]+-inch.*$/i, '').trim() || fallbackModel : fallbackModel;
    const carrierKey = carrierKeyOf(p.carrierModel);
    // Models sold in a single size (e.g. older iPhones) have no capacity
    // dimension; recover it from the SEO slug ("6.1-inch-display-128gb-pink").
    const capacityKey = p.dimensionCapacity || (/(\d+(?:gb|tb))/i.exec(p.seoUrlToken || '')?.[1] || '').toLowerCase();
    out.push({
      partNumber: p.partNumber,
      slug,
      model,
      family: p.familyType || slug,
      color: label('dimensionColor', p.dimensionColor) || p.dimensionColor || '',
      colorKey: p.dimensionColor || '',
      capacity: label('dimensionCapacity', capacityKey) || capacityKey.toUpperCase(),
      capacityKey,
      carrier: carrierLabel(carrierKey),
      carrierKey,
      url: `${base}/shop/buy-iphone/${slug}${p.seoUrlToken ? '/' + p.seoUrlToken : ''}`,
    });
  }
  return out;
}

function carrierKeyOf(carrierModel) {
  if (!carrierModel || /^UNLOCKED/i.test(carrierModel)) return 'unlocked';
  return carrierModel.split('_')[0].toLowerCase();
}

const CARRIER_NAMES = { unlocked: 'Unlocked', att: 'AT&T', tmobile: 'T-Mobile', verizon: 'Verizon', boost: 'Boost Mobile' };
function carrierLabel(key) {
  return CARRIER_NAMES[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

const capacityOrder = (k) => {
  const m = /^(\d+)(gb|tb)$/i.exec(k || '');
  return m ? Number(m[1]) * (m[2].toLowerCase() === 'tb' ? 1024 : 1) : 0;
};

export async function fetchCatalog(country) {
  const base = storefront(country);
  const indexRes = await get(`${base}/shop/buy-iphone`);
  if (!indexRes.ok) throw new AppleError(`Apple returned HTTP ${indexRes.status} for the iPhone store page.`);
  const slugs = parseModelSlugs(await indexRes.text(), country);
  if (!slugs.length) throw new AppleError('Could not find any iPhone models on the Apple Store page.');

  const pages = await Promise.all(
    slugs.map(async (slug) => {
      const res = await get(`${base}/shop/buy-iphone/${slug}`);
      if (!res.ok) return [];
      // Apple redirects retired models back to /shop/buy-iphone.
      if (!res.url.includes(`/buy-iphone/${slug}`)) return [];
      return parseProductPage(await res.text(), slug, base);
    }),
  );

  const configs = pages.flat();
  const models = [];
  for (const c of configs) {
    let m = models.find((x) => x.name === c.model);
    if (!m) models.push((m = { name: c.model, slug: c.slug, configs: [] }));
    m.configs.push(c);
  }
  for (const m of models) {
    m.configs.sort(
      (a, b) =>
        a.colorKey.localeCompare(b.colorKey) ||
        capacityOrder(a.capacityKey) - capacityOrder(b.capacityKey) ||
        a.carrierKey.localeCompare(b.carrierKey),
    );
  }
  // Keep Apple's own lineup order; within one page, smaller model first
  // ("iPhone 18 Pro" before "iPhone 18 Pro Max").
  models.sort((a, b) => slugs.indexOf(a.slug) - slugs.indexOf(b.slug) || a.name.localeCompare(b.name));
  return { country, fetchedAt: new Date().toISOString(), models };
}

// ---------- availability ----------

export const PARTS_PER_REQUEST = 8;

export function parseAvailability(json, parts) {
  const msg = json?.body?.content?.pickupMessage;
  if (!msg) throw new AppleError('Unexpected response from Apple (no pickupMessage).');
  if (msg.errorMessage && !msg.stores?.length) throw new AppleError(stripHtml(msg.errorMessage), 400);

  return (msg.stores || []).map((s) => {
    const addr = s.retailStore?.address || s.address || {};
    const availability = {};
    for (const pn of parts) {
      const a = s.partsAvailability?.[pn];
      if (!a) continue;
      const quote =
        stripHtml(a.pickupSearchQuote) ||
        stripHtml(a.messageTypes?.regular?.storePickupQuote) ||
        stripHtml(a.messageTypes?.compact?.storePickupQuote);
      availability[pn] = {
        available: a.pickupDisplay === 'available',
        status: a.pickupDisplay || 'unknown',
        quote,
      };
    }
    return {
      storeNumber: s.storeNumber,
      name: s.storeName,
      city: s.city || addr.city || '',
      state: s.state || addr.stateCode || '',
      distance: s.storeDistanceWithUnit || (s.storedistance != null ? String(s.storedistance) : ''),
      distanceValue: Number(s.storedistance ?? parseFloat(s.storeDistanceWithUnit)) || 0,
      address: [addr.address2 || addr.street, addr.city, addr.postalCode].filter(Boolean).join(', '),
      phone: s.phoneNumber || '',
      availability,
    };
  });
}

function mergeStores(target, stores) {
  for (const s of stores) {
    const existing = target.get(s.storeNumber);
    if (existing) Object.assign(existing.availability, s.availability);
    else target.set(s.storeNumber, s);
  }
}

export async function fetchAvailability(country, location, parts) {
  const base = storefront(country);
  const stores = new Map();
  for (let i = 0; i < parts.length; i += PARTS_PER_REQUEST) {
    const chunk = parts.slice(i, i + PARTS_PER_REQUEST);
    const qs = new URLSearchParams({ fae: 'true', pl: 'true', 'mts.0': 'regular', 'mts.1': 'compact', location });
    chunk.forEach((pn, idx) => qs.set(`parts.${idx}`, pn));
    const res = await get(`${base}/shop/fulfillment-messages?${qs}`);
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('json')) {
      throw new AppleError(
        `Apple refused the availability request (HTTP ${res.status}). ` +
          'Apple blocks this endpoint for most cloud/datacenter IPs — run the checker on your own computer, ' +
          'or slow down if you have been refreshing very often.',
        502,
      );
    }
    mergeStores(stores, parseAvailability(await res.json(), chunk));
    if (i + PARTS_PER_REQUEST < parts.length) await new Promise((r) => setTimeout(r, 400));
  }
  return [...stores.values()].sort((a, b) => a.distanceValue - b.distanceValue);
}
