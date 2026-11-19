// Fitting the parametric model to the photo (analysis by synthesis): the piece is cut out of the photo, the model is
// rendered as a silhouette from a camera and with its depth and height scaled, and both are searched until the
// rendered outline covers the cut-out as closely as possible. The width is the reference (a photo has no scale);
// the user's one known measurement sets the real size. Also draws the comparison image (photo + fitted outline).
import * as THREE from 'three';
import { Z_UP_TO_Y_UP } from './mesh.js';

const GRID = 128; // the mask is compared on this grid (its longer side)
const RT = 224; // silhouette render size

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
function toGrid(cut) {
  const k = GRID / Math.max(cut.w, cut.h);
  const gw = Math.max(8, Math.round(cut.w * k));
  const gh = Math.max(8, Math.round(cut.h * k));
  const g = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const sx = Math.min(cut.w - 1, Math.floor((x + 0.5) / k));
      const sy = Math.min(cut.h - 1, Math.floor((y + 0.5) / k));
      g[y * gw + x] = cut.mask[sy * cut.w + sx];
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
  return { g, u, gw, gh, box: bbox(g, gw, gh), area: g.reduce((s, v) => s + v, 0) };
}

function bbox(g, w, h) {
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1, w: x1 + 1 - x0, h: y1 + 1 - y0, cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2 };
}

