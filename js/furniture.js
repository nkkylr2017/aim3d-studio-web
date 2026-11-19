// Port of src/aim3d_studio/smart_furniture.rb (AIM 3D Studio 2.12.3): the nine furniture types, their options,
// fitted proportions, the photo palette and the physics specs. Kept close to the Ruby for the parity test.
// x = width, y = depth/length (front/foot at -Y), z = up; cm.

import { RubyRandom, crc32, rround, sgn } from './rng.js';
import { Kit, Frame, V, smooth } from './kit.js';

const PI = Math.PI;
const { sin, cos, sqrt, abs, asin, min, max, floor, ceil } = Math;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const even = (n) => n % 2 === 0;

export const TYPES = ['bed', 'sofa', 'armchair', 'chair', 'table', 'coffee_table', 'nightstand', 'cabinet', 'wardrobe'];
export const KEYWORDS = {
  nightstand: ['كومودينو', 'كمودينو', 'كومدينة', 'طاولة جانبية', 'nightstand', 'bedside', 'night stand'],
  coffee_table: ['طاولة قهوة', 'طاولة وسط', 'coffee table'],
  wardrobe: ['دولاب', 'خزانة ملابس', 'wardrobe', 'closet'],
  bed: ['سرير', 'سراير', 'تخت', 'bed'],
  sofa: ['كنبة', 'كنب', 'كنبه', 'صوفا', 'sofa', 'couch', 'kanaba'],
  armchair: ['كرسي مفرد', 'كرسي استرخاء', 'فوتيه', 'armchair', 'lounge chair'],
  chair: ['كرسي طعام', 'كرسي', 'chair', 'stool'],
  table: ['طاولة', 'طاوله', 'ترابيزة', 'مكتب', 'سفرة', 'table', 'desk'],
  cabinet: ['خزانة', 'خزانه', 'بوفيه', 'درج', 'أدراج', 'cabinet', 'dresser', 'drawer', 'sideboard'],
};

export const OPTIONS = {
  bed: { outline: ['rect', 'round'], headboard: ['padded', 'channel', 'tufted', 'wing', 'panel', 'slats', 'none'], base: ['platform', 'legs'],
    bedding: ['duvet', 'tucked', 'none'], throw: ['diagonal', 'heap', 'runner', 'none'], throw_side: ['left', 'right'],
    throw_texture: ['smooth', 'knit'], pillows: ['2', '3', '4', '5', '6'] },
  sofa: { arms: ['track', 'rolled', 'slope', 'none'], back: ['cushions', 'tight', 'tufted'], base: ['legs', 'skirt'],
    seats: ['2', '3', '4'], pillows: ['2', '0', '4'], throw: ['none', 'over_back', 'over_arm'] },
  armchair: { arms: ['track', 'rolled', 'slope', 'none'], back: ['cushions', 'tight', 'tufted', 'wing'], base: ['legs', 'skirt'],
    pillows: ['0', '1'], throw: ['none', 'over_back', 'over_arm'] },
  chair: { back: ['upholstered', 'solid', 'slats', 'bars'], arms: ['no', 'yes'], legs: ['tapered', 'straight'], pad: ['no', 'yes'] },
  table: { top: ['rect', 'round', 'oval'], legs: ['straight', 'tapered', 'hairpin', 'pedestal', 'trestle'] },
  coffee_table: { top: ['rect', 'round', 'oval'], legs: ['tapered', 'straight', 'hairpin', 'pedestal', 'trestle'] },
  nightstand: { fronts: ['drawers', 'door'], base: ['legs', 'plinth'], handles: ['bar', 'knob', 'none'], style: ['shaker', 'flat'], interior: ['fitted', 'empty'] },
  cabinet: { fronts: ['drawers', 'doors', 'mixed'], base: ['legs', 'plinth'], handles: ['bar', 'knob', 'none'], style: ['shaker', 'flat'], interior: ['fitted', 'empty'] },
  wardrobe: { fronts: ['doors', 'mixed'], base: ['plinth', 'legs'], handles: ['bar', 'knob', 'none'], style: ['shaker', 'flat'], interior: ['hanging', 'shelves', 'empty'] },
};

export const BED_TUNING = { throw_extra_w: 120.0, throw_len: 0.40, throw_cx: 15.0, throw_cy: 0.15, throw_turn: 32.0,
  duvet_foot_cut: 30.0, duvet_side_cut: 4.0, throw_bow: 0.0 };
export const ROUND_TUNING = { ring_w: 21.0, front_drop: 18.0, rise: [0.31, 0.935], wing_rise: [0.20, 0.70], deck: 30.0, mattress: 28.0,
  back_pillow: [97.0, 62.0, 15.0], front_pillow: [87.0, 54.0, 22.0], disc: 52.0, pillow_span: 0.874 };
const bedTuning = () => BED_TUNING;
const roundTuning = () => ROUND_TUNING;

export const DEFAULTS = { bed: { pillows: '5', throw: 'diagonal', throw_texture: 'knit' }, sofa: { seats: '3' } };

export const RANGES = {
  bed: [[90, 220, 160], [190, 230, 200], [70, 170, 104]], sofa: [[140, 340, 215], [70, 115, 95], [65, 110, 86]],
  armchair: [[60, 120, 88], [65, 105, 86], [65, 120, 86]], chair: [[38, 70, 46], [40, 70, 52], [70, 125, 88]],
  table: [[60, 320, 160], [50, 160, 90], [55, 110, 75]], coffee_table: [[50, 180, 110], [40, 120, 60], [28, 60, 42]],
  nightstand: [[35, 80, 50], [30, 60, 40], [40, 80, 56]], cabinet: [[60, 240, 140], [35, 70, 45], [60, 130, 82]],
  wardrobe: [[80, 300, 120], [45, 70, 60], [160, 260, 210]],
};

const ROUND_BED_D = 210.0;
const ROUND_BED_HEAD = 122.0;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function pick(v, lo, hi, def) {
  return Number.isFinite(v) && v > 0 ? clamp(v, lo, hi) : def;
}

export function overallSize(type, h, w, d, o = {}) {
  const [rw, rd, rh] = RANGES[type];
  const out = [pick(num(w), ...rw), pick(num(d), ...rd), pick(num(h), ...rh)];
  if ((type === 'table' || type === 'coffee_table') && o.top === 'round') {
    out[0] = out[1] = clamp(max(out[0], out[1]), max(rw[0], rd[0]), min(rw[1], rd[1]));
  }
  if (type === 'bed' && o.outline === 'round') {
    const given = max(num(w), num(d));
    out[0] = out[1] = given > 0 ? clamp(given, rd[0], rw[1]) : ROUND_BED_D;
    if (!(num(h) > 0)) out[2] = ROUND_BED_HEAD;
  }
  return out;
}

export function detect(choice, name, objectEn) {
  if (TYPES.includes(choice)) return choice;
  if (choice === 'other') return null;
  for (const text of [name, objectEn]) {
    const t = String(text || '').toLowerCase();
    if (!t.trim()) continue;
    for (const [type, words] of Object.entries(KEYWORDS)) if (words.some((w) => t.includes(w))) return type;
  }
  return null;
}

export function optionsFor(type, attrs) {
  if (!attrs || typeof attrs !== 'object') attrs = {};
  const o = {};
  for (const [key, values] of Object.entries(OPTIONS[type] || {})) {
    const v = attrs[key] == null ? '' : String(attrs[key]);
    o[key] = values.includes(v) ? v : ((DEFAULTS[type] && DEFAULTS[type][key]) || values[0]);
  }
  return o;
}

// Same photo, same folds and creases (crc32 of the file's bytes, like the extension).
export function seedFor(bytesOrName) {
  return crc32(bytesOrName || '') & 0x7fffffff;
}

// ---------------------------------------------------------------- colours from the photo
// colorAt(u, v) -> [r, g, b, a] with v running bottom-up, like SketchUp's ImageRep#color_at_uv.
export function palette(colorAt) {
  try {
    const border = [];
    for (let k = 0; k < 40; k++) {
      const f = (k + 0.5) / 40;
      for (const [u, v] of [[f, 0.01], [f, 0.99], [0.01, f], [0.99, f]]) { const c = colorAt(u, v); border.push([c[0], c[1], c[2]]); }
    }
    const bg = [0, 1, 2].map((i) => border.reduce((s, p) => s + p[i], 0) / border.length);
    const spread = border.map((p) => sqrt(d2(p, bg))).sort((a, b) => a - b)[floor(border.length * 0.8)];
    const steps = [];
    for (let side = 0; side < 4; side++) for (let k = 0; k < 39; k++) steps.push(sqrt(d2(border[k * 4 + side], border[(k + 1) * 4 + side])));
    steps.sort((a, b) => a - b);
    const smoothBg = steps[floor(steps.length * 0.9)] < 14;
    const plainBg = (spread < 40 || smoothBg) && lum(bg) > 0.78;
    const sample = (u0, u1, v0, v1, n = 28) => {
      const pts = [];
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const c = colorAt(u0 + (u1 - u0) * (i + 0.5) / n, v0 + (v1 - v0) * (j + 0.5) / n);
          const p = [c[0], c[1], c[2]];
          if (c[3] < 128 || (plainBg && sqrt(d2(p, bg)) < 38)) continue;
          pts.push(p);
        }
      }
      return pts.length ? pts : [[200, 196, 188]];
    };
    const bodyPts = sample(0.12, 0.88, 0.06, 0.5);
    const body = kmeans(bodyPts, 5);
    const top = kmeans(sample(0.15, 0.85, 0.45, 0.72), 4);
    const light = maxBy(body.concat(top).filter((c) => c.share > 0.04), (c) => lum(c.rgb));
    let darkish = bodyPts.filter((p) => lum(p) < 0.45).sort((a, b) => lum(a) - lum(b));
    darkish = darkish.slice(floor(darkish.length * 0.15));
    let accent;
    if (darkish.length > bodyPts.length * 0.08) {
      accent = { rgb: mix([0, 1, 2].map((i) => darkish.reduce((s, p) => s + p[i], 0) / darkish.length), [255, 255, 255], 0.08) };
    } else {
      accent = maxBy(body.filter((c) => c.share > 0.04 && lum(c.rgb) >= 0.1 && lum(c.rgb) <= 0.62), (c) => chroma(c.rgb) * c.share ** 0.3)
        || minBy(body, (c) => abs(lum(c.rgb) - 0.3));
    }
    let upholstery = maxBy(top.filter((c) => c.share > 0.06 && lum(c.rgb) > 0.42 && String(c.rgb) !== String(light.rgb)), (c) => c.share);
    if (plainBg) {
      const darkBody = body.filter((c) => c.share > 0.12 && lum(c.rgb) < 0.45);
      if (darkBody.length) {
        const total = darkBody.reduce((s, c) => s + c.share, 0);
        upholstery = { rgb: [0, 1, 2].map((i) => rround(darkBody.reduce((s, c) => s + c.rgb[i] * c.share, 0) / total)), sure: true };
      }
    }
    if (!upholstery) upholstery = { rgb: mix(light.rgb, [186, 172, 152], 0.2) };
    const cushion = maxBy(top.filter((c) => c.share >= 0.05 && lum(light.rgb) - lum(c.rgb) >= 0.2 && sqrt(d2(c.rgb, upholstery.rgb)) >= 35), (c) => c.share);
    return {
      light: light.rgb, accent: accent.rgb, upholstery: upholstery.rgb, cushion: (cushion || accent).rgb,
      dark: mix(accent.rgb, [40, 28, 20], 0.6), upholstery_mix: upholstery.sure ? 0.9 : 0.3,
    };
  } catch (e) {
    return { light: [236, 230, 218], accent: [120, 72, 50], upholstery: [214, 202, 184], dark: [60, 44, 32] };
  }
}

