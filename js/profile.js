// Route P, "profile": a rotational object (vase, pot, bowl, bottle, round shade, round stool seat) rebuilt by revolving
// the profile read from its cut-out, all on this computer. The part stays parametric: its profile (control points, cm)
// is kept with the extracted one and the outline it came from, so editing rebuilds it and "reset" brings it back.
// Pure functions, node-testable.
//
// What it assumes, said plainly: a side view (camera roughly level with the object). A camera looking down makes the
// top look taller; no correction is applied without rim evidence, so the result carries cameraElevation 'unknown'.
//   findAxis      the vertical mirror axis of the mask (best mirror overlap) and that overlap (score)
//   readProfile   per row: left and right half-widths about the axis, a status (observed, one_side = a handle or
//                 something on one side, interpolated) and the radius used
//   diagnose      axis confidence (row midpoints on the axis), tilt, cropping, handle and gap shares, resolution
//   controlPoints the profile reduced to points (Douglas-Peucker, tolerance relative to the widest diameter)
//   revolve       a closed shell from the points: solid (top capped), or hollow (an opening, an inner wall offset
//                 along the profile's normal, a rim and an inner floor), checked not to cross itself

// mask: Uint8Array w x h (1 = object). -> { axis (px, column centre), score (mirror IoU 0..1), x0, x1, y0, y1 }
export function findAxis(mask, w, h) {
  let x0 = w; let x1 = -1; let y0 = h; let y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x] === 1) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  // mirror IoU about the line x = c (c in half-pixel steps), on the rows of the object
  const iou = (c) => {
    let inter = 0; let uni = 0;
    for (let y = y0; y <= y1; y++) {
      const row = y * w;
      for (let x = x0; x <= x1; x++) {
        const a = mask[row + x] === 1;
        const mx = Math.round(2 * c - x);
        const b = mx >= 0 && mx < w && mask[row + mx] === 1;
        if (a && b) inter++;
        if (a || b) uni++;
      }
    }
    return uni ? inter / uni : 0;
  };
  const mid = (x0 + x1) / 2;
  const span = Math.max(2, Math.round((x1 - x0) * 0.15));
  let best = mid; let bestS = -1;
  for (let c = mid - span; c <= mid + span; c += 0.5) { const s = iou(c); if (s > bestS) { bestS = s; best = c; } }
  const a = iou(best - 0.5); const b = bestS; const c2 = iou(best + 0.5);
  const den = a - 2 * b + c2;
  const axis = den < 0 ? best + 0.25 * (a - c2) / den : best;
  return { axis, score: bestS, x0, x1, y0, y1 };
}

// -> { rows: Float32Array radius per row y0..y1 (px), left, right (half-widths, NaN when missing), status (0 observed,
// 1 one_side, 2 interpolated), mids, y0, y1 }. A row where one side reaches much further than the other (a handle, a
// spout, something in front) takes the nearer side: the body. Rows missing entirely are interpolated.
export const ROW = { observed: 0, oneSide: 1, interpolated: 2 };
export function readProfile(mask, w, h, ax) {
  const { axis, y0, y1 } = ax;
  const n = y1 - y0 + 1;
  const left = new Float32Array(n).fill(NaN); const right = new Float32Array(n).fill(NaN); const mids = new Float32Array(n).fill(NaN);
  let maxHalf = 0;
  for (let k = 0; k < n; k++) {
    const row = (y0 + k) * w;
    let l = -1; let r = -1;
    for (let x = 0; x < w; x++) if (mask[row + x] === 1) { if (l < 0) l = x; r = x; }
    if (l < 0) continue;
    left[k] = Math.max(0, axis - (l - 0.5)); right[k] = Math.max(0, (r + 0.5) - axis);
    mids[k] = (l - 0.5 + r + 0.5) / 2;
    maxHalf = Math.max(maxHalf, Math.min(left[k], right[k]));
  }
  const rad = new Float32Array(n).fill(NaN);
  const status = new Uint8Array(n).fill(ROW.interpolated);
  for (let k = 0; k < n; k++) {
    if (Number.isNaN(left[k])) continue;
    const dl = left[k]; const dr = right[k];
    if (Math.abs(dl - dr) > Math.max(2, 0.12 * maxHalf)) { rad[k] = Math.min(dl, dr); status[k] = ROW.oneSide; } else { rad[k] = (dl + dr) / 2; status[k] = ROW.observed; }
  }
  // fill gaps linearly
  let last = -1;
  for (let k = 0; k < n; k++) {
    if (Number.isNaN(rad[k])) continue;
    if (last >= 0 && k - last > 1) for (let j = last + 1; j < k; j++) rad[j] = rad[last] + (rad[k] - rad[last]) * (j - last) / (k - last);
    else if (last < 0) for (let j = 0; j < k; j++) rad[j] = rad[k];
    last = k;
  }
  for (let j = last + 1; j < n; j++) rad[j] = last >= 0 ? rad[last] : 0;
  // a light smoothing (3-row mean) against the staircase of the mask, not across a sharp step (a rim, a foot)
  const s = Float32Array.from(rad);
  for (let k = 1; k < n - 1; k++) {
    const step = Math.max(Math.abs(rad[k] - rad[k - 1]), Math.abs(rad[k + 1] - rad[k]));
    if (step < Math.max(1.5, 0.04 * maxHalf)) s[k] = (rad[k - 1] + rad[k] + rad[k + 1]) / 3;
  }
  return { rows: s, left, right, status, mids, y0, y1 };
}