// ---------------------------------------------------------------- silhouettes
export class Fitter {
  constructor(renderer) {
    this.renderer = renderer;
    this.rt = new THREE.WebGLRenderTarget(RT, RT);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.scene.add(this.group);
    this.white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);
    this.buf = new Uint8Array(RT * RT * 4);
  }

  // geometries in cm, z up (the viewer's), and their bounding box
  setModel(items) {
    for (const m of [...this.group.children]) this.group.remove(m);
    this.box = new THREE.Box3();
    for (const it of items) { this.group.add(new THREE.Mesh(it.geometry, this.white)); this.box.union(it.geometry.boundingBox); }
  }

  // The silhouette for a camera (azimuth/elevation in degrees, 0 = straight from the front) with depth and height
  // scaled by sy, sz. Returns a binary RT×RT image (row 0 at the top) and its box.
  silhouette(az, el, sy, sz) {
    const size = this.box.getSize(new THREE.Vector3());
    const c = this.box.getCenter(new THREE.Vector3());
    const m = new THREE.Matrix4().makeScale(0.01, 0.01, 0.01).premultiply(new THREE.Matrix4().copy(Z_UP_TO_Y_UP))
      .multiply(new THREE.Matrix4().makeScale(1, sy, sz))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -this.box.min.z));
    this.group.matrix.copy(m);
    this.group.matrixWorldNeedsUpdate = true;
    const r = Math.hypot(size.x, size.y * sy, size.z * sz) * 0.005;
    const target = new THREE.Vector3(0, size.z * sz * 0.005, 0);
    const a = THREE.MathUtils.degToRad(az);
    const e = THREE.MathUtils.degToRad(el);
    const dist = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 1.05;
    // the front of a piece faces -Y in its own coordinates, which is +Z after the z-up -> y-up turn
    this.camera.position.set(target.x + dist * Math.cos(e) * Math.sin(a), target.y + dist * Math.sin(e), target.z + dist * Math.cos(e) * Math.cos(a));
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.readRenderTargetPixels(this.rt, 0, 0, RT, RT, this.buf);
    this.renderer.setRenderTarget(prev);
    const s = new Uint8Array(RT * RT);
    for (let y = 0; y < RT; y++) for (let x = 0; x < RT; x++) s[(RT - 1 - y) * RT + x] = this.buf[(y * RT + x) * 4] > 127 ? 1 : 0;
    return { s, box: bbox(s, RT, RT) };
  }

  // Where the silhouette lands on the mask grid: its box centre goes to the mask box centre moved by (ox, oy), at
  // k grid pixels per render pixel (k0 lines the boxes up, lk scales from there).
  place(sil, grid, a) {
    const sb = sil.box; const mb = grid.box;
    const k = (mb.w + mb.h) / (sb.w + sb.h) * Math.exp(a.lk || 0);
    return { k, cx: mb.cx + (a.ox || 0), cy: mb.cy + (a.oy || 0), sb };
  }

  // How well a placed silhouette covers the mask (IoU). Pixels the cut-out left undecided, and everything outside
  // the photo's frame (a cropped photo cuts the piece off), count for nothing either way.
  score(sil, grid, a = {}) {
    if (!sil.box || !grid.box) return { iou: 0 };
    const { k, cx, cy, sb } = this.place(sil, grid, a);
    let inter = 0; let union = 0;
    const x0 = Math.max(0, Math.floor(Math.min(grid.box.x0, cx - sb.w * k / 2)));
    const x1 = Math.min(grid.gw, Math.ceil(Math.max(grid.box.x1, cx + sb.w * k / 2)));
    const y0 = Math.max(0, Math.floor(Math.min(grid.box.y0, cy - sb.h * k / 2)));
    const y1 = Math.min(grid.gh, Math.ceil(Math.max(grid.box.y1, cy + sb.h * k / 2)));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * grid.gw + x;
        if (grid.u[i]) continue;
        const mv = grid.g[i];
        const rx = Math.floor(sb.cx + (x + 0.5 - cx) / k);
        const ry = Math.floor(sb.cy + (y + 0.5 - cy) / k);
        const sv = rx >= 0 && ry >= 0 && rx < RT && ry < RT ? sil.s[ry * RT + rx] : 0;
        if (mv && sv) inter++;
        if (mv || sv) union++;
      }
    }
    return { iou: union ? inter / union : 0, k };
  }

  // Search camera, proportions and placement. limits: { sy: [lo, hi], sz: [lo, hi] } (factors on the model's
  // current depth and height); locked: 'sy'/'sz' that must stay 1 (sizes the user gave); start: a result to refine.
  fit(cut, { limits, locked = {}, start = null } = {}) {
    const grid = toGrid(cut);
    if (!grid.box || grid.area < 40) return null;
    const b = grid.box;
    // a piece cut off by the frame: its box is not its size, so the placement is searched more widely
    const edge = 2; // a cut-out model often stops a pixel or two short of the frame
    const cropped = b.x0 <= edge || b.y0 <= edge || b.x1 >= grid.gw - edge || b.y1 >= grid.gh - edge;
    let evals = 0;
    const sils = new Map(); // a silhouette only depends on the camera and proportions, not on the placement
    const silOf = (p) => {
      const key = `${p.az.toFixed(3)},${p.el.toFixed(3)},${p.sy.toFixed(4)},${p.sz.toFixed(4)}`;
      let v = sils.get(key);
      if (!v) { v = this.silhouette(p.az, p.el, p.sy, p.sz); sils.set(key, v); evals++; if (sils.size > 300) sils.clear(); }
      return v;
    };
    // the type's standard proportions are real furniture: a size moves away from them only when the photo clearly
    // says so (camera angle and depth/height trade off against each other in a single view)
    const prior = (q) => 0.3 * (Math.log(q.sy) ** 2 + Math.log(q.sz) ** 2);
    const f = (q) => this.score(silOf(q), grid, q).iou - prior(q);
    const span = cropped ? 0.5 * Math.max(grid.gw, grid.gh) : 0.12 * Math.max(b.w, b.h);
    const clampP = (q) => ({
      az: Math.max(-85, Math.min(85, q.az)), el: Math.max(-5, Math.min(55, q.el)),
      sy: locked.sy ? 1 : Math.max(limits.sy[0], Math.min(limits.sy[1], q.sy)),
      sz: locked.sz ? 1 : Math.max(limits.sz[0], Math.min(limits.sz[1], q.sz)),
      lk: Math.max(cropped ? -0.3 : -0.25, Math.min(cropped ? 1.2 : 0.25, q.lk || 0)),
      ox: Math.max(-span, Math.min(span, q.ox || 0)), oy: Math.max(-span, Math.min(span, q.oy || 0)),
    });
    let best = null; let bestV = -1;
    const starts = [];
    if (start) starts.push({ lk: 0, ox: 0, oy: 0, ...start });
    else {
      for (const az of [-60, -38, -18, 0, 18, 38, 60]) for (const el of [6, 18, 32]) starts.push({ az, el, sy: 1, sz: 1, lk: 0, ox: 0, oy: 0 });
      if (cropped) {
        // bigger than what shows, pushed off the frame on the sides where it is cut
        const dx = (b.x1 >= grid.gw - edge ? 1 : 0) - (b.x0 <= edge ? 1 : 0);
        const dy = (b.y1 >= grid.gh - edge ? 1 : 0) - (b.y0 <= edge ? 1 : 0);
        for (const az of [-45, -25, 0, 25, 45]) for (const el of [12, 25, 38]) for (const lk of [0.3, 0.6]) {
          starts.push({ az, el, sy: 1, sz: 1, lk, ox: dx * 0.25 * b.w * lk, oy: dy * 0.25 * b.h * lk });
        }
      }
    }
    for (const s0 of starts) { const q = clampP(s0); const v = f(q); if (v > bestV) { bestV = v; best = q; } }
    const keys = ['az', 'el', 'sy', 'sz', 'lk', 'ox', 'oy'];
    const mult = { sy: true, sz: true };
    let step = { az: start ? 6 : 12, el: start ? 4 : 8, sy: 0.16, sz: 0.12, lk: 0.12, ox: Math.max(2, b.w * 0.06), oy: Math.max(2, b.h * 0.06) };
    for (let round = 0; round < 6; round++) {
      let moved = true;
      let guard = 0;
      while (moved && evals < 450 && guard++ < 40) {
        moved = false;
        for (const key of keys) {
          if (locked[key]) continue;
          for (const dir of [1, -1]) {
            const q = clampP({ ...best, [key]: mult[key] ? best[key] * Math.exp(dir * step[key]) : best[key] + dir * step[key] });
            const v = f(q);
            if (v > bestV + 1e-4) { bestV = v; best = q; moved = true; }
          }
        }
      }
      for (const key of keys) step[key] /= 2;
    }
    return { ...best, iou: this.score(silOf(best), grid, best).iou, evals, cropped };
  }

  // The photo with the fitted outline drawn over it (an RGBA canvas the size of the photo canvas).
  compare(photoCanvas, cut, p) {
    const grid = toGrid(cut);
    const sil = this.silhouette(p.az, p.el, p.sy, p.sz);
    const W = photoCanvas.width; const H = photoCanvas.height;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    ctx.drawImage(photoCanvas, 0, 0);
    if (!sil.box || !grid.box) return out;
    const g2p = W / grid.gw; // grid -> photo pixels
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const { k, cx, cy, sb } = this.place(sil, grid, p);
    const inside = (x, y) => {
      const gx = x / g2p; const gy = y / g2p;
      const rx = Math.floor(sb.cx + (gx - cx) / k); const ry = Math.floor(sb.cy + (gy - cy) / k);
      return rx >= 0 && ry >= 0 && rx < RT && ry < RT && sil.s[ry * RT + rx] === 1;
    };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const a = inside(x, y);
        const edge = a !== inside(x + 1.5, y) || a !== inside(x, y + 1.5);
        if (edge) { d[i] = 255; d[i + 1] = 90; d[i + 2] = 40; } else if (a) { d[i] = d[i] * 0.55 + 46 * 0.45; d[i + 1] = d[i + 1] * 0.55 + 106 * 0.45; d[i + 2] = d[i + 2] * 0.55 + 110 * 0.45; }
      }
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }

  dispose() { this.rt.dispose(); this.white.dispose(); }
}
