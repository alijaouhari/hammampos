/* HammamPOS dashboard: shows push notifications and opens the right page when one is tapped. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (_) { m = { title: 'HammamPOS', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'HammamPOS', {
    body: m.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: m.tag || undefined,
    renotify: !!m.tag,
    data: { url: m.url || '/' }
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        w.postMessage({ type: 'hpos-open', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
