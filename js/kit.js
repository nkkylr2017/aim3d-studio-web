// Port of src/aim3d_studio/smart_kit.rb (AIM 3D Studio 2.12.3). Kept line for line close to the Ruby so the
// parity test (test/parity) can compare both builds point by point; when one changes, change the other.
// Units cm, z up. Ruby idioms kept exact: Float#round (rround), % (rmod), <=> 0 (sgn), integer division (Math.floor).

import { RubyRandom, crc32, rround, rmod, sgn } from './rng.js';

const PI = Math.PI;
const { sin, cos, sqrt, abs, exp, atan2, floor, ceil, min, max, hypot } = Math;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const odd = (n) => rmod(n, 2) === 1;

// ---------------------------------------------------------------- math
export const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  unit(a) {
    const l = sqrt(V.dot(a, a));
    return l < 1e-9 ? [0.0, 0.0, 1.0] : V.mul(a, 1.0 / l);
  },
  rot(v, k, ang) {
    const c = cos(ang);
    return V.add(V.add(V.mul(v, c), V.mul(V.cross(k, v), sin(ang))), V.mul(k, V.dot(k, v) * (1 - c)));
  },
};

export function smooth(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3 - 2 * t);
}

export class Frame {
  constructor(o, u = [1.0, 0.0, 0.0], v = [0.0, 1.0, 0.0], w = null) {
    this.o = o.map(Number);
    this.u = V.unit(u);
    this.v = V.unit(v);
    this.w = w ? V.unit(w) : V.cross(this.u, this.v);
  }

  at(p) {
    const { o, u, v, w } = this;
    return [o[0] + u[0] * p[0] + v[0] * p[1] + w[0] * p[2],
      o[1] + u[1] * p[0] + v[1] * p[1] + w[1] * p[2],
      o[2] + u[2] * p[0] + v[2] * p[1] + w[2] * p[2]];
  }

  turned(axis, deg) {
    const a = deg * PI / 180;
    const k = V.unit(axis);
    return new Frame(this.o, V.rot(this.u, k, a), V.rot(this.v, k, a), V.rot(this.w, k, a));
  }
}

// ---------------------------------------------------------------- noise
export class Noise {
  constructor(seed) {
    const rnd = new RubyRandom(seed);
    const perm = rnd.shuffle(Array.from({ length: 256 }, (_, i) => i));
    this.perm = perm.concat(perm);
    const angles = Array.from({ length: 256 }, () => rnd.rand() * 2 * PI);
    this.gx = angles.map((a) => cos(a));
    this.gy = angles.map((a) => sin(a));
  }

  at(x, y) {
    const xf = floor(x);
    const yf = floor(y);
    const fx = x - xf;
    const fy = y - yf;
    const xi = xf & 255;
    const yi = yf & 255;
    const p = this.perm;
    const a = p[xi] + yi;
    const b = p[xi + 1] + yi;
    const h00 = p[a];
    const h01 = p[a + 1];
    const h10 = p[b];
    const h11 = p[b + 1];
    const gx = this.gx;
    const gy = this.gy;
    const n00 = gx[h00] * fx + gy[h00] * fy;
    const n10 = gx[h10] * (fx - 1) + gy[h10] * fy;
    const n01 = gx[h01] * fx + gy[h01] * (fy - 1);
    const n11 = gx[h11] * (fx - 1) + gy[h11] * (fy - 1);
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const x0 = n00 + u * (n10 - n00);
    const x1 = n01 + u * (n11 - n01);
    return (x0 + v * (x1 - x0)) * 1.4;
  }

  fbm(x, y, octaves = 3) {
    let sum = 0.0;
    let amp = 1.0;
    let norm = 0.0;
    let f = 1.0;
    for (let k = 0; k < octaves; k++) {
      sum += amp * this.at(x * f + 17.3 * norm, y * f);
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  }

  ridged(x, y, octaves = 3) {
    let sum = 0.0;
    let amp = 1.0;
    let norm = 0.0;
    let f = 1.0;
    for (let k = 0; k < octaves; k++) {
      const r = 1.0 - abs(this.at(x * f, y * f + 31.7 * norm));
      sum += amp * r * r;
      norm += amp;
      amp *= 0.5;
      f *= 2.1;
    }
    return sum / norm;
  }
}

// ---------------------------------------------------------------- mesh buffer
// Points closer than 0.2 mm share one vertex (same key as the Ruby MeshBuf); zero-area triangles are skipped.
export class MeshBuf {
  constructor() {
    this.pos = [];
    this.tris = [];
    this.idx = new Map();
    this.count = 0;
  }

  pt(p) {
    const key = `${rround(p[0] * 50)},${rround(p[1] * 50)},${rround(p[2] * 50)}`;
    let i = this.idx.get(key);
    if (i === undefined) {
      i = this.pos.length / 3;
      this.pos.push(p[0], p[1], p[2]);
      this.idx.set(key, i);
    }
    return i;
  }

