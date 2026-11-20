// The model being edited: a list of parts, each a geometry (cm, z up, centred on its own box) with its own position,
// turn and scale. Generators (the parametric builder, the AI engines, the local draft) fill it; the viewer shows it;
// the editor changes it; export writes it. Pure data and three.js maths only (node-testable).
//
// Undo keeps whole-document snapshots: part records with their own position/turn/scale and a reference to the
// geometry. Geometries are never changed in place (a mesh operation makes a new one), so a snapshot stays valid; a
// geometry is disposed once neither the document nor any kept snapshot refers to it. History is capped by steps and
// by the bytes of the geometries only history keeps alive.
import * as THREE from 'three';

let nextId = 1;
const v3 = (v) => (v ? v.clone() : new THREE.Vector3());

// kind: how the part was made ('param' rules, 'ai' mesh, 'lite' draft, 'profile' revolved); params: what rebuilds it
// (a profile part: { profile: { points, hollow, wall, segments } }), replaced as a whole, never changed in place
export function makePart({ name = 'part', geometry, position, quaternion, scale, visible = true, role = '', kind = 'param', params = null }) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  return {
    id: nextId++, name, geometry, role, kind, visible, params,
    position: v3(position), quaternion: quaternion ? quaternion.clone() : new THREE.Quaternion(),
    scale: scale ? scale.clone() : new THREE.Vector3(1, 1, 1),
  };
}

// a geometry in model coordinates -> a copy centred on its box, and that centre (where the part sits)
export function centred(geometry) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const c = geometry.boundingBox.getCenter(new THREE.Vector3());
  const g = geometry.clone();
  g.translate(-c.x, -c.y, -c.z);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return { geometry: g, centre: c };
}

export const geometryBytes = (g) => {
  let n = g.index ? g.index.array.byteLength : 0;
  for (const a of Object.values(g.attributes)) n += a.array.byteLength;
  return n;
};

export class Doc {
  constructor() {
    this.parts = [];
    this.source = null; // 'param' | 'ai' | 'lite' | null
    this.edited = false; // the user changed parts by hand since the last build
    this.version = 0;
    // the model's own frame (model -> document; turning, scaling and the floor move it), its mirror plane in that
    // frame (x = at) and the mirror pairs the user confirmed ([[idA, idB]]); see assembly.js
    this.frame = new THREE.Matrix4();
    this.mirrorPlane = null;
    this.pairs = [];
  }

  // items from a generator: [{ name, geometry (cm, z up, model coordinates), role }]
  load(items, source) {
    this.parts = items.map((it) => {
      const { geometry, centre } = centred(it.geometry);
      return makePart({ name: it.name, geometry, position: centre, role: it.role || '', kind: it.kind || source, params: it.params || null });
    });
    this.source = source;
    this.edited = false;
    this.version++;
    this.frame = new THREE.Matrix4();
    const b = this.bounds(true);
    this.mirrorPlane = { at: b.isEmpty() ? 0 : (b.min.x + b.max.x) / 2 };
    this.pairs = [];
  }

  clear() { this.parts = []; this.source = null; this.edited = false; this.version++; this.frame = new THREE.Matrix4(); this.mirrorPlane = null; this.pairs = []; }

  part(id) { return this.parts.find((p) => p.id === id) || null; }

  matrixOf(p) { return new THREE.Matrix4().compose(p.position, p.quaternion, p.scale); }

  // the part's box in model space (cm, z up), from its vertices (a turned box of the local box would count the empty
  // corners around a round part); kept until the part's geometry or placement changes
  worldBox(p) {
    const m = this.matrixOf(p);
    const key = m.elements.join(',');
    if (p._box && p._box.geometry === p.geometry && p._box.key === key) return p._box.box.clone();
    const a = p.geometry.attributes.position.array;
    const e = m.elements;
    const box = new THREE.Box3();
    let x0 = Infinity; let y0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let y1 = -Infinity; let z1 = -Infinity;
    for (let i = 0; i < a.length; i += 3) {
      const x = a[i]; const y = a[i + 1]; const z = a[i + 2];
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12]; const wy = e[1] * x + e[5] * y + e[9] * z + e[13]; const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
      if (wx < x0) x0 = wx; if (wx > x1) x1 = wx; if (wy < y0) y0 = wy; if (wy > y1) y1 = wy; if (wz < z0) z0 = wz; if (wz > z1) z1 = wz;
    }
    if (x0 <= x1) box.set(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
    p._box = { geometry: p.geometry, key, box };
    return box.clone();
  }