// How far the profile can be trusted, and why not. -> { axisConfidence 0..1, rollDeg, cropped, oneSide, gaps, lowRes }
export function diagnose(mask, w, h, ax, prof) {
  const { status, mids, rows, y0 } = prof;
  const n = rows.length;
  let maxR = 0; for (let k = 0; k < n; k++) maxR = Math.max(maxR, rows[k]);
  // axis confidence: the share of fully seen rows whose own middle sits on the axis
  const tol = Math.max(1.5, 0.03 * maxR);
  let seen = 0; let on = 0; let one = 0; let gap = 0;
  let sy = 0; let sm = 0; let syy = 0; let sym = 0;
  for (let k = 0; k < n; k++) {
    if (status[k] === ROW.oneSide) one++;
    if (status[k] === ROW.interpolated) gap++;
    if (status[k] !== ROW.observed) continue;
    seen++;
    if (Math.abs(mids[k] - ax.axis) <= tol) on++;
    const y = y0 + k; sy += y; sm += mids[k]; syy += y * y; sym += y * mids[k];
  }
  // tilt: the line through the row middles (a photo turned a little, or an object leaning)
  const den = seen * syy - sy * sy;
  const slope = seen > 2 && den ? (seen * sym - sy * sm) / den : 0;
  const touches = ax.x0 <= 0 || ax.x1 >= w - 1 || ax.y0 <= 0 || ax.y1 >= h - 1;
  return {
    axisConfidence: seen ? on / seen : 0,
    rollDeg: (Math.atan(slope) * 180) / Math.PI,
    cropped: touches,
    oneSide: n ? one / n : 0,
    gaps: n ? gap / n : 1,
    lowRes: n < 60 || maxR < 12,
  };
}

// An open top seen from above: the outline's top is then the far half of the rim, an elliptical arc that closes the
// profile like a dome. Evidence, not assumption: the rows from the top down to the widest row (in the top part) must
// follow r = R * sqrt(1 - (d / b)^2) closely. -> { row (the rim, its widest), R, b, elevDeg, err } or null.
// The camera's elevation is asin(b / R) (orthographic). strict: the closer fit asked when nothing else says the top is
// open.
export function topEllipse(profile, { strict = false } = {}) {
  const r = profile.rows; const n = r.length;
  const limit = Math.floor(n * (strict ? 0.55 : 0.6));
  let k = 0;
  for (let i = 1; i <= limit; i++) if (r[i] > r[k]) k = i;
  const R = r[k]; const b = k + 0.5;
  if (k < 4 || R < 8) return null;
  const ratio = b / R;
  if (ratio < 0.1 || ratio > 0.95) return null;
  let err = 0;
  for (let i = 0; i <= k; i++) { const d = (k - i) / b; err += Math.abs(r[i] - R * Math.sqrt(Math.max(0, 1 - d * d))); }
  err /= (k + 1) * R;
  if (err > (strict ? 0.02 : 0.05)) return null;
  return { row: k, R, b, elevDeg: (Math.asin(Math.min(1, ratio)) * 180) / Math.PI, err };
}

