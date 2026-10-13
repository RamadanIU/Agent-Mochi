/* MCP-клиент: Streamable HTTP и stdio — для всех MCP-серверов пользователя, в том числе предустановленного
   поиска в интернете (Parallel Search, см. PRESETS в ext.js).
   stdio-сервер запускает исполнитель от имени personalcomputer-agent — у процесса нет доступа к данным сервера. */
import { spawnProc } from './runner-client.js';
import { apiFetch, cfBlock, cfMessage } from './net.js';

const PROTO = '2025-06-18';
const rpcErr = e => Object.assign(new Error((e && e.message) || 'ошибка сервера'), { code: e && e.code });
/* начало ответа сервера с ошибкой — одной строкой, без разметки: по нему видно, что случилось на самом деле */
const gist = t => { const s = String(t || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); return s ? ': ' + (s.length > 200 ? s.slice(0, 200) + '…' : s) : ''; };

async function readSSE(r, id) {
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const data = ev.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      let m; try { m = JSON.parse(data); } catch { continue; }
      if (m.id === id && (m.result !== undefined || m.error)) return m;
    }
  }
  const data = buf.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
  const m = JSON.parse(data);
  if (m.id === id) return m;
  throw new Error('пустой ответ сервера');
}

class HttpT {
  constructor(url, headers) { this.url = url; this.headers = headers || {}; this.sid = null; this.id = 0; }
  async rpc(method, params, signal, notify) {
    const h = { ...this.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTO };
    if (this.sid) h['Mcp-Session-Id'] = this.sid;
    const id = notify ? undefined : ++this.id;
    /* как к API модели: если Cloudflare не пускает Node.js, apiFetch повторит запрос через curl */
    const r = await apiFetch(this.url, { method: 'POST', headers: h, signal, body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id }) }) }, 'mcp')
      .catch(e => { throw signal?.aborted ? e : new Error('не достучался до ' + new URL(this.url).host + ' (' + (e.cause?.code || e.cause?.message || e.message) + ')'); });
    this.sid = r.headers.get('Mcp-Session-Id') || this.sid;
    if (!r.ok) {
      const text = await r.text().catch(() => ''), cf = cfBlock(r.status, text, r.headers);
      /* сессия на сервере истекла (404) — начинаем заново */
      throw Object.assign(new Error(cf ? cfMessage(cf, this.url, r.headers)
        : r.status === 429 ? 'слишком много запросов (HTTP 429), подождите' + gist(text)
        : r.status === 401 || r.status === 403 ? 'сервер не пустил (HTTP ' + r.status + ')' + gist(text) + (this.headers && Object.keys(this.headers).length ? ' — проверь ключ в заголовках' : '')
        : 'HTTP ' + r.status + gist(text)), { session: r.status === 404 && !!this.sid, status: r.status });
    }
    if (notify) { r.body?.cancel().catch(() => {}); return null; }
    const m = (r.headers.get('content-type') || '').includes('event-stream') ? await readSSE(r, id) : await r.json();
    if (m.error) throw rpcErr(m.error);
    return m.result;
  }
  reset() { this.sid = null; }
  close() {
    if (!this.sid) return;
    apiFetch(this.url, { method: 'DELETE', headers: { ...this.headers, 'Mcp-Session-Id': this.sid }, signal: AbortSignal.timeout(5000) }, 'mcp').then(r => r.body?.cancel(), () => {});
    this.sid = null;
  }
}

