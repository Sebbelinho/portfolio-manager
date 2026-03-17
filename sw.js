const CACHE_NAME = 'ai-monitor-v10';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.matchAll()).then((clients) => {
      clients.forEach((client) => client.navigate(client.url));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Same-origin requests: always bypass HTTP cache to get fresh content
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request))
    );
    return;
  }

  // External requests: normal fetch
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
