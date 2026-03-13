/**
 * MealForge PWA Service Worker — Stale-While-Revalidate.
 * Caches static assets on install (critical + JS modules + fonts); serves from cache
 * then revalidates in background; fallback to /index.html for navigation; prunes old caches on activate.
 * All URLs use absolute paths (/) for correct resolution.
 *
 * DEBUG NOTE: When diagnosing front-end issues, temporarily unregister or bypass this
 * Service Worker in DevTools to ensure you are running against the latest JS/CSS.
 */

const CACHE_VERSION = 'v3';
const CACHE_NAME = 'mealforge-static-' + CACHE_VERSION;

/** Critical static assets — relative to scope (e.g. GitHub Pages subpath) */
const CRITICAL_ASSETS = [
  './index.html',
  './app.js',
  './css/main.css',
  './css/theme.css',
  './manifest.json',
];

/** JS modules required by app.js — fetched and cached at install */
const MODULE_PATHS = [
  './modules/db.js',
  './modules/parser.js',
  './modules/selection-mode.js',
  './modules/ui.js',
  './utils/recipeUtils.js',
];

/**
 * Local fonts/icons can be added here once they exist in the repo.
 * Keep this empty until files are present to avoid install-time 404s.
 */
const OPTIONAL_ASSETS = [];

function originUrl(path) {
  return new URL(path, self.location.href).href;
}

function urlsToCache() {
  return [...CRITICAL_ASSETS, ...MODULE_PATHS, ...OPTIONAL_ASSETS].map(originUrl);
}

async function cacheIfOk(cache, url) {
  try {
    const res = await fetch(url, { cache: 'reload' });
    if (res && res.ok) {
      await cache.put(url, res.clone());
    }
  } catch (_) {
    // Ignore: offline during install or resource missing. SW should still install.
  }
}

self.addEventListener('install', (event) => {
  console.log('[SW] install', CACHE_NAME);
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const urls = urlsToCache();
      await Promise.all(urls.map((url) => cacheIfOk(cache, url)));
    }).then(() => {
      console.log('[SW] install complete, skipWaiting');
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  console.log('[SW] activate', CACHE_NAME);
  event.waitUntil(
    caches.keys().then((keys) => {
      const toDelete = keys.filter(
        (key) => key.startsWith('mealforge-static-') && key !== CACHE_NAME
      );
      toDelete.forEach((key) => console.log('[SW] deleting old cache:', key));
      return Promise.all(toDelete.map((key) => caches.delete(key)));
    }).then(() => {
      console.log('[SW] activate complete, claiming clients');
      return self.clients.claim();
    })
  );
});

/**
 * Stale-While-Revalidate: return cached response if present, then revalidate in background.
 * For navigation requests with no cache or failed network, serve /index.html.
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);

      const revalidate = () => {
        fetch(request)
          .then((res) => {
            if (res && res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
      };

      if (cached) {
        revalidate();
        return cached;
      }

      const net = await fetch(request).catch(() => null);
      if (net && net.ok) {
        cache.put(request, net.clone());
        return net;
      }

      if (request.mode === 'navigate') {
        const fallback = await cache.match(originUrl('./index.html'));
        if (fallback) return fallback;
      }

      return net || null;
    })()
  );
});