function maxBy(arr, f) { let best = null; let bv = -Infinity; for (const x of arr) { const v = f(x); if (v > bv) { bv = v; best = x; } } return best; }
function minBy(arr, f) { let best = null; let bv = Infinity; for (const x of arr) { const v = f(x); if (v < bv) { bv = v; best = x; } } return best; }

export function kmeans(pts, k, iters = 12) {
  if (!pts.length) return [];
  const cents = [];
  for (let i = 0; i < k; i++) cents.push((pts[floor(i * pts.length / k) + floor(pts.length / (2 * k))] || pts[0]).slice());
  const assign = new Array(pts.length).fill(0);
  for (let it = 0; it < iters; it++) {
    pts.forEach((p, i) => { let bc = 0; let bd = Infinity; for (let c = 0; c < k; c++) { const dd = d2(p, cents[c]); if (dd < bd) { bd = dd; bc = c; } } assign[i] = bc; });
    for (let c = 0; c < k; c++) {
      const mem = []; assign.forEach((a, i) => { if (a === c) mem.push(i); });
      if (!mem.length) continue;
      cents[c] = [0, 1, 2].map((ch) => mem.reduce((s, i) => s + pts[i][ch], 0) / mem.length);
    }
  }
  const out = [];
  for (let c = 0; c < k; c++) {
    const share = assign.filter((a) => a === c).length / pts.length;
    if (share !== 0) out.push({ rgb: cents[c].map(rround), share });
  }
  return out;
}

export const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
export const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255.0;
export const chroma = (c) => (max(...c) - min(...c)) / 255.0;
export const mix = (a, b, t) => [0, 1, 2].map((i) => rround(a[i] * (1 - t) + b[i] * t));

// The colour of each role (Kit#colour in the Ruby).
export function roleColour(pal, role) {
  const p = pal || {};
  switch (role) {
    case 'upholstery': return mix(p.light || [230, 222, 210], p.upholstery || [200, 190, 175], Number(p.upholstery_mix || 0.3));
    case 'linen': return p.light;
    case 'duvet': return mix(p.light || [236, 230, 218], [255, 255, 255], 0.25);
    case 'accent': return p.accent;
    case 'disc': return p.cushion || p.accent;
    case 'fabric': return p.upholstery;
    case 'cushion': return mix(p.upholstery || [200, 190, 175], p.light || [236, 230, 218], 0.3);
    case 'wood': return p.upholstery;
    case 'dark': return p.dark;
    default: return null;
  }
}

// ---------------------------------------------------------------- build
// Returns { parts: [{ name, role, thin, pos, tris }], triangles, options, cloth }.
export function build(type, { height_cm = 0, width_cm = 0, depth_cm = 0, attrs = {}, seed = 1, quality = 'standard', sims = null } = {}) {
  if (!TYPES.includes(type)) throw new Error(`Unknown furniture type: ${type}`);
  const o = optionsFor(type, attrs);
  const detail = { fast: 1.6, high: 0.72 }[quality] || 1.0;
  const kit = new Kit({ seed, detail });
  kit.sims = sims && typeof sims === 'object' && Object.keys(sims).length ? sims : null;
  kit.variation = {};
  BUILDERS[type](kit, num(height_cm), num(width_cm), num(depth_cm), o);
  return { parts: kit.parts, triangles: kit.triangles, options: o, cloth: kit.sims ? 'physics' : 'drawn' };
}

const upright = (o) => new Frame(o, [1, 0, 0], [0, 0, 1], [0, -1, 0]);
const CORNERS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

// ---------------------------------------------------------------- bed
export function bedDims(h, w, d, o) {
  const [bw, bl, bh] = overallSize('bed', h, w, d, o);
  const g = { w: bw, l: bl, head: bh };
  w = g.w;
  const l = g.l;
  g.legs = o.base === 'legs';
  g.wb = w + 10.0;
  g.lb = l + 10.0;
  g.head_front = g.lb / 2 - (o.headboard === 'none' ? 2 : 6);
  g.z0 = g.legs ? 15.0 : 3.0;
  g.z1 = g.legs ? 37.0 : 34.0;
  g.mt = 22.0;
  g.m0 = g.z1 - 2;
  g.top = g.m0 + g.mt;
  const tucked = o.bedding === 'tucked';
  const re = 6.0;
  g.hx = w / 2 - re;
  g.hy = l / 2 - re;
  g.stand = (g.wb - w) / 2 + re + 1.5;
  const arc = PI / 2 * g.stand;
  const hang = max(g.top - g.stand - (tucked ? g.m0 + 5 : g.z0 + 4), 4);
  const headEdge = l / 2 - 52.0;
  const foot = g.hy + arc + hang;
  const slide = tucked ? 0.0 : (o.throw_side === 'right' ? 1 : -1) * w * 0.15;
  g.duvet = [[2 * (g.hx + arc + hang), foot + headEdge], [slide, (headEdge - foot) / 2]];
  g.thick = tucked ? 3.5 : 9.0;
  g.thick_hang = tucked ? 2.5 : 6.0;
  g.tsup = { hx: w / 2 - 4, hy: l / 2 - 4, top: g.top + 2.4 + g.thick };
  g.tstand = g.stand + g.thick_hang + (tucked ? 0.0 : 3.5) - 0.8;
  const side = o.throw_side === 'right' ? 1 : -1;
  const bt = bedTuning();
  switch (o.throw) {
    case 'heap': g.throw = [[w * 0.78, l * 0.44], [side * w * 0.33, -l / 2 + l * 0.14], side * 18]; break;
    case 'diagonal': g.throw = [[w + bt.throw_extra_w, l * bt.throw_len], [side * bt.throw_cx, -l / 2 + l * bt.throw_cy], -side * bt.throw_turn]; break;
    case 'runner': g.throw = [[2 * (g.tsup.hx + PI / 2 * g.tstand + 24), 50], [0, -l / 2 + 34], 0]; break;
    default: g.throw = null;
  }
  if (o.outline === 'round') roundBedDims(g, o);
  return g;
}

function roundBedDims(g, o) {
  const t = roundTuning();
  g.round = true;
  g.R = g.w / 2;
  g.z1 = t.deck + (g.legs ? 3.0 : 0.0);
  g.mt = t.mattress;
  g.m0 = g.z1 - 2;
  g.top = g.m0 + g.mt;
  const tuck = { duvet: g.thick_hang, tucked: 2.5 }[o.bedding] ?? 0.5;
  g.r_in = g.R + tuck + 1.5;
  g.ring_w = t.ring_w;
  g.r_out = g.r_in + g.ring_w;
  g.wb = g.lb = 2 * g.r_out;
  g.ring_front = g.top - t.front_drop;
  g.ring_back = o.headboard === 'none' ? g.ring_front : max(g.head, g.top + 20);
  g.ring_rise = o.headboard === 'wing' ? t.wing_rise : t.rise;
  g.pillow_w = g.w * t.pillow_span;
  g.head_front = g.r_in - 1.0;
  g.rstand = 8.0;
  g.duvet_r = g.R - 7.0 + PI / 2 * g.rstand + max(g.top - g.rstand - (g.z1 + 4), 4);
  g.tsup = { hx: g.R - 4, hy: g.R - 4, top: g.top + 2.4 + g.thick, r: g.R - 4 };
  if (o.throw === 'diagonal') {
    const side = o.throw_side === 'right' ? 1 : -1;
    const cy = -g.R * 0.5;
    const half = sqrt(max(g.r_out ** 2 - cy ** 2, 1.0)) + 28.0;
    g.throw = [[2 * half, g.l * bedTuning().throw_len], [side * bedTuning().throw_cx, cy], -side * 24.0];
  }
  return g;
}

const headboardDepth = (style) => ({ slats: 4.0, padded: 20.0 }[style] ?? 16.0);

