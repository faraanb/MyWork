// Page side of the Apple bridge (see apple-bridge.user.js). Apple only answers
// availability requests that come from a real browser, so when the userscript
// is installed we route those requests through it instead of the local server.

const pending = new Map();
let seq = 0;
let info = null; // { version } once the userscript has answered
const waiters = new Set();

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const d = event.data;
  if (!d || d.source !== 'isc-bridge') return;
  if (d.type === 'pong') {
    info = { version: d.version };
    for (const w of waiters) w(info);
    waiters.clear();
  } else if (d.type === 'response' && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
  }
});

const post = (msg) => window.postMessage({ source: 'isc-page', ...msg }, window.location.origin);

/** Resolves to { version } if the userscript is installed, otherwise null. */
export function detectBridge(timeoutMs = 1000) {
  if (info) return Promise.resolve(info);
  return new Promise((resolve) => {
    const done = (v) => (clearTimeout(t), waiters.delete(done), resolve(v));
    const t = setTimeout(() => done(null), timeoutMs);
    waiters.add(done);
    post({ type: 'ping' });
  });
}

/** fetch()-like transport for lib/apple.js's fetchAvailability. */
export function bridgeTransport(url) {
  const id = `r${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The browser bridge did not answer. Is the userscript enabled?'));
    }, 20000);
    pending.set(id, (d) => {
      clearTimeout(timer);
      if (d.error) return reject(new Error(d.error));
      if (!d.status) return reject(new Error('apple.com did not return a response.'));
      // Statuses that can't carry a body (204/304) would make Response() throw.
      const body = [101, 204, 205, 304].includes(d.status) ? null : d.body;
      resolve(new Response(body, { status: d.status, headers: { 'content-type': d.contentType || '' } }));
    });
    post({ type: 'request', id, url });
  });
}
