// Cloth physics for AIM Lite's smart construction: duvets, throws and runners are dropped onto the furniture
// and left to settle, so their folds, corner cones and heaps come from gravity, not from noise.
//
// Position-based dynamics (Müller et al. 2007): particles on a grid, Verlet integration, and constraints
// projected a few times per step — stretch (neighbours), shear (diagonals), bend (two apart). Collisions with
// rounded boxes (mattress, base, headboard, optionally turned), the floor and a cloth settled earlier, with
// friction, and a spatial-hash repulsion so a crumpled throw does not pass through itself. Pillows are two sheets
// sewn along the edge and stuffed (simPillow). Runs in the dialog's V8, which is far faster than SketchUp's Ruby
// for this. Units: cm, z up.
//
// spec = { floor, colliders: [{ c:[x,y,z], h:[hx,hy,hz], r, axes?:[u,v,w] }],
//          cloths: [{ id, nx, ny, sx, sy, o:[x,y,z], u:[...], v:[...], steps, iters, bend, shear, inflate,
//                     inflate_side?, friction, grip?, damping, gather?, fold?, waves?, seed?, self?, relax? }] }
// inflate: how far the cloth stays from the colliders (its own half thickness, or what lies under it);
// inflate_side: the same on vertical faces, blended over the rounded edges (defaults to inflate);
// thickness: how close two layers of the cloth may come (self collision), so a thick duvet keeps round folds;
// over: { id, r_top, r_side, z_split }: it rests on a cloth settled earlier, whose points count as balls of that radius
// (r_top above z_split, r_side below), so it follows the real folds under it;
// gather (< 1) with gather_dir (deg, in the cloth's u-v plane): the cloth starts pushed together that much along
// that direction in waves `fold` long, so it lands in folds across it (a heap, or a duvet pulled to one side);
// bow (cm): the middle of the cloth starts that far along v, so its edges lie in an arch and not in a straight line;
// end_gather [g, from, wave]: towards both u ends (past `from`, 0..1) it starts pushed together to g along v, in
// waves that long, so what hangs off the sides falls in deep upright folds, like a curtain;
// scrunch (strain, about 0.3): the fabric starts pushed and pulled about in uneven patches, so it lands crumpled;
// drape { cx, cy, hx, hy, margin, pile }: it starts already hanging: whatever lies past that rectangle goes straight
// down beside it, and what would pass the floor lies in zigzags up to `pile` high, so it heaps there in folds (spread
// out flat from a flat start, the same fabric lands far out on the floor like a board).
// returns { grids: { id: { nx, ny, sx, sy, pts: [x0,y0,z0, x1,…] } }, seconds }  ((nx+1)·(ny+1) points, rows along u)

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// Signed distance to a rounded box and its outward direction (in world coordinates).
function boxSdf(col, x, y, z, out) {
  let px = x - col.c[0], py = y - col.c[1], pz = z - col.c[2];
  let lx = px, ly = py, lz = pz;
  if (col.axes) {
    const a = col.axes;
    lx = px * a[0][0] + py * a[0][1] + pz * a[0][2];
    ly = px * a[1][0] + py * a[1][1] + pz * a[1][2];
    lz = px * a[2][0] + py * a[2][1] + pz * a[2][2];
  }
  const r = col.r, qx = Math.abs(lx) - (col.h[0] - r), qy = Math.abs(ly) - (col.h[1] - r), qz = Math.abs(lz) - (col.h[2] - r);
  const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
  const outside = Math.sqrt(mx * mx + my * my + mz * mz);
  const d = outside + Math.min(Math.max(qx, qy, qz), 0) - r;
  let gx, gy, gz;
  if (outside > 1e-6) { gx = mx / outside * Math.sign(lx); gy = my / outside * Math.sign(ly); gz = mz / outside * Math.sign(lz); }
  else if (qx >= qy && qx >= qz) { gx = Math.sign(lx) || 1; gy = 0; gz = 0; }
  else if (qy >= qz) { gx = 0; gy = Math.sign(ly) || 1; gz = 0; }
  else { gx = 0; gy = 0; gz = Math.sign(lz) || 1; }
  if (col.axes) {
    const a = col.axes;
    out[0] = gx * a[0][0] + gy * a[1][0] + gz * a[2][0];
    out[1] = gx * a[0][1] + gy * a[1][1] + gz * a[2][1];
    out[2] = gx * a[0][2] + gy * a[1][2] + gz * a[2][2];
  } else { out[0] = gx; out[1] = gy; out[2] = gz; }
  return d;
}