export function bedPillowLayout(count, w, headFront, top, seed, round = null) {
  const rnd = new RubyRandom(Math.trunc(seed) + 7);
  const r = (a, b) => a + (b - a) * rnd.rand();
  let euro = [min(w / 2 + 2, 82), 62, 32, 12];
  let std = [min(w / 2 - 4, 76), 54, 28, 22];
  const small = [40, 28, 19, 30];
  const square = [38, 38, 21, 30];
  if (round) {
    const t = roundTuning();
    euro = [t.back_pillow[0], t.back_pillow[1], 32, t.back_pillow[2]];
    std = [t.front_pillow[0], t.front_pillow[1], 28, t.front_pillow[2]];
  }
  const disc = [roundTuning().disc, roundTuning().disc, 14, 12];
  let rows;
  if (round) {
    switch (count) {
      case 2: rows = [[std, 2, 'linen']]; break;
      case 3: rows = [[std, 2, 'linen'], [disc, 1, 'disc', null, 'round']]; break;
      case 4: rows = [[euro, 2, 'linen'], [std, 2, 'linen']]; break;
      case 6: rows = [[euro, 2, 'linen'], [std, 2, 'linen'], [square, 2, 'accent']]; break;
      default: rows = [[euro, 2, 'linen'], [std, 2, 'linen'], [disc, 1, 'disc', null, 'round']];
    }
  } else {
    switch (count) {
      case 2: rows = [[std, 2, 'linen']]; break;
      case 3: rows = [[std, 2, 'linen'], [small, 1, 'accent']]; break;
      case 4: rows = [[euro, 2, 'linen'], [std, 2, 'linen']]; break;
      case 6: rows = [[euro, 2, 'linen'], [square, 2, 'accent'], [std, 2, 'linen']]; break;
      default: rows = [[euro, 2, 'linen'], [small, 1, 'accent', 24.0], [std, 2, 'linen']];
    }
  }
  let y = headFront;
  let idx = 0;
  const all = [];
  for (const [[pw, ph, pt, lean0], n, role, raiseBy, shape] of rows) {
    const lean = lean0 + r(-2.5, 2.5);
    const b = lean * PI / 180;
    // pt is an Integer in the Ruby (19, 21, 28, 32…), so pt / 2 divides as integers there
    const cy = y - (ph / 2) * sin(b) - Math.trunc(pt / 2) * cos(b);
    const cz = top - 1.5 + (ph / 2) * cos(b) + (raiseBy == null ? 0 : raiseBy);
    const gap = n === 2 && pw < 45 ? w * 0.08 : (pw > w / 2 ? w / 2 - pw : 0.5);
    const xs = n === 1 ? [0.0] : [-(pw / 2 + gap), pw / 2 + gap];
    const wall = y;
    const out = xs.map((x) => {
      idx += 1;
      const p = { id: `Pillow ${idx}`, size: [pw, ph, pt], role, x };
      p.cy = cy + r(-2.0, 2.0);
      p.cz = cz; p.lean = b; p.wall = wall; p.top = top; p.raised = raiseBy != null;
      p.yaw = r(-5, 5) + sgn(x) * (lean > 18 ? -16 : 3);
      p.roll = r(-4, 4);
      p.round = shape === 'round';
      return p;
    });
    if (round) {
      for (const p of out) {
        const half = p.size[0] / 2.0;
        const sag = round - sqrt(max(round ** 2 - half ** 2, 1));
        const shift = sqrt(max(round ** 2 - p.x ** 2, 1)) - round - sag / 2;
        p.cy += shift;
        p.wall += shift;
        p.yaw = -sgn(p.x) * asin(min(abs(p.x) / round, 1.0)) * 180 / PI + r(-2, 2);
      }
    }
    y = raiseBy != null ? y - pt * 0.25 : cy - pt * 0.62 - 1.5;
    all.push(...out);
  }
  return all;
}

function pillowSpec(pose, cell, seed) {
  const [pw, ph, pt] = pose.size;
  const b = pose.lean;
  const fw = pw * 1.07;
  const fh = ph * 1.07;
  const lift = pose.raised ? -ph / 2 * cos(b) : pose.top + 1.2 - pose.cz;
  const planes = [{ n: [0, cos(b), sin(b)], d: lift }, { n: [0, -sin(b), cos(b)], d: pose.cy - pose.wall - 1.0 }];
  return { id: pose.id, w: fw, h: fh, nx: rround(fw / cell), ny: rround(fh / cell), volume: 0.6 * pw * ph * pt, planes,
    down: [0, -cos(b), -sin(b)], seed };
}

// The loose fabrics of a piece for the cloth physics (cloth_sim.js); null when it has none.
export function simSpec(type, { height_cm = 0, width_cm = 0, depth_cm = 0, attrs = {}, seed = 1, quality = 'standard' } = {}) {
  const h = num(height_cm); const w = num(width_cm); const d = num(depth_cm);
  if (type === 'sofa' || type === 'armchair') return sofaSimSpec(type, h, w, d, optionsFor(type, attrs), seed, quality);
  if (type === 'chair') return chairSimSpec(h, w, d, optionsFor(type, attrs), seed, quality);
  if (type !== 'bed') return null;
  const o = optionsFor('bed', attrs);
  const g = bedDims(h, w, d, o);
  if (g.round) return roundSimSpec(g, o, seed, quality);
  const res = { fast: 5.0, high: 3.2 }[quality] || 4.0;
  const ht = g.head - 14.0;
  const htT = headboardDepth(o.headboard);
  const b0 = g.legs ? g.z0 : 0.0;
  const colliders = [
    { c: [0, 0, (b0 + g.z1) / 2], h: [g.w / 2 + 1, g.l / 2 + 1, (g.z1 - b0) / 2], r: min(8.0, (g.z1 - b0) / 2 - 0.1) },
    { c: [0, 0, g.m0 + g.mt / 2], h: [g.w / 2, g.l / 2, g.mt / 2], r: 7.0 },
  ];
  if (o.headboard !== 'none') {
    colliders.push({ c: [0, g.lb / 2 + htT / 2 - 1.5, 14.0 + ht / 2], h: [g.wb / 2 + 4, htT / 2, ht / 2], r: min(6.0, htT / 2 - 0.1) });
  }
  let [[dsx, dsy], [dcx, dcy]] = g.duvet;
  const side = o.throw_side === 'right' ? 1 : -1;
  const gather = 0.9;
  const gdir = 90 - side * 38;
  dsx *= 1 + 0.35 * (1 - gather) * abs(cos(gdir * PI / 180));
  dsy *= 1 + 0.35 * (1 - gather) * abs(sin(gdir * PI / 180));
  dsy -= bedTuning().duvet_foot_cut;
  dcy -= (dsy - g.duvet[0][1]) / 2;
  const cut = abs(dcx) * 0.75 + bedTuning().duvet_side_cut;
  dsx -= cut;
  dcx -= side * cut / 2;
  const turn = side * 7 * PI / 180;
  let cloths = [{ id: 'Duvet', sx: dsx, sy: dsy, nx: rround(dsx / res), ny: rround(dsy / res),
    o: [dcx, dcy, g.top + 4], u: [cos(turn), sin(turn), 0], v: [-sin(turn), cos(turn), 0],
    gather, gather_dir: gdir, fold: 60, scrunch: 0.2,
    drape: { cx: 0, cy: 0, hx: g.w / 2 + 1, hy: g.l / 2 + 1, margin: (g.wb - g.w) / 2 + 5, pile: 10 },
    steps: 300, iters: 8, bend: 0.45, shear: 0.6, inflate: 1.8, friction: 0.4,
    damping: 0.982, waves: 2.0, self: true, thickness: g.thick_hang + 0.5, seed }];
  if (g.throw) {
    let [[tsx, tsy], [tcx, tcy], tturn] = g.throw;
    const a = tturn * PI / 180;
    const heap = o.throw === 'heap';
    if (heap) tcx += (o.throw_side === 'right' ? 1 : -1) * g.w * 0.05;
    const r2 = res * 0.8;
    cloths.push({ id: 'Throw', sx: tsx, sy: tsy, nx: rround(tsx / r2), ny: rround(tsy / r2),
      scrunch: heap ? null : 0.2,
      drape: heap ? null : { cx: 0, cy: 0, hx: g.w / 2 + 3, hy: g.l / 2 + 3, margin: (g.wb - g.w) / 2 + g.thick_hang + 4, pile: 5 },
      o: [tcx, tcy, g.top + g.thick + (heap ? 30 : 7)], u: [cos(a), sin(a), 0],
      v: [-sin(a), cos(a), 0], steps: heap ? 340 : 320, iters: 8, bend: heap ? 0.12 : 0.24,
      shear: 0.5, gather: heap ? 0.6 : (o.throw === 'diagonal' ? 0.82 : 1.0), gather_dir: o.throw === 'diagonal' ? 90 - (o.throw_side === 'right' ? 1 : -1) * 38 : 0, fold: heap ? 34 : 52,
      bow: o.throw === 'diagonal' ? Number(bedTuning().throw_bow) : 0.0, end_gather: o.throw === 'diagonal' ? [0.72, 0.5, 30.0] : null,
      waves: heap ? 5.0 : 1.5, inflate: 2.0, friction: 0.4,
      over: { id: 'Duvet', r_top: g.thick + 2.0, r_side: g.thick_hang + 3.0, z_split: g.top - 4 },
      damping: 0.982, self: true, thickness: 5.0, seed: seed + 1 });
  }
  const cell = { fast: 3.6, high: 2.1 }[quality] || 2.7;
  const pillows = bedPillowLayout(Number.parseInt(o.pillows, 10), g.w, g.head_front, g.top, seed).map((pose, k) => pillowSpec(pose, cell, seed + 11 + k));
  if (o.bedding !== 'duvet') cloths = [];
  return { floor: 0, colliders, cloths, pillows };
}

