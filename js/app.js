// AIM 3D Studio Web: photo -> recognised furniture type and style -> the extension's parametric model, with the
// same cloth physics -> GLB / DAE for SketchUp. Everything runs in this browser; the photo never leaves it.
import { TYPES, OPTIONS, RANGES, optionsFor, plannedSize, palette, roleColour, seedFor } from './furniture.js';
import { Viewer } from './viewer.js';
import { Doc, History } from './scene.js';
import { Editor } from './editor.js';
import { Fitter, plainCutout, clean } from './fit.js';
import { readGLB, toPart, sized, cleaned } from './ai.js';
import { splitPieces } from './meshops.js';
import { profileFromMask, revolve } from './profile.js';
import { toProject, fromProject } from './project.js';
import { partGeometry as kitGeometry } from './mesh.js';
import { toGLB, toDAE, download } from './export.js';
import { crc32 } from './rng.js';
import { makeModel, engineQueue } from './engines.js';
import { GEMINI_MODELS, analysisPrompt, analysisSchema, geminiBody, parseAnalysis, askGemini, judgePrompt, judgeSchema, judgeBody, parseJudge } from './vision.js';

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
  bedding: { ar: 'المفرش', en: 'Bedding', v: { duvet: ['لحاف منفوش نازل', 'Fluffy duvet'], tucked: ['مشدود مرتّب', 'Neatly tucked'], none: ['مرتبة بدون مفرش', 'Bare mattress'], puffy: ['لحاف سميك بطيات عميقة للأرض', 'Thick duvet, deep folds to the floor'] } },
  throw: { ar: 'البطانية', en: 'Throw', v: { over_back: ['منسدلة على الظهر', 'Over the back'], over_arm: ['منسدلة على المسند', 'Over the arm'], diagonal: ['كبيرة بعرض السرير نازلة من الجهتين', 'Large, across the bed'], heap: ['كومة على الزاوية', 'Heaped on a corner'], runner: ['شريط مطوي بالعرض', 'Folded runner'], none: ['بدون', 'None'], pile: ['مكوّمة على زاوية الرجلين', 'Piled on the foot corner'] } },
  throw_side: { ar: 'جهة البطانية', en: 'Throw side', v: { left: ['يسار (من جهة الرجلين)', 'Left (seen from the foot)'], right: ['يمين (من جهة الرجلين)', 'Right (seen from the foot)'] } },
  throw_texture: { ar: 'خامة البطانية', en: 'Throw texture', v: { smooth: ['ناعمة', 'Smooth'], knit: ['محبوكة صوف ثقيل', 'Chunky knit'] } },
  pillows: { ar: 'عدد المخدات', en: 'Pillows', v: {} },
  pillow_pose: { ar: 'وقفة المخدات', en: 'Pillow pose', v: { leaning: ['مائلة على الظهر', 'Leaning back'], upright: ['منفوشة واقفة', 'Plumped, upright'] } },
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
  sub: ['أي صورة ← مجسم 3D أبيض تعدّل فيه كل شي وتسحبه لسكتش اب', 'Any photo → a white 3D model you can edit and drag into SketchUp'],
  photo: ['الصورة', 'Photo'],
  drop: ['اسحب أي صورة هنا أو اضغط لاختيارها', 'Drop any photo here, or click to choose one'],
  dropHint: ['JPG أو PNG أو WebP. الصورة تبقى على جهازك.', 'JPG, PNG or WebP. The photo stays on this computer.'],
  change: ['صورة أخرى', 'Another photo'],
  type: ['نوع القطعة', 'Piece'],
  options: ['التفاصيل', 'Details'],
  size: ['المقاسات (سم)', 'Size (cm)'],
  sizeHint: ['اتركها فارغة للمقاس القياسي. السرير يُقاس بالمرتبة.', 'Leave empty for the standard size. A bed is sized by its mattress.'],
  w: ['العرض', 'Width'], d: ['العمق', 'Depth'], h: ['الارتفاع', 'Height'],
  quality: ['الدقة', 'Detail'], light: ['خفيفة (أسرع في سكتشب)', 'Light (quick in SketchUp)'], fast: ['سريعة', 'Fast'], standard: ['عادية', 'Standard'], high: ['مفصّلة', 'Detailed'],
  insert: ['إدراج في سكتشب', 'Insert in SketchUp'],
  pickBox: ['حدّد القطعة في الصورة', 'Select the piece in the photo'], useBox: ['استعمل هذا التحديد', 'Use this selection'], cancelBox: ['إلغاء', 'Cancel'],
  boxNote: ['اسحب مستطيلاً حول القطعة التي تريدها. مفيد لصور الغرف: تُقصّ هذه القطعة وحدها، وتقدر تأخذ قطعة ثانية من نفس الصورة بعد الإدراج.', 'Drag a rectangle around the piece you want. Useful for room photos: only that piece is cut out, and you can take another piece from the same photo after inserting.'],
  boxed: ['حدّدتَ قطعة من الصورة.', 'You selected a piece of the photo.'],
  senseW: ['العرض غير واضح من زاوية هذه الصورة: تأكد منه أو اكتبه.', 'The width is not clear from the angle of this photo: check it or type it.'],
  senseAll: ['هذه الصورة لا تكفي لتحديد المقاسات بدقة: اكتب مقاساً واحداً على الأقل تعرفه.', 'This photo is not enough to pin down the sizes: type at least one measurement you know.'],
  senseD: ['العمق غير واضح من زاوية هذه الصورة: تأكد منه أو اكتبه.', 'The depth is not clear from this photo\'s angle: check it or type it.'],
  senseH: ['الارتفاع غير واضح من زاوية هذه الصورة: تأكد منه أو اكتبه.', 'The height is not clear from this photo\'s angle: check it or type it.'],
  pasted: ['قرأتُ: عرض {w} × عمق {d} × ارتفاع {h} سم. إن كان الترتيب في المصدر مختلفاً فبدّل الخانات.', 'Read as width {w} × depth {d} × height {h} cm. If the source lists them in another order, swap the fields.'],
  partColours: ['ألوان كل جزء مأخوذة من مكانه في الصورة.', 'Each part\'s colour is taken from where it shows in the photo.'],
  aiMake: ['اصنع المجسم بالذكاء الاصطناعي', 'Make the model with AI'], aiCancel: ['إيقاف', 'Stop'],
  aiNote: ['للقطع غير الأثاث التسعة (مصباح، نبتة، تحفة…)، أو لمجسم طبق الأصل. عند الضغط تُرسل الصورة إلى ذكاء اصطناعي مجاني على Hugging Face وترجع مجسماً. الوقت المجاني محدود يومياً.', 'For pieces outside the nine furniture types (a lamp, a plant, decor…), or a model exactly like the photo. Pressing it sends the photo to a free AI on Hugging Face and brings back a model. Free time is limited per day.'],
  aiStep_connect: ['{e}: أتصل…', '{e}: connecting…'], aiStep_upload: ['{e}: أرفع الصورة…', '{e}: uploading the photo…'],
  aiStep_separate: ['{e}: أفصل القطعة عن الخلفية…', '{e}: separating the object…'], aiStep_prepare: ['{e}: أجهّز الصورة…', '{e}: preparing the photo…'],
  aiStep_gpu: ['{e}: يصنع الشكل (وقت GPU مجاني، عادة 1 إلى 3 دقائق)…', '{e}: making the shape (free GPU, usually 1–3 min)…'],
  aiStep_reduce: ['{e}: أخفّف المجسم…', '{e}: reducing the mesh…'], aiStep_export: ['{e}: أصدّر الملف…', '{e}: exporting…'],
  aiStep_download: ['{e}: أنزّل المجسم…', '{e}: downloading the model…'],
  editTitle: ['الأجزاء والتعديل', 'Parts and editing'],
  editHint: ['اضغط جزء في المجسم أو في القائمة. حرّكه أو دوّره أو كبّره بالأسهم، أو اكتب الأرقام. Shift لأكثر من جزء.', 'Click a part in the model or the list. Move, turn or scale it with the handles, or type numbers. Shift for more than one part.'],
  editNote: ['عدّلت أجزاء بيدك: تغيير الخيارات فوق يبني القطعة من جديد ويمسح تعديلاتك (تراجع يرجّعها).', 'You edited parts by hand: changing the options above rebuilds the piece and drops your edits (undo brings them back).'],
  editLost: ['انبنت القطعة من جديد ومسحت تعديلاتك اليدوية. تراجع (Ctrl+Z) يرجّعها.', 'The piece was rebuilt and your hand edits were dropped. Undo (Ctrl+Z) brings them back.'],
  editMany: ['{n} أجزاء مختارة', '{n} parts selected'],
  tMove: ['تحريك', 'Move'], tTurn: ['تدوير', 'Turn'], tScale: ['تكبير', 'Scale'], tUndo: ['تراجع', 'Undo'], tRedo: ['إعادة', 'Redo'],
  pPos: ['المكان (سم)', 'Position (cm)'], pSize: ['المقاس (سم)', 'Size (cm)'], pTurn: ['الدوران (°)', 'Turn (°)'], pRatio: ['حافظ على النسب', 'Keep proportions'],
  pDup: ['تكرار', 'Duplicate'], pMirror: ['مرآة', 'Mirror'], pHide: ['إخفاء', 'Hide'], pShow: ['إظهار', 'Show'], pDel: ['حذف', 'Delete'],
  shapeTools: ['أدوات الشكل', 'Shape tools'],
  aiPiece: ['قطعة', 'Piece'], aiObject: ['المجسم', 'Object'],
  aiLite: ['مسودة محلية الحين (بدون وقت GPU)', 'Local draft now (no GPU time)'],
  aiProfile: ['شكل دائري (فازة، أصيص، أباجورة) من محيطه', 'Round object (vase, pot, shade) from its outline'],
  prTitle: ['المحيط (الشكل الدائري)', 'Profile (round shape)'], prHint: ['اسحب النقاط البرتقالية. دبل كلك على نقطة يشيلها، وعلى الخط يضيف نقطة.', 'Drag the orange points. Double-click a point to remove it, the outline to add one.'],
  prH: ['الارتفاع', 'Height'], prD: ['أعرض قطر', 'Widest'], prWall: ['سماكة الجدار', 'Wall'], prHollow: ['مجوّف (فتحة من فوق)', 'Hollow (open at the top)'],
  profileName: ['الشكل الدائري', 'Profile'], profilePart: ['الجسم', 'Body'],
  profileAuto: ['الشكل متناظر ({s}٪)، فبنيته بلفّ محيطه على محوره: دقيق للأشكال الدائرية، وتعدّل المحيط من «المحيط» تحت.', 'The object is symmetric ({s}%), so it was built by revolving its outline: exact for round objects; edit the outline under "Profile".'],
  profileDone: ['بنيت الشكل بلفّ محيطه ({n} نقاط، تناظر {s}٪).', 'Built by revolving its outline ({n} points, symmetry {s}%).'],
  profileNo: ['ما أقدر أبنيه بلفّ محيطه: {why} (تناظر {s}٪).', 'Cannot build it by revolving its outline: {why} ({s}% symmetry).'],
  profileWarn: ['انتبه: {why}، راجع المحيط.', 'Check: {why}; review the profile.'],
  why_symmetry: ['الشكل مو متناظر', 'the outline is not symmetric'], why_axis: ['منتصفه مو على خط واحد', 'its middle does not line up'],
  why_tilt: ['الصورة مايلة', 'the photo is tilted'], why_cropped: ['الصورة قاصة جزء منه', 'the photo cuts part of it off'],
  why_gaps: ['أجزاء منه مخفية', 'parts of it are hidden'], why_one_side: ['فيه شيء بارز من جهة (مقبض؟): المجسم هو الجسم الدائري بدون هذا الجزء', 'something sticks out on one side (a handle?): the model is the round body without it'],
  why_low_res: ['الصورة صغيرة عليه', 'it is too small in the photo'], listSep: ['، ', ', '],
  pairTitle: ['القطع المتناظرة (يمين ويسار)', 'Mirror pairs (left and right)'],
  pairFind: ['اربط {n} أزواج متناظرة', 'Link {n} mirror pairs'], pairNone: ['ما فيه أزواج متناظرة جديدة', 'No new mirror pairs'],
  pairCount: ['مربوط: {n}', 'Linked: {n}'], pairsLinked: ['ربطت {n} أزواج: تعديل وحدة يعدل توأمها بالمعكوس.', 'Linked {n} pairs: editing one edits its twin, mirrored.'],
  pairLink: ['عدّل التوأم معه (معكوس)', 'Edit the twin with it (mirrored)'], pairOf: ['توأمها: {n}', 'Its twin: {n}'],
  pairUnlink: ['فك الربط', 'Unlink'], snapDist: ['الالتصاق (سم، 0 = بدون)', 'Snap (cm, 0 = off)'],
  snapHint: ['يلصق صناديق القطع ببعض (مو السطوح المنحنية). اضغط Alt وأنت تسحب عشان تتحرك بحرية.', 'Snaps the parts\' boxes together (not curved surfaces). Hold Alt while dragging to move freely.'],
  prTop: ['قطر الفوهة/الأعلى', 'Top (mouth)'], prBase: ['قطر القاعدة', 'Base'], prSeg: ['الأضلاع', 'Segments'],
  prReset: ['رجّع المحيط كما قُرئ من الصورة', 'Reset to the profile read from the photo'],
  prLocked: ['النقطة مقفلة (Shift + ضغطة تفكها).', 'The point is locked (Shift+click unlocks it).'],
  prSwapAbove: ['جرّب تقدير صورة مأخوذة من فوق (≈{d}°)', 'Try an elevated-view estimate (≈{d}°)'],
  prSwapSide: ['رجّعها صورة من الجنب', 'Back to a side view'],
  prAbove: ['تقدير لصورة مأخوذة من فوق بزاوية {d}° تقريباً (من شكل الحافة): الارتفاع تقريبي، راجعه.', 'Elevated-view estimate, about {d}° from above (from the rim): the height is approximate, check it.'],
  prSide: ['يفترض أن الصورة مأخوذة من الجنب، مو من فوق.', 'Assumes the photo was taken from the side, not from above.'],
  kind_param: ['بالقواعد', 'by rules'], kind_ai: ['مجسم ذكاء اصطناعي', 'AI mesh'], kind_lite: ['مسودة تقريبية', 'rough draft'],
  kind_profile: ['محيط ملفوف', 'revolved profile'],
  provGeometry: ['الشكل: {v}', 'Shape: {v}'], provSize: ['المقاس: {v}', 'Size: {v}'], provProduct: ['القطعة: {v}', 'Product: {v}'],
  provCamera: ['يفترض صورة من الجنب', 'assumes a side view'],
  provAbove: ['تقدير لصورة من فوق ≈{d}° (الارتفاع تقريبي)', 'elevated-view estimate ≈{d}° (height approximate)'],
  why_from_above: ['الصورة مأخوذة من فوق فصححت الارتفاع من شكل الحافة', 'seen from above: heights corrected from the rim'],
  size_user: ['كتبته أنت', 'typed by you'], size_ai: ['تقدير الذكاء الاصطناعي (غير مؤكد)', 'AI estimate (unverified)'],
  size_default: ['مقاس افتراضي (غير مؤكد)', 'a typical size (unverified)'],
  product_ai_suggestion: ['اقتراح الذكاء الاصطناعي من الصورة، بدون بحث، غير مؤكد', 'AI suggestion from the picture, not searched, unverified'],
  product_user_verified: ['أكدتها أنت', 'confirmed by you'],
  anConfirm: ['تأكدت أنها نفس القطعة', 'I checked: this is the product'],
  saveProject: ['احفظ المشروع (قابل للتعديل)', 'Save project (editable)'], openProject: ['افتح مشروع', 'Open project'],
  projectSaved: ['حفظت المشروع: تفتحه بعدين وكل جزء قابل للتعديل.', 'Project saved: open it later with every part editable.'],
  projectOpened: ['فتحت المشروع ({n} أجزاء).', 'Project opened ({n} parts).'], projectBad: ['ما قدرت أفتح الملف: {e}', 'Could not open the file: {e}'],
  projectName: ['مشروع', 'project'],
  liteName: ['مسودة محلية', 'Local draft'],
  liteWorking: ['أجهّز المسودة المحلية…', 'Preparing the local draft…'],
  liteDownload: ['أنزّل أداة العمق (مرة وحدة، حوالي 27 ميغا)… {p}٪', 'Downloading the depth tool (once, about 27 MB)… {p}%'],
  liteDepth: ['أقيس عمق الصورة وأبني الشكل…', 'Measuring the photo depth and building the shape…'],
  liteDone: ['هذي مسودة محلية تقريبية (الواجهة من الصورة والخلف تقديري). عدّلها، أو جرّب الذكاء الاصطناعي بعدين لنتيجة أدق.', 'This is a rough local draft (the front from the photo, the back estimated). Edit it, or try the AI later for a closer result.'],
  liteFail: ['ما قدرت أسوي المسودة ({e}).', 'Could not make the draft ({e}).'],
  liteNeedCut: ['المسودة تحتاج القطعة مقصوصة من الصورة: انتظر القص أو حدّد القطعة بمربع.', 'The draft needs the piece cut out of the photo: wait for the cut-out, or select it with a box.'],
  liteFallback: ['ما قدر أي محرك مجاني الحين، فسويت مسودة محلية.', 'No free engine could make it now, so here is a local draft.'],
  sizeEstimate: ['المقاس تقديري: اكتب مقاس واحد حقيقي تعرفه.', 'The size is an estimate: type one real measurement you know.'],
  sCut: ['قص بمستوى', 'Cut with a plane'], sLasso: ['اقطع بالرسم', 'Cut out by drawing'], sSplit: ['افصل القطع المنفصلة', 'Split loose pieces'],
  sClean: ['نظّف', 'Clean up'], sSmooth: ['نعّم', 'Smooth'], sLighter: ['خفّف', 'Lighter'],
  lassoThrough: ['الرسم يقطع لين الخلف (مو الواجهة بس)', 'Drawing cuts right through (not just the front)'],
  cutAcross: ['القص:', 'Cut:'], axisZ: ['أفقي', 'Level'], axisX: ['عرضي', 'Across'], axisY: ['طولي', 'Along'],
  cutGo: ['اقطع', 'Cut'], cutCancel: ['إلغاء', 'Cancel'], cutLow: ['تحت', 'low'], cutHigh: ['فوق', 'high'],
  cutDone: ['انقسم الجزء لجزأين، وتقدر تحرّك كل واحد لحاله.', 'The part is now two parts; each moves on its own.'],
  cutEmpty: ['المستوى ما يقطع الجزء: حرّكه لين يمرّ فيه.', 'The plane does not cross the part: move it through it.'],
  lassoHint: ['ارسم حول المنطقة اللي تبيها جزء لحاله.', 'Draw around the area you want as a part of its own.'],
  lassoDone: ['صار جزء لحاله، ومختار الحين.', 'It is now a part of its own, and selected.'],
  lassoEmpty: ['الرسم ما شمل شي من الجزء، أو شمله كله.', 'The drawing took none of the part, or all of it.'],
  lassoPart: ['قطعة', 'piece'],
  splitDone: ['انفصل لـ {n} أجزاء.', 'Split into {n} parts.'], splitOne: ['الجزء قطعة وحدة متصلة: استعمل القص.', 'The part is one connected piece: use a cut.'],
  pickOne: ['اختر جزء واحد أول.', 'Select one part first.'], opNothing: ['ما بقي شي بعد العملية، فما تغيّر.', 'Nothing would be left, so nothing changed.'],
  opDone: ['تم. صار {n} مثلث.', 'Done: {n} triangles now.'],
  mTurn: ['دوّر المجسم 90°', 'Turn the model 90°'], mSide: ['اقلبه على جنبه', 'Tip it over 90°'], mFloor: ['نزّله على الأرض', 'Set it on the floor'], mShowAll: ['أظهر كل الأجزاء', 'Show all parts'],
  judge: ['خلّ الذكاء الاصطناعي يقارن المجسم بالصورة ويصحّحه', 'Let the AI compare the model with the photo and fix it'],
  judgeWaiting: ['أنتظر القماش يستقر قبل المقارنة…', 'Waiting for the fabric to settle before comparing…'],
  judgeWorking: ['الجولة {r}: الذكاء الاصطناعي يقارن المجسم بالصورة…', 'Round {r}: the AI is comparing the model with the photo…'],
  judgeRefit: ['الجولة {r}: عدّلتُ المجسم وأطابقه مع الصورة من جديد…', 'Round {r}: changed the model, matching it to the photo again…'],
  judgeDone: ['قارن الذكاء الاصطناعي المجسم بالصورة: {s} من 10. {c}', 'The AI compared the model with the photo: {s} of 10. {c}'],
  judgeChanged: ['غيّر {n} من الخيارات (تقدر ترجّعها من القوائم).', 'It changed {n} options (you can set them back in the lists).'],
  judgeNoChange: ['ما شاف شي يحتاج تغيير.', 'It saw nothing to change.'],
  judgeRound: ['الجولة {r}: {s} من 10', 'Round {r}: {s} of 10'],
  judgeLeft: ['أكبر فرق باقي: {d}', 'Biggest difference left: {d}'],
  judgeSingle: ['اقتراح من نظرة وحدة بس، ما غيّرته: {c}', 'Named by one look only, left unchanged: {c}'],
  judgeKept: ['بقي التغيير: التطابق مع الصورة {a}٪ ← {b}٪.', 'Change kept: match with the photo {a}% → {b}%.'],
  judgeUndone: ['رجّعتُ هذا التغيير لأنه بعّد المجسم عن الصورة: التطابق نزل من {a}٪ إلى {b}٪.', 'Undone: it took the model away from the photo, the match fell from {a}% to {b}%.'],
  judgeUndoing: ['الجولة {r}: التغيير بعّد المجسم عن الصورة، أرجّعه…', 'Round {r}: the change took the model away from the photo, undoing it…'],
  judgeFail: ['ما قدرت أقارن ({e}).', 'Could not compare ({e}).'],
  judgeNeedFit: ['المقارنة تحتاج المجسم مطابق مع الصورة أولاً.', 'Comparing needs the model matched to the photo first.'],
  aiBest: ['جرّب كل المحركات واختر الأقرب', 'Try every engine, keep the closest'],
  // Hugging Face's ZeroGPU day (its docs, 2026-11): 2 min without an account, 5 min with a free one, 40 min with PRO,
  // counted again 24 h after the first use. A model takes from a few seconds to two minutes of it.
  aiBestHint: ['تشتغل المحركات واحد بعد الثاني (عدة دقائق)، وكل مجسم ينقاس على الصورة. وقت Hugging Face المجاني في اليوم: دقيقتين بدون رمز، و5 دقائق بحساب مجاني، ويرجع بعد 24 ساعة من أول استعمال، فالمقارنة ممكن تخلّص وقت اليوم كله.', 'The engines run one after another (several minutes); each model is measured against the photo. Free Hugging Face time per day: 2 minutes without a token, 5 with a free account, back 24 hours after the first use, so comparing can use up the whole day.'],
  aiBestNoCut: ['المقارنة تحتاج القطعة مقصوصة من الصورة: انتظر القص، أو حدّد القطعة بمربع.', 'Comparing needs the piece cut out of the photo: wait for the cut-out, or select the piece with a box.'],
  aiBestStep: ['({i} من {n}) {s}', '({i} of {n}) {s}'],
  aiBestScoring: ['{e}: أقيس المجسم على الصورة…', '{e}: measuring the model against the photo…'],
  aiBestScore: ['{e}: يطابق الصورة {p}٪', '{e}: {p}% match with the photo'],
  aiBestWorking: ['{e}: يشتغل…', '{e}: working…'],
  aiBestUse: ['استعمل هذا', 'Use this one'], aiBestUsing: ['المستعمل الحين', 'In use'],
  aiBestDone: ['الأقرب للصورة: {e} ({p}٪). نجح {n} من {m} محركات، وتقدر تختار غيره من تحت.', 'Closest to the photo: {e} ({p}%). {n} of {m} engines made a model; you can pick another below.'],
  aiBestNone: ['ما نجح أي محرك الحين.', 'No engine could make the model now.'],
  aiBestQuota: ['خلص الوقت المجاني', 'free time used up'],
  viewsTitle: ['صور إضافية لنفس القطعة (اختياري)', 'More photos of the same piece (optional)'],
  vBack: ['من الخلف', 'Back'], vLeft: ['من اليسار', 'Left'], vRight: ['من اليمين', 'Right'],
  videoPick: ['أو فيديو لفّة حول القطعة', 'or a video turning around the piece'],
  swapLR: ['بدّل اليسار واليمين', 'Swap left and right'], clearViews: ['امسح الصور الإضافية', 'Clear the extra photos'],
  viewsHint: ['مع صور إضافية يبدأ Hunyuan3D 2mv فيطلع الخلف والجوانب أقرب للحقيقة. من الفيديو آخذ الأمام والجانبين والخلف (أرباع اللفّة).', 'With more photos Hunyuan3D 2mv goes first, so the back and sides come out closer to the real piece. From a video the front, sides and back are taken (quarter turns).'],
  videoReading: ['أقرأ الفيديو…', 'Reading the video…'],
  videoDone: ['أخذت من الفيديو الأمام والجانبين والخلف. تأكد أن اليسار واليمين في مكانهم.', 'Took the front, sides and back from the video. Check that left and right are the right way round.'],
  videoBad: ['ما قدرت أقرأ الفيديو. جرّب MP4 أو WebM.', 'Could not read the video. Try MP4 or WebM.'],
  aiFailAll: ['ما قدر أي ذكاء اصطناعي مجاني يصنع المجسم الحين. {e}', 'No free AI could make the model now. {e}'],
  aiToken: [' رمز Hugging Face غير صحيح؛ صحّحه أو امسحه.', ' The Hugging Face token is not valid; fix it or clear it.'],
  aiNeedPhoto: ['أضف صورة القطعة أولاً.', 'Add a photo of the piece first.'],
  aiReceiving: ['يصل المجسم… {p}٪', 'Receiving the model… {p}%'],
  aiDone: ['صنعه {e}. اكتب مقاساً واحداً تعرفه ليصير بحجمه الحقيقي.', 'Made by {e}. Type one measurement you know to give it its real size.'],
  aiQuotaToken: [' خلص وقتك المجاني على Hugging Face لليوم، ويرجع بكرة.', ' Your free Hugging Face time is used up for today; it comes back tomorrow.'],
  aiFail: ['{e}', '{e}'], aiQuota: [' انتهى الوقت المجاني لليوم؛ رمز Hugging Face مجاني يعطيك وقتاً أكثر.', ' The free time is used up for today; a free Hugging Face token gives more.'],
  token: ['رمز Hugging Face (اختياري)', 'Hugging Face token (optional)'], tokenSave: ['حفظ', 'Save'], tokenSaved: ['انحفظ الرمز عندك (في سكتش اب أو في هذا المتصفح)، وما يُرسل إلا لـ Hugging Face.', 'Saved with you (in SketchUp or in this browser); it goes only to Hugging Face.'],
  aiNoEdit: ['قطع الذكاء الاصطناعي لا تُعدَّل من هنا؛ اصنعها من جديد.', 'AI pieces cannot be edited from here; make them again.'],
  cutting: ['أقصّ القطعة من الصورة…', 'Cutting the piece out of the photo…'],
  cutDownload: ['تنزيل نموذج القصّ مرة واحدة: {a} من {b} م.ب', 'Downloading the cut-out model once: {a} of {b} MB'],
  cutFail: ['تعذّر قصّ القطعة من الصورة ({e}). المقاسات القياسية مستعملة.', 'Could not cut the piece out of the photo ({e}). Standard sizes are used.'],
  fitting: ['أطابق الشكل مع الصورة… (10 إلى 30 ثانية)', 'Matching the shape to the photo… (10 to 30 seconds)'],
  shapeChosen: ['«{o}»: الصورة توحي بـ«{a}» لكن محيطها يطابق «{b}» أكثر (تطابق المحيط {x}٪ ← {y}٪)، فاخترته.', '{o}: the picture suggested {a} but its outline matches {b} better (silhouette overlap {x}% to {y}%), so {b} was used.'],
  fitted: ['طابقتُ الشكل مع الصورة: تطابق {p}٪. «قارن بالصورة» يريك الفرق.', 'Matched to the photo: {p}% overlap. Compare with photo shows the difference.'],
  fittedLow: ['تطابق ضعيف مع الصورة ({p}٪): ربما النوع أو التفاصيل مختلفة، أو الصورة فيها أكثر من قطعة.', 'Weak match with the photo ({p}%): the piece or its details may differ, or the photo shows more than one piece.'],
  cutStalled: ['توقف تحميل أداة القص أو القص نفسه. جرّب مرة ثانية، أو حدّد القطعة بمربع.', 'The cut-out tool stopped responding while loading or cutting. Try again, or select the piece with a box.'],
  seeAI: ['اقرأ التفاصيل بالذكاء الاصطناعي (ترسل الصورة لـ Google)', 'Read the details with AI (sends the photo to Google)'],
  seeAIWorking: ['الذكاء الاصطناعي يقرأ تفاصيل الصورة…', 'The AI is reading the photo details…'],
  seeAIDone: ['قرأ الذكاء الاصطناعي: {d}', 'The AI read: {d}'],
  seeAIFail: ['ما قدر الذكاء الاصطناعي يقرأ التفاصيل ({e}). استعملتُ التعرّف العادي.', 'The AI could not read the details ({e}); the usual recognition is used.'],
  seeAINoToken: ['قراءة التفاصيل تحتاج مفتاح Gemini (تحت).', 'Reading the details needs a Gemini key (below).'],
  seeAIBadKey: ['مفتاح Gemini غير صحيح', 'the Gemini key is not valid'],
  seeAIQuota: ['خلص حد Gemini المجاني الحين، جرّب بعد دقيقة أو بكرة', 'the free Gemini limit is used up for now; try in a minute or tomorrow'],
  seeAINet: ['ما وصلنا لـ Google، تأكد من الإنترنت', 'Google could not be reached; check the internet connection'],
  seeAIUnreadable: ['جواب ما ينقرأ', 'an answer that could not be read'],
  gemini: ['مفتاح Gemini (لقراءة التفاصيل)', 'Gemini key (to read the details)'],
  geminiHint: ['مجاني من aistudio.google.com/apikey. يبقى عندك (في سكتش اب أو في هذا المتصفح) وما يُرسل إلا لـ Google.', 'Free from aistudio.google.com/apikey. It stays with you (in SketchUp or in this browser) and goes only to Google.'],
  geminiChange: ['تغيير مفتاح Gemini', 'Change the Gemini key'],
  geminiForget: ['احذف المفتاح', 'Remove the key'],
  geminiRemoved: ['انحذف مفتاح Gemini.', 'Gemini key removed.'],
  anTitle: ['قراءة الذكاء الاصطناعي', 'What the AI read'],
  anSize: ['المقاس المتوقع: {w} × {d} × {h} سم ({c})', 'Likely size: {w} × {d} × {h} cm ({c})'],
  anSure_low: ['تقدير تقريبي', 'a rough guess'], anSure_medium: ['تقدير متوسط', 'a fair estimate'], anSure_high: ['تقدير قوي', 'a firm estimate'],
  anUseSize: ['استعمل هذا المقاس', 'Use this size'],
  anProduct: ['غالباً: {p} ({c})', 'Probably: {p} ({c})'],
  anSearch: ['ابحث عن منتجات مشابهة (وصور من الخلف والجنب تضيفها تحت)', 'Search for similar products (and back and side photos to add below)'],
  anTip: ['نصيحة: {t}', 'Tip: {t}'],
  anBy: ['قرأها {m}', 'Read by {m}'],
  geminiEmpty: ['الصق المفتاح في الحقل أولاً (Ctrl+V)، ثم اضغط حفظ.', 'Paste the key into the field first (Ctrl+V), then press Save.'],
  geminiSaved: ['حُفظ مفتاح Gemini.', 'Gemini key saved.'],
  geminiSavedRead: ['حُفظ مفتاح Gemini. الذكاء الاصطناعي يقرأ تفاصيل الصورة…', 'Gemini key saved. The AI is reading the photo details…'],
  exactAI: ['تبيه طبق الأصل من الصورة؟ اصنعه بالذكاء الاصطناعي (قطعة واحدة)', 'Want it exactly like the photo? Make it with AI (one piece)'],
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
  glb: ['تنزيل لسكتش اب (GLB)', 'Download for SketchUp (GLB)'], dae: ['DAE', 'DAE'],
  dragOut: ['اسحبني لسكتش اب', 'Drag me into SketchUp'],
  dragTip: ['في Chrome و Edge: اسحب هذا الزر لنافذة سكتش اب أو لأي مجلد. ولو ما زبط: نزّل الملف واسحبه من التنزيلات لسكتش اب.', 'In Chrome and Edge: drag this button onto SketchUp\'s window or into a folder. If that does not work: download the file and drag it from your downloads into SketchUp.'],
  autoAI: ['الصورة مو من الأثاث التسعة، فأصنع المجسم بالذكاء الاصطناعي…', 'The photo is not one of the nine furniture types, so the AI is making the model…'],
  autoLite: ['الصورة مو من الأثاث التسعة: هذي مسودة محلية (ما طلعت الصورة من جهازك). لنتيجة أدق اضغط «اصنع المجسم بالذكاء الاصطناعي».', 'The photo is not one of the nine furniture types: here is a local draft (the photo did not leave this computer). For a closer result press "Make the model with AI".'],
  aiAuto: ['اصنع المجسم بالذكاء الاصطناعي لحاله للصور اللي مو أثاث (ترسل الصورة لـ Hugging Face)', 'Make the model with AI by itself for photos that are not furniture (sends the photo to Hugging Face)'],
  importHint: ['لسكتش اب: اسحب الملف المنزّل لنافذة سكتش اب، أو ملف ← استيراد. كل جزء يدخل مجموعة باسمه وبمقاسه الحقيقي. DAE للنسخ القديمة من سكتش اب.',
    'Into SketchUp: drag the downloaded file onto SketchUp\'s window, or File → Import. Each part comes in as a named group at its real size. DAE is for older SketchUp versions.'],
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
  cut: null, photoCanvas: null, photoBig: null, box: null, partColors: null, sense: null, fitDims: null, fitResult: null, wantFit: false, aiRaw: null, aiEngine: '',
  aiCands: [], aiPick: -1, views: { back: null, left: null, right: null }, viewUrls: { back: null, left: null, right: null },
  photo: null, photoSeed: null, pal: null, foldShift: 0,
  sims: null, simKey: null, parts: null, items: [],
};
// pieces with something soft for the physics: beds, sofas, armchairs, and chairs with a padded seat or back
const soft = (type, o) => type === 'bed' || type === 'sofa' || type === 'armchair' || (type === 'chair' && (o.back === 'upholstered' || o.pad === 'yes'));
const seed = () => (state.photoSeed != null ? state.photoSeed : seedFor(`AIM ${state.type}`)) + 7919 * state.foldShift;
const request = () => ({ ...(window.__tune ? { tune: window.__tune } : {}), type: state.type, attrs: optionsFor(state.type, state.vals[state.type] || {}), seed: seed(), quality: state.quality,
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
// the builder's items (what the fitter and the judge look at); the previous ones are freed (the document keeps its
// own copies)
function setItems(items) {
  const keep = new Set(items.map((it) => it.geometry));
  for (const it of state.items || []) if (!keep.has(it.geometry)) it.geometry.dispose();
  state.items = items;
}
function scheduleBuild() { clearTimeout(buildTimer); buildTimer = setTimeout(rebuild, 90); }

let autoSimFor = null;
const needsPhysics = (req) => req.type === 'bed' && (req.attrs.bedding === 'puffy' || req.attrs.throw === 'pile');
async function rebuild() {
  if (state.type === 'ai') {
    if (state.aiRaw && doc && doc.source === 'ai' && state.aiDocFor === state.aiRaw) return resizeAI();
    return showAI();
  }
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
  setItems(viewer.makeItems(r.parts));
  loadDoc(state.items, 'param', sizeKey !== lastFramedKey);
  lastFramedKey = sizeKey;
  state.sizeSource = Object.values(typedDims()).some((v) => v > 0) ? 'user' : 'default';
  status('build', () => fill(t('built'), { n: nf(r.parts.length), t: nf(r.triangles) }));
  showDims();
  renderActions(r.cloth);
  if (state.wantFit && state.cut && mine === latestBuild) setTimeout(runFit, 50);
  // the puffy duvet and the piled throw get their shape from the physics: it runs by itself for them, once per piece
  else if (mine === latestBuild && !fitting && !state.sims && r.cloth && needsPhysics(req) && autoSimFor !== key) { autoSimFor = key; setTimeout(settle, 50); }
  return mine === latestBuild;
}

// ---------------------------------------------------------------- the document (what is shown, edited, exported)
let doc = null;
let history = null;
let editor = null;
// A new build replaces the parts. When the user had edited parts by hand, the replacement is an undoable step and a
// note says so; otherwise history starts afresh with the new model.
function loadDoc(items, source, frame) {
  if (!doc) return;
  history.adopt(doc);
  if (doc.edited && doc.parts.length) {
    history.record(doc, 'rebuild', () => doc.load(items, source));
    status('build', () => t('editLost'));
  } else {
    doc.load(items, source);
    history.clear(doc);
  }
  editor.refresh(frame);
  prepareDrag();
  paintProvenance();
}
// hand edits are what export writes; the option lists rebuild the piece from scratch
function paintEditNote() {
  $('#editNote').hidden = !(doc && doc.edited && doc.source === 'param');
}
function clearDoc() {
  if (!doc) { if (viewer) viewer.clear(); return; }
  history.adopt(doc);
  doc.clear();
  history.clear(doc);
  viewer.clear();
  editor.refresh();
  prepareDrag();
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
    // a bigger copy, so a small piece selected in a room photo is cut out from real detail
    const kb = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    var big = document.createElement('canvas');
    big.width = Math.max(1, Math.round(bitmap.width * kb));
    big.height = Math.max(1, Math.round(bitmap.height * kb));
    big.getContext('2d').drawImage(bitmap, 0, 0, big.width, big.height);
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
  state.aiCands = []; state.aiPick = -1; paintCands();
  stopJudge(); state.judge = null; paintJudge(); status('judge', ''); $('#judge').hidden = true;
  if (aiBusyNow()) cancelAI(); // a model being made for the last photo is not wanted any more
  state.aiRaw = null; state.aiDocFor = null;
  for (const side of ['back', 'left', 'right']) setView(side, null); // the extra photos belonged to the last piece
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
  state.photoBig = big;
  state.box = null; state.partColors = null; state.sense = null; showSense();
  state.cut = null; state.fitDims = null; state.fitResult = null; $('#compare').hidden = true; $('#exactAI').hidden = true; closeCompare();
  $('#pickBox').hidden = false;
  cutOut(px, w, h, c, mine);
  $('#thumb').src = state.photo;
  $('#drop').classList.add('has');
  renderForm();
  scheduleBuild();
  const shot = await createImageBitmap(c);
  if (mine === photoJob) recognise(shot); else shot.close();
  paintAnalysis();
  if (mine === photoJob && seeOn()) readDetails();
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
// Any photo becomes 3D: when the photo is not one of the nine furniture types (and the user did not pick a type),
// the AI engines start by themselves once the cut-out is ready, once per photo; when they fail, the local draft does.
// The photo goes to Hugging Face only when the user said so: by pressing "make with AI", or once and for all with
// the "make it with AI by itself" switch. Without it, the automatic route is the local draft (nothing leaves the
// computer); the AI button stays one press away.
const aiAutoOn = () => store.get('aiAuto') === '1';
function maybeAutoAI() {
  if (state.type !== 'ai' || state.typeByUser || state.aiRaw || !state.photo || state.autoAIFor === photoJob) return;
  if (aiBusyNow()) return; // something is already being made
  const photo = photoJob;
  state.autoAIFor = photo;
  waitFor(() => state.cut && state.cut.mask, 240000).then(async (ready) => {
    if (!ready || photo !== photoJob || state.type !== 'ai' || state.aiRaw || aiBusyNow()) return;
    if (readingFor === photo) await waitFor(() => readingFor !== photo || photo !== photoJob, 90000);
    if (photo !== photoJob || state.type !== 'ai' || state.aiRaw || aiBusyNow()) return;
    if (makeProfile(true)) return;
    if (aiAutoOn()) { status('ai', () => t('autoAI')); makeAI(); } else makeLite(t('autoLite'));
  });
}
function applySeen(r) {
  const p = Math.round(r.confidence * 100);
  const sure = r.type !== 'other' && r.confidence >= 0.45;
  if (sure) state.wantFit = true; // matched to the photo once the recognised piece is built
  if (sure && !state.typeByUser) state.type = r.type;
  if (r.type === 'other' && r.confidence >= 0.45 && !state.typeByUser) { state.type = 'ai'; setTimeout(maybeAutoAI, 0); }
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
  // the vision model reads details far better: what it said for this photo stands over this guess
  if (state.aiSeen && state.aiSeen.photo === photoJob) applyAISeen(state.aiSeen);
  renderForm();
  scheduleBuild();
}

// ---------------------------------------------------------------- the photo read by AI (Gemini, the user's own key)
// Only after the user switched it on. On the website the key stays in this browser and the photo goes from the
// browser to Google; inside SketchUp the extension keeps the key and carries the same request. The question and the
// answer's schema come from the option lists (vision.js), so a new option is asked about without touching this.
const relay = () => !!(window.sketchup && window.sketchup.aim3d_see); // the extension carries the request
const seeOn = () => (relay() ? !!(host && host.see_ai) : store.get('see') === '1');
const hasKey = () => (relay() ? !!(host && host.has_gemini) : !!store.get('gemini'));
const optEn = (k, v) => (OPT_T[k] && OPT_T[k].v && OPT_T[k].v[v] ? OPT_T[k].v[v][1] : v);
function seePrompt() {
  return analysisPrompt(TYPES, OPTIONS, (k) => TYPE_T[k][1], (k) => (OPT_T[k] ? OPT_T[k].en : k), optEn);
}
let seeSchemaCache = null;
const seeSchema = () => (seeSchemaCache = seeSchemaCache || analysisSchema(TYPES, OPTIONS));
let aiSeeJob = 0;
let aiSeeFor = 0;
let aiAbort = null;
let readingFor = null; // the photo whose reading is on its way
function readDetails(src) {
  if (!state.photoCanvas) return;
  if (!hasKey()) { status('seeAI', () => t('seeAINoToken'), true); paintKeyRow(); return; }
  const big = src || state.photoBig || state.photoCanvas;
  const k = Math.min(1, 1024 / Math.max(big.width, big.height));
  const c = document.createElement('canvas');
  c.width = Math.max(8, Math.round(big.width * k)); c.height = Math.max(8, Math.round(big.height * k));
  c.getContext('2d').drawImage(big, 0, 0, c.width, c.height);
  const id = ++aiSeeJob;
  state.aiSeen = null;
  aiSeeFor = photoJob;
  readingFor = photoJob;
  paintAnalysis();
  status('seeAI', () => t('seeAIWorking'));
  const body = geminiBody(seePrompt(), c.toDataURL('image/jpeg', 0.9), seeSchema(), { thinking: window.__seeThinking });
  if (aiAbort) aiAbort.abort();
  aiAbort = null;
  if (relay()) { window.sketchup.aim3d_see(JSON.stringify({ job: id, body, models: GEMINI_MODELS })); return; }
  aiAbort = new AbortController();
  const url = new URLSearchParams(location.search).get('geminiUrl') || undefined; // tests: a local stand-in for Google
  askGemini(store.get('gemini'), body, { signal: aiAbort.signal, url })
    .then((r) => window.aim3dSee({ job: id, status: 'done', text: r.text, model: r.model }),
      (e) => { if (e.name !== 'AbortError') window.aim3dSee({ job: id, status: 'error', error: e.message, bad_key: e.kind === 'key', quota: e.kind === 'quota', net: e.kind === 'net' }); });
}
function stopReading() {
  aiSeeJob++;
  readingFor = null;
  if (aiAbort) aiAbort.abort();
  aiAbort = null;
  if (window.sketchup && window.sketchup.aim3d_see_cancel) window.sketchup.aim3d_see_cancel('read');
}
function applyAISeen(seen) {
  if (!state.typeByUser) {
    if (TYPES.includes(seen.type)) state.type = seen.type;
    else if (seen.type === 'other') { state.type = 'ai'; setTimeout(maybeAutoAI, 0); }
  }
  if (!TYPES.includes(seen.type)) return;
  const vals = state.vals[seen.type] = state.vals[seen.type] || {};
  const mine = state.userSet[seen.type] || {};
  const here = state.fromPhoto[seen.type] = state.fromPhoto[seen.type] || {};
  for (const [k, v] of Object.entries(seen.attrs)) {
    if (mine[k]) continue;
    vals[k] = v;
    here[k] = true;
  }
}
function seenSummary(seen) {
  const ar = lang === 'ar';
  const parts = [TYPE_T[seen.type] ? TYPE_T[seen.type][ar ? 0 : 1] : seen.type];
  for (const [k, v] of Object.entries(seen.attrs)) {
    const o = OPT_T[k];
    if (o && o.v && o.v[v]) parts.push(o.v[v][ar ? 0 : 1]);
    else if (/^\d+$/.test(v)) parts.push(`${o ? o[ar ? 'ar' : 'en'] : k} ${nf(Number(v))}`);
  }
  return parts.join(ar ? '، ' : ', ');
}
// The analysis card: what the AI saw, part by part, its size estimate (one click puts it in the size fields), the
// photo's problems and a tip. The Arabic notes come from the AI as written; in English only the names are shown.
function paintAnalysis() {
  const a = state.aiSeen;
  const box = $('#analysis');
  box.hidden = !a || a.photo !== photoJob;
  if (box.hidden) return;
  const ar = lang === 'ar';
  $('#anName').textContent = (ar ? a.nameAr || a.name : a.name || a.nameAr) || '';
  $('#anDesc').textContent = ar ? a.descAr : '';
  $('#anDesc').hidden = !ar || !a.descAr;
  const ul = $('#anParts');
  ul.textContent = '';
  for (const l of a.layers) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = `${ar ? l.ar || l.en : l.en || l.ar}${l.count > 1 ? ` × ${nf(l.count)}` : ''}`;
    li.appendChild(b);
    if (ar && l.detail) li.appendChild(document.createTextNode(` — ${l.detail}`));
    ul.appendChild(li);
  }
  ul.hidden = !a.layers.length;
  const s = a.size;
  $('#anSize').hidden = !s;
  $('#anUseSize').hidden = !s;
  if (s) $('#anSize').textContent = fill(t('anSize'), { w: nf(s.w), d: nf(s.d), h: nf(s.h), c: t(`anSure_${a.sizeSure}`) });
  const issues = $('#anIssues');
  issues.textContent = '';
  if (ar) for (const x of a.issues) { const li = document.createElement('li'); li.textContent = x; issues.appendChild(li); }
  issues.hidden = !ar || !a.issues.length;
  $('#anTip').textContent = ar && a.tip ? fill(t('anTip'), { t: a.tip }) : '';
  $('#anTip').hidden = !ar || !a.tip;
  $('#anBy').textContent = fill(t('anBy'), { m: a.model || 'Gemini' });
  // what the product probably is, and a search for more photos of it (the user picks back and side views)
  const known = a.product && a.productSure !== 'none';
  $('#anProduct').hidden = !known;
  if (known) $('#anProduct').textContent = fill(t('anProduct'), { p: [a.maker, a.product].filter(Boolean).join(' — '), c: t(`anSure_${a.productSure === 'high' ? 'high' : a.productSure === 'medium' ? 'medium' : 'low'}`) });
  const q = a.query || a.name;
  $('#anSearch').hidden = !q;
  if (q) $('#anSearch').href = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
  $('#anConfirmRow').hidden = !known;
  $('#anConfirm').checked = state.productConfirmed === photoJob;
  paintProvenance();
}
function useAISize() {
  const s = state.aiSeen && state.aiSeen.size;
  if (!s) return;
  for (const [k, v] of Object.entries(s)) { state[k] = String(v); $(`#${k}`).value = String(v); }
  if (state.cut) state.wantFit = true;
  showSense();
  scheduleBuild();
}
window.aim3dSee = (m) => {
  // the judge's answers go to the request that waits for them
  const pend = m && seePending.get(m.job);
  if (pend) {
    seePending.delete(m.job);
    if (m.status === 'done') pend.resolve({ text: m.text, model: m.model });
    else pend.reject(Object.assign(new Error(String(m.error || 'error')), { kind: m.bad_key ? 'key' : m.quota ? 'quota' : m.net ? 'net' : 'model' }));
    return;
  }
  if (!m || m.job !== aiSeeJob || aiSeeFor !== photoJob) return; // an older photo's answer
  aiAbort = null;
  readingFor = null;
  if (m.status === 'error') {
    if (m.bad_key) { keyBad = true; paintKeyRow(); } // the key field comes back for a new key
    const why = m.error === 'no_key' ? null
      : m.bad_key ? t('seeAIBadKey') : m.quota ? t('seeAIQuota') : m.net ? t('seeAINet') : String(m.error).slice(0, 160);
    status('seeAI', () => (why == null ? t('seeAINoToken') : fill(t('seeAIFail'), { e: why })), true);
    if (why == null) paintKeyRow();
    return;
  }
  const seen = parseAnalysis(String(m.text || ''), TYPES, OPTIONS);
  if (!seen) { status('seeAI', () => fill(t('seeAIFail'), { e: t('seeAIUnreadable') }), true); return; }
  keyBad = false;
  state.aiSeen = { ...seen, photo: photoJob, model: m.model };
  applyAISeen(state.aiSeen);
  if (state.cut) state.wantFit = true; // the piece as read is matched to the photo again
  status('seeAI', () => fill(t('seeAIDone'), { d: seenSummary(seen) }));
  paintKeyRow();
  paintAnalysis();
  renderForm();
  scheduleBuild();
};

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
  const el = where === 'see' ? $('#seeState') : where === 'seeAI' ? $('#seeAIState') : where === 'judge' ? $('#judgeState') :  where === 'fit' ? $('#fitState') : where === 'ai' ? $('#aiState') : $('#buildState');
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
  paintAnalysis();
  paintStatus('seeAI');
  paintStatus('build');
  paintStatus('fit');
  paintStatus('ai');
  paintCands();
  paintStatus('judge');
  paintJudge();
  $('#dragOut').title = t('dragTip');
  showSense();
  paintViewNote();
  $('#view').setAttribute('aria-label', t('view3d'));
  $('#type').setAttribute('aria-label', t('type'));
  $('#seeBar').setAttribute('aria-label', t('seeLoading'));
}

// what the user sees, edits included, in one white material -> { blob, filename } or null
async function modelBlob(kind) {
  if (!doc || !doc.parts.some((p) => p.visible)) return null;
  const kinds = new Set(doc.parts.filter((p) => p.visible).map((p) => p.kind));
  const name = kinds.has('lite') ? 'AIM rough draft' : state.type === 'ai' ? `AIM ${state.aiEngine || 'AI'}` : `AIM ${TYPE_T[state.type][1]}`;
  const items = doc.exportItems().map((it) => ({ ...it, color: [242, 242, 242], materialName: 'AIM white' }));
  const blob = kind === 'glb' ? await toGLB(items, name) : toDAE(items, name);
  for (const it of items) it.geometry.dispose();
  return { blob, filename: `${name.replace(/[\s:/\\]+/g, '-')}.${kind}` };
}
async function exportAs(kind) {
  const r = await modelBlob(kind);
  if (r) download(r.blob, r.filename);
}
// Dragging the model out: a drag must carry its file at once, so the GLB is kept ready (made again shortly after
// each change). Chromium (Chrome, Edge) writes a DownloadURL drag where it is dropped; elsewhere the button
// downloads the file instead.
let dragFile = null;
let dragTimer = 0;
let dragGen = 0;
function prepareDrag() {
  clearTimeout(dragTimer);
  const gen = ++dragGen;
  // the old file goes at once: until the new one is ready the button waits rather than carry the old model
  if (dragFile) URL.revokeObjectURL(dragFile.url);
  dragFile = null;
  $('#dragOut').classList.add('waiting');
  dragTimer = setTimeout(async () => {
    const r = await modelBlob('glb');
    if (gen !== dragGen) return; // changed again meanwhile
    dragFile = r ? { url: URL.createObjectURL(r.blob), name: r.filename } : null;
    $('#dragOut').hidden = !dragFile;
    $('#dragOut').classList.remove('waiting');
  }, 500);
}

// ---------------------------------------------------------------- AI pieces (free engines on Hugging Face)
// Inside SketchUp the extension runs the engines (it keeps the Hugging Face token); on the website the browser asks
// the Spaces itself. "Best of the engines" runs them one after another, scores each model by how its outline covers
// the photo's cut-out (the fitter, proportions locked) and keeps the closest, with the overlays side by side.
function showAI() {
  renderActions('none');
  if (!state.aiRaw) { clearDoc(); state.parts = []; setItems([]); $('#dims').hidden = true; status('build', ''); return false; }
  // size: what the user typed, else the AI's estimate of this photo's object, else 100 cm high (a photo has no scale)
  const seen = state.aiSeen && state.aiSeen.photo === photoJob && state.aiSeen.size;
  const part = sized(state.aiRaw, typedDims(), seen ? seen.h : 100);
  state.sizeIsEstimate = !Object.values(typedDims()).some((v) => v > 0);
  state.sizeSource = state.sizeIsEstimate ? (seen ? 'ai' : 'default') : 'user';
  // one part per connected piece, so each can be moved, turned or cut on its own
  const pieces = splitPieces(part.pos, part.tris, 20);
  const parts = pieces.length > 1 && pieces.length <= 60
    ? pieces.map((m, k) => ({ name: `${t('aiPiece')} ${k + 1}`, role: null, pos: m.pos, tris: m.tris }))
    : [{ ...part, name: t('aiObject') }];
  state.parts = parts;
  setItems(viewer.makeItems(parts));
  loadDoc(state.aiRaw.lite ? state.items.map((it) => ({ ...it, kind: 'lite' })) : state.items, 'ai', true);
  state.aiDocFor = state.aiRaw;
  showDims();
  status('build', () => fill(t('built'), { n: nf(parts.length), t: nf(part.tris.length / 3) }) + (state.sizeIsEstimate ? ` ${t('sizeEstimate')}` : ''));
  return true;
}
// one measurement the user knows scales the whole model (as built, edits included) so that side has its length
function resizeAI() {
  const typed = typedDims();
  const b = doc.bounds(true);
  const have = { w: b.max.x - b.min.x, d: b.max.y - b.min.y, h: b.max.z - b.min.z };
  const key = typed.w ? 'w' : typed.d ? 'd' : typed.h ? 'h' : null;
  if (!key || !(have[key] > 0)) return true;
  const k = typed[key] / have[key];
  if (Math.abs(k - 1) < 1e-4) return true;
  history.record(doc, 'size', () => doc.scaleAll(k), { merge: true });
  state.sizeIsEstimate = false;
  state.sizeSource = 'user';
  editor.refresh();
  showDims();
  prepareDrag();
  return true;
}
let aiRun = 0; // the current request (one model, or the best of the engines): a newer one or Stop silences the older
let aiJob = 0; // one engine run carried by the extension
let aiChunks = [];
let aiWebAbort = null;
const aiPending = new Map(); // extension job -> { resolve, reject, onStatus }
const relayAI = () => !!(window.sketchup && window.sketchup.aim3d_ai_start);
const hasHFToken = () => (relayAI() ? !!(host && host.has_token) : !!store.get('hf'));
const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
const aiBusyNow = () => $('#aiMake').disabled || $('#aiLite').disabled;
function aiBusy(on) { $('#aiMake').disabled = on; $('#aiBest').disabled = on; $('#aiCancel').hidden = !on; }
const viewBlobs = () => (['back', 'left', 'right'].some((k) => state.views[k]) ? { ...state.views } : null);
// One model: from one engine (only) or the first engine of the chain that delivers. Resolves { glb, engine }.
async function runEngines({ image, views = null, engine = '', only = false, onStatus = () => {} }) {
  if (relayAI()) {
    const v = {};
    for (const k of ['back', 'left', 'right']) if (views && views[k]) v[k] = await blobToDataURL(views[k]);
    const photo = await blobToDataURL(image);
    const id = ++aiJob;
    aiChunks = [];
    return new Promise((resolve, reject) => {
      aiPending.set(id, { resolve, reject, onStatus });
      window.sketchup.aim3d_ai_start(JSON.stringify({ job: id, image: photo, views: v, engine, only, quality: state.quality, ...(window.__aiOpts || {}) }));
    });
  }
  if (!aiWebAbort) aiWebAbort = new AbortController();
  return makeModel({
    image, views, engine, only, token: store.get('hf') || '', quality: state.quality, signal: aiWebAbort.signal, ...(window.__aiOpts || {}),
    onStatus: (step, name) => onStatus(fill(t(`aiStep_${step}`), { e: name })),
  });
}
const quotaNote = () => t(hasHFToken() ? 'aiQuotaToken' : 'aiQuota');
// the engines' buttons are off while one works; the local draft stays reachable (it stops them)
const aiFailText = (e) => fill(t('aiFailAll'), { e: e.message }) + (e.token ? t('aiToken') : e.quota ? quotaNote() : '');
async function makeAI() {
  if (!state.photo) { status('ai', () => t('aiNeedPhoto'), true); return; }
  const run = ++aiRun;
  const photo = photoJob;
  aiBusy(true);
  state.aiCands = [];
  paintCands();
  try {
    const views = viewBlobs();
    const image = await (await fetch(aiPhoto(!!views))).blob();
    const r = await runEngines({ image, views, onStatus: (text) => { if (run === aiRun) status('ai', () => text); } });
    if (run === aiRun && photo === photoJob) await gotModel(r.glb, r.engine, () => run === aiRun && photo === photoJob);
  } catch (e) {
    if (run === aiRun && photo === photoJob && e.name !== 'AbortError') {
      aiBusy(false);
      // no free engine could make it: the local draft does, at once
      if (state.cut && state.cut.mask) makeLite(t('liteFallback'));
      else status('ai', () => aiFailText(e), true);
    }
  } finally {
    if (run === aiRun) aiBusy(false);
  }
}
// current(): still the run and the photo it was made for (parsing takes a moment; Stop or a new photo may come first)
async function gotModel(buffer, engine, current = () => true) {
  try {
    const raw = cleaned(toPart(await readGLB(buffer)));
    if (!current()) return false;
    state.aiRaw = raw;
    state.aiEngine = engine;
    status('ai', () => fill(t('aiDone'), { e: engine }));
    showAI();
    return true;
  } catch (err) {
    status('ai', () => fill(t('aiFail'), { e: err.message }), true);
    return false;
  }
}
// How the model's outline covers the photo's cut-out, its own proportions kept; the overlay for the side by side.
async function scoreAI(raw) {
  state.aiRaw = raw;
  showAI();
  await new Promise((r) => setTimeout(r, 40)); // the new model is painted before the search takes the thread
  if (!fitter) fitter = new Fitter(viewer.renderer);
  fitter.setModel(state.items);
  const r = fitter.fit(state.cut, { limits: { sy: [1, 1], sz: [1, 1] }, locked: { sy: true, sz: true } });
  if (!r) return { iou: 0, img: null };
  return { iou: r.iou, img: fitter.compare(state.photoCanvas, state.cut, r).toDataURL('image/jpeg', 0.8) };
}
async function bestOf() {
  if (!state.photo) { status('ai', () => t('aiNeedPhoto'), true); return; }
  if (!state.cut || !state.cut.mask || !viewer || !viewer.ok) { status('ai', () => t('aiBestNoCut'), true); return; }
  const run = ++aiRun;
  const photo = photoJob;
  aiBusy(true);
  const views = viewBlobs();
  // TRELLIS.2 reserves more free GPU time than an anonymous visitor has: it joins with a token
  const list = engineQueue({ views }).filter((s) => s.id !== 'trellis2' || hasHFToken());
  const cands = state.aiCands = [];
  state.aiPick = -1;
  paintCands();
  try {
    const image = await (await fetch(aiPhoto(!!views))).blob();
    for (let i = 0; i < list.length; i++) {
      if (run !== aiRun || photo !== photoJob) return; // stopped, or a new photo: no further upload
      const s = list[i];
      const c = { engine: s.name };
      cands.push(c);
      paintCands();
      const say = (text) => { if (run === aiRun) status('ai', () => fill(t('aiBestStep'), { i: nf(i + 1), n: nf(list.length), s: text })); };
      say(fill(t('aiStep_connect'), { e: s.name }));
      try {
        const r = await runEngines({ image, views: s.views ? views : null, engine: s.id, only: true, onStatus: say });
        if (run !== aiRun || photo !== photoJob) return;
        c.raw = cleaned(toPart(await readGLB(r.glb)));
        if (run !== aiRun || photo !== photoJob) return;
        say(fill(t('aiBestScoring'), { e: s.name }));
        Object.assign(c, await scoreAI(c.raw));
      } catch (e) {
        if (e.name === 'AbortError' || run !== aiRun) return;
        // the reason alone: the card already names the engine
        const why = (e.tried && e.tried[0] && e.tried[0].error) || String(e.message).replace(/^No free AI could make the model now\.\s*/, '');
        c.error = e.quota ? t('aiBestQuota') : why.replace(new RegExp(`^${s.name.replace(/[.]/g, '\\.')}:\\s*`), '').slice(0, 140);
        if (e.token) { paintCands(); break; } // a wrong token is wrong for every engine
      }
      paintCands();
    }
    const ok = cands.filter((c) => c.raw);
    if (!ok.length) {
      aiBusy(false);
      if (state.cut && state.cut.mask) { makeLite(t('liteFallback')); return; }
      status('ai', () => t('aiBestNone') + (cands.some((c) => c.error === t('aiBestQuota')) ? quotaNote() : ''), true);
      state.aiRaw = null; showAI();
      return;
    }
    const best = ok.reduce((a, b) => (b.iou > a.iou ? b : a));
    useCand(cands.indexOf(best));
    status('ai', () => fill(t('aiBestDone'), { e: best.engine, p: nf(Math.round(best.iou * 100)), n: nf(ok.length), m: nf(cands.length) }));
  } finally {
    if (run === aiRun) aiBusy(false);
  }
}
function useCand(i) {
  const c = (state.aiCands || [])[i];
  if (!c || !c.raw) return;
  state.aiRaw = c.raw;
  state.aiEngine = c.engine;
  state.aiPick = i;
  showAI();
  paintCands();
}
function paintCands() {
  const box = $('#aiResults');
  const cands = state.aiCands || [];
  box.hidden = !cands.length;
  box.textContent = '';
  cands.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = `cand${state.aiPick === i ? ' on' : ''}`;
    if (c.img) { const im = new Image(); im.src = c.img; im.alt = ''; card.appendChild(im); }
    const p = document.createElement('p');
    p.textContent = c.raw ? (c.img ? fill(t('aiBestScore'), { e: c.engine, p: nf(Math.round(c.iou * 100)) }) : c.engine)
      : c.error ? `${c.engine}: ${c.error}` : fill(t('aiBestWorking'), { e: c.engine });
    if (c.error) p.className = 'bad';
    card.appendChild(p);
    if (c.raw) {
      const b = document.createElement('button');
      b.className = 'link'; b.type = 'button';
      b.textContent = t(state.aiPick === i ? 'aiBestUsing' : 'aiBestUse');
      b.disabled = state.aiPick === i;
      b.addEventListener('click', () => useCand(i));
      card.appendChild(b);
    }
    box.appendChild(card);
  });
}
// ---- route P, the profile: a rotational object (vase, pot, bowl, bottle, round shade) revolved from the profile of its
// cut-out (profile.js). Local, exact for such objects when seen from the side, and the part keeps its profile, so it
// stays editable. The automatic route takes it only when the photo reading says the body is round in plan and the
// mask raises no doubt (symmetry, axis, tilt, cropping, gaps, handles, resolution); a square pot has a symmetric
// outline too, so symmetry alone never decides. Pressed by hand it builds with the doubts shown as warnings.
// Hollow or solid comes from what the reading says about the top (or the kind of object), never from depth, and is
// one switch in the profile panel.
const HOLLOW_WORDS = /\b(vase|pot|planter|bowl|cup|mug|jar|urn|vessel|basket|bucket|glass|pitcher|jug|bottle|shade)s?\b/i;
const SOLID_WORDS = /\b(stool|seat|table|top|lid|cushion|pouf|ottoman|column|post)s?\b/i;
function hollowFor(seen) {
  if (!seen) return false;
  if (seen.opening === 'open' || seen.opening === 'narrow') return true;
  if (seen.opening === 'closed') return false;
  const words = `${seen.name} ${seen.nameAr}`;
  return HOLLOW_WORDS.test(words) && !SOLID_WORDS.test(words);
}
function makeProfile(auto = false) {
  const cut = state.cut;
  if (!cut || !cut.mask) { if (!auto) status('ai', () => t('liteNeedCut'), true); return false; }
  const seen = state.aiSeen && state.aiSeen.photo === photoJob ? state.aiSeen : null;
  if (auto && !(seen && seen.roundBody === 'yes')) return false; // the outline alone cannot tell round from square
  const typed = typedDims();
  const height = typed.h || (seen && seen.size && seen.size.h) || 40;
  // a rim seen from above is looked for when the top is known to be open (or, more strictly, when nothing is known)
  const open = !seen ? 'unknown' : seen.opening === 'open' ? 'open' : seen.opening === 'unknown' ? 'unknown' : 'none';
  const r = profileFromMask(cut.mask, cut.w, cut.h, { heightCm: height, strict: auto, open });
  if (!r || !r.points) {
    if (!auto) status('ai', () => fill(t('profileNo'), { s: nf(Math.round(((r && r.score) || 0) * 100)), why: whyList(r && r.reasons) }), true);
    return false;
  }
  const maxR = Math.max(...r.points.map((p) => p.r));
  const profile = {
    points: r.points, extracted: r.points.map((q) => ({ ...q })), outline: r.outline, locked: [], alt: r.alt,
    hollow: hollowFor(seen) || (!seen && r.camera.view === 'above'), // a rim seen from above is an open top
    wall: Math.max(0.4, Math.round(maxR * 0.06 * 10) / 10), segments: 64, camera: r.camera,
  };
  const mesh = revolve(profile.points, profile);
  const geometry = kitGeometry({ pos: mesh.pos, tris: mesh.tris });
  if (aiBusyNow()) cancelAI();
  state.aiRaw = { pos: mesh.pos, tris: mesh.tris, size: r.size };
  state.aiEngine = t('profileName');
  state.aiCands = []; paintCands();
  if (state.type !== 'ai') { state.type = 'ai'; renderForm(); }
  renderActions('none');
  setItems([{ name: t('profilePart'), role: null, geometry, color: [244, 244, 241] }]);
  loadDoc([{ name: t('profilePart'), geometry: geometry.clone(), kind: 'profile', params: { profile } }], 'ai', true);
  state.aiDocFor = state.aiRaw;
  state.sizeSource = typed.h ? 'user' : seen && seen.size && seen.size.h ? 'ai' : 'default';
  state.sizeIsEstimate = !typed.h;
  showDims();
  const warn = r.warnings.length ? ` ${fill(t('profileWarn'), { why: whyList(r.warnings) })}` : '';
  status('ai', () => fill(t(auto ? 'profileAuto' : 'profileDone'), { s: nf(Math.round(r.score * 100)), n: nf(r.points.length) }) + warn, r.warnings.length > 0);
  status('build', () => fill(t('built'), { n: nf(1), t: nf(mesh.tris.length / 3) }) + (state.sizeIsEstimate ? ` ${t('sizeEstimate')}` : ''));
  if (doc.parts[0]) editor.select([doc.parts[0].id]);
  paintProvenance();
  return true;
}
const whyList = (list) => (list || []).map((k) => t(`why_${k}`)).join(t('listSep'));

