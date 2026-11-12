// "Last seen" tracking: remembers every stretch of time a configuration was
// in stock at a store, as observed by this checker's own checks. Pure
// functions over a plain { events: [] } object, so the page can keep it in
// localStorage and tests can drive it with fake times.
//
// An event is one restock: { store, name, retailer, city, distanceValue, part,
// first, last, open }. `first`/`last` are the first and last checks (ms) that
// saw it in stock; `open` means the most recent check still saw it.

export const MAX_EVENTS = 500;

export function emptyHistory() {
  return { events: [] };
}

/**
 * Record one check. `stores` are the stores that check returned and `parts`
 * the part numbers it asked about. A stock sighting more than `gapMs` after
 * the previous one (e.g. the checker wasn't running) starts a new event
 * instead of stretching the old one across the gap.
 * Returns the events that started with this check.
 */
export function recordCheck(history, stores, parts, now, { gapMs }) {
  const open = new Map();
  for (const ev of history.events) if (ev.open) open.set(`${ev.store}|${ev.part}`, ev);

  const started = [];
  for (const s of stores) {
    for (const part of parts) {
      const key = `${s.storeNumber}|${part}`;
      const ev = open.get(key);
      if (s.availability?.[part]?.available) {
        if (ev && now - ev.last <= gapMs) {
          ev.last = now;
        } else {
          if (ev) ev.open = false;
          const fresh = {
            store: s.storeNumber,
            name: s.name,
            retailer: s.retailer || 'apple',
            city: s.city || '',
            distanceValue: s.distanceValue || 0,
            part,
            first: now,
            last: now,
            open: true,
          };
          history.events.push(fresh);
          started.push(fresh);
        }
      } else if (ev) {
        ev.open = false;
      }
      open.delete(key);
    }
  }
  // Anything still open but not checked for a while has gone stale.
  for (const ev of open.values()) if (now - ev.last > gapMs) ev.open = false;

  if (history.events.length > MAX_EVENTS) history.events.splice(0, history.events.length - MAX_EVENTS);
  return started;
}

/** Most recent event for any of `parts` at `store`, or null. */
export function lastSeen(history, store, parts) {
  const want = new Set(parts);
  let best = null;
  for (const ev of history.events) {
    if (ev.store === store && want.has(ev.part) && (!best || ev.last > best.last)) best = ev;
  }
  return best;
}

/** Most recent events (newest first) for `parts`, optionally limited to stores within `maxDistance`. */
export function recentEvents(history, parts, { maxDistance = 0, limit = 15 } = {}) {
  const want = new Set(parts);
  return history.events
    .filter((ev) => want.has(ev.part) && (!maxDistance || !ev.distanceValue || ev.distanceValue <= maxDistance))
    .sort((a, b) => b.first - a.first)
    .slice(0, limit);
}

/** "just now", "5 min ago", "3 hr ago", "2 days ago". */
export function timeAgo(then, now) {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** How long an event lasted, to the resolution of the checks that saw it. */
export function describeDuration(ev, intervalMs) {
  if (ev.open) return 'still in stock';
  const span = ev.last - ev.first;
  if (span <= 0) return `gone within ${Math.round(intervalMs / 60000) || 1} min`;
  const m = Math.round(span / 60000);
  return m < 1 ? 'in stock under a minute' : `in stock about ${m} min`;
}
