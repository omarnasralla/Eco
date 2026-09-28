/**
 * Service worker for web push.
 *
 * Deliberately tiny. It exists to receive a push and open the right screen —
 * it does not cache anything, because an offline cache of financial figures
 * is a different feature with different risks, and mixing the two means every
 * push change risks serving someone a stale balance.
 */
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    // A push that is not our JSON is still worth showing rather than dropping.
    payload = { title: 'Eco', body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Eco', {
      body: payload.body || '',
      icon: '/eco/app/icon.svg',
      badge: '/eco/app/icon.svg',
      // Lets a repeat of the same alert replace the earlier one rather than
      // stacking, which matters for a daily digest.
      tag: payload.tag || payload.title,
      data: { url: payload.url || '/eco/app' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/eco/app';

  // Focus an already-open tab rather than opening a second one.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('/eco/app') && 'focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
