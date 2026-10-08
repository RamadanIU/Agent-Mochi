/* Исполнитель команд агента. Работает отдельной службой от имени mochi-agent (без доступа к данным сервера)
   и слушает unix-сокет, доступный только группе mochi. Протокол — JSON-строки:
     → {id, op:'exec', cmd, cwd, timeout}   ← {id, op:'done', out, code, cwd, timedOut, killed}
     → {id, op:'kill'}
     → {id, op:'info'}                      ← {id, op:'info', ...}
     → {id, op:'spawn', cmd, cwd, env}      ← {id, op:'line', line}…  ← {id, op:'exit', code, err}
     → {id, op:'write', data}               (долгий процесс со stdin/stdout — stdio-серверы MCP)
     → {id, op:'file', fop, path, cwd, …}  ← {id, op:'file', text | err, real, sig, …}   (read_file / edit_file / write_file / view_image)
   Каждая команда — новый bash: текущая папка сохраняется между вызовами (её возвращаем), stdin — /dev/null.
   Прерывание/таймаут убивают всю группу процессов. */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { CFG } from './config.js';
import { fileOp, resolvePath } from './fileops.js';
import { mirror } from './mirror.js';

const SHELL = ['/bin/bash', '/usr/bin/bash'].find(p => fs.existsSync(p)) || '/bin/sh';
const SCRIPT = `trap 'pwd >"$MOCHI_CWDF" 2>/dev/null' EXIT
exec 2>&1
eval "$MOCHI_CMD"`;
const KEEP_HEAD = 4000, KEEP_TAIL = 12000, MEM = 2 * 2 ** 20;

/* убираем цвета и «перерисовки» прогресс-баров — модели нужен чистый текст */
export function cleanOut(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n').map(l => { const i = l.lastIndexOf('\r'); return i >= 0 ? l.slice(i + 1) : l; }).join('\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function agentEnv(home) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^MOCHI_|^NOTIFY_SOCKET$|^INVOCATION_ID$|^JOURNAL_STREAM$/.test(k)) delete e[k];
  const nodeBin = path.dirname(process.execPath);
  return {
    ...e,
    HOME: home, USER: os.userInfo().username, LOGNAME: os.userInfo().username,
    SHELL, LANG: e.LANG || 'C.UTF-8', LC_ALL: e.LC_ALL || 'C.UTF-8',
    PATH: [path.join(home, '.local/bin'), nodeBin, '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'].join(':'),
    NPM_CONFIG_PREFIX: path.join(home, '.local'),
    TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', SYSTEMD_PAGER: '', GIT_TERMINAL_PROMPT: '0',
    DEBIAN_FRONTEND: 'noninteractive', PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONUNBUFFERED: '1',
  };
}

