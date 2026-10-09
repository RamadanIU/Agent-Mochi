/* Клиент исполнителя: сервер → unix-сокет службы mochi-runner.
   В режиме разработки (MOCHI_RUNNER_SOCK=inline) команды выполняются прямо в процессе сервера. */
import net from 'node:net';
import { CFG } from './config.js';
import { execCommand, spawnProcess, sysInfo, agentFileOp, agentFsOp, agentFsOpen, agentFsPut } from './runner.js';
import { readHead } from './rawio.js';

let conn = null, buf = '', seq = 0;
const wait = new Map(), subs = new Map();

function connect() {
  if (conn) return conn;
  return conn = new Promise((ok, no) => {
    const c = net.createConnection(CFG.runnerSock);
    c.once('connect', () => ok(c));
    c.on('data', d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (subs.has(m.id)) { subs.get(m.id)(m); continue; }
        const w = wait.get(m.id); if (w) { wait.delete(m.id); w(m); }
      }
    });
    const lost = e => {
      conn = null; buf = ''; info = null; /* исполнитель перезапустился (например, сменился доступ агента) — спросим заново */
      no(e || new Error('closed'));
      for (const [id, w] of wait) { wait.delete(id); w({ op: 'lost' }); }
      for (const s of [...subs.values()]) s({ op: 'exit', code: null, err: 'связь с исполнителем оборвалась' });
    };
    c.on('error', lost); c.on('close', () => lost());
  });
}

async function call(msg, signal) {
  let c;
  try { c = await connect(); }
  catch (e) { throw new Error('исполнитель команд недоступен (служба mochi-runner не запущена?): ' + (e.code || e.message)); }
  const id = ++seq;
  return new Promise(ok => {
    wait.set(id, m => { signal?.removeEventListener('abort', ab); ok(m); });
    const ab = () => c.write(JSON.stringify({ id, op: 'kill' }) + '\n');
    signal?.addEventListener('abort', ab, { once: true });
    c.write(JSON.stringify({ ...msg, id }) + '\n');
  });
}

/* → {out, code, cwd, timedOut, killed} */
export async function runCmd(opts, signal) {
  if (CFG.runnerSock === 'inline') {
    return new Promise(ok => {
      const j = execCommand(opts, ok);
      signal?.addEventListener('abort', () => j.kill(), { once: true });
    });
  }
  const m = await call({ op: 'exec', ...opts }, signal);
  if (m.op === 'lost') return { out: '[связь с исполнителем оборвалась: служба mochi-runner перезапускалась]', code: -1, cwd: opts.cwd, lost: true };
  return m;
}

/* файловая операция от имени агента → {text | err, real, sig, …} (см. fileops.js) */
export async function fileCmd(opts, signal) {
  if (CFG.runnerSock === 'inline') return agentFileOp(opts);
  let m;
  try { m = await call({ ...opts, op: 'file' }, signal); } catch (e) { return { err: e.message }; }
  if (m.op === 'lost') return { err: 'связь с исполнителем оборвалась (служба mochi-runner перезапускалась) — повтори' };
  return m;
}

/* операция проводника от имени агента → объект или {err} (см. fsx.js) */
export async function fsCmd(q, signal) {
  if (CFG.runnerSock === 'inline') return agentFsOp({ ...q, signal });
  let m;
  try { m = await call({ ...q, op: 'fs' }, signal); } catch (e) { return { err: e.message }; }
  if (m.op === 'lost') return { err: 'связь с исполнителем оборвалась (служба mochi-runner перезапускалась) — повтори' };
  delete m.id; delete m.op;
  return m;
}

/* сырое соединение с исполнителем: свой сокет на каждый поток байтов */
function rawSock(q) {
  return new Promise((ok, no) => {
    const c = net.createConnection(CFG.runnerSock);
    c.once('connect', () => { c.off('error', no); c.on('error', () => {}); c.write(JSON.stringify(q) + '\n'); ok(c); });
    c.once('error', e => no(new Error('исполнитель команд недоступен (служба mochi-runner не запущена?): ' + (e.code || e.message))));
  });
}

/* байты файла (q: path, start, end, tar) → {head, stream} или {err} */
export async function fsGet(q) {
  if (CFG.runnerSock === 'inline') return agentFsOpen(q);
  let c;
  try { c = await rawSock({ ...q, op: 'get' }); } catch (e) { return { err: e.message }; }
  try {
    const { head, stream } = await readHead(c);
    if (head.err) { c.destroy(); return head; }
    return { head, stream };
  } catch (e) { c.destroy(); return { err: 'исполнитель не ответил: ' + e.message }; }
}

/* загрузка: q {dir, name, size, over} + поток ровно size байт → {path, name, size} или {err} */
export async function fsUpload(q, src) {
  if (CFG.runnerSock === 'inline') return agentFsPut(q, src);
  let c;
  try { c = await rawSock({ ...q, op: 'put' }); } catch (e) { src.resume(); return { err: e.message }; }
  const size = Math.max(0, Math.floor(+q.size || 0));
  return new Promise(ok => {
    let sent = 0, fin = false;
    const done = r => { if (fin) return; fin = true; src.unpipe?.(c); ok(r); };
    readHead(c).then(({ head }) => { c.end(); done(head); }, e => done({ err: sent < size ? 'загрузка оборвалась' : 'загрузка не удалась: ' + e.message }));
    /* тело обрезано (браузер оборвал загрузку) — рвём и соединение: исполнитель удалит недописанный файл */
    src.on('data', d => { sent += d.length; });
    src.on('end', () => { if (sent < size) c.destroy(); });
    src.on('error', () => c.destroy());
    src.on('close', () => { if (sent < size) c.destroy(); });
    src.pipe(c, { end: false });
  });
}

/* долгий процесс от имени агента (stdio-сервер MCP) → {write, kill} */
export function spawnProc(opts, onLine, onExit) {
  if (CFG.runnerSock === 'inline') return spawnProcess(opts, onLine, onExit);
  const id = ++seq;
  let c = null, dead = false;
  const end = (code, err) => { if (dead) return; dead = true; subs.delete(id); onExit(code, err); };
  subs.set(id, m => { if (m.op === 'line') onLine(m.line); else if (m.op === 'exit') end(m.code, m.err); });
  const ready = connect().then(cc => { c = cc; c.write(JSON.stringify({ ...opts, op: 'spawn', id }) + '\n'); },
    e => end(null, 'исполнитель команд недоступен (служба mochi-runner не запущена?): ' + (e.code || e.message)));
  const send = m => ready.then(() => { if (c && !dead) c.write(JSON.stringify({ ...m, id }) + '\n'); });
  return { write: data => send({ op: 'write', data }), kill: () => send({ op: 'kill' }) };
}

let info = null;
/* fresh — спросить исполнитель заново (настройки → «Доступ агента» показывают, есть ли root прямо сейчас) */
export async function agentInfo(fresh = false) {
  if (info && !fresh) return info;
  if (CFG.runnerSock === 'inline') return info = sysInfo();
  try { const m = await call({ op: 'info' }); if (m.op === 'info') return info = m; } catch {}
  return { os: 'Linux', kernel: '', arch: process.arch, user: 'mochi-agent', pm: '', sudo: false, tools: [] };
}
