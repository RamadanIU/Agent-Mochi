/* Проводник: файловая система сервера глазами агента.
   Работает внутри исполнителя (от имени mochi-agent), как run_command и файловые инструменты, — прав ровно столько же.
   При полном доступе (root через sudo) то, на что прав не хватило, исполнитель повторяет от root (runner.js).
   • fsOp(q)        — список папки, сведения, поиск, размер папки, новая папка/файл, переименование, копирование,
                      перенос, удаление, права, сохранение текста из редактора, архивы (что внутри, распаковать, сжать).
                      Ответ — объект или {err, code};
   • fsOpen(q)      — поток байтов файла (с диапазоном — для перемотки видео) или папки архивом .tar.gz → {head, stream};
   • fsPut(q, src)  — загрузка файла в папку: сначала во временный файл рядом, потом под своё имя
                      (без перезаписи: занято — «имя (2).ext»; с over — заменить).
   Пути — абсолютные (или от q.cwd); «~» — домашняя папка агента. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolvePath, decode, encode, atomicWrite, sigOf } from './fileops.js';

const LIST_MAX = 10000, FIND_MAX = 500, FIND_SCAN = 300000, FIND_MS = 8000, DU_MS = 10000, DU_SCAN = 1000000, TEXT_MAX = 8 * 2 ** 20;
/* по этим папкам при поиске и подсчёте размера не ходим: виртуальные файловые системы ядра */
const VIRT = new Set(['/proc', '/sys', '/dev', '/run']);

const fail = (msg, code) => Object.assign(new Error(msg), { soft: true, code });
const who = () => { try { return os.userInfo().username; } catch { return 'mochi-agent'; } };

export function errText(e, p) {
  p = e.path || p || '';
  switch (e.code) {
    case 'ENOENT': return 'нет такого файла или папки: ' + p;
    case 'EACCES': case 'EPERM': return `нет прав: ${p} (Мочи работает как ${who()})`;
    case 'EEXIST': return 'уже есть: ' + path.basename(p);
    case 'ENOTDIR': return 'это не папка: ' + p;
    case 'EISDIR': return 'это папка: ' + p;
    case 'ENOTEMPTY': return 'папка не пустая: ' + p;
    case 'ENOSPC': return 'на диске закончилось место';
    case 'EDQUOT': return 'закончилась квота на диске';
    case 'EROFS': return 'файловая система только для чтения: ' + p;
    case 'EBUSY': return 'занято системой (точка монтирования?): ' + p;
    case 'ELOOP': return 'зацикленная символическая ссылка: ' + p;
    case 'ENAMETOOLONG': return 'слишком длинное имя';
    case 'EINVAL': return 'так нельзя: ' + p;
    default: return e.message;
  }
}

/* ---------- мелочи ---------- */
const kindOf = st => st.isDirectory() ? 'd' : st.isFile() ? 'f' : st.isSymbolicLink() ? 'l' : 'o';
const subKind = st => st.isFIFO() ? 'fifo' : st.isSocket() ? 'sock' : st.isCharacterDevice() ? 'chr' : st.isBlockDevice() ? 'blk' : '';
const inside = (p, root) => p === root || p.startsWith(root === '/' ? '/' : root + '/');

/* имя от человека: без «/», NUL, «.» и «..», не длиннее 255 байт */
function checkName(n) {
  n = String(n ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!n) throw fail('пустое имя');
  if (n === '.' || n === '..') throw fail('так назвать нельзя: ' + n);
  if (/[/\x00]/.test(n)) throw fail('в имени не может быть «/»');
  if (Buffer.byteLength(n) > 255) throw fail('слишком длинное имя (до 255 байт)');
  return n;
}
const splitExt = (n, dir) => { const i = n.lastIndexOf('.'); return !dir && i > 0 ? [n.slice(0, i), n.slice(i)] : [n, '']; };
const exists = p => fsp.lstat(p).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });

/* свободное имя: «имя (копия).ext», «имя (копия 2).ext» / «имя (2).ext» */
async function freeName(dir, name, isDir, tag) {
  if (!await exists(path.join(dir, name))) return name;
  const [b, ext] = splitExt(name, isDir);
  for (let k = tag ? 1 : 2; k < 10000; k++) {
    const n = tag ? `${b} (${tag}${k > 1 ? ' ' + k : ''})${ext}` : `${b} (${k})${ext}`;
    if (!await exists(path.join(dir, n))) return n;
  }
  throw fail('не нашлось свободного имени для ' + name);
}