  tri(a, b, c) {
    if (a === b || b === c || a === c) return;
    this.tris.push(a, b, c);
    this.count += 1;
  }

  quad(a, b, c, d) {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }
}

// ---------------------------------------------------------------- kit
export class Kit {
  constructor({ seed, detail = 1.0 }) {
    this.seed = seed;
    this.noise = new Noise(seed);
    this.rnd = new RubyRandom(seed);
    this.detail = detail;
    this.triangles = 0;
    this.variation = {};
    this.sims = null;
    this.parts = []; // { name, role, thin, pos, tris }
  }

  rand(lo, hi) {
    return lo + (hi - lo) * this.rnd.rand();
  }

  step(cm) {
    return cm * this.detail;
  }

  part(label, role, fn) {
    // a part keeps the same wrinkles whether built alone or in a full build
    this.rnd = new RubyRandom(Math.trunc(Number(this.seed)) + crc32(String(label)));
    const buf = new MeshBuf();
    this.thin = false;
    fn(buf);
    this.triangles += buf.count;
    if (buf.count > 0) this.parts.push({ name: label, role: role || null, thin: this.thin, pos: buf.pos, tris: buf.tris });
    return buf;
  }

  // ---- cushion (see the Ruby for the meaning of every option)
  cushion(buf, frame, a, b, t, { corner = 4.0, rim = 'round', bulge = 0.0, back = 0.0, pattern = null, bend = null, grid = 3.0,
    piping = null, piping_r = 0.6 } = {}) {
    let r = rim === 'round' ? t / 2.0 : min(Number(rim), t / 2.0);
    r = max(r, 0.05);
    const ai = max(a - r, 0.5);
    const bi = max(b - r, 0.5);
    const rc = min(max(corner - r, 0.0), ai, bi);
    const st = this.step(grid);
    const nu = max(ceil(2 * ai / st), 3);
    const nv = max(ceil(2 * bi / st), 3);
    const lam = max(min(ai, bi) * 0.45, 1.5);
    const pat = this.patternFn(pattern, ai, bi);
    const rise = (x, y) => 1 - (1 - min(inside(x, y, ai, bi, rc) / lam, 1.0)) ** 2;
    const place = (x, y, w) => {
      if (bend && abs(x) > bend[0]) {
        const th = (abs(x) - bend[0]) / bend[1];
        const rr = bend[1] - w;
        return frame.at([sgn(x) * (bend[0] + rr * sin(th)), y, bend[1] - rr * cos(th)]);
      }
      return frame.at([x, y, w]);
    };
    const xy = [];
    const f = [];
    const bk = [];
    for (let i = 0; i <= nu; i++) {
      const s = -1.0 + 2.0 * i / nu;
      xy.push([]); f.push([]); bk.push([]);
      for (let j = 0; j <= nv; j++) {
        const [x, y] = roundMap(s, -1.0 + 2.0 * j / nv, ai, bi, rc);
        xy[i][j] = [x, y];
        const k = rise(x, y);
        f[i][j] = buf.pt(place(x, y, t / 2.0 + k * (bulge - pat(x, y))));
        bk[i][j] = buf.pt(place(x, y, -t / 2.0 - k * back));
      }
    }
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        buf.quad(f[i][j], f[i + 1][j], f[i + 1][j + 1], f[i][j + 1]);
        buf.quad(bk[i][j], bk[i][j + 1], bk[i + 1][j + 1], bk[i + 1][j]);
      }
    }
    const prof = this.rimProfile(rim, r, t);
    const loopIJ = [];
    for (let i = 0; i < nu; i++) loopIJ.push([i, 0]);
    for (let j = 0; j < nv; j++) loopIJ.push([nu, j]);
    for (let i = nu; i >= 1; i--) loopIJ.push([i, nv]);
    for (let j = nv; j >= 1; j--) loopIJ.push([0, j]);
    const rings = loopIJ.map(([i, j]) => {
      const [x, y] = xy[i][j];
      const n = outlineNormal(x, y, ai, bi, rc);
      return prof.map(([o, w]) => buf.pt(place(x + n[0] * o, y + n[1] * o, w)));
    });
    rings.forEach((ra, k) => {
      const rb = rings[(k + 1) % rings.length];
      for (let p = 0; p < prof.length - 1; p++) buf.quad(ra[p], ra[p + 1], rb[p + 1], rb[p]);
    });
    if (!(piping && this.detail <= 1.2)) return;

