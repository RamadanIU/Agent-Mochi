/* Простое и надёжное хранилище: JSON-документы в памяти, запись атомарная (tmp + rename), права 0600 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

export function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') {
      /* битый файл не теряем: откладываем в сторону и начинаем с чистого */
      try { fs.renameSync(file, file + '.broken-' + Date.now()); } catch {}
      console.error('store: не прочитался', file, e.message);
    }
    return typeof def === 'function' ? def() : structuredClone(def);
  }
}

export function writeJSONSync(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

const docs = new Set();

/* Документ: объект в памяти + отложенная запись (несколько изменений подряд — одна запись) */
export class Doc {
  constructor(file, def, delay = 250) {
    this.file = file; this.delay = delay; this.t = null;
    this.v = readJSON(file, def);
    docs.add(this);
  }
  save() {
    if (this.t) return;
    this.t = setTimeout(() => this.flush(), this.delay);
    this.t.unref?.();
  }
  flush() {
    if (this.t) { clearTimeout(this.t); this.t = null; }
    try { writeJSONSync(this.file, this.v); } catch (e) { console.error('store: не записалось', this.file, e.message); }
  }
  drop() { if (this.t) clearTimeout(this.t); this.t = null; docs.delete(this); }
}

export function flushAll() { for (const d of docs) if (d.t) d.flush(); }

export const rid = (n = 16) => crypto.randomBytes(n).toString('hex');
export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