export function execCommand({ cmd, cwd, timeout }, done) {
  const home = os.homedir();
  let dir = cwd && fs.existsSync(cwd) ? cwd : home;
  const sec = Math.min(Math.max(+timeout || 120, 1), 3600);
  const cwdf = path.join(os.tmpdir(), '.mochi-cwd-' + crypto.randomBytes(6).toString('hex'));
  const env = { ...agentEnv(home), MOCHI_CMD: String(cmd), MOCHI_CWDF: cwdf };
  let head = '', tail = '', total = 0, timedOut = false, killed = false, finished = false, killT;
  const t0 = Date.now();
  let ch;
  try {
    ch = spawn(SHELL, ['-c', SCRIPT], { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    done({ out: 'Ошибка запуска: ' + e.message, code: -1, cwd: dir });
    return { kill() {} };
  }
  const scr = mirror(cmd, dir); /* показать команду и вывод в терминале (если он открыт) */
  const dec = new StringDecoder('utf8');
  const onData = b => {
    const s = b.toString('utf8'); total += s.length;
    scr?.out(dec.write(b));
    if (head.length < MEM) head += s; else { tail += s; if (tail.length > MEM) tail = tail.slice(-MEM / 2); }
  };
  ch.stdout.on('data', onData); ch.stderr.on('data', onData);
  const group = sig => { try { process.kill(-ch.pid, sig); } catch { try { ch.kill(sig); } catch {} } };
  const stop = why => {
    if (finished) return;
    if (why === 'time') timedOut = true; else killed = true;
    group('SIGTERM');
    killT = setTimeout(() => group('SIGKILL'), 3000);
  };
  const to = setTimeout(() => stop('time'), sec * 1000);
  const finish = (code, signal) => {
    if (finished) return; finished = true;
    clearTimeout(to); clearTimeout(killT);
    /* фоновые процессы (cmd &) могут держать вывод открытым — не ждём их */
    ch.stdout.destroy(); ch.stderr.destroy();
    let newCwd = dir;
    try { const p = fs.readFileSync(cwdf, 'utf8').trim(); if (p && fs.existsSync(p)) newCwd = p; } catch {}
    try { fs.unlinkSync(cwdf); } catch {}
    let out = cleanOut(head + tail).replace(/\s+$/, '');
    if (out.length > KEEP_HEAD + KEEP_TAIL + 200)
      out = out.slice(0, KEEP_HEAD) + `\n…(пропущено ${out.length - KEEP_HEAD - KEEP_TAIL} символов)…\n` + out.slice(-KEEP_TAIL);
    const res = { out, code: code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : -1), signal, cwd: newCwd, timedOut, killed, ms: Date.now() - t0, bytes: total };
    scr?.end(res);
    done(res);
  };
  ch.on('exit', (code, signal) => setTimeout(() => finish(code, signal), 120));
  ch.on('error', e => { onData(Buffer.from('Ошибка: ' + e.message)); finish(-1); });
  return { kill: () => stop('kill') };
}

/* долгий процесс (stdio-сервер MCP): stdin — наш, stdout — построчно, stderr — хвост для сообщения об ошибке */
const MAX_LINE = 16 * 2 ** 20;
export function spawnProcess({ cmd, cwd, env }, onLine, onExit) {
  const home = os.homedir();
  const dir = cwd && fs.existsSync(cwd) ? cwd : home;
  const extra = {};
  for (const [k, v] of Object.entries(env && typeof env === 'object' ? env : {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/^MOCHI_/.test(k)) extra[k] = String(v);
  let ch, out = '', err = '', finished = false, killT;
  const dec = new StringDecoder('utf8');
  try {
    ch = spawn(SHELL, ['-c', 'eval "$MOCHI_CMD"'], { cwd: dir, env: { ...agentEnv(home), ...extra, MOCHI_CMD: String(cmd) }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    setImmediate(() => onExit(-1, 'Ошибка запуска: ' + e.message));
    return { write() {}, kill() {} };
  }
  const group = sig => { try { process.kill(-ch.pid, sig); } catch { try { ch.kill(sig); } catch {} } };
  const kill = () => { if (finished || killT) return; group('SIGTERM'); killT = setTimeout(() => group('SIGKILL'), 3000); };
  ch.stdout.on('data', b => {
    out += dec.write(b);
    if (out.length > MAX_LINE) { out = ''; err += '\n[слишком длинная строка вывода]'; kill(); return; }
    let i;
    while ((i = out.indexOf('\n')) >= 0) { const l = out.slice(0, i).replace(/\r$/, ''); out = out.slice(i + 1); if (l.trim()) onLine(l); }
  });
  ch.stderr.on('data', b => { err = (err + b.toString('utf8')).slice(-4000); });
  ch.stdin.on('error', () => {});
  ch.on('error', e => { err += '\nОшибка: ' + e.message; });
  /* stderr дочитываем чуть позже: в нём причина падения */
  ch.on('exit', (code, signal) => setTimeout(() => {
    if (finished) return; finished = true; clearTimeout(killT);
    ch.stdout.destroy(); ch.stderr.destroy();
    onExit(code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : -1), cleanOut(err).trim().slice(-1500));
  }, 120));
  return { write: d => { if (!finished && ch.stdin.writable) ch.stdin.write(String(d)); }, kill };
}

let infoCache = null;
export function sysInfo() {
  if (infoCache) return infoCache;
  let osName = os.type();
  try {
    const t = fs.readFileSync('/etc/os-release', 'utf8');
    osName = (t.match(/^PRETTY_NAME="?([^"\n]*)"?/m) || [])[1] || osName;
  } catch {}
  const has = c => { try { execFileSync(SHELL, ['-c', 'command -v ' + c], { stdio: 'ignore' }); return true; } catch { return false; } };
  const pm = ['apt-get', 'dnf', 'yum', 'apk', 'pacman', 'zypper'].find(has) || '';
  let sudo = false;
  if (has(CFG.sudo)) try { execFileSync(CFG.sudo, ['-n', 'true'], { stdio: 'ignore', timeout: 5000 }); sudo = true; } catch {}
  infoCache = {
    os: osName, kernel: os.release(), arch: os.arch(), shell: SHELL, user: os.userInfo().username,
    home: os.homedir(), pm, sudo, root: process.getuid?.() === 0, cpus: os.cpus().length,
    mem: Math.round(os.totalmem() / 2 ** 20), tools: ['git', 'python3', 'curl', 'tmux', 'docker'].filter(has),
  };
  return infoCache;
}

/* ---------- файловые инструменты при полном доступе ----------
   Сначала — от имени mochi-agent (файлы в рабочих папках остаются его). Не хватило прав, а у агента root
   (sudo без пароля) — тот же fileOp ещё раз от root: sudo node mochi.js fileop, запрос JSON на stdin, ответ на stdout.
   Так правка /etc/nginx/… через edit_file работает так же, как через «sudo tee». В разработке — только с MOCHI_AGENT_SUDO=1 */
const MOCHI_JS = fileURLToPath(new URL('../mochi.js', import.meta.url));
const DENIED = new Set(['EACCES', 'EPERM']);
const rootFiles = () => (CFG.agentSudo || !CFG.dev) && process.getuid?.() !== 0 && sysInfo().sudo;

function fileOpAsRoot(q) {
  return new Promise((ok, no) => {
    let ch, out = '', err = '';
    try { ch = spawn(CFG.sudo, ['-n', '--', process.execPath, MOCHI_JS, 'fileop'], { cwd: os.homedir(), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return no(e); }
    const t = setTimeout(() => { try { ch.kill('SIGKILL'); } catch {} }, 120e3);
    ch.stdout.on('data', d => { out += d; });
    ch.stderr.on('data', d => { err = (err + d).slice(-2000); });
    ch.stdin.on('error', () => {});
    ch.on('error', e => { clearTimeout(t); no(e); });
    ch.on('close', code => {
      clearTimeout(t);
      let r = null; try { r = JSON.parse(out); } catch {}
      if (r && typeof r === 'object') ok(r); else no(new Error(cleanOut(err).trim().split('\n').pop() || 'sudo завершился с кодом ' + code));
    });
    ch.stdin.end(JSON.stringify(q));
  });
}

export async function agentFileOp(q) {
  const r = await fileOp(q);
  if (!DENIED.has(r.code) || !rootFiles()) return r;
  /* путь — уже готовый: у root другой HOME, а «~» и относительные пути — от папки агента */
  let r2;
  try { r2 = await fileOpAsRoot({ ...q, path: resolvePath(q.path, q.cwd) }); }
  catch (e) { return { ...r, err: r.err + ` (повторить от root не вышло: ${e.message})` }; }
  if (r2.text && q.fop !== 'read') r2.text += '\n[сделано от root: прав mochi-agent не хватило]';
  return { ...r2, root: true };
}

/* ---------- служба: unix-сокет ---------- */
export function startRunner(sock) {
  try { fs.unlinkSync(sock); } catch {}
  const srv = net.createServer(conn => {
    const jobs = new Map();
    let buf = '';
    const send = o => { if (!conn.destroyed) conn.write(JSON.stringify(o) + '\n'); };
    conn.on('data', d => {
      buf += d.toString('utf8');
      if (buf.length > 32 * 2 ** 20) { conn.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.op === 'exec' && !jobs.has(m.id)) {
          jobs.set(m.id, execCommand(m, r => { jobs.delete(m.id); send({ id: m.id, op: 'done', ...r }); }));
        } else if (m.op === 'spawn' && !jobs.has(m.id)) {
          jobs.set(m.id, spawnProcess(m, line => send({ id: m.id, op: 'line', line }), (code, err) => { jobs.delete(m.id); send({ id: m.id, op: 'exit', code, err }); }));
        } else if (m.op === 'file') {
          agentFileOp(m).then(r => send({ ...r, id: m.id, op: 'file' }), e => send({ id: m.id, op: 'file', err: e.message }));
        } else if (m.op === 'write') jobs.get(m.id)?.write?.(m.data);
        else if (m.op === 'kill') jobs.get(m.id)?.kill();
        else if (m.op === 'info') send({ id: m.id, op: 'info', ...sysInfo() });
      }
    });
    /* сервер отключился (перезапуск) — его команды больше никто не ждёт */
    const drop = () => { for (const j of jobs.values()) j.kill(); jobs.clear(); };
    conn.on('close', drop); conn.on('error', drop);
  });
  const old = process.umask(0o007);
  srv.listen(sock, () => {
    process.umask(old);
    try { fs.chmodSync(sock, 0o660); } catch {}
    console.log('runner: слушаю', sock, 'как', os.userInfo().username);
  });
  return srv;
}
