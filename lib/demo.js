// Fake availability so the UI can be tried without hitting Apple
// (start with DEMO=1, or add ?demo=1 to the page URL).
const STORES = [
  ['R095', 'Fifth Avenue', 'New York', 'NY', 0.8],
  ['R245', 'SoHo', 'New York', 'NY', 1.9],
  ['R401', 'Upper West Side', 'New York', 'NY', 2.6],
  ['R512', 'Williamsburg', 'Brooklyn', 'NY', 3.4],
  ['R322', 'Brookfield Place', 'New York', 'NY', 4.1],
  ['R223', 'Garden State Plaza', 'Paramus', 'NJ', 13.7],
  ['R138', 'Roosevelt Field', 'Garden City', 'NY', 19.2],
  ['R364', 'Short Hills', 'Short Hills', 'NJ', 21.0],
];

// Deterministic per (store, part, 2-minute window), so refreshes change slowly.
function hash(str) {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) / 2 ** 32;
}

export function demoAvailability(parts) {
  const window = Math.floor(Date.now() / 120000);
  return STORES.map(([storeNumber, name, city, state, miles]) => {
    const availability = {};
    for (const pn of parts) {
      const r = hash(`${storeNumber}${pn}${window}`);
      const available = r < 0.22;
      availability[pn] = {
        available,
        status: available ? 'available' : 'unavailable',
        quote: available ? (r < 0.15 ? 'Available Today' : 'Available Tomorrow') : 'Currently unavailable',
      };
    }
    return {
      storeNumber,
      name,
      city,
      state,
      distance: `${miles} mi`,
      distanceValue: miles,
      address: '',
      phone: '',
      availability,
    };
  });
}
