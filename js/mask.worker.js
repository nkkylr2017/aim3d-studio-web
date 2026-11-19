// Cuts the piece out of a room photo (ISNet, the same model the extension uses: onnx-community/ISNet-ONNX, 8-bit,
// 44 MB, AGPL-3.0, fetched from Hugging Face once and kept in the browser's cache). Plain-backdrop photos never come
// here: fit.js cuts those out without a model. Answers { job, mask: Uint8Array (w×h, 1 = the piece) }.
const MODEL = ['onnx-community/ISNet-ONNX', 'q8'];
let T = null;
let net = null;
let loading = null;
let latestJob = 0;

// SketchUp's built-in browser has no working Cache Storage (caches.open never answers there, checked 2026-11-19):
// transformers.js would wait for it forever. The cache is used only when it answers within 1.5 s.
async function cacheWorks() {
  try {
    if (typeof caches === 'undefined') return false;
    return await Promise.race([caches.open('aim3d-probe').then(() => true, () => false), new Promise((ok) => setTimeout(() => ok(false), 1500))]);
  } catch (e) { return false; }
}

async function load(job) {
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

let queue = Promise.resolve();
self.onmessage = (e) => {
  latestJob = e.data.job;
  queue = queue.then(() => handle(e.data)).catch(() => {});
};

async function handle({ job, bitmap }) {
  try {
    if (job !== latestJob) return;
    self.postMessage({ job, status: 'loading' });
    if (!loading) loading = load(job).catch((err) => { loading = null; throw err; });
    await loading;
    if (job !== latestJob) return;
    self.postMessage({ job, status: 'cutting' });
    const W = bitmap.width; const H = bitmap.height;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const raw = new T.RawImage(new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data), W, H, 4).rgb();
    const inputs = await net.processor(raw);
    const inName = (net.model.sessions && net.model.sessions.model && net.model.sessions.model.inputNames || ['input'])[0];
    let out;
    try {
      out = await net.model({ [inName]: inputs.pixel_values });
    } finally {
      for (const v of Object.values(inputs)) if (v && typeof v.dispose === 'function') v.dispose();
    }
    const t = out[Object.keys(out)[0]];
    const mh = t.dims[t.dims.length - 2]; const mw = t.dims[t.dims.length - 1];
    const data = t.data;
    let lo = Infinity; let hi = -Infinity;
    for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const sx = Math.min(mw - 1, Math.floor((x + 0.5) * mw / W));
        const sy = Math.min(mh - 1, Math.floor((y + 0.5) * mh / H));
        mask[y * W + x] = (data[sy * mw + sx] - lo) / (hi - lo || 1) > 0.5 ? 1 : 0;
      }
    }
    for (const v of Object.values(out)) if (v && typeof v.dispose === 'function') v.dispose();
    self.postMessage({ job, status: 'done', mask, w: W, h: H }, [mask.buffer]);
  } catch (err) {
    self.postMessage({ job, status: 'error', error: String((err && err.message) || err) });
  } finally {
    if (bitmap && bitmap.close) bitmap.close();
  }
}
