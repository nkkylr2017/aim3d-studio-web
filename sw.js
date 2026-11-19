// Offline support. The app's own files: network first (an update is never hidden behind an old copy), the cache
// when offline. The vendored libraries (large, versioned by folder): cache first. The recognition model is kept by
// transformers.js in its own Cache Storage entry.
const APP = 'aim3d-app-v3';
const VENDOR = 'aim3d-vendor-v3';
const SHELL = ['./', './index.html', './js/app.js', './js/furniture.js', './js/kit.js', './js/rng.js', './js/cloth_sim.js', './js/mesh.js',
  './js/viewer.js', './js/export.js', './js/engine.worker.js', './js/recognize.worker.js', './js/clip_prompts.json',
  './js/fit.js', './js/ai.js', './js/mask.worker.js'];

// the libraries are fetched by the first visit before this worker exists, so they are cached here explicitly
const LIBS = ['./vendor/three/three.module.js', './vendor/three/three.core.js', './vendor/three/addons/OrbitControls.js',
  './vendor/three/addons/GLTFExporter.js', './vendor/three/addons/BufferGeometryUtils.js', './vendor/transformers.min.js',
  './vendor/three/addons/loaders/GLTFLoader.js', './vendor/three/addons/utils/BufferGeometryUtils.js', './vendor/three/addons/utils/SkeletonUtils.js',
  './vendor/ort-wasm-simd-threaded.jsep.mjs', './vendor/ort-wasm-simd-threaded.jsep.wasm'];

self.addEventListener('install', (e) => {
  e.waitUntil(Promise.all([caches.open(APP).then((c) => c.addAll(SHELL)), caches.open(VENDOR).then((c) => c.addAll(LIBS))])
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('aim3d-') && k !== APP && k !== VENDOR).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.open(VENDOR).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      } catch (err) {
        return new Response('Offline and not cached yet', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    }));
    return;
  }
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) caches.open(APP).then((c) => c.put(e.request, res.clone()));
    return res;
  }).catch(async () => (await caches.match(e.request)) || new Response('Offline and not cached yet', { status: 503, headers: { 'Content-Type': 'text/plain' } })));
});
