/* ============================================================================
   alerts-sw.js — the part that wakes the phone.

   This runs in the background, with no page open. Android hands it a push and
   it shows the notification. That is all it does — no caching, no offline
   tricks, nothing that could interfere with the other Simtec pages.

   ⚠ THE SOUND IS NOT SET HERE, AND CANNOT BE.
   Chrome on Android ignores any sound a website asks for. The tone comes from
   Android's own notification settings for this site:
       Settings → Apps → Chrome → Notifications → app.simtectp.com
   There Matt picks the tone, the volume, and whether it overrides Do Not
   Disturb. If it is not loud enough, that is where to look — not in this file.

   ⚠ requireInteraction keeps the notification on screen until it is dismissed,
   so a sale seen an hour later is still on the lock screen.
============================================================================ */

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = { title: 'Simtec', body: 'Something happened.', tag: 'simtec-alert' };
  try {
    if (event.data) d = Object.assign(d, event.data.json());
  } catch (err) {
    /* A push with no readable payload still deserves to ring — better a vague
       alert than a silent one. */
    try { d.body = event.data ? event.data.text() : d.body; } catch (e2) {}
  }

  event.waitUntil(
    self.registration.showNotification(d.title, {
      body: d.body,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: d.tag || ('simtec-' + Date.now()),
      renotify: true,              // ring again even if one is already showing
      requireInteraction: true,    // stays until dismissed
      vibrate: [300, 120, 300, 120, 500],
      silent: false,
      data: { url: d.url || '/home.html' },
    })
  );
});

/* Tapping it opens the System — or focuses the tab if it is already open. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/home.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(url) && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
