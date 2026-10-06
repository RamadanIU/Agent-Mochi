/* MCP-клиент (Streamable HTTP) для поиска в интернете — тот же сервер, что и в браузерной версии */
import { CFG } from './config.js';
import { rid } from './store.js';

const st = { sid: null, tools: null, props: {}, pending: null, id: 0, fail: 0 };

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

async function rpc(method, params, signal, notify) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (st.sid) h['Mcp-Session-Id'] = st.sid;
  const id = notify ? undefined : ++st.id;
  const r = await fetch(CFG.searchMcp, { method: 'POST', headers: h, signal, body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id }) }) });
  st.sid = r.headers.get('Mcp-Session-Id') || st.sid;
  if (!r.ok) throw new Error(r.status === 429 ? 'слишком много запросов, подождите' : 'HTTP ' + r.status);
  if (notify) { r.body?.cancel().catch(() => {}); return null; }
  const m = (r.headers.get('content-type') || '').includes('event-stream') ? await readSSE(r, id) : await r.json();
  if (m.error) throw new Error(m.error.message || 'ошибка сервера');
  return m.result;
}

function toOpenAI(t) {
  const p = structuredClone(t.inputSchema || { type: 'object', properties: {} });
  delete p.$schema; st.props[t.name] = p.properties || {};
  for (const k of ['session_id', 'model_name']) { if (p.properties) delete p.properties[k]; if (p.required) p.required = p.required.filter(x => x !== k); }
  if (p.required && !p.required.length) delete p.required;
  return { type: 'function', function: { name: t.name, description: (t.description || '').slice(0, 1500), parameters: p } };
}

function connect() {
  if (st.tools) return Promise.resolve(st.tools);
  return st.pending ??= (async () => {
    const signal = AbortSignal.timeout(10000);
    try {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mochi-server', version: '1' } }, signal);
      await rpc('notifications/initialized', null, signal, true).catch(() => {});
      return st.tools = ((await rpc('tools/list', {}, signal)).tools || []).map(toOpenAI);
    } finally { st.pending = null; }
  })();
}

export async function webTools() {
  if (!CFG.searchMcp) return [];
  if (st.tools) return st.tools;
  if (st.fail && Date.now() - st.fail < 60000) return [];
  try { return await connect(); } catch (e) { st.fail = Date.now(); console.warn('mcp:', e.message); return []; }
}

export async function webCall(name, args, { signal, session, model }, retry = 1) {
  await connect();
  const a = { ...args }, pr = st.props[name] || {};
  if (pr.session_id) a.session_id = session || rid(16);
  if (pr.model_name && model) a.model_name = String(model).slice(0, 100);
  const to = AbortSignal.timeout(45000), sig = signal ? AbortSignal.any([signal, to]) : to;
  try {
    const res = await rpc('tools/call', { name, arguments: a }, sig);
    let out = (res.content || []).map(c => c.type === 'text' ? c.text : '[' + c.type + ']').join('\n').trim() || (res.structuredContent ? JSON.stringify(res.structuredContent) : '(пусто)');
    if (out.length > 14000) out = out.slice(0, 14000) + '\n…(усечено)';
    return res.isError ? 'Ошибка: ' + out : out;
  } catch (e) {
    if (retry && /HTTP 404/.test(e.message)) { st.sid = null; st.tools = null; return webCall(name, args, { signal, session, model }, 0); }
    if (to.aborted && !signal?.aborted) throw new Error('поиск не ответил вовремя');
    throw e;
  }
}
