// Free image-to-3D engines on Hugging Face Spaces (ZeroGPU), run from the browser (port of the extension's ai.rb).
// The photo goes to the Space only when the user asks for a model. The Spaces are tried from the one that needs the
// least free GPU time; one that is out of quota, down or changed gives way to the next. Endpoints and input counts are
// compared with each Space's live /config before anything is uploaded. Quota is per user (per IP without a token).
import { Gradio, GradioError } from './gradio.js';

export const SPACES = [
  { id: 'hunyuan2', name: 'Hunyuan3D 2', space: 'tencent-hunyuan3d-2', interface: { shape_generation: 13, on_export_click: 6 } },
  { id: 'hunyuan21', name: 'Hunyuan3D 2.1', space: 'tencent-hunyuan3d-2-1', interface: { shape_generation: 12, on_export_click: 6 } },
  { id: 'triposg', name: 'TripoSG', space: 'vast-ai-triposg', interface: { start_session: 0, run_segmentation: 1, image_to_3d: 6 } },
  { id: 'trellis2', name: 'TRELLIS.2', space: 'microsoft-trellis-2',
    interface: { start_session: 0, preprocess_image: 1, image_to_3d: 15, extract_glb: 2 } },
  // Hunyuan3D 2 fine-tuned for up to four views (front, back, left, right; only the front is required). Used only
  // when the user gave more photos of the piece; then it goes first and the one-photo engines follow it.
  { id: 'hunyuan2mv', name: 'Hunyuan3D 2mv', space: 'tencent-hunyuan3d-2mv', views: true, interface: { shape_generation: 13, on_export_click: 6 } },
];
export const FACES = { light: 20000, fast: 30000, standard: 60000, high: 120000 };
const MAX_GLB = 200 * 1024 * 1024;

const unwrap = (d) => (d && typeof d === 'object' && d.value && typeof d.value === 'object' ? d.value : d);

export function isGLB(buf) {
  if (!buf || buf.byteLength < 20 || buf.byteLength > MAX_GLB) return false;
  const v = new DataView(buf);
  return v.getUint32(0, true) === 0x46546c67 && v.getUint32(4, true) === 2 && v.getUint32(8, true) <= buf.byteLength;
}

// The flows: each resolves the output FileData of the Space's 3D file.
const FLOWS = {
  async hunyuan(c, args, faces, say) {
    say('gpu');
    const out = await c.call('shape_generation', args);
    const mesh = unwrap(out[0]);
    if (!mesh || !mesh.path) throw new GradioError('returned no mesh');
    say('reduce');
    const exp = await c.call('on_export_click', [mesh, mesh, 'glb', true, false, faces]);
    return pick(c, exp, 1);
  },
  hunyuan2(c, img, o, say) { return FLOWS.hunyuan(c, [null, img, null, null, null, null, o.steps, 5.0, 1234, o.octree, o.rembg, 8000, false], o.faces, say); },
  async hunyuan2mv(c, img, o, say) {
    const up = {};
    for (const side of ['back', 'left', 'right']) {
      if (!o.views[side]) continue;
      say('upload');
      up[side] = await c.upload(o.views[side], `${side}.${o.views[side].type === 'image/png' ? 'png' : 'jpg'}`);
    }
    return FLOWS.hunyuan(c, [null, null, img, up.back || null, up.left || null, up.right || null, o.steps, 5.0, 1234, o.octree, o.rembg, 8000, false], o.faces, say);
  },
  hunyuan21(c, img, o, say) { return FLOWS.hunyuan(c, [img, null, null, null, null, o.steps, 5.0, 1234, o.octree, o.rembg, 8000, false], o.faces, say); },
  async triposg(c, img, o, say) {
    await c.call('start_session', []);
    say('separate');
    const seg = await c.call('run_segmentation', [img]);
    say('gpu');
    return pick(c, await c.call('image_to_3d', [seg[0], 0, 50, 7.0, true, o.faces]), 0);
  },
  async trellis2(c, img, o, say) {
    await c.call('start_session', []);
    say('prepare');
    const pre = await c.call('preprocess_image', [img]);
    say('gpu');
    await c.call('image_to_3d', [pre[0], 0, '512', 7.5, 0.7, 12, 5.0, 7.5, 0.5, 12, 3.0, 1.0, 0.0, 12, 3.0]);
    say('export');
    return pick(c, await c.call('extract_glb', [o.faces, 1024]), 0);
  },
};