// Any collider: a rounded box (the default), kind 'cyl' (an upright rounded cylinder: c, R, hz half height, r edge
// radius) or kind 'ring' (the padded ring round a round bed, centred on the origin: r_in, r_out, z0, its top at
// `front` in front rising to `back` between rise[0] and rise[1] half turns from the front; a rounded tombstone in
// section).
function colliderSdf(col, x, y, z, out) {
  if (col.kind === 'cyl') return cylSdf(col, x, y, z, out);
  if (col.kind === 'ring') return ringSdf(col, x, y, z, out);
  return boxSdf(col, x, y, z, out);
}

function cylSdf(col, x, y, z, out) {
  const px = x - col.c[0], py = y - col.c[1], pz = z - col.c[2], rho = Math.hypot(px, py) || 1e-9;
  const r = col.r || 0, dx = rho - (col.R - r), dz = Math.abs(pz) - (col.hz - r);
  const mx = Math.max(dx, 0), mz = Math.max(dz, 0), outside = Math.hypot(mx, mz);
  const d = outside + Math.min(Math.max(dx, dz), 0) - r;
  let gr, gz;
  if (outside > 1e-6) { gr = mx / outside; gz = mz / outside * Math.sign(pz); }
  else if (dx > dz) { gr = 1; gz = 0; } else { gr = 0; gz = Math.sign(pz) || 1; }
  out[0] = gr * px / rho; out[1] = gr * py / rho; out[2] = gz;
  return d;
}

function smoothstep(e0, e1, x) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

function ringSdf(col, x, y, z, out) {
  const rho = Math.hypot(x, y) || 1e-9, phi = Math.abs(Math.atan2(x, -y));
  const top = col.front + (col.back - col.front) * smoothstep(col.rise[0] * Math.PI, col.rise[1] * Math.PI, phi);
  const half = (col.r_out - col.r_in) / 2, rc = (col.r_in + col.r_out) / 2, zc = (col.z0 + top) / 2, hz = (top - col.z0) / 2;
  const r = Math.min(half, hz), dr = Math.abs(rho - rc) - (half - r), dz = Math.abs(z - zc) - (hz - r);
  const mr = Math.max(dr, 0), mz = Math.max(dz, 0), outside = Math.hypot(mr, mz);
  const d = outside + Math.min(Math.max(dr, dz), 0) - r;
  let gr, gz;
  if (outside > 1e-6) { gr = mr / outside * Math.sign(rho - rc); gz = mz / outside * Math.sign(z - zc); }
  else if (dr > dz) { gr = Math.sign(rho - rc) || 1; gz = 0; } else { gr = 0; gz = Math.sign(z - zc) || 1; }
  out[0] = gr * x / rho; out[1] = gr * y / rho; out[2] = gz;
  return d;
}

// A point of a square (half sizes hs, ht) mapped onto the disc inside it: a round cloth on a square grid.
function toDisc(s, t, hs, ht) {
  const qs = s / hs, qt = t / ht;
  return [s * Math.sqrt(Math.max(0, 1 - qt * qt / 2)), t * Math.sqrt(Math.max(0, 1 - qs * qs / 2))];
}

// A tailored round cover is sewn as a cap: a flat top of radius cap.r, rounded over an edge of radius cap.re, then
// straight down. Laid out that way (not as a flat disc) its side has no spare width to fall in tablecloth folds.
// A point (s, t) of the round cloth -> [x, y, z] on the cap, z down from its top.
function capPoint(s, t, cap) {
  const rho = Math.hypot(s, t);
  if (rho <= cap.r || rho < 1e-9) return [s, t, 0];
  const e = rho - cap.r, arc = Math.PI / 2 * cap.re, ux = s / rho, uy = t / rho;
  let rad, z;
  if (e <= arc) { const a = e / cap.re; rad = cap.r + cap.re * Math.sin(a); z = -cap.re * (1 - Math.cos(a)); }
  else { rad = cap.r + cap.re; z = -cap.re - (e - arc); }
  return [ux * rad, uy * rad, z];
}

