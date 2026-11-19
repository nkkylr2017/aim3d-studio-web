// Fitting the parametric model to the photo (analysis by synthesis): the piece is cut out of the photo, the model is
// rendered as a silhouette from a camera and with its depth and height scaled, and both are searched until the
// rendered outline covers the cut-out as closely as possible. The width is the reference (a photo has no scale);
// the user's one known measurement sets the real size. Also draws the comparison image (photo + fitted outline).
import * as THREE from 'three';
import { Z_UP_TO_Y_UP } from './mesh.js';

const GRID = 128; // the mask is compared on this grid (its longer side)

// ---------------------------------------------------------------- cut-out without AI (plain backdrops)
// px: RGBA of the downscaled photo. A studio or catalogue photo has an even or smoothly graded backdrop: everything
// far enough from the border colours is the piece. Returns null when the backdrop is not plain (a room photo).
export function plainCutout(px, w, h) {
  const border = [];
  const at = (x, y) => { const i = (y * w + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  for (let k = 0; k < 64; k++) {
    const fx = Math.min(w - 1, Math.round((k + 0.5) / 64 * (w - 1)));
    const fy = Math.min(h - 1, Math.round((k + 0.5) / 64 * (h - 1)));
    border.push(at(fx, 1), at(fx, h - 2), at(1, fy), at(w - 2, fy));
  }
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  // the border may be a gradient: compare each pixel with the nearest of a few border colours
  const refs = kmeans3(border, 4);
  const mean = [0, 1, 2].map((i) => border.reduce((s, p) => s + p[i], 0) / border.length);
  const spread = border.map((p) => d(p, mean)).sort((a, b) => a - b)[Math.floor(border.length * 0.8)];
  const steps = [];
  for (let k = 0; k + 4 < border.length; k++) steps.push(d(border[k], border[k + 4]));
  steps.sort((a, b) => a - b);
  const smooth = steps[Math.floor(steps.length * 0.9)] < 14;
  if (!(spread < 40 || smooth)) return null;
  // a dark backdrop (studio black, often a glossy floor): shaded fabric and the floor's reflection sit within the
  // colour gap of the backdrop, so the cut-out model decides instead
  if (0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2] < 48) return null;
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = at(x, y);
      let best = Infinity;
      for (const r of refs) best = Math.min(best, d(p, r));
      m[y * w + x] = best > 34 ? 1 : 0;
    }
  }
  return { mask: clean(m, w, h), w, h, source: 'plain' };
}

function kmeans3(pts, k) {
  let c = Array.from({ length: k }, (_, i) => pts[Math.floor((i + 0.5) * pts.length / k)].slice());
  for (let it = 0; it < 8; it++) {
    const sum = c.map(() => [0, 0, 0, 0]);
    for (const p of pts) {
      let bi = 0; let bd = Infinity;
      c.forEach((q, i) => { const dd = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; if (dd < bd) { bd = dd; bi = i; } });
      sum[bi][0] += p[0]; sum[bi][1] += p[1]; sum[bi][2] += p[2]; sum[bi][3]++;
    }
    c = c.map((q, i) => (sum[i][3] ? [sum[i][0] / sum[i][3], sum[i][1] / sum[i][3], sum[i][2] / sum[i][3]] : q));
  }
  return c;
}

// Keeps the largest connected blob and fills its holes (a gap between chair legs that touches the border stays open).
export function clean(m, w, h) {
  const lab = new Int32Array(w * h).fill(-1);
  let best = -1; let bestN = 0;
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!m[s] || lab[s] >= 0) continue;
    let n = 0;
    stack.push(s); lab[s] = s;
    while (stack.length) {
      const i = stack.pop(); n++;
      const x = i % w; const y = (i - x) / w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && m[j] && lab[j] < 0) { lab[j] = s; stack.push(j); }
      }
    }
    if (n > bestN) { bestN = n; best = s; }
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = lab[i] === best ? 1 : 0;
  // background reachable from the border stays background; enclosed background becomes part of the piece
  const outside = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) if (!out[y * w + x] && !outside[y * w + x]) { outside[y * w + x] = 1; stack.push(y * w + x); }
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) if (!out[y * w + x] && !outside[y * w + x]) { outside[y * w + x] = 1; stack.push(y * w + x); }
  while (stack.length) {
    const i = stack.pop(); const x = i % w; const y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j >= 0 && !out[j] && !outside[j]) { outside[j] = 1; stack.push(j); }
    }
  }
  for (let i = 0; i < w * h; i++) if (!outside[i]) out[i] = 1;
  return out;
}

