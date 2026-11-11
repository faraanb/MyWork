// Push notifications for the headless watcher.
//  - ntfy (https://ntfy.sh or a self-hosted server): free phone push, no account.
//  - generic webhook: POSTs JSON with both `text` (Slack) and `content` (Discord).

export function formatHits(modelName, hits, limit = 6) {
  const lines = hits
    .slice(0, limit)
    .map((h) => `${h.config.color} ${h.config.capacity} @ ${h.store.name}${h.quote ? ` (${h.quote})` : ''}`);
  if (hits.length > limit) lines.push(`…and ${hits.length - limit} more`);
  return { title: `${modelName} in stock`, body: lines.join('\n'), url: hits[0]?.config.url };
}

async function post(url, init) {
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10000), ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
}

export async function sendNtfy(target, { title, body, url }) {
  // Accept either a bare topic ("my-iphone-alerts") or a full URL.
  const endpoint = /^https?:\/\//.test(target) ? target : `https://ntfy.sh/${encodeURIComponent(target)}`;
  const headers = { Title: title, Tags: 'iphone', Priority: 'high' };
  if (url) headers.Click = url;
  await post(endpoint, { headers, body });
}

export async function sendWebhook(endpoint, { title, body, url }, hits) {
  const text = `*${title}*\n${body}${url ? `\n${url}` : ''}`;
  await post(endpoint, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      content: text,
      items: hits.map((h) => ({
        store: h.store.name,
        storeNumber: h.store.storeNumber,
        partNumber: h.config.partNumber,
        model: h.config.model,
        color: h.config.color,
        capacity: h.config.capacity,
        quote: h.quote,
        url: h.config.url,
      })),
    }),
  });
}
