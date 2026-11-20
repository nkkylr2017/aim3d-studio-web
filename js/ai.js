// A model made by a free AI (through the SketchUp extension, which talks to Hugging Face): the GLB is read, all its
// meshes become one part, turned from glTF's y-up to SketchUp's z-up, cleaned (shared corners welded, broken
// triangles dropped), stood on the floor with its front towards -Y, and sized in cm.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { cleanup } from './meshops.js';

const Y_UP_TO_Z_UP = new THREE.Matrix4().makeRotationX(Math.PI / 2); // (x, y, z) -> (x, -z, y)

export function readGLB(buffer) {
  return new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', resolve, reject));
}

// -> { pos: Float32Array (cm, z up, on the floor, centred), tris: Uint32Array, size: [w, d, h] } at its own scale
// (1 unit of the file = 1 m is assumed; the caller resizes to the user's measurement).
export function toPart(gltf) {
  const pos = [];
  const tris = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const g = o.geometry;
    const p = g.attributes.position;
    const m = new THREE.Matrix4().multiplyMatrices(Y_UP_TO_Z_UP, o.matrixWorld);
    const base = pos.length / 3;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m); pos.push(v.x * 100, v.y * 100, v.z * 100); }
    if (g.index) for (let i = 0; i < g.index.count; i++) tris.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) tris.push(base + i);
  });
  if (!tris.length) throw new Error('the file has no triangles');
  return weld(pos, tris);
}

// Corners closer than 0.2 mm become one (the files repeat corners per texture seam); zero-area triangles go.
function weld(pos, tris) {
  const key = new Map();
  const out = [];
  const map = new Int32Array(pos.length / 3);
  for (let i = 0; i < pos.length / 3; i++) {
    const k = `${Math.round(pos[3 * i] * 50)},${Math.round(pos[3 * i + 1] * 50)},${Math.round(pos[3 * i + 2] * 50)}`;
    let j = key.get(k);
    if (j === undefined) { j = out.length / 3; out.push(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]); key.set(k, j); }
    map[i] = j;
  }
  const t = [];
  for (let i = 0; i < tris.length; i += 3) {
    const a = map[tris[i]]; const b = map[tris[i + 1]]; const c = map[tris[i + 2]];
    if (a === b || b === c || a === c) continue;
    t.push(a, b, c);
  }
  // stand it on the floor, centred
  let lo = [Infinity, Infinity, Infinity]; let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < out.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], out[i + k]); hi[k] = Math.max(hi[k], out[i + k]); }
  const cx = (lo[0] + hi[0]) / 2; const cy = (lo[1] + hi[1]) / 2;
  for (let i = 0; i < out.length; i += 3) { out[i] -= cx; out[i + 1] -= cy; out[i + 2] -= lo[2]; }
  return { pos: new Float32Array(out), tris: new Uint32Array(t), size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}

// What image-to-3D models add around the object goes (spikes, a ground sheet from the shadow, floating crumbs), then
// the part stands on the floor again, centred. A cleanup that would leave less than half the triangles is not used
// (it would mean the "sheet" was the object).
export function cleaned(part) {
  const m = cleanup(part.pos, part.tris);
  if (m.tris.length < part.tris.length * 0.5) return part;
  const p = m.pos;
  const lo = [Infinity, Infinity, Infinity]; const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]); }
  const cx = (lo[0] + hi[0]) / 2; const cy = (lo[1] + hi[1]) / 2;
  for (let i = 0; i < p.length; i += 3) { p[i] -= cx; p[i + 1] -= cy; p[i + 2] -= lo[2]; }
  return { pos: p, tris: m.tris, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], cleaned: part.tris.length / 3 - m.tris.length / 3 };
}

// The part resized: one known measurement scales it evenly (a photo has no scale); none: its height becomes `h0`.
export function sized(part, typed, h0 = 100) {
  const [w, d, h] = part.size;
  let k;
  if (typed.w) k = typed.w / w; else if (typed.d) k = typed.d / d; else if (typed.h) k = typed.h / h; else k = h0 / h;
  const pos = Float32Array.from(part.pos, (v) => v * k);
  return { name: 'Object', role: null, pos, tris: part.tris, size: [w * k, d * k, h * k] };
}