// The mask on the comparison grid, with its bounding box.
// The comparison grid covers a region of the photo at full solver resolution: the user's box (padded 20 %) or the
// cut-out's box (padded 15 %), so a small piece in a room photo is not a few pixels. Outside the user's box the photo
// counts as background (the model must not spill past it); only the frame's edge is unseen.
function toGrid(cut) {
  let roi = cut.roi;
  if (!roi) {
    const b = bbox(cut.mask, cut.w, cut.h);
    if (!b) return { box: null, area: 0 };
    const pad = 0.25 * Math.max(b.w, b.h);
    const x0 = Math.max(0, Math.floor(b.x0 - pad)); const y0 = Math.max(0, Math.floor(b.y0 - pad));
    roi = { x: x0, y: y0, w: Math.min(cut.w, Math.ceil(b.x1 + pad)) - x0, h: Math.min(cut.h, Math.ceil(b.y1 + pad)) - y0 };
  }
  const k = GRID / Math.max(roi.w, roi.h);
  const gw = Math.max(8, Math.round(roi.w * k));
  const gh = Math.max(8, Math.round(roi.h * k));
  const g = new Uint8Array(gw * gh);
  const at = (x, y) => Math.min(cut.h - 1, Math.floor(roi.y + (y + 0.5) / k)) * cut.w + Math.min(cut.w - 1, Math.floor(roi.x + (x + 0.5) / k));
  // each cell averages the cut-out pixels it covers: a 2 px chair leg survives the reduction (one sample would miss it)
  const cellW = 1 / k;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const sx0 = roi.x + x * cellW; const sy0 = roi.y + y * cellW;
      let on = 0; let n = 0;
      for (let yy = Math.floor(sy0); yy < Math.min(cut.h, Math.ceil(sy0 + cellW)); yy++) {
        for (let xx = Math.floor(sx0); xx < Math.min(cut.w, Math.ceil(sx0 + cellW)); xx++) { on += cut.mask[yy * cut.w + xx]; n++; }
      }
      g[y * gw + x] = n ? (on / n >= 0.4 ? 1 : 0) : cut.mask[at(x, y)];
    }
  }
  // Unknown: inside the piece's outline (between its left and right edge on a row, and its top and bottom in a
  // column) but not in the cut-out. A white cushion on a white backdrop is cut away by colour and leaves such a gap;
  // so does a real opening (between legs). Neither counts for or against a match.
  const u = new Uint8Array(gw * gh);
  const rowL = new Int32Array(gh).fill(gw); const rowR = new Int32Array(gh).fill(-1);
  const colT = new Int32Array(gw).fill(gh); const colB = new Int32Array(gw).fill(-1);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (g[y * gw + x]) { rowL[y] = Math.min(rowL[y], x); rowR[y] = Math.max(rowR[y], x); colT[x] = Math.min(colT[x], y); colB[x] = Math.max(colB[x], y); }
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x;
    if (!g[i] && x > rowL[y] && x < rowR[y] && y > colT[x] && y < colB[x]) u[i] = 1;
  }
  // where the region reaches the photo's edge, the piece may go on beyond it: the frame edge is "cut off"
  const touches = { l: roi.x <= 1, t: roi.y <= 1, r: roi.x + roi.w >= cut.w - 1, b: roi.y + roi.h >= cut.h - 1 };
  return { g, u, gw, gh, k, roi, fullW: cut.w * k, fullH: cut.h * k, offX: roi.x * k, offY: roi.y * k, touches,
    box: bbox(g, gw, gh), area: g.reduce((s2, v) => s2 + v, 0), boxed: !!cut.box };
}

function bbox(g, w, h) {
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1, w: x1 + 1 - x0, h: y1 + 1 - y0, cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2 };
}

