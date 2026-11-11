#!/usr/bin/env node
// Headless watcher: polls Apple for in-store pickup availability and alerts
// you (terminal bell, ntfy push, Slack/Discord webhook) when stock appears.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { COUNTRIES } from './lib/countries.js';
import { fetchCatalog, fetchAvailability } from './lib/apple.js';
import { demoAvailability } from './lib/demo.js';
import { findModel, filterConfigs, optionsOf, inStock } from './lib/filter.js';
import { formatHits, sendNtfy, sendWebhook } from './lib/notify.js';

const HELP = `Usage: node watch.js --location <postal code> --model <name> [options]

  -c, --country <code>    Storefront (default: us). One of: ${Object.keys(COUNTRIES).join(', ')}
  -l, --location <text>   Postal/ZIP code or city to search near
  -m, --model <name>      Model, e.g. "iPhone 18 Pro" or "18 pro"
      --color <list>      Comma-separated finishes (default: any)
      --storage <list>    Comma-separated sizes, e.g. 256gb,512gb (default: any)
      --carrier <list>    Comma-separated carriers (default: unlocked if offered)
  -e, --every <seconds>   Poll interval, minimum 60 (default: 120)
      --once              Check once and exit (exit code 0 = in stock, 1 = none, 2 = error)
      --ntfy <topic|url>  Send phone push via ntfy.sh topic or full ntfy URL
      --webhook <url>     POST alerts as JSON (Slack/Discord compatible)
      --list              List models and their options, then exit
      --demo              Use fake availability (no requests to Apple)
  -h, --help              Show this help

Example:
  node watch.js -l 10001 -m "18 pro max" --color silver --storage 256gb,512gb --ntfy my-secret-topic`;

const MIN_INTERVAL = 60;
const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
const ts = () => new Date().toLocaleTimeString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parse(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      country: { type: 'string', short: 'c', default: 'us' },
      location: { type: 'string', short: 'l' },
      model: { type: 'string', short: 'm' },
      color: { type: 'string' },
      storage: { type: 'string' },
      carrier: { type: 'string' },
      every: { type: 'string', short: 'e', default: '120' },
      once: { type: 'boolean', default: false },
      ntfy: { type: 'string' },
      webhook: { type: 'string' },
      list: { type: 'boolean', default: false },
      demo: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  return values;
}

function printCatalog(catalog) {
  for (const m of catalog.models) {
    const o = optionsOf(m.configs);
    console.log(`${m.name}\n  finishes: ${o.colors.join(', ')}\n  storage:  ${o.capacities.join(', ')}\n  carriers: ${o.carriers.join(', ')}`);
  }
}

async function notify(opts, modelName, hits) {
  const msg = formatHits(modelName, hits);
  const jobs = [];
  if (opts.ntfy) jobs.push(sendNtfy(opts.ntfy, msg).catch((e) => console.error(`  ntfy failed: ${e.message}`)));
  if (opts.webhook) jobs.push(sendWebhook(opts.webhook, msg, hits).catch((e) => console.error(`  webhook failed: ${e.message}`)));
  await Promise.all(jobs);
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) return console.log(HELP), 0;
  if (!COUNTRIES[opts.country]) return console.error(`Unknown country "${opts.country}".`), 2;

  const catalog = await fetchCatalog(opts.country);
  if (opts.list) return printCatalog(catalog), 0;
  if (!opts.location || !opts.model) return console.error(`--location and --model are required.\n\n${HELP}`), 2;

  const model = findModel(catalog, opts.model);
  if (!model) {
    console.error(`No model matches "${opts.model}". Available: ${catalog.models.map((m) => m.name).join(', ')}`);
    return 2;
  }
  const carriers = list(opts.carrier) ?? (model.configs.some((c) => c.carrierKey === 'unlocked') ? ['unlocked'] : undefined);
  const configs = filterConfigs(model.configs, { colors: list(opts.color), capacities: list(opts.storage), carriers });
  if (!configs.length) {
    const o = optionsOf(model.configs);
    console.error(`No ${model.name} configuration matches those filters.\n  finishes: ${o.colors.join(', ')}\n  storage:  ${o.capacities.join(', ')}\n  carriers: ${o.carriers.join(', ')}`);
    return 2;
  }
  const parts = [...new Set(configs.map((c) => c.partNumber))];
  const every = Math.max(MIN_INTERVAL, Number(opts.every) || 120);

  console.log(`Watching ${model.name}: ${parts.length} configuration${parts.length === 1 ? '' : 's'} near ${opts.location} (${COUNTRIES[opts.country].name})${opts.demo ? ' [demo]' : ''}`);
  if (!opts.once) console.log(`Checking every ${every}s. Ctrl+C to stop.`);

  let previous = null;
  for (;;) {
    let hits;
    try {
      const stores = opts.demo ? demoAvailability(parts) : await fetchAvailability(opts.country, opts.location, parts);
      hits = inStock(stores, configs);
    } catch (err) {
      console.error(`[${ts()}] ${err.message}`);
      if (opts.once) return 2;
      await sleep(every * 1000);
      continue;
    }

    const fresh = previous ? hits.filter((h) => !previous.has(h.key)) : hits;
    if (!hits.length) {
      console.log(`[${ts()}] Nothing in stock.`);
    } else {
      console.log(`[${ts()}] In stock at ${new Set(hits.map((h) => h.store.storeNumber)).size} store(s):`);
      for (const h of hits) {
        const mark = previous && !previous.has(h.key) ? '  NEW' : '     ';
        console.log(`${mark} ${h.config.color} ${h.config.capacity} — ${h.store.name}${h.store.distance ? ` (${h.store.distance})` : ''}${h.quote ? ` · ${h.quote}` : ''}`);
      }
    }
    if (fresh.length) {
      process.stdout.write('\x07');
      await notify(opts, model.name, fresh);
    }
    previous = new Set(hits.map((h) => h.key));

    if (opts.once) return hits.length ? 0 : 1;
    await sleep(every * 1000);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      console.error(err.message);
      process.exit(2);
    },
  );
}