  bounds(all = false) {
    const b = new THREE.Box3();
    for (const p of this.parts) if (all || p.visible) b.union(this.worldBox(p));
    return b;
  }

  // what export writes: each visible part's geometry with its placement baked in (cm, z up)
  // a mirrored part (negative determinant) has its triangles turned back, so its faces still point outwards
  exportItems() {
    return this.parts.filter((p) => p.visible).map((p) => {
      const m = this.matrixOf(p);
      const geometry = p.geometry.clone().applyMatrix4(m);
      if (m.determinant() < 0) {
        if (geometry.index) {
          const ix = geometry.index.array;
          for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
          geometry.index.needsUpdate = true;
        } else {
          for (const attr of Object.values(geometry.attributes)) {
            const a = attr.array; const n = attr.itemSize;
            for (let i = 0; i < attr.count; i += 3) for (let k = 0; k < n; k++) { const t = a[(i + 1) * n + k]; a[(i + 1) * n + k] = a[(i + 2) * n + k]; a[(i + 2) * n + k] = t; }
          }
        }
        if (geometry.attributes.normal) geometry.computeVertexNormals();
      }
      return { name: p.name, role: p.role, geometry };
    });
  }

  snapshot() {
    return {
      source: this.source, edited: this.edited,
      frame: this.frame.clone(), mirrorPlane: this.mirrorPlane, pairs: this.pairs.map((x) => x.slice()),
      parts: this.parts.map((p) => ({ ...p, _box: null, position: p.position.clone(), quaternion: p.quaternion.clone(), scale: p.scale.clone() })),
    };
  }

  restore(s) {
    this.parts = s.parts.map((p) => ({ ...p, _box: null, position: p.position.clone(), quaternion: p.quaternion.clone(), scale: p.scale.clone() }));
    this.source = s.source;
    this.edited = s.edited;
    this.frame = s.frame ? s.frame.clone() : new THREE.Matrix4();
    this.mirrorPlane = s.mirrorPlane || null;
    this.pairs = s.pairs ? s.pairs.map((x) => x.slice()) : [];
    this.version++;
  }

  geometries() { return new Set(this.parts.map((p) => p.geometry)); }

  // ---- edits (the caller records them in History)
  add(part) { this.parts.push(part); this.edited = true; return part; }

  remove(ids) {
    const set = new Set([].concat(ids));
    this.parts = this.parts.filter((p) => !set.has(p.id));
    this.pairs = this.pairs.filter(([a, b]) => !set.has(a) && !set.has(b));
    this.edited = true;
  }

  duplicate(id, offset = new THREE.Vector3(10, 10, 0)) {
    const p = this.part(id);
    if (!p) return null;
    const q = makePart({ ...p, name: `${p.name} 2`, position: p.position.clone().add(offset) });
    q.geometry = p.geometry; // shared: geometries are never changed in place
    const at = this.parts.indexOf(p);
    this.parts.splice(at + 1, 0, q);
    this.edited = true;
    return q;
  }

  // mirror a part across the model's centre plane x = cx (a negative scale; SketchUp shows it as a flipped group)
  mirror(id, axis = 'x') {
    const p = this.part(id);
    if (!p) return;
    const c = this.bounds(true).getCenter(new THREE.Vector3());
    p.position[axis] = 2 * c[axis] - p.position[axis];
    p.scale[axis] = -p.scale[axis];
    this.edited = true;
  }

  // a new geometry for a part (mesh operations), given in the part's own frame; it is centred again and the part
  // moves by that shift, so nothing jumps. The old geometry stays for undo.
  setGeometry(id, geometry, keepWorld = true) {
    const p = this.part(id);
    if (!p) return;
    const { geometry: g, centre } = centred(geometry);
    if (keepWorld) p.position.add(centre.multiply(p.scale).applyQuaternion(p.quaternion));
    p.geometry = g;
    this.edited = true;
  }

  // parts made from one (a cut, a split), geometries in the part's own frame: the first replaces it, the others
  // follow it, each keeping its place in the model
  replace(id, geometries, names) {
    const p = this.part(id);
    if (!p) return [];
    const at = this.parts.indexOf(p);
    const made = geometries.map((geo, k) => {
      const { geometry, centre } = centred(geo);
      const pos = p.position.clone().add(centre.multiply(p.scale).applyQuaternion(p.quaternion));
      return makePart({ name: names ? names[k] : `${p.name} ${k + 1}`, geometry, position: pos, quaternion: p.quaternion, scale: p.scale, role: p.role, kind: p.kind });
    });
    this.parts.splice(at, 1, ...made);
    this.pairs = this.pairs.filter(([a, b]) => a !== id && b !== id);
    this.edited = true;
    return made;
  }

