#!/usr/bin/env node
// iPhone Stock Checker — a tiny dependency-free server that serves the web UI
// and proxies Apple's store catalog + pickup availability (browsers can't call
// apple.com directly because of CORS).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNTRIES } from './lib/countries.js';
import { fetchCatalog, fetchAvailability } from './lib/apple.js';
import { demoAvailability } from './lib/demo.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DEMO = process.env.DEMO === '1';
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const CATALOG_TTL = 6 * 60 * 60 * 1000; // product lineup rarely changes
const AVAILABILITY_TTL = 30 * 1000; // never hit Apple more than twice a minute per query
const MAX_PARTS = 64;

const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  // Share one in-flight request between concurrent callers.
  if (hit?.pending) return hit.pending;
  const pending = fn().then(
    (value) => (cache.set(key, { at: Date.now(), value }), value),
    (err) => (cache.delete(key), Promise.reject(err)),
  );
  cache.set(key, { ...hit, at: hit?.at ?? 0, pending });
  return pending;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function api(url, res) {
  const country = (url.searchParams.get('country') || 'us').toLowerCase();

  if (url.pathname === '/api/countries') {
    return send(res, 200, Object.entries(COUNTRIES).map(([code, c]) => ({ code, name: c.name, postal: c.postal })));
  }

  if (url.pathname === '/api/catalog') {
    const catalog = await cached(`catalog:${country}`, CATALOG_TTL, () => fetchCatalog(country));
    return send(res, 200, catalog);
  }

  if (url.pathname === '/api/availability') {
    const location = (url.searchParams.get('location') || '').trim();
    const parts = [...new Set((url.searchParams.get('parts') || '').split(',').map((p) => p.trim()).filter(Boolean))];
    if (!location) return send(res, 400, { error: 'Enter a postal code or city.' });
    if (!parts.length) return send(res, 400, { error: 'Choose at least one configuration.' });
    if (parts.length > MAX_PARTS) return send(res, 400, { error: `Too many configurations (max ${MAX_PARTS}).` });
    if (!parts.every((p) => /^[A-Z0-9]{4,6}[A-Z]{0,3}\/[A-Z]$/i.test(p)))
      return send(res, 400, { error: 'Invalid part number.' });

    const demo = DEMO || url.searchParams.get('demo') === '1';
    const stores = demo
      ? demoAvailability(parts)
      : await cached(`avail:${country}:${location.toLowerCase()}:${parts.sort().join(',')}`, AVAILABILITY_TTL, () =>
          fetchAvailability(country, location, parts),
        );
    return send(res, 200, { country, location, demo, checkedAt: new Date().toISOString(), stores });
  }

  return send(res, 404, { error: 'Not found' });
}

const LIB_DIR = fileURLToPath(new URL('./lib/', import.meta.url));
// Modules the browser imports directly (shared parsing / request logic).
const BROWSER_LIB = new Set(['/lib/apple.js', '/lib/countries.js']);

async function staticFile(url, res) {
  if (BROWSER_LIB.has(url.pathname)) {
    const body = await readFile(join(LIB_DIR, url.pathname.slice(5)));
    res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-cache' });
    return res.end(body);
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '') || 'index.html';
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(url, res);
    else await staticFile(url, res);
  } catch (err) {
    console.error(`[${req.method} ${url.pathname}]`, err.message);
    send(res, err.status || 500, { error: err.message || 'Something went wrong.', code: err.code });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log(`iPhone Stock Checker running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${DEMO ? '  (demo mode)' : ''}`);
  });
}
