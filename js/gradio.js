// A small client for Gradio 4/5/6 apps on Hugging Face Spaces, straight from the browser (the Spaces answer the
// site's origin, checked 2026-11-20). The same queue protocol as a Space's own page, so stateful apps keep their
// session (port of the extension's gradio_client.rb):
//   GET  <base>/config                              -> dependencies (fn_index by api_name), api_prefix
//   POST <base><prefix>/upload                      -> ["/tmp/gradio/.../input.png"]
//   POST <base><prefix>/queue/join                  -> {"event_id": ...}
//   GET  <base><prefix>/queue/data?session_hash=... -> event stream until process_completed
// The optional Hugging Face token goes to Hugging Face only, in the Authorization header.

const QUEUE_TIMEOUT = 15 * 60 * 1000; // a job that has not answered by then is given up, never sent again
const RETRY_AFTER_MAX = 30; // a "busy, come back in N s" is honoured once, and only up to this long

export class GradioError extends Error {
  constructor(message, kind = 'space') {
    super(message);
    this.kind = kind; // 'quota', 'token', 'down', 'changed', 'net', 'space'
  }
}

export function quotaLike(msg) {
  return /quota|ZeroGPU|exceeded|GPU task aborted|You have exceeded/i.test(String(msg));
}

export class Gradio {
  // space: a Space subdomain ("tencent-hunyuan3d-2") or a full server URL
  constructor(space, { token = '', fetchFn = (...a) => fetch(...a), signal } = {}) {
    this.base = /^https?:\/\//.test(space) ? space.replace(/\/+$/, '') : `https://${space}.hf.space`;
    this.token = String(token || '').trim();
    this.fetch = fetchFn;
    this.signal = signal;
    this.session = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
    this.retriedJoin = false;
  }

