const CACHE_NAME = 'comic-timeline-v3';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://unpkg.com/lucide@latest/dist/umd/lucide.min.js'
];

const DYNAMIC_CACHE = 'dynamic-v3';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME && key !== DYNAMIC_CACHE)
            .map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Cache-first for static assets & icons
  if (STATIC_ASSETS.some(path => url.pathname === path) ||
      url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // Stale-while-revalidate for conversations.json
  if (url.href.includes('conversations.json')) {
    event.respondWith(
      caches.open(DYNAMIC_CACHE).then(cache => {
        return cache.match(event.request).then(cached => {
          const fetchPromise = fetch(event.request).then(res => {
            if (res && res.status === 200) {
              cache.put(event.request, res.clone());
            }
            return res;
          }).catch(() => cached || new Response('Offline – stories not cached yet', {status: 503}));
          return cached || fetchPromise;
        });
      })
    );
    return;
  }

  // Cache-first for images
  if (event.request.destination === 'image' ||
      url.hostname.includes('myfilebase.com') ||
      url.hostname.includes('via.placeholder.com')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request).then(res => {
          if (res && res.status === 200) {
            caches.open(DYNAMIC_CACHE).then(cache => cache.put(event.request, res.clone()));
          }
          return res;
        }).catch(() => caches.match('/icons/icon-192.png'));
      })
    );
    return;
  }

  // Network-first fallback
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});