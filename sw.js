// Offline support. The app's own files: network first (an update is never hidden behind an old copy), the cache
// when offline. The vendored libraries (large, versioned by folder): cache first. The recognition model is kept by
// transformers.js in its own Cache Storage entry.
// Some browsers (SketchUp's built-in one) have a Cache Storage that never answers: every cache step here gives up
// after 1.5 s and the request goes to the network, so the page can never hang on this worker.
const APP = 'aim3d-app-v6';
const VENDOR = 'aim3d-vendor-v3';
const SHELL = ['./', './index.html', './js/app.js', './js/furniture.js', './js/kit.js', './js/rng.js', './js/cloth_sim.js', './js/mesh.js',
  './js/viewer.js', './js/export.js', './js/engine.worker.js', './js/recognize.worker.js', './js/clip_prompts.json',
  './js/fit.js', './js/ai.js', './js/mask.worker.js', './js/vision.js', './js/gradio.js', './js/engines.js'];

// the libraries are fetched by the first visit before this worker exists, so they are cached here explicitly
const LIBS = ['./vendor/three/three.module.js', './vendor/three/three.core.js', './vendor/three/addons/OrbitControls.js',
  './vendor/three/addons/GLTFExporter.js', './vendor/three/addons/BufferGeometryUtils.js', './vendor/transformers.min.js',
  './vendor/three/addons/loaders/GLTFLoader.js', './vendor/three/addons/utils/BufferGeometryUtils.js', './vendor/three/addons/utils/SkeletonUtils.js',
  './vendor/ort-wasm-simd-threaded.jsep.mjs', './vendor/ort-wasm-simd-threaded.jsep.wasm'];

const late = (ms) => new Promise((ok) => setTimeout(() => ok(null), ms));
// a cache, or null when the cache does not answer in time
const openCache = (name) => Promise.race([caches.open(name).catch(() => null), late(1500)]);
const offline = () => new Response('Offline and not cached yet', { status: 503, headers: { 'Content-Type': 'text/plain' } });

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const [a, v] = await Promise.all([openCache(APP), openCache(VENDOR)]);
    if (a && v) await Promise.all([a.addAll(SHELL), v.addAll(LIBS)]).catch(() => {});
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await Promise.race([caches.keys().catch(() => []), late(1500).then(() => [])]);
    await Promise.all((keys || []).filter((k) => k.startsWith('aim3d-') && k !== APP && k !== VENDOR).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/vendor/')) {
    e.respondWith((async () => {
      const c = await openCache(VENDOR);
      const hit = c ? await Promise.race([c.match(e.request), late(1500)]) : null;
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res.ok && c) c.put(e.request, res.clone()).catch(() => {});
        return res;
      } catch (err) {
        return offline();
      }
    })());
    return;
  }
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) openCache(APP).then((c) => c && c.put(e.request, res.clone()).catch(() => {}));
      return res;
    } catch (err) {
      const c = await openCache(APP);
      return (c && (await Promise.race([c.match(e.request), late(1500)]))) || offline();
    }
  })());
});
