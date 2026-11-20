// Editing the model by hand: click a part (or pick it in the list) to select it; move, turn and scale it with the
// gizmo (1 cm, 5° snaps) or with numbers (cm, degrees); duplicate, mirror, hide, delete; turn the whole model or set
// it on the floor. Every change is one undoable step (History); the gizmo records a drag when it ends.
import * as THREE from 'three';
import { TransformControls } from '../vendor/three/addons/controls/TransformControls.js';
import { fromGeometry, cleanup, taubin, simplify, splitPieces, cutPlane, lassoSplit } from './meshops.js';
import { partGeometry } from './mesh.js';
import { revolve, radiusAt } from './profile.js';
import { suggestPairs, mirrorChange, matricesFor, partnerOf, snapOffset } from './assembly.js';

const fill = (s, o) => String(s).replace(/\{(\w+)\}/g, (_, k) => (o[k] == null ? '' : o[k]));
// plain arrays back to a geometry with creased normals (as the builder's parts)
const toGeometry = (m) => partGeometry({ pos: m.pos, tris: m.tris });

const $ = (s) => document.querySelector(s);
const num = (v) => {
  const s = String(v).replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 0x0660).replace(/[۰-۹]/g, (c) => c.charCodeAt(0) - 0x06F0).replace(/[٫,]/g, '.');
  const x = parseFloat(s);
  return Number.isFinite(x) ? x : null;
};
const round1 = (x) => Math.round(x * 10) / 10;