function buildBed(kit, h, w, d, o) {
  const g = bedDims(h, w, d, o);
  if (g.round) return buildRoundBed(kit, g, o);
  w = g.w;
  const { l, head, legs, wb, lb, z0, z1, mt, m0, top } = g;
  const sims = kit.sims || {};
  kit.part('Base', 'upholstery', (b) => {
    kit.cushion(b, new Frame([0, 0, (z0 + z1) / 2]), wb / 2, lb / 2, z1 - z0, { corner: 8, rim: 7.0, bulge: 0.8, grid: 7 });
    if (!legs) kit.cushion(b, new Frame([0, 0, z0 / 2]), wb / 2 - 6, lb / 2 - 6, z0, { corner: 3, rim: 0.4, grid: 16 });
  });
  if (legs) {
    kit.part('Legs', 'dark', (b) => {
      for (const [sx, sy] of CORNERS) kit.lathe(b, [sx * (wb / 2 - 9), sy * (lb / 2 - 9), 0], [[1.7, 0], [2.7, z0 + 1]], { seg: 14 });
    });
  }
  kit.part('Mattress', 'linen', (b) => {
    kit.cushion(b, new Frame([0, 0, m0 + mt / 2]), w / 2, l / 2, mt, { corner: 7, rim: 7.0, bulge: 0.8, grid: 6 });
  });
  if (o.bedding !== 'none') {
    const sre = 7.0;
    const sstand = sre + 0.6;
    const shang = mt - sstand - 3;
    kit.part('Sheet', 'linen', (b) => {
      kit.cloth(b, { size: [2 * (w / 2 - sre + PI / 2 * sstand + shang), 2 * (l / 2 - sre + PI / 2 * sstand + shang)],
        centre: [0, 0], sup: { hx: w / 2 - sre, hy: l / 2 - sre, top: top + 0.2 }, stand: sstand, floor: m0 + 1,
        grid: 4.0, thick: 1.0, thick_hang: 0.8, crease: 0.5, crease_size: 16, waves: 0.3, fold: 0.5,
        fold_size: 10, flare: 0.0 });
    });
  }
  if (o.headboard !== 'none') bedHeadboard(kit, o.headboard, wb, lb, head);
  bedPillows(kit, Number.parseInt(o.pillows, 10), w, g.head_front, top, sims);
  if (o.bedding === 'none') return;

  const tucked = o.bedding === 'tucked';
  const { hx, hy, stand, thick, thick_hang } = g;
  kit.part('Duvet', 'duvet', (b) => {
    kit.cloth(b, { size: g.duvet[0], centre: g.duvet[1], sim: sims.Duvet,
      sup: { hx, hy, top: top + 1.8 }, stand, floor: 0.8, grid: 3.0,
      thick, thick_hang, crease: tucked ? 0.5 : 2.0, crease_size: 34,
      waves: tucked ? 0.3 : 3.2, fold: tucked ? 1.0 : 7.0, fold_size: 26, flare: tucked ? 0.5 : 6.0,
      roll: tucked ? null : (sims.Duvet ? [5.5, 34.0] : [7.0, 10.0]), edge_puff: tucked ? 0.0 : (sims.Duvet ? 2.0 : 6.0),
      pleats: tucked ? null : [o.throw_side === 'right' ? 125 : 55, 24.0, 4.5], hem: tucked ? [1.5, 3.0] : [4.0, 5.0] });
  });
  bedThrow(kit, g, o, sims);
}

function bedThrow(kit, g, o, sims) {
  const { tsup, tstand } = g;
  if (o.throw === 'diagonal' || o.throw === 'heap') {
    const knit = o.throw_texture === 'knit' ? [5.5, 1.6] : null;
    const [size, centre, turn] = g.throw;
    kit.part('Throw', 'accent', (b) => {
      kit.cloth(b, { size, centre, turn, sup: tsup, sim: sims.Throw,
        stand: tstand, floor: 1.0, grid: knit ? 1.7 : 2.4, thick: sims.Throw ? 3.2 : (knit ? 4.2 : 3.2), crease: sims.Throw ? 0.8 : (knit ? 3.2 : 3.6),
        crease_size: 13, waves: o.throw === 'heap' ? 12.0 : 4.0, fold: 5.0, fold_size: 12, flare: 3.0,
        warp: 14.0, edge_puff: 2.0, hem: sims.Throw ? null : [1.5, 3.0], knit });
    });
  } else if (o.throw === 'runner') {
    kit.part('Throw', 'accent', (b) => {
      const knit = o.throw_texture === 'knit' ? [5.5, 1.5] : null;
      // the runner's 50 cm is an Integer in the Ruby: it divides as integers in the cloth's spacing and hem
      kit.cloth(b, { size: g.throw[0], centre: g.throw[1], sup: tsup, stand: tstand, sim: sims.Throw, sy_int: true,
        floor: 1.0, grid: knit ? 1.7 : 2.6, thick: 3.2, crease: 0.8, crease_size: 18, waves: 0.4, fold: 1.8,
        fold_size: 12, flare: 1.0, knit });
    });
  }
}

function buildRoundBed(kit, g, o) {
  const sims = kit.sims || {};
  const { z0, z1, m0, mt, top } = g;
  const bigR = g.R;
  kit.part('Base', 'upholstery', (b) => {
    kit.cushion(b, new Frame([0, 0, (z0 + z1) / 2]), g.r_in - 0.3, g.r_in - 0.3, z1 - z0, { corner: g.r_in, rim: 2.0, grid: 8 });
    if (!g.legs) kit.cushion(b, new Frame([0, 0, z0 / 2]), g.r_out - 7, g.r_out - 7, z0, { corner: g.r_out, rim: 0.4, grid: 16 });
  });
  if (g.legs) {
    kit.part('Legs', 'dark', (b) => {
      for (let k = 0; k < 6; k++) {
        const a = 2 * PI * (k + 0.5) / 6;
        kit.lathe(b, [sin(a) * (g.r_out - 10), -cos(a) * (g.r_out - 10), 0], [[1.7, 0], [2.7, z0 + 1]], { seg: 14 });
      }
    });
  }
  roundHeadboard(kit, o.headboard, g);
  kit.part('Mattress', 'linen', (b) => {
    kit.cushion(b, new Frame([0, 0, m0 + mt / 2]), bigR, bigR, mt, { corner: bigR, rim: 7.0, bulge: 0.8, grid: 6 });
  });
  if (o.bedding !== 'none') {
    const sre = 7.0;
    const sstand = sre + 0.6;
    const half = bigR - sre + PI / 2 * sstand + (mt - sstand - 3);
    kit.part('Sheet', 'linen', (b) => {
      kit.cloth(b, { size: [2 * half, 2 * half], centre: [0, 0], sup: { hx: bigR - sre, hy: bigR - sre, top: top + 0.2, r: bigR - sre },
        stand: sstand, floor: m0 + 1, grid: 4.0, thick: 1.0, thick_hang: 0.8, crease: 0.5, crease_size: 16, waves: 0.3,
        fold: 0.5, fold_size: 10, flare: 0.0, disc: true });
    });
  }
  bedPillows(kit, Number.parseInt(o.pillows, 10), g.pillow_w, g.head_front, top, sims, g.r_in);
  if (o.bedding === 'none') return;

  const tucked = o.bedding === 'tucked';
  const rs = bigR - 7.0;
  kit.part('Duvet', 'duvet', (b) => {
    kit.cloth(b, { size: [2 * g.duvet_r, 2 * g.duvet_r], centre: [0, 0], sim: sims.Duvet, disc: true,
      sup: { hx: rs, hy: rs, top: top + 1.8, r: rs }, stand: g.rstand, floor: z1 + 1, grid: 3.0,
      thick: tucked ? 3.5 : g.thick * 0.75, thick_hang: tucked ? 2.5 : g.thick_hang * 0.8,
      crease: tucked ? 0.5 : 1.6, crease_size: 30, waves: tucked ? 0.3 : 2.0, fold: tucked ? 0.8 : 3.0, fold_size: 18,
      flare: tucked ? 0.3 : 1.5, edge_puff: tucked ? 0.0 : 2.0, hem: tucked ? [1.5, 3.0] : [3.0, 4.0] });
  });
  bedThrow(kit, g, o, sims);
}

function roundHeadboard(kit, style, g) {
  const seams = { channel: 14, tufted: 22, wing: 12, panel: 10, slats: 0 }[style] ?? 8;
  const puff = { channel: 1.8, tufted: 1.3, padded: 0.8, none: 0.8 }[style] ?? 1.0;
  const lo = g.ring_front;
  const hi = g.ring_back;
  const [r0, r1] = g.ring_rise.map((f) => f * PI);
  const topAt = (phi) => lo + (hi - lo) * smooth(r0, r1, phi);
  kit.part('Headboard', style === 'slats' ? 'wood' : 'upholstery', (b) => {
    kit.ring(b, { r_in: g.r_in, width: g.ring_w, z0: g.z0, top_at: topAt, seams, puff, piping: style === 'slats' ? 0.0 : 0.8 });
  });
}

function roundSimSpec(g, o, seed, quality) {
  const res = { fast: 5.0, high: 3.2 }[quality] || 4.0;
  const colliders = [
    { kind: 'cyl', c: [0, 0, g.z1 / 2], R: g.r_in, hz: g.z1 / 2, r: 2.0 },
    { kind: 'cyl', c: [0, 0, g.m0 + g.mt / 2], R: g.R, hz: g.mt / 2, r: 7.0 },
    { kind: 'ring', r_in: g.r_in, r_out: g.r_out, z0: g.z0, front: g.ring_front, back: g.ring_back, rise: g.ring_rise },
  ];
  const cloths = [];
  if (o.bedding === 'duvet') {
    const rad = g.duvet_r;
    const n = rround(2 * rad / res);
    cloths.push({ id: 'Duvet', disc: true, sx: 2 * rad, sy: 2 * rad, nx: n, ny: n, o: [0, 0, g.top + 4],
      u: [1, 0, 0], v: [0, 1, 0], cap: { r: g.R - 5.0, re: g.rstand, ease: 0.008 },
      steps: 280, iters: 8, bend: 0.45, shear: 0.6, inflate: 1.8, friction: 0.4,
      damping: 0.982, waves: 0.9, self: true, thickness: g.thick_hang + 0.5, seed });
    if (g.throw && o.throw !== 'none') {
      const [[tsx, tsy], [tcx, tcy], turn] = g.throw;
      const a = turn * PI / 180;
      const r2 = res * 0.8;
      cloths.push({ id: 'Throw', sx: tsx, sy: tsy, nx: rround(tsx / r2), ny: rround(tsy / r2), scrunch: 0.2,
        o: [tcx, tcy, g.top + g.thick + 7], u: [cos(a), sin(a), 0], v: [-sin(a), cos(a), 0],
        steps: 320, iters: 8, bend: 0.24, shear: 0.5, gather: 0.85, gather_dir: 0, fold: 52,
        waves: 1.5, inflate: 2.0, friction: 0.4, damping: 0.982, self: true, thickness: 5.0,
        over: { id: 'Duvet', r_top: g.thick + 2.0, r_side: g.thick_hang + 3.0, z_split: g.top - 4 },
        seed: seed + 1 });
    }
  }
  const cell = { fast: 3.6, high: 2.1 }[quality] || 2.7;
  const poses = bedPillowLayout(Number.parseInt(o.pillows, 10), g.pillow_w, g.head_front, g.top, seed, g.r_in);
  const pillows = [];
  poses.forEach((pose, k) => { if (!pose.round) pillows.push(pillowSpec(pose, cell, seed + 11 + k)); });
  return { floor: 0, colliders, cloths, pillows };
}