    const round = rim === 'round' || r >= t / 2.0 - 0.01;
    for (const deg of piping) {
      const ph = deg * PI / 180;
      const centre = round ? 0.0 : (ph > 0 ? t / 2.0 - r : -t / 2.0 + r);
      const o = (r + piping_r * 0.4) * cos(ph);
      const w = centre + (r + piping_r * 0.4) * sin(ph);
      const pts = outlinePoints(ai + o, bi + o, rc + o, this.step(1.5)).map(([x, y]) => place(x, y, w));
      this.tube(buf, pts, piping_r, { seg: 6, closed: true });
    }
  }

  rimProfile(rim, r, t) {
    if (rim === 'round' || r >= t / 2.0 - 0.01) {
      return Array.from({ length: 9 }, (_, k) => { const a = PI / 2 - PI * k / 8; return [r * cos(a), r * sin(a)]; });
    }
    const top = Array.from({ length: 5 }, (_, k) => { const a = PI / 2 * (1 - k / 4.0); return [r * cos(a), t / 2.0 - r + r * sin(a)]; });
    const bottom = Array.from({ length: 5 }, (_, k) => { const a = -PI / 2 * k / 4.0; return [r * cos(a), -t / 2.0 + r + r * sin(a)]; });
    return top.concat(bottom);
  }

  patternFn(pattern, ai, bi) {
    if (!pattern) return () => 0.0;
    switch (pattern[0]) {
      case 'channels':
      case 'rows': {
        const vertical = pattern[0] === 'channels';
        const half = vertical ? ai : bi;
        const n = max(rround(2 * half / pattern[1]), 1);
        const pc = 2 * half / n;
        const depth = pattern[2];
        return (x, y) => {
          const c = rmod(((vertical ? x : y) + half) / pc, 1.0);
          return depth * (1 - sin(PI * c) ** 0.4);
        };
      }
      case 'tufts': {
        const nu = max(rround(2 * ai / pattern[1]), 2);
        const nv = max(rround(2 * bi / pattern[2]), 2);
        const pu = 2 * ai / nu;
        const pv = 2 * bi / nv;
        const depth = pattern[3];
        const sig2 = (0.24 * min(pu, pv)) ** 2;
        return (x, y) => {
          const row = rround((y + bi) / pv);
          let best = 1e9;
          for (let rw = row - 1; rw <= row + 1; rw++) {
            if (rw <= 0 || rw >= nv) continue;
            const off = odd(rw) ? pu / 2.0 : 0.0;
            const col = rround((x + ai - off) / pu);
            for (let cl = col - 1; cl <= col + 1; cl++) {
              const bx = -ai + off + cl * pu;
              if (bx < -ai + pu * 0.4 || bx > ai - pu * 0.4) continue;
              const d2 = (x - bx) ** 2 + (y - (-bi + rw * pv)) ** 2;
              if (d2 < best) best = d2;
            }
          }
          return depth * exp(-best / sig2);
        };
      }
      case 'inset': {
        const margin = pattern[1];
        const depth = pattern[2];
        const bevel = max(depth * 1.4, 0.6);
        return (x, y) => depth * clamp((min(ai - margin - abs(x), bi - margin - abs(y)) + bevel) / bevel, 0.0, 1.0);
      }
      default:
        return () => 0.0;
    }
  }

  // ---- pillow
  pillow(buf, frame, w, h, t, { n = 22, pinch = 0.09, puff = 0.45, crease = 0.35, seam = 0.45, sim = null } = {}) {
    if (sim) return this.pillowFromSim(buf, frame, sim);

    const seed = this.rand(0, 500);
    const top = [];
    const bot = [];
    const edge = new Map();
    for (let i = 0; i <= n; i++) {
      const s = -1.0 + 2.0 * i / n;
      top.push([]); bot.push([]);
      for (let j = 0; j <= n; j++) {
        const q = -1.0 + 2.0 * j / n;
        const x = w / 2.0 * s * (1 - pinch * (1 - q * q));
        const y = h / 2.0 * q * (1 - pinch * (1 - s * s));
        const prof = ((1 - abs(s) ** 2.4) * (1 - abs(q) ** 2.4)) ** puff;
        const dz = t / 2.0 * prof;
        const wr = crease * this.noise.fbm(seed + x / 11.0, y / 11.0, 2) * (0.35 + (1 - prof));
        top[i][j] = buf.pt(frame.at([x, y, dz + wr]));
        bot[i][j] = buf.pt(frame.at([x, y, -dz + wr]));
        if (i === 0 || j === 0 || i === n || j === n) edge.set(`${i},${j}`, frame.at([x, y, wr]));
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        buf.quad(top[i][j], top[i + 1][j], top[i + 1][j + 1], top[i][j + 1]);
        buf.quad(bot[i][j], bot[i][j + 1], bot[i + 1][j + 1], bot[i + 1][j]);
      }
    }
    if (!(seam && this.detail <= 1.2)) return;
    const ring = [];
    for (let i = 0; i < n; i++) ring.push(edge.get(`${i},0`));
    for (let j = 0; j < n; j++) ring.push(edge.get(`${n},${j}`));
    for (let i = n; i >= 1; i--) ring.push(edge.get(`${i},${n}`));
    for (let j = n; j >= 1; j--) ring.push(edge.get(`0,${j}`));
    this.tube(buf, ring, seam, { seg: 5, closed: true });
  }

  pillowFromSim(buf, frame, sim, { piping = null } = {}) {
    this.thin = true;
    const nx = Math.trunc(sim.nx);
    const ny = Math.trunc(sim.ny);
    const count = (nx + 1) * (ny + 1) * 3;
    const rows = Math.trunc(sim.rows || 0);
    const f = rows === 0 && this.detail < 1.0 ? 2 : 1;
    const [front, mx, my] = upsample(sim.pts.slice(0, count), nx, ny, f);
    const [back] = upsample(sim.pts.slice(count, 2 * count), nx, ny, f);
    const ft = front.map((col) => col.map((p) => buf.pt(frame.at(p))));
    const bk = back.map((col) => col.map((p) => buf.pt(frame.at(p))));
    for (let i = 0; i < mx; i++) {
      for (let j = 0; j < my; j++) {
        buf.quad(ft[i][j], ft[i + 1][j], ft[i + 1][j + 1], ft[i][j + 1]);
        buf.quad(bk[i][j], bk[i][j + 1], bk[i + 1][j + 1], bk[i + 1][j]);
      }
    }
    if (!(rows > 0)) return;

    const ring = [];
    for (let i = 0; i < nx; i++) ring.push([i, 0]);
    for (let j = 0; j < ny; j++) ring.push([nx, j]);
    for (let i = nx; i >= 1; i--) ring.push([i, ny]);
    for (let j = ny; j >= 1; j--) ring.push([0, j]);
    const n = ring.length;
    const pts = sim.pts;
    const at = (m, k) => {
      const [i, j] = ring[m % n];
      if (k === 0) return ft[i][j];
      if (k === rows) return bk[i][j];
      const o = 2 * count + ((m % n) * (rows - 1) + k - 1) * 3;
      return buf.pt(frame.at([pts[o], pts[o + 1], pts[o + 2]]));
    };
    for (let m = 0; m < n; m++) {
      for (let k = 0; k < rows; k++) buf.quad(at(m, k), at(m, k + 1), at(m + 1, k + 1), at(m + 1, k));
    }
    if (!(piping && this.detail <= 1.2)) return;
    this.tube(buf, ring.map(([i, j]) => frame.at(front[i][j])), piping, { seg: 5, closed: true });
    this.tube(buf, ring.map(([i, j]) => frame.at(back[i][j])), piping, { seg: 5, closed: true });
  }

  // ---- cloth
  cloth(buf, { size, centre, sup, stand, turn = 0.0, floor: floorZ = 0.6, grid = 3.0, thick = 3.0, thick_hang = null,
    crease = 1.0, crease_size = 20.0, waves = 0.0, fold = 3.0, fold_size = 14.0, flare = 3.0, roll = null, warp = 0.0,
    knit = null, edge_puff = 0.0, pleats = null, hem = null, sim = null, disc = false, sy_int = false }) {
    this.thin = true;
    const [sx, sy] = sim && sim.sx ? [Number(sim.sx), Number(sim.sy)] : size;
    // a size given as a Ruby Integer divides as integers by the grid count (only the runner's length)
    const syi = sy_int && !(sim && sim.sx);
    const sydiv = (a, b) => (syi ? floor(a / b) : a / b);
    const st = this.step(grid);
    let nx = max(ceil(sx / st), 4);
    let ny = max(ceil(sy / st), 4);
    const stitches = !!(knit && sim && this.detail <= 1.0);
    let mid = null;
    if (sim) {
      let f = clamp(rround(sx / Number(sim.nx) / st + 0.3), 1, 3);
      if (stitches) f = clamp(max(ceil(sx / Number(sim.nx) / (knit[0] / 5.0)), f), 1, 4);
      [mid, nx, ny] = upsample(sim.pts, Math.trunc(sim.nx), Math.trunc(sim.ny), f);
    }
    const ang = turn * PI / 180;
    const ca = cos(ang);
    const sa = sin(ang);
    const hx = sup.hx;
    const hy = sup.hy;
    const scy = sup.cy || 0.0;
    const top = sup.top;
    const rc = sup.r ? min(Number(sup.r), hx, hy) : min(6.0, hx, hy);
    const arc = PI / 2 * stand;
    if (thick_hang == null) thick_hang = thick;
    const nz = this.noise;
    const hw = Array.from({ length: nx + 1 }, () => new Array(ny + 1));
    const pleat = (ls, lt) => {
      const pa = pleats[0] * PI / 180;
      const u = (ls * cos(pa) + lt * sin(pa)) / pleats[1] + 0.6 * nz.fbm(ls / 60.0 + 7, lt / 60.0, 2);
      return pleats[2] * smooth(sy * 0.35, -sy * 0.25, lt) * (0.5 - 0.5 * cos(2 * PI * u)) ** 1.6;
    };
    if (sim) {
      for (let i = 0; i <= nx; i++) {
        const ls = sx * (i / nx - 0.5);
        for (let j = 0; j <= ny; j++) {
          const lt = sy * (j / ny - 0.5);
          const [x, y, z] = mid[i][j];
          const w = smooth(0, stand, top - z);
          let cz = crease * 0.6 * (nz.ridged(ls / crease_size, lt / (crease_size * 2.2), 3) - 0.42);
          if (pleats) cz += 0.35 * pleat(ls, lt);
          mid[i][j] = [x, y, z + cz * (1 - w)];
          hw[i][j] = w;
        }
      }
    }
    if (!mid) mid = Array.from({ length: nx + 1 }, () => new Array(ny + 1));
    for (let i = 0; i <= nx; i++) {
      if (sim) break;
      const ls = sx * (i / nx - 0.5);
      for (let j = 0; j <= ny; j++) {
        const lt = sy * (j / ny - 0.5);
        const [cs, ct] = disc ? toDisc(ls, lt, sx / 2, sy / 2) : [ls, lt];
        let px = centre[0] + ca * cs - sa * ct;
        let py = centre[1] + sa * cs + ca * ct;
        if (warp > 0) {
          px += warp * nz.fbm(ls / 70.0 + 3.7, lt / 70.0, 2);
          py += warp * nz.fbm(ls / 70.0, lt / 70.0 + 8.3, 2);
        }
        const qx = abs(px) - (hx - rc);
        const qy = abs(py - scy) - (hy - rc);
        const e = sqrt(max(qx, 0.0) ** 2 + max(qy, 0.0) ** 2) + min(max(qx, qy), 0.0) - rc;
        let cz = crease * (nz.ridged(ls / crease_size, lt / (crease_size * 2.2), 3) - 0.42);
        cz += waves * nz.fbm(ls / 55.0 + 40, lt / 55.0, 2);
        if (pleats) cz += pleat(ls, lt);
        if (e <= 0) {
          mid[i][j] = [px, py, top + cz];
          hw[i][j] = 0.0;
          continue;
        }
        let n;
        if (qx > 0 && qy > 0) {
          const l = sqrt(qx * qx + qy * qy);
          n = [qx / l * sgn(px), qy / l * sgn(py - scy)];
        } else if (qx > qy) {
          n = [sgn(px), 0.0];
        } else {
          n = [0.0, sgn(py - scy)];
        }
        const bx = px - n[0] * e;
        const by = py - n[1] * e;
        const diag = qx > 0 && qy > 0 ? sin(2 * atan2(qy, qx)) : 0.0;
        const ev = e * (1 - 0.24 * diag);
        let off;
        let z;
        if (ev < arc) {
          const al = ev / stand;
          off = stand * sin(al);
          z = top - stand * (1 - cos(al));
        } else {
          const hang = ev - arc;
          off = stand + flare * smooth(0, 45, hang);
          z = top - stand - hang;
        }
        const along = perimeter(px, py - scy, qx, qy, hx - rc, hy - rc);
        const amp = fold * smooth(arc * 0.2, arc + 28, e) * (1 + 0.8 * diag);
        off += amp * nz.fbm(along / fold_size, e / (fold_size * 3.2), 2);
        z += 0.25 * amp * nz.at(along / (fold_size * 1.7) + 9.1, 3.3);
        if (z < floorZ) {
          off += (floorZ - z) * 0.85;
          z = floorZ;
        }
        const w = smooth(0, arc, e);
        mid[i][j] = [bx + n[0] * off, by + n[1] * off, z + cz * (1 - w)];
        hw[i][j] = w;
      }
    }
    const out = Array.from({ length: nx + 1 }, () => new Array(ny + 1));
    const inn = Array.from({ length: nx + 1 }, () => new Array(ny + 1));
    const spacing = min(sx / nx, sydiv(sy, ny));
    const sm = blur(mid, clamp(rround(thick_hang * 0.7 / spacing), 1, 8));
    for (let i = 0; i <= nx; i++) {
      const i0 = max(i - 2, 0);
      const i1 = min(i + 2, nx);
      for (let j = 0; j <= ny; j++) {
        const j0 = max(j - 2, 0);
        const j1 = min(j + 2, ny);
        const nrm = V.unit(V.cross(V.sub(sm[i1][j], sm[i0][j]), V.sub(sm[i][j1], sm[i][j0])));
        let th = thick * (1 - hw[i][j]) + thick_hang * hw[i][j] + edge_puff * sin(PI * hw[i][j]);
        if (sim) th *= 0.45 + 0.55 * smooth(floorZ, floorZ + 10, mid[i][j][2]);
        if (roll) {
          const fromEdge = sy * (1 - j / ny);
          th += roll[0] * (sim ? smooth(roll[1] + 4, roll[1] - 4, fromEdge) : exp(-((fromEdge / roll[1]) ** 2)));
        }
        const edgeD = min(min(i, nx - i) * sx / nx, sydiv(min(j, ny - j) * sy, ny));
        if (hem) th += hem[0] * exp(-((edgeD / hem[1]) ** 2));
        if (stitches) {
          const ks = sx * (i / nx - 0.5) / knit[0];
          const kt = sy * (j / ny - 0.5) / (knit[0] * 0.8);
          th += knit[1] * (1 - 0.3 * hw[i][j]) * stitch(ks, kt);
        } else if (knit && sim) {
          th += knit[1] * 0.45 * (1 - 0.8 * hw[i][j]) * (0.5 + 0.8 * nz.fbm(sx * i / nx / knit[0], sy * j / ny / knit[0], 2));
        } else if (knit) {
          const u = sx * (i / nx - 0.5) / knit[0];
          const v = sy * (j / ny - 0.5) / (knit[0] * 0.8) + (odd(floor(u)) ? 0.5 : 0.0);
          th += knit[1] * abs(sin(PI * (u - floor(u)))) ** 0.6 * (0.6 + 0.4 * cos(2 * PI * v));
        }
        let lo = 0.0;
        const rr = th / 2;
        if (edgeD < rr) {
          const k = 1 - edgeD / rr;
          const seamW = max(0.8, th * 0.12);
          lo = (th - seamW) / 2 * (1 - sqrt(1 - k * k));
        }
        let outer = V.add(mid[i][j], V.mul(nrm, th - lo));
        let inner = lo > 0 ? V.add(mid[i][j], V.mul(nrm, lo)) : mid[i][j];
        if (sim) {
          if (outer[2] < 0.05) outer = [outer[0], outer[1], 0.05];
          if (inner[2] < 0.05) inner = [inner[0], inner[1], 0.05];
        }
        out[i][j] = buf.pt(outer);
        inn[i][j] = buf.pt(inner);
      }
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        buf.quad(out[i][j], out[i + 1][j], out[i + 1][j + 1], out[i][j + 1]);
        buf.quad(inn[i][j], inn[i][j + 1], inn[i + 1][j + 1], inn[i + 1][j]);
      }
    }
    const edge = [];
    for (let i = 0; i < nx; i++) edge.push([i, 0]);
    for (let j = 0; j < ny; j++) edge.push([nx, j]);
    for (let i = nx; i >= 1; i--) edge.push([i, ny]);
    for (let j = ny; j >= 1; j--) edge.push([0, j]);
    edge.forEach(([i, j], k) => {
      const [i2, j2] = edge[(k + 1) % edge.length];
      buf.quad(out[i][j], inn[i][j], inn[i2][j2], out[i2][j2]);
    });
  }

  // ---- ring round a round bed
  ring(buf, { r_in, width, z0, top_at, seams = 0, puff = 1.0, piping = 0.0 }) {
    const rr = width / 2.0;
    let segs = max(ceil(2 * PI * (r_in + width) / this.step(3.0)), 64);
    if (seams > 0 && segs % seams !== 0) segs += seams - segs % seams;
    const wallN = max(ceil(40.0 / this.step(3.0)), 5);
    const topN = max(ceil(PI * rr / this.step(1.5)), 8);
    const rows = Array.from({ length: segs }, (_, i) => {
      const phi = 2 * PI * i / segs;
      const h = top_at(phi > PI ? 2 * PI - phi : phi);
      const hc = max(h - rr, z0 + 3.0);
      const panel = seams > 0 ? sin(PI * rmod(phi * seams / (2 * PI), 1.0)) ** 0.6 : 0.55;
      const prof = [];
      for (let k = 0; k <= wallN; k++) { const f = k / wallN; prof.push([width, z0 + 1.0 + (hc - z0 - 1.0) * f, 1.0, 0.0, sin(PI * f)]); }
      for (let k = 1; k < topN; k++) { const a = PI * k / topN; prof.push([rr + rr * cos(a), hc + rr * sin(a), cos(a), sin(a), 1.0]); }
      for (let k = 0; k <= wallN; k++) { const f = k / wallN; prof.push([0.0, hc - (hc - z0 - 1.0) * f, -1.0, 0.0, sin(PI * f)]); }
      prof.push([0.8, z0, 0.0, -1.0, 0.0], [rr, z0, 0.0, -1.0, 0.0], [width - 0.8, z0, 0.0, -1.0, 0.0]);
      const sn = sin(phi);
      const cs = cos(phi);
      return prof.map(([dr, z, nr, nzz, show]) => {
        const o = puff * panel * show;
        const rho = r_in + dr + o * nr;
        return buf.pt([rho * sn, -rho * cs, z + o * nzz]);
      });
    });
    const m = rows[0].length;
    for (let i = 0; i < segs; i++) {
      const a = rows[i];
      const b = rows[(i + 1) % segs];
      for (let j = 0; j < m; j++) buf.quad(a[j], b[j], b[(j + 1) % m], a[(j + 1) % m]);
    }
    if (!(piping > 0)) return;
    const path = Array.from({ length: segs }, (_, i) => {
      const phi = 2 * PI * i / segs;
      const hc = max(top_at(phi > PI ? 2 * PI - phi : phi) - rr, z0 + 3.0);
      const rho = r_in + width + piping * 0.35;
      return [rho * sin(phi), -rho * cos(phi), hc + piping * 0.2];
    });
    this.tube(buf, path, piping, { seg: 6, closed: true });
  }

  // ---- lathe: solid of revolution about a vertical axis through c; profile [[radius, z], …] bottom→top
  lathe(buf, c, profile, { seg = 18, scale = [1.0, 1.0] } = {}) {
    const rings = profile.map(([r, z]) => Array.from({ length: seg }, (_, k) => {
      const a = 2 * PI * k / seg;
      return buf.pt([c[0] + r * cos(a) * scale[0], c[1] + r * sin(a) * scale[1], c[2] + z]);
    }));
    for (let p = 0; p < rings.length - 1; p++) {
      for (let k = 0; k < seg; k++) buf.quad(rings[p][k], rings[p][(k + 1) % seg], rings[p + 1][(k + 1) % seg], rings[p + 1][k]);
    }
    const bottom = buf.pt([c[0], c[1], c[2] + profile[0][1]]);
    const topc = buf.pt([c[0], c[1], c[2] + profile[profile.length - 1][1]]);
    const first = rings[0];
    const last = rings[rings.length - 1];
    for (let k = 0; k < seg; k++) {
      if (profile[0][0] > 0) buf.tri(bottom, first[(k + 1) % seg], first[k]);
      if (profile[profile.length - 1][0] > 0) buf.tri(topc, last[k], last[(k + 1) % seg]);
    }
  }

  // ---- tube of radius r along a polyline
  tube(buf, pts, r, { seg = 10, closed = false } = {}) {
    const n = pts.length;
    const tang = Array.from({ length: n }, (_, i) => {
      const a = pts[closed ? rmod(i - 1, n) : max(i - 1, 0)];
      const b = pts[closed ? (i + 1) % n : min(i + 1, n - 1)];
      return V.unit(V.sub(b, a));
    });
    const ref = abs(tang[0][2]) < 0.9 ? [0.0, 0.0, 1.0] : [1.0, 0.0, 0.0];
    let nrm = V.unit(V.cross(tang[0], ref));
    const rings = [];
    for (let i = 0; i < n; i++) {
      if (i > 0) nrm = V.unit(V.sub(nrm, V.mul(tang[i], V.dot(nrm, tang[i]))));
      const bin = V.cross(tang[i], nrm);
      rings.push(Array.from({ length: seg }, (_, k) => {
        const a = 2 * PI * k / seg;
        return buf.pt(V.add(pts[i], V.add(V.mul(nrm, r * cos(a)), V.mul(bin, r * sin(a)))));
      }));
    }
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const ra = rings[i];
      const rb = rings[(i + 1) % n];
      for (let k = 0; k < seg; k++) buf.quad(ra[k], ra[(k + 1) % seg], rb[(k + 1) % seg], rb[k]);
    }
    if (closed) return;
    const c0 = buf.pt(pts[0]);
    const c1 = buf.pt(pts[n - 1]);
    for (let k = 0; k < seg; k++) {
      buf.tri(c0, rings[0][(k + 1) % seg], rings[0][k]);
      buf.tri(c1, rings[n - 1][k], rings[n - 1][(k + 1) % seg]);
    }
  }
}