// ---- provenance: three separate things, each with where it came from; nothing unverified is shown as verified
//   geometry  how each part was made (rules / AI engine x / rough local draft / profile, side view assumed / opened)
//   size      typed by the user / AI estimate / a typical size
//   product   AI suggestion (recognised from the picture, not searched) / confirmed by the user / none
function provenance() {
  const kinds = doc ? [...new Set(doc.parts.map((p) => p.kind))] : [];
  const seen = state.aiSeen && state.aiSeen.photo === photoJob ? state.aiSeen : null;
  const named = !!(seen && seen.product && seen.productSure !== 'none');
  return {
    geometry: kinds, engine: kinds.includes('ai') ? state.aiEngine || '' : '',
    size: state.sizeSource || (state.sizeIsEstimate ? 'default' : 'user'),
    product: named ? (state.productConfirmed === photoJob ? 'user_verified' : 'ai_suggestion') : 'none',
    productName: named ? [seen.maker, seen.product].filter(Boolean).join(' — ') : '',
    camera: cameraOf(),
  };
}
function cameraOf() {
  const p = doc && doc.parts.find((q) => q.params && q.params.profile);
  if (!p) return 'unknown';
  const c = p.params.profile.camera;
  return c && c.view === 'above' ? `above_${c.elevDeg}` : 'side_view_assumed';
}
function paintProvenance() {
  const el = $('#provenance');
  if (!el) return;
  if (!doc || !doc.parts.length) { el.hidden = true; return; }
  const p = provenance();
  const how = p.geometry.map((k) => (k === 'ai' && p.engine ? `${t('kind_ai')} (${p.engine})` : t(`kind_${k}`))).join(t('listSep'));
  const bits = [fill(t('provGeometry'), { v: how }), fill(t('provSize'), { v: t(`size_${p.size}`) })];
  if (p.product !== 'none') bits.push(fill(t('provProduct'), { v: `${p.productName} — ${t(`product_${p.product}`)}` }));
  if (p.camera === 'side_view_assumed') bits.push(t('provCamera'));
  else if (p.camera.startsWith('above_')) bits.push(fill(t('provAbove'), { d: nf(Number(p.camera.slice(6))) }));
  el.textContent = bits.join(' · ');
  el.hidden = false;
}

