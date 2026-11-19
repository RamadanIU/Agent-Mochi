/* Ключи API для других проектов: OpenAI-совместимый адрес /v1 (gateway.js) открывает провайдеров пользователя наружу.
   • ключ — «sk-pc-» + 32 случайных байта; на сервере хранится только его SHA-256 и подсказка (начало и конец),
     сам ключ показывается один раз — при создании;
   • у ключа может быть: список разрешённых провайдеров, модель по умолчанию, лимит запросов в минуту, срок действия;
   • ключ принадлежит пользователю и ходит к его провайдерам (его ключи, его входы в Qwen, DeepSeek, Kiro, Antigravity);
   • статистика (запросы, токены, ошибки) и последние запросы — чтобы видеть, кто и как пользуется ключом. */
import crypto from 'node:crypto';
import path from 'node:path';
import { CFG } from './config.js';
import { Doc, rid, sha256 } from './store.js';

export const PREFIX = 'sk-pc-';
export const MAX_KEYS = 50;
const RECENT = 30;
const KEY_RE = /^sk-pc-[A-Za-z0-9_-]{43}$/;

let db = null;
const doc = () => db ||= new Doc(path.join(CFG.data, 'apikeys.json'), { keys: [] }, 2000);
const byHash = () => {
  const m = new Map();
  for (const k of doc().v.keys) m.set(k.hash, k);
  return m;
};
let idx = null;
const index = () => idx ||= byHash();
const reindex = () => { idx = null; };

const cleanName = n => String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const cleanModel = m => String(m ?? '').trim().slice(0, 240);
const cleanProvs = p => Array.isArray(p) ? [...new Set(p.map(x => String(x || '').trim().slice(0, 120)).filter(Boolean))].slice(0, 40) : [];
const cleanRpm = r => { const n = Math.round(+r || 0); return n > 0 ? Math.min(n, 100000) : 0; };

/* что видно в настройках: без хеша */
export function pub(k) {
  return { id: k.id, name: k.name, hint: k.hint, created: k.created, last: k.last || 0, exp: k.exp || 0, off: !!k.off,
    expired: !!(k.exp && Date.now() > k.exp), providers: k.providers || [], model: k.model || '', rpm: k.rpm || 0,
    stats: { req: 0, err: 0, in: 0, out: 0, ...(k.stats || {}) }, recent: (k.recent || []).slice(-RECENT).reverse() };
}

export const listKeys = uid => doc().v.keys.filter(k => k.uid === uid).map(pub);
const own = (uid, id) => doc().v.keys.find(k => k.uid === uid && k.id === id) || null;

export function createKey(uid, o = {}) {
  const D = doc().v;
  if (D.keys.filter(k => k.uid === uid).length >= MAX_KEYS) throw Object.assign(new Error('Ключей уже ' + MAX_KEYS + ' — удали ненужные'), { status: 400 });
  const key = PREFIX + crypto.randomBytes(32).toString('base64url');
  const days = Math.round(+o.days || 0);
  if (o.days !== undefined && o.days !== null && o.days !== '' && !(days >= 0 && days <= 3650)) throw Object.assign(new Error('Срок действия — от 1 до 3650 дней (0 — бессрочно)'), { status: 400 });
  const k = {
    id: rid(6), uid, name: cleanName(o.name) || 'Ключ ' + (D.keys.filter(x => x.uid === uid).length + 1),
    hash: sha256(key), hint: key.slice(0, 10) + '…' + key.slice(-4), created: Date.now(), last: 0,
    exp: days > 0 ? Date.now() + days * 864e5 : 0, off: false,
    providers: cleanProvs(o.providers), model: cleanModel(o.model), rpm: cleanRpm(o.rpm),
    stats: { req: 0, err: 0, in: 0, out: 0 }, recent: [],
  };
  D.keys.push(k); doc().save(); reindex();
  return { key, row: pub(k) };
}

export function updateKey(uid, id, b = {}) {
  const k = own(uid, id);
  if (!k) return null;
  if (b.name !== undefined) k.name = cleanName(b.name) || k.name;
  if (b.off !== undefined) k.off = !!b.off;
  if (b.providers !== undefined) k.providers = cleanProvs(b.providers);
  if (b.model !== undefined) k.model = cleanModel(b.model);
  if (b.rpm !== undefined) k.rpm = cleanRpm(b.rpm);
  if (b.days !== undefined) { const d = Math.round(+b.days || 0); k.exp = d > 0 ? Date.now() + Math.min(d, 3650) * 864e5 : 0; }
  if (b.resetStats) { k.stats = { req: 0, err: 0, in: 0, out: 0 }; k.recent = []; }
  doc().save();
  return pub(k);
}

export function deleteKey(uid, id) {
  const D = doc().v, n = D.keys.length;
  D.keys = D.keys.filter(k => !(k.uid === uid && k.id === id));
  if (D.keys.length === n) return false;
  doc().save(); reindex(); rates.delete(id);
  return true;
}
/* пользователя удалили — его ключи больше не действуют */
export function dropUser(uid) {
  const D = doc().v, n = D.keys.length;
  D.keys = D.keys.filter(k => k.uid !== uid);
  if (D.keys.length !== n) { doc().save(); reindex(); }
}

/* ключ из запроса → запись (или почему нет). Сравниваем хеши: сам ключ на сервере не хранится */
export function findKey(token) {
  token = String(token || '').trim();
  if (!KEY_RE.test(token)) return { err: 'invalid' };
  const k = index().get(sha256(token));
  if (!k) return { err: 'invalid' };
  if (k.off) return { err: 'disabled', k };
  if (k.exp && Date.now() > k.exp) return { err: 'expired', k };
  return { k };
}

/* ---------- лимит запросов в минуту: скользящее окно на ключ ---------- */
const rates = new Map();
export function rate(k) {
  if (!k.rpm) return { ok: true };
  const now = Date.now(), w = (rates.get(k.id) || []).filter(t => now - t < 60e3);
  if (w.length >= k.rpm) { rates.set(k.id, w); return { ok: false, limit: k.rpm, left: 0, retry: Math.max(1, Math.ceil((w[0] + 60e3 - now) / 1000)) }; }
  w.push(now); rates.set(k.id, w);
  return { ok: true, limit: k.rpm, left: k.rpm - w.length };
}

/* ---------- учёт: запрос закончился (status — HTTP-код ответа) ---------- */
export function record(k, { model = '', status = 200, inTok = 0, outTok = 0, ms = 0, path: p = '', stream = false, err = '' } = {}) {
  const s = k.stats ||= { req: 0, err: 0, in: 0, out: 0 };
  s.req++; if (status >= 400) s.err++;
  s.in += Math.max(0, Math.round(+inTok || 0)); s.out += Math.max(0, Math.round(+outTok || 0));
  k.last = Date.now();
  const r = k.recent ||= [];
  r.push({ t: k.last, p: String(p).slice(0, 40), model: String(model).slice(0, 120), status, in: Math.round(+inTok || 0), out: Math.round(+outTok || 0), ms: Math.round(ms), ...(stream ? { stream: 1 } : {}), ...(err ? { err: String(err).slice(0, 200) } : {}) });
  if (r.length > RECENT) r.splice(0, r.length - RECENT);
  doc().save();
}

/* ключом пользовались, но не для запроса к модели (список моделей): только время */
export function touch(k) { k.last = Date.now(); doc().save(); }

/* для тестов и выключения сервера */
export const flushKeys = () => db?.flush();