// ---------------------------------------------------------------- helpers
export function toDisc(s, t, hs, ht) {
  const qs = s / hs;
  const qt = t / ht;
  return [s * sqrt(max(1 - qt * qt / 2, 0)), t * sqrt(max(1 - qs * qs / 2, 0))];
}

export function stitch(u, v) {
  const fu = u - floor(u);
  const fv = v - floor(v);
  let h = 0.0;
  for (const dv of [-1, 0, 1]) {
    const y = fv - 0.5 - dv;
    for (const [side, x0] of [[-1, 0.28], [1, 0.72]]) {
      const x = fu - x0;
      const ang = -side * 0.42;
      const xr = x * cos(ang) - y * sin(ang);
      const yr = x * sin(ang) + y * cos(ang);
      const e = (xr / 0.20) ** 2 + (yr / 0.46) ** 2;
      if (e < 9) h = max(h, exp(-e));
    }
  }
  return h;
}

export function roundMap(s, q, ai, bi, rc) {
  const x = ai * s;
  const y = bi * q;
  if (rc < 0.01) return [x, y];
  const cx = ai - rc;
  const cy = bi - rc;
  const ex = abs(x) - cx;
  const ey = abs(y) - cy;
  if (!(ex > 0 && ey > 0)) return [x, y];
  const ua = ex / rc;
  const vb = ey / rc;
  return [sgn(x) * (cx + rc * ua * sqrt(1 - vb * vb / 2)), sgn(y) * (cy + rc * vb * sqrt(1 - ua * ua / 2))];
}