// ---- the project file: save and open again with every part editable as it was (project.js)
function saveProject() {
  if (!doc || !doc.parts.length) return;
  const json = JSON.stringify(toProject(doc, provenance()));
  const name = (state.type === 'ai' ? `AIM ${state.aiEngine || 'model'}` : `AIM ${TYPE_T[state.type][1]}`).replace(/[\s:/\\]+/g, '-');
  download(new Blob([json], { type: 'application/json' }), `${name}.aim3d`);
  status('build', () => t('projectSaved'));
}
async function openProject(file) {
  let r;
  try { r = fromProject(await file.text()); } catch (e) { status('build', () => fill(t('projectBad'), { e: e.message }), true); return; }
  if (aiBusyNow()) cancelAI();
  history.adopt(doc);
  history.record(doc, 'open', () => {
    doc.parts = r.parts; doc.source = 'ai'; doc.edited = true; doc.version++;
    doc.frame = r.frame; doc.mirrorPlane = r.mirrorPlane; doc.pairs = r.pairs;
  });
  // the page shows it as an AI-type model: the form's options do not rebuild it; a typed size scales it
  state.type = 'ai'; state.typeByUser = true; renderForm();
  state.aiRaw = { project: true }; state.aiDocFor = state.aiRaw; state.aiEngine = t('projectName');
  state.sizeSource = r.provenance.size || 'default';
  setItems([]);
  editor.refresh(true);
  editor.select(doc.parts.length === 1 ? [doc.parts[0].id] : []);
  showDims();
  prepareDrag();
  paintProvenance();
  status('build', () => fill(t('projectOpened'), { n: nf(doc.parts.length) }));
}

