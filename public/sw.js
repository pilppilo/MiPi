/*
 * MiPi's service worker (COD-244): it exists so the app can be installed, and does nothing else. It has no `fetch`
 * handler on purpose. Every request, the page itself included, goes to the network, so after the Cloudflare Access
 * session expires a reload reaches Access's sign-in instead of a cached shell whose WebSocket then fails silently.
 * It caches nothing, so it never holds `/api/*` answers or anything private.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
