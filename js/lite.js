// The local draft ("AIM Lite"): a closed 3D shape from the photo's cut-out and its relative depth, made on this
// computer with no GPU time and no quota (port of the AIM 3D Studio extension's ui/lite_engine.js):
//   1. the cut-out on a grid fitted to the piece (largest piece kept, small holes filled, corner-only touches fixed)
//   2. depth (Depth Anything V2, relative, larger = nearer) moves the mid-surface towards or away from the camera
//   3. the hidden back: "inflation" — thickness grows with the distance to the outline (round near the edge, flatter
//      inside), the back mirrors the front
//   4. a closed mesh: front and back grids joined by a wall along the outline
// Rough by nature (a 2.5D shell), labelled as a draft. Pure functions, node-testable.

function sample(f, w, h, x, y) {
  x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y));
  const x0 = x | 0; const y0 = y | 0; const x1 = Math.min(w - 1, x0 + 1); const y1 = Math.min(h - 1, y0 + 1); const fx = x - x0; const fy = y - y0;
  return (f[y0 * w + x0] * (1 - fx) + f[y0 * w + x1] * fx) * (1 - fy) + (f[y1 * w + x0] * (1 - fx) + f[y1 * w + x1] * fx) * fy;
}

export function largestComponent(M, w, h) {
  const lab = new Int32Array(w * h); const stack = new Int32Array(w * h); let best = 0; let bestSize = 0; let next = 0;
  for (let s = 0; s < w * h; s++) {
    if (!M[s] || lab[s]) continue;
    next++; let top = 0; let size = 0; stack[top++] = s; lab[s] = next;
    while (top) {
      const p = stack[--top]; size++; const x = p % w; const y = (p / w) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) if (q >= 0 && M[q] && !lab[q]) { lab[q] = next; stack[top++] = q; }
    }
    if (size > bestSize) { bestSize = size; best = next; }
  }
  for (let i = 0; i < w * h; i++) M[i] = lab[i] === best ? 1 : 0;
  return bestSize;
}

// small holes (segmentation noise) are filled; real openings (a handle, a chair back) are kept
export function fillHoles(M, w, h) {
  const out = new Uint8Array(w * h); const stack = [];
  const push = (p) => { if (!M[p] && !out[p]) { out[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop(); const x = p % w; const y = (p / w) | 0;
    if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (y > 0) push(p - w); if (y < h - 1) push(p + w);
  }
  let area = 0; for (let i = 0; i < w * h; i++) area += M[i];
  const seen = new Uint8Array(w * h); const limit = Math.max(4, area * 0.012);
  for (let s = 0; s < w * h; s++) {
    if (M[s] || out[s] || seen[s]) continue;
    const hole = [s]; seen[s] = 1;
    for (let k = 0; k < hole.length; k++) {
      const p = hole[k]; const x = p % w; const y = (p / w) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) if (q >= 0 && !M[q] && !out[q] && !seen[q]) { seen[q] = 1; hole.push(q); }
    }
    if (hole.length < limit) for (const p of hole) M[p] = 1;
  }
}

// pixels touching only at a corner would make a non-manifold junction: the gap is filled
export function fixDiagonals(M, w, h) {
  for (let pass = 0; pass < 4; pass++) {
    let changed = 0;
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const a = y * w + x; const b = a + 1; const c = a + w; const d = c + 1;
      if (M[a] && M[d] && !M[b] && !M[c]) { M[b] = 1; changed++; } else if (M[b] && M[c] && !M[a] && !M[d]) { M[a] = 1; changed++; }
    }
    if (!changed) break;
  }
}

function inpaint(F, M, before, w, h) {
  const todo = []; for (let i = 0; i < w * h; i++) if (M[i] && !before[i]) todo.push(i);
  const known = before.slice();
  for (let it = 0; it < 40 && todo.length; it++) {
    for (let k = todo.length - 1; k >= 0; k--) {
      const p = todo[k]; const x = p % w; const y = (p / w) | 0; let s = 0; let n = 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) if (q >= 0 && known[q]) { s += F[q]; n++; }
      if (n) { F[p] = s / n; known[p] = 1; todo.splice(k, 1); }
    }
  }
}