// ---- the local draft: Depth Anything + inflation on this computer (lite.worker.js); no quota, rough
let liteWorker = null;
let liteJob = 0;
function makeLite(why = '') {
  if (!state.photo) { status('ai', () => t('aiNeedPhoto'), true); return; }
  if (!state.cut || !state.cut.mask) { status('ai', () => t('liteNeedCut'), true); return; }
  // the engines give way: the draft is what the user asked for now
  if (aiWebAbort) aiWebAbort.abort();
  aiWebAbort = null;
  if (window.sketchup && window.sketchup.aim3d_ai_cancel) window.sketchup.aim3d_ai_cancel('{}');
  const run = ++aiRun;
  const photo = photoJob;
  aiBusy(true);
  $('#aiLite').disabled = true;
  if (!liteWorker) liteWorker = new Worker(new URL('./lite.worker.js', import.meta.url), { type: 'module' });
  const job = ++liteJob;
  const prefix = why ? `${why} ` : '';
  status('ai', () => prefix + t('liteWorking'));
  liteWorker.onmessage = (e) => {
    const m = e.data;
    if (m.job !== liteJob || run !== aiRun || photo !== photoJob) return;
    if (m.status === 'download') { status('ai', () => prefix + fill(t('liteDownload'), { p: nf(Math.round(m.loaded / m.total * 100)) })); return; }
    if (m.status === 'depth') { status('ai', () => prefix + t('liteDepth')); return; }
    aiBusy(false);
    $('#aiLite').disabled = false;
    if (m.status === 'error') { status('ai', () => fill(t('liteFail'), { e: m.error }), true); return; }
    // a furniture type the user picked meanwhile stays: the draft is not forced on it
    if (state.typeByUser && state.type !== 'ai') return;
    state.aiRaw = { pos: m.pos, tris: m.tris, size: m.size, lite: true };
    state.aiEngine = t('liteName');
    state.aiCands = []; paintCands();
    if (state.type !== 'ai') { state.type = 'ai'; renderForm(); }
    showAI();
    status('ai', () => prefix + t('liteDone'));
  };
  const big = state.photoBig || state.photoCanvas;
  createImageBitmap(big).then((bitmap) => {
    const cut = state.cut;
    liteWorker.postMessage({ job, bitmap, mask: cut.mask, mw: cut.w, mh: cut.h, grid: state.quality === 'high' ? 224 : 160 }, [bitmap]);
  });
}