function bedHeadboard(kit, style, wb, lb, head) {
  const z0 = 14.0;
  const ht = head - z0;
  const t = headboardDepth(style);
  const yc = lb / 2 + t / 2 - 1.5;
  const f = upright([0, yc, z0 + ht / 2]);
  kit.part('Headboard', style === 'slats' ? 'wood' : 'upholstery', (b) => {
    switch (style) {
      case 'channel':
        kit.cushion(b, f, wb / 2 + 4, ht / 2, t, { corner: 7, bulge: 2.4, pattern: ['channels', 15.0, 3.4], grid: 1.5, piping: [55] }); break;
      case 'tufted':
        kit.cushion(b, f, wb / 2 + 4, ht / 2, t, { corner: 7, bulge: 3.0, pattern: ['tufts', 19.0, 15.0, 3.2], grid: 1.4, piping: [55] }); break;
      case 'wing': {
        const wing = 26.0;
        kit.cushion(b, f, wb / 2 + 2 + wing, ht / 2, t, { corner: 9, bulge: 2.4, pattern: ['channels', 14.0, 3.4],
          bend: [wb / 2 + 2, wing * 0.95], grid: 1.5, piping: [55] });
        break;
      }
      case 'panel':
        kit.cushion(b, f, wb / 2 + 4, ht / 2, t, { corner: 6, bulge: 2.0, pattern: ['rows', ht / 3.0, 2.8], grid: 2.0, piping: [55] }); break;
      case 'slats': {
        const n = floor((wb + 8) / 11);
        const pitch = (wb + 8) / n;
        for (let k = 0; k < n; k++) {
          kit.cushion(b, upright([-wb / 2 - 4 + pitch * (k + 0.5), yc, z0 + ht / 2 - 2]), pitch / 2 - 1.6, ht / 2 - 2, t,
            { corner: 0.6, rim: 0.5, grid: 9 });
        }
        kit.cushion(b, upright([0, yc - 0.5, head - 3]), wb / 2 + 6, 3.0, t + 2, { corner: 1, rim: 0.6, grid: 8 });
        break;
      }
      default:
        kit.cushion(b, f, wb / 2 + 1, ht / 2, t, { corner: 15, rim: 8.0, bulge: 5.0, grid: 3.0 });
    }
  });
}

function bedPillows(kit, count, w, headFront, top, sims = {}, round = null) {
  for (const pose of bedPillowLayout(count, w, headFront, top, kit.seed, round)) {
    const [pw, ph, pt] = pose.size;
    const b = pose.lean;
    const f0 = new Frame([pose.x, pose.cy, pose.cz], [1, 0, 0], [0, sin(b), cos(b)]);
    const f = f0.turned([0, 0, 1], pose.yaw).turned(f0.w, pose.roll);
    kit.part(pose.id, pose.role, (buf) => {
      if (pose.round) {
        kit.cushion(buf, f, pw / 2.0, ph / 2.0, pt, { corner: pw / 2.0, rim: 'round', bulge: 3.5, back: 2.5, grid: 2.0 });
      } else {
        kit.pillow(buf, f, pw, ph, pt, { puff: 0.24, pinch: 0.07, crease: 0.6, seam: 0.3, sim: sims[pose.id] });
      }
    });
  }
}

// ---------------------------------------------------------------- sofa, armchair
function sofaSizes(type, h, w, d, o) {
  [w, d, h] = overallSize(type, h, w, d);
  const z0 = o.base === 'legs' ? 13.0 : 2.0;
  return [type === 'sofa' ? Number.parseInt(o.seats, 10) : 1, w, d - sofaRake(h - z0), h];
}

const sofaRake = (backHeight) => max(backHeight / 2.0 * sin(6 * PI / 180) - 0.35, 0.0);

function planeIn(frame, n, d) {
  return { n: [V.dot(n, frame.u), V.dot(n, frame.v), V.dot(n, frame.w)], d: d - V.dot(n, frame.o) };
}

export function sofaLayout(seats, w, d, h, o, seed) {
  const rnd = new RubyRandom(Math.trunc(seed) + 23);
  const r = (a, b) => a + (b - a) * rnd.rand();
  const arms = o.arms;
  const g = { arms, legs: o.base === 'legs', wing: o.back === 'wing', deck: 30.0, seat_t: 14.0, back_t: 17.0 };
  g.aw = arms === 'none' ? 0.0 : ({ rolled: 21.0, slope: 16.0 }[arms] ?? 18.0);
  g.z0 = g.legs ? 13.0 : 2.0;
  g.arm_top = h * (arms === 'slope' ? 0.66 : 0.72);
  g.inner = w - 2 * g.aw;
  g.sw = g.inner / max(seats, 1);
  g.back_top = h;
  const { deck, seat_t, back_t, inner, sw } = g;
  const seatTop = deck + seat_t;
  const centres = Array.from({ length: seats }, (_, i) => -inner / 2 + sw * (i + 0.5));
  const sides = (cx) => [[[1, 0, 0], cx - sw / 2 + 0.1], [[-1, 0, 0], -(cx + sw / 2 - 0.1)]];
  g.seat_parts = centres.map((cx, i) => {
    const f = new Frame([cx, -back_t / 2 + 2, deck + seat_t / 2 - 1]);
    return { id: `Seat ${i + 1}`, frame: f, a: sw / 2 - 0.6, b: (d - back_t - 2) / 2, t: seat_t, band: seat_t - 2.5, crown: 2.4 + r(-0.4, 0.4), down: [0, 0, -1],
      planes: [[[0, 0, 1], deck - 1.5], [[0, -1, 0], -(d / 2 - back_t + 1)]].concat(sides(cx)) };
  });
  const bh = (g.back_top - deck - seat_t) * 0.95;
  g.back_parts = o.back === 'cushions'
    ? centres.map((cx, i) => {
      const f = new Frame([cx, d / 2 - back_t - 9, seatTop + bh / 2 - 2], [1, 0, 0], [0, 0, 1], [0, -1, 0]).turned([1, 0, 0], -13);
      return { id: `Back ${i + 1}`, frame: f, a: sw / 2 - 1.2, b: bh / 2, t: 17.0, band: 9.0, crown: 5.5 + r(-0.8, 0.8), spread: 0.94, down: [0, 0, -1],
        planes: [[[0, 0, 1], seatTop - 1.5], [[0, -1, 0], -(d / 2 - back_t + 1.5)]].concat(sides(cx)) };
    })
    : [];
  const frontOfBack = d / 2 - back_t - (o.back === 'cushions' ? 16 : 1);
  g.pillows = Array.from({ length: Number.parseInt(o.pillows, 10) || 0 }, (_, k) => {
    const sx = even(k) ? -1 : 1;
    const inset = k < 2 ? 0 : 24;
    const f = new Frame([sx * (inner / 2 - 23 - inset), d / 2 - back_t - 22 - (k < 2 ? 0 : 6), seatTop + 19], [1, 0, 0], [0, 0.34, 0.94]);
    return { id: `Pillow ${k + 1}`, frame: f.turned([0, 0, 1], -sx * 12 + r(-4, 4)), size: 44.0, t: 16.0, down: [0, 0, -1],
      planes: [[[0, 0, 1], seatTop - 1.5], [[0, -1, 0], -frontOfBack]] };
  });
  return g;
}

function softSpec(part, cell, seed) {
  let spec;
  if (part.size) {
    const side = part.size * 1.07;
    const n = rround(side / cell);
    spec = { w: side, h: side, nx: n, ny: n, volume: 0.6 * part.size ** 2 * part.t };
  } else {
    const fw = 2 * part.a * 1.03;
    const fh = 2 * part.b * 1.03;
    spec = { w: fw, h: fh, nx: rround(fw / cell), ny: rround(fh / cell), volume: 4 * part.a * part.b * (part.band + part.crown),
      band: { h: part.band, rows: 3 }, spread: part.spread || 0.97, bend: 0.2 };
  }
  const f = part.frame;
  return Object.assign(spec, { id: part.id, seed, steps: 220, gravity: 3,
    down: part.down ? [V.dot(part.down, f.u), V.dot(part.down, f.v), V.dot(part.down, f.w)] : [0, 0, 0],
    planes: (part.planes || []).map(([n, d]) => planeIn(f, n, d)) });
}

function sofaSimSpec(type, h, w, d, o, seed, quality) {
  let seats;
  [seats, w, d, h] = sofaSizes(type, h, w, d, o);
  const g = sofaLayout(seats, w, d, h, o, seed);
  const cell = { fast: 4.6, high: 2.4 }[quality] || 3.2;
  const parts = g.seat_parts.concat(g.back_parts, g.pillows);
  const spec = { floor: 0, colliders: [], cloths: [], pillows: parts.map((part, k) => softSpec(part, cell, seed + 31 + k)) };
  const layout = sofaThrow(g, o, w, d, h);
  if (!layout) return spec;
  spec.colliders = sofaColliders(g, w, d, h);
  const [[sx, sy], [cx, cy], z, alongX] = layout;
  const res = { fast: 4.4, high: 2.4 }[quality] || 3.2;
  spec.cloths.push({ id: 'Throw', sx, sy, nx: rround(sx / res), ny: rround(sy / res),
    o: [cx, cy, z], u: [1, 0, 0], v: [0, 1, 0], steps: 340, iters: 8, bend: 0.2, shear: 0.5,
    gather: 0.88, gather_dir: alongX ? 90 : 0, fold: 40, scrunch: 0.15, waves: 2.0, inflate: 2.0,
    drape: { cx: 0, cy: 0, hx: w / 2 + 1, hy: d / 2 + 1, margin: 3, pile: 5 },
    friction: 0.5, damping: 0.982, self: true, thickness: 4.0, seed: seed + 3 });
  return spec;
}

