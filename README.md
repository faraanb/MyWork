# iPhone Stock Checker

A self-hosted take on sites like iphonestockchecker.com. It shows live **in-store pickup availability** for every iPhone configuration at Apple Stores near you. It auto-refreshes, and it can alert you with a desktop notification and a sound when stock appears.

- **Always-current lineup.** Models, finishes, storage sizes, carriers and part numbers come straight from the Apple Store website, so new iPhones show up with no code changes.
- **12 storefronts:** US, Canada, UK, Australia, Germany, France, Italy, Spain, Netherlands, Japan, Singapore and Hong Kong.
- **Store × configuration grid.** Each cell that's in stock links straight to that configuration on apple.com.
- **Auto-refresh** every 1, 2, 5 or 10 minutes, with alerts only for *newly* available stock.
- **Headless watcher** (`watch.js`) that pushes alerts to your phone via [ntfy](https://ntfy.sh), or to Slack or Discord via a webhook. No browser tab needed.
- **No dependencies.** Plain Node.js (≥ 18.17) and vanilla JS.

## Run it

```bash
npm start          # http://localhost:3000
npm run demo       # same UI with fake availability (no Apple requests)
npm test
```

Environment variables: `PORT` (default `3000`), `HOST` (default `127.0.0.1`; use `0.0.0.0` to expose it on your LAN), and `DEMO=1`.
You can also add `?demo=1` to the page URL to use demo data for a single tab.

## Watch from the terminal (phone alerts)

```bash
node watch.js --list                                   # models, finishes, storage, carriers
node watch.js -l 10001 -m "18 pro max" --color silver --storage 256gb,512gb \
  --ntfy my-secret-topic                               # push to the ntfy app, topic "my-secret-topic"
node watch.js -c uk -l "W1B 2EL" -m "iPhone 17" --webhook https://hooks.slack.com/services/…
node watch.js -l 10001 -m air --once                   # single check; exit 0 = in stock, 1 = none, 2 = error
```

Names are matched loosely (`"18 pro"`, `Silver`, `256gb`). The carrier defaults to Unlocked when it's offered. The watcher polls every 120 s (minimum 60 s). It alerts only when a store or configuration *becomes* available, and it prints every in-stock hit on each check. To get phone pushes, install the ntfy app and subscribe to the same topic. Pick a hard-to-guess name, because ntfy.sh topics are public. `--ntfy` also accepts a full URL for a self-hosted server. `--webhook` POSTs JSON with `text` (Slack), `content` (Discord) and an `items` array.

> **Run it from a home or office connection.** Apple blocks the availability endpoint for most cloud/datacenter IP addresses (it answers with HTTP 541). That means it fails on typical VPS/serverless hosts, while the catalog pages still load. Keep the refresh interval reasonable: the server caches each query for 30 s so it never hits Apple more than twice a minute.

## How it works

| Piece | What it does |
| --- | --- |
| `lib/apple.js` → `fetchCatalog` | Reads `/{cc}/shop/buy-iphone` to find the current model pages. It then parses the `PRODUCT_SELECTION_BOOTSTRAP.productSelectionData` JSON embedded in each page into `{partNumber, model, color, capacity, carrier, url}` entries (cached 6 h). |
| `lib/apple.js` → `fetchAvailability` | Calls `/{cc}/shop/fulfillment-messages?pl=true&location=…&parts.N=…` in batches of 8 part numbers. It merges the stores and normalises each part to `{available, status, quote}`. |
| `server.js` | Static file server plus a JSON API (`/api/countries`, `/api/catalog`, `/api/availability`). Browsers can't call apple.com directly because of CORS. |
| `watch.js`, `lib/filter.js`, `lib/notify.js` | The terminal watcher: loose model/option matching, change detection, ntfy and webhook delivery. |
| `public/` | The UI: filters, results grid, auto-refresh, notifications. Settings are remembered in `localStorage`. |

Not affiliated with Apple. These are undocumented Apple Store endpoints, so they can change without notice.