// ---- more photos of the same piece: three slots, or four frames from a turntable video
function setView(side, blob) {
  if (state.viewUrls[side]) URL.revokeObjectURL(state.viewUrls[side]);
  state.views[side] = blob || null;
  state.viewUrls[side] = blob ? URL.createObjectURL(blob) : null;
  paintViews();
}
function paintViews() {
  let any = false;
  for (const side of ['back', 'left', 'right']) {
    const slot = document.querySelector(`.slot[data-side="${side}"]`);
    const img = slot.querySelector('img');
    img.hidden = !state.viewUrls[side];
    if (state.viewUrls[side]) img.src = state.viewUrls[side]; else img.removeAttribute('src');
    slot.classList.toggle('has', !!state.views[side]);
    any = any || !!state.views[side];
  }
  $('#swapLR').hidden = !(state.views.left || state.views.right);
  $('#clearViews').hidden = !any;
}
// The turntable's quarter turns: the start is the front, half way the back, the quarters the sides (which side comes
// first depends on the turn's direction: the user can swap them).
async function framesFromVideo(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('video')); setTimeout(() => rej(new Error('video')), 20000); });
    let dur = v.duration;
    if (!Number.isFinite(dur)) {
      // a recorded WebM often has no length written in it: seeking far past the end makes the browser find it
      await new Promise((res) => { v.ondurationchange = res; v.onseeked = res; setTimeout(res, 5000); v.currentTime = 1e101; });
      dur = v.duration;
    }
    if (!Number.isFinite(dur) || dur <= 0.2) throw new Error('video');
    const grab = async (time) => {
      await new Promise((res) => { v.onseeked = res; v.currentTime = Math.max(0, Math.min(dur - 0.05, time)); });
      const k = Math.min(1, 1024 / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(8, Math.round(v.videoWidth * k)); c.height = Math.max(8, Math.round(v.videoHeight * k));
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
    };
    const front = await grab(0.05);
    const left = await grab(dur * 0.25);
    const back = await grab(dur * 0.5);
    const right = await grab(dur * 0.75);
    return { front, back, left, right };
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function takeVideo(file) {
  if (!file) return;
  status('ai', () => t('videoReading'));
  try {
    const f = await framesFromVideo(file);
    // a new main photo clears the extra ones, so the video's front goes in first
    if (!state.photo) await takePhoto(new File([f.front], 'video-front.jpg', { type: 'image/jpeg' }));
    setView('back', f.back); setView('left', f.left); setView('right', f.right);
    status('ai', () => t('videoDone'));
  } catch (e) {
    status('ai', () => t('videoBad'), true);
  }
}
// What the AI is sent: the photo at up to 1024 px (not the 512 px working copy). When the piece is already cut out,
// only the piece on a transparent background, framed with a margin: the Spaces then skip their own background
// removal, which takes a glossy floor's reflection or the room around it for part of the piece.
function aiPhoto(plain = false) {
  const big = state.photoBig || state.photoCanvas;
  const k = Math.min(1, 1024 / Math.max(big.width, big.height));
  const W = Math.round(big.width * k); const H = Math.round(big.height * k);
  const cut = state.cut;
  // plain: with more photos of the piece the Space cuts all of them out the same way
  if (plain || !cut || !cut.mask || cut.source === 'none' || window.__aiNoCut) { // __aiNoCut: the tests compare with the plain photo
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    c.getContext('2d').drawImage(big, 0, 0, W, H);
    return c.toDataURL('image/jpeg', 0.92);
  }
  // the mask, scaled up smoothly, becomes the alpha (soft edge instead of mask-sized steps)
  const mc = document.createElement('canvas'); mc.width = cut.w; mc.height = cut.h;
  const mx = mc.getContext('2d'); const md = mx.createImageData(cut.w, cut.h);
  let x0 = cut.w; let y0 = cut.h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < cut.h; y++) {
    for (let x = 0; x < cut.w; x++) {
      if (cut.mask[y * cut.w + x] !== 1) continue;
      md.data[(y * cut.w + x) * 4 + 3] = 255;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) { state.cut = null; const r = aiPhoto(); state.cut = cut; return r; }
  mx.putImageData(md, 0, 0);
  const full = document.createElement('canvas'); full.width = W; full.height = H;
  const fx = full.getContext('2d');
  fx.imageSmoothingEnabled = true; fx.imageSmoothingQuality = 'high';
  fx.drawImage(mc, 0, 0, W, H);
  fx.globalCompositeOperation = 'source-in';
  fx.drawImage(big, 0, 0, W, H);
  // framed around the piece: a square with 8 % margin, the way the Spaces expect an object photo
  const sx = W / cut.w; const sy = H / cut.h;
  const bw = (x1 - x0 + 1) * sx; const bh = (y1 - y0 + 1) * sy;
  const side = Math.round(Math.max(bw, bh) * 1.16);
  const out = document.createElement('canvas'); out.width = side; out.height = side;
  out.getContext('2d').drawImage(full, x0 * sx, y0 * sy, bw, bh, (side - bw) / 2, (side - bh) / 2, bw, bh);
  return out.toDataURL('image/png');
}
// the extension's replies for one engine run (aim3dAI): progress, the GLB in pieces, the end
window.aim3dAI = (m) => {
  const p = m && aiPending.get(m.job);
  if (!p) return;
  if (m.status === 'working') p.onStatus(m.text);
  else if (m.status === 'chunk') { aiChunks[m.index] = m.data; p.onStatus(fill(t('aiReceiving'), { p: nf(Math.round((m.index + 1) / m.count * 100)) })); }
  else if (m.status === 'error') {
    aiPending.delete(m.job);
    // the page says "no free AI could…" in the user's language: the extension's English opening is dropped
    const e = new Error(String(m.error || 'error').replace(/^No free AI could make the model now\.\s*/, ''));
    e.quota = !!m.quota;
    e.token = /token \(401\)/i.test(e.message);
    p.reject(e);
  } else if (m.status === 'done') {
    aiPending.delete(m.job);
    const bin = atob(aiChunks.join(''));
    aiChunks = [];
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    p.resolve({ glb: bytes.buffer, engine: m.engine });
  }
};
function cancelAI() {
  aiRun++;
  if (aiWebAbort) aiWebAbort.abort();
  aiWebAbort = null;
  const stopped = Object.assign(new Error('stopped'), { name: 'AbortError' });
  for (const p of aiPending.values()) p.reject(stopped);
  aiPending.clear();
  if (window.sketchup && window.sketchup.aim3d_ai_cancel) window.sketchup.aim3d_ai_cancel('{}');
  liteJob++;
  $('#aiLite').disabled = false;
  aiBusy(false);
  status('ai', '');
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
  const id = ++maskJob;
  maskTarget = null;
  postMask(id, canvas, () => photoId === photoJob);
}
let maskTarget = null; // set when the cut-out is of a selected box
let maskBusy = false;
// A download that stalls (seen once in SketchUp, on the first fetch of the model in a session) never ends by itself: a
// worker silent for 90 s is replaced and the job sent again once, then the page says so instead of waiting forever.
let maskWatch = null;
let maskRetry = null;
const MASK_SILENCE = Number(new URLSearchParams(location.search).get('maskSilence')) || 90000; // the parameter is for the tests
function newMaskWorker() {
  maskWorker = new Worker(new URL('./mask.worker.js', import.meta.url), { type: 'module' });
  maskWorker.onmessage = (e) => { onMask(e.data); watchMask(); };
  maskWorker.onerror = (e) => onMask({ job: maskJob, status: 'error', error: e.message || 'worker' });
}
function watchMask() {
  clearTimeout(maskWatch);
  if (maskBusy) maskWatch = setTimeout(maskStalled, MASK_SILENCE);
}
function maskStalled() {
  if (!maskBusy) return;
  maskWorker.terminate(); maskWorker = null; maskBusy = false;
  const retry = maskRetry; maskRetry = null;
  if (retry) retry();
  else onMask({ job: maskJob, status: 'error', error: t('cutStalled') });
}
function postMask(id, src, still = () => true) {
  if (!maskWorker) newMaskWorker();
  const send = (again) => createImageBitmap(src).then((bm) => {
    if (id !== maskJob || !still()) { bm.close(); return; }
    if (!maskWorker) newMaskWorker();
    maskRetry = again ? () => send(false) : null;
    maskBusy = true;
    maskWorker.postMessage({ job: id, bitmap: bm }, [bm]);
    watchMask();
  });
  send(true);
}
function onMask(m) {
  if (m.status === 'done' || m.status === 'error') { maskBusy = false; maskRetry = null; clearTimeout(maskWatch); }
  if (m.job !== maskJob) return;
  if (m.status === 'cutting' || m.status === 'loading') status('fit', () => t('cutting'));
  else if (m.status === 'download') status('fit', () => fill(t('cutDownload'), { a: nf(Math.round(m.loaded / 1e6)), b: nf(Math.round(m.total / 1e6)) }));
  else if (m.status === 'error') status('fit', () => fill(t('cutFail'), { e: m.error }), true);
  else if (m.status === 'done') {
    state.cut = maskTarget ? boxCut(m.mask, m.w, m.h, maskTarget) : { mask: clean(m.mask, m.w, m.h), w: m.w, h: m.h, source: 'ISNet' };
    status('fit', '');
    if (state.wantFit && state.parts) runFit();
  }
}

// The selected box (photo fractions) cut out on its own: the box padded 20 % gives the cut-out model the room around
// the piece; the mask is put back into the whole photo, clipped to the box (outside it is background).
function cutBox(box) {
  const W = state.photoCanvas.width; const H = state.photoCanvas.height;
  const bx = { x: box.x * W, y: box.y * H, w: box.w * W, h: box.h * H };
  const pad = 0.2 * Math.max(bx.w, bx.h);
  const pr = { x: Math.max(0, Math.floor(bx.x - pad)), y: Math.max(0, Math.floor(bx.y - pad)) };
  pr.w = Math.min(W, Math.ceil(bx.x + bx.w + pad)) - pr.x;
  pr.h = Math.min(H, Math.ceil(bx.y + bx.h + pad)) - pr.y;
  const big = state.photoBig || state.photoCanvas;
  const s = big.width / W;
  const crop = document.createElement('canvas');
  const kc = Math.min(1, 1024 / Math.max(pr.w * s, pr.h * s));
  crop.width = Math.max(8, Math.round(pr.w * s * kc));
  crop.height = Math.max(8, Math.round(pr.h * s * kc));
  crop.getContext('2d').drawImage(big, pr.x * s, pr.y * s, pr.w * s, pr.h * s, 0, 0, crop.width, crop.height);
  const target = { W, H, pr, bx, cw: crop.width, ch: crop.height };
  state.cut = null; state.fitResult = null; state.partColors = null; state.fitDims = null; $('#compare').hidden = true; $('#exactAI').hidden = true;
  const cpx = crop.getContext('2d').getImageData(0, 0, crop.width, crop.height).data;
  const plain = plainCutout(cpx, crop.width, crop.height);
  if (plain) state.cut = boxCut(plain.mask, crop.width, crop.height, target);
  else {
    if (maskWorker && maskBusy) { maskWorker.terminate(); maskWorker = null; maskBusy = false; clearTimeout(maskWatch); }
    const id = ++maskJob;
    maskTarget = target;
    postMask(id, crop);
  }
  // the selected piece is recognised on its own
  createImageBitmap(crop).then((bm) => recognise(bm));
  if (seeOn()) readDetails(crop);
  state.typeByUser = false;
  state.wantFit = true;
}

function boxCut(mask, cw, ch, t) {
  const m = new Uint8Array(t.W * t.H);
  for (let y = Math.floor(t.bx.y); y < Math.min(t.H, Math.ceil(t.bx.y + t.bx.h)); y++) {
    for (let x = Math.floor(t.bx.x); x < Math.min(t.W, Math.ceil(t.bx.x + t.bx.w)); x++) {
      const cx = Math.min(cw - 1, Math.floor((x + 0.5 - t.pr.x) / t.pr.w * cw));
      const cy = Math.min(ch - 1, Math.floor((y + 0.5 - t.pr.y) / t.pr.h * ch));
      m[y * t.W + x] = mask[cy * cw + cx];
    }
  }
  return { mask: clean(m, t.W, t.H), w: t.W, h: t.H, roi: t.pr, box: t.bx, source: 'box' };
}

// the box drawn by dragging over the photo in the stage
let boxDrag = null;
function openBoxView() {
  if (!state.photoCanvas) return;
  $('#boxImg').src = state.photoCanvas.toDataURL('image/jpeg', 0.9);
  $('#boxView').hidden = false;
  $('#boxRect').hidden = true;
  $('#useBox').disabled = true;
  boxDrag = null;
}
function boxPoint(e) {
  const r = $('#boxImg').getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
}
function drawBox() {
  if (!boxDrag) return;
  const r = $('#boxImg').getBoundingClientRect(); const pr = $('#boxView').getBoundingClientRect();
  const x0 = Math.min(boxDrag.a.x, boxDrag.b.x); const y0 = Math.min(boxDrag.a.y, boxDrag.b.y);
  const el = $('#boxRect');
  el.hidden = false;
  el.style.left = `${r.left - pr.left + x0 * r.width}px`; el.style.top = `${r.top - pr.top + y0 * r.height}px`;
  el.style.width = `${Math.abs(boxDrag.b.x - boxDrag.a.x) * r.width}px`; el.style.height = `${Math.abs(boxDrag.b.y - boxDrag.a.y) * r.height}px`;
  $('#useBox').disabled = Math.abs(boxDrag.b.x - boxDrag.a.x) < 0.03 || Math.abs(boxDrag.b.y - boxDrag.a.y) < 0.03;
}
function useBox() {
  if (!boxDrag) return;
  const box = { x: Math.min(boxDrag.a.x, boxDrag.b.x), y: Math.min(boxDrag.a.y, boxDrag.b.y), w: Math.abs(boxDrag.b.x - boxDrag.a.x), h: Math.abs(boxDrag.b.y - boxDrag.a.y) };
  $('#boxView').hidden = true;
  state.box = box;
  status('fit', () => t('boxed'));
  cutBox(box);
}

// a note next to the sizes the photo cannot tell
function showSense() {
  const s = state.sense;
  let notes = [];
  const typedAny = Number(state.w) > 0 || Number(state.d) > 0 || Number(state.h) > 0;
  if (s && s.sx < 0.02 && s.sy < 0.02 && s.sz < 0.02 && !typedAny) {
    notes = [t('senseAll')]; // nothing stands out: one plain sentence instead of three
  } else {
    if (s && s.sx < 0.02 && !(Number(state.w) > 0)) notes.push(t('senseW'));
    if (s && s.sy < 0.02 && !(Number(state.d) > 0)) notes.push(t('senseD'));
    if (s && s.sz < 0.02 && !(Number(state.h) > 0)) notes.push(t('senseH'));
  }
  const el = $('#senseNote');
  el.textContent = notes.join(' ');
  el.hidden = !notes.length;
}

// what colour each part gets: its own colour from the photo when the fit measured it, else the photo palette's
function colourOfPart(p) {
  if (state.colour !== 'photo' || !state.pal) return null;
  return (state.partColors && state.partColors[p.name]) || roleColour(state.pal, p.role);
}

let fitter = null;
let fitting = false;
const typedDims = () => ({ w: Number(state.w) || 0, d: Number(state.d) || 0, h: Number(state.h) || 0 });

// Two passes: proportions and camera on the current build, then a refinement on the rebuilt piece.
// Options that change the outline (a table's top, a bed's outline): when the photo, not the user, chose them, the
// outline gets a say. Each choice is built and fitted the full way (sizes and camera); another one is kept only when
// area and outline together (IoU + edge F-score) are clearly better and the area is not worse; the page says so.
// Once per photo.
const SHAPE_KEYS = { table: ['top'], coffee_table: ['top'], bed: ['outline'] };
async function chooseShape(type) {
  const keys = (SHAPE_KEYS[type] || []).filter((k) => OPTIONS[type][k] && !((state.userSet[type] || {})[k]));
  const notes = [];
  for (const k of keys) {
    const cur = optionsFor(type, state.vals[type] || {})[k];
    const scores = [];
    for (const v of OPTIONS[type][k]) {
      state.vals[type] = { ...(state.vals[type] || {}), [k]: v };
      state.fitDims = null;
      clearTimeout(buildTimer);
      if (!(await rebuild())) continue;
      const q = await fitPasses(type); // the same fit the chosen one gets: sizes and camera, rebuilt
      scores.push({ v, iou: q ? q.iou : 0, edge: q ? fitter.edgeScore(state.cut, q) : 0 });
    }
    // area and outline together; another choice wins only by a clear margin and never by losing area
    const now = scores.find((x) => x.v === cur);
    const value = (x) => x.iou + x.edge;
    const best = scores.slice().sort((a, b) => value(b) - value(a))[0];
    const pick = best && now && best.v !== cur && value(best) >= value(now) + 0.05 && best.iou >= now.iou - 0.005 ? best.v : cur;
    state.vals[type] = { ...state.vals[type], [k]: pick };
    if (pick !== cur) notes.push({ k, from: cur, to: pick, a: now.iou, b: best.iou });
    state.shapeScores = { ...(state.shapeScores || {}), [k]: scores };
  }
  state.fitDims = null;
  clearTimeout(buildTimer);
  await rebuild();
  if (notes.length) renderForm();
  return notes;
}

async function runFit() {
  if (fitting || !state.cut || !viewer || !viewer.ok || !state.items.length || state.type === 'ai') return;
  fitting = true;
  state.wantFit = false;
  try {
    status('fit', () => t('fitting'));
    await new Promise((r) => setTimeout(r, 40)); // the message is painted before the search takes the thread
    if (!fitter) fitter = new Fitter(viewer.renderer);
    const type = state.type;
    let shapeNotes = [];
    if (state.shapeFor !== photoJob) { state.shapeFor = photoJob; shapeNotes = await chooseShape(type); }
    const last = await fitPasses(type);
    if (last) {
      state.fitResult = last;
      state.sense = fitter.sensitivity(state.cut, last);
      showSense();
      state.partColors = fitter.partColours(state.photoCanvas, state.cut, last);
      const pc = Math.round(last.iou * 100);
      const shapeSaid = shapeNotes.map((n) => fill(t('shapeChosen'), { o: optLabel(n.k), a: valLabel(n.k, n.from), b: valLabel(n.k, n.to), x: nf(Math.round(n.a * 100)), y: nf(Math.round(n.b * 100)) })).join(' ');
      status('fit', () => fill(t(pc >= 70 ? 'fitted' : 'fittedLow'), { p: nf(pc) }) + (shapeSaid ? ` ${shapeSaid}` : ''), pc < 70);
      $('#compare').hidden = false;
      // the fitted model is a close match of its kind; the AI copies the photo's own shape (folds, heaps) as one mesh
      $('#exactAI').hidden = false;
      $('#judge').hidden = false;
      maybeAutoJudge();
    }
  } catch (err) {
    status('fit', () => fill(t('cutFail'), { e: err.message }), true);
  } finally {
    fitting = false;
    // the builds during the fit skipped the physics the new looks need: it runs now, on the fitted piece
    const req = request();
    if (!state.sims && needsPhysics(req) && autoSimFor !== keyOf(req)) { autoSimFor = keyOf(req); setTimeout(settle, 50); }
  }
}
// the size passes: fit the camera and proportions, rebuild at those sizes, again until nothing changes; then the
// final fit at the built size. -> that fit ({ iou, ... }) or null
async function fitPasses(type) {
  {
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
    if (!p) return null;
    fitter.setModel(state.items);
    return fitter.fit(state.cut, { limits: { sy: [1, 1], sz: [1, 1] }, locked: { sy: true, sz: true }, start: { ...p, sy: 1, sz: 1 } });
  }
}

// ---------------------------------------------------------------- the AI compares the model with the photo (judge)
// Render and compare: the photo and a grey render of the fitted model from the same camera, cropped alike, go to the
// vision model with the current options; options the photo clearly contradicts are changed (never the user's own),
// the piece is rebuilt and matched again, and a second round checks the result. A value once replaced is not offered
// again, so the loop cannot swing back and forth. The outline is the referee: a round whose changes take the model's
// outline further from the photo (by more than JUDGE_SLACK) is undone and its values ruled out (2026-11-20, studio
// frame: round 2 turned the piled throw into a heap and the match fell 1.1-1.2 points, twice). The outline moves by
// about a point between rebuilds of nearly the same piece (test/depth/README.md), so the slack is one point: it is a
// coarse referee. The finer one is agreement: each round asks twice, with a tight and a wide crop, and only changes
// both answers name are made (the judge was steady on the pillow count and wavered on the throw: pile, diagonal, heap).
// Runs by itself once per photo when "read the details" is on.
const JUDGE_SLACK = 0.01;
let judgeRun = 0;
let judgeJob = 1000000; // the extension's job numbers for the judge, apart from the reading's
let judging = false;
const seePending = new Map();
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(test, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (test()) return true; await sleepMs(250); }
  return false;
}
// one vision request on the judge's channel: the extension carries it inside SketchUp, the browser asks on the website
function askVision(body, signal) {
  if (relay()) {
    const id = ++judgeJob;
    return new Promise((resolve, reject) => {
      seePending.set(id, { resolve, reject });
      window.sketchup.aim3d_see(JSON.stringify({ job: id, body, models: GEMINI_MODELS, channel: 'judge' }));
    });
  }
  const url = new URLSearchParams(location.search).get('geminiUrl') || undefined;
  return askGemini(store.get('gemini'), body, { signal, url });
}
// the photo and the render, cropped to the piece (its cut-out's box with a margin, 12 % or more) at up to 768 px
function judgePictures(margin = 0.12) {
  const cut = state.cut;
  const big = state.photoBig || state.photoCanvas;
  const k = Math.min(1, 1024 / Math.max(big.width, big.height));
  const W = Math.round(big.width * k); const H = Math.round(big.height * k);
  const render = fitter.shaded({ width: W, height: H }, cut, state.fitResult);
  let x0 = cut.w; let y0 = cut.h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < cut.h; y++) {
    for (let x = 0; x < cut.w; x++) {
      if (cut.mask[y * cut.w + x] !== 1) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const sx = W / cut.w; const sy = H / cut.h;
  const mx = (x1 - x0 + 1) * sx * margin; const my = (y1 - y0 + 1) * sy * margin;
  const bx = Math.max(0, x0 * sx - mx); const by = Math.max(0, y0 * sy - my);
  const bw = Math.min(W, (x1 + 1) * sx + mx) - bx; const bh = Math.min(H, (y1 + 1) * sy + my) - by;
  const crop = (src, sw, sh) => {
    const c = document.createElement('canvas');
    const s = Math.min(1, 768 / Math.max(bw, bh));
    c.width = Math.max(8, Math.round(bw * s)); c.height = Math.max(8, Math.round(bh * s));
    const f = sw / W;
    c.getContext('2d').drawImage(src, bx * f, by * (sh / H), bw * f, bh * (sh / H), 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.88);
  };
  return { photo: crop(big, big.width, big.height), render: crop(render, W, H) };
}
function undoJudge(done, tried) {
  const vals = state.vals[state.type] = state.vals[state.type] || {};
  for (const c of done) {
    vals[c.key] = c.from;
    (tried[c.key] = tried[c.key] || []).push(c.value); // the judge's value did not help: not offered again
  }
}
// The overlap of the piece as it stands now (after the fabric settled) with the photo: a local polish of the current
// fit, proportions kept. Before and after a round are measured this same way, so physics or a fresh search cannot pass
// for an effect of the change (2026-11-20: the fit's own figure was taken before the fabric settled).
async function measureNow() {
  await waitFor(() => !fitting && !physics.busy && !simFor, 180000);
  await sleepMs(300);
  if (!state.fitResult || !fitter || !state.items.length) return null;
  fitter.setModel(state.items);
  const r = fitter.fit(state.cut, { limits: { sy: [1, 1], sz: [1, 1] }, locked: { sy: true, sz: true }, start: { ...state.fitResult, sy: 1, sz: 1 } });
  return r ? r.iou : null;
}
// builds what changed, matches it to the photo again and lets the fabric settle; -> measureNow()
async function refitNow(alive) {
  const before = state.fitResult;
  renderForm();
  state.wantFit = true;
  scheduleBuild();
  await waitFor(() => !fitting && state.fitResult !== before, 180000);
  if (!alive()) return null;
  return measureNow();
}
function applyJudge(j, tried) {
  const type = state.type;
  const vals = state.vals[type] = state.vals[type] || {};
  const mine = state.userSet[type] || {};
  const cur = optionsFor(type, vals);
  const done = [];
  for (const c of j.changes) {
    if (mine[c.key] || cur[c.key] === c.value || (tried[c.key] || []).includes(c.value)) continue;
    (tried[c.key] = tried[c.key] || []).push(cur[c.key]); // the value it had is now ruled out
    done.push({ ...c, from: cur[c.key] });
    vals[c.key] = c.value;
    (state.fromPhoto[type] = state.fromPhoto[type] || {})[c.key] = true;
  }
  return done;
}
async function judgeModel({ rounds = 2 } = {}) {
  if (judging) return;
  if (!hasKey()) { status('judge', () => t('seeAINoToken'), true); return; }
  if (!state.fitResult || !state.cut || !state.cut.mask || state.type === 'ai' || !fitter) { status('judge', () => t('judgeNeedFit'), true); return; }
  judging = true;
  const run = ++judgeRun;
  const photo = photoJob;
  $('#judge').disabled = true;
  const tried = {};
  const log = [];
  state.judge = { photo, log, model: '' };
  paintJudge();
  const alive = () => run === judgeRun && photo === photoJob;
  try {
    for (let r = 1; r <= rounds; r++) {
      // the comparison waits for the fit and the fabric: the render must show the piece as it now stands
      if (fitting || physics.busy || simFor) status('judge', () => t('judgeWaiting'));
      await waitFor(() => !fitting && !physics.busy && !simFor, 180000);
      await sleepMs(300);
      if (!alive()) return;
      status('judge', () => fill(t('judgeWorking'), { r: nf(r) }));
      const type = state.type;
      const cur = optionsFor(type, state.vals[type] || {});
      const prompt = judgePrompt(type, OPTIONS, cur, (k) => TYPE_T[k][1], (k) => (OPT_T[k] ? OPT_T[k].en : k), optEn, tried);
      const schema = judgeSchema(type, OPTIONS);
      // two looks, one after the other (the extension keeps one judge request at a time): tight crop, then wide
      const views = [judgePictures(0.12), judgePictures(0.35)];
      const answers = [];
      for (const v of views) {
        const ans = await askVision(judgeBody(prompt, v.photo, v.render, schema));
        if (!alive()) return;
        answers.push({ ans, j: parseJudge(ans.text, type, OPTIONS) });
      }
      const ok = answers.filter((x) => x.j);
      if (!ok.length) throw new Error(t('seeAIUnreadable'));
      const [ja, jb] = [ok[0].j, ok[1] ? ok[1].j : null];
      // only what both looks name is changed; what one alone names is shown and left as it is
      const same = (c, d) => c.key === d.key && c.value === d.value;
      const agreed = jb ? ja.changes.filter((c) => jb.changes.some((d) => same(c, d))) : [];
      const single = ja.changes.concat(jb ? jb.changes : []).filter((c) => !agreed.some((d) => same(c, d)))
        .filter((c, i, all) => all.findIndex((d) => same(c, d)) === i);
      const j = { score: Math.round((ja.score + (jb ? jb.score : ja.score)) / 2), changes: agreed, diff: ja.diff || (jb && jb.diff) || '' };
      const ans = ok[0].ans;
      const iouBefore = (await measureNow()) || 0;
      if (!alive()) return;
      const done = applyJudge(j, tried);
      const entry = { round: r, score: j.score, diff: j.diff, done, before: iouBefore, single };
      log.push(entry);
      state.judge.model = ans.model;
      paintJudge();
      if (!done.length) break;
      // the outline decides whether the round's changes stay
      status('judge', () => fill(t('judgeRefit'), { r: nf(r) }));
      const after = await refitNow(alive);
      if (!alive()) return;
      entry.after = after;
      if (after != null && after < iouBefore - JUDGE_SLACK) {
        entry.undone = true;
        undoJudge(done, tried);
        paintJudge();
        status('judge', () => fill(t('judgeUndoing'), { r: nf(r) }));
        await refitNow(alive);
        if (!alive()) return;
        break;
      }
      paintJudge();
      if (j.score >= 9) break;
    }
    const kept = log.filter((l) => !l.undone).reduce((n, l) => n + l.done.length, 0);
    const last = log[log.length - 1];
    status('judge', () => fill(t('judgeDone'), { s: nf(last.score), c: kept ? fill(t('judgeChanged'), { n: nf(kept) }) : t('judgeNoChange') }));
  } catch (e) {
    if (alive() && e.name !== 'AbortError') {
      const why = e.kind === 'key' ? t('seeAIBadKey') : e.kind === 'quota' ? t('seeAIQuota') : e.kind === 'net' ? t('seeAINet') : String(e.message).slice(0, 160);
      status('judge', () => fill(t('judgeFail'), { e: why }), true);
    }
  } finally {
    if (run === judgeRun) { judging = false; $('#judge').disabled = false; }
  }
}
// once per photo, after the first fit that already has the AI's reading of the details
function maybeAutoJudge() {
  if (judging || !seeOn() || !hasKey() || state.type === 'ai') return;
  if (!state.aiSeen || state.aiSeen.photo !== photoJob || state.judgedFor === photoJob) return;
  state.judgedFor = photoJob;
  setTimeout(() => judgeModel(), 50);
}
function stopJudge() {
  judgeRun++;
  judging = false;
  $('#judge').disabled = false;
  for (const p of seePending.values()) p.reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
  seePending.clear();
  if (window.sketchup && window.sketchup.aim3d_see_cancel) window.sketchup.aim3d_see_cancel('judge');
}
function paintJudge() {
  const ul = $('#judgeList');
  const j = state.judge;
  ul.textContent = '';
  ul.hidden = !j || j.photo !== photoJob || !j.log.length;
  if (ul.hidden) return;
  const ar = lang === 'ar';
  for (const l of j.log) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = fill(t('judgeRound'), { r: nf(l.round), s: nf(l.score) });
    li.appendChild(b);
    const arrow = ar ? '←' : '→'; // from the old value to the new one, in the reading direction
    const parts = l.done.map((c) => `${optLabel(c.key)}: ${/^\d+$/.test(c.from) ? nf(Number(c.from)) : valLabel(c.key, c.from)} ${arrow} ${/^\d+$/.test(c.value) ? nf(Number(c.value)) : valLabel(c.key, c.value)}${ar && c.reason ? ` (${c.reason})` : ''}`);
    li.appendChild(document.createTextNode(` — ${parts.length ? parts.join('؛ ') : t('judgeNoChange')}`));
    if (l.single && l.single.length) {
      const d = document.createElement('div');
      d.className = 'hint';
      d.textContent = fill(t('judgeSingle'), { c: l.single.map((c) => `${optLabel(c.key)}: ${/^\d+$/.test(c.value) ? nf(Number(c.value)) : valLabel(c.key, c.value)}`).join('؛ ') });
      li.appendChild(d);
    }
    if (l.after != null && l.done.length) {
      const d = document.createElement('div');
      d.className = l.undone ? 'hint bad' : 'hint';
      d.textContent = fill(t(l.undone ? 'judgeUndone' : 'judgeKept'), { a: nf(Math.round(l.before * 1000) / 10), b: nf(Math.round(l.after * 1000) / 10) });
      li.appendChild(d);
    }
    if (ar && l.diff) { const d = document.createElement('div'); d.className = 'hint'; d.textContent = fill(t('judgeLeft'), { d: l.diff }); li.appendChild(d); }
    ul.appendChild(li);
  }
}

