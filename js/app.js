// AIM 3D Studio Web: photo -> recognised furniture type and style -> the extension's parametric model, with the
// same cloth physics -> GLB / DAE for SketchUp. Everything runs in this browser; the photo never leaves it.
import { TYPES, OPTIONS, RANGES, optionsFor, plannedSize, palette, roleColour, seedFor } from './furniture.js';
import { Viewer } from './viewer.js';
import { Fitter, plainCutout, clean } from './fit.js';
import { readGLB, toPart, sized } from './ai.js';
import { toGLB, toDAE, download } from './export.js';
import { crc32 } from './rng.js';

const $ = (s) => document.querySelector(s);
const store = {
  get(k) { try { return localStorage.getItem(`aim3d.${k}`); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(`aim3d.${k}`, v); } catch (e) { /* private window: not remembered */ } },
};

// ---------------------------------------------------------------- words
const TYPE_T = {
  bed: ['سرير', 'Bed'], sofa: ['كنبة', 'Sofa'], armchair: ['كرسي مفرد', 'Armchair'], chair: ['كرسي طعام', 'Dining chair'],
  table: ['طاولة', 'Table'], coffee_table: ['طاولة قهوة', 'Coffee table'], nightstand: ['كومودينو', 'Nightstand'],
  cabinet: ['خزانة', 'Cabinet'], wardrobe: ['دولاب', 'Wardrobe'], ai: ['شيء آخر (ذكاء اصطناعي)', 'Something else (AI)'],
};
const OPT_T = {
  interior: { ar: 'التجهيز الداخلي', en: 'Interior', v: { fitted: ['رفوف وصناديق أدراج حسب الواجهات', 'Shelves and drawer boxes'], hanging: ['رف علوي وعلاقة ملابس', 'Top shelf and hanging rail'], shelves: ['رفوف', 'Shelves'], empty: ['فارغ', 'Empty'] } },
  outline: { ar: 'شكل السرير', en: 'Bed shape', v: { rect: ['مستطيل', 'Rectangular'], round: ['دائري', 'Round'] } },
  headboard: { ar: 'لوح الرأس', en: 'Headboard', v: { padded: ['منجّد سادة', 'Padded'], channel: ['قنوات طولية', 'Vertical channels'], tufted: ['كابتونيه بأزرار', 'Button tufted'],
    wing: ['بأجنحة ملتفّة', 'Wingback'], panel: ['ألواح عرضية', 'Horizontal panels'], slats: ['شرائح خشب', 'Wooden slats'], none: ['بدون', 'None'] } },
  base: { ar: 'القاعدة', en: 'Base', v: { platform: ['منجّدة على الأرض', 'Upholstered platform'], legs: ['على أرجل', 'On legs'], skirt: ['تنزل للأرض', 'Skirt to the floor'], plinth: ['قاعدة مسطّحة', 'Plinth'] } },
  bedding: { ar: 'المفرش', en: 'Bedding', v: { duvet: ['لحاف منفوش نازل', 'Fluffy duvet'], tucked: ['مشدود مرتّب', 'Neatly tucked'], none: ['مرتبة بدون مفرش', 'Bare mattress'] } },
  throw: { ar: 'البطانية', en: 'Throw', v: { over_back: ['منسدلة على الظهر', 'Over the back'], over_arm: ['منسدلة على المسند', 'Over the arm'], diagonal: ['كبيرة بعرض السرير نازلة من الجهتين', 'Large, across the bed'], heap: ['كومة على الزاوية', 'Heaped on a corner'], runner: ['شريط مطوي بالعرض', 'Folded runner'], none: ['بدون', 'None'] } },
  throw_side: { ar: 'جهة البطانية', en: 'Throw side', v: { left: ['يسار (من جهة الرجلين)', 'Left (seen from the foot)'], right: ['يمين (من جهة الرجلين)', 'Right (seen from the foot)'] } },
  throw_texture: { ar: 'خامة البطانية', en: 'Throw texture', v: { smooth: ['ناعمة', 'Smooth'], knit: ['محبوكة صوف ثقيل', 'Chunky knit'] } },
  pillows: { ar: 'عدد المخدات', en: 'Pillows', v: {} },
  pad: { ar: 'وسادة مقعد', en: 'Seat pad', v: { no: ['بدون', 'No'], yes: ['نعم', 'Yes'] } },
  seats: { ar: 'عدد المقاعد', en: 'Seats', v: {} },
  arms: { ar: 'المساند', en: 'Arms', v: { track: ['مربّعة', 'Square (track)'], rolled: ['ملفوفة', 'Rolled'], slope: ['دائرية مائلة', 'Sloped'], none: ['بدون', 'None'], no: ['بدون', 'No'], yes: ['بمساند', 'Yes'] } },
  back: { ar: 'الظهر', en: 'Back', v: { cushions: ['مخدات منفصلة', 'Loose cushions'], tight: ['مشدود', 'Tight'], tufted: ['كابتونيه', 'Tufted'], wing: ['بأجنحة', 'Wingback'],
    upholstered: ['منجّد', 'Upholstered'], solid: ['خشب مصمت', 'Solid wood'], slats: ['شرائح طولية', 'Vertical slats'], bars: ['قضبان عرضية', 'Horizontal bars'] } },
  legs: { ar: 'الأرجل', en: 'Legs', v: { tapered: ['مخروطية', 'Tapered'], straight: ['مستقيمة', 'Straight'], hairpin: ['معدن رفيعة', 'Hairpin'], pedestal: ['قاعدة وسطية', 'Pedestal'], trestle: ['على شكل U', 'Trestle'] } },
  top: { ar: 'السطح', en: 'Top', v: { rect: ['مستطيل', 'Rectangular'], round: ['دائري', 'Round'], oval: ['بيضاوي', 'Oval'] } },
  fronts: { ar: 'الواجهات', en: 'Fronts', v: { drawers: ['أدراج', 'Drawers'], door: ['باب', 'Door'], doors: ['أبواب', 'Doors'], mixed: ['أدراج + أبواب', 'Drawers + doors'] } },
  handles: { ar: 'المقابض', en: 'Handles', v: { bar: ['مقبض طولي', 'Bar'], knob: ['مقبض دائري', 'Knob'], none: ['بدون', 'None'] } },
  style: { ar: 'الطراز', en: 'Style', v: { shaker: ['إطار وحشوة', 'Shaker panels'], flat: ['سادة مودرن', 'Flat modern'] } },
};
const UI = {
  title: ['استوديو AIM للمجسمات', 'AIM 3D Studio'],
  sub: ['صورة قطعة أثاث ← مجسم أبيض جاهز لسكتشب', 'A furniture photo → a white model ready for SketchUp'],
  photo: ['الصورة', 'Photo'],
  drop: ['اسحب صورة القطعة هنا أو اضغط لاختيارها', 'Drop a photo of the piece here, or click to choose one'],
  dropHint: ['JPG أو PNG أو WebP. الصورة تبقى على جهازك.', 'JPG, PNG or WebP. The photo stays on this computer.'],
  change: ['صورة أخرى', 'Another photo'],
  type: ['نوع القطعة', 'Piece'],
  options: ['التفاصيل', 'Details'],
  size: ['المقاسات (سم)', 'Size (cm)'],
  sizeHint: ['اتركها فارغة للمقاس القياسي. السرير يُقاس بالمرتبة.', 'Leave empty for the standard size. A bed is sized by its mattress.'],
  w: ['العرض', 'Width'], d: ['العمق', 'Depth'], h: ['الارتفاع', 'Height'],
  quality: ['الدقة', 'Detail'], light: ['خفيفة (أسرع في سكتشب)', 'Light (quick in SketchUp)'], fast: ['سريعة', 'Fast'], standard: ['عادية', 'Standard'], high: ['مفصّلة', 'Detailed'],
  insert: ['إدراج في سكتشب', 'Insert in SketchUp'],
  aiMake: ['اصنع المجسم بالذكاء الاصطناعي', 'Make the model with AI'], aiCancel: ['إيقاف', 'Stop'],
  aiNote: ['للقطع غير الأثاث التسعة (مصباح، نبتة، تحفة…). عند الضغط تُرسل الصورة إلى ذكاء اصطناعي مجاني على Hugging Face عبر سكتشب، وترجع مجسماً. الوقت المجاني محدود يومياً.', 'For pieces outside the nine furniture types (a lamp, a plant, decor…). Pressing it sends the photo to a free AI on Hugging Face through SketchUp and brings back a model. Free time is limited per day.'],
  aiWebOnly: ['صنع المجسم بالذكاء الاصطناعي يعمل داخل سكتشب (إضافة AIM 3D Studio Web).', 'Making a model with AI works inside SketchUp (the AIM 3D Studio Web extension).'],
  aiNeedPhoto: ['أضف صورة القطعة أولاً.', 'Add a photo of the piece first.'],
  aiReceiving: ['يصل المجسم… {p}٪', 'Receiving the model… {p}%'],
  aiDone: ['صنعه {e}. اكتب مقاساً واحداً تعرفه ليصير بحجمه الحقيقي.', 'Made by {e}. Type one measurement you know to give it its real size.'],
  aiFail: ['{e}', '{e}'], aiQuota: [' انتهى الوقت المجاني لليوم؛ رمز Hugging Face مجاني يعطيك وقتاً أكثر.', ' The free time is used up for today; a free Hugging Face token gives more.'],
  token: ['رمز Hugging Face (اختياري)', 'Hugging Face token (optional)'], tokenSave: ['حفظ', 'Save'], tokenSaved: ['محفوظ في سكتشب على هذا الجهاز.', 'Saved in SketchUp on this computer.'],
  aiNoEdit: ['قطع الذكاء الاصطناعي لا تُعدَّل من هنا؛ اصنعها من جديد.', 'AI pieces cannot be edited from here; make them again.'],
  cutting: ['أقصّ القطعة من الصورة…', 'Cutting the piece out of the photo…'],
  cutDownload: ['تنزيل نموذج القصّ مرة واحدة: {a} من {b} م.ب', 'Downloading the cut-out model once: {a} of {b} MB'],
  cutFail: ['تعذّر قصّ القطعة من الصورة ({e}). المقاسات القياسية مستعملة.', 'Could not cut the piece out of the photo ({e}). Standard sizes are used.'],
  fitting: ['أطابق الشكل مع الصورة…', 'Matching the shape to the photo…'],
  fitted: ['طابقتُ الشكل مع الصورة: تطابق {p}٪. «قارن بالصورة» يريك الفرق.', 'Matched to the photo: {p}% overlap. Compare with photo shows the difference.'],
  fittedLow: ['تطابق ضعيف مع الصورة ({p}٪): ربما النوع أو التفاصيل مختلفة، أو الصورة فيها أكثر من قطعة.', 'Weak match with the photo ({p}%): the piece or its details may differ, or the photo shows more than one piece.'],
  refit: ['طابق مع الصورة', 'Match to photo'], compare: ['قارن بالصورة', 'Compare with photo'], closeCompare: ['رجوع للمجسم', 'Back to the model'],
  compareNote: ['اللون الأخضر: شكل المجسم كما تراه الكاميرا. الخط البرتقالي: حدوده. ما خارجه من الصورة لم يُغطَّ.', 'Green: the model as the camera sees it. Orange line: its outline. Photo outside it is not covered.'],
  sizeHint2: ['اكتب مقاساً واحداً تعرفه (مثلاً العرض)؛ الباقي يُحسب من الصورة. الأرقام الرمادية محسوبة.', 'Type one measurement you know (e.g. the width); the rest comes from the photo. Grey numbers are computed.'], inserting: ['جارٍ الإدراج في سكتشب…', 'Inserting into SketchUp…'],
  inserted: ['أُدرج. حرّك الماوس وانقر مكان القطعة (Esc للإلغاء).', 'Inserted. Move the mouse and click where it goes (Esc cancels).'],
  replaced: ['تم تحديث القطعة المحددة في سكتشب.', 'The selected piece was updated in SketchUp.'],
  insertFail: ['تعذّر الإدراج: {e}', 'Could not insert: {e}'],
  editSel: ['تعديل المحدد', 'Edit selected'], editing: ['تعدّل قطعة من سكتشب. «إدراج» يحدّثها مكانها.', 'Editing a piece from SketchUp. Insert updates it in place.'],
  noSel: ['حدّد في سكتشب قطعة صنعتها AIM أولاً.', 'Select a piece made with AIM in SketchUp first.'],
  sketchupHint: ['«إدراج في سكتشب» يضع القطعة في النموذج مباشرة، كل جزء مجموعة باسمه.', 'Insert in SketchUp puts the piece straight into the model, each part a named group.'],
  colour: ['الألوان', 'Colour'], white: ['أبيض (الشكل فقط)', 'White (shape only)'], photoColours: ['ألوان من الصورة', 'Colours from the photo'],
  settle: ['أسقِط القماش بالفيزياء', 'Let the fabric settle'], settling: ['القماش ينزل… {s} ث', 'Fabric settling… {s} s'], stop: ['إيقاف', 'Stop'],
  settled: ['القماش نازل بالفيزياء', 'Fabric settled by physics'], drawn: ['القماش مرسوم (أسرع)', 'Fabric drawn (faster)'],
  folds: ['طيّات أخرى', 'Other folds'],
  glb: ['تنزيل GLB', 'Download GLB'], dae: ['تنزيل DAE', 'Download DAE'],
  importHint: ['في سكتشب: ملف ← استيراد. ملف GLB يُدخل كل جزء كمجموعة باسمه. ملف DAE للنسخ الأقدم من سكتشب: الأجزاء منفصلة لكن بلا أسماء.',
    'In SketchUp: File → Import. GLB brings each part in as its own named group. DAE is for older SketchUp versions: the parts stay separate but lose their names.'],
  building: ['جارٍ البناء…', 'Building…'],
  built: ['{n} جزء، {t} مثلث', '{n} parts, {t} triangles'],
  seeLoading: ['تجهيز التعرّف على الصورة…', 'Getting photo recognition ready…'],
  seeDownload: ['تنزيل نموذج التعرّف مرة واحدة: {a} من {b} م.ب', 'Downloading the recognition model once: {a} of {b} MB'],
  seeThinking: ['أتعرّف على القطعة…', 'Looking at the piece…'],
  seeResult: ['تبدو {type} ({p}٪). عدّلتُ التفاصيل حسب الصورة.', 'Looks like a {type} ({p}%). Details set from the photo.'],
  seeLow: ['غير متأكد ({type}؟ {p}٪). اختر النوع بنفسك.', 'Not sure ({type}? {p}%). Pick the piece yourself.'],
  seeOther: ['لا تبدو من الأنواع التسعة. اختر النوع بنفسك.', 'It does not look like one of the nine kinds. Pick the piece yourself.'],
  seeFail: ['تعذّر التعرّف على الصورة ({e}). اختر النوع والتفاصيل بنفسك.', 'Recognition did not run ({e}). Pick the piece and details yourself.'],
  seeSkip: ['تخطَّ', 'Skip'],
  fromPhoto: ['من الصورة', 'from photo'],
  heic: ['صور HEIC لا تُفتح في المتصفح. صدّرها JPG من جوالك وجرّب.', 'HEIC photos do not open in browsers. Export it as JPG and try again.'],
  badImage: ['هذا الملف ليس صورة يقرأها المتصفح.', 'This file is not an image the browser can read.'],
  fileProto: ['افتح الصفحة عبر الخادم المحلي (ملف start.bat)، لا بالنقر المزدوج على index.html.', 'Open the page through the local server (start.bat), not by double-clicking index.html.'],
  view3d: ['عرض ثلاثي الأبعاد للمجسم، اسحب للتدوير', '3D view of the model, drag to turn it'],
  lost: ['توقّف العرض ثلاثي الأبعاد مؤقتاً. سيعود تلقائياً أو أعد تحميل الصفحة.', 'The 3D view stopped. It comes back by itself, or reload the page.'],
  nowebgl: ['هذا المتصفح لا يعرض ثلاثي الأبعاد (WebGL). جرّب Chrome أو Edge.', 'This browser cannot show 3D (WebGL). Try Chrome or Edge.'],
  failed: ['فشل البناء: {e}', 'Build failed: {e}'],
  simFailed: ['فشلت الفيزياء ({e}). القماش مرسوم.', 'Physics failed ({e}). The fabric is drawn.'],
  lang: ['English', 'عربي'],
};