function simCloth(c, colliders, floor, done) {
  const nx = c.nx, ny = c.ny, W = nx + 1, n = W * (ny + 1);
  const P = new Float64Array(n * 3), Q = new Float64Array(n * 3);
  const rand = rng(c.seed || 7);
  // starting shape: the cloth spread flat, or gathered into accordion folds to fall into a heap or land in
  // folds. The folds keep the fabric's length (amplitude from the gather), so nothing snaps apart at the start.
  const gather = c.gather || 1, waves = c.waves || 0, ph = rand() * 6.28;
  const ga = (c.gather_dir || 0) * Math.PI / 180, gc = Math.cos(ga), gs = Math.sin(ga);
  const lambda = c.fold || 16, amp = gather < 1 ? lambda / (2 * Math.PI) * Math.sqrt(2 * (1 - gather * gather)) : 0;
  const crumple = [];
  if (c.scrunch) {
    for (let k = 0; k < 8; k++) {
      const L = k < 3 ? 86 : (k < 6 ? 38 : 19), dir = rand() * 6.283, a = c.scrunch / 2.2 * L / (2 * Math.PI);
      crumple.push({ kx: Math.cos(dir) * 2 * Math.PI / L, ky: Math.sin(dir) * 2 * Math.PI / L, a, ax: Math.cos(dir), ay: Math.sin(dir), ph: rand() * 6.283, pz: rand() * 6.283 });
    }
  }
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const k = (j * W + i) * 3;
    let s0 = (i / nx - 0.5) * c.sx, t0 = (j / ny - 0.5) * c.sy;
    if (c.disc) [s0, t0] = toDisc(s0, t0, c.sx / 2, c.sy / 2);
    if (c.cap) {
      // a tailored cover starts in its own shape, a few soft waves on its top
      const cp = capPoint(s0, t0, c.cap);
      const lift = waves && cp[2] === 0 ? waves * Math.sin(s0 / 29 + ph) * Math.sin(t0 / 37 + 1.3 * ph) : 0;
      for (let a = 0; a < 3; a++) P[k + a] = c.o[a] + c.u[a] * cp[0] + c.v[a] * cp[1];
      P[k + 2] += cp[2] + lift;
      continue;
    }
    const p = s0 * gc + t0 * gs, q = -s0 * gs + t0 * gc, pg = p * gather;
    const s = pg * gc - q * gs;
    let t = pg * gs + q * gc;
    const fromMiddle = Math.abs(s0) / (c.sx / 2);
    if (c.bow) t += c.bow * (1 - fromMiddle * fromMiddle);
    let curtain = 0;
    if (c.end_gather) {
      const eg = c.end_gather, e1 = Math.min(1, Math.max(0, (fromMiddle - eg[1]) / (1 - eg[1]))), e2 = e1 * e1 * (3 - 2 * e1);
      if (e2 > 0) {
        const gNow = 1 - e2 * (1 - eg[0]);
        t = c.bow ? c.bow * (1 - fromMiddle * fromMiddle) + (t - c.bow * (1 - fromMiddle * fromMiddle)) * gNow : t * gNow;
        curtain = eg[2] / (2 * Math.PI) * Math.sqrt(2 * (1 - gNow * gNow)) * Math.sin(2 * Math.PI * t0 / eg[2] + ph + 0.8 * Math.sin(s0 / 17));
      }
    }
    // the waves wander along the cloth and differ in height: real gathers are never regular
    const wander = 0.9 * Math.sin(q / 31 + ph) + 0.7 * Math.sin(q / 13 + 2.1 * ph) + 0.5 * Math.sin(p / 47 + 1.7 * ph);
    let lift = amp * (0.75 + 0.35 * Math.sin(p / 23 + 0.7 * ph) * Math.sin(q / 19 + ph)) * Math.sin(2 * Math.PI * p / lambda + ph + wander);
    if (waves) lift += waves * Math.sin(s0 / 29 + ph) * Math.sin(t0 / 37 + 1.3 * ph);
    lift += curtain;
    let sC = s, tC = t;
    for (let w = 0; w < crumple.length; w++) {
      const cr = crumple[w], arg = cr.kx * s0 + cr.ky * t0 + cr.ph, sn = cr.a * Math.sin(arg);
      sC += cr.ax * sn; tC += cr.ay * sn; lift += 0.45 * cr.a * Math.sin(arg + cr.pz);
    }
    P[k] = c.o[0] + c.u[0] * sC + c.v[0] * tC;
    P[k + 1] = c.o[1] + c.u[1] * sC + c.v[1] * tC;
    P[k + 2] = c.o[2] + c.u[2] * sC + c.v[2] * tC + lift;
    if (c.drape) {
      const d = c.drape, rx = P[k] - d.cx, ry = P[k + 1] - d.cy, ex = Math.abs(rx) - d.hx, ey = Math.abs(ry) - d.hy;
      if (ex > 0 || ey > 0) {
        const e = Math.hypot(Math.max(ex, 0), Math.max(ey, 0));
        // out to the hanging plane, then straight down
        if (ex > 0) P[k] = d.cx + Math.sign(rx) * (d.hx + Math.min(ex, d.margin));
        if (ey > 0) P[k + 1] = d.cy + Math.sign(ry) * (d.hy + Math.min(ey, d.margin));
        let z = P[k + 2] - Math.max(0, e - d.margin);
        const low = floor + 1.5;
        if (z < low) {
          const over = low - z, h = d.pile || 8, m = over % (2 * h);
          z = low + (m < h ? m : 2 * h - m);
          if (ex > 0) P[k] += Math.sign(rx) * Math.min(over * 0.18, 12);
          if (ey > 0) P[k + 1] += Math.sign(ry) * Math.min(over * 0.18, 12);
        }
        P[k + 2] = z;
      }
    }
  }
  Q.set(P);
  // constraints: [a, b, rest length, stiffness]
  const A = [], B = [], R = [], K = [];
  // rest lengths from the cloth laid flat (a round cloth: as mapped onto its disc; a tailored cover: as sewn, on its
  // cap, cut a little larger than what it covers, ease, so it lies soft and not stretched)
  const flat = (q) => {
    const s = (q % W / nx - 0.5) * c.sx, t = (((q / W) | 0) / ny - 0.5) * c.sy;
    const p = c.disc ? toDisc(s, t, c.sx / 2, c.sy / 2) : [s, t];
    return c.cap ? capPoint(p[0], p[1], c.cap) : [p[0], p[1], 0];
  };
  const ease = 1 + ((c.cap && c.cap.ease) || 0);
  const rest = (a, b) => { const fa = flat(a), fb = flat(b); return ease * Math.hypot(fb[0] - fa[0], fb[1] - fa[1], fb[2] - fa[2]); };
  const add = (a, b, k) => { A.push(a); B.push(b); R.push(rest(a, b)); K.push(k); };
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const a = j * W + i;
    if (i < nx) add(a, a + 1, 1);
    if (j < ny) add(a, a + W, 1);
    if (i < nx && j < ny) { add(a, a + W + 1, c.shear || 0.5); add(a + 1, a + W, c.shear || 0.5); }
    if (i + 2 <= nx) add(a, a + 2, c.bend);
    if (j + 2 <= ny) add(a, a + 2 * W, c.bend);
  }
  const m = A.length, cA = Int32Array.from(A), cB = Int32Array.from(B), cR = Float64Array.from(R), cK = Float64Array.from(K);
  const g = -981, dt = 1 / 60, damp = c.damping || 0.985, inflate = c.inflate || 0.8, fr = c.friction || 0.5;
  const side = c.inflate_side == null ? inflate : c.inflate_side;
  const topFr = c.grip == null ? 1 : c.grip;
  const steps = c.steps || 240, iters = c.iters || 8, grad = [0, 0, 0];
  // self collision: a hashed grid of cells as big as the thickness; each particle meets those in the 27 cells
  // around it, except its neighbours on the cloth (they are held by the constraints)
  const spacing = Math.min(c.sx / nx, c.sy / ny), rad = c.thickness || spacing * 0.9, ir = 1 / rad;
  const near = Math.max(2, Math.ceil(rad / spacing)), selfCollide = c.self !== false;
  const HS = 1 << 16, head = new Int32Array(HS), next = new Int32Array(n);
  const CX = new Int32Array(n), CY = new Int32Array(n), CZ = new Int32Array(n);
  const bucket = (x, y, z) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (HS - 1);
  // the cloth this one rests on, in its own hash
  let under = null;
  if (c.over && done && done[c.over.id]) {
    const pts = done[c.over.id].pts, count = pts.length / 3, size = Math.max(c.over.r_top, c.over.r_side);
    const uHead = new Int32Array(HS).fill(-1), uNext = new Int32Array(count), iu = 1 / size;
    for (let q = 0; q < count; q++) {
      const h = bucket(Math.floor(pts[q * 3] * iu), Math.floor(pts[q * 3 + 1] * iu), Math.floor(pts[q * 3 + 2] * iu));
      uNext[q] = uHead[h]; uHead[h] = q;
    }
    under = { pts, uHead, uNext, iu, rTop: c.over.r_top, rSide: c.over.r_side, zSplit: c.over.z_split };
  }
  for (let step = 0; step < steps; step++) {
    for (let p = 0; p < n * 3; p += 3) {
      const vx = (P[p] - Q[p]) * damp, vy = (P[p + 1] - Q[p + 1]) * damp, vz = (P[p + 2] - Q[p + 2]) * damp;
      Q[p] = P[p]; Q[p + 1] = P[p + 1]; Q[p + 2] = P[p + 2];
      P[p] += vx; P[p + 1] += vy; P[p + 2] += vz + g * dt * dt;
    }
    const relax = step < (c.relax || (c.scrunch ? 40 : 20));
    for (let it = 0; it < iters; it++) {
      for (let e = 0; e < m; e++) {
        const a = cA[e] * 3, b = cB[e] * 3;
        const dx = P[b] - P[a], dy = P[b + 1] - P[a + 1], dz = P[b + 2] - P[a + 2];
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (L < 1e-9) continue;
        const f = (L - cR[e]) / L * 0.5 * cK[e];
        P[a] += dx * f; P[a + 1] += dy * f; P[a + 2] += dz * f;
        P[b] -= dx * f; P[b + 1] -= dy * f; P[b + 2] -= dz * f;
      }
    }
    // settle the starting shape before gravity really takes over: no speed carried from the corrections
    if (relax) Q.set(P);
    // self collision: parts of the cloth that are far apart on it but meet in space push each other apart
    if (selfCollide && step % 2 === 0) {
      head.fill(-1);
      for (let q = 0; q < n; q++) {
        const x = Math.floor(P[q * 3] * ir), y = Math.floor(P[q * 3 + 1] * ir), z = Math.floor(P[q * 3 + 2] * ir);
        CX[q] = x; CY[q] = y; CZ[q] = z;
        const h = bucket(x, y, z); next[q] = head[h]; head[h] = q;
      }
      const r2 = rad * rad;
      for (let q = 0; q < n; q++) {
        const qi = q % W, qj = (q / W) | 0, ia = q * 3;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          for (let b = head[bucket(CX[q] + dx, CY[q] + dy, CZ[q] + dz)]; b !== -1; b = next[b]) {
            if (b <= q || (Math.abs(b % W - qi) <= near && Math.abs(((b / W) | 0) - qj) <= near)) continue;
            const ib = b * 3, ex = P[ib] - P[ia], ey = P[ib + 1] - P[ia + 1], ez = P[ib + 2] - P[ia + 2];
            const L2 = ex * ex + ey * ey + ez * ez;
            if (L2 >= r2 || L2 < 1e-12) continue;
            const L = Math.sqrt(L2), f = (rad - L) / L * 0.25;
            P[ia] -= ex * f; P[ia + 1] -= ey * f; P[ia + 2] -= ez * f;
            P[ib] += ex * f; P[ib + 1] += ey * f; P[ib + 2] += ez * f;
          }
        }
      }
    }
    // collisions and friction
    for (let p = 0; p < n * 3; p += 3) {
      for (let ci = 0; ci < colliders.length; ci++) {
        const raw = colliderSdf(colliders[ci], P[p], P[p + 1], P[p + 2], grad);
        const d = raw - (side + (inflate - side) * Math.max(0, grad[2]));
        if (d >= 0) continue;
        P[p] -= grad[0] * d; P[p + 1] -= grad[1] * d; P[p + 2] -= grad[2] * d;
        // friction at position level (Macklin et al. 2014): undo the sliding of this step — fully where the
        // fabric rests on a top surface (it grips), partly on edges and sides (it slides, slowed)
        const vx = P[p] - Q[p], vy = P[p + 1] - Q[p + 1], vz = P[p + 2] - Q[p + 2];
        const vn = vx * grad[0] + vy * grad[1] + vz * grad[2], k = grad[2] > 0.7 ? topFr : fr;
        P[p] -= (vx - vn * grad[0]) * k; P[p + 1] -= (vy - vn * grad[1]) * k; P[p + 2] -= (vz - vn * grad[2]) * k;
      }
      if (under) {
        const cx = Math.floor(P[p] * under.iu), cy = Math.floor(P[p + 1] * under.iu), cz = Math.floor(P[p + 2] * under.iu);
        let nx0 = 0, ny0 = 0, nz0 = 0, hit = false;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          for (let q = under.uHead[bucket(cx + dx, cy + dy, cz + dz)]; q !== -1; q = under.uNext[q]) {
            const k = q * 3, ex = P[p] - under.pts[k], ey = P[p + 1] - under.pts[k + 1], ez = P[p + 2] - under.pts[k + 2];
            const r = under.pts[k + 2] > under.zSplit ? under.rTop : under.rSide, L2 = ex * ex + ey * ey + ez * ez;
            if (L2 >= r * r || L2 < 1e-9) continue;
            const L = Math.sqrt(L2), f = (r - L) / L;
            P[p] += ex * f; P[p + 1] += ey * f; P[p + 2] += ez * f;
            nx0 += ex / L; ny0 += ey / L; nz0 += ez / L; hit = true;
          }
        }
        if (hit) {
          const nl = Math.sqrt(nx0 * nx0 + ny0 * ny0 + nz0 * nz0) || 1; nx0 /= nl; ny0 /= nl; nz0 /= nl;
          const vx = P[p] - Q[p], vy = P[p + 1] - Q[p + 1], vz = P[p + 2] - Q[p + 2];
          const vn = vx * nx0 + vy * ny0 + vz * nz0, k = nz0 > 0.7 ? topFr : fr;
          P[p] -= (vx - vn * nx0) * k; P[p + 1] -= (vy - vn * ny0) * k; P[p + 2] -= (vz - vn * nz0) * k;
        }
      }
      if (P[p + 2] < floor + 0.6) {
        P[p + 2] = floor + 0.6;
        Q[p] += (P[p] - Q[p]) * 0.8; Q[p + 1] += (P[p + 1] - Q[p + 1]) * 0.8;
      }
    }
  }
  const out = new Array(n * 3);
  for (let p = 0; p < n * 3; p++) out[p] = Math.round(P[p] * 100) / 100;
  return out;
}

