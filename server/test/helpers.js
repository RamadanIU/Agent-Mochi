/* Тестовое окружение: фальшивая модель (OpenAI-совместимая), фальшивый Telegram и сервер Мочи в отдельном процессе */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const sleep = ms => new Promise(r => setTimeout(r, ms));

const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

/* модель: каждый запрос отдаёт следующий ответ из сценария (функция от тела запроса) */
export async function fakeModel(script) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'fake-1' }, { id: 'fake-2' }] })); }
    const body = JSON.parse(b || '{}'); calls.push({ body, auth: req.headers.authorization });
    const step = typeof script === 'function' ? await script(body, calls.length - 1) : script[calls.length - 1] || { text: 'конец' };
    if (step.status) { res.writeHead(step.status); return res.end('{"error":"x"}'); }
    if (step.delay) await sleep(step.delay);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = d => res.write('data: ' + JSON.stringify({ choices: [{ delta: d }] }) + '\n\n');
    if (step.text) for (const w of step.text.match(/.{1,5}/gs)) { ev({ content: w }); await sleep(5); }
    (step.tools || []).forEach((t, i) => ev({ tool_calls: [{ index: i, id: 'c' + calls.length + i, function: { name: t.name, arguments: JSON.stringify(t.args) } }] }));
    res.end('data: [DONE]\n\n');
  });
  const port = await freePort();
  await new Promise(ok => srv.listen(port, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${port}/v1`, calls, close: () => srv.close() };
}

export async function startMochi(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-test-'));
  const port = await freePort();
  const env = { ...process.env, MOCHI_DEV: '1', MOCHI_PORT: String(port), MOCHI_DATA: path.join(dir, 'data'), MOCHI_WORK: path.join(dir, 'work'), MOCHI_SEARCH_MCP: '', HOME: path.join(dir, 'work'), ...extraEnv };
  fs.mkdirSync(env.MOCHI_WORK, { recursive: true });
  const start = () => {
    const p = spawn(process.execPath, [path.join(here, '..', 'mochi.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    p.log = ''; p.stdout.on('data', d => p.log += d); p.stderr.on('data', d => p.log += d);
    return p;
  };
  const m = { dir, port, env, base: `http://127.0.0.1:${port}`, proc: start() };
  m.ready = async () => { for (let i = 0; i < 200; i++) { try { if ((await fetch(m.base + '/api/health')).ok) return; } catch {} await sleep(50); } throw new Error('сервер не стартовал:\n' + m.proc.log); };
  m.restart = async () => { m.proc.kill('SIGTERM'); await new Promise(r => m.proc.once('exit', r)); m.proc = start(); await m.ready(); };
  m.stop = async () => { m.proc.kill('SIGTERM'); await new Promise(r => m.proc.exitCode !== null ? r() : m.proc.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); };
  m.cli = (...a) => new Promise(ok => { const p = spawn(process.execPath, [path.join(here, '..', 'mochi.js'), ...a], { env }); let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d); p.on('exit', c => ok({ code: c, out: o })); });
  await m.ready();
  return m;
}

/* клиент с cookie */
export function client(base) {
  let cookie = '';
  const c = async (p, opt = {}) => {
    const h = { ...(opt.body && typeof opt.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(opt.method && opt.method !== 'GET' ? { 'x-mochi': '1' } : {}), ...(cookie ? { cookie } : {}), ...opt.headers };
    const r = await fetch(base + p, { ...opt, headers: h, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return r;
  };
  c.json = async (p, body, method = 'POST') => { const r = await c(p, { method, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, j: await r.json().catch(() => null) }; };
  /* поток событий: собираем, пока условие не выполнится */
  c.events = (until, ms = 15000) => new Promise(async (ok, no) => {
    const ac = new AbortController(), evs = [];
    const t = setTimeout(() => { ac.abort(); no(new Error('таймаут ожидания событий: ' + JSON.stringify(evs.slice(-5)))); }, ms);
    try {
      const r = await fetch(base + '/api/stream', { headers: { cookie }, signal: ac.signal });
      const dec = new TextDecoder(); let buf = '';
      for await (const ch of r.body) {
        buf += dec.decode(ch, { stream: true }); let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (raw.match(/^event: (.*)$/m) || [])[1], d = (raw.match(/^data: (.*)$/m) || [])[1];
          if (!ev) continue;
          evs.push({ ev, d: JSON.parse(d) });
          if (until(evs)) { clearTimeout(t); ac.abort(); return ok(evs); }
        }
      }
    } catch (e) { if (!ac.signal.aborted) { clearTimeout(t); no(e); } }
  });
  return c;
}

export async function registered(m, name = 'tester') {
  const inv = await m.cli('invite');
  const code = inv.out.match(/[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/)[0];
  const c = client(m.base);
  const r = await c.json('/api/register', { name, password: 'password123', invite: code });
  if (r.status !== 200) throw new Error('регистрация: ' + JSON.stringify(r.j));
  return c;
}