let lang = store.get('lang') === 'en' ? 'en' : 'ar';
const t = (k) => (UI[k] ? UI[k][lang === 'ar' ? 0 : 1] : k);
const fill = (s, o) => s.replace(/\{(\w+)\}/g, (_, k) => o[k]);
const nf = (n) => new Intl.NumberFormat(lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US').format(n);
const optLabel = (k) => (OPT_T[k] ? OPT_T[k][lang] : k);
const valLabel = (k, v) => (OPT_T[k] && OPT_T[k].v[v] ? OPT_T[k].v[v][lang === 'ar' ? 0 : 1] : v);

// ---------------------------------------------------------------- state
const SEE_MIN = { headboard: 0.6, throw_texture: 0.95 };
const state = {
  type: 'bed', vals: {}, fromPhoto: {}, userSet: {}, typeByUser: false,
  w: '', d: '', h: '', quality: 'light', colour: 'white', editing: false,
  cut: null, photoCanvas: null, fitDims: null, fitResult: null, wantFit: false, aiRaw: null, aiEngine: '',
  photo: null, photoSeed: null, pal: null, foldShift: 0,
  sims: null, simKey: null, parts: null, items: [],
};
// pieces with something soft for the physics: beds, sofas, armchairs, and chairs with a padded seat or back
const soft = (type, o) => type === 'bed' || type === 'sofa' || type === 'armchair' || (type === 'chair' && (o.back === 'upholstered' || o.pad === 'yes'));
const seed = () => (state.photoSeed != null ? state.photoSeed : seedFor(`AIM ${state.type}`)) + 7919 * state.foldShift;
const request = () => ({ type: state.type, attrs: optionsFor(state.type, state.vals[state.type] || {}), seed: seed(), quality: state.quality,
  width_cm: Number(state.w) || (state.fitDims && state.fitDims.w) || 0, depth_cm: Number(state.d) || (state.fitDims && state.fitDims.d) || 0,
  height_cm: Number(state.h) || (state.fitDims && state.fitDims.h) || 0 });
const keyOf = (r) => JSON.stringify([r.type, r.attrs, r.seed, r.quality, r.width_cm, r.depth_cm, r.height_cm]);

// ---------------------------------------------------------------- workers
// Two workers from the same file: one builds, one runs the physics, so a rebuild never waits behind a physics run,
// and stopping the physics ends only its own worker.
let job = 0;
class Engine {
  constructor() { this.waiting = new Map(); this.start(); }
  start() {
    this.w = new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
    this.w.onmessage = (e) => { const p = this.waiting.get(e.data.job); if (p) { this.waiting.delete(e.data.job); p.resolve(e.data); } };
    this.w.onerror = (e) => this.fail(new Error(e.message || 'worker error'));
  }
  fail(err) { for (const [, p] of this.waiting) p.reject(err); this.waiting.clear(); }
  restart() { this.w.terminate(); this.fail(new Error('stopped')); this.start(); }
  get busy() { return this.waiting.size > 0; }
  ask(kind, req) {
    const id = ++job;
    return new Promise((resolve, reject) => { this.waiting.set(id, { resolve, reject }); this.w.postMessage({ job: id, kind, req }); });
  }
}
let builder = null;
let physics = null;

// ---------------------------------------------------------------- build
let viewer;
let latestBuild = 0;
let lastFramedKey = '';
let buildTimer = 0;
function scheduleBuild() { clearTimeout(buildTimer); buildTimer = setTimeout(rebuild, 90); }

async function rebuild() {
  if (state.type === 'ai') return showAI();
  const req = request();
  const key = keyOf(req);
  if (state.simKey !== key) { state.sims = null; }
  req.sims = state.sims;
  const mine = ++latestBuild;
  status('build', () => t('building'));
  let r;
  // a physics run for another piece is now pointless: stop it
  if (physics.busy && simFor !== key) stopSim(true);
  try {
    r = await builder.ask('build', req);
  } catch (e) {
    if (mine === latestBuild && e.message !== 'stopped') status('build', () => fill(t('failed'), { e: e.message }), true);
    return false;
  }
  if (mine !== latestBuild) return false; // a newer build was asked for meanwhile
  if (!r.ok) { status('build', () => fill(t('failed'), { e: r.error }), true); return false; }
  state.parts = r.parts;
  const sizeKey = JSON.stringify([req.type, req.attrs.outline, req.attrs.top, req.width_cm, req.depth_cm, req.height_cm]);
  state.items = viewer.show(r.parts, (role) => (state.colour === 'photo' && state.pal ? roleColour(state.pal, role) : null), sizeKey !== lastFramedKey);
  lastFramedKey = sizeKey;
  status('build', () => fill(t('built'), { n: nf(r.parts.length), t: nf(r.triangles) }));
  showDims();
  renderActions(r.cloth);
  if (state.wantFit && state.cut && mine === latestBuild) setTimeout(runFit, 50);
  return mine === latestBuild;
}

function showDims() {
  const b = viewer.bounds();
  if (b.isEmpty()) { $('#dims').hidden = true; return; }
  const s = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((v) => Math.round(v));
  $('#dimW').textContent = nf(s[0]);
  $('#dimD').textContent = nf(s[1]);
  $('#dimH').textContent = nf(s[2]);
  $('#dims').hidden = false;
}

// ---------------------------------------------------------------- physics
let simTimer = 0;
let simFor = null; // the piece the running physics is for
let simJob = 0;
async function settle() {
  if (physics.busy) return;
  const req = request();
  const key = keyOf(req);
  const mine = ++simJob;
  simFor = key;
  const t0 = performance.now();
  clearInterval(simTimer);
  $('#settle').hidden = true;
  $('#stopSim').hidden = false;
  const tick = () => { $('#simState').textContent = fill(t('settling'), { s: nf(Math.round((performance.now() - t0) / 1000)) }); };
  tick();
  simTimer = setInterval(tick, 500);
  let r;
  try { r = await physics.ask('simulate', req); } catch (e) { r = null; }
  if (mine !== simJob) return; // stopped, or replaced by a newer run: that one owns the buttons now
  clearInterval(simTimer);
  simFor = null;
  $('#stopSim').hidden = true;
  if (!r) { renderActions('drawn'); return; } // stopped
  if (!r.ok) { status('build', () => fill(t('simFailed'), { e: r.error }), true); renderActions('drawn'); return; }
  if (keyOf(request()) !== key) { renderActions('drawn'); return; } // the piece changed meanwhile
  state.sims = r.grids;
  state.simKey = key;
  rebuild();
}
function stopSim(quiet) {
  simJob++;
  simFor = null;
  clearInterval(simTimer);
  physics.restart();
  $('#stopSim').hidden = true;
  renderActions('drawn');
  if (quiet !== true) scheduleBuild();
}

function renderActions(cloth) {
  if (physics && physics.busy) { $('#settle').hidden = true; return; } // the running run owns the buttons and its timer
  const o = optionsFor(state.type, state.vals[state.type] || {});
  const canSettle = soft(state.type, o);
  $('#settle').hidden = !canSettle || cloth === 'physics';
  $('#simState').textContent = canSettle ? t(cloth === 'physics' ? 'settled' : 'drawn') : '';
  $('#folds').hidden = !canSettle;
}

// ---------------------------------------------------------------- photo
let photoJob = 0;
async function takePhoto(file) {
  if (!file) return;
  if (/\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type)) { status('see', () => t('heic'), true); return; }
  const mine = ++photoJob;
  let bitmap;
  let bytes;
  const c = document.createElement('canvas');
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    bytes = new Uint8Array(await file.arrayBuffer());
    // downscaled once, for the thumbnail, the colours and the recognition
    const k = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    c.width = Math.max(1, Math.round(bitmap.width * k));
    c.height = Math.max(1, Math.round(bitmap.height * k));
    c.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0, c.width, c.height);
  } catch (e) {
    if (mine === photoJob) status('see', () => t('badImage'), true);
    return;
  } finally {
    if (bitmap) bitmap.close();
  }
  if (mine !== photoJob) return; // a newer photo was dropped meanwhile
  // a new photo is a new piece: earlier hand choices give way to what this photo shows
  state.typeByUser = false;
  state.userSet = {};
  state.aiRaw = null;
  state.photoSeed = crc32(bytes) & 0x7fffffff; // the same photo gives the same folds as in the extension
  state.foldShift = 0;
  const w = c.width;
  const h = c.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const px = ctx.getImageData(0, 0, w, h).data;
  state.pal = palette((u, v) => {
    const x = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
    const y = Math.min(h - 1, Math.max(0, Math.floor((1 - v) * h)));
    const i = (y * w + x) * 4;
    return [px[i], px[i + 1], px[i + 2], px[i + 3]];
  });
  state.photo = c.toDataURL('image/jpeg', 0.85);
  state.photoCanvas = c;
  state.cut = null; state.fitDims = null; state.fitResult = null; $('#compare').hidden = true; closeCompare();
  cutOut(px, w, h, c, mine);
  $('#thumb').src = state.photo;
  $('#drop').classList.add('has');
  $('#colourPhoto').disabled = false;
  renderForm();
  scheduleBuild();
  const shot = await createImageBitmap(c);
  if (mine === photoJob) recognise(shot); else shot.close();
}

