// ==UserScript==
// @name         iPhone Stock Checker – Apple bridge
// @namespace    iphone-stock-checker
// @version      1.1.0
// @description  Lets the local iPhone Stock Checker page ask Apple and AT&T for pickup availability from your own browser.
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @include      http://localhost:*/*
// @include      http://127.0.0.1:*/*
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      www.apple.com
// @connect      www.att.com
// @run-at       document-start
// ==/UserScript==

// How it works: the checker page posts {type: 'request', id, url, method, body}
// to window. This script forwards the request from your browser, with your
// browser's own cookies, and posts the response back. Only these are forwarded:
//  - GET  Apple Store pickup availability
//  - GET  AT&T iPhone pages (to map Apple part numbers to AT&T SKUs)
//  - POST AT&T store availability for a ZIP code
(function () {
  'use strict';

  const VERSION = '1.1.0';
  const ALLOWED = [
    { method: 'GET', url: /^https:\/\/www\.apple\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?shop\/fulfillment-messages\?/ },
    { method: 'GET', url: /^https:\/\/www\.att\.com\/buy\/phones\/apple-iphone-[a-z0-9-]+\.html$/ },
    { method: 'POST', url: /^https:\/\/www\.att\.com\/msapi\/sales\/uis\/v1\/inventory\/storeavailability\?zipCode=\d{5}$/ },
  ];
  const allowed = (method, url) => ALLOWED.some((r) => r.method === method && r.url.test(url));
  // Called as a method on GM (some managers need `this`), else the legacy global.
  const gmRequest =
    typeof GM !== 'undefined' && GM.xmlHttpRequest
      ? (opts) => GM.xmlHttpRequest(opts)
      : typeof GM_xmlhttpRequest !== 'undefined'
        ? GM_xmlhttpRequest
        : null;

  // Only answer the checker page, which sets this meta tag.
  const isCheckerPage = () => !!document.querySelector('meta[name="isc-app"]');

  const host = (url) => new URL(url).hostname;

  function reply(msg) {
    window.postMessage({ source: 'isc-bridge', version: VERSION, ...msg }, window.location.origin);
  }

  // Mark the page so it can tell "installed" apart from "not answering",
  // without relying on messaging. The DOM is shared with the page.
  // At document-start <html> may not exist yet, so retry once the DOM is ready.
  const mark = () => document.documentElement?.setAttribute('data-isc-bridge', VERSION);
  mark();

  // Note: no `event.source === window` check. Userscript managers run this in a
  // sandbox where `window` is a wrapper, so that comparison is always false.
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'isc-page' || !isCheckerPage()) return;

    if (data.type === 'ping') return reply({ type: 'pong' });

    if (data.type === 'request') {
      const { id, url } = data;
      const method = data.method === 'POST' ? 'POST' : 'GET';
      if (typeof url !== 'string' || !allowed(method, url)) {
        return reply({ type: 'response', id, error: 'URL not allowed by the bridge.' });
      }
      if (!gmRequest) return reply({ type: 'response', id, error: 'Your userscript manager does not support GM.xmlHttpRequest.' });
      try {
        const r = gmRequest({
          method,
          url,
          headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
          data: method === 'POST' && typeof data.body === 'string' ? data.body : undefined,
          timeout: 15000,
          onload: (r) => {
            const type = /content-type:\s*([^\r\n]+)/i.exec(r.responseHeaders || '')?.[1] || '';
            reply({ type: 'response', id, status: r.status, contentType: type, body: r.responseText });
          },
          onerror: () => reply({ type: 'response', id, error: `Network error reaching ${host(url)}.` }),
          ontimeout: () => reply({ type: 'response', id, error: `${host(url)} took too long to answer.` }),
          onabort: () => reply({ type: 'response', id, error: `The request to ${host(url)} was blocked or cancelled by the userscript manager.` }),
        });
        // GM.xmlHttpRequest may return a promise; surface its rejection too.
        r?.catch?.((err) => reply({ type: 'response', id, error: `Bridge request failed: ${err?.message || err}` }));
      } catch (err) {
        reply({ type: 'response', id, error: `Bridge request failed: ${err?.message || err}` });
      }
    }
  });

  // Announce ourselves in case the page loaded first.
  window.addEventListener('DOMContentLoaded', () => {
    mark();
    if (isCheckerPage()) reply({ type: 'pong' });
  });
})();
