// Kit parts (cm, z up) -> three.js geometry ready to show and export: creased normals (smooth upholstery,
// sharp board edges), box-projected UVs (1 UV unit = 1 m, so a material applied later in SketchUp maps), then
// vertices merged again. The order matters: UVs and normals split vertices, merging afterwards keeps files small.
import * as THREE from 'three';
import { toCreasedNormals, mergeVertices } from '../vendor/three/addons/BufferGeometryUtils.js';

// Faces meeting at more than this stay sharp. Lathed legs (30° per facet) and tubes with 8 sides (45°) stay smooth;
// boxes (90°) stay sharp; only the thinnest piping cords (60-72°, under 1 cm thick) show their facets.
export const CREASE_DEG = 50;

export function partGeometry(part) {
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(part.pos instanceof Float32Array ? part.pos : new Float32Array(part.pos), 3));
  g.setIndex(new THREE.BufferAttribute(part.tris instanceof Uint32Array ? part.tris : new Uint32Array(part.tris), 1));
  g = toCreasedNormals(g, (CREASE_DEG * Math.PI) / 180);
  addBoxUVs(g);
  g = mergeVertices(g, 1e-4);
  g.computeBoundingBox();
  return g;
}

function addBoxUVs(g) {
  const p = g.attributes.position.array;
  const uv = new Float32Array((p.length / 3) * 2);
  for (let t = 0; t < p.length / 9; t++) {
    const o = t * 9;
    const ax = p[o + 3] - p[o]; const ay = p[o + 4] - p[o + 1]; const az = p[o + 5] - p[o + 2];
    const bx = p[o + 6] - p[o]; const by = p[o + 7] - p[o + 1]; const bz = p[o + 8] - p[o + 2];
    const nx = Math.abs(ay * bz - az * by); const ny = Math.abs(az * bx - ax * bz); const nz = Math.abs(ax * by - ay * bx);
    for (let k = 0; k < 3; k++) {
      const x = p[o + 3 * k] / 100; const y = p[o + 3 * k + 1] / 100; const z = p[o + 3 * k + 2] / 100;
      const i = (t * 3 + k) * 2;
      if (nz >= nx && nz >= ny) { uv[i] = x; uv[i + 1] = y; } else if (nx >= ny) { uv[i] = y; uv[i + 1] = z; } else { uv[i] = x; uv[i + 1] = z; }
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// z up (SketchUp) -> y up (glTF, three.js), right-handed: (x, y, z) -> (x, z, -y). A pure rotation, so no face turns
// inside out.
export const Z_UP_TO_Y_UP = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

// Signed volume of a closed mesh (positive when its faces point outwards).
export function signedVolume(g) {
  const p = g.attributes.position.array;
  const idx = g.index ? g.index.array : null;
  const n = idx ? idx.length : p.length / 3;
  let v = 0;
  for (let t = 0; t < n; t += 3) {
    const a = (idx ? idx[t] : t) * 3; const b = (idx ? idx[t + 1] : t + 1) * 3; const c = (idx ? idx[t + 2] : t + 2) * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}