let seeWorker = null;
let seeJob = 0;
function recognise(bitmap) {
  if (!seeWorker) {
    seeWorker = new Worker(new URL('./recognize.worker.js', import.meta.url), { type: 'module' });
    seeWorker.onmessage = (e) => onSeen(e.data);
    seeWorker.onerror = (e) => onSeen({ job: seeJob, status: 'error', error: e.message || 'worker' });
  }
  const id = ++seeJob;
  seeWorker.postMessage({ job: id, bitmap }, [bitmap]);
  $('#skipSee').hidden = false;
}
function onSeen(m) {
  if (m.job !== seeJob) return;
  if (m.status === 'loading') status('see', () => t('seeLoading'));
  else if (m.status === 'download') {
    status('see', () => fill(t('seeDownload'), { a: nf(Math.round(m.loaded / 1e6)), b: nf(Math.round(m.total / 1e6)) }));
    $('#seeBar').hidden = false;
    $('#seeBar').value = m.loaded / m.total;
  } else if (m.status === 'thinking') { status('see', () => t('seeThinking')); $('#seeBar').hidden = true; }
  else if (m.status === 'error') { status('see', () => fill(t('seeFail'), { e: m.error }), true); $('#seeBar').hidden = true; $('#skipSee').hidden = true; }
  else if (m.status === 'done') { $('#skipSee').hidden = true; applySeen(m.result); }
}
function applySeen(r) {
  const p = Math.round(r.confidence * 100);
  const sure = r.type !== 'other' && r.confidence >= 0.45;
  if (sure) state.wantFit = true; // matched to the photo once the recognised piece is built
  if (sure && !state.typeByUser) state.type = r.type;
  if (r.type === 'other' && r.confidence >= 0.45 && !state.typeByUser && inSketchUp) state.type = 'ai';
  // what the earlier photo set gives way to this one; choices made by hand since this photo stay
  if (sure) state.fromPhoto = {};
  for (const type of Object.keys(sure ? r.styles || {} : {})) {
    const vals = state.vals[type] = state.vals[type] || {};
    const mine = state.userSet[type] || {};
    const seenHere = state.fromPhoto[type] = {};
    for (const k of Object.keys(r.styles[type])) {
      if (mine[k]) continue;
      if ((r.conf[type][k] || 0) >= (SEE_MIN[k] || 0.5)) { vals[k] = r.styles[type][k]; seenHere[k] = true; } else delete vals[k];
    }
  }
  // a round bed: the throw guess is not used (the extension's rule: dark bedding reads as a blanket)
  const bed = state.vals.bed;
  if (sure && bed && bed.outline === 'round' && !(state.userSet.bed || {}).throw) {
    bed.throw = 'none';
    if (state.fromPhoto.bed) delete state.fromPhoto.bed.throw;
  }
  status('see', () => (r.type === 'other' ? t('seeOther')
    : fill(t(sure ? 'seeResult' : 'seeLow'), { type: TYPE_T[r.type] ? TYPE_T[r.type][lang === 'ar' ? 0 : 1] : r.type, p: nf(p) })));
  renderForm();
  scheduleBuild();
}