// two-pass chamfer (3-4) distance to the nearest outside pixel
function distance(M, w, h) {
  const D = new Float32Array(w * h); const BIG = 1e9;
  for (let i = 0; i < w * h; i++) D[i] = M[i] ? BIG : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!D[i]) continue;
    let d = D[i];
    d = x > 0 ? Math.min(d, D[i - 1] + 3) : Math.min(d, 3);
    if (y > 0) { d = Math.min(d, D[i - w] + 3); if (x > 0) d = Math.min(d, D[i - w - 1] + 4); if (x < w - 1) d = Math.min(d, D[i - w + 1] + 4); } else d = Math.min(d, 3);
    D[i] = d;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!D[i]) continue;
    let d = D[i];
    d = x < w - 1 ? Math.min(d, D[i + 1] + 3) : Math.min(d, 3);
    if (y < h - 1) { d = Math.min(d, D[i + w] + 3); if (x < w - 1) d = Math.min(d, D[i + w + 1] + 4); if (x > 0) d = Math.min(d, D[i + w - 1] + 4); } else d = Math.min(d, 3);
    D[i] = d;
  }
  for (let i = 0; i < w * h; i++) D[i] /= 3;
  return D;
}

function blurMasked(F, M, w, h, passes) {
  let a = F; let b = new Float32Array(w * h);
  for (let k = 0; k < passes; k++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!M[i]) { b[i] = a[i]; continue; }
      let s = 0; let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx; const yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx; if (M[j]) { s += a[j]; n++; }
      }
      b[i] = s / n;
    }
    [a, b] = [b, a];
  }
  return a;
}

// front and back grids from the fields (R relief 0..1, H inflation 0..1), joined along the outline; y up, z towards
// the camera, units of the grid's longer side
export function buildMesh(M, R, H, w, h, { thickness, relief, mean }) {
  const W = w + 1; const Hn = h + 1; const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && M[y * w + x];
  const used = new Uint8Array(W * Hn); const boundary = new Uint8Array(W * Hn);
  for (let y = 0; y < Hn; y++) for (let x = 0; x < W; x++) {
    const c = inside(x - 1, y - 1) + inside(x, y - 1) + inside(x - 1, y) + inside(x, y);
    if (c) used[y * W + x] = 1;
    if (c && c < 4) boundary[y * W + x] = 1;
  }
  const nodeVal = (F, x, y) => {
    let s = 0; let n = 0;
    for (const [cx, cy] of [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]]) if (inside(cx, cy)) { s += F[cy * w + cx]; n++; }
    return n ? s / n : 0;
  };
  // the staircase outline is smoothed along itself
  const px = new Float32Array(W * Hn); const py = new Float32Array(W * Hn);
  for (let i = 0; i < W * Hn; i++) { px[i] = i % W; py[i] = (i / W) | 0; }
  for (let it = 0; it < 6; it++) {
    const nx = px.slice(); const ny = py.slice();
    for (let y = 0; y < Hn; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!boundary[i]) continue;
      let sx = 0; let sy = 0; let n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx; const yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= Hn) continue;
        const j = yy * W + xx; if (boundary[j]) { sx += px[j]; sy += py[j]; n++; }
      }
      if (n >= 2) { nx[i] = Math.max(x - 0.2, Math.min(x + 0.2, 0.5 * px[i] + 0.5 * sx / n)); ny[i] = Math.max(y - 0.2, Math.min(y + 0.2, 0.5 * py[i] + 0.5 * sy / n)); }
    }
    px.set(nx); py.set(ny);
  }
  const span = Math.max(w, h);
  const thick = thickness * span;
  const rel = relief * span;
  const pos = []; const front = new Int32Array(W * Hn).fill(-1); const back = new Int32Array(W * Hn).fill(-1);
  for (let y = 0; y < Hn; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!used[i]) continue;
    const hv = boundary[i] ? 0 : Math.max(0, nodeVal(H, x, y)); const t = Math.max(Math.min(thick * 0.05, 0.25), hv * thick);
    const c = (nodeVal(R, x, y) - mean) * rel * Math.min(1, hv * 2.5);
    const X = (px[i] - w / 2) / span; const Y = (h - py[i]) / span;
    front[i] = pos.length / 3; pos.push(X, Y, (c + t / 2) / span);
    if (t > 0) { back[i] = pos.length / 3; pos.push(X, Y, (c - t / 2) / span); } else back[i] = front[i];
  }
  const idx = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inside(x, y)) continue;
    const a = y * W + x; const b = a + 1; const c = a + W; const d = c + 1;
    idx.push(front[a], front[c], front[b], back[a], back[b], back[c]);
    idx.push(front[b], front[c], front[d], back[b], back[d], back[c]);
    const wall = (u, v) => idx.push(front[u], front[v], back[v], front[u], back[v], back[u]);
    if (!inside(x, y - 1)) wall(a, b);
    if (!inside(x + 1, y)) wall(b, d);
    if (!inside(x, y + 1)) wall(d, c);
    if (!inside(x - 1, y)) wall(c, a);
  }
  const tri = [];
  for (let k = 0; k < idx.length; k += 3) { const p = idx[k]; const q = idx[k + 1]; const s = idx[k + 2]; if (p !== q && q !== s && p !== s) tri.push(p, q, s); }
  return { positions: new Float32Array(pos), indices: new Uint32Array(tri) };
}

