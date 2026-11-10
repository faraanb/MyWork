import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProductPage, parseAvailability, parseModelSlugs, stripHtml } from '../lib/apple.js';
import { demoAvailability } from '../lib/demo.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('stripHtml removes tags, footnotes and entities', () => {
  assert.equal(stripHtml('256<small>GB</small><as-footnote data-id="x"><sup>1</sup></as-footnote>'), '256GB');
  assert.equal(stripHtml('Available<br/>Today'), 'Available Today');
  assert.equal(stripHtml('iPhone&nbsp;18&nbsp;Pro'), 'iPhone 18 Pro');
});

test('parseModelSlugs finds buy pages for a storefront', () => {
  const html = '<a href="/uk/shop/buy-iphone/iphone-17">x</a><a href="/uk/shop/buy-iphone/iphone-air">y</a><a href="/uk/shop/buy-iphone/iphone-17">';
  assert.deepEqual(parseModelSlugs(html, 'uk'), ['iphone-17', 'iphone-air']);
  assert.deepEqual(parseModelSlugs('<a href="/shop/buy-iphone/iphone-16">', 'us'), ['iphone-16']);
});

test('parseProductPage extracts configurations from an Apple buy page', () => {
  const configs = parseProductPage(fixture('buy-iphone-18-pro.html'), 'iphone-18-pro', 'https://www.apple.com');
  assert.ok(configs.length > 0);
  const models = new Set(configs.map((c) => c.model));
  assert.deepEqual([...models].sort(), ['iPhone 18 Pro', 'iPhone 18 Pro Max']);
  for (const c of configs) {
    assert.match(c.partNumber, /^[A-Z0-9]+\/A$/);
    assert.ok(c.color && c.capacity && c.carrier);
    assert.match(c.capacity, /^\d+(GB|TB)$/);
    assert.ok(c.url.startsWith('https://www.apple.com/shop/buy-iphone/iphone-18-pro/'));
  }
  assert.ok(configs.some((c) => c.carrierKey === 'unlocked' && c.carrier === 'Unlocked'));
  assert.ok(configs.some((c) => c.carrierKey === 'att' && c.carrier === 'AT&T'));
  // no duplicate (part, carrier) pairs
  const keys = configs.map((c) => `${c.partNumber}|${c.carrierKey}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('parseAvailability normalises stores and per-part status', () => {
  const stores = parseAvailability(JSON.parse(fixture('fulfillment.json')), ['MJWA4LL/A', 'MJQ34LL/A']);
  assert.equal(stores.length, 2);
  const soho = stores.find((s) => s.storeNumber === 'R245');
  assert.equal(soho.name, 'SoHo');
  assert.equal(soho.distance, '1.9 mi');
  assert.equal(soho.distanceValue, 1.9);
  assert.equal(soho.address, '103 Prince Street, New York, 10012');
  assert.deepEqual(soho.availability['MJWA4LL/A'], { available: true, status: 'available', quote: 'Available Today' });
  assert.equal(soho.availability['MJQ34LL/A'].available, false);
  const fifth = stores.find((s) => s.storeNumber === 'R095');
  assert.equal(fifth.availability['MJWA4LL/A'].status, 'ineligible');
  assert.equal(fifth.availability['MJQ34LL/A'].available, true);
});

test('parseAvailability surfaces Apple error messages', () => {
  const json = { body: { content: { pickupMessage: { errorMessage: 'Please enter a valid zip code.' } } } };
  assert.throws(() => parseAvailability(json, []), /valid zip/);
  assert.throws(() => parseAvailability({}, []), /Unexpected response/);
});

test('demo availability covers every requested part at every store', () => {
  const stores = demoAvailability(['A1/A', 'B2/A']);
  assert.ok(stores.length > 0);
  for (const s of stores) assert.deepEqual(Object.keys(s.availability), ['A1/A', 'B2/A']);
});

test('parseProductPage infers capacity for single-size models', () => {
  const data = {
    displayValues: { dimensionColor: { pink: { value: 'Pink' } } },
    products: [{ partNumber: 'MYAR3LL/A', seoUrlToken: '6.1-inch-display-128gb-pink-att', dimensionColor: 'pink', carrierModel: 'ATT_IPHONE16' }],
  };
  const html = `window.PRODUCT_SELECTION_BOOTSTRAP = { productSelectionData: ${JSON.stringify(data)} };`;
  const [c] = parseProductPage(html, 'iphone-16', 'https://www.apple.com');
  assert.equal(c.model, 'iPhone 16');
  assert.equal(c.capacity, '128GB');
  assert.equal(c.capacityKey, '128gb');
  assert.equal(c.carrier, 'AT&T');
});