// ---------------------------------------------------------------- form
function renderForm() {
  const focused = document.activeElement && document.activeElement.id;
  const tsel = $('#type');
  tsel.innerHTML = TYPES.concat('ai').map((k) => `<option value="${k}">${TYPE_T[k][lang === 'ar' ? 0 : 1]}</option>`).join('');
  tsel.value = state.type;
  $('#aiBox').hidden = state.type !== 'ai';
  $('#optsBox').hidden = state.type === 'ai';
  if (state.type === 'ai') { $('#opts').innerHTML = ''; return; }
  const o = optionsFor(state.type, state.vals[state.type] || {});
  const seen = state.fromPhoto[state.type] || {};
  const box = $('#opts');
  box.innerHTML = '';
  for (const [key, values] of Object.entries(OPTIONS[state.type])) {
    const id = `opt-${key}`;
    const row = document.createElement('label');
    row.className = 'field';
    row.htmlFor = id;
    const ordered = /^\d+$/.test(values[0]) ? [...values].sort((a, b) => a - b) : values;
    row.innerHTML = `<span class="name">${optLabel(key)}${seen[key] ? ` <em class="seen">${t('fromPhoto')}</em>` : ''}</span>`
      + `<select id="${id}">${ordered.map((v) => `<option value="${v}">${/^\d+$/.test(v) ? nf(Number(v)) : valLabel(key, v)}</option>`).join('')}</select>`;
    const sel = row.querySelector('select');
    sel.value = o[key];
    sel.addEventListener('change', () => {
      (state.vals[state.type] = state.vals[state.type] || {})[key] = sel.value;
      (state.userSet[state.type] = state.userSet[state.type] || {})[key] = true;
      delete (state.fromPhoto[state.type] || {})[key];
      renderForm();
      scheduleBuild();
    });
    box.appendChild(row);
  }
  const [sw, sd, sh] = plannedSize(state.type, 0, 0, 0, o);
  $('#w').placeholder = nf(sw); $('#d').placeholder = nf(sd); $('#h').placeholder = nf(sh);
  if (state.fitDims) showFitDims();
  const back = focused && document.getElementById(focused);
  if (back && document.activeElement !== back) back.focus(); // rebuilt controls keep the keyboard focus
}