// The outline that a profile makes when seen from `elev` above (orthographic, pixels, rows from the rim down): the
// horizontal circle at depth j rows (centre row j, every row is 1 / cos(elev) of height) is an ellipse r wide and
// r * sin(elev) tall; each row of the outline is the widest of the ellipses crossing it.
export function outlineFromAbove(r, elev, rowsOut) {
  const se = Math.sin(elev);
  const out = new Float32Array(rowsOut);
  for (let j = 0; j < r.length; j++) {
    const b = r[j] * se;
    const lo = Math.max(0, Math.ceil(j - b)); const hi = Math.min(rowsOut - 1, Math.floor(j + b));
    for (let y = lo; y <= hi; y++) { const d = b > 0 ? (y - j) / b : 0; const w = r[j] * Math.sqrt(Math.max(0, 1 - d * d)); if (w > out[y]) out[y] = w; }
  }
  return out;
}

// The profile as seen from that elevation, put back upright: the rows above the rim go (they are the far side of the
// rim); so do the rows of the near half of the base's ellipse at the bottom; each remaining row is 1 / cos(elevation)
// of height. (A full per-row fit through outlineFromAbove was tried: rows hidden behind the ellipses above them cannot
// be observed and drift; it did worse on the rendered bowls. Only the bottom cut is chosen through it.)
// -> { rows, vScale, fitErr }
export function fromAbove(profile, top) {
  const e = (top.elevDeg * Math.PI) / 180;
  const se = Math.sin(e);
  const obs = profile.rows.slice(top.row);
  const m = obs.length;
  // the base's near half-ellipse at the bottom. Its lowest rows belong to the base circle alone (nothing of the body
  // reaches lower), so they follow R * sqrt(1 - ((c - i - 1/2) / c)^2) with c = R x sin(elevation): R is fitted on
  // those rows only (the lowest eighth of the ellipse, at least 3 rows), and c rows go.
  let cut = 0; let bestE = Infinity;
  const Rmax = Math.max(...obs) * 1.2;
  for (let R = Math.max(1, obs[m - 1]); R <= Rmax; R += 0.5) {
    const c = R * se;
    if (c < 1 || c > m * 0.45) continue;
    const K = Math.max(3, Math.round(c / 8));
    let err = 0;
    for (let i = 0; i < K; i++) { const d = (c - i - 0.5) / c; const want = R * Math.sqrt(Math.max(0, 1 - d * d)); err += (obs[m - 1 - i] - want) ** 2; }
    err /= K;
    if (err < bestE) { bestE = err; cut = Math.round(c); }
  }
  const rows = obs.slice(0, Math.max(2, m - cut));
  // how well this profile explains the outline it came from (0 = exactly)
  const pred = outlineFromAbove(rows, e, m);
  let fitErr = 0; for (let y = 0; y < m; y++) fitErr += Math.abs(pred[y] - obs[y]);
  fitErr /= m * Math.max(1, obs[0]);
  return { rows, vScale: 1 / Math.max(0.2, Math.cos(e)), fitErr };
}

// Douglas-Peucker on the (height, radius) curve; heightCm sets the scale; the tolerance is a share of the widest
// diameter (a squat bowl and a tall bottle are judged alike). vScale: height per row in pixels (1 from the side;
// 1 / cos(elevation) from above). -> [{ z, r }] cm, bottom (z = 0) first
export function controlPoints(profile, heightCm = 100, tolerance = 0.008, maxPoints = 40) {
  const { rows } = profile;
  const vScale = profile.vScale || 1;
  const n = rows.length;
  const k = heightCm / Math.max(1, n * vScale);
  const pts = [];
  for (let i = n - 1; i >= 0; i--) pts.push({ z: (n - 1 - i + 0.5) * vScale * k, r: rows[i] * k });
  pts[0].z = 0;
  pts[pts.length - 1].z = heightCm;
  const maxD = 2 * Math.max(...pts.map((p) => p.r));
  const tol = tolerance * Math.max(maxD, 1e-6);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const dp = (a, b) => {
    let worst = -1; let at = -1;
    const dz = pts[b].z - pts[a].z; const dr = pts[b].r - pts[a].r; const len = Math.hypot(dz, dr) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dr * (pts[i].z - pts[a].z) - dz * (pts[i].r - pts[a].r)) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol && at > 0) { keep[at] = 1; dp(a, at); dp(at, b); }
  };
  dp(0, pts.length - 1);
  let out = pts.filter((_, i) => keep[i]);
  if (out.length > maxPoints) return controlPoints(profile, heightCm, tolerance * 1.3, maxPoints);
  out = out.map((p) => ({ z: Math.round(p.z * 10) / 10, r: Math.max(0, Math.round(p.r * 10) / 10) }));
  return out.filter((p, i) => i === 0 || p.z > out[i - 1].z);
}

