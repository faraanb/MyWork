import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyHistory, recordCheck, lastSeen, recentEvents, timeAgo, describeDuration, MAX_EVENTS } from '../lib/history.js';

const MIN = 60000;
const store = (storeNumber, inStock, extra = {}) => ({
  storeNumber,
  name: `Store ${storeNumber}`,
  distanceValue: 3,
  availability: Object.fromEntries(Object.entries(inStock).map(([pn, available]) => [pn, { available }])),
  ...extra,
});
const opts = { gapMs: 5 * MIN };

test('recordCheck opens, extends and closes a restock', () => {
  const h = emptyHistory();
  const t0 = 1_000_000;
  assert.equal(recordCheck(h, [store('R1', { A: false })], ['A'], t0, opts).length, 0);

  const started = recordCheck(h, [store('R1', { A: true })], ['A'], t0 + MIN, opts);
  assert.equal(started.length, 1);
  recordCheck(h, [store('R1', { A: true })], ['A'], t0 + 2 * MIN, opts);
  recordCheck(h, [store('R1', { A: false })], ['A'], t0 + 3 * MIN, opts);

  assert.equal(h.events.length, 1);
  assert.deepEqual(
    { first: h.events[0].first, last: h.events[0].last, open: h.events[0].open },
    { first: t0 + MIN, last: t0 + 2 * MIN, open: false },
  );
  assert.equal(describeDuration(h.events[0], 2 * MIN), 'in stock about 1 min');
});

test('a sighting after a long gap starts a new restock', () => {
  const h = emptyHistory();
  recordCheck(h, [store('R1', { A: true })], ['A'], 0, opts);
  recordCheck(h, [store('R1', { A: true })], ['A'], 60 * MIN, opts);
  assert.equal(h.events.length, 2);
  assert.equal(h.events[0].open, false);
  assert.equal(h.events[1].open, true);
});

test('parts not asked about are left alone, stale open events close', () => {
  const h = emptyHistory();
  recordCheck(h, [store('R1', { A: true, B: true })], ['A', 'B'], 0, opts);
  recordCheck(h, [store('R1', { A: true })], ['A'], MIN, opts);
  assert.equal(h.events.find((e) => e.part === 'B').open, true);
  recordCheck(h, [store('R1', { A: true })], ['A'], 10 * MIN, opts);
  assert.equal(h.events.find((e) => e.part === 'B').open, false);
});

test('lastSeen and recentEvents pick the newest matching events', () => {
  const h = emptyHistory();
  recordCheck(h, [store('R1', { A: true }), store('R9', { A: true }, { distanceValue: 40 })], ['A'], 0, opts);
  recordCheck(h, [store('R1', { A: false, B: true })], ['A', 'B'], MIN, opts);
  assert.equal(lastSeen(h, 'R1', ['A', 'B']).part, 'B');
  assert.equal(lastSeen(h, 'R1', ['C']), null);
  assert.deepEqual(recentEvents(h, ['A'], { maxDistance: 15 }).map((e) => e.store), ['R1']);
  assert.equal(recentEvents(h, ['A']).length, 2);
});

test('history is capped', () => {
  const h = emptyHistory();
  for (let i = 0; i < MAX_EVENTS + 10; i++) recordCheck(h, [store(`R${i}`, { A: true })], ['A'], i, opts);
  assert.equal(h.events.length, MAX_EVENTS);
});

test('timeAgo and describeDuration read naturally', () => {
  assert.equal(timeAgo(0, 30 * 1000), 'just now');
  assert.equal(timeAgo(0, 5 * MIN), '5 min ago');
  assert.equal(timeAgo(0, 3 * 60 * MIN), '3 hr ago');
  assert.equal(timeAgo(0, 72 * 60 * MIN), '3 days ago');
  assert.equal(describeDuration({ open: true }, MIN), 'still in stock');
  assert.equal(describeDuration({ open: false, first: 5, last: 5 }, 2 * MIN), 'gone within 2 min');
});
