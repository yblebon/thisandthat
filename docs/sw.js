const CACHE_NAME = 'comic-timeline-v3';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.json',
  '/icons/icon-192.png',                    // ← now pre-cached
  'https://unpkg.com/lucide@0.574.0/dist/umd/lucide.min.js'  // ← pinned
];

const DYNAMIC_CACHE = 'dynamic-v3';
const MAX_DYNAMIC_ENTRIES = 70;
const MAX_AGE_DAYS = 30;

const STATIC_PATHS = STATIC_ASSETS
  .filter(url => url.startsWith('/'))
  .map(path => path.split('?')[0]);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('Opened cache, starting asset download...');
      return Promise.allSettled(
        STATIC_ASSETS.map(url => 
          cache.add(url).catch(err => console.error(`Failed to cache: ${url}`, err))
        )
      );
    }).then(() => {
      console.log('Install complete!');
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key !== CACHE_NAME && key !== DYNAMIC_CACHE)
          .map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

async function trimDynamicCache() {
  try {
    const cache = await caches.open(DYNAMIC_CACHE);
    const now = Date.now();
    const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const requests = await cache.keys();
    const toDelete = [];

    for (const req of requests) {
      const res = await cache.match(req);
      if (res) {
        const dateHeader = res.headers.get('date');
        const cachedTime = dateHeader ? new Date(dateHeader).getTime() : now;
        if (now - cachedTime > maxAgeMs) toDelete.push(req);
      }
    }

    await Promise.all(toDelete.map(req => cache.delete(req)));

    const remaining = await cache.keys();
    if (remaining.length > MAX_DYNAMIC_ENTRIES) {
      const excess = remaining.length - MAX_DYNAMIC_ENTRIES;
      await Promise.all(remaining.slice(0, excess).map(req => cache.delete(req)));
    }
  } catch (err) {
    console.warn('Cache trim failed:', err);
  }
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 1. Navigation → custom offline page
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/offline.html'))
    );
    return;
  }

  // 2. Cache-first: same-origin static + icons
  const isSameOriginStatic =
    url.origin === self.origin &&
    STATIC_PATHS.some(path => url.pathname === path || url.pathname === path + '/');

  const isIcon = url.pathname.startsWith('/icons/');

  if (isSameOriginStatic || isIcon) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // 3. External static (pinned lucide)
  if (STATIC_ASSETS.some(asset => url.href.startsWith(asset.split('?')[0]))) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request).then(res => {
          if (res?.ok) caches.open(CACHE_NAME).then(cache => cache.put(event.request, res.clone()));
          return res;
        });
      })
    );
    return;
  }

  // 4. Stale-while-revalidate for conversations.json (critical fix)
  if (url.href.includes('conversations.json')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(DYNAMIC_CACHE);
        const cached = await cache.match(event.request);

        const fetchPromise = fetch(event.request).then(async res => {
          if (res && res.status === 200) {
            await cache.put(event.request, res.clone());
            trimDynamicCache();
          }
          return res;
        }).catch(() => {
          return cached || new Response(
            'Offline – stories not cached yet',
            { status: 503, statusText: 'Service Unavailable' }
          );
        });

        if (cached) {
          fetchPromise.catch(() => {}); // background update
          return cached;
        }
        return fetchPromise;
      })()
    );
    return;
  }

  // 5. Images & comic assets – cache-first + nice SVG fallback (unchanged)
  const isImageRequest =
    event.request.destination === 'image' ||
    url.hostname.includes('myfilebase.com') ||
    url.hostname.includes('via.placeholder.com');

  if (isImageRequest) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;

        return fetch(event.request).then(networkResponse => {
          if (networkResponse?.status === 200) {
            const cacheCopy = networkResponse.clone();
            caches.open(DYNAMIC_CACHE).then(cache => {
              cache.put(event.request, cacheCopy);
              trimDynamicCache();
            });
          }
          return networkResponse;
        }).catch(() => {
          return new Response(
            `<svg width="320" height="320" viewBox="0 0 320 320" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="320" height="320" fill="#f1f3f5"/>
              <path d="M160 90 L240 160 L160 230 L80 160 Z" stroke="#868e96" stroke-width="14" fill="none"/>
              <circle cx="120" cy="130" r="14" fill="#adb5bd"/>
              <circle cx="200" cy="130" r="14" fill="#adb5bd"/>
              <text x="160" y="270" font-family="system-ui, sans-serif" font-size="28" text-anchor="middle" fill="#495057">Comic offline</text>
              <text x="160" y="300" font-family="system-ui, sans-serif" font-size="20" text-anchor="middle" fill="#868e96">Reconnect to load more</text>
            </svg>`,
            { headers: { 'Content-Type': 'image/svg+xml' } }
          );
        });
      })
    );
    return;
  }

  // 6. General network-first → cache on success (critical fix)
  event.respondWith(
    fetch(event.request).then(async (response) => {
      if (response && response.ok) {
        const cache = await caches.open(DYNAMIC_CACHE);
        cache.put(event.request, response.clone());
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});