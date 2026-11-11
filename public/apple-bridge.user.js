// ==UserScript==
// @name         iPhone Stock Checker – Apple bridge
// @namespace    iphone-stock-checker
// @version      1.0.1
// @description  Lets the local iPhone Stock Checker page ask Apple for pickup availability from your own browser.
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @include      http://localhost:*/*
// @include      http://127.0.0.1:*/*
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      www.apple.com
// @run-at       document-start
// ==/UserScript==

// How it works: the checker page posts {type: 'isc-apple-request', id, url}
// to window. This script forwards the request to Apple from your browser, with
// your browser's own apple.com cookies, and posts the response back.
// Only Apple Store availability URLs are forwarded, nothing else.
(function () {
  'use strict';

  const VERSION = '1.0.1';
  const ALLOWED = /^https:\/\/www\.apple\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?shop\/fulfillment-messages\?/;
  const gmRequest =
    (typeof GM !== 'undefined' && GM.xmlHttpRequest) ||
    (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest);

  // Only answer the checker page, which sets this meta tag.
  const isCheckerPage = () => !!document.querySelector('meta[name="isc-app"]');

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
      if (typeof url !== 'string' || !ALLOWED.test(url)) {
        return reply({ type: 'response', id, error: 'URL not allowed by the bridge.' });
      }
      if (!gmRequest) return reply({ type: 'response', id, error: 'Your userscript manager does not support GM.xmlHttpRequest.' });
      gmRequest({
        method: 'GET',
        url,
        timeout: 15000,
        onload: (r) => {
          const type = /content-type:\s*([^\r\n]+)/i.exec(r.responseHeaders || '')?.[1] || '';
          reply({ type: 'response', id, status: r.status, contentType: type, body: r.responseText });
        },
        onerror: () => reply({ type: 'response', id, error: 'Network error reaching apple.com.' }),
        ontimeout: () => reply({ type: 'response', id, error: 'apple.com took too long to answer.' }),
      });
    }
  });

  // Announce ourselves in case the page loaded first.
  window.addEventListener('DOMContentLoaded', () => {
    mark();
    if (isCheckerPage()) reply({ type: 'pong' });
  });
})();