  headers(extra = {}) {
    const h = { Accept: 'application/json', ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async request(url, init = {}) {
    try {
      return await this.fetch(url, { ...init, signal: this.signal });
    } catch (e) {
      if (this.signal && this.signal.aborted) throw e;
      throw new GradioError('No internet connection, or Hugging Face could not be reached.', 'net');
    }
  }

  async connect() {
    const res = await this.request(`${this.base}/config`, { headers: this.headers() });
    if (!res.ok) throw new GradioError(`The free Space is not available right now (HTTP ${res.status}).`, 'down');
    this.config = await res.json();
    this.prefix = String(this.config.api_prefix || '');
    if (this.prefix === '/') this.prefix = '';
    const types = {};
    for (const c of this.config.components || []) types[c.id] = c.type;
    this.types = types;
    return this;
  }

  // { api_name: visible inputs } -> what does not match the live app (empty when all is as expected)
  interfaceProblems(expected) {
    const out = [];
    for (const [api, count] of Object.entries(expected)) {
      const dep = (this.config.dependencies || []).find((d) => d.api_name === api);
      if (!dep) { out.push(`no '${api}' endpoint`); continue; }
      const have = (dep.inputs || []).filter((id) => this.types[id] !== 'state').length;
      if (have !== count) out.push(`'${api}' takes ${have} inputs, not ${count}`);
    }
    return out;
  }

  // a Blob -> a Gradio FileData usable as an input
  async upload(blob, name = 'input.png') {
    const form = new FormData();
    form.append('files', blob, name);
    const res = await this.request(`${this.base}${this.prefix}/upload`, { method: 'POST', headers: this.headers(), body: form });
    let paths = null;
    try { paths = await res.json(); } catch (e) { paths = null; }
    if (!res.ok || !Array.isArray(paths) || !paths[0]) throw new GradioError(`Upload to the Space failed (HTTP ${res.status}).`);
    return { path: paths[0], meta: { _type: 'gradio.FileData' }, orig_name: name, mime_type: blob.type || 'image/png' };
  }

  // Runs one endpoint with its visible inputs in order (hidden gr.State inputs are filled with null); resolves the
  // output data array.
  async call(apiName, values) {
    const deps = this.config.dependencies || [];
    const index = deps.findIndex((d) => d.api_name === apiName);
    if (index < 0) throw new GradioError(`The Space changed its interface (no '${apiName}' endpoint).`, 'changed');
    const dep = deps[index];
    const queue = values.slice();
    const data = (dep.inputs || []).map((id) => (this.types[id] === 'state' ? null : queue.shift()));
    const targets = dep.targets || [];
    const trigger = Array.isArray(targets[0]) ? targets[0][0] : targets[0];
    const payload = { data, event_data: null, fn_index: dep.id != null ? dep.id : index, trigger_id: trigger, session_hash: this.session };
    const res = await this.request(`${this.base}${this.prefix}/queue/join`, {
      method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
    });
    if (res.status === 429 && !this.retriedJoin) {
      const wait = Number(res.headers.get('retry-after')) || 0;
      if (wait >= 1 && wait <= RETRY_AFTER_MAX) {
        // joining the queue was refused outright, so nothing ran: asking once more after the stated wait is safe
        this.retriedJoin = true;
        await new Promise((r) => setTimeout(r, wait * 1000));
        return this.call(apiName, values);
      }
    }
    if (res.status === 401) throw new GradioError('Invalid Hugging Face token (401). Fix it or leave it empty.', 'token');
    if (res.status === 429) throw new GradioError('The free Space is busy or rate-limited (HTTP 429).', 'quota');
    if (!res.ok) throw new GradioError(`The Space refused the job (HTTP ${res.status}): ${(await res.text()).slice(0, 160)}`);
    const eventId = (await res.json().catch(() => ({}))).event_id;
    return this.waitFor(eventId, apiName);
  }

  async waitFor(eventId, apiName) {
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    if (this.signal) this.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop.abort(), QUEUE_TIMEOUT);
    let res;
    try {
      res = await this.fetch(`${this.base}${this.prefix}/queue/data?session_hash=${this.session}`,
        { headers: this.headers({ Accept: 'text/event-stream' }), signal: stop.signal });
      if (!res.ok) throw new GradioError(`Space stream failed (HTTP ${res.status})`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          let m;
          try { m = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (eventId && m.event_id && m.event_id !== eventId) continue;
          if (m.msg === 'unexpected_error') throw new GradioError(String(m.message || 'the Space reported an error'), quotaLike(m.message) ? 'quota' : 'space');
          if (m.msg === 'process_completed') {
            reader.cancel().catch(() => {});
            if (!m.success) {
              const msg = String((m.output && m.output.error) || m.title || 'the Space reported an error');
              throw new GradioError(quotaLike(msg) ? `Free GPU quota used up for now: ${msg.slice(0, 160)}` : msg.slice(0, 300), quotaLike(msg) ? 'quota' : 'space');
            }
            return (m.output && m.output.data) || [];
          }
        }
        if (done) throw new GradioError(`${apiName}: the Space closed the connection without a result.`);
      }
    } catch (e) {
      if (this.signal && this.signal.aborted) throw e;
      if (e instanceof GradioError) throw e;
      if (stop.signal.aborted) throw new GradioError(`${apiName}: timed out after ${QUEUE_TIMEOUT / 60000} min in the Space's queue. The job was not sent again.`);
      throw new GradioError('The connection to the Space was lost while waiting (no internet connection?).', 'net');
    } finally {
      clearTimeout(timer);
      if (this.signal) this.signal.removeEventListener('abort', onAbort);
    }
  }

  // A link to a result file. Behind a tunnel an app may build links with its internal address, so a link to another
  // host is re-pointed at the public base URL.
  fileUrl(file) {
    if (!file || typeof file !== 'object') return null;
    const url = String(file.url || '');
    if (!url) return file.path ? `${this.base}${this.prefix}/file=${file.path}` : null;
    if (url.startsWith('/')) return `${this.base}${url}`;
    try {
      const u = new URL(url);
      const b = new URL(this.base);
      if (u.host === b.host && u.protocol === b.protocol) return url;
      return `${this.base}${u.pathname}${u.search}`;
    } catch (e) {
      return url;
    }
  }

  async download(file) {
    const url = this.fileUrl(file);
    if (!url) throw new GradioError('finished without a 3D file');
    const res = await this.request(url, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) throw new GradioError(`download failed (HTTP ${res.status})`, 'net');
    return res.arrayBuffer();
  }
}
