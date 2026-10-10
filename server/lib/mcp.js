/* MCP-клиент: Streamable HTTP и stdio. Один и тот же клиент — для поиска в интернете (тот же сервер,
   что и в браузерной версии) и для серверов, которые подключили пользователь или агент.
   stdio-сервер запускает исполнитель от имени mochi-agent — у процесса нет доступа к данным сервера. */
import { CFG } from './config.js';
import { rid } from './store.js';
import { spawnProc } from './runner-client.js';

const PROTO = '2025-06-18';
const rpcErr = e => Object.assign(new Error((e && e.message) || 'ошибка сервера'), { code: e && e.code });

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
    const r = await fetch(this.url, { method: 'POST', headers: h, signal, body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id }) }) })
      .catch(e => { throw signal?.aborted ? e : new Error('не достучалась до ' + new URL(this.url).host + ' (' + (e.cause?.code || e.cause?.message || e.message) + ')'); });
    this.sid = r.headers.get('Mcp-Session-Id') || this.sid;
    if (!r.ok) {
      r.body?.cancel().catch(() => {});
      /* сессия на сервере истекла — начинаем заново */
      throw Object.assign(new Error(r.status === 429 ? 'слишком много запросов, подождите' : r.status === 401 || r.status === 403 ? 'сервер не пустил (HTTP ' + r.status + '): проверь ключ в заголовках' : 'HTTP ' + r.status), { session: r.status === 404 && !!this.sid, status: r.status });
    }
    if (notify) { r.body?.cancel().catch(() => {}); return null; }
    const m = (r.headers.get('content-type') || '').includes('event-stream') ? await readSSE(r, id) : await r.json();
    if (m.error) throw rpcErr(m.error);
    return m.result;
  }
  reset() { this.sid = null; }
  close() {
    if (!this.sid) return;
    fetch(this.url, { method: 'DELETE', headers: { ...this.headers, 'Mcp-Session-Id': this.sid }, signal: AbortSignal.timeout(5000) }).then(r => r.body?.cancel(), () => {});
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
        const r = await this.t.rpc('initialize', { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'mochi-server', version: '1' } }, signal);
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

/* ---------- поиск в интернете ---------- */
const WEB_HIDE = ['session_id', 'model_name'];
const web = { c: null, defs: null, fail: 0, p: null, t0: 0 };
const webClient = () => web.c ??= new McpClient({ type: 'http', url: CFG.searchMcp });
export const WEB_GRACE = 2500;

/* Инструменты поиска для очередного шага агента. Подключение к поиску (initialize + tools/list, до 10 с) не должно
   задерживать ответ: список уже знаем — отдаём его, а переподключение идёт в фоне (сам поиск в webCall подключится сам);
   не знаем — ждём не дольше WEB_GRACE от начала первой попытки и идём без поиска. Не ответил — новая попытка не чаще
   раза в минуту и только в фоне */
export async function webTools() {
  if (!CFG.searchMcp) return [];
  if (webClient().tools && web.defs) return web.defs;
  const failed = web.fail;
  if (!failed || Date.now() - failed > 60000) warmWeb();
  const left = web.t0 + WEB_GRACE - Date.now();
  if (web.defs || failed || !web.p || left <= 0) return web.defs || [];
  return Promise.race([web.p, new Promise(r => setTimeout(r, left).unref()).then(() => web.defs || [])]);
}
/* подключиться к поиску заранее (при старте сервера), чтобы первое сообщение после перезапуска его не ждало */
export function warmWeb() {
  if (!CFG.searchMcp) return Promise.resolve([]);
  if (web.p) return web.p;
  web.t0 = Date.now();
  return web.p = webClient().connect(10000)
    .then(ts => { web.fail = 0; return web.defs = ts.map(t => toOpenAI(t, t.name, WEB_HIDE)); })
    .catch(e => { web.fail = Date.now(); console.warn('mcp:', e.message); return web.defs || []; })
    .finally(() => { web.p = null; });
}

export async function webCall(name, args, { signal, session, model }) {
  const c = webClient(), t = (await c.connect(10000)).find(x => x.name === name), pr = t?.inputSchema?.properties || {};
  const a = { ...args };
  if (pr.session_id) a.session_id = session || rid(16);
  if (pr.model_name && model) a.model_name = String(model).slice(0, 100);
  try { return await c.call(name, a, signal, 45000); }
  catch (e) { if (/не ответил за/.test(e.message)) throw new Error('поиск не ответил вовремя'); throw e; }
}