// ---------------------------------------------------------------- silhouettes (full-frame camera)
// The model is photographed like the photo was taken: a pinhole camera whose optical axis goes through the centre of
// the WHOLE photo, with a searched field of view. The piece is placed in the picture by turning the camera (the
// look-at point pans) and moving it closer or further, so a piece at the side of a wide-angle room photo keeps the
// perspective it really has there. Comparison happens pixel for pixel on the photo's grid.
const MULT = { sy: true, sz: true, fov: true }; // searched in ratios, not steps

export class Fitter {
  constructor(renderer) {
    this.renderer = renderer;
    this.rt = null;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.scene.add(this.group);
    this.white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false });
    this.normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    this.normalMat.toneMapped = false;
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.05, 200);
  }

  // geometries in cm, z up (the viewer's), and their bounding box
  setModel(items) {
    for (const m of [...this.group.children]) this.group.remove(m);
    this.box = new THREE.Box3();
    this.idMats = [];
    items.forEach((it, k) => {
      const mesh = new THREE.Mesh(it.geometry, this.white);
      mesh.userData.id = k + 1;
      mesh.userData.name = it.name;
      this.group.add(mesh);
      this.box.union(it.geometry.boundingBox);
    });
  }

  target(w, h) {
    if (!this.rt || this.rt.width !== w || this.rt.height !== h) {
      if (this.rt) this.rt.dispose();
      this.rt = new THREE.WebGLRenderTarget(w, h);
      this.buf = new Uint8Array(w * h * 4);
    }
    return this.rt;
  }

  // Places model and camera for parameters p = { az, el, fov, dist, px, py, sy, sz } (world metres, y up).
  pose(p, aspect, view = null) {
    const size = this.box.getSize(new THREE.Vector3());
    const c = this.box.getCenter(new THREE.Vector3());
    this.group.matrix.copy(new THREE.Matrix4().makeScale(0.01, 0.01, 0.01).premultiply(new THREE.Matrix4().copy(Z_UP_TO_Y_UP))
      .multiply(new THREE.Matrix4().makeScale(1, p.sy, p.sz))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -this.box.min.z)));
    this.group.matrixWorldNeedsUpdate = true;
    const T = new THREE.Vector3(0, size.z * p.sz * 0.005, 0);
    const a = THREE.MathUtils.degToRad(p.az);
    const e = THREE.MathUtils.degToRad(p.el);
    // the front of a piece faces -Y in its own coordinates, which is +Z after the z-up -> y-up turn
    const dir = new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a));
    const cam = this.camera;
    cam.fov = p.fov;
    cam.aspect = aspect;
    if (view) cam.setViewOffset(view.fw, view.fh, view.x, view.y, view.w, view.h); else cam.clearViewOffset();
    cam.updateProjectionMatrix();
    cam.position.copy(T).addScaledVector(dir, p.dist);
    cam.up.set(0, 1, 0);
    cam.lookAt(T);
    // pan: the camera turns so the piece sits off the photo's centre, as it does in a real off-centre shot
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    cam.lookAt(T.clone().addScaledVector(right, p.px).addScaledVector(up, p.py));
    cam.updateMatrixWorld();
    return { radius: Math.hypot(size.x, size.y * p.sy, size.z * p.sz) * 0.005 };
  }

  render(p, w, h, material = this.white, view = null) {
    this.pose(p, view ? view.fw / view.fh : w / h, view);
    const rt = this.target(w, h);
    for (const m of this.group.children) m.material = material;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, this.buf);
    this.renderer.setRenderTarget(prev);
    return this.buf;
  }

  // Binary silhouette on the grid at rs render pixels per cell (a cell is set when any of its rs×rs pixels is), and
  // its box in grid cells.
  silhouette(p, grid, rs) {
    const w = grid.gw * rs; const h = grid.gh * rs;
    const view = { fw: grid.fullW * rs, fh: grid.fullH * rs, x: grid.offX * rs, y: grid.offY * rs, w, h };
    const buf = this.render(p, w, h, this.white, view);
    const cnt = new Uint8Array(grid.gw * grid.gh);
    for (let y = 0; y < h; y++) {
      const gy = Math.floor((h - 1 - y) / rs) * grid.gw;
      for (let x = 0; x < w; x++) if (buf[(y * w + x) * 4] > 127) cnt[gy + Math.floor(x / rs)]++;
    }
    // a cell is the model when half its pixels are (any one pixel would fatten every edge by half a cell)
    const need = Math.max(1, Math.ceil(rs * rs / 2));
    const s = new Uint8Array(grid.gw * grid.gh);
    for (let i = 0; i < s.length; i++) s[i] = cnt[i] >= need ? 1 : 0;
    return { s, box: bbox(s, grid.gw, grid.gh) };
  }

  // Distance and pan that put the piece's outline over the cut-out's box, for a camera direction, field of view and
  // proportions; lk/ox/oy then nudge it (a piece cut off by the photo's edge). Pan is a turn of the camera (a real
  // off-centre shot), so distance and pan scale together and the corrections repeat until the boxes meet.
  aligned(p, grid, rs) {
    const key = `${rs}|${p.az.toFixed(2)},${p.el.toFixed(2)},${p.fov.toFixed(2)},${p.sy.toFixed(4)},${p.sz.toFixed(4)}`;
    const t = Math.tan(THREE.MathUtils.degToRad(p.fov) / 2);
    let base = this.alignCache.get(key);
    if (!base) {
      const mb = grid.box;
      const analytic = () => {
        const { radius } = this.pose({ ...p, dist: 1, px: 0, py: 0 }, grid.fullW / grid.fullH);
        const dist = 2 * radius * grid.fullH / (t * (mb.w + mb.h));
        const per0 = 2 * dist * t / grid.fullH;
        return { dist, px: -(grid.offX + mb.cx - grid.fullW / 2) * per0, py: (grid.offY + mb.cy - grid.fullH / 2) * per0 };
      };
      // a neighbouring camera's answer is the best start; across a change of lens it is rescaled to keep the size
      const w = this.warm;
      if (w && w.grid === grid) {
        const k = Math.tan(THREE.MathUtils.degToRad(w.fov) / 2) / t;
        base = { dist: w.dist * k, px: w.px * k, py: w.py * k };
      } else base = analytic();
      const tol = rs === 1 ? 1.5 : 0.6; // loose while searching, tight for the final answer
      let ok = false;
      for (let it = 0; it < (rs === 1 ? 4 : 6); it++) {
        let sil = this.silhouette({ ...p, ...base }, grid, rs);
        if (!sil.box && it === 0) { base = analytic(); sil = this.silhouette({ ...p, ...base }, grid, rs); }
        if (!sil.box) break;
        const off = Math.abs(mb.cx - sil.box.cx) + Math.abs(mb.cy - sil.box.cy) + Math.abs(mb.w + mb.h - sil.box.w - sil.box.h) / 2;
        if (off < tol) { base.sil = sil; ok = true; break; } // this render is also the one to score
        const s = (sil.box.w + sil.box.h) / (mb.w + mb.h);
        base.dist *= s; base.px *= s; base.py *= s; // closer or further: the pan turns by the same angle
        const perPx = 2 * base.dist * t / grid.fullH;
        base.px -= (mb.cx - sil.box.cx) * perPx;
        base.py += (mb.cy - sil.box.cy) * perPx;
      }
      this.alignCache.set(key, base);
      if (this.alignCache.size > 400) this.alignCache.clear();
      if (ok) this.warm = { grid, fov: p.fov, dist: base.dist, px: base.px, py: base.py }; // only a good answer leads
    }
    const e = Math.exp(-(p.lk || 0));
    const dist = base.dist * e;
    const perPx = 2 * dist * t / grid.fullH;
    return { q: { ...p, dist, px: base.px * e - (p.ox || 0) * perPx, py: base.py * e + (p.oy || 0) * perPx }, base };
  }

  // IoU on the grid. Undecided cells count for nothing; outside the user's box is background; beyond the photo's
  // edge nothing is seen. Model reaching past the region's own edge (not the photo's) is charged by how far its box
  // goes beyond, so the search is pulled back however far it spilled.
  score(p, grid, rs = 2) {
    const { q, base } = this.aligned(p, grid, rs);
    const unmoved = !(p.lk || p.ox || p.oy);
    const sil = unmoved && base.sil ? base.sil : this.silhouette(q, grid, rs);
    let inter = 0; let union = 0;
    for (let i = 0; i < grid.gw * grid.gh; i++) {
      if (grid.u[i]) continue;
      const mv = grid.g[i]; const sv = sil.s[i];
      if (mv && sv) inter++;
      if (mv || sv) union++;
    }
    const T = grid.touches || {};
    const b = this.projectedBox(q, grid);
    let over = 0;
    if (b) {
      // only where the silhouette itself reaches the region's edge (an L-shaped piece's empty box corner may cross it)
      const W = grid.gw; const H = grid.gh;
      let l = false; let r = false; let tp = false; let bt = false;
      for (let y = 0; y < H; y++) { if (sil.s[y * W]) l = true; if (sil.s[y * W + W - 1]) r = true; }
      for (let x = 0; x < W; x++) { if (sil.s[x]) tp = true; if (sil.s[(H - 1) * W + x]) bt = true; }
      if (!T.l && l) over += Math.max(0, -b.x0) * (b.y1 - b.y0);
      if (!T.r && r) over += Math.max(0, b.x1 - W) * (b.y1 - b.y0);
      if (!T.t && tp) over += Math.max(0, -b.y0) * (b.x1 - b.x0);
      if (!T.b && bt) over += Math.max(0, b.y1 - H) * (b.x1 - b.x0);
    }
    union += 0.5 * over;
    return { iou: union ? inter / union : 0, pose: q };
  }

  // The model's 3D box projected onto the grid (cells), with the camera as posed for q.
  projectedBox(q, grid) {
    const size = this.box.getSize(new THREE.Vector3());
    this.pose(q, grid.fullW / grid.fullH, { fw: grid.fullW, fh: grid.fullH, x: grid.offX, y: grid.offY, w: grid.gw, h: grid.gh });
    const hx = size.x * 0.005; const hz = size.y * q.sy * 0.005; const hy = size.z * q.sz * 0.01;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    const v = new THREE.Vector3();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const yy of [0, hy]) {
      v.set(sx * hx, yy, sz * hz).project(this.camera);
      if (v.z > 1) return null; // behind the camera
      const gx = (v.x + 1) / 2 * grid.gw; const gy = (1 - v.y) / 2 * grid.gh;
      x0 = Math.min(x0, gx); x1 = Math.max(x1, gx); y0 = Math.min(y0, gy); y1 = Math.max(y1, gy);
    }
    return { x0, y0, x1, y1 };
  }

  // Search camera, field of view, proportions and placement. limits: { sy: [lo, hi], sz: [lo, hi] } (factors on the
  // model's current depth and height); locked: 'sy'/'sz' that must stay 1 (sizes the user gave); start: to refine.
  fit(cut, { limits, locked = {}, start = null } = {}) {
    const grid = toGrid(cut);
    if (!grid.box || grid.area < 40) return null;
    this.alignCache = new Map();
    this.warm = null;
    const b = grid.box;
    const edge = 2;
    const T = grid.touches;
    // a piece cut off by the photo's edge: its box is not its size, so placement is searched more widely
    const cropped = (T.l && b.x0 <= edge) || (T.t && b.y0 <= edge) || (T.r && b.x1 >= grid.gw - edge) || (T.b && b.y1 >= grid.gh - edge);
    let evals = 0;
    // the type's standard proportions are real furniture: a size moves away from them only when the photo clearly
    // says so (camera angle and depth/height trade off in a single view); a lens far from normal likewise
    const prior = (q) => 0.3 * (Math.log(q.sy) ** 2 + Math.log(q.sz) ** 2) + 0.01 * Math.log(q.fov / 40) ** 2;
    const span = cropped ? 0.5 * Math.max(grid.gw, grid.gh) : 0.12 * Math.max(b.w, b.h);
    const clampP = (q) => ({
      az: Math.max(-105, Math.min(105, q.az)), el: Math.max(-5, Math.min(60, q.el)), fov: Math.max(10, Math.min(75, q.fov)),
      sy: locked.sy ? 1 : Math.max(limits.sy[0], Math.min(limits.sy[1], q.sy)),
      sz: locked.sz ? 1 : Math.max(limits.sz[0], Math.min(limits.sz[1], q.sz)),
      lk: Math.max(cropped ? -0.3 : -0.25, Math.min(cropped ? 1.2 : 0.25, q.lk || 0)),
      ox: Math.max(-span, Math.min(span, q.ox || 0)), oy: Math.max(-span, Math.min(span, q.oy || 0)),
    });
    const descend = (best0, bestV0, rs, keys, step, budget) => {
      let best = best0; let bestV = bestV0;
      const f = (q) => { evals++; return this.score(q, grid, rs).iou - prior(q); };
      for (let round = 0; round < 6; round++) {
        let moved = true;
        let sweeps = 0;
        while (moved && sweeps++ < 3 && evals < budget) {
          moved = false;
          for (const key of keys) {
            if (locked[key]) continue;
            for (const dir of [1, -1]) {
              const q = clampP({ ...best, [key]: MULT[key] ? best[key] * Math.exp(dir * step[key]) : best[key] + dir * step[key] });
              const v = f(q);
              if (v > bestV + 1e-4) { bestV = v; best = q; moved = true; break; } // the other direction goes back
            }
          }
        }
        for (const key of keys) step[key] /= 2;
      }
      return [best, bestV];
    };
    const f1 = (q) => { evals++; return this.score(q, grid, 1).iou - prior(q); };
    let best; let bestV;
    if (start) {
      best = clampP({ lk: 0, ox: 0, oy: 0, fov: 40, ...start });
      bestV = f1(best);
    } else {
      const scored = [];
      for (const az of [-90, -60, -35, -15, 0, 15, 35, 60, 90]) for (const el of [6, 18, 32]) { const q = clampP({ az, el, fov: 40, sy: 1, sz: 1 }); scored.push([f1(q), q]); }
      scored.sort((a, c) => c[0] - a[0]);
      [bestV, best] = scored[0];
      // the other lenses, from the best directions that are really different (25° apart)
      const peaks = [];
      for (const s of scored) { if (peaks.every((pk) => Math.abs(pk[1].az - s[1].az) >= 25)) peaks.push(s); if (peaks.length === 3) break; }
      for (const [, q0] of peaks) for (const fov of [24, 60, 70]) { const q = clampP({ ...q0, fov }); const v = f1(q); if (v > bestV) { bestV = v; best = q; } }
      if (cropped) {
        const dx = (T.r && b.x1 >= grid.gw - edge ? 1 : 0) - (T.l && b.x0 <= edge ? 1 : 0);
        const dy = (T.b && b.y1 >= grid.gh - edge ? 1 : 0) - (T.t && b.y0 <= edge ? 1 : 0);
        for (const lk of [0.3, 0.6]) { const q = clampP({ ...best, lk, ox: dx * 0.25 * b.w * lk, oy: dy * 0.25 * b.h * lk }); const v = f1(q); if (v > bestV) { bestV = v; best = q; } }
      }
    }
    // the placement nudges matter only for a piece the photo cuts off; otherwise every try reuses its placement render,
    // and the full-resolution polish below sets the last half cell
    const keys = cropped ? ['az', 'el', 'fov', 'sy', 'sz', 'lk', 'ox', 'oy'] : ['az', 'el', 'fov', 'sy', 'sz'];
    [best, bestV] = descend(best, bestV, 1, keys,
      { az: start ? 6 : 10, el: start ? 4 : 7, fov: 0.2, sy: 0.16, sz: 0.12, lk: 0.12, ox: Math.max(2, b.w * 0.06), oy: Math.max(2, b.h * 0.06) },
      start ? 140 : 320);
    // the coarse render placed the piece within 1.5 cells: a short polish of the placement at full resolution
    this.warm = null;
    const v2 = this.score(best, grid, 2).iou - prior(best);
    [best] = descend(best, v2, 2, ['lk', 'ox', 'oy'], { lk: 0.03, ox: 0.8, oy: 0.8 }, evals + 24);
    const sc = this.score(best, grid, 2);
    return { ...best, iou: sc.iou, evals, cropped, pose: sc.pose };
  }

  // How much the match changes when depth or height move by ±20% at the fitted camera (re-placed each time): near
  // zero means this view cannot tell that size (the user should check it). -> { sy: change, sz: change }
  sensitivity(cut, p) {
    const grid = toGrid(cut);
    this.alignCache = new Map();
    this.warm = null;
    const base = this.score(p, grid, 2).iou;
    const out = {};
    for (const key of ['sy', 'sz']) {
      const lo = this.score({ ...p, [key]: p[key] * 0.8 }, grid, 2).iou;
      const hi = this.score({ ...p, [key]: p[key] * 1.2 }, grid, 2).iou;
      // the larger of the two changes: the fit sits on the slope the proportion prior leaves, so an average of both
      // sides would cancel exactly the change that shows the size is seen
      out[key] = Math.max(Math.abs(base - lo), Math.abs(base - hi));
    }
    // depth and height together against the width: near zero in a side view, where the width runs along the line of sight
    const lo = this.score({ ...p, sy: p.sy * 0.8, sz: p.sz * 0.8 }, grid, 2).iou;
    const hi = this.score({ ...p, sy: p.sy * 1.2, sz: p.sz * 1.2 }, grid, 2).iou;
    out.sx = Math.max(Math.abs(base - lo), Math.abs(base - hi));
    return out;
  }

  // The photo with the fitted outline drawn over it (a canvas the size of the photo canvas).
  compare(photoCanvas, cut, p) {
    const W = photoCanvas.width; const H = photoCanvas.height;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    ctx.drawImage(photoCanvas, 0, 0);
    const pose = p.pose || this.aligned(p, toGrid(cut), 2).q;
    const buf = this.render(pose, W, H);
    const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H && buf[((H - 1 - y) * W + x) * 4] > 127;
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const a = inside(x, y);
        const edge = a !== inside(x + 1, y) || a !== inside(x, y + 1) || a !== inside(x - 1, y) || a !== inside(x, y - 1);
        if (edge) { d[i] = 255; d[i + 1] = 90; d[i + 2] = 40; } else if (a) { d[i] = d[i] * 0.55 + 46 * 0.45; d[i + 1] = d[i + 1] * 0.55 + 106 * 0.45; d[i + 2] = d[i + 2] * 0.55 + 110 * 0.45; }
      }
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }

  // Each part's own colour from the photo, measured where the fitted model shows that part: the part's pixels are
  // shrunk by 2 px (edges are where the fit is least sure), kept only inside the cut-out and where the surface faces
  // the camera; highlights are dropped and the 70th-percentile lightness with the median hue is taken, so shadow and
  // glare do not darken or wash out the colour. -> { partName: [r, g, b] } (parts with < 30 good pixels are left out)
  partColours(photoCanvas, cut, p) {
    const W = photoCanvas.width; const H = photoCanvas.height;
    const pose = p.pose || this.aligned(p, toGrid(cut), 2).q;
    // part ids: a flat colour per part
    const idMats = this.group.children.map((m) => new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB((m.userData.id & 255) / 255, 0, 0, THREE.LinearSRGBColorSpace), side: THREE.DoubleSide, toneMapped: false }));
    this.pose(pose, W / H);
    const rt = this.target(W, H);
    this.group.children.forEach((m, k) => { m.material = idMats[k]; });
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, this.camera);
    const ids = new Uint8Array(W * H * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, W, H, ids);
    for (const m of this.group.children) m.material = this.normalMat;
    this.renderer.render(this.scene, this.camera);
    const nrm = new Uint8Array(W * H * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, W, H, nrm);
    this.renderer.setRenderTarget(prev);
    for (const m of idMats) m.dispose();
    for (const m of this.group.children) m.material = this.white;
    const idAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : ids[((H - 1 - y) * W + x) * 4]);
    const px = photoCanvas.getContext('2d').getImageData(0, 0, W, H).data;
    const ks = cut.w / W;
    // how far inside a part a pixel must be: 1 % of the piece's smaller side on screen (at least 1 px, at most 4)
    let minX = W; let minY = H; let maxX = 0; let maxY = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (idAt(x, y)) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const er = Math.max(1, Math.min(4, Math.round(0.01 * Math.min(maxX - minX, maxY - minY))));
    const collect = (minFacing, erode) => {
      const out = new Map();
      for (let y = erode; y < H - erode; y++) {
        for (let x = erode; x < W - erode; x++) {
          const id = idAt(x, y);
          if (!id) continue;
          let same = true;
          for (let dy = -erode; dy <= erode && same; dy++) for (let dx = -erode; dx <= erode; dx++) if (idAt(x + dx, y + dy) !== id) { same = false; break; }
          if (!same) continue;
          const ci = Math.min(cut.h - 1, Math.floor(y * ks)) * cut.w + Math.min(cut.w - 1, Math.floor(x * ks));
          if (!cut.mask[ci]) continue;
          const nz = nrm[((H - 1 - y) * W + x) * 4 + 2] / 255 * 2 - 1; // view-space normal: +z faces the camera
          if (nz < minFacing) continue;
          const i = (y * W + x) * 4;
          let list = out.get(id);
          if (!list) { list = []; out.set(id, list); }
          list.push(toLab(px[i], px[i + 1], px[i + 2]));
        }
      }
      return out;
    };
    const strict = collect(0.15, er);
    const loose = collect(0.0, 1); // thin or steep parts (legs, a table top seen low) get a second, looser look
    const out = {};
    for (const m of this.group.children) {
      const id = m.userData.id & 255;
      let list = strict.get(id);
      if (!list || list.length < 30) list = loose.get(id);
      if (!list || list.length < 30) continue;
      list.sort((a, b) => a[0] - b[0]);
      const kept = list.slice(0, Math.max(1, Math.floor(list.length * 0.95))); // highlights out
      // the 70th percentile lightness reads a lit fabric's own colour; a dark material (black metal, walnut) keeps
      // its median, or its sheen would turn it grey
      const p70 = kept[Math.floor(kept.length * 0.7)][0];
      const p50 = kept[Math.floor(kept.length * 0.5)][0];
      const L = p50 < 25 ? p50 + (p70 - p50) * Math.max(0, (p50 - 10) / 15) : p70;
      const med = (k) => { const v = kept.map((c) => c[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
      out[m.userData.name] = fromLab(L, med(1), med(2));
    }
    return out;
  }

  dispose() { if (this.rt) this.rt.dispose(); this.white.dispose(); this.normalMat.dispose(); }
}

// sRGB (0..255) <-> CIE Lab (D65): photo pixels and SketchUp colours are both sRGB, so the conversion is exact both ways
function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function linearToSrgb(c) { const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; return Math.round(Math.max(0, Math.min(1, v)) * 255); }
const WX = 0.95047; const WZ = 1.08883;
function labF(t) { return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116; }
function labFi(t) { return t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27); }
export function toLab(r8, g8, b8) {
  const r = srgbToLinear(r8); const g = srgbToLinear(g8); const b = srgbToLinear(b8);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / WX;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / WZ;
  const fx = labF(X); const fy = labF(Y); const fz = labF(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function fromLab(L, a, bb) {
  let lo = 0; let hi = 1;
  if (!inGamut(L, a, bb)) {
    for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (inGamut(L, a * mid, bb * mid)) lo = mid; else hi = mid; }
    a *= lo; bb *= lo;
  }
  return labToSrgb(L, a, bb);
}
function labLinear(L, a, bb) {
  const fy = (L + 16) / 116; const fx = fy + a / 500; const fz = fy - bb / 200;
  const X = labFi(fx) * WX; const Y = labFi(fy); const Z = labFi(fz) * WZ;
  return [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.2040 * Y + 1.0570 * Z];
}
function inGamut(L, a, bb) { return labLinear(L, a, bb).every((c) => c >= -1e-4 && c <= 1 + 1e-4); }
function labToSrgb(L, a, bb) {
  const fy = (L + 16) / 116; const fx = fy + a / 500; const fz = fy - bb / 200;
  const X = labFi(fx) * WX; const Y = labFi(fy); const Z = labFi(fz) * WZ;
  const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
}
export { toGrid }; // for the tests
