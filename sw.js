/**
 * MealForge PWA Service Worker — Cache First strategy for static assets.
 * Domain-agnostic: uses path-based cache keys so the app works on any origin
 * (localhost, production, or temporary tunnels like ngrok) and offline.
 */

const CACHE_NAME = 'mealforge-v2';

const STATIC_ASSETS = [
  './',
  './index.html',
  './css/theme.css',
  './css/main.css',
  './app.js',
  './manifest.json',
  './icons/appicon-192.png',
  './icons/appicon-512.png',
];

/** Cache key from request: current origin + pathname (domain-agnostic). */
function cacheKeyFor(request) {
  const url = new URL(request.url);
  const path = url.pathname === '/' || url.pathname === '' ? '/index.html' : url.pathname;
  return self.location.origin + path;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      const toDelete = names.filter((name) => name !== CACHE_NAME);
      return Promise.all(toDelete.map((name) => caches.delete(name))).then(() => self.clients.claim());
    })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (!request.url.startsWith(self.location.origin)) return;

  const key = cacheKeyFor(request);

  event.respondWith(
    caches.match(new Request(key)).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(new Request(key), clone));
        }
        return response;
      }).catch(() => {
        if (request.mode === 'navigate' && request.destination === 'document') {
          const indexKey = self.location.origin + '/index.html';
          return caches.match(new Request(indexKey)).then((fallback) => fallback || new Response(
            'Offline — unable to load the page.',
            { status: 503, statusText: 'Service Unavailable', headers: { 'Content-Type': 'text/plain' } }
          ));
        }
        return new Response('Unavailable offline.', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain' },
        });
      });
    })
  );
});