// "220 x 95 x 82 cm", "2200×950×820 mm", "87 x 37 x 32 in": width × depth × height in cm, or null.
function readTriple(text) {
  const s = String(text).replace(/[\u0660-\u0669]/g, (c) => c.charCodeAt(0) - 0x0660).replace(/[\u06F0-\u06F9]/g, (c) => c.charCodeAt(0) - 0x06F0).replace(/\u066B/g, '.');
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*[x×*X]\s*(\d+(?:[.,]\d+)?)\s*[x×*X]\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m|in|inch|inches|"|”)?/i);
  if (!m) return null;
  const unit = (m[4] || 'cm').toLowerCase();
  const k = unit === 'mm' ? 0.1 : unit === 'm' ? 100 : (unit.startsWith('in') || unit === '"' || unit === '”') ? 2.54 : 1;
  const n = (i) => Math.round(parseFloat(m[i].replace(',', '.')) * k * 10) / 10;
  return { w: n(1), d: n(2), h: n(3) };
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
window.aim3dHost = (info) => {
  host = info; $('#tokenRow').hidden = false; $('#token').placeholder = info.has_token ? '••••••••' : 'hf_…';
  $('#seeAI').checked = seeOn();
  paintKeyRow();
  if (readAfterKey && hasKey()) { readAfterKey = false; if (seeOn() && state.photo) readDetails(); }
};
let readAfterKey = false;
let keyBad = false;
let keyEdit = false;
// the Gemini key field shows while the details are to be read and no key is saved yet, Google refused the key, or the
// user asked to change it; "change the key" shows while a key is saved and the field is hidden
function paintKeyRow() {
  const on = $('#seeAI').checked;
  $('#geminiRow').hidden = !(on && (keyBad || keyEdit || !hasKey()));
  $('#geminiChange').hidden = !(on && $('#geminiRow').hidden);
  $('#geminiForget').hidden = !hasKey();
  $('#gemini').placeholder = hasKey() ? '••••••••' : 'AQ.… / AIza…';
}
// the key goes to SketchUp's settings when the extension keeps it, else to this browser
function saveGeminiKey(v) {
  if (window.sketchup && window.sketchup.aim3d_set_gemini) {
    readAfterKey = !!v;
    // the switch is on while the key row shows: saving the key keeps it on (sent first, so the last reply has both)
    if (v && $('#seeAI').checked && window.sketchup.aim3d_set_see) window.sketchup.aim3d_set_see('1');
    window.sketchup.aim3d_set_gemini(v);
    return;
  }
  store.set('gemini', v);
  if (v) store.set('see', '1');
  paintKeyRow();
  if (v && state.photo) readDetails();
}
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
  state.colour = 'white'; // the site makes white models only
  state.pal = rc.pal || state.pal;
  $('#quality').value = state.quality;
  for (const k of ['w', 'd', 'h']) $(`#${k}`).value = state[k];
  renderForm();
  scheduleBuild();
  if (rc.physics) setTimeout(settle, 400);
}

