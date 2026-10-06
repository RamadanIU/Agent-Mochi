/* Пользователи, приглашения, сессии.
   • пароль — scrypt с солью, сравнение за постоянное время;
   • сессия — 32 случайных байта в cookie HttpOnly+Secure+SameSite=Strict, на сервере хранится только её хеш;
   • регистрация — только по одноразовому приглашению (первое печатает установщик): у агента есть
     настоящий shell на сервере, поэтому открытая регистрация = чужой человек с терминалом. */
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { CFG } from './config.js';
import { Doc, rid, sha256 } from './store.js';

const scrypt = promisify(crypto.scrypt);
const SC = { N: 16384, r: 8, p: 1, maxmem: 64 * 2 ** 20 };
const SESSION_TTL = 30 * 24 * 3600e3;
const INVITE_TTL = 7 * 24 * 3600e3;
const ABC = 'abcdefghjkmnpqrstuvwxyz23456789'; /* без похожих символов: l/1, o/0 */

let users, sessions;
export function initAuth() {
  users = new Doc(path.join(CFG.data, 'users.json'), { users: [], invites: [] });
  sessions = new Doc(path.join(CFG.data, 'sessions.json'), { s: {} });
  /* чистим просроченное */
  const now = Date.now();
  for (const [k, s] of Object.entries(sessions.v.s)) if (now - s.seen > SESSION_TTL) delete sessions.v.s[k];
  users.v.invites = users.v.invites.filter(i => i.exp > now);
  sessions.save(); users.save();
}

export const normName = n => String(n || '').trim().toLowerCase();
export const validName = n => /^[a-z0-9][a-z0-9_-]{1,31}$/.test(n);
export const listUsers = () => users.v.users;
export const userById = id => users.v.users.find(u => u.id === id) || null;
export const userByName = n => users.v.users.find(u => u.name === normName(n)) || null;
export const hasUsers = () => users.v.users.length > 0;
export const publicUser = u => u && { id: u.id, name: u.name, admin: !!u.admin, created: u.created };

async function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const h = await scrypt(String(pw).normalize('NFC'), salt, 64, SC);
  return { salt, hash: h.toString('hex') };
}
async function checkPw(u, pw) {
  const { hash } = await hashPw(pw, u.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex'));
}
/* на несуществующего пользователя тратим столько же времени — имя нельзя угадать по задержке */
const DUMMY = { salt: '00', hash: '00'.repeat(64) };

export function pwProblem(pw) {
  pw = String(pw || '');
  if (pw.length < 8) return 'Пароль — минимум 8 символов';
  if (pw.length > 256) return 'Слишком длинный пароль';
  return null;
}

/* ---------- ограничение попыток: 10 ошибок за 15 минут на IP и на имя ---------- */
const fails = new Map();
const WIN = 15 * 60e3, MAXF = 10;
export function limited(...keys) {
  const now = Date.now();
  return keys.some(k => { const f = fails.get(k); return f && now < f.until && f.n >= MAXF; });
}
export function fail(...keys) {
  const now = Date.now();
  for (const k of keys) {
    const f = fails.get(k);
    if (!f || now > f.until) fails.set(k, { n: 1, until: now + WIN });
    else f.n++;
  }
  if (fails.size > 5000) for (const [k, f] of fails) if (now > f.until) fails.delete(k);
}
export const clearFails = (...keys) => keys.forEach(k => fails.delete(k));

/* ---------- приглашения ---------- */
export function createInvite(by = 'cli', ttl = INVITE_TTL) {
  let code = '';
  const b = crypto.randomBytes(12);
  for (const x of b) code += ABC[x % ABC.length];
  code = code.slice(0, 4) + '-' + code.slice(4, 8) + '-' + code.slice(8, 12);
  users.v.invites.push({ h: sha256(code), exp: Date.now() + ttl, by, t: Date.now() });
  users.save();
  return code;
}
function takeInvite(code) {
  const h = sha256(String(code || '').trim().toLowerCase());
  const now = Date.now();
  const i = users.v.invites.findIndex(x => x.exp > now && crypto.timingSafeEqual(Buffer.from(x.h), Buffer.from(h)));
  if (i < 0) return false;
  users.v.invites.splice(i, 1);
  users.save();
  return true;
}
export const inviteCount = () => users.v.invites.filter(i => i.exp > Date.now()).length;

/* ---------- регистрация и вход ---------- */
export async function register(name, pw, invite) {
  name = normName(name);
  if (!validName(name)) throw new Error('Имя: 2–32 символа, латиница, цифры, «-» или «_»');
  const p = pwProblem(pw); if (p) throw new Error(p);
  if (userByName(name)) throw new Error('Такое имя уже занято');
  const first = !hasUsers();
  if (!CFG.allowRegister && !takeInvite(invite)) throw Object.assign(new Error('Код приглашения не подошёл или устарел'), { code: 'invite' });
  const u = { id: rid(8), name, ...(await hashPw(pw)), admin: first, created: Date.now() };
  users.v.users.push(u); users.save();
  return u;
}

export async function login(name, pw) {
  const u = userByName(name);
  const ok = await checkPw(u || DUMMY, pw).catch(() => false);
  return u && ok ? u : null;
}

export async function setPassword(u, pw) {
  const p = pwProblem(pw); if (p) throw new Error(p);
  Object.assign(u, await hashPw(pw)); users.save();
  dropSessions(u.id);
}

export function deleteUser(id) {
  users.v.users = users.v.users.filter(u => u.id !== id); users.save();
  dropSessions(id);
}

/* ---------- сессии ---------- */
export function newSession(u, ua = '') {
  const tok = crypto.randomBytes(32).toString('base64url');
  sessions.v.s[sha256(tok)] = { uid: u.id, t: Date.now(), seen: Date.now(), ua: String(ua).slice(0, 160) };
  sessions.save();
  return tok;
}
export function sessionUser(tok) {
  if (!tok || tok.length > 100) return null;
  const k = sha256(tok), s = sessions.v.s[k];
  if (!s) return null;
  const now = Date.now();
  if (now - s.seen > SESSION_TTL) { delete sessions.v.s[k]; sessions.save(); return null; }
  const u = userById(s.uid);
  if (!u) { delete sessions.v.s[k]; sessions.save(); return null; }
  if (now - s.seen > 3600e3) { s.seen = now; sessions.save(); }
  return u;
}
export function endSession(tok) {
  if (!tok) return;
  delete sessions.v.s[sha256(tok)]; sessions.save();
}
export function dropSessions(uid) {
  for (const [k, s] of Object.entries(sessions.v.s)) if (s.uid === uid) delete sessions.v.s[k];
  sessions.save();
}
export const sessionCount = uid => Object.values(sessions.v.s).filter(s => s.uid === uid).length;
export const SESSION_MAX_AGE = SESSION_TTL / 1000;
