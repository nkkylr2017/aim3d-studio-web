// The project file (.aim3d, JSON): what the editor needs to carry on later, not just the delivered mesh.
//   { format: 'aim3d-project', version: 1, units: 'cm', up: 'z', source, provenance, parts: [...] }
// A part keeps its name, role, how it was made (kind), visibility, placement (position, quaternion, scale), its
// parameters (a profile part: its profile, extracted profile and outline, so it opens editable and "reset" still
// works) and, only when it cannot be rebuilt from parameters, its mesh in its own frame as base64 (Float32 positions,
// Uint32 triangles): never giant JSON number arrays. The model's frame (16 numbers), its mirror plane and the confirmed
// mirror pairs (as part indices: ids are not kept) are saved too, so links survive a reopen. Pure, node-testable.
import * as THREE from 'three';
import { makePart, centred } from './scene.js';
import { partGeometry } from './mesh.js';
import { revolve } from './profile.js';

export const PROJECT_FORMAT = 'aim3d-project';
export const PROJECT_VERSION = 1;

const toB64 = (typed) => {
  const u8 = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b64, Type) => {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return new Type(u8.buffer);
};

// the geometry of a profile part, in its own frame (centred on its box), as the editor keeps it
export function profileGeometry(profile) {
  const m = revolve(profile.points, profile);
  return centred(partGeometry({ pos: m.pos, tris: m.tris })).geometry;
}

export function toProject(doc, provenance = {}) {
  return {
    format: PROJECT_FORMAT, version: PROJECT_VERSION, units: 'cm', up: 'z', saved: new Date().toISOString(),
    source: doc.source, provenance,
    frame: doc.frame ? doc.frame.toArray() : null, mirrorPlane: doc.mirrorPlane || null,
    pairs: (doc.pairs || []).map(([a, b]) => [doc.parts.findIndex((p) => p.id === a), doc.parts.findIndex((p) => p.id === b)]).filter(([a, b]) => a >= 0 && b >= 0),
    parts: doc.parts.map((p) => {
      const out = {
        name: p.name, role: p.role || '', kind: p.kind, visible: p.visible,
        position: p.position.toArray(), quaternion: p.quaternion.toArray(), scale: p.scale.toArray(),
        params: p.params || null,
      };
      if (!(p.params && p.params.profile)) {
        const g = p.geometry;
        const pos = Float32Array.from(g.attributes.position.array);
        const tris = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
        out.mesh = { pos: toB64(pos), tris: toB64(tris) };
      }
      return out;
    }),
  };
}

// -> { parts (made with makePart), source, provenance }; throws a plain Error with a short reason on a bad file
export function fromProject(json) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  if (!j || j.format !== PROJECT_FORMAT) throw new Error('not an AIM 3D project');
  if (!(j.version >= 1 && j.version <= PROJECT_VERSION)) throw new Error(`project version ${j.version} is newer than this page`);
  if (!Array.isArray(j.parts) || !j.parts.length) throw new Error('the project has no parts');
  const vec = (a, n, d) => (Array.isArray(a) && a.length === n && a.every(Number.isFinite) ? a : d);
  const parts = j.parts.map((q, i) => {
    let geometry;
    if (q.params && q.params.profile && Array.isArray(q.params.profile.points) && q.params.profile.points.length >= 2) geometry = profileGeometry(q.params.profile);
    else if (q.mesh && q.mesh.pos && q.mesh.tris) {
      const pos = fromB64(q.mesh.pos, Float32Array); const tris = fromB64(q.mesh.tris, Uint32Array);
      if (pos.length % 3 || tris.length % 3 || tris.some((k) => k >= pos.length / 3)) throw new Error(`part ${i + 1}: broken mesh`);
      geometry = partGeometry({ pos, tris });
    } else throw new Error(`part ${i + 1}: no shape`);
    return makePart({
      name: String(q.name || `part ${i + 1}`).slice(0, 80), role: q.role || '', kind: q.kind || 'ai', visible: q.visible !== false,
      params: q.params || null, geometry,
      position: new THREE.Vector3(...vec(q.position, 3, [0, 0, 0])),
      quaternion: new THREE.Quaternion(...vec(q.quaternion, 4, [0, 0, 0, 1])),
      scale: new THREE.Vector3(...vec(q.scale, 3, [1, 1, 1])),
    });
  });
  const frame = new THREE.Matrix4();
  if (Array.isArray(j.frame) && j.frame.length === 16 && j.frame.every(Number.isFinite)) frame.fromArray(j.frame);
  const mirrorPlane = j.mirrorPlane && Number.isFinite(j.mirrorPlane.at) ? { at: j.mirrorPlane.at } : null;
  const pairs = (Array.isArray(j.pairs) ? j.pairs : [])
    .filter((pr) => Array.isArray(pr) && pr.length === 2 && pr.every((k) => Number.isInteger(k) && k >= 0 && k < parts.length) && pr[0] !== pr[1])
    .map(([a, b]) => [parts[a].id, parts[b].id]);
  return { parts, source: j.source || 'ai', provenance: j.provenance || {}, frame, mirrorPlane, pairs };
}
