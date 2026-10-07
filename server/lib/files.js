/* Файлы: рабочая папка агента ⇄ пользователь.
   Рабочая папка принадлежит агенту, поэтому всё, что там лежит, считаем недоверенным:
   • читаем только обычные файлы, а настоящий путь открытого дескриптора (/proc/self/fd) обязан быть
     внутри MOCHI_WORK — симлинк на данные сервера (/var/lib/mochi/data) не пройдёт;
   • пишем только новые файлы (O_EXCL|O_NOFOLLOW), чтобы агент не подсунул симлинк для перезаписи. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { CFG } from './config.js';
import { Doc, ensureDir, rid } from './store.js';

export const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  html: 'text/html', zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', py: 'text/plain', js: 'text/plain', sh: 'text/plain', log: 'text/plain',
};
export const mime = n => MIME[String(n).split('.').pop().toLowerCase()] || 'application/octet-stream';
export const safeName = n => String(n || '').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120) || 'file';
export const sz = n => n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' КБ' : (n / 1048576).toFixed(1) + ' МБ';

const inside = (p, root) => p === root || p.startsWith(root + path.sep);
let workReal = null;
const work = () => workReal ??= (() => { try { return fs.realpathSync(CFG.work); } catch { return CFG.work; } })();

export function userDir(u) {
  const d = path.join(CFG.work, u.name);
  for (const x of [d, path.join(d, 'inbox'), path.join(d, 'outbox')]) {
    /* группа mochi наследуется от setgid-папки агента; права — rwx для владельца и группы */
    try { fs.mkdirSync(x, { mode: 0o2770 }); try { fs.chmodSync(x, 0o2770); } catch { fs.chmodSync(x, 0o770); } }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  return d;
}

/* настоящий путь открытого дескриптора — после open() его уже не подменить */
const fdPath = fd => { try { return fs.readlinkSync('/proc/self/fd/' + fd); } catch { return null; } };

/* человек → рабочая папка: inbox/<имя>, без перезаписи (имя (2).ext) */
export async function putInbox(u, name, src) {
  const dir = path.join(userDir(u), 'inbox');
  let n = safeName(name), fh;
  for (let k = 1; ; k++) {
    try { fh = await fsp.open(path.join(dir, n), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o660); break; }
    catch (e) {
      if (e.code !== 'EEXIST' || k > 500) throw e;
      n = safeName(name).replace(/(?: \((\d+)\))?(\.[^.]*)?$/, (m, i, ext) => ' (' + (k + 1) + ')' + (ext || ''));
    }
  }
  const real = fdPath(fh.fd);
  if (real && !inside(real, work())) { await fh.close(); await fsp.unlink(real).catch(() => {}); throw new Error('папка inbox указывает за пределы рабочей папки'); }
  let size = 0;
  try {
    const ws = fh.createWriteStream();
    if (Buffer.isBuffer(src)) { size = src.length; if (size > CFG.maxFile) throw new Error('файл больше ' + sz(CFG.maxFile)); await new Promise((ok, no) => ws.end(src, e => e ? no(e) : ok())); }
    else await pipeline(src, async function* (s) { for await (const c of s) { size += c.length; if (size > CFG.maxFile) throw new Error('файл больше ' + sz(CFG.maxFile)); yield c; } }, ws);
  } catch (e) { await fsp.unlink(path.join(dir, n)).catch(() => {}); throw e; }
  finally { await fh.close().catch(() => {}); }
  return { name: n, path: path.join(dir, n), size };
}

/* рабочая папка → хранилище сервера (ссылка на скачивание живёт, даже если агент удалит файл) */
export async function pullFile(p, base) {
  p = String(p || '').trim();
  if (!p) throw new Error('не указан путь к файлу');
  if (p.startsWith('~/')) p = path.join(CFG.work, p.slice(2));
  const abs = path.resolve(base || CFG.work, p);
  let fh;
  try { fh = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); }
  catch (e) { throw new Error(e.code === 'ENOENT' ? 'файл не найден: ' + p : e.code === 'EACCES' ? 'нет прав на чтение (chmod g+r): ' + p : e.message); }
  try {
    const real = fdPath(fh.fd) || abs;
    if (!inside(real, work())) throw new Error('можно отправлять только файлы из рабочей папки ' + CFG.work + ' (скопируй файл туда)');
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('это не обычный файл (для папки сделай архив: tar czf name.tgz папка): ' + p);
    if (st.size > CFG.maxFile) throw new Error('файл ' + sz(st.size) + ' — больше лимита ' + sz(CFG.maxFile));
    return { name: safeName(path.basename(abs)), data: await fh.readFile(), size: st.size };
  } finally { await fh.close(); }
}

/* ---------- хранилище отданных/загруженных файлов пользователя ---------- */
const idx = new Map();
const index = u => {
  if (!idx.has(u.id)) idx.set(u.id, new Doc(path.join(CFG.data, 'users', u.id, 'files.json'), { f: {} }));
  return idx.get(u.id);
};
const blobPath = (u, fid) => path.join(CFG.data, 'users', u.id, 'files', fid);

export async function storeFile(u, name, data, extra = {}) {
  const fid = rid(12);
  ensureDir(path.join(CFG.data, 'users', u.id, 'files'));
  await fsp.writeFile(blobPath(u, fid), data, { mode: 0o600 });
  const d = index(u);
  d.v.f[fid] = { name: safeName(name), size: data.length, mime: mime(name), t: Date.now(), ...extra };
  /* храним последние 300 файлов */
  const ids = Object.keys(d.v.f);
  if (ids.length > 300) for (const old of ids.slice(0, ids.length - 300)) { delete d.v.f[old]; fsp.unlink(blobPath(u, old)).catch(() => {}); }
  d.save();
  return { fid, ...d.v.f[fid] };
}

/* копия загруженного файла для миниатюры в чате (только картинки до 8 МБ) */
export async function storeCopy(u, file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(mime(file.name)) || file.size > 8 * 2 ** 20) return null;
  try { return await storeFile(u, file.name, await fsp.readFile(file.path), { up: 1 }); } catch { return null; }
}

export function getFile(u, fid) {
  if (!/^[0-9a-f]{24}$/.test(fid)) return null;
  const m = index(u).v.f[fid];
  if (!m) return null;
  return { ...m, path: blobPath(u, fid) };
}

export function dropFiles(u) {
  const d = index(u);
  for (const fid of Object.keys(d.v.f)) fsp.unlink(blobPath(u, fid)).catch(() => {});
  d.v.f = {}; d.save();
}