const FOLD_CORNER = 18.0 * PI / 2;

export function perimeter(px, py, qx, qy, lx, ly) {
  const q = FOLD_CORNER;
  const r = FOLD_CORNER / (PI / 2);
  if (qx > 0 && qy > 0) {
    if (py > 0) return px < 0 ? lx + r * atan2(qx, qy) : 3 * lx + 3 * q + 4 * ly + r * atan2(qy, qx);
    return px < 0 ? lx + q + 2 * ly + r * atan2(qy, qx) : 3 * lx + 2 * q + 2 * ly + r * atan2(qx, qy);
  }
  if (qx > qy) return px < 0 ? lx + q + (ly - py) : 3 * lx + 3 * q + 2 * ly + (py + ly);
  if (py > 0) return px < 0 ? -px : 3 * lx + 4 * q + 4 * ly + (lx - px);
  return lx + 2 * q + 2 * ly + (px + lx);
}

// A simulated grid ((nx+1)·(ny+1) points, flat, rows along u) refined f times with Catmull-Rom splines.
export function upsample(pts, nx, ny, f) {
  const wd = nx + 1;
  const at = (i, j) => {
    const k = (clamp(j, 0, ny) * wd + clamp(i, 0, nx)) * 3;
    return [Number(pts[k]), Number(pts[k + 1]), Number(pts[k + 2])];
  };
  const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return [0, 1, 2].map((c) => 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2
      + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t3));
  };
  const mx = nx * f;
  const my = ny * f;
  const grid = Array.from({ length: mx + 1 }, () => new Array(my + 1));
  for (let a = 0; a <= mx; a++) {
    const i = min(floor(a / f), nx - 1);
    const u = (a - i * f) / f;
    for (let b = 0; b <= my; b++) {
      const j = min(floor(b / f), ny - 1);
      const v = (b - j * f) / f;
      const rows = [-1, 0, 1, 2].map((dj) => cr(at(i - 1, j + dj), at(i, j + dj), at(i + 1, j + dj), at(i + 2, j + dj), u));
      grid[a][b] = cr(rows[0], rows[1], rows[2], rows[3], v);
    }
  }
  return [grid, mx, my];
}