// A status is kept as a function of the language, so switching language rewrites it too.
const shown = {};
function status(where, text, bad) {
  shown[where] = { make: typeof text === 'function' ? text : () => text, bad };
  paintStatus(where);
}
let viewNote = null;
function paintViewNote() {
  const n = $('#viewNote');
  n.hidden = !viewNote;
  n.textContent = viewNote ? t(viewNote) : '';
}
function paintStatus(where) {
  const el = where === 'see' ? $('#seeState') : where === 'fit' ? $('#fitState') : where === 'ai' ? $('#aiState') : $('#buildState');
  const st = shown[where];
  el.textContent = st ? st.make() : '';
  el.classList.toggle('bad', !!(st && st.bad));
}

function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.title = t('title');
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  renderForm();
  renderActions(state.sims ? 'physics' : 'drawn');
  paintStatus('see');
  paintStatus('build');
  paintStatus('fit');
  paintStatus('ai');
  paintViewNote();
  $('#view').setAttribute('aria-label', t('view3d'));
  $('#type').setAttribute('aria-label', t('type'));
  $('#seeBar').setAttribute('aria-label', t('seeLoading'));
}

async function exportAs(kind) {
  if (!state.items.length) return;
  const name = `AIM ${TYPE_T[state.type][1]}`;
  const items = state.items.map((it) => ({ name: it.name, geometry: it.geometry, color: it.color,
    materialName: state.colour === 'photo' && state.pal ? `AIM ${it.role || 'white'}` : 'AIM 3D Studio white' }));
  const blob = kind === 'glb' ? await toGLB(items, name) : toDAE(items, name);
  download(blob, `${name.replace(/\s+/g, '-')}.${kind}`);
}