/* то, что удалять и уносить нельзя: корень, папки верхнего уровня (/etc, /usr…) и домашняя папка агента */
function guard(abs, keep) {
  const list = ['/', ...(Array.isArray(keep) ? keep : []), os.homedir()];
  const bad = p => list.includes(p) || path.dirname(p) === '/';
  let real = abs;
  try { real = fs.lstatSync(abs).isSymbolicLink() ? abs : fs.realpathSync(abs); } catch {}
  if (bad(abs) || bad(real)) throw fail('эту папку трогать нельзя: ' + abs);
}

/* пользователи и группы по номерам — для «Свойств» */
let ids = null, idsAt = 0;
function idNames() {
  if (ids && Date.now() - idsAt < 60000) return ids;
  const read = f => { const m = new Map(); try { for (const l of fs.readFileSync(f, 'utf8').split('\n')) { const a = l.split(':'); if (a.length > 2 && /^\d+$/.test(a[2])) m.set(+a[2], a[0]); } } catch {} return m; };
  idsAt = Date.now();
  return ids = { u: read('/etc/passwd'), g: read('/etc/group') };
}

/* ---------- одна запись папки ---------- */
async function entry(dir, name) {
  const p = path.join(dir, name);
  try {
    const st = await fsp.lstat(p);
    const e = { n: name, t: kindOf(st), s: st.size, m: Math.round(st.mtimeMs), p: st.mode & 0o7777 };
    if (e.t === 'o') e.k = subKind(st);
    if (e.t === 'l') {
      try { e.lk = await fsp.readlink(p); } catch {}
      try { const t = await fsp.stat(p); e.lt = kindOf(t); if (e.lt === 'f') e.s = t.size; } catch { e.lt = 'x'; }
    }
    return e;
  } catch { return { n: name, t: 'o', s: 0, m: 0, p: 0, k: '?' }; }
}
async function entries(dir, names) {
  const out = [];
  for (let i = 0; i < names.length; i += 256) out.push(...await Promise.all(names.slice(i, i + 256).map(n => entry(dir, n))));
  return out;
}