export function blur(grid, r, passes = 2) {
  let g = grid;
  const nx = g.length - 1;
  const ny = g[0].length - 1;
  for (let p = 0; p < passes; p++) {
    g = g.map((col) => blurLine(col, r));
    const rows = [];
    for (let j = 0; j <= ny; j++) { const line = []; for (let i = 0; i <= nx; i++) line.push(g[i][j]); rows.push(blurLine(line, r)); }
    const next = [];
    for (let i = 0; i <= nx; i++) { const col = []; for (let j = 0; j <= ny; j++) col.push(rows[j][i]); next.push(col); }
    g = next;
  }
  return g;
}

export function blurLine(pts, r) {
  const m = pts.length;
  const sx = [0.0];
  const sy = [0.0];
  const sz = [0.0];
  for (const p of pts) {
    sx.push(sx[sx.length - 1] + p[0]);
    sy.push(sy[sy.length - 1] + p[1]);
    sz.push(sz[sz.length - 1] + p[2]);
  }
  const out = [];
  for (let k = 0; k < m; k++) {
    const a = max(k - r, 0);
    const b = min(k + r, m - 1) + 1;
    const n = b - a;
    out.push([(sx[b] - sx[a]) / n, (sy[b] - sy[a]) / n, (sz[b] - sz[a]) / n]);
  }
  return out;
}

