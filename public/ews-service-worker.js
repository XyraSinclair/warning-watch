self.addEventListener('push', (event) => {
  const payload = event.data
    ? event.data.json()
    : {
        title: 'Warning Watch alert',
        body: 'A takeoff or anomaly alert was detected.',
        url: '/',
      };
  const title = payload.title || 'Warning Watch alert';
  const options = {
    body: payload.body || 'A takeoff or anomaly alert was detected.',
    data: {
      url: payload.url || '/',
      eventKey: payload.eventKey || null,
    },
    tag: payload.tag || payload.eventKey || 'warning-watch-alert',
    renotify: true,
    requireInteraction: Number(payload.level || 0) >= 5,
    icon: '/favicon.svg',
    badge: '/favicon.svg',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(clients.openWindow(targetUrl));
});