// The inside of a hollow object: the outside moved `wall` cm inwards along the profile's normal (so a sloping shoulder
// keeps its thickness), from the top down to floorZ; never closer than 0.2 cm to the axis, heights strictly rising.
export function innerProfile(pts, wall, floorZ) {
  const top = pts[pts.length - 1].z;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]; const b = pts[Math.min(pts.length - 1, i + 1)];
    const tr = b.r - a.r; const tz = b.z - a.z; const len = Math.hypot(tr, tz) || 1;
    const nr = tz / len; const nz = -tr / len; // outward normal in (r, z)
    out.push({ z: pts[i].z - wall * nz, r: Math.max(0.2, pts[i].r - wall * nr) });
  }
  out[out.length - 1].z = top;
  const inner = [{ z: floorZ, r: Math.max(0.2, radiusAt(pts, floorZ) - wall) }];
  for (const p of out) if (p.z > inner[inner.length - 1].z + 0.05 && p.z <= top) inner.push(p);
  if (inner[inner.length - 1].z < top) inner.push({ z: top, r: Math.max(0.2, pts[pts.length - 1].r - wall) });
  // the inside never reaches outside the outside at the same height
  for (const p of inner) p.r = Math.min(p.r, Math.max(0.2, radiusAt(pts, p.z) - 0.25 * wall));
  return inner;
}

// A closed shell from the profile (z up, cm, centred on the axis, standing on z = 0). hollow: an opening at the top with
// a wall `wall` cm thick going down to `depth` (fraction of the height): a vase mouth or a pot; else the top is capped.
export function revolve(points, { segments = 64, hollow = false, wall = 1, depth = 0.85 } = {}) {
  const pos = []; const tris = [];
  const ring = (z, r) => { const base = pos.length / 3; for (let s = 0; s < segments; s++) { const a = (s / segments) * Math.PI * 2; pos.push(r * Math.cos(a), r * Math.sin(a), z); } return base; };
  const band = (lo, hi) => {
    for (let s = 0; s < segments; s++) {
      const a = lo + s; const b = lo + ((s + 1) % segments); const c = hi + ((s + 1) % segments); const d = hi + s;
      tris.push(a, b, c, a, c, d);
    }
  };
  const fan = (ring0, z, up) => {
    const c = pos.length / 3; pos.push(0, 0, z);
    for (let s = 0; s < segments; s++) { const a = ring0 + s; const b = ring0 + ((s + 1) % segments); if (up) tris.push(c, a, b); else tris.push(c, b, a); }
  };
  const pts = points.filter((p, i) => i === 0 || p.z > points[i - 1].z);
  const outer = pts.map((p) => ring(p.z, Math.max(p.r, 1e-3)));
  for (let i = 0; i + 1 < outer.length; i++) band(outer[i], outer[i + 1]);
  fan(outer[0], pts[0].z, false);
  const top = pts[pts.length - 1];
  if (!hollow || top.r <= wall + 0.2) { fan(outer[outer.length - 1], top.z, true); return { pos: new Float32Array(pos), tris: new Uint32Array(tris) }; }
  const floorZ = Math.max(pts[0].z + Math.min(wall, top.z * 0.1), top.z * (1 - depth));
  const inner = innerProfile(pts, wall, floorZ).map((p) => ring(p.z, p.r));
  const ot = outer[outer.length - 1]; const it = inner[inner.length - 1];
  for (let s = 0; s < segments; s++) {
    const a = ot + s; const b = ot + ((s + 1) % segments); const c = it + ((s + 1) % segments); const d = it + s;
    tris.push(a, b, c, a, c, d);
  }
  for (let i = inner.length - 1; i > 0; i--) {
    const hi = inner[i]; const lo = inner[i - 1];
    for (let s = 0; s < segments; s++) {
      const a = lo + s; const b = lo + ((s + 1) % segments); const c = hi + ((s + 1) % segments); const d = hi + s;
      tris.push(a, c, b, a, d, c);
    }
  }
  fan(inner[0], floorZ, true);
  return { pos: new Float32Array(pos), tris: new Uint32Array(tris) };
}