export function outlinePoints(ax, by, rc, step) {
  rc = clamp(rc, 0.0, min(ax, by));
  const lx = ax - rc;
  const ly = by - rc;
  const pts = [];
  const line = (x0, y0, x1, y1) => {
    const n = max(ceil(hypot(x1 - x0, y1 - y0) / step), 1);
    for (let k = 0; k < n; k++) pts.push([x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]);
  };
  const arc = (cx, cy, a0) => {
    const n = max(ceil(rc * PI / 2 / step), 1);
    for (let k = 0; k < n; k++) { const a = a0 + PI / 2 * k / n; pts.push([cx + rc * cos(a), cy + rc * sin(a)]); }
  };
  line(-lx, -by, lx, -by);
  arc(lx, -ly, -PI / 2);
  line(ax, -ly, ax, ly);
  arc(lx, ly, 0.0);
  line(lx, by, -lx, by);
  arc(-lx, ly, PI / 2);
  line(-ax, ly, -ax, -ly);
  arc(-lx, -ly, PI);
  return pts;
}

export function inside(x, y, ai, bi, rc) {
  const qx = abs(x) - (ai - rc);
  const qy = abs(y) - (bi - rc);
  return -(sqrt(max(qx, 0.0) ** 2 + max(qy, 0.0) ** 2) + min(max(qx, qy), 0.0) - rc);
}

export function outlineNormal(x, y, ai, bi, rc) {
  const sx = x < 0 ? -1.0 : 1.0;
  const sy = y < 0 ? -1.0 : 1.0;
  const ex = abs(x) - (ai - rc);
  const ey = abs(y) - (bi - rc);
  if (rc >= 0.01 && ex > 1e-6 && ey > 1e-6) {
    const l = sqrt(ex * ex + ey * ey);
    return [sx * ex / l, sy * ey / l];
  }
  const onX = abs(abs(x) - ai) < 1e-6;
  const onY = abs(abs(y) - bi) < 1e-6;
  if (onX && onY) return [sx * 0.7071, sy * 0.7071];
  return onX ? [sx, 0.0] : [0.0, sy];
}
