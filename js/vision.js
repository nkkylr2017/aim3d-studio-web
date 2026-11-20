// Reading a photo with a vision model (Google's Gemini, the user's own key). The question and the answer's JSON
// schema are built from the option lists, so a new option is asked about without touching this file; the layer by
// layer analysis (parts with counts, real size, photo problems, a tip) follows the AIM 3D Studio extension's analyser.
// On the website the browser asks Google directly (generativelanguage.googleapis.com answers the site's origin);
// inside SketchUp the extension carries the same request, with the key it keeps.

// Free-tier Flash models with image input (Google's free tier, 2026-11; the same models as the AIM 3D Studio
// extension), then the alias that follows the newest Flash. A model that is missing, busy, out of quota or silent for
// 60 s gives way. Order by measurement (2026-11-20, the user's free key, a one-word reply): 3.6 Flash 9.5 s and it
// read the studio bed in about 20 s; 3.8 Flash 41 s (a photo with the full question ran past 60 s); 3.5 Flash-Lite
// 0.8 s (no thinking, the quick fallback).
export const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest'];
export const MODEL_WAIT = 60000;
export const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent';

const HINTS = [
  'Left and right are as seen standing at the foot of the bed (in front of any other piece), facing it.',
  'pillows: count every pillow and cushion on the bed, one by one. seats: count the seat cushions.',
  'bedding: puffy = a thick, fluffy duvet hanging down to the floor in deep folds; duvet = a duvet hanging part way down; tucked = sheets tucked in neatly.',
  'throw: pile = a large blanket bunched at the foot end, spilling over a corner or side; heap = a small blanket heaped on one corner; '
    + 'diagonal = a large blanket laid across the bed, hanging down both sides; runner = a folded strip across the foot; none = no separate blanket.',
  'pillow_pose: upright = pillows standing almost straight up; leaning = pillows leaning back against the headboard.',
  'base: platform = an upholstered base down to the floor; legs = the base stands on visible legs.',
  'If a detail is hidden, give the most likely value. Use "unknown" only for keys that do not belong to the type you chose.',
];

// en(key, value) -> a short English description of the value, or the value itself
export function analysisPrompt(types, options, typeName, optName, en) {
  const lines = [
    'This photo will be rebuilt as a 3D model inside SketchUp. Look at it like a furniture designer preparing the model.',
    `First, what the main object is: "type" is one of ${types.map((k) => `${k} (${typeName(k)})`).join(', ')}, or other (anything else).`,
    'Then its visible parts from the outside in ("layers"), each with how many there are and a short Arabic note on position, '
      + 'material, colour and shape (for a bed: base, headboard, mattress, duvet, every pillow and cushion, throw blanket, legs).',
    'Then "attrs": for the type you chose, each of its keys below with exactly one of its values (value = what it looks like); '
      + 'every other key is "unknown".',
  ];
  for (const type of types) {
    lines.push(`${type}:`);
    for (const [k, vals] of Object.entries(options[type])) {
      lines.push(`  ${k} (${optName(k)}): ${vals.map((v) => (/^\d+$/.test(v) ? v : `${v} = ${en(k, v)}`)).join(' | ')}`);
    }
  }
  lines.push(...HINTS);
  lines.push('Also give its typical real-world size in centimetres (estimate from the object type, its proportions and any cues '
    + 'such as doors, tiles or people), how sure you are of that size, whether the photo is good for building the model, '
    + 'problems that would hurt the model (cropped parts, heavy shadows, reflections, people or things in front, low resolution) '
    + 'and one practical tip. Write every Arabic field briefly.');
  return lines.join('\n');
}

// The answer's shape (JSON Schema, the subset Gemini takes: no additionalProperties).
export function analysisSchema(types, options) {
  const keys = {};
  for (const type of types) {
    for (const [k, vals] of Object.entries(options[type])) {
      keys[k] = keys[k] || new Set();
      vals.forEach((v) => keys[k].add(v));
    }
  }
  const attrProps = {};
  for (const [k, set] of Object.entries(keys)) attrProps[k] = { type: 'string', enum: [...set, 'unknown'] };
  return {
    type: 'object',
    required: ['type', 'object_en', 'object_ar', 'description_ar', 'layers', 'attrs', 'width_cm', 'depth_cm', 'height_cm',
      'size_confidence', 'photo_quality', 'issues_ar', 'tip_ar'],
    properties: {
      type: { type: 'string', enum: [...types, 'other'] },
      object_en: { type: 'string', description: 'Short English name, e.g. "upholstered bed with a winged headboard"' },
      object_ar: { type: 'string', description: 'Short Arabic name' },
      description_ar: { type: 'string', description: 'One or two sentences in Arabic describing the object as a designer would' },
      layers: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name_en', 'name_ar', 'count', 'detail_ar'],
          properties: {
            name_en: { type: 'string' }, name_ar: { type: 'string' },
            count: { type: 'integer', description: 'How many of this part are visible' },
            detail_ar: { type: 'string', description: 'Position, material, colour and shape, briefly, in Arabic' },
          },
        },
      },
      attrs: { type: 'object', required: Object.keys(attrProps), properties: attrProps },
      width_cm: { type: 'number', description: 'Typical real width, side to side, seen from the front' },
      depth_cm: { type: 'number', description: 'Typical real depth, front to back' },
      height_cm: { type: 'number', description: 'Typical real height, floor to top' },
      size_confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      photo_quality: { type: 'string', enum: ['good', 'ok', 'poor'] },
      issues_ar: { type: 'array', items: { type: 'string' }, description: 'Problems that will hurt the 3D model, in Arabic; empty if none' },
      tip_ar: { type: 'string', description: 'One practical tip in Arabic for a better 3D model' },
    },
  };
}

