// Builds models and runs the cloth physics off the page's thread. Every request carries a job id; the page
// drops any answer whose id is not the latest it asked for. A physics run is stopped by ending this worker.
import { build, simSpec, setLook } from './furniture.js';
import { simulate } from './cloth_sim.js';

self.onmessage = (e) => {
  const { job, kind, req } = e.data;
  try {
    setLook(req && req.tune); // the new looks' numbers: defaults unless a tuning run sends its own
    if (kind === 'build') {
      const t0 = performance.now();
      const r = build(req.type, req);
      const parts = r.parts.map((p) => ({ name: p.name, role: p.role, pos: new Float32Array(p.pos), tris: new Uint32Array(p.tris) }));
      const transfer = [];
      for (const p of parts) transfer.push(p.pos.buffer, p.tris.buffer);
      self.postMessage({ job, ok: true, parts, triangles: r.triangles, options: r.options, cloth: r.cloth, ms: Math.round(performance.now() - t0) }, transfer);
    } else if (kind === 'simulate') {
      // the light mesh uses the fast physics grid
      const spec = simSpec(req.type, { ...req, quality: req.quality === 'light' ? 'fast' : req.quality });
      if (!spec) { self.postMessage({ job, ok: true, grids: null }); return; }
      const r = simulate(spec);
      self.postMessage({ job, ok: true, grids: r.grids, seconds: r.seconds });
    }
  } catch (err) {
    self.postMessage({ job, ok: false, error: String((err && err.message) || err) });
  }
};
