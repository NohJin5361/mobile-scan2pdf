// Service worker: offline app shell. Network first (always fresh when online), cache
// fallback when offline. API calls are never cached.
const CACHE = 'scan2pdf-v1';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'js/app.js',
  'js/ui.js',
  'js/util.js',
  'js/settings.js',
  'js/store.js',
  'js/api.js',
  'js/sync.js',
  'js/pages.js',
  'js/imageio.js',
  'js/processor.js',
  'js/worker.js',
  'js/worker-ops.js',
  'js/exporter.js',
  'js/core/image.js',
  'js/core/geometry.js',
  'js/core/warp.js',
  'js/core/detect.js',
  'js/core/enhance.js',
  'js/core/pdf.js',
  'js/core/zip.js',
  'js/views/common.js',
  'js/views/home.js',
  'js/views/camera.js',
  'js/views/crop.js',
  'js/views/page.js',
  'js/views/doc.js',
  'js/views/cloud.js',
  'js/views/settings.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('scan2pdf-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match('index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