// mask: Uint8Array (1 = the piece) mw x mh over the whole photo; depth: Float32Array dw x dh over the whole photo
// (larger = nearer). -> { pos (cm, z up, front towards -y, on the floor, centred, 100 cm high), tris, size }
export function liteMesh({ mask, mw, mh, depth, dw, dh, grid = 160, thickness = 0.55 }) {
  let bx0 = mw; let by0 = mh; let bx1 = -1; let by1 = -1;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (mask[y * mw + x] === 1) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
  if (bx1 < 0) throw new Error('no piece in the cut-out');
  const pad = Math.round(0.03 * Math.max(bx1 - bx0, by1 - by0));
  bx0 = Math.max(0, bx0 - pad); by0 = Math.max(0, by0 - pad); bx1 = Math.min(mw - 1, bx1 + pad); by1 = Math.min(mh - 1, by1 + pad);
  const bw = bx1 - bx0 + 1; const bh = by1 - by0 + 1; const k = grid / Math.max(bw, bh);
  const w = Math.max(8, Math.round(bw * k)); const h = Math.max(8, Math.round(bh * k));
  const M = new Uint8Array(w * h); const R = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = bx0 + (x + 0.5) / k; const sy = by0 + (y + 0.5) / k;
    M[y * w + x] = mask[Math.min(mh - 1, Math.floor(sy)) * mw + Math.min(mw - 1, Math.floor(sx))] === 1 ? 1 : 0;
    R[y * w + x] = sample(depth, dw, dh, sx * dw / mw, sy * dh / mh);
  }
  if (largestComponent(M, w, h) < 30) throw new Error('the piece is too small in the photo');
  const before = M.slice();
  fillHoles(M, w, h);
  fixDiagonals(M, w, h);
  inpaint(R, M, before, w, h);
  const vals = []; for (let i = 0; i < w * h; i++) if (M[i]) vals.push(R[i]);
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.02)]; const hi = vals[Math.floor(vals.length * 0.98)] || lo + 1;
  for (let i = 0; i < w * h; i++) R[i] = M[i] ? Math.max(0, Math.min(1, (R[i] - lo) / (hi - lo || 1))) : 0;
  const Rs = blurMasked(R, M, w, h, 2);
  const D = distance(M, w, h); let dmax = 0; for (let i = 0; i < w * h; i++) dmax = Math.max(dmax, D[i]);
  const Hf = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) if (M[i]) { const u = Math.min(1, D[i] / (dmax * 0.6)); Hf[i] = Math.sqrt(Math.max(0, 1 - (1 - u) * (1 - u))); }
  const Hs = blurMasked(Hf, M, w, h, 1);
  let mean = 0; let cnt = 0; for (let i = 0; i < w * h; i++) if (M[i]) { mean += Rs[i]; cnt++; }
  const { positions: P, indices } = buildMesh(M, Rs, Hs, w, h, { thickness, relief: thickness * 0.6, mean: cnt ? mean / cnt : 0.5 });
  // y up, z towards the camera -> z up, front towards -y (the site's frame), standing on the floor, 100 cm high
  const pos = new Float32Array(P.length);
  let lo3 = [Infinity, Infinity, Infinity]; let hi3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    pos[i] = P[i]; pos[i + 1] = -P[i + 2]; pos[i + 2] = P[i + 1];
    for (let j = 0; j < 3; j++) { lo3[j] = Math.min(lo3[j], pos[i + j]); hi3[j] = Math.max(hi3[j], pos[i + j]); }
  }
  const s = 100 / Math.max(1e-6, hi3[2] - lo3[2]);
  const cx = (lo3[0] + hi3[0]) / 2; const cy = (lo3[1] + hi3[1]) / 2;
  for (let i = 0; i < pos.length; i += 3) { pos[i] = (pos[i] - cx) * s; pos[i + 1] = (pos[i + 1] - cy) * s; pos[i + 2] = (pos[i + 2] - lo3[2]) * s; }
  return { pos, tris: indices, size: [(hi3[0] - lo3[0]) * s, (hi3[1] - lo3[1]) * s, 100] };
}
