/* Клиент исполнителя: сервер → unix-сокет службы mochi-runner.
   В режиме разработки (MOCHI_RUNNER_SOCK=inline) команды выполняются прямо в процессе сервера. */
import net from 'node:net';
import { CFG } from './config.js';
import { execCommand, sysInfo } from './runner.js';

let conn = null, buf = '', seq = 0;
const wait = new Map();

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
        const w = wait.get(m.id); if (w) { wait.delete(m.id); w(m); }
      }
    });
    const lost = e => {
      conn = null; buf = '';
      no(e || new Error('closed'));
      for (const [id, w] of wait) { wait.delete(id); w({ op: 'lost' }); }
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

let info = null;
export async function agentInfo() {
  if (info) return info;
  if (CFG.runnerSock === 'inline') return info = sysInfo();
  try { const m = await call({ op: 'info' }); if (m.op === 'info') return info = m; } catch {}
  return { os: 'Linux', kernel: '', arch: process.arch, user: 'mochi-agent', pm: '', sudo: false, tools: [] };
}