  // the whole model: turn about the vertical through its centre, or about x / y by 90°, then back on the floor
  turnAll(axis, degrees) {
    const c = this.bounds(true).getCenter(new THREE.Vector3());
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0), THREE.MathUtils.degToRad(degrees));
    for (const p of this.parts) {
      p.position.sub(c).applyQuaternion(q).add(c);
      p.quaternion.premultiply(q);
    }
    this.moveFrame(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z)));
    this.onFloor();
    this.edited = true;
  }

  // the whole model scaled about its bottom centre, so that a measured side has its real length
  scaleAll(k) {
    const b = this.bounds(true);
    const o = new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.min.z);
    for (const p of this.parts) {
      p.position.sub(o).multiplyScalar(k).add(o);
      p.scale.multiplyScalar(k);
    }
    this.moveFrame(new THREE.Matrix4().makeTranslation(o.x, o.y, o.z).multiply(new THREE.Matrix4().makeScale(k, k, k)).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z)));
    this.edited = true;
  }

  // the lowest point on the floor (z = 0), centred on the origin in plan
  onFloor() {
    const b = this.bounds(true);
    if (b.isEmpty()) return;
    const d = new THREE.Vector3(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
    for (const p of this.parts) p.position.add(d);
    this.moveFrame(new THREE.Matrix4().makeTranslation(d.x, d.y, d.z));
  }

  // the whole model moved by m: its frame (and so its mirror plane) moves with it (a new matrix: snapshots keep theirs)
  moveFrame(m) { this.frame = m.clone().multiply(this.frame); }
}

export class History {
  constructor({ maxSteps = 50, maxBytes = 300e6 } = {}) {
    this.undoStack = [];
    this.redoStack = [];
    this.maxSteps = maxSteps;
    this.maxBytes = maxBytes;
    this.known = new Set(); // every geometry the document or history has held
  }

  // runs fn (which edits doc) as one undoable step; merge: steps with this label within 1.5 s count as one (typing a
  // size digit by digit)
  record(doc, label, fn, { merge = false } = {}) {
    const top = this.undoStack[this.undoStack.length - 1];
    if (merge && top && top.label === label && Date.now() - top.time < 1500) {
      const out = fn();
      for (const g of doc.geometries()) this.known.add(g);
      top.time = Date.now();
      this.redoStack = [];
      return out;
    }
    const before = doc.snapshot();
    for (const g of doc.geometries()) this.known.add(g);
    const out = fn();
    for (const g of doc.geometries()) this.known.add(g);
    this.undoStack.push({ label, snap: before, time: Date.now() });
    this.redoStack = [];
    this.trim(doc);
    return out;
  }

  // the document's current geometries become history's to dispose (call before a load that is not recorded)
  adopt(doc) { for (const g of doc.geometries()) this.known.add(g); }

  // a step whose edit already happened (a drag with the mouse): its "before" snapshot was taken when it began
  push(doc, label, before) {
    for (const p of before.parts) this.known.add(p.geometry);
    for (const g of doc.geometries()) this.known.add(g);
    this.undoStack.push({ label, snap: before });
    this.redoStack = [];
    this.trim(doc);
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo(doc) {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ label: e.label, snap: doc.snapshot() });
    doc.restore(e.snap);
    return e.label;
  }

  redo(doc) {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ label: e.label, snap: doc.snapshot() });
    doc.restore(e.snap);
    return e.label;
  }

  clear(doc) { this.undoStack = []; this.redoStack = []; this.collect(doc); }

  // bytes of geometries only history keeps alive
  heldBytes(doc) {
    const live = doc.geometries();
    const held = new Set();
    for (const e of this.undoStack.concat(this.redoStack)) for (const p of e.snap.parts) if (!live.has(p.geometry)) held.add(p.geometry);
    let n = 0;
    for (const g of held) n += geometryBytes(g);
    return n;
  }

  trim(doc) {
    while (this.undoStack.length > this.maxSteps || (this.undoStack.length > 1 && this.heldBytes(doc) > this.maxBytes)) this.undoStack.shift();
    this.collect(doc);
  }

  // disposes geometries nothing refers to any more
  collect(doc) {
    const used = doc.geometries();
    for (const e of this.undoStack.concat(this.redoStack)) for (const p of e.snap.parts) used.add(p.geometry);
    for (const g of this.known) {
      if (used.has(g)) continue;
      g.dispose();
      this.known.delete(g);
    }
  }
}
