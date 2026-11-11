import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAttProductPage, parseAttAvailability, fetchAttAvailability, attProductUrl, attSlug } from '../lib/att.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('parseAttProductPage maps Apple part numbers to AT&T billCodes', () => {
  const map = parseAttProductPage(fixture('att-iphone-17.html'));
  assert.equal(map.size, 10);
  assert.deepEqual(map.get('MG464LL/A'), { billCode: '6062F', pickup: true }); // Black 256GB
  assert.equal(map.get('MG4E4LL/A').billCode, '6067F'); // Black 512GB
  assert.deepEqual(parseAttProductPage('<html>no data</html>'), new Map());
});

test('parseAttAvailability returns stores in the app shape, keyed by Apple part', () => {
  const json = JSON.parse(fixture('att-storeavailability.json'));
  const billToParts = new Map([['6062F', ['MG464LL/A']], ['6067F', ['MG4E4LL/A']]]);
  const stores = parseAttAvailability(json, billToParts, 'iphone-17');
  assert.equal(stores.length, 4);
  const oak = stores.find((s) => s.name === 'Oak Park');
  assert.equal(oak.storeNumber, 'att-CA25');
  assert.equal(oak.retailer, 'att');
  assert.equal(oak.state, 'IL');
  assert.equal(oak.distanceValue, 9.2);
  assert.deepEqual(oak.availability['MG464LL/A'], {
    available: true,
    status: 'available',
    quote: 'Just 2 left in stock',
    url: attProductUrl('iphone-17'),
  });
  assert.equal(oak.availability['MG4E4LL/A'].available, false);
});

test('fetchAttAvailability posts billCodes and skips parts AT&T does not sell', async () => {
  const calls = [];
  const transport = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (url.endsWith('.html')) return new Response(fixture('att-iphone-17.html'), { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(fixture('att-storeavailability.json'), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const stores = await fetchAttAvailability('60601', ['MG464LL/A', 'NOTATT1/A'], 'iphone-17', { transport });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://www.att.com/buy/phones/apple-iphone-17.html');
  assert.equal(calls[1].method, 'POST');
  assert.match(calls[1].url, /storeavailability\?zipCode=60601$/);
  assert.deepEqual(JSON.parse(calls[1].body), { itemDetails: [{ category: 'phone', billCode: '6062F' }] });
  assert.deepEqual(stores.map((s) => s.name), ['Chicago Ave', 'Oak Park', 'Niles', 'Glen Gate']);
  assert.ok(stores.every((s) => s.availability['MG464LL/A'].available));
});

test('fetchAttAvailability needs a ZIP code and handles models AT&T does not sell', async () => {
  await assert.rejects(fetchAttAvailability('Chicago', ['MG464LL/A'], 'iphone-17'), { code: 'att_zip' });
  const transport = async () => new Response('not found', { status: 404 });
  assert.deepEqual(await fetchAttAvailability('60601', ['MG464LL/A'], 'iphone-duo', { transport }), []);
});

test('parseAttAvailability treats AT&T "out of stock" and "no stores" errors as no stores', () => {
  const billToParts = new Map([['6062F', ['MG464LL/A']]]);
  const out = { error: { errorId: 'UIS-INV-00003', message: 'Items out of stock' } };
  const none = { error: { errorId: 'UIS-INV-00002', message: 'No stores found' } };
  assert.deepEqual(parseAttAvailability(out, billToParts), []);
  assert.deepEqual(parseAttAvailability(none, billToParts), []);
  assert.throws(() => parseAttAvailability({ error: { errorId: 'UIS-X', message: 'Boom' } }, billToParts), /AT&T: Boom/);
});

test('attSlug follows AT&T page names, which split Pro and Pro Max', () => {
  assert.equal(attSlug('iPhone 18 Pro Max'), 'iphone-18-pro-max');
  assert.equal(attSlug('iPhone 18 Pro'), 'iphone-18-pro');
  assert.equal(attSlug('iPhone 17e'), 'iphone-17e');
  assert.equal(attProductUrl(attSlug('iPhone Air')), 'https://www.att.com/buy/phones/apple-iphone-air.html');
});

test('fetchAttAvailability explains when AT&T offers no store pickup for the phone', async () => {
  let calls = 0;
  const transport = async () => (calls++, new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const mapping = new Map([['MK1H4LL/A', { billCode: '6053G', pickup: false }]]);
  await assert.rejects(fetchAttAvailability('10001', ['MK1H4LL/A'], 'iphone-duo', { transport, mapping }), { code: 'att_no_pickup' });
  assert.equal(calls, 0);
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { devices: { d: { product: { childSkus: [
    { mpn: 'MK1H4LL/A', billingInfo: { billCode: '6053G' }, fulfillmentOptions: { click2Store: { eligible: false } } },
  ] } } } } } })}</script>`;
  assert.deepEqual(parseAttProductPage(html).get('MK1H4LL/A'), { billCode: '6053G', pickup: false });
});