// The generateContent body: the question, the photo (a data URL) and the answer's schema.
// thinking: Gemini 3's thinkingLevel ('low' …), or nothing for the model's default.
export function geminiBody(prompt, dataUrl, schema, { thinking } = {}) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(String(dataUrl));
  if (!m) throw new Error('the photo is not a JPEG, PNG or WebP data URL');
  return {
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: m[1], data: m[2] } }, { text: prompt }] }],
    generationConfig: {
      temperature: 0, responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 8192,
      ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}),
    },
  };
}

// The answer's text from a generateContent reply (thought parts skipped).
export function replyText(data) {
  const parts = (((data || {}).candidates || [])[0] || {}).content;
  return ((parts && parts.parts) || []).filter((p) => p && !p.thought && p.text).map((p) => p.text).join('');
}

// What a failed call means: 'key' (wrong or not allowed: the other models would say the same), 'quota', 'model'
// (this model is missing or refused the request: the next one may work), 'busy' or 'net'.
export function failureKind(status, message) {
  const msg = String(message || '');
  // a 403 without a word on the key can be one model the key may not use: the next model is tried
  if (status === 401 || /API key not valid|API_KEY_INVALID|API key expired|invalid api key/i.test(msg)) return 'key';
  if (status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(msg)) return 'quota';
  if (status === 404 || status === 400) return 'model';
  if (status >= 500) return 'busy';
  return status ? 'model' : 'net';
}