function sofaThrow(g, o, _w, d, h) {
  if (!o.throw || o.throw === 'none') return null;
  if (o.throw === 'over_arm' && g.aw > 0) {
    const armX = -(g.inner / 2 + g.aw / 2);
    return [[172.0, 62.0], [armX + 26.0, -6.0], g.arm_top + 10, true];
  }
  const length = d + 58.0;
  return [[max(g.inner * 0.72, 72.0), length], [-g.inner * 0.14, d / 2 + 24 - length / 2], h + 10, false];
}

function sofaColliders(g, w, d, _h) {
  const { deck, seat_t, back_t, inner } = g;
  const list = [{ c: [0, 0, deck / 2], h: [w / 2 - g.aw + 1, d / 2, deck / 2], r: 2.5 },
    { c: [0, -back_t / 2 + 2, deck + seat_t / 2 + 0.5], h: [inner / 2, (d - back_t - 2) / 2, seat_t / 2 + 1.5], r: 4.0 }];
  if (g.aw > 0) {
    for (const sx of [-1, 1]) list.push({ c: [sx * (w / 2 - g.aw / 2), 0, (g.z0 + g.arm_top) / 2], h: [g.aw / 2, d / 2, (g.arm_top - g.z0) / 2], r: 5.0 });
  }
  const tilted = (frame, a, b, t, r) => ({ c: frame.o, h: [a, b, t], r, axes: [frame.u, frame.v, frame.w] });
  const back = new Frame([0, d / 2 - back_t / 2, (g.z0 + g.back_top) / 2], [1, 0, 0], [0, 0, 1], [0, -1, 0]).turned([1, 0, 0], -6);
  list.push(tilted(back, inner / 2 + 1, (g.back_top - g.z0) / 2, back_t / 2, 5.0));
  for (const p of g.back_parts) list.push(tilted(p.frame, p.a, p.b, p.t / 2 + 2, 6.0));
  for (const p of g.pillows) list.push(tilted(p.frame, p.size / 2 - 2, p.size / 2 - 2, p.t / 2 + 1, 6.0));
  return list;
}

function chairSimSpec(h, w, d, o, seed, quality) {
  [w, d, h] = chairSizes(h, w, d, o);
  const parts = chairSoftParts(w, d, h, o);
  if (!parts.length) return null;
  const cell = { fast: 4.0, high: 1.8 }[quality] || 2.6;
  return { floor: 0, colliders: [], cloths: [], pillows: parts.map((part, k) => softSpec(part, cell, seed + 41 + k)) };
}

const CHAIR_SEAT = 46.0;
const CHAIR_ARM_OUT = 4.0;

function chairSizes(h, w, d, o = {}) {
  [w, d, h] = overallSize('chair', h, w, d);
  if (o.arms === 'yes') w -= 2 * CHAIR_ARM_OUT;
  return [w, d - (o.back === 'upholstered' || o.back == null ? chairRake(h) : 0.0), h];
}

const chairBackH = (h) => h - CHAIR_SEAT - 1.5;
const chairRake = (h) => max(chairBackH(h) / 2.0 * sin(8 * PI / 180) + 0.4, 0.0);

function chairSoftParts(w, d, h, o) {
  const seat = CHAIR_SEAT;
  const soft = o.back === 'upholstered';
  const st = soft ? 7.0 : 4.0;
  const bh = chairBackH(h);
  const yb = d / 2 - 3;
  const parts = [];
  if (soft) {
    parts.push({ id: 'Seat', frame: new Frame([0, 0, seat - st / 2]), a: w / 2, b: d / 2, t: st, band: st - 2.0, crown: 1.6, down: [0, 0, -1],
      planes: [[[0, 0, 1], seat - st]] });
    parts.push({ id: 'Back', frame: upright([0, yb, seat + 1 + bh / 2]).turned([1, 0, 0], -8), a: w / 2 - 1, b: bh / 2, t: 7.0, band: 4.5, crown: 1.8 });
  } else if (o.pad === 'yes') {
    parts.push({ id: 'Seat pad', frame: new Frame([0, -1, seat + 1.9]), a: w / 2 - 2, b: d / 2 - 3, t: 3.8, band: 2.6, crown: 1.1, down: [0, 0, -1],
      planes: [[[0, 0, 1], seat]] });
  }
  return parts;
}

function sofaLike(kit, seats, w, d, h, o) {
  const g = sofaLayout(seats, w, d, h, o, kit.seed);
  const sims = kit.sims || {};
  const { arms, legs, wing, aw, z0, deck, seat_t, back_t, arm_top, inner } = g;
  kit.part('Base', 'fabric', (b) => {
    kit.cushion(b, new Frame([0, 0, (z0 + deck) / 2]), w / 2 - aw + (aw > 0 ? 1 : 0), d / 2, deck - z0, { corner: 3, rim: 2.5, grid: 8 });
    if (!legs) kit.cushion(b, new Frame([0, 0, 1]), w / 2 - 4, d / 2 - 4, 2, { corner: 2, rim: 0.3, grid: 20 });
  });
  if (arms !== 'none') {
    kit.part('Arms', 'fabric', (b) => {
      for (const sx of [-1, 1]) {
        const cx = sx * (w / 2 - aw / 2);
        if (arms === 'rolled') {
          kit.cushion(b, new Frame([cx, 0, (z0 + arm_top - 9) / 2], [0, 1, 0], [0, 0, 1]), d / 2, (arm_top - 9 - z0) / 2, aw - 6,
            { corner: 3, rim: 3.0, grid: 6 });
          kit.cushion(b, new Frame([cx + sx * (aw / 2 - 10.5), 0, arm_top - 9], [0, 1, 0], [1, 0, 0]), d / 2 + 1, 10.5, 21, { corner: 10, grid: 4 });
        } else {
          kit.cushion(b, new Frame([cx, 0, (z0 + arm_top) / 2], [0, 1, 0], [0, 0, 1]), d / 2, (arm_top - z0) / 2, aw,
            { corner: arms === 'slope' ? 14 : 5, rim: arms === 'slope' ? 'round' : 4.5, bulge: 0.5, back: 0.5, grid: 5 });
        }
      }
    });
  }
  const backTop = g.back_top;
  kit.part('Back', 'fabric', (b) => {
    const f = new Frame([0, d / 2 - back_t / 2, (z0 + backTop) / 2], [1, 0, 0], [0, 0, 1], [0, -1, 0]).turned([1, 0, 0], -6);
    const tufted = o.back === 'tufted';
    kit.cushion(b, f, inner / 2 + (arms === 'none' ? 0 : 1), (backTop - z0) / 2, back_t, { corner: wing ? 16 : 5,
      rim: tufted || o.back === 'tight' ? 'round' : 4.0, bulge: tufted ? 3.0 : 1.0,
      pattern: tufted ? ['tufts', 18.0, 15.0, 3.0] : null, grid: tufted ? 1.6 : 5 });
    if (wing) {
      for (const sx of [-1, 1]) {
        kit.cushion(b, new Frame([sx * (inner / 2 - 5), d / 2 - 22, backTop - 24], [0, 1, 0], [0, 0, 1]), 17, 24, 10, { corner: 14, grid: 4 });
      }
    }
  });
  kit.part('Seat cushions', 'cushion', (b) => {
    for (const c of g.seat_parts) {
      if (sims[c.id]) kit.pillowFromSim(b, c.frame, sims[c.id], { piping: 0.45 });
      else kit.cushion(b, c.frame, c.a, c.b, c.t, { corner: 5, rim: 4.5, bulge: 2.2, back: 0.5, grid: 4, piping: [45, -45], piping_r: 0.5 });
    }
  });
  if (g.back_parts.length) {
    kit.part('Back cushions', 'cushion', (b) => {
      for (const c of g.back_parts) {
        if (sims[c.id]) kit.pillowFromSim(b, c.frame, sims[c.id], { piping: 0.45 });
        else kit.cushion(b, c.frame, c.a, c.b, c.t, { corner: 9, bulge: 3.5, back: 1.5, grid: 4, piping: [0], piping_r: 0.5 });
      }
    });
  }
  if (g.pillows.length) {
    kit.part('Pillows', 'accent', (b) => {
      for (const c of g.pillows) kit.pillow(b, c.frame, c.size, c.size, 14, { sim: sims[c.id] });
    });
  }
  const layout = sofaThrow(g, o, w, d, h);
  if (layout) {
    const [[sx, sy], [cx, cy]] = layout;
    kit.part('Throw', 'accent', (b) => {
      kit.cloth(b, { size: [sx, sy], centre: [cx, cy], sup: { hx: inner / 2 - 2, hy: (d - back_t) / 2 - 4, cy: -back_t / 2, top: deck + seat_t + 2 }, stand: 10.0,
        floor: 1.0, grid: 2.6, thick: 2.6, crease: sims.Throw ? 0.5 : 2.0, crease_size: 16, waves: 2.0, fold: 3.0, fold_size: 14, flare: 2.0,
        sim: sims.Throw });
    });
  }
  if (!legs) return;
  kit.part('Legs', 'dark', (b) => {
    const xs = seats > 2 ? [-1.0, 0.0, 1.0] : [-1.0, 1.0];
    for (const sx of xs) {
      for (const sy of [-1.0, 1.0]) kit.lathe(b, [sx * (w / 2 - 7), sy * (d / 2 - 7), 0], [[1.4, 0], [2.4, z0 + 0.5]], { seg: 12 });
    }
  });
}

