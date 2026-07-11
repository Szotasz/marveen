// Service worker DISABLED (kill-switch). No fetch handler -> no request is ever
// intercepted, so this can never break a page load. On activate it purges any
// old caches and unregisters itself. It does NOT reload clients (that caused a
// reload loop with re-registration). index.html also unregisters any SW on load,
// which is the primary cleanup path; this stub only exists to neutralise a
// still-registered old worker that a browser fetches for its update check.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        /* best-effort */
      }
      try {
        await self.registration.unregister();
      } catch {
        /* best-effort */
      }
    })()
  );
});

// No fetch handler on purpose.