function insertIntoSketchUp(opts = {}) {
  if (!host && !window.sketchup) return;
  if (!doc || !doc.parts.some((p) => p.visible)) return;
  const payload = {
    protocol: HOST_PROTOCOL,
    name: state.type === 'ai' ? `AI ${state.aiEngine || 'model'}` : `${TYPE_T[state.type][1]}`,
    recipe: recipe(),
    replace: state.editing,
    place: opts.place !== false, // false: put at the origin (tests); normally the piece follows the mouse
    // a colour measured on the part itself names its material after the part ("AIM Throw"), others after their role
    parts: doc.exportItems().map((it) => {
      const g = it.geometry.index ? it.geometry : null;
      const pos = new Float32Array(it.geometry.attributes.position.array);
      const tris = g ? new Uint32Array(g.index.array) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
      return { name: it.name, role: it.role, color: null, pos: b64(pos), tris: b64(tris), material: 'AIM white' };
    }),
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
  doc = new Doc();
  history = new History();
  editor = new Editor({ viewer, doc, history, t, nf, onChange: (kind) => { showDims(); paintProvenance(); if (kind === 'edit') { paintEditNote(); prepareDrag(); } } });
  builder = new Engine();
  physics = new Engine();
  applyLang();
  $('#lang').addEventListener('click', () => { lang = lang === 'ar' ? 'en' : 'ar'; store.set('lang', lang); applyLang(); showDims(); });
  $('#type').addEventListener('change', (e) => { if (e.target.value !== 'ai' && aiBusyNow()) cancelAI(); state.type = e.target.value; state.typeByUser = true; state.fitDims = null; state.fitResult = null; $('#compare').hidden = true; $('#exactAI').hidden = true; if (state.cut) state.wantFit = true; renderForm(); scheduleBuild(); });
  for (const k of ['w', 'd', 'h']) {
    $(`#${k}`).addEventListener('input', (e) => {
      // Arabic-Indic and Persian digits and the Arabic decimal mark count as typed; anything else is dropped
      const triple = readTriple(e.target.value);
      if (triple) {
        for (const [key, val] of Object.entries(triple)) { state[key] = String(val); $(`#${key}`).value = String(val); }
        status('fit', () => fill(t('pasted'), { w: nf(triple.w), d: nf(triple.d), h: nf(triple.h) }));
        if (state.cut) state.wantFit = true;
        showSense();
        scheduleBuild();
        return;
      }
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
  $('#pickBox').addEventListener('click', openBoxView);
  $('#cancelBox').addEventListener('click', () => { $('#boxView').hidden = true; });
  $('#useBox').addEventListener('click', useBox);
  const bimg = $('#boxImg');
  bimg.addEventListener('pointerdown', (e) => { e.preventDefault(); bimg.setPointerCapture(e.pointerId); const p = boxPoint(e); boxDrag = { a: p, b: p }; drawBox(); });
  bimg.addEventListener('pointermove', (e) => { if (boxDrag && e.buttons) { boxDrag.b = boxPoint(e); drawBox(); } });
  bimg.addEventListener('pointerup', (e) => { if (boxDrag) { boxDrag.b = boxPoint(e); drawBox(); } });
  $('#aiMake').addEventListener('click', makeAI);
  $('#aiBest').addEventListener('click', bestOf);
  $('#dragOut').addEventListener('dragstart', (e) => {
    if (!dragFile) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('DownloadURL', `model/gltf-binary:${dragFile.name}:${dragFile.url}`);
    e.dataTransfer.setData('text/uri-list', dragFile.url);
  });
  $('#dragOut').addEventListener('click', (e) => { e.preventDefault(); exportAs('glb'); });
  $('#aiLite').addEventListener('click', () => makeLite());
  $('#aiProfile').addEventListener('click', () => makeProfile(false));
  $('#anConfirm').addEventListener('change', (e) => { state.productConfirmed = e.target.checked ? photoJob : null; paintProvenance(); });
  $('#saveProject').addEventListener('click', saveProject);
  $('#openProject').addEventListener('click', () => $('#projectFile').click());
  $('#projectFile').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) openProject(f); });
  $('#aiAuto').checked = aiAutoOn();
  $('#aiAuto').addEventListener('change', (e) => store.set('aiAuto', e.target.checked ? '1' : '0'));
  $('#judge').addEventListener('click', () => judgeModel());
  for (const slot of document.querySelectorAll('.slot')) {
    const input = slot.querySelector('input');
    input.addEventListener('change', () => { if (input.files[0]) setView(slot.dataset.side, input.files[0]); input.value = ''; });
  }
  $('#videoPick').addEventListener('click', () => $('#videoFile').click());
  $('#videoFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; takeVideo(f); });
  $('#swapLR').addEventListener('click', () => { const l = state.views.left; const r = state.views.right; setView('left', r); setView('right', l); });
  $('#clearViews').addEventListener('click', () => { for (const side of ['back', 'left', 'right']) setView(side, null); });
  $('#aiCancel').addEventListener('click', cancelAI);
  // the Hugging Face token: kept by the extension inside SketchUp, else in this browser; it goes only to Hugging Face
  $('#tokenRow').hidden = false;
  $('#token').placeholder = store.get('hf') ? '••••••••' : 'hf_…';
  $('#tokenSave').addEventListener('click', () => {
    const v = $('#token').value.trim().replace(/\s+/g, '');
    if (window.sketchup && window.sketchup.aim3d_set_token) window.sketchup.aim3d_set_token(v);
    else { store.set('hf', v); $('#token').placeholder = v ? '••••••••' : 'hf_…'; }
    $('#token').value = '';
    status('ai', () => t('tokenSaved'));
  });
  $('#closeCompare').addEventListener('click', closeCompare);
  $('#refit').addEventListener('click', () => { state.wantFit = false; runFit(); });
  $('#geminiSave').addEventListener('click', () => {
    const v = $('#gemini').value.trim().replace(/\s+/g, '');
    if (!v) { status('seeAI', () => t('geminiEmpty'), true); $('#gemini').focus(); return; }
    keyBad = false;
    keyEdit = false;
    $('#gemini').value = '';
    status('seeAI', () => t(state.photo ? 'geminiSavedRead' : 'geminiSaved'));
    saveGeminiKey(v);
  });
  $('#gemini').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#geminiSave').click(); } });
  $('#geminiChange').addEventListener('click', () => { keyEdit = true; paintKeyRow(); $('#gemini').focus(); });
  $('#geminiForget').addEventListener('click', () => {
    stopReading();
    keyEdit = true;
    saveGeminiKey('');
    status('seeAI', () => t('geminiRemoved'));
    paintKeyRow();
  });
  $('#anUseSize').addEventListener('click', useAISize);
  $('#seeAI').addEventListener('change', (e) => {
    const on = e.target.checked;
    if (host) host.see_ai = on;
    if (window.sketchup && window.sketchup.aim3d_set_see) window.sketchup.aim3d_set_see(on ? '1' : '0');
    else store.set('see', on ? '1' : '0');
    paintKeyRow();
    if (on && state.photo) readDetails();
    if (!on) { stopReading(); status('seeAI', ''); }
  });
  $('#seeAI').checked = seeOn();
  paintKeyRow();
  $('#exactAI').addEventListener('click', () => {
    const sel = $('#type'); sel.value = 'ai'; sel.dispatchEvent(new Event('change'));
    makeAI();
  });
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
  // offline mode on the website only: inside SketchUp the browser has no working cache (see index.html)
  if ('serviceWorker' in navigator && !inSketchUp) navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  scheduleBuild();
  connectSketchUp();
  window.aim3d = { state, viewer, rebuild, settle, exportAs, toGLB, toDAE, insertIntoSketchUp, recipe, applyRecipe, runFit, openCompare, cutBox, readTriple, aiPhoto, seePrompt, readDetails, paintAnalysis, useAISize, setView, makeAI, bestOf, framesFromVideo, judgeModel, judgePictures, measureNow, openProject, provenance, projectJSON: () => JSON.stringify(toProject(doc, provenance())), makeProfile, get doc() { return doc; }, get editor() { return editor; }, get history() { return history; } }; // for the tests
}

start();
