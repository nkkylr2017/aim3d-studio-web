// The local draft, off the page's thread: Depth Anything V2 small (q8, about 27 MB from Hugging Face's model hub
// once; no GPU time, no quota) gives the photo's relative depth, and lite.js turns the cut-out and that depth into a
// closed shape. In: { job, bitmap, mask (Uint8Array, 1 = piece), mw, mh, grid }. Out: { job, status: 'done', pos,
// tris, size } or { status: 'download' | 'depth' | 'error' }.
import { liteMesh } from './lite.js';
const MODEL = ['onnx-community/depth-anything-v2-small', 'q8'];
let T = null;
let net = null;
let initPromise = null;
let latestJob = 0;

async function cacheWorks() {
  try {
    if (typeof caches === 'undefined') return false;
    return await Promise.race([caches.open('aim3d-probe').then(() => true, () => false), new Promise((ok) => setTimeout(() => ok(false), 1500))]);
  } catch (e) { return false; }
}

async function load() {
  if (!T) {
    const lib = await import('../vendor/transformers.min.js');
    const wasm = lib.env.backends.onnx.wasm;
    wasm.wasmPaths = {
      mjs: new URL('../vendor/ort-wasm-simd-threaded.jsep.mjs', import.meta.url).href,
      wasm: new URL('../vendor/ort-wasm-simd-threaded.jsep.wasm', import.meta.url).href,
    };
    wasm.numThreads = 1;
    lib.env.allowRemoteModels = true;
    lib.env.allowLocalModels = false;
    lib.env.useBrowserCache = await cacheWorks();
    T = lib;
  }
  if (!net) {
    let last = 0;
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.total > 1e6 && Date.now() - last > 300) {
        last = Date.now();
        self.postMessage({ job: latestJob, status: 'download', loaded: p.loaded, total: p.total });
      }
    };
    const processor = await T.AutoProcessor.from_pretrained(MODEL[0], { progress_callback });
    const model = await T.AutoModel.from_pretrained(MODEL[0], { dtype: MODEL[1], device: 'wasm', progress_callback });
    net = { processor, model };
  }
}
const init = () => (initPromise = initPromise || load().catch((e) => { initPromise = null; throw e; }));

self.onmessage = async (e) => {
  const { job, bitmap, mask, mw, mh, grid } = e.data;
  latestJob = job;
  const post = (m, transfer) => self.postMessage(Object.assign({ job }, m), transfer || []);
  try {
    await init();
    if (job !== latestJob) { bitmap.close(); return; }
    post({ status: 'depth' });
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = c.getContext('2d');
    g.drawImage(bitmap, 0, 0);
    bitmap.close();
    const data = g.getImageData(0, 0, c.width, c.height).data;
    const raw = new T.RawImage(new Uint8ClampedArray(data), c.width, c.height, 4).rgb();
    const out = await net.model(await net.processor(raw));
    if (job !== latestJob) return;
    const d = out.predicted_depth;
    const dh = d.dims[d.dims.length - 2];
    const dw = d.dims[d.dims.length - 1];
    const m = liteMesh({ mask, mw, mh, depth: d.data, dw, dh, grid: grid || 160 });
    post({ status: 'done', pos: m.pos, tris: m.tris, size: m.size }, [m.pos.buffer, m.tris.buffer]);
  } catch (err) {
    post({ status: 'error', error: String(err && err.message || err) });
  }
};