// ---------------------------------------------------------------- AI pieces (through SketchUp)
function showAI() {
  renderActions('none');
  if (!state.aiRaw) { viewer.clear(); state.parts = []; state.items = []; $('#dims').hidden = true; status('build', ''); return false; }
  const part = sized(state.aiRaw, typedDims());
  state.parts = [part];
  state.items = viewer.show([part], () => null, true);
  showDims();
  status('build', () => fill(t('built'), { n: nf(1), t: nf(part.tris.length / 3) }));
  return true;
}
let aiJob = 0;
let aiChunks = [];
function makeAI() {
  if (!window.sketchup || !window.sketchup.aim3d_ai_start) { status('ai', () => t('aiWebOnly'), true); return; }
  if (!state.photo) { status('ai', () => t('aiNeedPhoto'), true); return; }
  aiChunks = [];
  const id = ++aiJob;
  $('#aiMake').disabled = true;
  $('#aiCancel').hidden = false;
  window.sketchup.aim3d_ai_start(JSON.stringify({ job: id, image: state.photo, quality: state.quality }));
}
window.aim3dAI = async (m) => {
  if (!m || m.job !== aiJob) return;
  if (m.status === 'working') status('ai', () => m.text);
  else if (m.status === 'chunk') { aiChunks[m.index] = m.data; status('ai', () => fill(t('aiReceiving'), { p: nf(Math.round((m.index + 1) / m.count * 100)) })); }
  else if (m.status === 'error') {
    $('#aiMake').disabled = false; $('#aiCancel').hidden = true;
    status('ai', () => fill(t('aiFail'), { e: m.error }) + (m.quota ? t('aiQuota') : ''), true);
  } else if (m.status === 'done') {
    $('#aiMake').disabled = false; $('#aiCancel').hidden = true;
    try {
      const bin = atob(aiChunks.join(''));
      aiChunks = [];
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      state.aiRaw = toPart(await readGLB(bytes.buffer));
      state.aiEngine = m.engine;
      status('ai', () => fill(t('aiDone'), { e: m.engine }));
      showAI();
    } catch (err) {
      status('ai', () => fill(t('aiFail'), { e: err.message }), true);
    }
  }
};
function cancelAI() {
  aiJob++;
  if (window.sketchup && window.sketchup.aim3d_ai_cancel) window.sketchup.aim3d_ai_cancel('{}');
  $('#aiMake').disabled = false; $('#aiCancel').hidden = true; status('ai', '');
}

// ---------------------------------------------------------------- fitting to the photo
let maskWorker = null;
let maskJob = 0;
function cutOut(px, w, h, canvas, photoId) {
  // a cut-out PNG already says what the piece is; a plain backdrop is cut by colour; a room photo needs the model
  let alpha = false;
  for (let i = 3; i < px.length; i += 4 * 7) if (px[i] < 128) { alpha = true; break; }
  if (alpha) {
    const m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) m[i] = px[i * 4 + 3] >= 128 ? 1 : 0;
    state.cut = { mask: clean(m, w, h), w, h, source: 'alpha' };
    return;
  }
  const plain = plainCutout(px, w, h);
  if (plain) { state.cut = plain; return; }
  if (!maskWorker) {
    maskWorker = new Worker(new URL('./mask.worker.js', import.meta.url), { type: 'module' });
    maskWorker.onmessage = (e) => onMask(e.data);
    maskWorker.onerror = (e) => onMask({ job: maskJob, status: 'error', error: e.message || 'worker' });
  }
  const id = ++maskJob;
  createImageBitmap(canvas).then((bm) => {
    if (photoId !== photoJob || id !== maskJob) { bm.close(); return; }
    maskWorker.postMessage({ job: id, bitmap: bm }, [bm]);
  });
}
function onMask(m) {
  if (m.job !== maskJob) return;
  if (m.status === 'cutting' || m.status === 'loading') status('fit', () => t('cutting'));
  else if (m.status === 'download') status('fit', () => fill(t('cutDownload'), { a: nf(Math.round(m.loaded / 1e6)), b: nf(Math.round(m.total / 1e6)) }));
  else if (m.status === 'error') status('fit', () => fill(t('cutFail'), { e: m.error }), true);
  else if (m.status === 'done') {
    state.cut = { mask: clean(m.mask, m.w, m.h), w: m.w, h: m.h, source: 'ISNet' };
    status('fit', '');
    if (state.wantFit && state.parts) runFit();
  }
}

let fitter = null;
let fitting = false;
const typedDims = () => ({ w: Number(state.w) || 0, d: Number(state.d) || 0, h: Number(state.h) || 0 });