export function radiusAt(points, z) {
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]; const b = points[i + 1];
    if (z >= a.z && z <= b.z) return a.r + (b.r - a.r) * ((z - a.z) / ((b.z - a.z) || 1));
  }
  return z < points[0].z ? points[0].r : points[points.length - 1].r;
}

// The thresholds, provisional (tuned on the test photos, not settled).
export const LIMITS = { score: 0.93, axis: 0.8, rollDeg: 3, gaps: 0.2, oneSide: 0.35 };

// the whole route on a mask. strict (the automatic route): any doubt refuses; else (the user asked) only a mask that
// is not symmetric at all is refused and the doubts come back as warnings. open: what is known of the top ('open' a
// wide open top: a rim seen from above is looked for; 'unknown': looked for with the stricter test; anything else:
// not looked for). -> { points, outline, score, diag, camera, reasons[], warnings[], size } (points null when refused)
// or null (empty mask)
export function profileFromMask(mask, w, h, { heightCm = 100, strict = true, minScore = strict ? LIMITS.score : 0.8, open = 'unknown' } = {}) {
  const ax = findAxis(mask, w, h);
  if (!ax) return null;
  const prof = readProfile(mask, w, h, ax);
  const diag = diagnose(mask, w, h, ax, prof);
  const doubts = [];
  if (ax.score < LIMITS.score) doubts.push('symmetry');
  if (diag.axisConfidence < LIMITS.axis) doubts.push('axis');
  if (Math.abs(diag.rollDeg) > LIMITS.rollDeg) doubts.push('tilt');
  if (diag.cropped) doubts.push('cropped');
  if (diag.gaps > LIMITS.gaps) doubts.push('gaps');
  if (diag.oneSide > LIMITS.oneSide) doubts.push('one_side');
  if (diag.lowRes) doubts.push('low_res');
  const refuse = ax.score < minScore || (strict && doubts.length > 0);
  const base = { score: ax.score, diag, reasons: refuse ? (doubts.length ? doubts : ['symmetry']) : [], warnings: refuse ? [] : doubts };
  if (refuse) return { ...base, points: null };
  // a rim seen from above: never applied by itself. An elliptical top shows the outer contour is ellipse-like, not that
  // its widest row is the mouth (an open vase whose shoulder is wider than its mouth looks the same) nor that the lowest
  // rows isolate the base; on a real bowl the height still came out about half. So a found rim becomes the alternative
  // the user can try with one click (alt) and the side view stays, until a run with real readings shows when the
  // estimate is better. Two separate tests: a known open top (looser fit) and nothing known (stricter fit).
  const build = (top) => {
    const used = top ? { ...prof, ...fromAbove(prof, top) } : prof;
    const points = controlPoints(used, heightCm);
    // the outline it was read from, for the editor (faint, behind the points): about 80 samples
    const n = used.rows.length; const vs = used.vScale || 1; const k = heightCm / (n * vs); const step = Math.max(1, Math.floor(n / 80));
    const outline = [];
    for (let i = n - 1; i >= 0; i -= step) outline.push({ z: Math.round((n - 1 - i) * vs * k * 10) / 10, r: Math.round(used.rows[i] * k * 10) / 10 });
    const camera = top ? { view: 'above', elevDeg: Math.round(top.elevDeg), evidence: 'rim ellipse' } : { view: 'side' };
    return { points, outline, camera };
  };
  const top = open === 'open' ? topEllipse(prof) : open === 'unknown' ? topEllipse(prof, { strict: true }) : null;
  const main = build(null);
  const alt = top ? build(top) : null;
  const maxR = Math.max(...main.points.map((p) => p.r));
  return { ...base, ...main, alt, axis: ax.axis, size: [2 * maxR, 2 * maxR, heightCm] };
}
