// Photo recognition on this computer (port of the extension's ui/lite_engine.js `understand`): MobileCLIP-S0's
// vision model, fetched once from Hugging Face and kept in the browser's Cache Storage, scored against the prompt
// vectors the extension ships (clip_prompts.json). Runs in a worker so the page stays responsive.
const CLIP_MODEL = ['Xenova/mobileclip_s0', 'fp16'];
let T = null;
let clip = null;
let prompts = null;

let initPromise = null;
// one load at a time: a second photo during the download waits for the same load
function init() {
  if (!initPromise) initPromise = load().catch((e) => { initPromise = null; throw e; });
  return initPromise;
}

// SketchUp's built-in browser has no working Cache Storage (caches.open never answers there, checked 2026-11-19):
// transformers.js would wait for it forever. The cache is used only when it answers within 1.5 s.
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
    wasm.numThreads = 1; // no SharedArrayBuffer needed: works on any static host
    lib.env.allowRemoteModels = true;
    lib.env.allowLocalModels = false;
    lib.env.useBrowserCache = await cacheWorks();
    T = lib;
  }
  if (!prompts) prompts = await (await fetch(new URL('./clip_prompts.json', import.meta.url))).json();
  if (!clip) {
    let last = 0;
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.total > 1e6 && Date.now() - last > 300) {
        last = Date.now();
        // to the latest photo: one dropped during the download is the one the page is waiting for
        self.postMessage({ job: latestJob, status: 'download', loaded: p.loaded, total: p.total });
      }
    };
    const processor = await T.AutoProcessor.from_pretrained(CLIP_MODEL[0], { progress_callback });
    const vision = await T.CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL[0], { dtype: CLIP_MODEL[1], device: 'wasm', progress_callback });
    clip = { processor, vision };
  }
}

function vectors(g, dim) {
  if (!g._vecs) {
    const bin = atob(g.emb);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ints = new Int16Array(bytes.buffer);
    g._vecs = g.labels.map((_, k) => { const v = new Float32Array(dim); for (let i = 0; i < dim; i++) v[i] = ints[k * dim + i] * g.scales[k]; return v; });
  }
  return g._vecs;
}

function classify(img, g, dim, allowed) {
  const vecs = vectors(g, dim);
  const score = {};
  vecs.forEach((v, k) => {
    const label = g.labels[k];
    if (allowed && allowed.indexOf(label) < 0) return;
    let s = 0;
    for (let i = 0; i < dim; i++) s += img[i] * v[i];
    if (score[label] === undefined || 100 * s > score[label]) score[label] = 100 * s;
  });
  const mx = Math.max(...Object.values(score));
  let sum = 0;
  const probs = {};
  for (const k in score) { probs[k] = Math.exp(score[k] - mx); sum += probs[k]; }
  let best = null;
  for (const k in probs) { probs[k] = Math.round(probs[k] / sum * 1000) / 1000; if (!best || probs[k] > probs[best]) best = k; }
  return { label: best, p: probs[best], probs };
}

const STYLE_GROUPS = {
  bed: { outline: ['table.top', ['rect', 'round']], headboard: 'bed.headboard', base: 'bed.base', throw: 'bed.throw', bedding: 'bed.bedding', throw_texture: 'bed.throw_texture' },
  sofa: { arms: 'sofa.arms', back: ['sofa.back', ['cushions', 'tight', 'tufted']], base: 'sofa.base' },
  armchair: { arms: 'sofa.arms', back: 'sofa.back', base: 'sofa.base' },
  chair: { back: 'chair.back', arms: 'chair.arms', legs: 'chair.legs' },
  table: { top: 'table.top', legs: 'table.legs' },
  coffee_table: { top: 'table.top', legs: 'table.legs' },
  nightstand: { fronts: ['storage.fronts', ['drawers', 'doors']], base: 'storage.base', handles: 'storage.handles', style: 'storage.style' },
  cabinet: { fronts: 'storage.fronts', base: 'storage.base', handles: 'storage.handles', style: 'storage.style' },
  wardrobe: { fronts: ['storage.fronts', ['doors', 'mixed']], base: 'storage.base', handles: 'storage.handles', style: 'storage.style' },
};

// Photos are looked at one at a time (an ONNX session cannot run two inferences at once); a photo that is no longer
// the latest when its turn comes is dropped.
let queue = Promise.resolve();
let latestJob = 0;
self.onmessage = (e) => {
  latestJob = e.data.job;
  queue = queue.then(() => handle(e)).catch(() => {});
};

async function handle(e) {
  const { job, bitmap } = e.data;
  if (job !== latestJob) { if (bitmap && bitmap.close) bitmap.close(); return; }
  const post = (m) => self.postMessage(Object.assign({ job }, m));
  try {
    post({ status: 'loading' });
    await init();
    if (job !== latestJob) return; // a newer photo arrived during the download
    post({ status: 'thinking' });
    const t0 = performance.now();
    // the photo as the model's processor expects it: RGBA pixels from the page's downscaled bitmap
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    // (the bitmap is closed by now: its size is read from the canvas)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const raw = new T.RawImage(new Uint8ClampedArray(data), canvas.width, canvas.height, 4);
    const inputs = await clip.processor(raw.rgb());
    let image_embeds;
    try {
      ({ image_embeds } = await clip.vision(inputs));
    } finally {
      for (const v of Object.values(inputs)) if (v && typeof v.dispose === 'function') v.dispose();
    }
    const emb = Float32Array.from(image_embeds.data);
    if (image_embeds.dispose) image_embeds.dispose();
    let n = 0;
    for (let i = 0; i < emb.length; i++) n += emb[i] * emb[i];
    n = Math.sqrt(n) || 1;
    const img = Float32Array.from(emb, (x) => x / n);
    const P = prompts;
    const type = classify(img, P.groups.type, P.dim);
    const styles = {};
    const conf = {};
    for (const t in STYLE_GROUPS) {
      styles[t] = {}; conf[t] = {};
      for (const key in STYLE_GROUPS[t]) {
        const spec = STYLE_GROUPS[t][key];
        const name = Array.isArray(spec) ? spec[0] : spec;
        const allowed = Array.isArray(spec) ? spec[1] : null;
        const r = classify(img, P.groups[name], P.dim, allowed);
        styles[t][key] = t === 'nightstand' && key === 'fronts' && r.label === 'doors' ? 'door' : r.label;
        conf[t][key] = Math.round(r.p * 100) / 100;
      }
    }
    if (styles.bed && styles.bed.outline === 'round' && P.groups['bed.round_headboard']) {
      const r = classify(img, P.groups['bed.round_headboard'], P.dim);
      styles.bed.headboard = r.label;
      conf.bed.headboard = Math.round(r.p * 100) / 100;
    }
    post({ status: 'done', result: { type: type.label, confidence: Math.round(type.p * 100) / 100, types: type.probs, styles, conf,
      seconds: Math.round((performance.now() - t0) / 100) / 10 } });
  } catch (err) {
    // a broken or half-downloaded model is loaded again next time; its sessions are released first
    if (clip) { try { if (clip.vision.dispose) await clip.vision.dispose(); } catch (x) { /* already gone */ } }
    clip = null;
    initPromise = null;
    post({ status: 'error', error: String((err && err.message) || err) });
  } finally {
    if (bitmap && bitmap.close) bitmap.close(); // closing twice is harmless
  }
}
