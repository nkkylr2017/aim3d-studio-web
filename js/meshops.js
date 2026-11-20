// Mesh operations on plain arrays (pos: Float32Array of x,y,z in cm; tris: Uint32Array of vertex indices), pure and
// node-testable. A geometry from the viewer is split at creases and UV seams, so operations that need neighbours
// first weld it (fromGeometry). The cleanup steps follow the AIM 3D Studio extension's mesh_cleanup.rb.

// ---- conversion
export function fromGeometry(g, eps = 1e-3) {
  const p = g.attributes.position.array;
  const n = p.length / 3;
  const idx = g.index ? g.index.array : Uint32Array.from({ length: n }, (_, i) => i);
  return weld(new Float32Array(p), new Uint32Array(idx), eps);
}

// vertices closer than eps become one; triangles that collapse are dropped
export function weld(pos, tris, eps = 1e-3) {
  const map = new Map();
  const remap = new Uint32Array(pos.length / 3);
  const out = [];
  const inv = 1 / eps;
  for (let i = 0; i < pos.length / 3; i++) {
    const key = `${Math.round(pos[3 * i] * inv)},${Math.round(pos[3 * i + 1] * inv)},${Math.round(pos[3 * i + 2] * inv)}`;
    let k = map.get(key);
    if (k === undefined) { k = out.length / 3; map.set(key, k); out.push(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]); }
    remap[i] = k;
  }
  const t = [];
  for (let i = 0; i < tris.length; i += 3) {
    const a = remap[tris[i]]; const b = remap[tris[i + 1]]; const c = remap[tris[i + 2]];
    if (a !== b && b !== c && a !== c) t.push(a, b, c);
  }
  return { pos: new Float32Array(out), tris: new Uint32Array(t) };
}

// keeps only the vertices the triangles use
export function compact(pos, tris) {
  const remap = new Int32Array(pos.length / 3).fill(-1);
  const out = [];
  const t = new Uint32Array(tris.length);
  for (let i = 0; i < tris.length; i++) {
    const v = tris[i];
    if (remap[v] < 0) { remap[v] = out.length / 3; out.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]); }
    t[i] = remap[v];
  }
  return { pos: new Float32Array(out), tris: t };
}

function pick(pos, tris, keepTri) {
  const t = [];
  for (let i = 0; i < tris.length / 3; i++) if (keepTri[i]) t.push(tris[3 * i], tris[3 * i + 1], tris[3 * i + 2]);
  return compact(pos, new Uint32Array(t));
}

export function bbox(pos) {
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

// ---- connected pieces
export function components(pos, tris) {
  const n = pos.length / 3;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < tris.length; i += 3) {
    const a = find(tris[i]); const b = find(tris[i + 1]); const c = find(tris[i + 2]);
    if (a !== b) parent[a] = b;
    const b2 = find(b);
    if (find(c) !== b2) parent[find(c)] = b2;
  }
  const groups = new Map();
  for (let i = 0; i < tris.length / 3; i++) {
    const r = find(tris[3 * i]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

// one mesh per connected piece (largest first); pieces under minTris triangles are not lost: they go together into
// one last mesh
export function splitPieces(pos, tris, minTris = 1) {
  const comps = components(pos, tris);
  const big = comps.filter((c) => c.length >= minTris);
  const small = comps.filter((c) => c.length < minTris).flat();
  const make = (c) => {
    const t = new Uint32Array(c.length * 3);
    c.forEach((ti, k) => { t[3 * k] = tris[3 * ti]; t[3 * k + 1] = tris[3 * ti + 1]; t[3 * k + 2] = tris[3 * ti + 2]; });
    return compact(pos, t);
  };
  const out = big.map(make);
  if (small.length) out.push(make(small));
  return out;
}

// ---- cleanup of AI meshes
// small floating fragments: pieces smaller than a twentieth of the model, unless they hold a tenth of its triangles
// (a leg or a handle is bigger than that; a crumb of noise is not)
export function removeFragments(pos, tris, minSize = 0.05, share = 0.1) {
  const total = tris.length / 3;
  const size = Math.max(...bbox(pos).size);
  const keep = new Uint8Array(total);
  for (const c of components(pos, tris)) {
    let ok = c.length >= share * total;
    if (!ok) {
      const t = new Uint32Array(c.flatMap((ti) => [tris[3 * ti], tris[3 * ti + 1], tris[3 * ti + 2]]));
      ok = Math.max(...bbox(compact(pos, t).pos).size) > size * minSize;
    }
    if (ok) for (const ti of c) keep[ti] = 1;
  }
  return pick(pos, tris, keep);
}

function quantile(values, q) {
  const a = Float32Array.from(values).sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))];
}

