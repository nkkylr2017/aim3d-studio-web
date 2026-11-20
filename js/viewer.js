// The 3D view: a soft studio backdrop, a floor grid in 10 cm squares, a contact shadow, orbit controls.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/addons/OrbitControls.js';
import { partGeometry, Z_UP_TO_Y_UP } from './mesh.js';

export class Viewer {
  constructor(canvas, onLost) {
    this.canvas = canvas;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (e) {
      onLost('nowebgl');
      return;
    }
    this.ok = true;
    renderer.setClearColor(0x000000, 0); // the page's studio backdrop shows through
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer = renderer;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; onLost('lost'); });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; onLost('restored'); this.render(); });

    const scene = new THREE.Scene();
    this.scene = scene;
    scene.add(new THREE.HemisphereLight(0xf2f5f8, 0x8d949b, 1.25));
    const key = new THREE.DirectionalLight(0xffffff, 1.9);
    key.position.set(-2.2, 4.2, 3.4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.radius = 6;
    key.shadow.bias = -0.0004;
    this.key = key;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdfe8f0, 0.55);
    fill.position.set(3, 2, -2);
    scene.add(fill);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.16 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(8, 80, 0x9aa3ab, 0xc2c8ce);
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    grid.position.y = 0.0005;
    scene.add(grid);

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);
    this.camera.position.set(-2.6, 1.8, 3.2);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.addEventListener('change', () => this.request());
    this.model = new THREE.Group();
    this.model.matrixAutoUpdate = false;
    this.model.matrix.copy(new THREE.Matrix4().makeScale(0.01, 0.01, 0.01).multiply(Z_UP_TO_Y_UP));
    scene.add(this.model);
    this.items = [];
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  resize() {
    if (!this.ok) return;
    const el = this.canvas.parentElement;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return; // hidden or not laid out yet
    const wasEmpty = !(this.camera.aspect > 0) || this.needsFrame;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
    if (wasEmpty && this.needsFrame) this.frame();
    this.request();
  }

  request() {
    if (this.pending || !this.ok) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      if (this.controls.update()) this.request();
      this.render();
    });
  }

  render() { if (this.ok && !this.lost) this.renderer.render(this.scene, this.camera); }

  // Kit parts -> items { name, role, geometry (cm, z up, model coordinates), color } without showing them (the
  // document shows its own copies; the items stay for fitting and judging).
  makeItems(parts) {
    return parts.map((p) => {
      const geometry = partGeometry(p);
      return { name: p.name, role: p.role, geometry, color: [244, 244, 241] };
    });
  }

  // Shows the document: one mesh per visible part, all in one white material; the selected parts in a light blue.
  // Meshes are kept by part id, so an edit moves the mesh instead of making a new one.
  showDoc(doc, frame, selected = new Set()) {
    if (!this.ok) return;
    this.doc = doc;
    if (!this.white) {
      this.white = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.955, 0.955, 0.945, THREE.SRGBColorSpace), roughness: 0.82, metalness: 0 });
      this.picked = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.62, 0.8, 0.98, THREE.SRGBColorSpace), roughness: 0.7, metalness: 0 });
    }
    this.byId = this.byId || new Map();
    const seen = new Set();
    for (const p of doc.parts) {
      seen.add(p.id);
      let mesh = this.byId.get(p.id);
      if (!mesh) {
        mesh = new THREE.Mesh(p.geometry, this.white);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.partId = p.id;
        this.byId.set(p.id, mesh);
        this.model.add(mesh);
      }
      if (mesh.geometry !== p.geometry) mesh.geometry = p.geometry; // the document disposes geometries, not the viewer
      mesh.name = p.name;
      mesh.position.copy(p.position);
      mesh.quaternion.copy(p.quaternion);
      mesh.scale.copy(p.scale);
      mesh.visible = p.visible;
      mesh.material = selected.has(p.id) ? this.picked : this.white;
    }
    for (const [id, mesh] of this.byId) {
      if (seen.has(id)) continue;
      this.model.remove(mesh);
      this.byId.delete(id);
    }
    if (frame) this.frame();
    this.request();
  }

  meshOf(id) { return this.byId ? this.byId.get(id) : null; }
  docMeshes() { return this.byId ? [...this.byId.values()].filter((m) => m.visible) : []; }

  // parts: kit parts; colourOf(part) -> [r,g,b] or null (white)
  show(parts, colourOf, frame) {
    if (!this.ok) return [];
    this.clear();
    const mats = new Map();
    for (const p of parts) {
      const geometry = partGeometry(p);
      const rgb = colourOf(p) || [244, 244, 241];
      const key = rgb.join(',');
      let m = mats.get(key);
      if (!m) {
        m = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace), roughness: 0.82, metalness: 0 });
        mats.set(key, m);
      }
      const mesh = new THREE.Mesh(geometry, m);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = p.name;
      this.model.add(mesh);
      this.items.push({ name: p.name, role: p.role, geometry, color: rgb });
    }
    this.mats = [...mats.values()];
    if (frame) this.frame();
    this.request();
    return this.items;
  }

  clear() {
    for (const m of [...this.model.children]) {
      this.model.remove(m);
      if (m.userData.keep) { this.model.add(m); continue; } // the editor's own helpers stay
      if (m.userData.partId == null) m.geometry.dispose(); // document geometries are the document's to dispose
    }
    if (this.byId) this.byId.clear();
    for (const m of this.mats || []) m.dispose();
    this.mats = [];
    this.items = [];
  }

  // bounding box in cm (z up): the document's when it is shown, else the items'
  bounds() {
    if (this.doc && this.doc.parts.length) return this.doc.bounds();
    const b = new THREE.Box3();
    for (const it of this.items) b.union(it.geometry.boundingBox);
    return b;
  }

  frame() {
    const b = this.bounds();
    if (b.isEmpty()) return;
    const el = this.canvas.parentElement;
    if (!el.clientWidth || !el.clientHeight || !(this.camera.aspect > 0)) { this.needsFrame = true; return; } // done on the next resize
    this.needsFrame = false;
    const size = b.getSize(new THREE.Vector3()).multiplyScalar(0.01);
    const c = b.getCenter(new THREE.Vector3()).multiplyScalar(0.01);
    const target = new THREE.Vector3(c.x, c.z, -c.y);
    const r = size.length() * 0.5 + 0.05;
    // fit the bounding sphere in the narrower of the two view angles, with room for the size read-out and the buttons
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = r / Math.sin(Math.min(vfov, hfov) / 2) * 1.12;
    // three-quarter view from the front left, a little above, like a catalogue photo
    const dir = new THREE.Vector3(-0.55, 0.42, 0.72).normalize();
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.controls.target.copy(target);
    const k = this.key;
    k.position.set(target.x - 2.2 * r, 4 * r + 1, target.z + 3 * r);
    k.target.position.copy(target);
    k.target.updateMatrixWorld();
    const s = k.shadow.camera;
    s.left = s.bottom = -r * 2; s.right = s.top = r * 2; s.near = 0.1; s.far = 12 * r + 6;
    s.updateProjectionMatrix();
    this.controls.update();
    this.request();
  }

  snapshot() { this.render(); return this.canvas.toDataURL('image/png'); }
}