function pick(c, data, prefer) {
  const list = (data || []).map(unwrap);
  const files = list.filter((d) => d && typeof d === 'object' && (d.path || d.url));
  return (list[prefer] && list[prefer].path ? list[prefer] : null)
    || files.find((d) => /\.glb$/i.test(c.fileUrl(d) || '')) || files[0] || null;
}

// image: a Blob (a PNG cut-out on a transparent background skips the Space's own background removal).
// views: { back, left, right } Blobs, any of them (more photos of the same piece): the multi-view engine goes first.
// engine: the one to try first; only: that one and no other. onStatus(stepKey, engineName).
// Resolves { glb: ArrayBuffer, engine, id, tried } or rejects with an Error carrying .tried, .quota and .token.
export function engineQueue({ engine = '', only = false, views = null } = {}) {
  const many = !!(views && (views.back || views.left || views.right));
  let queue = SPACES.filter((s) => !s.views || many);
  if (many) queue.sort((a, b) => (b.views ? 1 : 0) - (a.views ? 1 : 0));
  const first = queue.findIndex((s) => s.id === engine);
  if (only) return first >= 0 ? [queue[first]] : [];
  if (first > 0) queue.unshift(queue.splice(first, 1)[0]);
  return queue;
}
export async function makeModel({ image, views = null, token = '', quality = 'light', faces, engine = '', only = false, steps = 20,
  octree = 256, onStatus = () => {}, signal, fetchFn } = {}) {
  const queue = engineQueue({ engine, only, views });
  const v = views || {};
  const o = {
    faces: faces >= 5000 && faces <= 300000 ? faces : (FACES[quality] || FACES.light),
    steps: steps >= 5 && steps <= 50 ? steps : 20,
    octree: octree >= 64 && octree <= 512 ? octree : 256,
    // the Space removes backgrounds unless every photo it gets is already a cut-out
    rembg: image.type !== 'image/png' || ['back', 'left', 'right'].some((k) => v[k] && v[k].type !== 'image/png'),
    views: v,
  };
  const name = image.type === 'image/png' ? 'photo.png' : 'photo.jpg';
  const tried = [];
  for (const s of queue) {
    const say = (step) => onStatus(step, s.name);
    try {
      say('connect');
      const c = await new Gradio(s.space, { token, signal, fetchFn }).connect();
      const changed = c.interfaceProblems(s.interface);
      if (changed.length) throw new GradioError(`changed its interface (${changed.join('; ')})`, 'changed');
      say('upload');
      const img = await c.upload(image, name);
      const file = await FLOWS[s.id](c, img, o, say);
      say('download');
      const glb = await c.download(file);
      if (!isGLB(glb)) throw new GradioError('the file that came back is not a 3D model (GLB)');
      return { glb, engine: s.name, id: s.id, tried };
    } catch (e) {
      if (signal && signal.aborted) throw e;
      tried.push({ engine: s.name, error: String(e.message).slice(0, 200), kind: e.kind || 'space' });
      if (e.kind === 'token') break; // a wrong token is wrong everywhere
    }
  }
  const err = new Error(tried.map((t) => `${t.engine}: ${t.error}`).join(' | '));
  err.tried = tried;
  err.quota = tried.some((t) => t.kind === 'quota');
  err.token = tried.some((t) => t.kind === 'token');
  throw err;
}