// spikes and stray points: triangles touching a vertex well outside the box that holds 99.6 % of the vertices
export function removeSpikes(pos, tris) {
  const n = pos.length / 3;
  if (n < 50) return { pos, tris };
  const lo = []; const hi = [];
  for (let k = 0; k < 3; k++) {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = pos[3 * i + k];
    const a = quantile(v, 0.002); const b = quantile(v, 0.998);
    const m = (b - a) * 0.1;
    lo.push(a - m); hi.push(b + m);
  }
  const bad = new Uint8Array(n);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) if (pos[3 * i + k] < lo[k] || pos[3 * i + k] > hi[k]) bad[i] = 1;
  const keep = new Uint8Array(tris.length / 3);
  for (let i = 0; i < keep.length; i++) keep[i] = bad[tris[3 * i]] || bad[tris[3 * i + 1]] || bad[tris[3 * i + 2]] ? 0 : 1;
  return pick(pos, tris, keep);
}

// a ground sheet grown from the photo's shadow: flat triangles in the bottom layer outside the footprint of what
// stands above it. The footprint is the upper triangles' projection on a grid (filled, grown by two cells so leg ends
// are kept); a bottom that does not reach beyond it (a box's own floor) is left alone.
function cover(occ, G, cell, ax, ay, bx, by, cx2, cy2) {
  // the grid cells under one projected triangle (by sampling it at about half a cell)
  const [i0, j0] = cell(Math.min(ax, bx, cx2), Math.min(ay, by, cy2));
  const [i1, j1] = cell(Math.max(ax, bx, cx2), Math.max(ay, by, cy2));
  const n = Math.max(1, 2 * Math.max(i1 - i0, j1 - j0) + 1);
  for (let u = 0; u <= n; u++) for (let v = 0; v <= n - u; v++) {
    const s = u / n; const t = v / n;
    const [i, j] = cell(ax + s * (bx - ax) + t * (cx2 - ax), ay + s * (by - ay) + t * (cy2 - ay));
    occ[j * G + i] = 1;
  }
}
export function removeGroundSheet(pos, tris, layer = 0.03) {
  const { min, size } = bbox(pos);
  if (size[2] <= 0) return { pos, tris };
  const G = 64;
  const cell = (x, y) => [Math.max(0, Math.min(G - 1, Math.floor((x - min[0]) / (size[0] || 1) * G))), Math.max(0, Math.min(G - 1, Math.floor((y - min[1]) / (size[1] || 1) * G)))];
  const occ = new Uint8Array(G * G);
  const zLow = min[2] + layer * size[2];
  const zUp = min[2] + 2.5 * layer * size[2];
  for (let i = 0; i < tris.length; i += 3) {
    const a = 3 * tris[i]; const b = 3 * tris[i + 1]; const c = 3 * tris[i + 2];
    if (Math.max(pos[a + 2], pos[b + 2], pos[c + 2]) <= zUp) continue;
    cover(occ, G, cell, pos[a], pos[a + 1], pos[b], pos[b + 1], pos[c], pos[c + 1]);
  }
  for (let pass = 0; pass < 2; pass++) {
    const grown = occ.slice();
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) if (occ[y * G + x]) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx; const Y = y + dy; if (X >= 0 && Y >= 0 && X < G && Y < G) grown[Y * G + X] = 1; }
    occ.set(grown);
  }
  const keep = new Uint8Array(tris.length / 3).fill(1);
  let dropped = 0;
  for (let i = 0; i < keep.length; i++) {
    const a = 3 * tris[3 * i]; const b = 3 * tris[3 * i + 1]; const c = 3 * tris[3 * i + 2];
    if (Math.max(pos[a + 2], pos[b + 2], pos[c + 2]) > zLow) continue;
    const [cx, cy] = cell((pos[a] + pos[b] + pos[c]) / 3, (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3);
    if (!occ[cy * G + cx]) { keep[i] = 0; dropped++; }
  }
  return dropped ? pick(pos, tris, keep) : { pos, tris };
}