// Asks Google straight from the page (the website). Tries the models in turn; resolves { text, model } or rejects
// with an Error carrying .kind ('key', 'quota', 'busy', 'net', 'model') and .tried (one line per model).
export async function askGemini(key, body, { models = GEMINI_MODELS, signal, fetchFn = fetch, url = GEMINI_URL, wait = MODEL_WAIT } = {}) {
  const tried = [];
  let last = 'model';
  const text = JSON.stringify(body);
  for (const model of models) {
    // this attempt's own stop: the caller's, or the time limit
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    if (signal) { if (signal.aborted) throw abortError(); signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = setTimeout(() => stop.abort(), wait);
    let res;
    let data = null;
    try {
      res = await fetchFn(url.replace('%s', model), {
        method: 'POST', signal: stop.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: text,
      });
      try { data = await res.json(); } catch (e) { data = null; }
    } catch (e) {
      if (signal && signal.aborted) throw abortError();
      const timedOut = stop.signal.aborted;
      tried.push(`${model}: ${timedOut ? `no answer in ${Math.round(wait / 1000)} s` : 'no connection'}`);
      last = timedOut ? 'busy' : 'net';
      continue;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (res.ok && data) {
      const text = replyText(data);
      if (text.trim()) return { text, model };
      tried.push(`${model}: empty answer`);
      continue;
    }
    const msg = data && data.error ? data.error.message : '';
    last = failureKind(res.status, msg);
    tried.push(`${model}: HTTP ${res.status} ${String(msg).slice(0, 120)}`);
    if (last === 'key') break;
  }
  const err = new Error(tried.join(' | '));
  err.kind = last;
  err.tried = tried;
  throw err;
}

// ---- the judge: the photo next to a grey render of the model from the same camera (render and compare). Asked with
// both pictures and the model's current options; only options the photo clearly contradicts are to be changed
// (a judge asked without a reference rewards a clean but wrong model; small edits keep the loop from swinging).
export function judgePrompt(type, options, current, typeName, optName, en, tried = {}) {
  const lines = [
    `Image 1 is a photo of a real ${typeName(type)}. Image 2 is a 3D model of it, rendered in plain grey from the same camera.`,
    'The model is built from the options below; each line gives the current value and the possible values (value = what it looks like).',
  ];
  for (const [k, vals] of Object.entries(options[type])) {
    lines.push(`  ${k} (${optName(k)}): now ${current[k]}; possible: ${vals.map((v) => (/^\d+$/.test(v) ? v : `${v} = ${en(k, v)}`)).join(' | ')}`);
  }
  const no = Object.entries(tried).filter(([, vs]) => vs.length).map(([k, vs]) => `${k}: ${vs.join(', ')}`);
  if (no.length) lines.push(`Already tried and rejected, do not suggest again: ${no.join('; ')}.`);
  lines.push(
    'Compare the model with the photo. List in "changes" only the options whose current value is clearly wrong, each with the',
    'value that matches the photo. Leave out anything the photo does not show clearly, and colour or material (the model is',
    'grey on purpose). Ignore the background, the floor and the lighting. Left and right are as seen standing in front of the piece.',
    'Rate how close the model\'s shape is to the photo from 0 to 10, and name the biggest difference that remains, in Arabic.',
  );
  return lines.join('\n');
}

export function judgeSchema(type, options) {
  const keys = Object.keys(options[type]);
  const values = [...new Set(Object.values(options[type]).flat())];
  return {
    type: 'object',
    required: ['score', 'changes', 'biggest_difference_ar'],
    properties: {
      score: { type: 'integer', description: '0 = nothing alike, 10 = the same shape' },
      changes: {
        type: 'array',
        items: {
          type: 'object', required: ['key', 'value', 'reason_ar'],
          properties: { key: { type: 'string', enum: keys }, value: { type: 'string', enum: values }, reason_ar: { type: 'string' } },
        },
      },
      biggest_difference_ar: { type: 'string' },
    },
  };
}

// photo and render: data URLs; the body asks with both pictures (photo first, as the prompt says)
export function judgeBody(prompt, photoUrl, renderUrl, schema) {
  const part = (u) => {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(String(u));
    if (!m) throw new Error('a picture is not a JPEG, PNG or WebP data URL');
    return { inline_data: { mime_type: m[1], data: m[2] } };
  };
  return {
    contents: [{ role: 'user', parts: [{ text: 'Image 1 (the photo):' }, part(photoUrl), { text: 'Image 2 (the model):' }, part(renderUrl), { text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 4096 },
  };
}

// -> { score, changes: [{ key, value, reason }], diff } with only valid keys and values of this type, or null
export function parseJudge(text, type, options) {
  const s = String(text);
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  const opts = options[type] || {};
  const seen = new Set();
  const changes = (Array.isArray(j.changes) ? j.changes : []).map((c) => ({
    key: String(c && c.key || ''), value: String(c && c.value || '').toLowerCase(), reason: String(c && c.reason_ar || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  })).filter((c) => opts[c.key] && opts[c.key].includes(c.value) && !seen.has(c.key) && seen.add(c.key));
  const score = Math.max(0, Math.min(10, Math.round(Number(j.score) || 0)));
  return { score, changes, diff: String(j.biggest_difference_ar || '').replace(/\s+/g, ' ').trim().slice(0, 240) };
}

function abortError() {
  const e = new Error('stopped');
  e.name = 'AbortError';
  return e;
}

// The answer, checked against the option lists: { type, attrs, size, sizeSure, layers, name, nameAr, descAr, quality,
// issues, tip } or null. attrs keeps only the chosen type's keys with known values.
export function parseAnalysis(text, types, options) {
  const s = String(text);
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  const type = String(j.type || '').toLowerCase();
  if (!types.includes(type) && type !== 'other') return null;
  const attrs = {};
  const src = j.attrs && typeof j.attrs === 'object' ? j.attrs : {};
  for (const [k, vals] of Object.entries(options[type] || {})) {
    const v = src[k] == null ? '' : String(src[k]).toLowerCase();
    if (vals.includes(v)) attrs[k] = v;
  }
  const cm = (v) => (Number.isFinite(Number(v)) && Number(v) >= 5 && Number(v) <= 2000 ? Math.round(Number(v)) : 0);
  const size = { w: cm(j.width_cm), d: cm(j.depth_cm), h: cm(j.height_cm) };
  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const layers = (Array.isArray(j.layers) ? j.layers : []).slice(0, 24).map((l) => ({
    en: str(l && l.name_en, 60), ar: str(l && l.name_ar, 60),
    count: Math.max(0, Math.min(99, Math.round(Number(l && l.count) || 0))), detail: str(l && l.detail_ar, 160),
  })).filter((l) => l.ar || l.en);
  return {
    type, attrs, size: size.w && size.d && size.h ? size : null,
    sizeSure: ['low', 'medium', 'high'].includes(j.size_confidence) ? j.size_confidence : 'low',
    layers, name: str(j.object_en, 80), nameAr: str(j.object_ar, 80), descAr: str(j.description_ar, 400),
    quality: ['good', 'ok', 'poor'].includes(j.photo_quality) ? j.photo_quality : 'ok',
    issues: (Array.isArray(j.issues_ar) ? j.issues_ar : []).slice(0, 6).map((x) => str(x, 160)).filter(Boolean),
    tip: str(j.tip_ar, 240),
  };
}
