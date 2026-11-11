import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { findModel, filterConfigs, inStock } from '../lib/filter.js';
import { formatHits, sendNtfy, sendWebhook } from '../lib/notify.js';

const cfg = (partNumber, colorKey, capacityKey, carrierKey) => ({
  partNumber, colorKey, capacityKey, carrierKey,
  color: colorKey[0].toUpperCase() + colorKey.slice(1),
  capacity: capacityKey.toUpperCase(),
  carrier: carrierKey === 'att' ? 'AT&T' : carrierKey[0].toUpperCase() + carrierKey.slice(1),
  model: 'iPhone 18 Pro',
  url: `https://www.apple.com/shop/buy-iphone/iphone-18-pro/${partNumber}`,
});
const configs = [
  cfg('A1/A', 'silver', '256gb', 'unlocked'),
  cfg('A1/A', 'silver', '256gb', 'att'),
  cfg('B2/A', 'black', '512gb', 'unlocked'),
  cfg('C3/A', 'black', '1tb', 'unlocked'),
];
const catalog = {
  models: [
    { name: 'iPhone 18 Pro Max', slug: 'iphone-18-pro', configs: [] },
    { name: 'iPhone 18 Pro', slug: 'iphone-18-pro', configs },
    { name: 'iPhone 17e', slug: 'iphone-17e', configs: [] },
  ],
};

test('findModel matches loosely and prefers the shortest name', () => {
  assert.equal(findModel(catalog, 'iphone 18 pro').name, 'iPhone 18 Pro');
  assert.equal(findModel(catalog, '18 pro').name, 'iPhone 18 Pro');
  assert.equal(findModel(catalog, '18 Pro Max').name, 'iPhone 18 Pro Max');
  assert.equal(findModel(catalog, '17e').name, 'iPhone 17e');
  assert.equal(findModel(catalog, 'galaxy'), null);
});

test('filterConfigs accepts keys or labels, any case', () => {
  assert.equal(filterConfigs(configs).length, 4);
  assert.deepEqual(filterConfigs(configs, { colors: ['Black'] }).map((c) => c.partNumber), ['B2/A', 'C3/A']);
  assert.deepEqual(filterConfigs(configs, { capacities: ['1TB'], colors: ['black'] }).map((c) => c.partNumber), ['C3/A']);
  assert.deepEqual(filterConfigs(configs, { carriers: ['AT&T'] }).map((c) => c.carrierKey), ['att']);
});

test('inStock de-duplicates carrier variants sharing a part number', () => {
  const stores = [
    { storeNumber: 'R1', name: 'SoHo', availability: { 'A1/A': { available: true, quote: 'Today' }, 'B2/A': { available: false } } },
    { storeNumber: 'R2', name: 'Fifth Ave', availability: { 'C3/A': { available: true, quote: 'Tomorrow' } } },
  ];
  const hits = inStock(stores, configs);
  assert.deepEqual(hits.map((h) => h.key), ['R1|A1/A', 'R2|C3/A']);
  const msg = formatHits('iPhone 18 Pro', hits);
  assert.equal(msg.title, 'iPhone 18 Pro in stock');
  assert.match(msg.body, /Silver 256GB @ SoHo \(Today\)/);
  assert.equal(msg.url, configs[0].url);
});

test('ntfy and webhook senders POST the expected payloads', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      received.push({ url: req.url, headers: req.headers, body });
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const hits = [{ key: 'R1|A1/A', store: { name: 'SoHo', storeNumber: 'R1' }, config: configs[0], quote: 'Today' }];
    const msg = formatHits('iPhone 18 Pro', hits);
    await sendNtfy(`${base}/my-topic`, msg);
    await sendWebhook(`${base}/hook`, msg, hits);

    const [ntfy, hook] = received;
    assert.equal(ntfy.url, '/my-topic');
    assert.equal(ntfy.headers.title, 'iPhone 18 Pro in stock');
    assert.equal(ntfy.headers.click, configs[0].url);
    assert.match(ntfy.body, /SoHo/);

    const json = JSON.parse(hook.body);
    assert.equal(hook.url, '/hook');
    assert.equal(json.text, json.content);
    assert.equal(json.items[0].partNumber, 'A1/A');
  } finally {
    server.close();
  }
});
