// Downloads for SketchUp (2024 imports .glb and .dae; it has no OBJ importer).
//   GLB: metres, y up (glTF rule), one named node per part, baked (no transforms on the nodes).
//   DAE: Collada 1.4.1 in centimetres and z up, exactly the extension's coordinates; one named node per part.
import * as THREE from 'three';
import { GLTFExporter } from '../vendor/three/addons/GLTFExporter.js';
import { Z_UP_TO_Y_UP } from './mesh.js';

// items: [{ name, geometry (cm, z up), color: [r,g,b] 0..255, materialName }]
export async function toGLB(items, modelName) {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.name = modelName;
  scene.add(root);
  const mats = new Map();
  const bake = new THREE.Matrix4().makeScale(0.01, 0.01, 0.01).multiply(Z_UP_TO_Y_UP);
  for (const it of items) {
    const g = it.geometry.clone().applyMatrix4(bake);
    let m = mats.get(it.materialName);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ name: it.materialName, color: new THREE.Color().setRGB(it.color[0] / 255, it.color[1] / 255, it.color[2] / 255, THREE.SRGBColorSpace), roughness: 0.85 });
      mats.set(it.materialName, m);
    }
    const mesh = new THREE.Mesh(g, m);
    mesh.name = it.name;
    root.add(mesh);
  }
  try {
    const out = await new GLTFExporter().parseAsync(scene, { binary: true });
    return new Blob([out], { type: 'model/gltf-binary' });
  } finally {
    for (const it of root.children) it.geometry.dispose();
    for (const m of mats.values()) m.dispose();
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Collada ids must be XML NCNames: ASCII letters, digits, _ - .; names keep the readable (Arabic or English) text
const safeId = (s, k) => `${String(s).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^([^A-Za-z_])/, '_$1')}_${k}`;
const f = (x) => (Math.abs(x) < 1e-9 ? '0' : String(Math.round(x * 1e5) / 1e5));

export function toDAE(items, modelName) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const matIds = new Map();
  const effects = [];
  const materials = [];
  for (const it of items) {
    if (matIds.has(it.materialName)) continue;
    const id = `mat-${safeId(it.materialName, matIds.size)}`;
    matIds.set(it.materialName, id);
    const c = it.color.map((v) => f(v / 255)).join(' ');
    effects.push(`<effect id="${id}-fx"><profile_COMMON><technique sid="common"><lambert><diffuse><color>${c} 1</color></diffuse></lambert></technique></profile_COMMON></effect>`);
    materials.push(`<material id="${id}" name="${esc(it.materialName)}"><instance_effect url="#${id}-fx"/></material>`);
  }
  const geoms = [];
  const nodes = [];
  const libNodes = [];
  items.forEach((it, k) => {
    const id = `part-${safeId(it.name, k)}`;
    const g = it.geometry;
    const pos = g.attributes.position.array;
    const nrm = g.attributes.normal.array;
    const uv = g.attributes.uv.array;
    const idx = g.index.array;
    const n = pos.length / 3;
    const tri = idx.length / 3;
    const p = new Array(idx.length);
    for (let i = 0; i < idx.length; i++) p[i] = idx[i];
    const mid = matIds.get(it.materialName);
    geoms.push(`<geometry id="${id}-mesh" name="${esc(it.name)}"><mesh>`
      + `<source id="${id}-pos"><float_array id="${id}-pos-a" count="${n * 3}">${Array.from(pos, f).join(' ')}</float_array>`
      + `<technique_common><accessor source="#${id}-pos-a" count="${n}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>`
      + `<source id="${id}-nrm"><float_array id="${id}-nrm-a" count="${n * 3}">${Array.from(nrm, f).join(' ')}</float_array>`
      + `<technique_common><accessor source="#${id}-nrm-a" count="${n}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>`
      + `<source id="${id}-uv"><float_array id="${id}-uv-a" count="${n * 2}">${Array.from(uv, f).join(' ')}</float_array>`
      + `<technique_common><accessor source="#${id}-uv-a" count="${n}" stride="2"><param name="S" type="float"/><param name="T" type="float"/></accessor></technique_common></source>`
      + `<vertices id="${id}-vtx"><input semantic="POSITION" source="#${id}-pos"/></vertices>`
      + `<triangles material="m" count="${tri}"><input semantic="VERTEX" source="#${id}-vtx" offset="0"/>`
      + `<input semantic="NORMAL" source="#${id}-nrm" offset="0"/><input semantic="TEXCOORD" source="#${id}-uv" offset="0" set="0"/>`
      + `<p>${p.join(' ')}</p></triangles></mesh></geometry>`);
    // each part as a library node placed once: SketchUp's importer makes a named component of it (a plain node
    // with geometry is merged into one block with everything else)
    libNodes.push(`<node id="${id}-part" name="${esc(it.name)}"><instance_geometry url="#${id}-mesh"><bind_material><technique_common>`
      + `<instance_material symbol="m" target="#${mid}"><bind_vertex_input semantic="UVSET0" input_semantic="TEXCOORD" input_set="0"/></instance_material>`
      + '</technique_common></bind_material></instance_geometry></node>');
    nodes.push(`<node id="${id}" name="${esc(it.name)}"><instance_node url="#${id}-part"/></node>`);
  });
  const xml = '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">'
    + `<asset><contributor><authoring_tool>AIM 3D Studio Web</authoring_tool></contributor><created>${now}</created><modified>${now}</modified>`
    + '<unit name="centimeter" meter="0.01"/><up_axis>Z_UP</up_axis></asset>'
    + `<library_effects>${effects.join('')}</library_effects><library_materials>${materials.join('')}</library_materials>`
    + `<library_geometries>${geoms.join('')}</library_geometries><library_nodes>${libNodes.join('')}</library_nodes>`
    + `<library_visual_scenes><visual_scene id="scene" name="${esc(modelName)}"><node id="model" name="${esc(modelName)}">${nodes.join('')}</node></visual_scene></library_visual_scenes>`
    + '<scene><instance_visual_scene url="#scene"/></scene></COLLADA>\n';
  return new Blob([xml], { type: 'model/vnd.collada+xml' });
}

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000); // long enough for a "where to save" dialog
}
