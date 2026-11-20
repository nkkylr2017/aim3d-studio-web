// Mirror pairs and box snapping for the editor. Pure three.js maths, node-testable.
//
// Mirror pairs. The model has its own frame (doc.frame: model -> document, changed by "turn the model", "scale the
// model" and "put it on the floor") and a mirror plane in that frame (doc.mirrorPlane: x = at, the left-right plane of
// a piece whose front faces -y). Pairs are only suggested (parts whose centres mirror each other and whose sizes
// and triangle counts match); editing propagates only across pairs the user confirmed (doc.pairs). A change to one
// part, as a whole transform D = W_after * W_before^-1, reaches its partner as M D M (M the reflection, in document
// space), so a move, a turn or a resize comes out mirrored and turning the whole model first changes nothing.
//
// Box snapping. While a part is dragged, its box (axis-aligned, in document space) snaps to a face of another part's
// box when the two are within `dist` cm and overlap across the other two axes (no snapping through the air to a part
// off to the side). Per axis: touching faces (my min to its max, my max to its min) and aligned faces (min to min,
// max to max); the nearest wins, and the previous target is kept while it stays within 1.5 x dist (no jitter). It
// snaps boxes, not curved surfaces: said so in the UI.
import * as THREE from 'three';

// the reflection in document space: F * Mlocal * F^-1
export function mirrorMatrix(doc) {
  const at = doc.mirrorPlane ? doc.mirrorPlane.at : 0;
  const local = new THREE.Matrix4().set(-1, 0, 0, 2 * at, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const F = doc.frame || new THREE.Matrix4();
  return new THREE.Matrix4().multiplyMatrices(F, local).multiply(F.clone().invert());
}

const triCount = (p) => (p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count) / 3;

// -> [[idA, idB]] parts that look like mirror images of each other across the model's plane, not yet confirmed
export function suggestPairs(doc, { tol = 0.03, sizeTol = 0.12, triTol = 0.25 } = {}) {
  const Finv = (doc.frame || new THREE.Matrix4()).clone().invert();
  const at = doc.mirrorPlane ? doc.mirrorPlane.at : 0;
  const all = doc.bounds(true);
  const diag = all.isEmpty() ? 0 : all.getSize(new THREE.Vector3()).length();
  const near = Math.max(1, tol * diag);
  const taken = new Set(doc.pairs ? doc.pairs.flat() : []);
  const info = doc.parts.filter((p) => p.visible && !taken.has(p.id)).map((p) => {
    const b = doc.worldBox(p);
    return { p, c: b.getCenter(new THREE.Vector3()).applyMatrix4(Finv), s: b.getSize(new THREE.Vector3()), n: triCount(p) };
  });
  const out = [];
  const used = new Set();
  const left = info.filter((a) => a.c.x < at - near / 2).sort((a, b) => a.c.x - b.c.x);
  for (const a of left) {
    const want = new THREE.Vector3(2 * at - a.c.x, a.c.y, a.c.z);
    let best = null; let bestD = Infinity;
    for (const b of info) {
      if (b === a || used.has(b.p.id) || b.c.x <= at) continue;
      const d = b.c.distanceTo(want);
      if (d > near) continue;
      const sizeOk = ['x', 'y', 'z'].every((k) => Math.abs(a.s[k] - b.s[k]) <= sizeTol * Math.max(a.s[k], b.s[k], 1));
      const triOk = Math.abs(a.n - b.n) <= triTol * Math.max(a.n, b.n);
      if (sizeOk && triOk && d < bestD) { best = b; bestD = d; }
    }
    if (best) { out.push([a.p.id, best.p.id]); used.add(best.p.id); used.add(a.p.id); }
  }
  return out;
}

export const partnerOf = (doc, id) => {
  for (const [a, b] of doc.pairs || []) { if (a === id) return b; if (b === id) return a; }
  return null;
};

// place part q as the mirror of what happened to part a: before = { a: Matrix4, q: Matrix4 } at the start of the change
export function mirrorChange(doc, aId, before) {
  const qId = partnerOf(doc, aId);
  const a = doc.part(aId); const q = qId != null ? doc.part(qId) : null;
  if (!a || !q || !before) return null;
  const M = mirrorMatrix(doc);
  const D = doc.matrixOf(a).multiply(before.a.clone().invert());
  const W = new THREE.Matrix4().multiplyMatrices(M, D).multiply(M).multiply(before.q);
  W.decompose(q.position, q.quaternion, q.scale); // a mirrored partner comes back with a negative x scale: same matrix
  q._box = null;
  return q;
}

export const matricesFor = (doc, aId) => {
  const qId = partnerOf(doc, aId);
  const a = doc.part(aId); const q = qId != null ? doc.part(qId) : null;
  return a && q ? { a: doc.matrixOf(a), q: doc.matrixOf(q) } : null;
};

// -> { offset: Vector3 to add to the moving part's position, targets: [{ axis, value, id }] }
export function snapOffset(moving, others, dist, prev = null) {
  const offset = new THREE.Vector3();
  const targets = [];
  if (!(dist > 0)) return { offset, targets };
  const axes = ['x', 'y', 'z'];
  for (const axis of axes) {
    const rest = axes.filter((k) => k !== axis);
    let best = null;
    for (const o of others) {
      const b = o.box;
      const overlaps = rest.every((k) => moving.min[k] < b.max[k] + dist && moving.max[k] > b.min[k] - dist);
      if (!overlaps) continue;
      for (const [mine, theirs] of [['min', 'max'], ['max', 'min'], ['min', 'min'], ['max', 'max']]) {
        const d = b[theirs][axis] - moving[mine][axis];
        const kept = prev && prev.find((t) => t.axis === axis && t.id === o.id && t.face === `${mine}-${theirs}`);
        const limit = kept ? 1.5 * dist : dist;
        if (Math.abs(d) > limit) continue;
        const score = Math.abs(d) - (kept ? dist : 0); // the kept target wins ties
        if (!best || score < best.score) best = { d, score, id: o.id, face: `${mine}-${theirs}`, value: b[theirs][axis] };
      }
    }
    if (best) { offset[axis] = best.d; targets.push({ axis, value: best.value, id: best.id, face: best.face }); }
  }
  return { offset, targets };
}