export class Editor {
  // t(key) -> text, nf(number) -> local digits, onChange(kind) after every change ('edit', 'live', 'select')
  constructor({ viewer, doc, history, t, nf, onChange = () => {} }) {
    this.viewer = viewer;
    this.doc = doc;
    this.history = history;
    this.t = t;
    this.nf = nf;
    this.onChange = onChange;
    this.sel = new Set();
    this.mode = 'translate';
    this.linkOn = true; // edits reach confirmed mirror twins
    this.snapDist = 2; // cm; 0 = off
    this.altDown = false;
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', (e) => { if (e.key === 'Alt') this.altDown = true; });
      window.addEventListener('keyup', (e) => { if (e.key === 'Alt') this.altDown = false; });
      window.addEventListener('blur', () => { this.altDown = false; });
    }
    if (!viewer.ok) return;
    const tc = new TransformControls(viewer.camera, viewer.canvas);
    tc.setSize(0.85);
    tc.setTranslationSnap(1); // the gizmo snaps the part's own position, which is in cm
    tc.setRotationSnap(THREE.MathUtils.degToRad(5));
    tc.setSpace('local');
    viewer.scene.add(tc.getHelper());
    tc.addEventListener('change', () => viewer.request());
    tc.addEventListener('dragging-changed', (e) => {
      viewer.controls.enabled = !e.value;
      if (e.value) {
        this.dragBefore = doc.snapshot();
        const mesh = tc.object;
        this.dragMats = mesh && this.linkOn ? matricesFor(doc, mesh.userData.partId) : null;
        this.snapPrev = null;
      } else { this.showSnap([]); this.endDrag(); }
    });
    tc.addEventListener('objectChange', () => {
      const mesh = tc.object;
      const p = mesh && doc.part(mesh.userData.partId);
      if (!p) return;
      p.position.copy(mesh.position);
      p.quaternion.copy(mesh.quaternion);
      p.scale.copy(mesh.scale);
      // box snapping while moving (Alt held: free); the twin and hidden parts are not targets
      if (this.mode === 'translate' && this.snapDist > 0 && !this.altDown) {
        const twin = partnerOf(doc, p.id);
        const others = doc.parts.filter((q) => q.visible && q.id !== p.id && q.id !== twin).map((q) => ({ id: q.id, box: doc.worldBox(q) }));
        const r = snapOffset(doc.worldBox(p), others, this.snapDist, this.snapPrev);
        this.snapPrev = r.targets;
        if (r.offset.lengthSq() > 0) { p.position.add(r.offset); mesh.position.copy(p.position); }
        this.showSnap(r.targets.map((t) => others.find((o) => o.id === t.id).box));
      } else this.showSnap([]);
      // the confirmed twin follows, mirrored
      if (this.dragMats) {
        const q = mirrorChange(doc, p.id, this.dragMats);
        const qm = q && viewer.meshOf(q.id);
        if (qm) { qm.position.copy(q.position); qm.quaternion.copy(q.quaternion); qm.scale.copy(q.scale); }
      }
      this.paintFields();
      this.onChange('live');
    });
    this.tc = tc;
    // a click (not a drag) picks the part under the pointer; Shift adds or removes it
    let down = null;
    viewer.canvas.addEventListener('pointerdown', (e) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; });
    viewer.canvas.addEventListener('pointerup', (e) => {
      if (!down || tc.dragging || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down = null; return; }
      down = null;
      const id = this.pick(e.clientX, e.clientY);
      if (id == null) { if (!e.shiftKey) this.select([]); return; }
      if (e.shiftKey) { const s = new Set(this.sel); if (s.has(id)) s.delete(id); else s.add(id); this.select([...s]); } else this.select([id]);
    });
    this.bindUI();
  }

  pick(x, y) {
    const r = this.viewer.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.viewer.camera);
    const hit = ray.intersectObjects(this.viewer.docMeshes(), false)[0];
    return hit ? hit.object.userData.partId : null;
  }

  // ---- state
  select(ids) {
    this.sel = new Set(ids.filter((id) => this.doc.part(id)));
    this.attach();
    this.refresh();
    this.onChange('select');
  }

  attach() {
    if (!this.tc) return;
    const one = this.sel.size === 1 ? this.viewer.meshOf([...this.sel][0]) : null;
    if (one && one.visible) { this.tc.attach(one); this.tc.setMode(this.mode); } else this.tc.detach();
  }

  setMode(mode) {
    this.mode = mode;
    if (this.tc) this.tc.setMode(mode);
    for (const b of document.querySelectorAll('#tools [data-mode]')) b.classList.toggle('on', b.dataset.mode === mode);
  }

  // after the document changed under the editor (a new build, undo, redo)
  refresh(frame = false) {
    for (const id of [...this.sel]) if (!this.doc.part(id)) this.sel.delete(id);
    this.viewer.showDoc(this.doc, frame, this.sel);
    this.attach();
    this.paintList();
    this.paintFields();
    this.paintTools();
    this.paintProfile();
    this.paintPairs();
  }

  step(label, fn) {
    this.history.record(this.doc, label, () => { fn(); this.doc.edited = true; });
    this.refresh();
    this.onChange('edit');
  }

  endDrag() {
    if (!this.dragBefore) return;
    this.history.push(this.doc, this.mode, this.dragBefore);
    this.dragBefore = null;
    this.doc.edited = true;
    this.refresh();
    this.onChange('edit');
  }

  undo() { if (this.history.undo(this.doc)) { this.refresh(); this.onChange('edit'); } }
  redo() { if (this.history.redo(this.doc)) { this.refresh(); this.onChange('edit'); } }

  // ---- operations on the selection
  ids() { return [...this.sel]; }
  remove() { const ids = this.ids(); if (!ids.length) return; this.step('delete', () => this.doc.remove(ids)); this.select([]); }
  duplicate() {
    const ids = this.ids();
    if (!ids.length) return;
    let made = [];
    this.step('duplicate', () => { made = ids.map((id) => this.doc.duplicate(id)).filter(Boolean); });
    this.select(made.map((p) => p.id));
  }
  mirror() { const ids = this.ids(); if (ids.length) this.step('mirror', () => ids.forEach((id) => this.doc.mirror(id))); }
  hide() { const ids = this.ids(); if (!ids.length) return; this.step('hide', () => ids.forEach((id) => { this.doc.part(id).visible = false; })); this.select([]); }
  showAll() { if (this.doc.parts.some((p) => !p.visible)) this.step('show', () => this.doc.parts.forEach((p) => { p.visible = true; })); }
  turnAll(axis, deg) { if (this.doc.parts.length) this.step('turn', () => this.doc.turnAll(axis, deg)); }
  onFloor() { if (this.doc.parts.length) this.step('floor', () => this.doc.onFloor()); }

  // numbers for the one selected part: position (its centre, cm), turn about the vertical (°), size (cm)
  fields() {
    if (this.sel.size !== 1) return null;
    const p = this.doc.part([...this.sel][0]);
    if (!p) return null;
    const s = p.geometry.boundingBox.getSize(new THREE.Vector3());
    const e = new THREE.Euler().setFromQuaternion(p.quaternion, 'ZYX');
    return { p, x: p.position.x, y: p.position.y, z: p.position.z, r: THREE.MathUtils.radToDeg(e.z),
      w: Math.abs(s.x * p.scale.x), d: Math.abs(s.y * p.scale.y), h: Math.abs(s.z * p.scale.z), size: s };
  }

  setField(key, value) {
    const f = this.fields();
    const v = num(value);
    if (!f || v == null) return;
    const { p, size } = f;
    if ((key === 'w' || key === 'd' || key === 'h') && v <= 0) return;
    const before = this.linkOn ? matricesFor(this.doc, p.id) : null;
    this.step(key, () => {
      this.applyField(key, v, p, size);
      if (before) mirrorChange(this.doc, p.id, before);
    });
  }

  applyField(key, v, p, size) {
    if (key === 'x' || key === 'y' || key === 'z') p.position[key] = v;
    else if (key === 'r') {
      const e = new THREE.Euler().setFromQuaternion(p.quaternion, 'ZYX');
      e.z = THREE.MathUtils.degToRad(v);
      p.quaternion.setFromEuler(e);
    } else {
      // the side's new length over its present one; with "keep proportions" every side grows alike
      const axis = { w: 'x', d: 'y', h: 'z' }[key];
      const k = v / Math.max(1e-6, Math.abs(size[axis] * p.scale[axis]));
      if (this.keepRatio) p.scale.multiplyScalar(k); else p.scale[axis] *= k;
    }
  }

  // ---- mirror pairs (assembly.js): suggested, confirmed by the user, unlinked one by one
  suggested() { return this.doc.parts.length > 1 ? suggestPairs(this.doc) : []; }
  linkSuggested() {
    const s = this.suggested();
    if (!s.length) return;
    this.step('pair', () => { this.doc.pairs = [...this.doc.pairs, ...s]; });
    this.say(fill(this.t('pairsLinked'), { n: this.nf(s.length) }));
  }
  unlink() {
    const p = this.onePart();
    if (!p || partnerOf(this.doc, p.id) == null) return;
    this.step('unpair', () => { this.doc.pairs = this.doc.pairs.filter((pr) => !pr.includes(p.id)); });
  }
  paintPairs() {
    const box = $('#pairBox');
    if (!box) return;
    box.hidden = this.doc.parts.length < 2;
    if (box.hidden) return;
    const s = this.suggested();
    const btn = $('#pairFind');
    btn.disabled = !s.length;
    btn.textContent = fill(this.t(s.length ? 'pairFind' : 'pairNone'), { n: this.nf(s.length) });
    const p = this.onePart();
    const twin = p ? partnerOf(this.doc, p.id) : null;
    $('#pairOf').hidden = twin == null;
    $('#pairUnlink').hidden = twin == null;
    if (twin != null) $('#pairOf').textContent = fill(this.t('pairOf'), { n: this.doc.part(twin).name });
    $('#pairCount').textContent = fill(this.t('pairCount'), { n: this.nf(this.doc.pairs.length) });
    $('#pairLink').checked = this.linkOn;
  }

  // the target boxes of a snap, outlined while dragging
  showSnap(boxes) {
    if (!this.viewer.ok) return;
    if (!this.snapMarks) this.snapMarks = [];
    while (this.snapMarks.length > boxes.length) { const m = this.snapMarks.pop(); this.viewer.scene.remove(m); m.geometry.dispose(); }
    boxes.forEach((b, i) => {
      if (!this.snapMarks[i]) { const m = new THREE.Box3Helper(new THREE.Box3(), 0xff6a3d); m.userData.keep = true; this.viewer.scene.add(m); this.snapMarks[i] = m; }
      this.snapMarks[i].box.copy(b).expandByScalar(0.3);
    });
    this.viewer.request();
  }


  // ---- shape tools on one part (its geometry in its own frame; the result replaces it as one undoable step)
  onePart() { return this.sel.size === 1 ? this.doc.part([...this.sel][0]) : null; }

  meshOp(label, fn) {
    const p = this.onePart();
    if (!p) { this.say(this.t('pickOne')); return; }
    const m = fromGeometry(p.geometry);
    const out = fn(m);
    if (!out || !out.tris.length) { this.say(this.t('opNothing')); return; }
    this.step(label, () => this.doc.setGeometry(p.id, toGeometry(out)));
    this.say(fill(this.t('opDone'), { n: this.nf(out.tris.length / 3) }));
  }

  cleanPart() { this.meshOp('clean', (m) => cleanup(m.pos, m.tris, { sheet: true })); }
  smoothPart() { this.meshOp('smooth', (m) => taubin(m.pos, m.tris, 4)); }
  lighterPart() { this.meshOp('simplify', (m) => simplify(m.pos, m.tris, Math.max(500, Math.round(m.tris.length / 3 / 2)))); }

  splitPart() {
    const p = this.onePart();
    if (!p) { this.say(this.t('pickOne')); return; }
    const m = fromGeometry(p.geometry);
    const pieces = splitPieces(m.pos, m.tris, 8); // crumbs under 8 triangles go together into the last part
    if (pieces.length < 2) { this.say(this.t('splitOne')); return; }
    let made = [];
    this.step('split', () => { made = this.doc.replace(p.id, pieces.map(toGeometry), pieces.map((_, k) => `${p.name} ${k + 1}`)); });
    this.select(made.map((q) => q.id));
    this.say(fill(this.t('splitDone'), { n: this.nf(pieces.length) }));
  }

  // the cutting plane: across the model's x, y or z, through the part; at = 0..1 across the part's box
  startCut(axis = 'z') {
    const p = this.onePart();
    if (!p) { this.say(this.t('pickOne')); return; }
    this.cut = { id: p.id, axis, at: 0.5 };
    if (!this.cutMesh) {
      this.cutMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xff6a3d, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
      this.cutMesh.renderOrder = 5;
      this.cutMesh.userData.keep = true;
      this.viewer.model.add(this.cutMesh);
    }
    $('#cutBox').hidden = false;
    $('#cutAt').value = '50';
    for (const b of document.querySelectorAll('#cutBox [data-axis]')) b.classList.toggle('on', b.dataset.axis === axis);
    this.paintCut();
  }

  paintCut() {
    const c = this.cut;
    if (!c || !this.cutMesh) return;
    const p = this.doc.part(c.id);
    if (!p) { this.endCut(); return; }
    const b = this.doc.worldBox(p);
    const size = b.getSize(new THREE.Vector3());
    const ctr = b.getCenter(new THREE.Vector3());
    const k = { x: 0, y: 1, z: 2 }[c.axis];
    const pos = b.min.getComponent(k) + c.at * size.getComponent(k);
    const m = this.cutMesh;
    m.visible = true;
    m.position.copy(ctr).setComponent(k, pos);
    m.rotation.set(0, 0, 0);
    if (c.axis === 'x') m.rotation.y = Math.PI / 2;
    if (c.axis === 'y') m.rotation.x = Math.PI / 2;
    const pad = 1.25;
    const [u, v] = c.axis === 'x' ? [size.z, size.y] : c.axis === 'y' ? [size.x, size.z] : [size.x, size.y];
    m.scale.set(Math.max(u, 1) * pad, Math.max(v, 1) * pad, 1);
    c.world = pos;
    this.viewer.request();
  }

  endCut() {
    this.cut = null;
    if (this.cutMesh) this.cutMesh.visible = false;
    if ($('#cutBox')) $('#cutBox').hidden = true;
    this.viewer.request();
  }

  // the plane n·x = d in the model, carried into the part's own frame: (S Rᵀ n)·x = d - n·P, then normalised
  applyCut() {
    const c = this.cut;
    const p = c && this.doc.part(c.id);
    if (!p) return;
    const n = new THREE.Vector3(c.axis === 'x' ? 1 : 0, c.axis === 'y' ? 1 : 0, c.axis === 'z' ? 1 : 0);
    const nl = n.clone().applyQuaternion(p.quaternion.clone().invert()).multiply(p.scale);
    const len = nl.length();
    const dl = (c.world - n.dot(p.position)) / len;
    nl.divideScalar(len);
    const m = fromGeometry(p.geometry);
    const { above, below } = cutPlane(m.pos, m.tris, [nl.x, nl.y, nl.z], dl);
    if (!above.tris.length || !below.tris.length) { this.say(this.t('cutEmpty')); return; }
    let made = [];
    this.step('cut', () => { made = this.doc.replace(p.id, [toGeometry(below), toGeometry(above)], [`${p.name} ${this.t('cutLow')}`, `${p.name} ${this.t('cutHigh')}`]); });
    this.endCut();
    this.select(made.map((q) => q.id));
    this.say(this.t('cutDone'));
  }

  // the lasso: draw around a region of the selected part on the screen; what falls inside becomes its own part
  startLasso() {
    const p = this.onePart();
    if (!p) { this.say(this.t('pickOne')); return; }
    const svg = $('#lasso');
    svg.removeAttribute('hidden'); // an SVG element has no hidden property: the attribute is what CSS sees
    this.viewer.controls.enabled = false;
    if (this.tc) this.tc.detach();
    this.say(this.t('lassoHint'));
    const pts = [];
    const line = svg.querySelector('polyline');
    line.setAttribute('points', '');
    const r = () => svg.getBoundingClientRect();
    const onDown = (e) => { pts.length = 0; svg.setPointerCapture(e.pointerId); add(e); };
    const add = (e) => { const b = r(); pts.push([e.clientX - b.left, e.clientY - b.top]); line.setAttribute('points', pts.map((q) => q.join(',')).join(' ')); };
    const onMove = (e) => { if (e.buttons) add(e); };
    const onUp = () => {
      svg.removeEventListener('pointerdown', onDown); svg.removeEventListener('pointermove', onMove); svg.removeEventListener('pointerup', onUp);
      const b = r(); // before hiding: a hidden overlay has no position
      svg.setAttribute('hidden', '');
      this.viewer.controls.enabled = true;
      if (pts.length >= 3) this.lassoCut(p.id, pts.map(([x, y]) => [x + b.left, y + b.top]));
      else this.attach();
    };
    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    this.cancelLasso = () => { onUp(); };
  }

  lassoCut(id, polygon) {
    const p = this.doc.part(id);
    const mesh = this.viewer.meshOf(id);
    if (!p || !mesh) return;
    mesh.updateMatrixWorld(true);
    const toWorld = mesh.matrixWorld;
    const cam = this.viewer.camera;
    const rect = this.viewer.canvas.getBoundingClientRect();
    const v = new THREE.Vector3();
    const project = (x, y, z) => {
      v.set(x, y, z).applyMatrix4(toWorld).project(cam);
      return [rect.left + (v.x + 1) / 2 * rect.width, rect.top + (1 - v.y) / 2 * rect.height];
    };
    const through = $('#lassoThrough') && $('#lassoThrough').checked;
    const eye = through ? null : cam.position.clone().applyMatrix4(toWorld.clone().invert()).toArray();
    const m = fromGeometry(p.geometry);
    const { inside, outside } = lassoSplit(m.pos, m.tris, polygon, project, eye);
    if (!inside.tris.length || !outside.tris.length) { this.say(this.t('lassoEmpty')); this.attach(); return; }
    let made = [];
    this.step('lasso', () => { made = this.doc.replace(p.id, [toGeometry(outside), toGeometry(inside)], [p.name, `${p.name} ${this.t('lassoPart')}`]); });
    this.select([made[1].id]);
    this.say(this.t('lassoDone'));
  }


  // ---- the profile panel: a revolved part keeps its outline (points from bottom to top, cm); dragging a point or
  // changing a number rebuilds it exactly, as one undoable step, standing where it stood. The outline it was read from
  // shows faintly behind; a locked point (shift+click) does not move with the numbers and cannot be dragged or removed;
  // "reset" brings back the profile as extracted.
  profilePart() { const p = this.onePart(); return p && p.params && p.params.profile ? p : null; }

  setProfile(p, profile, label = 'profile') {
    const oldH = p.params.profile.points[p.params.profile.points.length - 1].z;
    const m = revolve(profile.points, profile);
    const g = toGeometry(m);
    g.translate(0, 0, -oldH / 2); // the old part's own frame (its centre was half its height up)
    this.step(label, () => { this.doc.setGeometry(p.id, g); p.params = { ...p.params, profile }; });
  }

  paintProfile() {
    const box = $('#profileBox');
    if (!box) return;
    const p = this.profilePart();
    box.hidden = !p;
    if (!p) return;
    const pr = p.params.profile;
    const pts = pr.points;
    const locked = new Set(pr.locked || []);
    const H = pts[pts.length - 1].z;
    const ref = [...pts, ...(pr.outline || [])];
    const R = Math.max(...ref.map((q) => q.r)) * 1.15 || 1;
    const Hmax = Math.max(H, ...(pr.outline || []).map((q) => q.z));
    const W = 240; const Hs = 240; const pad = 12;
    const sx = (r) => W / 2 + (r / R) * (W / 2 - pad);
    const sy = (z) => Hs - pad - (z / Hmax) * (Hs - 2 * pad);
    const svg = $('#profileSvg');
    svg.setAttribute('viewBox', `0 0 ${W} ${Hs}`);
    const poly = (list) => `${list.map((q) => `${sx(q.r)},${sy(q.z)}`).join(' ')} ${list.map((q) => `${W - sx(q.r)},${sy(q.z)}`).reverse().join(' ')}`;
    svg.innerHTML = `<line x1="${W / 2}" y1="${pad / 2}" x2="${W / 2}" y2="${Hs - pad / 2}" class="axis"/>`
      + (pr.outline && pr.outline.length > 2 ? `<polygon points="${poly(pr.outline.slice().sort((a, b) => a.z - b.z))}" class="seen"/>` : '')
      + `<polygon points="${poly(pts)}" class="body"/>`
      + pts.map((q, i) => `<circle cx="${sx(q.r)}" cy="${sy(q.z)}" r="6" data-i="${i}" class="pt${locked.has(i) ? ' locked' : ''}"/>`).join('');
    const f = (v) => String(Math.round(v * 10) / 10);
    const sxy = Math.abs(p.scale.x); const sz = Math.abs(p.scale.z);
    const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = f(v); };
    set('#prH', H * sz);
    set('#prD', 2 * Math.max(...pts.map((q) => q.r)) * sxy);
    set('#prTop', 2 * pts[pts.length - 1].r * sxy);
    set('#prBase', 2 * pts[0].r * sxy);
    set('#prWall', pr.wall);
    $('#prSeg').value = String(pr.segments || 64);
    $('#prHollow').checked = !!pr.hollow;
    $('#prWall').disabled = !pr.hollow;
    $('#prReset').disabled = !pr.extracted || JSON.stringify(pr.extracted) === JSON.stringify(pts);
    const above = pr.camera && pr.camera.view === 'above';
    $('#prSideNote').textContent = above ? fill(this.t('prAbove'), { d: this.nf(pr.camera.elevDeg) }) : this.t('prSide');
    // the other reading of the photo (side view / seen from above), when the outline offers one
    const swap = $('#prSwap');
    swap.hidden = !pr.alt;
    if (pr.alt) swap.textContent = pr.alt.camera.view === 'above' ? fill(this.t('prSwapAbove'), { d: this.nf(pr.alt.camera.elevDeg) }) : this.t('prSwapSide');
    for (const c of svg.querySelectorAll('.pt')) {
      const i = Number(c.dataset.i);
      c.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (e.shiftKey) { // lock or unlock this point
          const next = new Set(locked); if (next.has(i)) next.delete(i); else next.add(i);
          this.setProfile(p, { ...pr, locked: [...next] }, 'lock');
          return;
        }
        if (locked.has(i)) { this.say(this.t('prLocked')); return; }
        const rect = svg.getBoundingClientRect();
        const k = W / rect.width;
        c.setPointerCapture(e.pointerId);
        const at = (ev) => {
          const x = (ev.clientX - rect.left) * k; const y = (ev.clientY - rect.top) * k;
          const r = Math.max(0, ((x - W / 2) / (W / 2 - pad)) * R);
          let z = ((Hs - pad - y) / (Hs - 2 * pad)) * Hmax;
          if (i === 0) z = 0; else if (i === pts.length - 1) z = Math.max(pts[i - 1].z + 0.5, z); // the top may grow
          else z = Math.min(pts[i + 1].z - 0.5, Math.max(pts[i - 1].z + 0.5, z));
          return { z: Math.round(z * 10) / 10, r: Math.round(r * 10) / 10 };
        };
        const move = (ev) => { const q = at(ev); c.setAttribute('cx', sx(q.r)); c.setAttribute('cy', sy(q.z)); };
        const up = (ev) => {
          c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up);
          const next = pts.slice(); next[i] = at(ev);
          if (next[i].z === pts[i].z && next[i].r === pts[i].r) return;
          this.setProfile(p, { ...pr, points: next });
        };
        c.addEventListener('pointermove', move);
        c.addEventListener('pointerup', up);
      });
      c.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (i === 0 || i === pts.length - 1 || pts.length <= 3 || locked.has(i)) return;
        const keep = [...locked].filter((j) => j !== i).map((j) => (j > i ? j - 1 : j));
        this.setProfile(p, { ...pr, points: pts.filter((_, j) => j !== i), locked: keep });
      });
    }
  }

  // a new point on the outline at the height clicked (between its neighbours)
  addProfilePoint(e) {
    const p = this.profilePart();
    if (!p || e.target.classList.contains('pt')) return;
    const pr = p.params.profile; const pts = pr.points;
    const svg = $('#profileSvg'); const rect = svg.getBoundingClientRect();
    const W = 240; const Hs = 240; const pad = 12; const k = W / rect.width;
    const H = pts[pts.length - 1].z;
    const Hmax = Math.max(H, ...(pr.outline || []).map((q) => q.z));
    const z = ((Hs - pad - (e.clientY - rect.top) * k) / (Hs - 2 * pad)) * Hmax;
    if (z <= 0.5 || z >= H - 0.5) return;
    const at = pts.findIndex((q) => q.z > z);
    const r = radiusAt(pts, z);
    const next = pts.slice(); next.splice(at, 0, { z: Math.round(z * 10) / 10, r: Math.round(r * 10) / 10 });
    const locked = (pr.locked || []).map((j) => (j >= at ? j + 1 : j));
    this.setProfile(p, { ...pr, points: next, locked });
  }

  // named numbers: height and widest diameter scale the unlocked points; the top (mouth) and base diameters move only
  // their own point; wall and segments rebuild
  setProfileNumber(key, value) {
    const p = this.profilePart();
    const v = num(value);
    if (!p || v == null || v <= 0) return;
    const pr = p.params.profile; const pts = pr.points; const locked = new Set(pr.locked || []);
    const H = pts[pts.length - 1].z; const sxy = Math.abs(p.scale.x); const sz = Math.abs(p.scale.z);
    const r1 = (x) => Math.round(x * 10) / 10;
    if (key === 'h') { const k = v / (H * sz); this.setProfile(p, { ...pr, points: pts.map((q) => ({ z: r1(q.z * k), r: q.r })) }, 'height'); }
    if (key === 'd') {
      const k = v / (2 * Math.max(...pts.map((q) => q.r)) * sxy);
      this.setProfile(p, { ...pr, points: pts.map((q, i) => (locked.has(i) ? q : { z: q.z, r: r1(q.r * k) })) }, 'diameter');
    }
    if (key === 'top' || key === 'base') {
      const i = key === 'top' ? pts.length - 1 : 0;
      const next = pts.slice(); next[i] = { z: pts[i].z, r: r1(v / 2 / sxy) };
      this.setProfile(p, { ...pr, points: next }, key);
    }
    if (key === 'wall') this.setProfile(p, { ...pr, wall: v }, 'wall');
    if (key === 'seg') this.setProfile(p, { ...pr, segments: Math.max(12, Math.min(256, Math.round(v))) }, 'segments');
  }

  // switch between the two readings of the photo: the extracted points, outline and camera swap with the alternative;
  // an open rim seen from above means an open top, so going there makes it hollow (coming back restores the choice)
  swapView() {
    const p = this.profilePart();
    if (!p || !p.params.profile.alt) return;
    const pr = p.params.profile;
    const here = { points: pr.extracted || pr.points, outline: pr.outline, camera: pr.camera, hollow: pr.hollow };
    const to = pr.alt;
    const hollow = to.camera.view === 'above' ? true : (to.hollow != null ? to.hollow : pr.hollow);
    this.setProfile(p, { ...pr, points: to.points.map((q) => ({ ...q })), extracted: to.points.map((q) => ({ ...q })), outline: to.outline, camera: to.camera, hollow, locked: [], alt: here }, 'view');
  }

  resetProfile() {
    const p = this.profilePart();
    if (!p || !p.params.profile.extracted) return;
    this.setProfile(p, { ...p.params.profile, points: p.params.profile.extracted.map((q) => ({ ...q })), locked: [] }, 'reset');
  }

  say(text) { const el = $('#editState'); if (el) el.textContent = text || ''; }

  // ---- interface
  bindUI() {
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    for (const b of document.querySelectorAll('#tools [data-mode]')) b.addEventListener('click', () => this.setMode(b.dataset.mode));
    on('#tUndo', 'click', () => this.undo());
    on('#tRedo', 'click', () => this.redo());
    on('#pDup', 'click', () => this.duplicate());
    on('#pMirror', 'click', () => this.mirror());
    on('#pHide', 'click', () => this.hide());
    on('#pDel', 'click', () => this.remove());
    on('#mTurn', 'click', () => this.turnAll('z', 90));
    on('#mSide', 'click', () => this.turnAll('x', 90));
    on('#mFloor', 'click', () => this.onFloor());
    on('#mShowAll', 'click', () => this.showAll());
    on('#pRatio', 'change', (e) => { this.keepRatio = e.target.checked; });
    on('#pairFind', 'click', () => this.linkSuggested());
    on('#pairUnlink', 'click', () => this.unlink());
    on('#pairLink', 'change', (e) => { this.linkOn = e.target.checked; });
    on('#snapDist', 'change', (e) => { const v = num(e.target.value); this.snapDist = v != null && v >= 0 ? v : 2; e.target.value = String(this.snapDist); });
    on('#sSplit', 'click', () => this.splitPart());
    on('#sClean', 'click', () => this.cleanPart());
    on('#sSmooth', 'click', () => this.smoothPart());
    on('#sLighter', 'click', () => this.lighterPart());
    on('#sCut', 'click', () => this.startCut('z'));
    on('#sLasso', 'click', () => this.startLasso());
    for (const b of document.querySelectorAll('#cutBox [data-axis]')) b.addEventListener('click', () => this.startCut(b.dataset.axis));
    on('#cutAt', 'input', (e) => { if (this.cut) { this.cut.at = Number(e.target.value) / 100; this.paintCut(); } });
    on('#cutGo', 'click', () => this.applyCut());
    on('#cutCancel', 'click', () => this.endCut());
    on('#profileSvg', 'dblclick', (e) => this.addProfilePoint(e));
    on('#prHollow', 'change', (e) => { const q = this.profilePart(); if (q) this.setProfile(q, { ...q.params.profile, hollow: e.target.checked }, 'hollow'); });
    on('#prReset', 'click', () => this.resetProfile());
    on('#prSwap', 'click', () => this.swapView());
    for (const [id, key] of [['#prH', 'h'], ['#prD', 'd'], ['#prTop', 'top'], ['#prBase', 'base'], ['#prWall', 'wall'], ['#prSeg', 'seg']]) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener('change', () => this.setProfileNumber(key, el.value));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
    }
    for (const k of ['x', 'y', 'z', 'r', 'w', 'd', 'h']) {
      const el = $(`#p${k.toUpperCase()}`);
      if (!el) continue;
      el.addEventListener('change', () => this.setField(k, el.value));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
    }
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
      const k = e.key.toLowerCase();
      // undo works even when the last part was deleted
      if ((e.ctrlKey || e.metaKey) && k === 'z' && (this.history.canUndo() || this.history.canRedo())) { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y' && this.history.canRedo()) { e.preventDefault(); this.redo(); return; }
      if (!this.doc.parts.length) return;
      if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); this.duplicate(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === 'delete' || k === 'backspace') { if (this.sel.size) { e.preventDefault(); this.remove(); } }
      else if (k === 'g') this.setMode('translate');
      else if (k === 'r') this.setMode('rotate');
      else if (k === 's') this.setMode('scale');
      else if (k === 'h') this.hide();
      else if (k === 'escape') { if (this.cut) this.endCut(); else this.select([]); }
      else if (k === 'f') this.viewer.frame();
    });
  }

  paintTools() {
    const has = this.doc.parts.length > 0;
    const tools = $('#tools');
    if (tools) tools.hidden = !has && !this.history.canUndo() && !this.history.canRedo();
    const box = $('#editBox');
    if (box) box.hidden = !has;
    if ($('#tUndo')) $('#tUndo').disabled = !this.history.canUndo();
    if ($('#tRedo')) $('#tRedo').disabled = !this.history.canRedo();
    this.setMode(this.mode);
  }

  paintList() {
    const ul = $('#partsList');
    if (!ul) return;
    ul.textContent = '';
    for (const p of this.doc.parts) {
      const li = document.createElement('li');
      li.className = `${this.sel.has(p.id) ? 'on' : ''}${p.visible ? '' : ' off'}`;
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'pname';
      name.textContent = p.name;
      const how = this.t(`kind_${p.kind}`);
      if (how && !how.startsWith('kind_')) { const tag = document.createElement('small'); tag.className = 'kind'; tag.textContent = how; name.append(' ', tag); }
      name.addEventListener('click', (e) => {
        if (e.shiftKey) { const s = new Set(this.sel); if (s.has(p.id)) s.delete(p.id); else s.add(p.id); this.select([...s]); } else this.select([p.id]);
      });
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'eye';
      eye.textContent = p.visible ? '◉' : '○';
      eye.title = this.t(p.visible ? 'pHide' : 'pShow');
      eye.addEventListener('click', () => this.step(p.visible ? 'hide' : 'show', () => { p.visible = !p.visible; }));
      li.append(name, eye);
      ul.appendChild(li);
    }
  }

  paintFields() {
    const box = $('#partFields');
    if (!box) return;
    const f = this.fields();
    box.hidden = !f;
    $('#editState').textContent = this.sel.size > 1 ? this.t('editMany').replace('{n}', this.nf(this.sel.size)) : '';
    if (!f) return;
    for (const k of ['x', 'y', 'z', 'r', 'w', 'd', 'h']) {
      const el = $(`#p${k.toUpperCase()}`);
      if (el && document.activeElement !== el) el.value = String(round1(f[k]));
    }
  }
}