async function df(p) {
  try { const s = await fsp.statfs(p); return { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch { return null; }
}

/* ---------- операции ---------- */
async function listOp(q) {
  const abs = resolvePath(q.path, q.cwd);
  const st = await fsp.stat(abs);
  if (!st.isDirectory()) throw Object.assign(new Error('not dir'), { code: 'ENOTDIR', path: abs });
  const ents = await fsp.readdir(abs, { withFileTypes: true });
  /* слишком большая папка: сначала папки, потом по имени — и только первые LIST_MAX */
  let names = ents.map(e => e.name), cut = 0;
  if (names.length > LIST_MAX) {
    const dirs = new Set(ents.filter(e => e.isDirectory()).map(e => e.name));
    names.sort((a, b) => (dirs.has(b) - dirs.has(a)) || (a < b ? -1 : a > b ? 1 : 0));
    cut = names.length - LIST_MAX; names = names.slice(0, LIST_MAX);
  }
  const [list, real, w, space] = await Promise.all([entries(abs, names), fsp.realpath(abs).catch(() => abs), fsp.access(abs, fs.constants.W_OK).then(() => true, () => false), df(abs)]);
  return { path: abs, real, entries: list, total: ents.length, cut, w, df: space, m: Math.round(st.mtimeMs) };
}

async function statOp(q) {
  const abs = resolvePath(q.path, q.cwd), st = await fsp.lstat(abs), N = idNames();
  const r = { path: abs, name: path.basename(abs) || '/', t: kindOf(st), k: subKind(st), s: st.size, p: st.mode & 0o7777, uid: st.uid, gid: st.gid,
    user: N.u.get(st.uid) ?? String(st.uid), group: N.g.get(st.gid) ?? String(st.gid), nlink: st.nlink, ino: st.ino,
    m: Math.round(st.mtimeMs), a: Math.round(st.atimeMs), c: Math.round(st.ctimeMs), b: st.birthtimeMs > 0 ? Math.round(st.birthtimeMs) : null, sig: sigOf(st) };
  let t = st;
  if (r.t === 'l') {
    try { r.lk = await fsp.readlink(abs); } catch {}
    try { t = await fsp.stat(abs); r.lt = kindOf(t); r.s = t.size; } catch { r.lt = 'x'; }
  }
  r.real = await fsp.realpath(abs).catch(() => abs);
  if (t.isDirectory()) { try { r.items = (await fsp.readdir(abs)).length; } catch {} r.df = await df(abs); }
  r.w = await fsp.access(abs, fs.constants.W_OK).then(() => true, () => false);
  r.r = await fsp.access(abs, fs.constants.R_OK).then(() => true, () => false);
  return r;
}

async function mkdirOp(q) {
  const dir = resolvePath(q.path, q.cwd), name = checkName(q.name), p = path.join(dir, name);
  await fsp.mkdir(p);
  return { path: p, name };
}

async function newFileOp(q) {
  const dir = resolvePath(q.path, q.cwd), name = checkName(q.name), p = path.join(dir, name);
  const fh = await fsp.open(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o666);
  try { if (q.content) await fh.writeFile(String(q.content)); } finally { await fh.close(); }
  return { path: p, name };
}

async function renameOp(q) {
  const abs = resolvePath(q.path, q.cwd), name = checkName(q.name), to = path.join(path.dirname(abs), name);
  if (to === abs) return { path: to, name };
  guard(abs, q.keep);
  await fsp.lstat(abs);
  /* «Файл.txt» → «файл.txt» — та же запись, а не чужая */
  const dst = await fsp.lstat(to).catch(() => null);
  if (dst) { const src = await fsp.lstat(abs); if (dst.ino !== src.ino || dst.dev !== src.dev) throw fail('уже есть: ' + name, 'EEXIST'); }
  await fsp.rename(abs, to);
  return { path: to, name };
}

/* много путей → по каждому свой итог; ошибки собираем, а не обрываем всё на первой */
async function each(q, fn) {
  const paths = (Array.isArray(q.paths) ? q.paths : [q.path]).filter(x => typeof x === 'string' && x.trim()).slice(0, 5000);
  if (!paths.length) throw fail('ничего не выбрано');
  const done = [], errors = [];
  for (const p of paths) {
    if (q.signal?.aborted) break;
    const abs = resolvePath(p, q.cwd);
    try { done.push(await fn(abs)); }
    catch (e) { errors.push({ path: abs, err: e.soft ? e.message : errText(e, abs), code: e.code }); }
  }
  return { done, errors };
}

async function copyOp(q) {
  const dest = resolvePath(q.dest, q.cwd);
  if (!(await fsp.stat(dest)).isDirectory()) throw fail('копировать можно только в папку: ' + dest, 'ENOTDIR');
  const destReal = await fsp.realpath(dest);
  return each(q, async abs => {
    const st = await fsp.lstat(abs), isDir = st.isDirectory();
    if (isDir && inside(destReal, await fsp.realpath(abs))) throw fail('нельзя скопировать папку внутрь неё самой: ' + abs);
    const name = await freeName(dest, path.basename(abs), isDir, 'копия');
    const to = path.join(dest, name);
    await fsp.cp(abs, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
    return { from: abs, path: to, name };
  });
}

async function moveOp(q) {
  const dest = resolvePath(q.dest, q.cwd);
  if (!(await fsp.stat(dest)).isDirectory()) throw fail('переносить можно только в папку: ' + dest, 'ENOTDIR');
  const destReal = await fsp.realpath(dest);
  return each(q, async abs => {
    guard(abs, q.keep);
    const st = await fsp.lstat(abs), to = path.join(dest, path.basename(abs));
    if (to === abs) return { from: abs, path: to, name: path.basename(to), same: true };
    if (st.isDirectory() && inside(destReal, await fsp.realpath(abs))) throw fail('нельзя перенести папку внутрь неё самой: ' + abs);
    if (await exists(to)) throw fail('в папке назначения уже есть ' + path.basename(to), 'EEXIST');
    try { await fsp.rename(abs, to); }
    catch (e) {
      if (e.code !== 'EXDEV') throw e;
      /* другой диск: копия + удаление оригинала */
      await fsp.cp(abs, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
      await fsp.rm(abs, { recursive: true, force: false });
    }
    return { from: abs, path: to, name: path.basename(to) };
  });
}

async function deleteOp(q) {
  return each(q, async abs => {
    guard(abs, q.keep);
    await fsp.lstat(abs);
    await fsp.rm(abs, { recursive: true, force: false, maxRetries: 2 });
    return { path: abs };
  });
}

async function chmodOp(q) {
  const abs = resolvePath(q.path, q.cwd), mode = typeof q.mode === 'string' ? parseInt(q.mode, 8) : +q.mode;
  if (!(mode >= 0 && mode <= 0o7777)) throw fail('неверные права: ' + q.mode);
  await fsp.chmod(abs, mode);
  return { path: abs, p: mode };
}

/* сохранение из редактора: только UTF-8 и только если файл не поменялся с тех пор, как его открыли (expect) */
async function writeOp(q) {
  const abs = resolvePath(q.path, q.cwd), content = String(q.content ?? '');
  if (Buffer.byteLength(content) > TEXT_MAX) throw fail('слишком большой текст для сохранения (до 8 МБ)');
  let fh = null, st = null, buf = null;
  try { fh = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (fh) {
    try {
      st = await fh.stat();
      if (st.isDirectory()) throw fail('это папка: ' + abs, 'EISDIR');
      if (!st.isFile()) throw fail('это не обычный файл: ' + abs);
      if (q.expect && q.expect !== sigOf(st)) return { conflict: true, sig: sigOf(st), m: Math.round(st.mtimeMs), s: st.size };
      if (st.size > TEXT_MAX) throw fail('файл слишком большой для редактора');
      buf = await fh.readFile();
    } finally { await fh.close(); }
  } else if (!q.create) throw Object.assign(new Error('gone'), { code: 'ENOENT', path: abs });
  let data = Buffer.from(content, 'utf8');
  if (buf && buf.length) {
    const d = decode(buf);
    if (d.bin) throw fail('это двоичный файл — как текст его не сохранить');
    if (!d.utf8) throw fail('файл не в UTF-8 — сохранение исказило бы его');
    data = encode(content, d);
  }
  const real = st ? await fsp.realpath(abs) : abs;
  await atomicWrite(real, data, st);
  const ns = await fsp.stat(real);
  return { path: abs, sig: sigOf(ns), s: ns.size, m: Math.round(ns.mtimeMs) };
}

/* поиск по имени вглубь (в ширину, без перехода по ссылкам): подстрока без учёта регистра или маска с * и ? */
async function searchOp(q) {
  const root = resolvePath(q.path, q.cwd), needle = String(q.q ?? '').trim();
  if (!needle) throw fail('что искать?');
  const lc = needle.toLowerCase();
  const re = /[*?]/.test(needle) ? new RegExp('^' + needle.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
  const hit = n => re ? re.test(n) : n.toLowerCase().includes(lc);
  const t0 = Date.now(), found = [], queue = [root];
  let seen = 0, partial = false;
  if (!(await fsp.stat(root)).isDirectory()) throw fail('искать можно только в папке', 'ENOTDIR');
  for (let qi = 0; qi < queue.length; qi++) {
    if (q.signal?.aborted || found.length >= FIND_MAX || seen >= FIND_SCAN || Date.now() - t0 > FIND_MS) { partial = true; break; }
    const d = queue[qi];
    let dir; try { dir = await fsp.opendir(d, { bufferSize: 128 }); } catch { continue; }
    try {
      for await (const ent of dir) {
        seen++;
        if (!q.hidden && ent.name.startsWith('.')) continue;
        const full = path.join(d, ent.name);
        if (hit(ent.name)) found.push([d, ent.name]);
        if (ent.isDirectory() && !VIRT.has(full)) queue.push(full);
        if (found.length >= FIND_MAX) break;
      }
    } catch {}
  }
  const list = [];
  for (let i = 0; i < found.length; i += 256) list.push(...await Promise.all(found.slice(i, i + 256).map(async ([d, n]) => ({ ...await entry(d, n), d }))));
  return { path: root, q: needle, entries: list, partial, seen };
}

/* размер папки целиком (без перехода по ссылкам) */
async function duOp(q) {
  const root = resolvePath(q.path, q.cwd), t0 = Date.now(), stack = [root];
  let size = 0, files = 0, dirs = 0, seen = 0, partial = false, denied = 0;
  const st0 = await fsp.lstat(root);
  if (!st0.isDirectory()) return { path: root, size: st0.size, files: 1, dirs: 0, partial: false };
  while (stack.length) {
    if (q.signal?.aborted || seen >= DU_SCAN || Date.now() - t0 > DU_MS) { partial = true; break; }
    const d = stack.pop();
    let names; try { names = await fsp.readdir(d, { withFileTypes: true }); } catch { denied++; continue; }
    dirs++;
    const sts = await Promise.all(names.map(e => e.isDirectory() ? null : fsp.lstat(path.join(d, e.name)).catch(() => null)));
    names.forEach((e, i) => {
      seen++;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!VIRT.has(full)) stack.push(full); }
      else if (sts[i]) { files++; size += sts[i].size; }
    });
  }
  return { path: root, size, files, dirs: Math.max(0, dirs - 1), partial, denied };
}

/* ---------- архивы: что внутри, распаковать, сжать ----------
   ZIP читаем сами (центральный каталог, распаковка deflate через zlib) — unzip на сервере может не быть;
   tar (.tar, .tar.gz, .tgz, .tar.xz, .tar.bz2) — системным tar. Пути с «..» и абсолютные пропускаем. */
const ARC_MAX = 5000;
const isZip = n => /\.(zip|jar|war|apk|whl|epub|docx|xlsx|pptx|odt|ods|odp)$/i.test(n);
const isTar = n => /\.(tar|tgz|tbz2?|txz|tar\.(gz|bz2|xz|zst|lz|lzma|z))$/i.test(n);
async function readAt(fh, pos, len) { const b = Buffer.alloc(len); const { bytesRead } = await fh.read(b, 0, len, pos); return b.subarray(0, bytesRead); }
const dosTime = (t, d) => new Date(1980 + (d >> 9), (d >> 5 & 15) - 1, d & 31, t >> 11, t >> 5 & 63, (t & 31) * 2).getTime();
async function zipEntries(fh, size) {
  const tail = await readAt(fh, Math.max(0, size - 65557), Math.min(size, 65557));
  const i = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (i < 0) throw fail('это не ZIP-архив или он повреждён');
  let count = tail.readUInt16LE(i + 10), cdSize = tail.readUInt32LE(i + 12), cdOff = tail.readUInt32LE(i + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {
    const li = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]), i);
    if (li < 0) throw fail('архив ZIP64 повреждён');
    const z = await readAt(fh, Number(tail.readBigUInt64LE(li + 8)), 56);
    count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
  }
  if (cdSize > 64 * 2 ** 20) throw fail('слишком большой каталог архива');
  const cd = await readAt(fh, cdOff, cdSize), out = [];
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
    const flag = cd.readUInt16LE(p + 8), nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
    const e = { method: cd.readUInt16LE(p + 10), m: dosTime(cd.readUInt16LE(p + 12), cd.readUInt16LE(p + 14)), cs: cd.readUInt32LE(p + 20), s: cd.readUInt32LE(p + 24),
      unix: cd[p + 5] === 3, mode: cd.readUInt32LE(p + 38) >>> 16, off: cd.readUInt32LE(p + 42), enc: !!(flag & 1) };
    const nb = cd.subarray(p + 46, p + 46 + nl);
    e.n = flag & 0x800 ? nb.toString('utf8') : (() => { try { return new TextDecoder('utf-8', { fatal: true }).decode(nb); } catch { return nb.toString('latin1'); } })();
    /* ZIP64: настоящие размеры и смещение — в дополнительном поле 0x0001 */
    for (let x = p + 46 + nl, end = x + xl; x + 4 <= end; ) {
      const id = cd.readUInt16LE(x), sz = cd.readUInt16LE(x + 2);
      if (id === 1) { let k = x + 4; if (e.s === 0xffffffff) { e.s = Number(cd.readBigUInt64LE(k)); k += 8; } if (e.cs === 0xffffffff) { e.cs = Number(cd.readBigUInt64LE(k)); k += 8; } if (e.off === 0xffffffff) e.off = Number(cd.readBigUInt64LE(k)); }
      x += 4 + sz;
    }
    e.d = e.n.endsWith('/');
    out.push(e);
    p += 46 + nl + xl + cl;
    if (out.length > 200000) break;
  }
  return { entries: out, count };
}
/* имя из архива → безопасный относительный путь (или null) */
function safeRel(n) {
  const parts = String(n).replace(/\\/g, '/').split('/').filter(x => x && x !== '.');
  if (!parts.length || parts.some(x => x === '..')) return null;
  return parts.join('/');
}
function tarList(abs, max = ARC_MAX) {
  return new Promise(ok => {
    let ch, out = '', err = '', n = 0, cut = false;
    try { ch = spawn('tar', ['-tvf', abs], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C.UTF-8' } }); } catch (e) { return ok({ err: e.message }); }
    ch.stdout.on('data', d => { out += d; n = out.split('\n').length; if (n > max + 1) { cut = true; ch.kill(); } });
    ch.stderr.on('data', d => { err = (err + d).slice(-2000); });
    ch.on('error', e => ok({ err: e.code === 'ENOENT' ? 'на сервере нет tar' : e.message }));
    ch.on('close', code => {
      if (code && !cut && !out) return ok({ err: err.trim().split('\n').pop() || 'tar не прочитал архив' });
      const entries = [];
      for (const l of out.split('\n').slice(0, max)) {
        const m = /^([-dlhcbps])\S*\s+\S+\s+(\d+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?)\s+(.*)$/.exec(l);
        if (!m) continue;
        let name = m[4]; if (m[1] === 'l' || m[1] === 'h') name = name.replace(/ (->|link to) .*$/, '');
        entries.push({ n: name + (m[1] === 'd' && !name.endsWith('/') ? '/' : ''), s: +m[2], m: Date.parse(m[3].replace(' ', 'T')) || 0, d: m[1] === 'd', l: m[1] === 'l' });
      }
      ok({ entries, cut });
    });
  });
}
async function archiveOp(q) {
  const abs = resolvePath(q.path, q.cwd), name = path.basename(abs);
  if (isZip(name)) {
    const fh = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      const st = await fh.stat(), { entries, count } = await zipEntries(fh, st.size);
      return { path: abs, kind: 'zip', total: count, cut: entries.length > ARC_MAX, entries: entries.slice(0, ARC_MAX).map(e => ({ n: e.n, s: e.s, m: e.m, d: e.d, enc: e.enc || undefined })) };
    } finally { await fh.close(); }
  }
  if (!isTar(name)) throw fail('этот архив здесь не открыть — распакуй его в терминале');
  await fsp.access(abs, fs.constants.R_OK);
  const r = await tarList(abs);
  if (r.err) throw fail(r.err);
  return { path: abs, kind: 'tar', total: r.entries.length, cut: r.cut, entries: r.entries };
}
async function extractOp(q) {
  const abs = resolvePath(q.path, q.cwd), dir = path.dirname(abs), name = path.basename(abs);
  const stem = name.replace(/\.(tar\.(gz|bz2|xz|zst|lz|lzma|z)|tgz|tbz2?|txz|zip|tar|jar|war|apk|whl|epub)$/i, '') || 'архив';
  if (!isZip(name) && !isTar(name)) throw fail('этот архив здесь не распаковать — попробуй в терминале');
  const dest = path.join(dir, await freeName(dir, stem, true, ''));
  await fsp.mkdir(dest);
  let files = 0, skipped = 0;
  try {
    if (isTar(name)) {
      const r = await new Promise(ok => {
        let err = '';
        const ch = spawn('tar', ['-xf', abs, '-C', dest, '--no-same-owner'], { stdio: ['ignore', 'ignore', 'pipe'] });
        ch.stderr.on('data', d => { err = (err + d).slice(-2000); });
        ch.on('error', e => ok({ err: e.message }));
        ch.on('close', code => ok(code ? { err: err.trim().split('\n').pop() || 'tar завершился с ошибкой' } : {}));
      });
      if (r.err) throw fail(r.err);
      return { path: dest, name: path.basename(dest) };
    }
    const fh = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      const st = await fh.stat(), { entries } = await zipEntries(fh, st.size);
      for (const e of entries) {
        if (q.signal?.aborted) break;
        const rel = safeRel(e.n), isLink = e.unix && (e.mode & 0o170000) === 0o120000;
        if (!rel || e.enc || isLink || (e.method !== 0 && e.method !== 8)) { skipped++; continue; }
        const to = path.join(dest, rel);
        if (e.d) { await fsp.mkdir(to, { recursive: true }); continue; }
        await fsp.mkdir(path.dirname(to), { recursive: true });
        const lh = await readAt(fh, e.off, 30);
        if (lh.readUInt32LE(0) !== 0x04034b50) { skipped++; continue; }
        const start = e.off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        const src = e.cs ? fh.createReadStream({ start, end: start + e.cs - 1, autoClose: false }) : Readable.from([]);
        const out = fs.createWriteStream(to, { flags: 'wx', mode: e.unix && e.mode & 0o111 ? 0o777 : 0o666 });
        await (e.method === 8 ? pipeline(src, zlib.createInflateRaw(), out) : pipeline(src, out));
        if (e.m) await fsp.utimes(to, new Date(e.m), new Date(e.m)).catch(() => {});
        files++;
      }
    } finally { await fh.close(); }
  } catch (e) {
    if (!files) await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return { path: dest, name: path.basename(dest), files, skipped };
}
/* сжать выделенное (из одной папки) в .tar.gz рядом */
async function packOp(q) {
  const paths = (Array.isArray(q.paths) ? q.paths : []).filter(x => typeof x === 'string' && x).map(p => resolvePath(p, q.cwd));
  if (!paths.length) throw fail('ничего не выбрано');
  const dir = path.dirname(paths[0]);
  if (paths.some(p => path.dirname(p) !== dir)) throw fail('сжать можно файлы из одной папки');
  const base = q.name ? checkName(q.name) : (paths.length === 1 ? path.basename(paths[0]) : 'архив') + '.tar.gz';
  const out = path.join(dir, await freeName(dir, base.endsWith('.tar.gz') ? base : base + '.tar.gz', false, ''));
  const r = await new Promise(ok => {
    let err = '';
    const ch = spawn('tar', ['-czf', out, '-C', dir, '--', ...paths.map(p => path.basename(p))], { stdio: ['ignore', 'ignore', 'pipe'] });
    ch.stderr.on('data', d => { err = (err + d).slice(-2000); });
    ch.on('error', e => ok({ err: e.code === 'ENOENT' ? 'на сервере нет tar' : e.message }));
    ch.on('close', code => ok(code ? { err: err.trim().split('\n').pop() || 'tar завершился с ошибкой' } : {}));
  });
  if (r.err) { await fsp.unlink(out).catch(() => {}); throw fail(r.err, /Permission denied/.test(r.err) ? 'EACCES' : undefined); }
  return { path: out, name: path.basename(out) };
}

const OPS = { list: listOp, stat: statOp, mkdir: mkdirOp, newfile: newFileOp, rename: renameOp, copy: copyOp, move: moveOp, delete: deleteOp, chmod: chmodOp, write: writeOp, search: searchOp, du: duOp,
  archive: archiveOp, extract: extractOp, pack: packOp };

/* q: {fop, path, …} → результат или {err, code} (code — чтобы исполнитель мог повторить от root) */
export async function fsOp(q) {
  q = q || {};
  const fn = OPS[q.fop];
  if (!fn) return { err: 'неизвестная операция ' + q.fop };
  if (!['copy', 'move', 'delete', 'pack'].includes(q.fop) && (typeof q.path !== 'string' || !q.path.trim())) return { err: 'не указан путь' };
  try { return await fn(q); }
  catch (e) { return { err: e.soft ? e.message : errText(e, resolvePath(q.path || '', q.cwd)), code: e.code }; }
}

/* ---------- поток байтов: файл (с диапазоном) или папка архивом ---------- */
export async function fsOpen(q) {
  const abs = resolvePath(q.path, q.cwd);
  try {
    if (q.tar) {
      const st = await fsp.stat(abs);
      if (!st.isDirectory()) throw fail('архивом скачиваются только папки');
      if (abs === '/') throw fail('корень целиком в архив не сложить');
      await fsp.access(abs, fs.constants.R_OK | fs.constants.X_OK);
      const ch = spawn('tar', ['-czf', '-', '-C', path.dirname(abs), '--', path.basename(abs)], { stdio: ['ignore', 'pipe', 'ignore'] });
      const err = await new Promise(ok => { ch.once('spawn', () => ok(null)); ch.once('error', e => ok(e)); });
      if (err) throw fail(err.code === 'ENOENT' ? 'на сервере нет tar' : err.message);
      const s = ch.stdout;
      s.once('close', () => { try { ch.kill('SIGKILL'); } catch {} });
      return { head: { name: path.basename(abs) + '.tar.gz', tar: true }, stream: s };
    }
    const fh = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    let st;
    try {
      st = await fh.stat();
      if (st.isDirectory()) throw fail('это папка: ' + abs, 'EISDIR');
      if (!st.isFile()) throw fail('это не обычный файл (устройство, канал или сокет): ' + abs);
    } catch (e) { await fh.close(); throw e; }
    const size = st.size;
    /* last — «последние N байт» (Range: bytes=-N) */
    let start = q.last != null ? Math.max(0, size - Math.floor(+q.last || 0)) : Math.max(0, Math.floor(+q.start || 0));
    let end = q.end == null || q.last != null ? size - 1 : Math.min(size - 1, Math.floor(+q.end));
    if (start > end) { start = 0; end = -1; }
    const head = { name: path.basename(abs), size, m: Math.round(st.mtimeMs), sig: sigOf(st), start, end };
    /* пустой диапазон — пустой поток (createReadStream с end < start читал бы до конца) */
    if (end < start) { await fh.close(); return { head, stream: Readable.from([]) }; }
    const stream = fh.createReadStream({ start, end, highWaterMark: 256 * 1024 });
    return { head, stream };
  } catch (e) {
    return { err: e.soft ? e.message : errText(e, abs), code: e.code };
  }
}

/* ---------- загрузка: q {dir, name, size, over} + поток ровно size байт ----------
   Права проверяются до чтения потока (временный файл создаётся сразу): не хватило — исполнитель
   повторит от root тем же нетронутым потоком. */
export async function fsPrepPut(q) {
  const dir = resolvePath(q.dir, q.cwd);
  let name;
  try {
    name = checkName(q.name);
    if (!(await fsp.stat(dir)).isDirectory()) throw fail('загружать можно только в папку: ' + dir, 'ENOTDIR');
  } catch (e) { return { err: e.soft ? e.message : errText(e, dir), code: e.code }; }
  const tmp = path.join(dir, '.' + name.slice(0, 80) + '.' + crypto.randomBytes(4).toString('hex') + '.part');
  let fh;
  try { fh = await fsp.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o666); }
  catch (e) { return { err: errText(e, dir), code: e.code }; }
  return { dir, name, tmp, fh };
}

export async function fsPut(q, src, prep) {
  prep = prep || await fsPrepPut(q);
  if (prep.err) { src.resume?.(); return prep; }
  const { dir, name, tmp, fh } = prep, size = Math.max(0, Math.floor(+q.size || 0));
  let got = 0;
  try {
    const ws = fh.createWriteStream();
    await pipeline(src, async function* (s) { for await (const c of s) { got += c.length; if (got > size) throw fail('данных больше, чем обещано'); yield c; } }, ws);
    if (got !== size) throw fail('загрузка оборвалась');
  } catch (e) {
    await fh.close().catch(() => {}); await fsp.unlink(tmp).catch(() => {});
    return { err: e.soft ? e.message : errText(e, path.join(dir, name)), code: e.code };
  }
  await fh.close().catch(() => {});
  try {
    let final = name;
    if (q.over) {
      const old = await fsp.lstat(path.join(dir, name)).catch(() => null);
      if (old?.isDirectory()) throw fail('есть папка с таким же именем: ' + name, 'EISDIR');
      if (old) await fsp.chmod(tmp, old.mode & 0o7777).catch(() => {});
      await fsp.rename(tmp, path.join(dir, name));
    } else {
      /* без перезаписи: link() атомарно падает с EEXIST, если имя занято */
      for (let k = 1; ; k++) {
        try { await fsp.link(tmp, path.join(dir, final)); await fsp.unlink(tmp); break; }
        catch (e) {
          if (e.code === 'EEXIST' && k < 10000) { final = await freeName(dir, name, false, ''); continue; }
          if (e.code === 'EPERM' || e.code === 'ENOTSUP' || e.code === 'EOPNOTSUPP') { final = await freeName(dir, name, false, ''); await fsp.rename(tmp, path.join(dir, final)); break; }
          throw e;
        }
      }
    }
    return { path: path.join(dir, final), name: final, size: got };
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    return { err: e.soft ? e.message : errText(e, path.join(dir, name)), code: e.code };
  }
}