class StdioT {
  constructor({ command, env, cwd }) { this.spec = { cmd: command, env, cwd }; this.p = null; this.wait = new Map(); this.id = 0; this.onDead = null; this.onChanged = null; }
  start() {
    if (this.p) return;
    /* события старого процесса (уже остановленного) не трогают новый */
    const p = this.p = spawnProc(this.spec, l => { if (this.p === p) this.line(l); }, (code, err) => { if (this.p === p) this.exit(code, err); });
  }
  send(m) { this.p?.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'); }
  line(l) {
    let m; try { m = JSON.parse(l); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.method) {
      /* запросы сервера к клиенту: ping и roots/list понимаем, остальное — «не поддерживается» */
      if (m.method === 'notifications/tools/list_changed') this.onChanged?.();
      if (m.id === undefined) return;
      if (m.method === 'ping') this.send({ id: m.id, result: {} });
      else if (m.method === 'roots/list') this.send({ id: m.id, result: { roots: [] } });
      else this.send({ id: m.id, error: { code: -32601, message: 'не поддерживается' } });
      return;
    }
    const w = this.wait.get(m.id); if (w) { this.wait.delete(m.id); w(m); }
  }
  exit(code, err) {
    this.p = null;
    this.fail(new Error('MCP-сервер завершился' + (code != null ? ' (код ' + code + ')' : '') + (err ? ': ' + err.split('\n').slice(-6).join(' ').slice(-600) : '')));
    this.onDead?.();
  }
  fail(e) { const ws = [...this.wait.values()]; this.wait.clear(); for (const w of ws) w({ fail: e }); }
  rpc(method, params, signal, notify) {
    this.start();
    if (notify) { this.send({ method, ...(params ? { params } : {}) }); return Promise.resolve(null); }
    const id = ++this.id;
    return new Promise((ok, no) => {
      const ab = () => { this.wait.delete(id); this.send({ method: 'notifications/cancelled', params: { requestId: id } }); no(signal.reason || new Error('прервано')); };
      if (signal?.aborted) return ab();
      signal?.addEventListener('abort', ab, { once: true });
      this.wait.set(id, m => { signal?.removeEventListener('abort', ab); m.fail ? no(m.fail) : m.error ? no(rpcErr(m.error)) : ok(m.result); });
      this.send({ id, method, ...(params ? { params } : {}) });
    });
  }
  reset() {}
  close() { const p = this.p; this.p = null; p?.kill(); this.fail(new Error('MCP-сервер остановлен')); }
}

export class McpClient {
  constructor(spec) {
    this.t = spec.type === 'stdio' ? new StdioT(spec) : new HttpT(spec.url, spec.headers);
    this.tools = null; this.info = null; this.pending = null; this.used = Date.now(); this.stdio = spec.type === 'stdio';
    this.t.onDead = this.t.onChanged = () => { this.tools = null; };
  }
  connect(ms = 30000) {
    if (this.tools) return Promise.resolve(this.tools);
    return this.pending ??= (async () => {
      const signal = AbortSignal.timeout(ms);
      try {
        const r = await this.t.rpc('initialize', { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'personalcomputer-server', version: '1' } }, signal);
        this.info = { name: r?.serverInfo?.title || r?.serverInfo?.name || '', version: r?.serverInfo?.version || '', instructions: typeof r?.instructions === 'string' ? r.instructions.slice(0, 2000) : '' };
        await this.t.rpc('notifications/initialized', null, signal, true).catch(() => {});
        const all = []; let cursor;
        do {
          const l = await this.t.rpc('tools/list', cursor ? { cursor } : {}, signal);
          all.push(...(Array.isArray(l?.tools) ? l.tools : []).filter(t => t && typeof t.name === 'string'));
          cursor = l?.nextCursor;
        } while (cursor && all.length < 500);
        this.used = Date.now();
        return this.tools = all;
      } catch (e) {
        if (signal.aborted) { this.close(); throw new Error('MCP-сервер не ответил за ' + Math.round(ms / 1000) + ' с'); }
        if (e.session) this.t.reset();
        throw e;
      } finally { this.pending = null; }
    })();
  }
  async call(name, args, signal, ms = 120000, retry = 1) {
    this.used = Date.now();
    await this.connect();
    const to = AbortSignal.timeout(ms), sig = signal ? AbortSignal.any([signal, to]) : to;
    try {
      const res = await this.t.rpc('tools/call', { name, arguments: args }, sig);
      this.used = Date.now();
      return fmtResult(res);
    } catch (e) {
      if (retry && e.session) { this.t.reset(); this.tools = null; return this.call(name, args, signal, ms, 0); }
      if (to.aborted && !signal?.aborted) throw new Error('инструмент не ответил за ' + Math.round(ms / 1000) + ' с');
      throw e;
    }
  }
  close() { this.t.close(); this.tools = null; this.pending = null; }
}

export function fmtResult(res, max = 14000) {
  let out = (res?.content || []).map(c => c.type === 'text' ? c.text : c.type === 'resource' && c.resource?.text ? c.resource.text : '[' + c.type + ']').join('\n').trim()
    || (res?.structuredContent ? JSON.stringify(res.structuredContent) : '(пусто)');
  if (out.length > max) out = out.slice(0, max) + '\n…(усечено)';
  return res?.isError ? 'Ошибка: ' + out : out;
}

/* описание MCP-инструмента → формат OpenAI (имя функции — своё, скрытые параметры убираем) */
export function toOpenAI(t, fn = t.name, hide = []) {
  const p = structuredClone(t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} });
  delete p.$schema;
  if (p.type !== 'object') p.type = 'object';
  if (!p.properties || typeof p.properties !== 'object') p.properties = {};
  for (const k of hide) { delete p.properties[k]; if (Array.isArray(p.required)) p.required = p.required.filter(x => x !== k); }
  if (Array.isArray(p.required) && !p.required.length) delete p.required;
  return { type: 'function', function: { name: fn, description: String(t.description || t.title || t.name).slice(0, 1500), parameters: p } };
}