// sheet: also remove a ground sheet (only on the user's request: a wide thin base looks the same to this test)
export function cleanup(pos, tris, { sheet = false } = {}) {
  let m = removeSpikes(pos, tris);
  if (sheet) m = removeGroundSheet(m.pos, m.tris);
  m = removeFragments(m.pos, m.tris);
  return m;
}

// ---- smoothing that does not shrink: Taubin's λ/μ passes over the welded mesh's neighbours
export function taubin(pos, tris, passes = 6, lambda = 0.5, mu = -0.53) {
  const n = pos.length / 3;
  const nb = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i]; const b = tris[i + 1]; const c = tris[i + 2];
    nb[a].add(b); nb[a].add(c); nb[b].add(a); nb[b].add(c); nb[c].add(a); nb[c].add(b);
  }
  // border vertices stay where they are (an open cut must not shrink)
  const edgeCount = new Map();
  for (let i = 0; i < tris.length; i += 3) for (const [u, v] of [[tris[i], tris[i + 1]], [tris[i + 1], tris[i + 2]], [tris[i + 2], tris[i]]]) {
    const k = u < v ? `${u},${v}` : `${v},${u}`;
    edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
  }
  const border = new Uint8Array(n);
  for (const [k, c] of edgeCount) if (c === 1) { const [u, v] = k.split(',').map(Number); border[u] = 1; border[v] = 1; }
  let p = Float32Array.from(pos);
  const step = (f) => {
    const q = Float32Array.from(p);
    for (let i = 0; i < n; i++) {
      if (border[i] || !nb[i].size) continue;
      let x = 0; let y = 0; let z = 0;
      for (const j of nb[i]) { x += p[3 * j]; y += p[3 * j + 1]; z += p[3 * j + 2]; }
      const k = 1 / nb[i].size;
      q[3 * i] += f * (x * k - p[3 * i]); q[3 * i + 1] += f * (y * k - p[3 * i + 1]); q[3 * i + 2] += f * (z * k - p[3 * i + 2]);
    }
    p = q;
  };
  for (let s = 0; s < passes; s++) { step(lambda); step(mu); }
  return { pos: p, tris };
}

// ---- simplify by vertex clustering: the coarsest grid that keeps at most target triangles
export function simplify(pos, tris, target) {
  if (tris.length / 3 <= target) return { pos, tris };
  const { min, size } = bbox(pos);
  const big = Math.max(...size) || 1;
  const cluster = (res) => {
    const cs = big / res;
    const map = new Map(); const sum = []; const cnt = [];
    const remap = new Uint32Array(pos.length / 3);
    for (let i = 0; i < pos.length / 3; i++) {
      const key = `${Math.floor((pos[3 * i] - min[0]) / cs)},${Math.floor((pos[3 * i + 1] - min[1]) / cs)},${Math.floor((pos[3 * i + 2] - min[2]) / cs)}`;
      let k = map.get(key);
      if (k === undefined) { k = cnt.length; map.set(key, k); sum.push(0, 0, 0); cnt.push(0); }
      sum[3 * k] += pos[3 * i]; sum[3 * k + 1] += pos[3 * i + 1]; sum[3 * k + 2] += pos[3 * i + 2]; cnt[k]++;
      remap[i] = k;
    }
    const out = new Float32Array(sum.length);
    for (let k = 0; k < cnt.length; k++) { out[3 * k] = sum[3 * k] / cnt[k]; out[3 * k + 1] = sum[3 * k + 1] / cnt[k]; out[3 * k + 2] = sum[3 * k + 2] / cnt[k]; }
    const seen = new Set(); const t = [];
    for (let i = 0; i < tris.length; i += 3) {
      const a = remap[tris[i]]; const b = remap[tris[i + 1]]; const c = remap[tris[i + 2]];
      if (a === b || b === c || a === c) continue;
      const key = [a, b, c].sort((u, v) => u - v).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      t.push(a, b, c);
    }
    return compact(out, new Uint32Array(t));
  };
  let lo = 4; let hi = 2048; let best = cluster(lo);
  while (hi - lo > 2) {
    const mid = Math.round((lo + hi) / 2);
    const m = cluster(mid);
    if (m.tris.length / 3 <= target) { best = m; lo = mid; } else hi = mid;
  }
  return best;
}