// ---------------------------------------------------------------- dining chair
function buildChair(kit, h, w, d, o) {
  [w, d, h] = chairSizes(h, w, d, o);
  const sims = kit.sims || {};
  const softParts = Object.fromEntries(chairSoftParts(w, d, h, o).map((c) => [c.id, c]));
  const seat = 46.0;
  const soft = o.back === 'upholstered';
  const st = soft ? 7.0 : 4.0;
  const legsTop = seat - st;
  kit.part('Legs', 'wood', (b) => {
    for (const [sx, sy] of CORNERS) {
      const c = [sx * (w / 2 - 3), sy * (d / 2 - 3), 0];
      if (o.legs === 'straight') {
        kit.cushion(b, new Frame([c[0], c[1], legsTop / 2], [1, 0, 0], [0, 0, 1], [0, -1, 0]), 2.0, legsTop / 2, 4.0, { corner: 0.4, rim: 0.4, grid: 8 });
      } else {
        kit.lathe(b, c, [[1.2, 0], [2.1, legsTop]], { seg: 12 });
      }
    }
    for (const sx of [-1, 1]) kit.tube(b, [[sx * (w / 2 - 3), -d / 2 + 3, 16], [sx * (w / 2 - 3), d / 2 - 3, 16]], 0.9, { seg: 8 });
    kit.tube(b, [[-w / 2 + 3, 0, 20], [w / 2 - 3, 0, 20]], 0.9, { seg: 8 });
  });
  kit.part('Seat', soft ? 'fabric' : 'wood', (b) => {
    if (soft && sims.Seat) kit.pillowFromSim(b, softParts.Seat.frame, sims.Seat);
    else kit.cushion(b, new Frame([0, 0, seat - st / 2]), w / 2, d / 2, st, { corner: 4, rim: soft ? 2.5 : 1.0, bulge: soft ? 1.8 : 0.3, grid: 3 });
  });
  if (softParts['Seat pad']) {
    const c = softParts['Seat pad'];
    kit.part('Seat pad', 'cushion', (b) => {
      if (sims['Seat pad']) kit.pillowFromSim(b, c.frame, sims['Seat pad'], { piping: 0.3 });
      else kit.cushion(b, c.frame, c.a, c.b, c.t, { corner: 4, rim: 1.5, bulge: 1.0, grid: 3 });
    });
  }
  const bh = chairBackH(h);
  const yb = d / 2 - 3;
  kit.part('Back', soft ? 'fabric' : 'wood', (b) => {
    const post = (sx) => kit.lathe(b, [sx * (w / 2 - 3), yb, seat - 1], [[1.6, 0], [1.4, bh + 2.5]], { seg: 10 });
    switch (o.back) {
      case 'upholstered': {
        for (const sx of [-1, 1]) kit.lathe(b, [sx * (w / 2 - 4), yb + 2.5, seat - 1], [[1.5, 0], [1.3, bh * 0.75]], { seg: 10 });
        const f = upright([0, yb, seat + 1 + bh / 2]).turned([1, 0, 0], -8);
        if (sims.Back) kit.pillowFromSim(b, f, sims.Back);
        else kit.cushion(b, f, w / 2 - 1, bh / 2, 7, { corner: 6, rim: 3.0, bulge: 1.6, back: 0.8, grid: 3 });
        break;
      }
      case 'solid': {
        [-1, 1].forEach(post);
        const f = upright([0, yb, seat + bh * 0.62]).turned([1, 0, 0], -8);
        kit.cushion(b, f, w / 2 - 4, bh * 0.3, 2.2, { corner: 3, rim: 0.8, grid: 3 });
        break;
      }
      case 'slats': {
        [-1, 1].forEach(post);
        kit.cushion(b, upright([0, yb, seat + bh - 3]).turned([1, 0, 0], -8), w / 2 - 3, 4, 2.4, { corner: 2, rim: 0.7, grid: 3 });
        const n = 5;
        for (let k = 0; k < n; k++) {
          const x = -w / 2 + 6 + (w - 12) * k / (n - 1);
          kit.cushion(b, upright([x, yb, seat + 2 + (bh - 7) / 2]).turned([1, 0, 0], -8), 1.5, (bh - 7) / 2, 1.6, { corner: 0.5, rim: 0.5, grid: 4 });
        }
        break;
      }
      default:
        [-1, 1].forEach(post);
        for (let k = 0; k < 3; k++) {
          kit.cushion(b, upright([0, yb, seat + bh * (0.45 + 0.25 * k)]).turned([1, 0, 0], -8), w / 2 - 3, 2.5, 2.2, { corner: 1.5, rim: 0.7, grid: 3 });
        }
    }
  });
  if (o.arms !== 'yes') return;
  kit.part('Arms', 'wood', (b) => {
    for (const sx of [-1, 1]) {
      const x = sx * (w / 2 + CHAIR_ARM_OUT - 3);
      kit.tube(b, [[x, -d / 2 + 6, seat - 2], [x, -d / 2 + 6, seat + 18]], 1.3, { seg: 10 });
      kit.cushion(b, new Frame([x, 0, seat + 19.5]), 3, d / 2 - 2, 3, { corner: 2.5, rim: 1.2, grid: 3 });
    }
  });
}

// ---------------------------------------------------------------- tables
function tableLike(kit, w, d, h, thick, o) {
  const shape = o.top;
  if (shape === 'round') w = d = max(w, d);
  const corner = { round: w / 2, oval: d / 2 }[shape] ?? 1.8;
  kit.part('Top', 'wood', (b) => {
    kit.cushion(b, new Frame([0, 0, h - thick / 2]), w / 2, d / 2, thick, { corner, rim: 1.0, grid: shape === 'rect' ? 8 : 4 });
  });
  const lt = h - thick;
  let style = o.legs;
  if (shape === 'round' && style === 'trestle') style = 'pedestal';
  kit.part('Legs', 'dark', (b) => {
    switch (style) {
      case 'pedestal': {
        const r = min(w, d) * 0.22;
        kit.lathe(b, [0, 0, 0], [[r, 0], [r, 1.6], [r * 0.55, 3.2], [r * 0.3, 5], [r * 0.22, lt * 0.5], [r * 0.3, lt - 3], [r * 0.5, lt]],
          { seg: 28, scale: shape === 'oval' ? [w / d, 1.0] : [1.0, 1.0] });
        break;
      }
      case 'trestle':
        for (const sx of [-1, 1]) {
          const x = sx * (w / 2 - 14);
          kit.cushion(b, new Frame([x, 0, lt / 2], [0, 1, 0], [0, 0, 1]), 3.0, lt / 2, 5, { corner: 0.5, rim: 0.5, grid: 8 });
          kit.cushion(b, new Frame([x, 0, 2.5], [0, 1, 0], [0, 0, 1]), d / 2 - 8, 2.5, 6, { corner: 1, rim: 0.6, grid: 6 });
          kit.cushion(b, new Frame([x, 0, lt - 2.5], [0, 1, 0], [0, 0, 1]), d / 2 - 10, 2.5, 6, { corner: 1, rim: 0.6, grid: 6 });
        }
        kit.cushion(b, new Frame([0, 0, lt * 0.35], [1, 0, 0], [0, 0, 1], [0, -1, 0]), w / 2 - 14, 3, 4, { corner: 1, rim: 0.6, grid: 8 });
        break;
      case 'hairpin':
        for (const [sx, sy] of CORNERS) {
          const x = sx * (w / 2 - 9);
          const y = sy * (d / 2 - 9);
          kit.tube(b, [[x - sx * 6, y, lt], [x, y, 0.6], [x, y - sy * 6, lt]], 0.6, { seg: 8 });
        }
        break;
      default: {
        const ax = shape === 'rect' ? w / 2 - 5 : w / 2 * 0.62;
        const ay = shape === 'rect' ? d / 2 - 5 : d / 2 * 0.62;
        for (const [sx, sy] of CORNERS) {
          if (style === 'straight') {
            kit.cushion(b, new Frame([sx * ax, sy * ay, lt / 2], [1, 0, 0], [0, 0, 1], [0, -1, 0]), 2.6, lt / 2, 5.2, { corner: 0.5, rim: 0.5, grid: 8 });
          } else {
            kit.lathe(b, [sx * ax, sy * ay, 0], [[1.3, 0], [2.7, lt]], { seg: 14 });
          }
        }
        if (shape === 'rect' && h > 50) {
          kit.cushion(b, new Frame([0, -(d / 2 - 5), lt - 4], [1, 0, 0], [0, 0, 1], [0, -1, 0]), w / 2 - 8, 4, 2.2, { corner: 0.5, rim: 0.4, grid: 10 });
          kit.cushion(b, new Frame([0, d / 2 - 5, lt - 4], [1, 0, 0], [0, 0, 1], [0, -1, 0]), w / 2 - 8, 4, 2.2, { corner: 0.5, rim: 0.4, grid: 10 });
          kit.cushion(b, new Frame([-(w / 2 - 5), 0, lt - 4], [0, 1, 0], [0, 0, 1]), d / 2 - 8, 4, 2.2, { corner: 0.5, rim: 0.4, grid: 10 });
          kit.cushion(b, new Frame([w / 2 - 5, 0, lt - 4], [0, 1, 0], [0, 0, 1]), d / 2 - 8, 4, 2.2, { corner: 0.5, rim: 0.4, grid: 10 });
        }
      }
    }
  });
}

// ---------------------------------------------------------------- storage
const FRONT_T = 1.8;
const RUNNER = 1.25;

function storageSize(type, h, w, d) {
  [w, d, h] = overallSize(type, h, w, d);
  return [w, d - FRONT_T, h];
}