// Two passes: proportions and camera on the current build, then a refinement on the rebuilt piece.
async function runFit() {
  if (fitting || !state.cut || !viewer || !viewer.ok || !state.items.length || state.type === 'ai') return;
  fitting = true;
  state.wantFit = false;
  try {
    status('fit', () => t('fitting'));
    await new Promise((r) => setTimeout(r, 40)); // the message is painted before the search takes the thread
    if (!fitter) fitter = new Fitter(viewer.renderer);
    const type = state.type;
    const o = optionsFor(type, state.vals[type] || {});
    const typed = typedDims();
    const nTyped = ['w', 'd', 'h'].filter((k) => typed[k] > 0).length;
    // a round top or a round bed has one size for width and depth
    const tied = (type === 'bed' && o.outline === 'round') || ((type === 'table' || type === 'coffee_table') && o.top === 'round');
    let p = null;
    for (let pass = 0; pass < 3; pass++) {
      const req = request();
      const [w0, d0, h0] = plannedSize(type, req.height_cm, req.width_cm, req.depth_cm, o);
      const [rw, rd, rh] = RANGES[type];
      const limits = { sy: [rd[0] / d0, rd[1] / d0], sz: [rh[0] / h0, rh[1] / h0] };
      if (pass > 0) { limits.sy = [Math.max(limits.sy[0], 0.8), Math.min(limits.sy[1], 1.25)]; limits.sz = [Math.max(limits.sz[0], 0.8), Math.min(limits.sz[1], 1.25)]; }
      const locked = { sy: tied || nTyped >= 2, sz: nTyped >= 2 };
      fitter.setModel(state.items);
      p = fitter.fit(state.cut, { limits, locked, start: pass > 0 && p ? { ...p, sy: 1, sz: 1 } : null });
      if (!p) break;
      if (Math.abs(Math.log(p.sy)) < 0.03 && Math.abs(Math.log(p.sz)) < 0.03) break; // nothing left to change
      let dims = { w: w0, d: tied ? w0 : d0 * p.sy, h: h0 * p.sz };
      // the one measurement the user knows sets the real size; the others keep the photo's proportions
      if (nTyped === 1) {
        const k = typed.w ? typed.w / dims.w : typed.d ? typed.d / dims.d : typed.h / dims.h;
        dims = { w: dims.w * k, d: dims.d * k, h: dims.h * k };
      }
      const clampTo = (v, r) => Math.round(Math.max(r[0], Math.min(r[1], v)));
      state.fitDims = { w: clampTo(dims.w, rw), d: clampTo(dims.d, rd), h: clampTo(dims.h, rh) };
      showFitDims();
      clearTimeout(buildTimer);
      const ok = await rebuild();
      if (!ok) break;
    }
    if (p) {
      fitter.setModel(state.items);
      const last = fitter.fit(state.cut, { limits: { sy: [1, 1], sz: [1, 1] }, locked: { sy: true, sz: true }, start: { ...p, sy: 1, sz: 1 } });
      state.fitResult = last;
      const pc = Math.round(last.iou * 100);
      status('fit', () => fill(t(pc >= 70 ? 'fitted' : 'fittedLow'), { p: nf(pc) }), pc < 70);
      $('#compare').hidden = false;
    }
  } catch (err) {
    status('fit', () => fill(t('cutFail'), { e: err.message }), true);
  } finally {
    fitting = false;
  }
}

function showFitDims() {
  const f = state.fitDims || {};
  const o = optionsFor(state.type, state.vals[state.type] || {});
  const [sw, sd, sh] = plannedSize(state.type, 0, 0, 0, o);
  $('#w').placeholder = f.w ? `≈ ${nf(f.w)}` : nf(sw);
  $('#d').placeholder = f.d ? `≈ ${nf(f.d)}` : nf(sd);
  $('#h').placeholder = f.h ? `≈ ${nf(f.h)}` : nf(sh);
}

function openCompare() {
  if (!state.fitResult || !fitter || !state.photoCanvas) return;
  fitter.setModel(state.items);
  const img = fitter.compare(state.photoCanvas, state.cut, state.fitResult);
  $('#compareImg').src = img.toDataURL('image/jpeg', 0.9);
  $('#compareView').hidden = false;
}
function closeCompare() { const v = $('#compareView'); if (v) v.hidden = true; }

// ---------------------------------------------------------------- SketchUp host
// Opened from the AIM 3D Studio Web extension (?host=sketchup): the page talks to it through window.sketchup, which
// SketchUp injects a moment after the page starts. On the plain website nothing here runs.
const HOST_PROTOCOL = 1;
const inSketchUp = new URLSearchParams(location.search).get('host') === 'sketchup';
let host = null;
function waitForSketchUp() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (window.sketchup && typeof window.sketchup.aim3d_insert === 'function') resolve(window.sketchup);
      else if (Date.now() - t0 > 8000) resolve(null);
      else setTimeout(tick, 100);
    };
    tick();
  });
}
window.aim3dHost = (info) => { host = info; $('#tokenRow').hidden = false; $('#token').placeholder = info.has_token ? '••••••••' : 'hf_…'; };
window.aim3dInserted = (r) => {
  $('#insert').disabled = false;
  if (r && r.ok) {
    status('build', () => t(r.replaced ? 'replaced' : 'inserted'));
    if (r.replaced) state.editing = false;
  } else {
    status('build', () => fill(t('insertFail'), { e: (r && r.error) || '?' }), true);
  }
};
window.aim3dSelection = (r) => {
  if (!r || !r.ok || !r.recipe || !r.recipe.type) { status('build', () => t('noSel'), true); return; }
  if (r.recipe.type === 'ai') { status('build', () => t('aiNoEdit'), true); return; }
  applyRecipe(r.recipe);
  state.editing = true;
  status('build', () => t('editing'));
};