// A pillow or cushion in its own frame (x across, y up, z towards the room): sheets of fabric sewn together and stuffed
// until they hold the wanted volume. Nothing about its shape is drawn: the outline pulls in between the corners and
// wrinkles run in from the seams because the fabric cannot stretch. It settles against the surfaces it leans on
// (planes: { n, d } with n·p >= d), under a little gravity (down).
// p = { id, w, h, nx, ny, volume, planes, down, gravity, seed, steps, bend, spread, band: { h, rows } }  flat sizes in cm
// Without a band the two sheets are sewn straight together (a pillow); with one, a strip that high runs between
// them all round (a boxed sofa cushion).
// returns { kind: 'pillow', layers: 2, nx, ny, sx, sy, ring, rows, extra, pts }: the front grid, the back grid, then the
// band's inner rows, ring by ring (ring = points round the edge, extra = how many numbers those rows add).
function simPillow(p) {
  const nx = p.nx, ny = p.ny, W = nx + 1, H = ny + 1, cu = p.w / nx, cv = p.h / ny, rand = rng(p.seed || 3);
  const bandH = p.band ? p.band.h : 0, rows = p.band ? p.band.rows : 0;
  // vertices: the front sheet, then the back sheet (without a band they share the border: that is the seam)
  const backOf = new Int32Array(W * H); let n = W * H;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) backOf[j * W + i] = (!rows && (i === 0 || j === 0 || i === nx || j === ny)) ? j * W + i : n++;
  // the border, counter-clockwise seen from the front
  const ring = [];
  for (let i = 0; i < nx; i++) ring.push(i);
  for (let j = 0; j < ny; j++) ring.push(j * W + nx);
  for (let i = nx; i > 0; i--) ring.push(ny * W + i);
  for (let j = ny; j > 0; j--) ring.push(j * W);
  const Rn = ring.length, bandStart = n;
  if (rows) n += Rn * (rows - 1);
  const bandId = (m, k) => { const q = ((m % Rn) + Rn) % Rn; return k === 0 ? ring[q] : (k === rows ? backOf[ring[q]] : bandStart + q * (rows - 1) + (k - 1)); };
  const P = new Float64Array(n * 3), Q = new Float64Array(n * 3), N = new Float64Array(n * 3);
  const flatX = (id) => (id % W / nx - 0.5) * p.w, flatY = (id) => (((id / W) | 0) / ny - 0.5) * p.h;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = (i / nx - 0.5) * p.w, y = (j / ny - 0.5) * p.h, a = j * W + i, b = backOf[a];
    const bump = Math.sin(Math.PI * i / nx) * Math.sin(Math.PI * j / ny);
    P[a * 3] = x; P[a * 3 + 1] = y; P[a * 3 + 2] = bandH / 2 + (0.6 + 0.3 * rand()) * bump;
    if (b !== a) { P[b * 3] = x; P[b * 3 + 1] = y; P[b * 3 + 2] = -bandH / 2 - (0.6 + 0.3 * rand()) * bump; }
  }
  if (rows) for (let m = 0; m < Rn; m++) for (let k = 1; k < rows; k++) {
    const id = bandId(m, k);
    P[id * 3] = flatX(ring[m]); P[id * 3 + 1] = flatY(ring[m]); P[id * 3 + 2] = bandH / 2 - bandH * k / rows;
  }
  Q.set(P);
  const A = [], B = [], R = [], K = [], seen = new Set();
  const add = (a, b, r, k) => {
    const key = a < b ? a * n + b : b * n + a;
    if (seen.has(key)) return;
    seen.add(key); A.push(a); B.push(b); R.push(r); K.push(k);
  };
  const diag = Math.hypot(cu, cv), bend = p.bend == null ? 0.06 : p.bend, shear = 0.5;
  [(id) => id, (id) => backOf[id]].forEach((map) => {
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const a = j * W + i;
      if (i < nx) add(map(a), map(a + 1), cu, 1);
      if (j < ny) add(map(a), map(a + W), cv, 1);
      if (i < nx && j < ny) { add(map(a), map(a + W + 1), diag, shear); add(map(a + 1), map(a + W), diag, shear); }
      if (i + 2 <= nx) add(map(a), map(a + 2), 2 * cu, bend);
      if (j + 2 <= ny) add(map(a), map(a + 2 * W), 2 * cv, bend);
    }
  });
  // the stuffing fills it out to its edges: opposite sides stay almost a full width apart, so the outline stays
  // nearly straight and the wrinkles run in from the seam instead of the corners turning into points
  const spread = p.spread == null ? 0.94 : p.spread;
  [(id) => id, (id) => backOf[id]].forEach((map) => {
    for (let j = 0; j < H; j++) add(map(j * W), map(j * W + nx), p.w * spread, 0.6);
    for (let i = 0; i < W; i++) add(map(i), map(ny * W + i), p.h * spread, 0.6);
  });
  if (rows) {
    const rowH = bandH / rows;
    for (let m = 0; m < Rn; m++) {
      const edge = Math.hypot(flatX(ring[(m + 1) % Rn]) - flatX(ring[m]), flatY(ring[(m + 1) % Rn]) - flatY(ring[m])), dg = Math.hypot(edge, rowH);
      for (let k = 0; k <= rows; k++) {
        add(bandId(m, k), bandId(m + 1, k), edge, 1);
        if (k < rows) { add(bandId(m, k), bandId(m, k + 1), rowH, 1); add(bandId(m, k), bandId(m + 1, k + 1), dg, shear); add(bandId(m + 1, k), bandId(m, k + 1), dg, shear); }
        if (k + 2 <= rows) add(bandId(m, k), bandId(m, k + 2), 2 * rowH, 0.5);
      }
    }
  } else {
    // the seam is soft, not a knife edge: a little bending across it
    for (let i = 1; i < nx; i++) { add(W + i, backOf[W + i], 1.6 * cv, 0.2); add(ny * W - W + i, backOf[ny * W - W + i], 1.6 * cv, 0.2); }
    for (let j = 1; j < ny; j++) { add(j * W + 1, backOf[j * W + 1], 1.6 * cu, 0.2); add(j * W + nx - 1, backOf[j * W + nx - 1], 1.6 * cu, 0.2); }
  }
  const m = A.length, cA = Int32Array.from(A), cB = Int32Array.from(B), cR = Float64Array.from(R), cK = Float64Array.from(K);
  // outward triangles, for the normals and the volume
  const T = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * W + i, b = a + 1, c = a + W + 1, d = a + W;
    T.push(a, b, c, a, c, d, backOf[a], backOf[c], backOf[b], backOf[a], backOf[d], backOf[c]);
  }
  if (rows) for (let q = 0; q < Rn; q++) for (let k = 0; k < rows; k++) {
    const a = bandId(q, k), b = bandId(q + 1, k), c = bandId(q + 1, k + 1), d = bandId(q, k + 1);
    T.push(a, d, c, a, c, b);
  }
  const tris = Int32Array.from(T), steps = p.steps || 260, iters = p.iters || 6, damp = 0.94;
  const down = p.down || [0, -1, 0], gg = (p.gravity == null ? 4 : p.gravity) / 3600, planes = p.planes || [];
  for (let step = 0; step < steps; step++) {
    N.fill(0);
    let V = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      const ax = P[a], ay = P[a + 1], az = P[a + 2], ux = P[b] - ax, uy = P[b + 1] - ay, uz = P[b + 2] - az, vx = P[c] - ax, vy = P[c + 1] - ay, vz = P[c + 2] - az;
      const nx1 = uy * vz - uz * vy, ny1 = uz * vx - ux * vz, nz1 = ux * vy - uy * vx;
      V += (ax * nx1 + ay * ny1 + az * nz1) / 6;
      N[a] += nx1; N[a + 1] += ny1; N[a + 2] += nz1; N[b] += nx1; N[b + 1] += ny1; N[b + 2] += nz1; N[c] += nx1; N[c + 1] += ny1; N[c + 2] += nz1;
    }
    // stuffing: pushes out hard until the volume is reached (it keeps the body against its weight), and gives
    // way a little when squeezed past it
    const press = 0.0022 * Math.max(-0.4, Math.min(1, 5 * (p.volume - V) / p.volume));
    for (let q = 0; q < n * 3; q += 3) {
      const vx = (P[q] - Q[q]) * damp, vy = (P[q + 1] - Q[q + 1]) * damp, vz = (P[q + 2] - Q[q + 2]) * damp;
      Q[q] = P[q]; Q[q + 1] = P[q + 1]; Q[q + 2] = P[q + 2];
      P[q] += vx + N[q] * press + down[0] * gg; P[q + 1] += vy + N[q + 1] * press + down[1] * gg; P[q + 2] += vz + N[q + 2] * press + down[2] * gg;
    }
    for (let it = 0; it < iters; it++) {
      for (let e = 0; e < m; e++) {
        const a = cA[e] * 3, b = cB[e] * 3, dx = P[b] - P[a], dy = P[b + 1] - P[a + 1], dz = P[b + 2] - P[a + 2];
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (L < 1e-9) continue;
        // fabric does not stretch but it can buckle: bending and shear only hold it apart, not together
        if (cK[e] < 1 && L > cR[e]) continue;
        const f = (L - cR[e]) / L * 0.5 * cK[e];
        P[a] += dx * f; P[a + 1] += dy * f; P[a + 2] += dz * f;
        P[b] -= dx * f; P[b + 1] -= dy * f; P[b + 2] -= dz * f;
      }
    }
    for (let q = 0; q < n * 3; q += 3) {
      for (let k = 0; k < planes.length; k++) {
        const pl = planes[k], d = P[q] * pl.n[0] + P[q + 1] * pl.n[1] + P[q + 2] * pl.n[2] - pl.d;
        if (d >= 0) continue;
        P[q] -= pl.n[0] * d; P[q + 1] -= pl.n[1] * d; P[q + 2] -= pl.n[2] * d;
        // it stays where it touches
        Q[q] += (P[q] - Q[q]) * 0.5; Q[q + 1] += (P[q + 1] - Q[q + 1]) * 0.5; Q[q + 2] += (P[q + 2] - Q[q + 2]) * 0.5;
      }
    }
  }
  const out = [];
  const put = (id) => { out.push(Math.round(P[id * 3] * 100) / 100, Math.round(P[id * 3 + 1] * 100) / 100, Math.round(P[id * 3 + 2] * 100) / 100); };
  for (let k = 0; k < W * H; k++) put(k);
  for (let k = 0; k < W * H; k++) put(backOf[k]);
  if (rows) for (let q = 0; q < Rn; q++) for (let k = 1; k < rows; k++) put(bandId(q, k));
  return { kind: 'pillow', layers: 2, nx, ny, sx: p.w, sy: p.h, ring: Rn, rows, extra: rows ? Rn * (rows - 1) * 3 : 0, pts: out };
}

export function simulate(spec) {
  // spec.given: fabrics settled and approved in an earlier step. They stay exactly as they are, and a cloth that
  // rests "over" one of them lands on those very folds. Only what was simulated now is returned.
  const t0 = performance.now(), result = {}, known = Object.assign({}, spec.given || {});
  for (const c of spec.cloths || []) known[c.id] = result[c.id] = { nx: c.nx, ny: c.ny, sx: c.sx, sy: c.sy, pts: simCloth(c, spec.colliders || [], spec.floor || 0, known) };
  for (const p of spec.pillows || []) result[p.id] = simPillow(p);
  return { grids: result, seconds: Math.round((performance.now() - t0) / 100) / 10 };
}