function storage(kit, w, d, h, o, rows) {
  const legs = o.base === 'legs';
  const base = legs ? 14.0 : 8.0;
  const sideH = h - base - 2.4;
  storagePanel(kit, 'Carcass left', [-w / 2 + 0.9, 0, base + sideH / 2], [1.8, d, sideH]);
  storagePanel(kit, 'Carcass right', [w / 2 - 0.9, 0, base + sideH / 2], [1.8, d, sideH]);
  storagePanel(kit, 'Carcass bottom', [0, 0, base + 0.9], [w - 3.6, d, 1.8]);
  storagePanel(kit, 'Carcass back', [0, d / 2 - 0.3, base + 1.8 + (sideH - 1.8) / 2], [w - 3.6, 0.6, sideH - 1.8]);
  storagePanel(kit, 'Carcass top', [0, 0, h - 1.2], [w, d, 2.4]);
  if (!legs) storagePanel(kit, 'Plinth', [0, 1, base / 2], [w - 8, d - 10, base]);
  if (legs) {
    kit.part('Legs', 'dark', (b) => {
      for (const [sx, sy] of CORNERS) kit.lathe(b, [sx * (w / 2 - 5), sy * (d / 2 - 5), 0], [[1.1, 0], [2.0, base + 0.5]], { seg: 12 });
    });
  }
  const fz0 = base + 1.5;
  const fz1 = h - 3.5;
  const layout = [];
  if (o.fronts === 'door' || o.fronts === 'doors') {
    const cols = w > 70 ? max(2, rround(w / 55)) : 1;
    for (let c = 0; c < cols; c++) layout.push([c, cols, fz0, fz1, 'door']);
  } else if (o.fronts === 'mixed') {
    const cols = max(rround(w / 55), 2);
    const split = fz1 - (fz1 - fz0) * (h > 150 ? 0.2 : 0.3);
    for (let c = 0; c < cols; c++) layout.push([c, cols, split, fz1, 'drawer']);
    for (let c = 0; c < cols; c++) layout.push([c, cols, fz0, split, 'door']);
  } else {
    const cols = w > 120 ? 2 : 1;
    const rh = (fz1 - fz0) / rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) layout.push([c, cols, fz0 + rh * r, fz0 + rh * (r + 1), 'drawer']);
  }
  storageInterior(kit, w, d, h, base, o, layout);
  const shaker = o.style === 'shaker';
  kit.part('Fronts', 'cushion', (b) => {
    for (const [c, cols, z0, z1] of layout) {
      const fw = (w - 2) / cols;
      const cx = -w / 2 + 1 + fw * (c + 0.5);
      const f = new Frame([cx, -d / 2 - FRONT_T / 2, (z0 + z1) / 2], [1, 0, 0], [0, 0, 1], [0, -1, 0]);
      const margin = min(min(fw, z1 - z0) * 0.14, 5);
      const fine = max(min(fw, z1 - z0) / 32.0, 1.2);
      kit.cushion(b, f, fw / 2 - 0.25, (z1 - z0) / 2 - 0.25, 1.8, { corner: 0.4, rim: 0.3,
        pattern: shaker ? ['inset', margin, 0.6] : null, grid: shaker ? fine : 8 });
    }
  });
  if (o.handles === 'none') return;
  kit.part('Handles', 'dark', (b) => {
    for (const [c, cols, z0, z1, kind] of layout) {
      const fw = (w - 2) / cols;
      const cx = -w / 2 + 1 + fw * (c + 0.5);
      const y = -d / 2 - 1.8;
      if (kind === 'door') {
        const hx = cols === 1 ? cx + fw / 2 - 5 : cx + (even(c) ? fw / 2 - 4 : -fw / 2 + 4);
        const hz = h > 150 ? fz0 + (fz1 - fz0) * 0.5 : z1 - 10;
        if (o.handles === 'knob') knob(b, [hx, y, hz]);
        else { const len = h > 150 ? 30.0 : 14.0; bar(kit, b, [hx, y, hz - len / 2], [hx, y, hz + len / 2]); }
      } else {
        const hz = (z0 + z1) / 2 + (shaker ? 0 : (z1 - z0) * 0.18);
        if (o.handles === 'knob') knob(b, [cx, y, hz]);
        else { const len = min(fw * 0.35, 22); bar(kit, b, [cx - len / 2, y, hz], [cx + len / 2, y, hz]); }
      }
    }
  });
}

function storageBox(buf, center, size) {
  const [x, y, z] = center;
  const [a, b, c] = size.map((v) => v / 2.0);
  if (!(a > 0 && b > 0 && c > 0)) throw new Error('Panel sizes must be positive');
  const pts = [[-a, -b, -c], [a, -b, -c], [a, b, -c], [-a, b, -c], [-a, -b, c], [a, -b, c], [a, b, c], [-a, b, c]]
    .map(([dx, dy, dz]) => buf.pt([x + dx, y + dy, z + dz]));
  for (const face of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) buf.quad(...face.map((i) => pts[i]));
}

function storagePanel(kit, name, center, size) {
  kit.part(name, 'wood', (buf) => storageBox(buf, center, size));
}

function storageBay(w, col, cols) {
  const divider = (k) => -w / 2 + 1 + (w - 2) * k / cols;
  const left = col === 0 ? -w / 2 + 1.8 : divider(col) + 0.9;
  const right = col === cols - 1 ? w / 2 - 1.8 : divider(col + 1) - 0.9;
  return [left, right];
}

function storageInterior(kit, w, d, h, base, o, layout) {
  if (o.interior === 'empty') return;
  const cols = max(...layout.map((item) => item[1]));
  const back = d / 2 - 0.6;
  const shelfY = [-d / 2 + 1.5, back];
  const drawerY = [-d / 2, back - 1.0];
  for (let col = 1; col < cols; col++) {
    const x = -w / 2 + 1 + (w - 2) * col / cols;
    storagePanel(kit, `Divider ${col}`, [x, (-d / 2 + back) / 2, (base + 1.8 + h - 2.4) / 2], [1.8, back + d / 2, h - base - 4.2]);
  }
  let shelf = 0;
  let drawer = 0;
  let rail = 0;
  const span = (a, b) => [(a + b) / 2.0, b - a];
  for (const [col, count, z0, z1, kind] of layout) {
    const [left, right] = storageBay(w, floor(col * cols / count), cols);
    const [cx, iw] = span(left, right);
    if (kind === 'drawer') {
      drawer += 1;
      const dz = z1 - z0 - 3.0;
      const bottom = z0 + 1.4;
      const bw = iw - 2 * RUNNER;
      const [cy, depth] = span(...drawerY);
      kit.part(`Drawer box ${drawer}`, 'wood', (buf) => {
        storageBox(buf, [cx, cy, bottom + 0.3], [bw, depth, 0.6]);
        storageBox(buf, [cx - bw / 2 + 0.6, cy, bottom + 0.6 + dz / 2], [1.2, depth, dz]);
        storageBox(buf, [cx + bw / 2 - 0.6, cy, bottom + 0.6 + dz / 2], [1.2, depth, dz]);
        for (const sign of [-1, 1]) storageBox(buf, [cx, cy + sign * (depth / 2 - 0.6), bottom + 0.6 + dz / 2], [bw - 2.4, 1.2, dz]);
        for (const sign of [-1, 1]) storageBox(buf, [cx + sign * (iw / 2 - RUNNER / 2), cy, bottom + 0.6 + min(dz * 0.35, 3.5)], [RUNNER, depth - 2, 1.4]);
      });
    } else if (o.interior === 'hanging' && h > 150) {
      shelf += 1;
      const shelfZ = z1 - 25;
      storagePanel(kit, `Shelf ${shelf}`, [cx, span(...shelfY)[0], shelfZ], [iw, span(...shelfY)[1], 1.8]);
      rail += 1;
      kit.part(`Hanging rail ${rail}`, 'dark', (buf) => {
        const ry = (shelfY[0] + back) / 2;
        kit.tube(buf, [[left, ry, shelfZ - 12], [right, ry, shelfZ - 12]], 1.2, { seg: 12 });
        for (const [a, b] of [[left, left + 0.6], [right - 0.6, right]]) kit.tube(buf, [[a, ry, shelfZ - 12], [b, ry, shelfZ - 12]], 2.2, { seg: 12 });
      });
    } else {
      const number = clamp(ceil((z1 - z0) / 38.0), 2, 6) - 1;
      for (let index = 0; index < number; index++) {
        shelf += 1;
        const z = z0 + (z1 - z0) * (index + 1) / (number + 1);
        storagePanel(kit, `Shelf ${shelf}`, [cx, span(...shelfY)[0], z], [iw, span(...shelfY)[1], 1.8]);
      }
    }
  }
}

function bar(kit, buf, a, b) {
  const out = [0, -2.8, 0];
  kit.tube(buf, [V.add(a, [0, 1.5, 0]), V.add(a, out), V.add(b, out), V.add(b, [0, 1.5, 0])], 0.55, { seg: 8 });
}

function knob(buf, c) {
  const prof = [[0.7, 0], [0.6, 1.2], [1.6, 1.9], [1.7, 2.6], [1.0, 3.0]];
  const f = new Frame(c, [1, 0, 0], [0, 0, 1], [0, -1, 0]);
  const seg = 12;
  const rings = prof.map(([r, z]) => Array.from({ length: seg }, (_, k) => { const a = 2 * PI * k / seg; return buf.pt(f.at([r * cos(a), r * sin(a), z - 1.5])); }));
  for (let p = 0; p < rings.length - 1; p++) {
    for (let k = 0; k < seg; k++) buf.quad(rings[p][k], rings[p][(k + 1) % seg], rings[p + 1][(k + 1) % seg], rings[p + 1][k]);
  }
  const tip = buf.pt(f.at([0, 0, prof[prof.length - 1][1] - 1.5]));
  const base = buf.pt(f.at([0, 0, -1.5]));
  const last = rings[rings.length - 1];
  for (let k = 0; k < seg; k++) {
    buf.tri(tip, last[k], last[(k + 1) % seg]);
    buf.tri(base, rings[0][(k + 1) % seg], rings[0][k]);
  }
}

const BUILDERS = {
  bed: buildBed,
  sofa: (kit, h, w, d, o) => sofaLike(kit, ...sofaSizes('sofa', h, w, d, o), o),
  armchair: (kit, h, w, d, o) => sofaLike(kit, ...sofaSizes('armchair', h, w, d, o), o),
  chair: buildChair,
  table: (kit, h, w, d, o) => tableLike(kit, ...overallSize('table', h, w, d, o), 4.0, o),
  coffee_table: (kit, h, w, d, o) => tableLike(kit, ...overallSize('coffee_table', h, w, d, o), 3.5, o),
  nightstand: (kit, h, w, d, o) => storage(kit, ...storageSize('nightstand', h, w, d), o, 2),
  cabinet: (kit, h, w, d, o) => storage(kit, ...storageSize('cabinet', h, w, d), o, 3),
  wardrobe: (kit, h, w, d, o) => storage(kit, ...storageSize('wardrobe', h, w, d), o, 1),
};

// The overall size a build will have, for the dimension read-out: [width, depth, height] in cm.
export function plannedSize(type, h, w, d, attrs) {
  return overallSize(type, h, w, d, optionsFor(type, attrs));
}