// ---- cutting
// by the plane n·x = d (n a unit vector): triangles crossing it are split exactly, so both sides end flat on it.
// -> { above, below } (above: n·x >= d)
export function cutPlane(pos, tris, n, d) {
  const out = Array.from(pos);
  const dist = (i) => n[0] * out[3 * i] + n[1] * out[3 * i + 1] + n[2] * out[3 * i + 2] - d;
  const cache = new Map();
  const mid = (a, b) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let k = cache.get(key);
    if (k !== undefined) return k;
    const da = dist(a); const db = dist(b);
    const s = da / (da - db);
    k = out.length / 3;
    out.push(out[3 * a] + s * (out[3 * b] - out[3 * a]), out[3 * a + 1] + s * (out[3 * b + 1] - out[3 * a + 1]), out[3 * a + 2] + s * (out[3 * b + 2] - out[3 * a + 2]));
    cache.set(key, k);
    return k;
  };
  const A = []; const B = [];
  const eps = 1e-6;
  for (let i = 0; i < tris.length; i += 3) {
    const v = [tris[i], tris[i + 1], tris[i + 2]];
    const s = v.map((x) => { const q = dist(x); return q > eps ? 1 : q < -eps ? -1 : 0; });
    if (s.every((x) => x >= 0)) { A.push(...v); continue; }
    if (s.every((x) => x <= 0)) { B.push(...v); continue; }
    // rotate so that v[0] is the lone vertex on its side (or the one on the plane when one vertex lies on it)
    let r = 0;
    for (let k = 0; k < 3; k++) {
      const others = [s[(k + 1) % 3], s[(k + 2) % 3]];
      if (s[k] !== 0 && others.every((o) => o !== s[k])) { r = k; break; }
    }
    const a = v[r]; const b = v[(r + 1) % 3]; const c = v[(r + 2) % 3];
    const sa = s[r]; const sb = s[(r + 1) % 3]; const sc = s[(r + 2) % 3];
    const lone = sa > 0 ? A : B; const rest = sa > 0 ? B : A;
    if (sb === 0) { const m = mid(a, c); lone.push(a, b, m); rest.push(b, c, m); continue; }
    if (sc === 0) { const m = mid(a, b); lone.push(a, m, c); rest.push(m, b, c); continue; }
    const mab = mid(a, b); const mac = mid(a, c);
    lone.push(a, mab, mac);
    rest.push(mab, b, c, mab, c, mac);
  }
  const P = new Float32Array(out);
  return { above: compact(P, new Uint32Array(A)), below: compact(P, new Uint32Array(B)) };
}

// by a closed outline drawn on the screen: project(x, y, z) -> [sx, sy] (screen pixels) for a point of this mesh;
// eye: the camera position in the mesh's frame (front-facing test), or null to take everything under the outline.
// Triangles whose centre falls inside go to "inside". -> { inside, outside }
export function lassoSplit(pos, tris, polygon, project, eye = null) {
  const inPoly = (x, y) => {
    let c = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i]; const [xj, yj] = polygon[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const keep = new Uint8Array(tris.length / 3);
  for (let i = 0; i < keep.length; i++) {
    const a = 3 * tris[3 * i]; const b = 3 * tris[3 * i + 1]; const c = 3 * tris[3 * i + 2];
    const cx = (pos[a] + pos[b] + pos[c]) / 3; const cy = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3; const cz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
    if (eye) {
      const ux = pos[b] - pos[a]; const uy = pos[b + 1] - pos[a + 1]; const uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a]; const vy = pos[c + 1] - pos[a + 1]; const vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx;
      if (nx * (eye[0] - cx) + ny * (eye[1] - cy) + nz * (eye[2] - cz) <= 0) continue; // faces away
    }
    const [sx, sy] = project(cx, cy, cz);
    if (inPoly(sx, sy)) keep[i] = 1;
  }
  const inside = pick(pos, tris, keep);
  const outside = pick(pos, tris, keep.map((k) => 1 - k));
  return { inside, outside };
}
