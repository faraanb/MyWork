// Talks to att.com (US only):
//  - the phone pages (/buy/phones/apple-iphone-17.html), whose __NEXT_DATA__
//    lists every configuration with Apple's part number (mpn) and AT&T's own
//    SKU code (billCode)
//  - the store-availability endpoint, which reports pickup stock for a list
//    of billCodes at AT&T stores near a ZIP code.
// att.com sits behind bot protection, so the web UI sends these requests
// through the browser bridge (see public/apple-bridge.user.js).

const BASE = 'https://www.att.com';
const TIMEOUT_MS = 15000;

export class AttError extends Error {
  constructor(message, status = 502, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * AT&T's page slug for a model name ("iPhone 18 Pro Max" -> "iphone-18-pro-max").
 * Built from the name rather than Apple's buy-page slug, because Apple sells
 * the Pro and Pro Max on one page while AT&T gives each its own.
 */
export function attSlug(modelName) {
  return String(modelName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** AT&T phone page for an AT&T slug ("iphone-17" -> …/apple-iphone-17.html). */
export function attProductUrl(slug) {
  return `${BASE}/buy/phones/apple-${slug}.html`;
}

export function attAvailabilityUrl(zip) {
  return `${BASE}/msapi/sales/uis/v1/inventory/storeavailability?zipCode=${encodeURIComponent(zip)}`;
}

export const isZip = (s) => /^\d{5}$/.test(String(s).trim());

async function defaultTransport(url, init = {}) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new AttError(`Could not reach AT&T (${err.cause?.code || err.name}).`);
  }
}

/**
 * Map of Apple part number -> { billCode, pickup }, read from a phone page's
 * __NEXT_DATA__. `pickup` is AT&T's click2Store flag: whether that
 * configuration can be reserved for in-store pickup at all.
 */
export function parseAttProductPage(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return new Map();
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return new Map();
  }
  const out = new Map();
  for (const device of Object.values(data?.props?.pageProps?.devices || {})) {
    for (const sku of device?.product?.childSkus || []) {
      const billCode = sku.billingInfo?.billCode;
      const pickup = sku.fulfillmentOptions?.click2Store?.eligible !== false;
      if (sku.mpn && billCode && !out.has(sku.mpn)) out.set(sku.mpn, { billCode, pickup });
    }
  }
  return out;
}

/**
 * Turn a store-availability response into the same store shape lib/apple.js
 * produces, with availability keyed by Apple part number.
 * `billToParts` maps billCode -> [Apple part numbers].
 */
// AT&T answers "nothing to show" with HTTP 200 and an error object instead of an empty list.
const ATT_NO_RESULTS = new Set([
  'UIS-INV-00002', // No stores found (near that ZIP)
  'UIS-INV-00003', // Items out of stock (at every nearby store)
]);

export function parseAttAvailability(json, billToParts, slug) {
  if (json?.error) {
    if (ATT_NO_RESULTS.has(json.error.errorId)) return [];
    throw new AttError(`AT&T: ${json.error.message || json.error.errorId || 'unknown error'}.`);
  }
  const content = json?.content;
  if (!content || !Array.isArray(content.storeList)) throw new AttError('Unexpected response from AT&T (no storeList).');

  const stock = new Map(); // inv_id -> Map(billCode -> product)
  for (const p of content.productsList || []) {
    if (!stock.has(p.storeId)) stock.set(p.storeId, new Map());
    stock.get(p.storeId).set(p.billingCode, p);
  }
  const url = slug ? attProductUrl(slug) : BASE;

  return content.storeList.map((s) => {
    const availability = {};
    for (const [billCode, parts] of billToParts) {
      const p = stock.get(s.inv_id)?.get(billCode);
      const qty = Number(p?.availableQty) || 0;
      const available = qty > 0 && String(p?.status) === '1';
      for (const pn of parts) {
        availability[pn] = {
          available,
          status: available ? 'available' : 'unavailable',
          quote: available ? p.scarcityMsg || `${qty} in stock` : 'Not in stock at this store',
          url,
        };
      }
    }
    const distance = Number(s.distanceasDouble ?? s.arcdist) || 0;
    return {
      storeNumber: `att-${s.inv_id || s.id}`,
      retailer: 'att',
      name: s.mystore_name || s.name || 'AT&T store',
      city: s.city || '',
      state: s.region || '',
      distance: distance ? `${distance} mi` : '',
      distanceValue: distance,
      address: [s.address1, s.address2, s.city, s.postal].filter(Boolean).join(', '),
      phone: s.phone || '',
      availability,
    };
  });
}

/**
 * Pickup stock at AT&T stores near `zip` for the given Apple part numbers.
 * `transport(url, init)` must resolve to a fetch-style Response; the web UI
 * passes the browser bridge. `mapping` (from fetchAttMapping) can be passed
 * in to skip loading the phone page again.
 */
export async function fetchAttAvailability(zip, parts, slug, { transport = defaultTransport, mapping } = {}) {
  if (!isZip(zip)) throw new AttError('AT&T stores need a 5-digit ZIP code.', 400, 'att_zip');

  if (!mapping) mapping = await fetchAttMapping(slug, { transport });
  const known = parts.filter((pn) => mapping.has(pn));
  if (known.length && !known.some((pn) => mapping.get(pn).pickup)) {
    throw new AttError("AT&T doesn't offer in-store pickup for this phone right now (online orders only), so it can't report store stock.", 400, 'att_no_pickup');
  }
  const billToParts = new Map();
  for (const pn of known) {
    const { billCode } = mapping.get(pn);
    if (!billToParts.has(billCode)) billToParts.set(billCode, []);
    billToParts.get(billCode).push(pn);
  }
  if (!billToParts.size) return [];

  const res = await transport(attAvailabilityUrl(zip), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemDetails: [...billToParts.keys()].map((billCode) => ({ category: 'phone', billCode })) }),
  });
  if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) {
    throw new AttError(`AT&T refused the stock request (HTTP ${res.status}).`, 502, 'att_blocked');
  }
  return parseAttAvailability(await res.json(), billToParts, slug).sort((a, b) => a.distanceValue - b.distanceValue);
}

/** Apple part -> { billCode, pickup } for one model, read from its AT&T phone page. */
export async function fetchAttMapping(slug, { transport = defaultTransport } = {}) {
  const res = await transport(attProductUrl(slug));
  if (res.status === 404) return new Map(); // AT&T doesn't sell this model
  if (!res.ok) throw new AttError(`AT&T refused the phone page request (HTTP ${res.status}).`, 502, 'att_blocked');
  return parseAttProductPage(await res.text());
}