function b64(typed) {
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function recipe() {
  const r = request();
  if (state.type === 'ai') return { type: 'ai', engine: state.aiEngine, width_cm: r.width_cm, depth_cm: r.depth_cm, height_cm: r.height_cm };
  return { type: r.type, attrs: r.attrs, quality: r.quality, width_cm: r.width_cm, depth_cm: r.depth_cm, height_cm: r.height_cm, fit: state.fitResult ? Math.round(state.fitResult.iou * 100) : null,
    seed: r.seed, photoSeed: state.photoSeed, foldShift: state.foldShift, colour: state.colour, pal: state.pal, physics: !!state.sims };
}

function applyRecipe(rc) {
  if (!TYPE_T[rc.type]) return;
  state.type = rc.type;
  state.typeByUser = true;
  state.vals[rc.type] = { ...(rc.attrs || {}) };
  state.userSet[rc.type] = Object.fromEntries(Object.keys(rc.attrs || {}).map((k) => [k, true]));
  state.quality = rc.quality || 'light';
  state.w = rc.width_cm ? String(rc.width_cm) : ''; state.d = rc.depth_cm ? String(rc.depth_cm) : ''; state.h = rc.height_cm ? String(rc.height_cm) : '';
  state.photoSeed = rc.photoSeed == null ? null : rc.photoSeed;
  state.foldShift = rc.foldShift || 0;
  state.colour = rc.colour === 'photo' && rc.pal ? 'photo' : 'white';
  state.pal = rc.pal || state.pal;
  $('#quality').value = state.quality;
  for (const k of ['w', 'd', 'h']) $(`#${k}`).value = state[k];
  for (const el of document.querySelectorAll('input[name=colour]')) el.checked = el.value === state.colour;
  $('#colourPhoto').disabled = !state.pal;
  renderForm();
  scheduleBuild();
  if (rc.physics) setTimeout(settle, 400);
}

function insertIntoSketchUp(opts = {}) {
  if (!host && !window.sketchup) return;
  if (!state.parts || !state.parts.length) return;
  const colourOf = (role) => (state.colour === 'photo' && state.pal ? roleColour(state.pal, role) : null);
  const payload = {
    protocol: HOST_PROTOCOL,
    name: state.type === 'ai' ? `AI ${state.aiEngine || 'model'}` : `${TYPE_T[state.type][1]}`,
    recipe: recipe(),
    replace: state.editing,
    place: opts.place !== false, // false: put at the origin (tests); normally the piece follows the mouse
    parts: state.parts.map((p) => ({ name: p.name, role: p.role, color: colourOf(p.role), pos: b64(p.pos), tris: b64(p.tris) })),
  };
  $('#insert').disabled = true;
  status('build', () => t('inserting'));
  // a frame first, so the message shows before SketchUp is busy building
  setTimeout(() => window.sketchup.aim3d_insert(JSON.stringify(payload)), 30);
}

async function connectSketchUp() {
  if (!inSketchUp) return;
  document.documentElement.classList.add('in-sketchup');
  $('#importHint').dataset.t = 'sketchupHint';
  $('#importHint').textContent = t('sketchupHint');
  const su = await waitForSketchUp();
  if (!su) return; // opened with ?host=sketchup outside SketchUp: stays a normal page
  $('#insert').hidden = false;
  $('#editSel').hidden = false;
  su.aim3d_hello(JSON.stringify({ protocol: HOST_PROTOCOL }));
}

// ---------------------------------------------------------------- start
function start() {
  if (location.protocol === 'file:') { $('#fileWarn').hidden = false; $('#fileWarn').textContent = t('fileProto'); return; }
  viewer = new Viewer($('#view'), (why) => {
    viewNote = why === 'restored' ? null : (why === 'nowebgl' ? 'nowebgl' : 'lost');
    paintViewNote();
  });
  builder = new Engine();
  physics = new Engine();
  applyLang();
  $('#lang').addEventListener('click', () => { lang = lang === 'ar' ? 'en' : 'ar'; store.set('lang', lang); applyLang(); showDims(); });
  $('#type').addEventListener('change', (e) => { state.type = e.target.value; state.typeByUser = true; state.fitDims = null; state.fitResult = null; $('#compare').hidden = true; if (state.cut) state.wantFit = true; renderForm(); scheduleBuild(); });
  for (const k of ['w', 'd', 'h']) {
    $(`#${k}`).addEventListener('input', (e) => {
      // Arabic-Indic and Persian digits and the Arabic decimal mark count as typed; anything else is dropped
      let v = e.target.value.replace(/[\u0660-\u0669]/g, (c) => c.charCodeAt(0) - 0x0660).replace(/[\u06F0-\u06F9]/g, (c) => c.charCodeAt(0) - 0x06F0)
        .replace(/[\u066B,]/g, '.').replace(/[^\d.]/g, '');
      const dot = v.indexOf('.');
      if (dot >= 0) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '');
      if (v !== e.target.value) e.target.value = v;
      state[k] = v;
      scheduleBuild();
    });
  }
  $('#quality').addEventListener('change', (e) => { state.quality = e.target.value; scheduleBuild(); });
  for (const r of document.querySelectorAll('input[name=colour]')) r.addEventListener('change', (e) => { state.colour = e.target.value; scheduleBuild(); });
  $('#settle').addEventListener('click', settle);
  $('#stopSim').addEventListener('click', () => stopSim());
  $('#folds').addEventListener('click', async () => {
    state.foldShift += 1;
    const wasPhys = !!state.sims || physics.busy;
    if (physics.busy) stopSim(true);
    clearTimeout(buildTimer);
    const built = await rebuild();
    if (wasPhys && built) settle(); // only after the build of these folds, and only if no newer build replaced it
  });
  $('#glb').addEventListener('click', () => exportAs('glb'));
  $('#insert').addEventListener('click', () => insertIntoSketchUp());
  $('#compare').addEventListener('click', openCompare);
  $('#aiMake').addEventListener('click', makeAI);
  $('#aiCancel').addEventListener('click', cancelAI);
  $('#tokenSave').addEventListener('click', () => { if (window.sketchup && window.sketchup.aim3d_set_token) { window.sketchup.aim3d_set_token($('#token').value.trim()); $('#token').value = ''; status('ai', () => t('tokenSaved')); } });
  $('#closeCompare').addEventListener('click', closeCompare);
  $('#refit').addEventListener('click', () => { state.wantFit = false; runFit(); });
  $('#editSel').addEventListener('click', () => window.sketchup && window.sketchup.aim3d_selection('{}'));
  $('#dae').addEventListener('click', () => exportAs('dae'));
  $('#skipSee').addEventListener('click', () => {
    seeJob++;
    if (seeWorker) { seeWorker.terminate(); seeWorker = null; } // finished downloads stay in the browser's cache
    $('#skipSee').hidden = true;
    $('#seeBar').hidden = true;
    status('see', '');
  });
  const file = $('#file');
  $('#drop').addEventListener('click', () => file.click());
  $('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  file.addEventListener('change', () => { const f = file.files[0]; file.value = ''; takePhoto(f); });
  let depth = 0; // dragenter/dragleave fire for every child crossed: count them, or the highlight flickers
  document.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; $('#drop').classList.add('over'); });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('dragleave', (e) => { e.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) $('#drop').classList.remove('over'); });
  document.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; $('#drop').classList.remove('over'); takePhoto(e.dataTransfer.files[0]); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  scheduleBuild();
  connectSketchUp();
  window.aim3d = { state, viewer, rebuild, settle, exportAs, toGLB, toDAE, insertIntoSketchUp, recipe, applyRecipe, runFit, openCompare }; // for the tests
}

start();
