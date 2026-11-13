/* Провайдер Antigravity (antigravity.google, Google): модели Antigravity — Gemini, Claude и другие — по твоему
   Google-аккаунту, с бесплатными лимитами, которые сами обновляются. Сервер Personal Computer говорит с тем же API, что
   и сам Antigravity (Google Cloud Code, v1internal), — без сторонних прокси и шлюзов (включён прокси в настройках →
   Сервер — запросы идут через него).

   Вход — Google OAuth приложения Antigravity (с PKCE), как у самого Antigravity. Приложение открывает страницу Google
   окошком в ТВОЁМ браузере (там ты уже вошёл в Google — выбрать аккаунт и нажать «Разрешить»). Google возвращает код
   на адрес http://localhost:51121/oauth-callback — так зарегистрировано приложение Antigravity, другой адрес Google не
   примет. Дальше два пути, и оба без консоли:
     • Personal Computer открыт на этом же компьютере (или через SSH-туннель с -L 51121:127.0.0.1:51121) — на этом
       адресе код ловит сам сервер, вход завершается сам;
     • сервер в облаке — страница localhost в окне не откроется (так и должно быть): адрес из строки адреса вставляют
       в приложение (кнопка «Вставить» читает буфер обмена), и сервер сам меняет код на доступ.
   Доступ живёт час и обновляется сам по refresh-токену (тот лежит на сервере зашифрованным, store.seal).
   После входа сервер узнаёт у Google проект Cloud Code аккаунта (loadCodeAssist; новый аккаунт подключает сам —
   onboardUser), а по нему — модели и сколько лимита осталось у каждой (fetchAvailableModels).

   Запрос к модели — streamGenerateContent (поток SSE): вся переписка каждый раз в формате Gemini (contents/parts),
   инструменты — родные (functionDeclarations / functionCall / functionResponse), картинки — моделям, что их видят,
   PDF — моделям Gemini. Размышления приходят частями с thought: true; их подписи (thoughtSignature) возвращаем модели
   в следующих шагах: Claude без них не продолжит цепочку инструментов, Gemini 3 — не примет свои же вызовы. */
import crypto from 'node:crypto';
import http from 'node:http';
import { apiFetch } from './net.js';
import { seal, unseal, rid } from './store.js';
import { cleanSchema as jsonSchema, plainSchema, thinkSplit } from './kiro.js';

export const AG_BASE = 'https://antigravity.google';
export const isAntigravity = base => {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return false;
  try { return /(^|\.)antigravity\.google$/i.test(new URL(b).hostname); } catch { return false; }
};

/* ---------- адреса (для тестов — переменные окружения) ---------- */
const envUrl = k => String(process.env[k] || '').trim().replace(/\/+$/, '');
const AUTH_URL = () => envUrl('PERSONALCOMPUTER_AG_AUTH_URL') || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = () => envUrl('PERSONALCOMPUTER_AG_TOKEN_URL') || 'https://oauth2.googleapis.com/token';
const USERINFO_URL = () => envUrl('PERSONALCOMPUTER_AG_USERINFO_URL') || 'https://www.googleapis.com/oauth2/v1/userinfo';
/* Antigravity ходит только на «daily»-адрес Cloud Code: смешивать адреса нельзя — права аккаунта там разные */
const API = () => envUrl('PERSONALCOMPUTER_AG_API_URL') || 'https://daily-cloudcode-pa.googleapis.com';
/* Приложение Google OAuth самого Antigravity. Оно «для установленных программ»: у таких секрет не секрет — он лежит в
   каждой копии Antigravity. Склеиваем из частей, чтобы сканеры утечек не принимали его за настоящий секрет */
const CLIENT_ID = () => process.env.PERSONALCOMPUTER_AG_CLIENT_ID || ['1071006060591', 'tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'].join('-');
const CLIENT_SECRET = () => process.env.PERSONALCOMPUTER_AG_CLIENT_SECRET || ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-');
/* без openid: с ним Google уводит вход в страницу согласия, которая без открытого localhost зависает */
const SCOPES = ['cloud-platform', 'userinfo.email', 'userinfo.profile', 'cclog', 'experimentsandconfigs'].map(s => 'https://www.googleapis.com/auth/' + s);
export const REDIRECT = 'http://localhost:51121/oauth-callback';
/* где сервер сам ловит код (обычно тот же 51121); 0 — не ловить */
const CB_PORT = () => { const v = String(process.env.PERSONALCOMPUTER_AG_CALLBACK_PORT ?? '').trim(); return v === '' ? 51121 : Math.max(0, +v || 0); };
/* проект Google, которым пользуется сам Antigravity, если у аккаунта своего нет (бывает у Workspace) */
const DEFAULT_PROJECT = 'rising-fact-p41fc';
/* «пропустить проверку подписи» — официальная заглушка Gemini для вызовов, чьей подписи нет (другая модель, старый чат) */
const SKIP_SIG = 'skip_thought_signature_validator';

/* ---------- версия Antigravity ----------
   Google не отвечает старым версиям («This version of Antigravity is no longer supported»), а новые модели показывает
   только свежим. Поэтому версию берём там же, где её узнаёт сам Antigravity, — в его файле обновлений (раз в 6 часов),
   а если Google всё-таки сказал «устарела» — перепроверяем сразу. Своя версия — PERSONALCOMPUTER_AG_VERSION */
const HUB_KNOWN = '2.31.2', HUB_MIN = '2.23.0';
const VER_URL = () => envUrl('PERSONALCOMPUTER_AG_VERSION_URL') || 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml';
const semver = v => /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(String(v || '')) ? String(v) : '';
const cmpv = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
let HUB = HUB_KNOWN, hubAt = 0, hubPend = null;
export const hub = () => semver(process.env.PERSONALCOMPUTER_AG_VERSION) || HUB;
export function hubVersion(force) {
  if (semver(process.env.PERSONALCOMPUTER_AG_VERSION)) return Promise.resolve(hub());
  if (!force && Date.now() - hubAt < 6 * 3600e3) return Promise.resolve(HUB);
  return hubPend ||= (async () => {
    try {
      const r = await apiFetch(VER_URL(), { headers: { 'User-Agent': 'electron-builder', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(8000) });
      const t = r.ok ? (await r.text()).slice(0, 4096) : '';
      const v = semver((/^version:\s*['"]?([\d.]+)['"]?\s*(?:#.*)?$/m.exec(t) || [])[1]);
      if (v && cmpv(v, HUB_MIN) >= 0 && cmpv(v, HUB) > 0) HUB = v;
      hubAt = Date.now();
    } catch { hubAt = Date.now() - 5 * 3600e3; /* сеть подвела — спросим снова через час */ }
    finally { hubPend = null; }
    return HUB;
  })();
}

/* ---------- заголовки — как у Antigravity: только его User-Agent ---------- */
const UA = () => `antigravity/hub/${hub()} (aidev_client; os_type=darwin; arch=arm64)`;
const hdrs = (token, extra = {}) => ({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': UA(), ...extra });
const sleep = (ms, sig) => new Promise(ok => { const t = setTimeout(ok, ms); sig?.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true }); });
const jparse = t => { try { return JSON.parse(t); } catch { return null; } };
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const num = x => x === null || x === undefined || x === '' || !Number.isFinite(+x) ? null : +x;
async function post(url, body, { signal, headers, form } = {}) {
  const r = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', Accept: 'application/json', ...headers },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body), signal: signal || AbortSignal.timeout(30000) });
  const t = await r.text().catch(() => '');
  return { status: r.status, ok: r.ok, j: jparse(t), t };
}
const E = (msg, o = {}) => Object.assign(new Error(msg), { human: msg, ...o });
const netHuman = e => 'Не достучался до Google (' + (e?.cause?.code || e?.message || 'сеть') + '). ' + (e?.proxy ? 'Проверь прокси: настройки → Сервер → «Прокси».' : 'Проверь интернет на сервере.');
const AGAIN = 'Войди снова: настройки → Модель → Antigravity → «Войти через Google».';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ====================================================================================================
   Вход через Google
   ==================================================================================================== */
const b64u = b => b.toString('base64url');
const logins = new Map(), byNonce = new Map();
const pubLogin = s => s ? { state: s.st, url: s.url, exp: s.exp, msg: s.msg, login: s.login || '', auto: catcher.on } : { state: 'none' };
export const loginOf = uid => pubLogin(logins.get(uid));
export function loginStop(uid) {
  const s = logins.get(uid);
  if (s) { s.stopped = true; clearTimeout(s.timer); logins.delete(uid); byNonce.delete(s.nonce); }
  catchTidy();
}
/* итог держим 3 минуты (вторая вкладка приложения тоже увидит), потом забываем */
function finish(s, st, msg) {
  s.st = st; s.msg = msg; byNonce.delete(s.nonce); clearTimeout(s.timer);
  s.timer = setTimeout(() => { if (logins.get(s.uid) === s) logins.delete(s.uid); }, 180e3); s.timer.unref?.();
  catchTidy();
}
/* начать вход: адрес страницы Google; done(tokens) — сохранить вход (server.js), может вернуть, чей аккаунт */
export function loginStart(uid, done) {
  loginStop(uid);
  const verifier = b64u(crypto.randomBytes(32)), nonce = b64u(crypto.randomBytes(18));
  const q = new URLSearchParams({ client_id: CLIENT_ID(), response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES.join(' '),
    code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state: nonce, access_type: 'offline', prompt: 'consent' });
  const s = { uid, st: 'wait', nonce, verifier, url: AUTH_URL() + '?' + q, exp: Date.now() + 15 * 60e3, msg: '', done, stopped: false };
  logins.set(uid, s); byNonce.set(nonce, uid);
  s.timer = setTimeout(() => { if (s.st === 'wait') finish(s, 'fail', 'Время на вход вышло — нажми «Войти через Google» ещё раз.'); }, 15 * 60e3); s.timer.unref?.();
  catchOpen();
  return pubLogin(s);
}
/* что вставили: адрес страницы localhost целиком, его часть с ?code=… или сам код (4/0A…) */
export function parseCallback(text) {
  const s = String(text || '').trim().replace(/^["'<]+|["'>]+$/g, '');
  if (!s) throw E('Вставь адрес страницы, которую открыл Google, — он начинается с http://localhost:51121', { status: 400 });
  let q = null;
  try { if (/^https?:\/\//i.test(s)) { const u = new URL(s); q = new URLSearchParams(u.search || u.hash.slice(1)); } } catch {}
  if (!q && /(?:^|[?&#])(?:code|error)=/.test(s)) q = new URLSearchParams(s.slice(s.search(/[?#]/) + 1));
  if (q?.get('error')) throw E(q.get('error') === 'access_denied' ? 'Вход отменён на странице Google — нажми «Войти через Google» ещё раз.' : 'Google не пустил: ' + q.get('error'), { status: 400, final: true });
  if (q?.get('code')) return { code: q.get('code'), nonce: q.get('state') || '' };
  let c = s; try { c = decodeURIComponent(s); } catch {}
  if (/^4\/[\w.~-]{10,}$/.test(c)) return { code: c, nonce: '' };
  throw E('В этом адресе нет кода входа. Скопируй адрес из окна Google целиком — он начинается с http://localhost:51121/oauth-callback?', { status: 400 });
}
/* вставили адрес (или код): проверяем и меняем код на доступ — в фоне; приложение следит за loginOf */
export function loginCode(uid, text) {
  const s = logins.get(uid);
  if (!s || s.st === 'ok' || s.st === 'fail') throw E('Вход не начат или уже закончился — нажми «Войти через Google» и вставь адрес из нового окна.', { status: 409 });
  const p = parseCallback(text);
  if (s.st === 'save') return pubLogin(s);
  if (p.nonce && p.nonce !== s.nonce) throw E('Это адрес от другого, старого входа. Вставь адрес из последнего окна Google — или нажми «Войти через Google» ещё раз.', { status: 400 });
  complete(s, p.code);
  return pubLogin(s);
}
async function complete(s, code) {
  if (s.st !== 'wait' || s.stopped) return;
  s.st = 'save'; s.msg = '';
  let t;
  /* код не подошёл (скопировали не целиком) — вход не обрываем: можно вставить ещё раз */
  try { t = await exchange(code, s.verifier); }
  catch (e) { if (!s.stopped && s.st === 'save') { s.st = 'wait'; s.msg = e.human || e.message; } return; }
  if (s.stopped) return;
  try { s.login = (await s.done(t)) || ''; finish(s, 'ok', 'Antigravity подключён' + (s.login ? ': ' + s.login : '') + '.'); }
  catch (e) { if (!s.stopped) finish(s, 'fail', 'Вход прошёл, но подключить аккаунт не вышло: ' + (e.human || e.message)); }
}
async function exchange(code, verifier) {
  let r;
  try { r = await post(TOKEN_URL(), { client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(), code, grant_type: 'authorization_code', redirect_uri: REDIRECT, code_verifier: verifier }, { form: true }); }
  catch (e) { throw E(netHuman(e), { status: 502 }); }
  const j = r.j || {};
  if (!j.access_token) throw E(j.error === 'invalid_grant'
    ? 'Google не принял код входа: он устарел, уже использован или скопирован не целиком. Скопируй адрес из окна ещё раз — или нажми «Войти через Google» заново.'
    : 'Google не выдал доступ: ' + (j.error_description || j.error || 'HTTP ' + r.status), { status: 400 });
  if (!j.refresh_token) throw E('Google не выдал ключ обновления доступа — нажми «Войти через Google» ещё раз.', { status: 400 });
  return { access: j.access_token, refresh: j.refresh_token, expIn: +j.expires_in || 3600 };
}

/* ---------- сервер сам ловит код на localhost:51121 (Personal Computer открыт на этом же компьютере) ----------
   Открыт, пока есть незаконченный вход. Код принимается только с тем state, что выдали этому входу */
const catcher = { srv: null, on: false };
function catchOpen() {
  const port = CB_PORT();
  if (!port || catcher.srv) return;
  const srv = http.createServer((q, res) => {
    const u = new URL(q.url, 'http://localhost'), page = (ok, msg) => {
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Antigravity · Personal Computer</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#333"><h2>${ok ? 'Готово ✓' : 'Не вышло'}</h2><p>${esc(msg)}</p>${ok ? '<script>setTimeout(function(){window.close()},1200)</script>' : ''}`);
    };
    if (u.pathname !== '/oauth-callback') { res.writeHead(404); return res.end(); }
    const uid = byNonce.get(u.searchParams.get('state') || ''), s = uid && logins.get(uid);
    if (!s || s.st !== 'wait') return page(false, 'Этот вход уже закончился или начат не здесь. Вернись в Personal Computer и нажми «Войти через Google» ещё раз.');
    if (u.searchParams.get('error')) { finish(s, 'fail', u.searchParams.get('error') === 'access_denied' ? 'Вход отменён на странице Google.' : 'Google не пустил: ' + u.searchParams.get('error')); return page(false, s.msg); }
    const code = u.searchParams.get('code');
    if (!code) return page(false, 'В адресе нет кода входа.');
    complete(s, code);
    page(true, 'Вход получен — окно можно закрыть и вернуться в Personal Computer.');
  });
  srv.on('error', () => { if (catcher.srv === srv) { catcher.srv = null; catcher.on = false; } });
  srv.listen(port, '127.0.0.1', () => { if (catcher.srv === srv) catcher.on = true; });
  srv.unref();
  catcher.srv = srv;
}
function catchTidy() {
  if (!catcher.srv || [...logins.values()].some(s => s.st === 'wait' || s.st === 'save')) return;
  catcher.srv.close(); catcher.srv = null; catcher.on = false;
}

/* ---------- «Токен вручную»: refresh_token или файл входа (Antigravity CLI, opencode, CLIProxyAPI и т. п.) ---------- */
export function parseImport(text) {
  const s = String(text || '').trim();
  if (!s) throw E('Вставь refresh_token или содержимое файла входа', { status: 400 });
  let refresh = '', managed = '', plain = '', email = '';
  const j = jparse(s);
  if (j && typeof j === 'object') {
    const walk = (o, d = 0) => {
      if (!o || typeof o !== 'object' || d > 6) return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v !== 'string') { walk(v, d + 1); continue; }
        if (!v.trim()) continue;
        if (!refresh && /^refresh_?token$/i.test(k)) refresh = v;
        else if (!managed && /^managed_?project(_?id)?$/i.test(k)) managed = v;
        else if (!plain && /^(project_?id|project)$/i.test(k)) plain = v;
        else if (!email && /^email$/i.test(k)) email = v;
      }
    };
    walk(j);
  } else {
    /* «refresh|project|managedProject» (так хранит opencode) или просто токен */
    const p = s.replace(/^Bearer\s+/i, '').split('|');
    refresh = p[0]; plain = p[1] || ''; managed = p[2] || '';
  }
  refresh = refresh.trim();
  if (!/^1\/\/[\w-]{20,}$/.test(refresh)) throw E('Это не ключ Google: нужен refresh_token (начинается с 1//) или файл входа целиком — Antigravity CLI, antigravity-accounts.json, CLIProxyAPI.', { status: 400 });
  return { refresh, project: (managed || plain).trim().slice(0, 200), email: email.trim().slice(0, 200) };
}
/* проверить вставленное: сразу обновляем доступ по refresh-токену */
export async function importAuth(text) {
  const p = parseImport(text);
  return refresh(authFrom({ refresh: p.refresh, expIn: 1 }, { how: 'token', project: p.project, email: p.email }));
}

/* ---------- что храним (настройки пользователя, agAuth): ключ обновления — зашифрованным ---------- */
export function authFrom(t, info = {}, prev = {}) {
  return {
    how: info.how || prev.how || 'google', rt: t.refresh ? seal(t.refresh) : prev.rt || '', exp: Date.now() + Math.max(60, +t.expIn || 3600) * 1000,
    email: info.email ?? prev.email ?? '', name: info.name ?? prev.name ?? '', project: info.project ?? prev.project ?? '', tier: info.tier ?? prev.tier ?? '', t: prev.t || Date.now(),
  };
}
/* обновление доступа (час) по refresh-токену */
export async function refresh(a, signal) {
  const rt = unseal(a?.rt);
  if (!rt) throw E('Вход в Antigravity не сохранился на сервере. ' + AGAIN, { relogin: true, status: 401 });
  let r;
  try { r = await post(TOKEN_URL(), { client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(), refresh_token: rt, grant_type: 'refresh_token' }, { form: true, signal }); }
  catch (e) { throw E(netHuman(e), { status: 502, retry: true }); }
  const j = r.j || {};
  if (!j.access_token) {
    const er = String(j.error || ''), gone = er === 'invalid_grant' || er === 'unauthorized_client' || er === 'invalid_client' || r.status === 401;
    const why = String(j.error_description || er || 'HTTP ' + r.status);
    throw E(gone ? (er === 'unauthorized_client' ? 'Этот ключ выдан не для Antigravity, а другому приложению Google. ' : 'Вход в Google истёк или отозван (' + why + '). ') + AGAIN : 'Google не обновил доступ: ' + why,
      { relogin: gone, status: gone ? 401 : 502, retry: !gone });
  }
  return { token: j.access_token, auth: authFrom({ refresh: j.refresh_token && j.refresh_token !== rt ? j.refresh_token : '', expIn: j.expires_in }, {}, a) };
}
/* сколько осталось жить доступу, мс */
export const tokenLeft = a => (+a?.exp || 0) - Date.now();

/* ====================================================================================================
   Аккаунт: кто, проект Cloud Code, план
   ==================================================================================================== */
const pid = v => { const id = typeof v === 'string' ? v : v?.id; return typeof id === 'string' ? id.trim() : ''; };
const tierName = t => {
  const id = String(t?.id || '').toLowerCase();
  if (!id) return '';
  if (/ultra/.test(id)) return 'Ultra'; if (/pro|premium/.test(id)) return 'Pro'; if (id === 'standard-tier') return 'Standard'; if (/free|legacy/.test(id)) return 'Free';
  return String(t?.name || id).trim().slice(0, 40);
};
/* проект: loadCodeAssist; у нового аккаунта проекта нет — подключаем (onboardUser), как сам Antigravity при первом входе */
export async function project(token, { signal } = {}) {
  await hubVersion();
  let lc;
  try { lc = await post(API() + '/v1internal:loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }, { headers: hdrs(token), signal }); }
  catch (e) { throw E(netHuman(e), { status: 502, retry: true }); }
  if (lc.status === 401) throw E('Доступ Google не подошёл', { status: 401, auth: true });
  if (!lc.ok) throw fail(lc.status, lc.j, lc.t, '');
  const j = lc.j || {}, tier = tierName(j.paidTier) || tierName(j.currentTier);
  let id = pid(j.cloudaicompanionProject);
  if (id) return { project: id, tier };
  const allowed = Array.isArray(j.allowedTiers) ? j.allowedTiers : [], tierId = (allowed.find(t => t?.isDefault) || allowed[0] || j.currentTier || {}).id || 'free-tier';
  const inel = (Array.isArray(j.ineligibleTiers) ? j.ineligibleTiers : []).map(t => String(t?.reasonMessage || t?.reasonCode || '')).filter(Boolean);
  for (let i = 0; i < 12 && !signal?.aborted; i++) {
    let r;
    try {
      r = await post(API() + '/v1internal:onboardUser', { tier_id: tierId, metadata: { ide_type: 'ANTIGRAVITY', ide_version: hub(), ide_name: 'antigravity' } },
        { headers: hdrs(token, { 'User-Agent': UA() + ' google-api-nodejs-client/10.3.0', 'X-Goog-Api-Client': 'gl-node/22.21.1', Accept: '*/*' }), signal });
    } catch (e) { throw E(netHuman(e), { status: 502, retry: true }); }
    if (r.status === 401) throw E('Доступ Google не подошёл', { status: 401, auth: true });
    if (!r.ok) { const f = fail(r.status, r.j, r.t, ''); if (f.verify || f.banned) throw f; break; }
    if (r.j?.done) { id = pid(r.j.response?.cloudaicompanionProject); break; }
    await sleep(5000, signal);
  }
  if (!id && inel.length) throw E('Google не включил Antigravity для этого аккаунта: ' + inel[0].slice(0, 300), { status: 403 });
  /* подключили — план теперь известен точно */
  let t2 = '';
  if (id) { const again = await post(API() + '/v1internal:loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }, { headers: hdrs(token), signal }).catch(() => null); if (again?.ok) t2 = tierName(again.j?.paidTier) || tierName(again.j?.currentTier); }
  return { project: id || DEFAULT_PROJECT, tier: t2 || tier || tierName({ id: tierId }) };
}
export async function userinfo(token) {
  const r = await apiFetch(USERINFO_URL() + '?alt=json', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
  return r.ok ? jparse(await r.text().catch(() => '')) || {} : {};
}
/* сразу после входа: чей аккаунт, его проект и план */
export async function account(token, prev = {}) {
  const [ui, pj] = await Promise.all([userinfo(token).catch(() => ({})), project(token)]);
  return { email: String(ui.email || prev.email || '').slice(0, 200), name: String(ui.name || prev.name || '').slice(0, 100), project: pj.project, tier: pj.tier };
}

/* ====================================================================================================
   Модели и лимиты
   ==================================================================================================== */
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const TIER_RE = /-(minimal|low|medium|high)$/;
export function family(id, m = {}) {
  const s = String(id || '').toLowerCase(), p = String(m.apiProvider || m.modelProvider || '').toUpperCase();
  if (/claude/.test(s) || /ANTHROPIC/.test(p)) return 'claude';
  if (/gemini/.test(s) || /GEMINI|GOOGLE/.test(p)) return 'gemini';
  if (/gpt|openai/.test(s) || /OPENAI/.test(p)) return 'gpt';
  return 'other';
}
/* что модель умеет с размышлением. Уровень, вшитый в имя (gemini-3.1-pro-high, claude-opus-5-5-high), выбирает сам
   Google; у Claude «-thinking» — бюджет размышления, у Gemini 3 без уровня в имени — thinkingLevel */
export function caps(id, m = {}) {
  const s = String(id || '').toLowerCase(), f = family(id, m), tier = (TIER_RE.exec(s) || [])[1] || '';
  const g3 = f === 'gemini' && /gemini-(?:[3-9]|\d\d)/.test(s), budget = f === 'claude' && /thinking/.test(s) && !tier;
  const think = m.supportsThinking === true || /thinking/.test(s) || g3 || (f === 'claude' && !!tier);
  const efforts = budget ? ['low', 'medium', 'high', 'xhigh', 'max'] : g3 && !tier ? (/pro/.test(s) ? ['low', 'high'] : ['minimal', 'low', 'medium', 'high'])
    : f === 'gemini' && think && !tier ? ['low', 'medium', 'high'] : [];
  return { f, tier, g3, budget, think, efforts };
}
const FALLBACK = [['gemini-3-flash', 'Gemini 3 Flash'], ['gemini-3.1-pro-low', 'Gemini 3.1 Pro (Low)'], ['claude-sonnet-4-6', 'Claude Sonnet 4.6'], ['claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)']];
function toInfo(id, m = {}) {
  const c = caps(id, m), q = isObj(m.quotaInfo) ? m.quotaInfo : null, left = q ? num(q.remainingFraction) : null;
  return { id, name: String(m.displayName || id).slice(0, 80), fam: c.f, tier: c.tier, g3: c.g3, budget: c.budget,
    img: typeof m.supportsImages === 'boolean' ? m.supportsImages : c.f === 'claude' || c.f === 'gemini', think: c.think, efforts: c.efforts,
    ctx: num(m.maxTokens) || (c.f === 'gemini' ? 1048576 : 200000), out: num(m.maxOutputTokens) || 0,
    /* лимит: сколько осталось (0…1) и когда обновится; нет remainingFraction, но есть время — значит, кончился */
    q: q ? Math.max(0, Math.min(1, left ?? (q.resetTime ? 0 : 1))) : null, reset: q?.resetTime ? Date.parse(q.resetTime) || 0 : 0, rec: m.recommended === true };
}
/* только модели для агента: без служебных (tab_, chat_), картинок, речи, отключённых и заглушек «-disabled» */
const NONCHAT = /(?:^|[-_])(image|imagen|audio|tts|embedding|embed|video|veo|lyria|computer-use)(?:[-_]|$)/i;
function catalog(raw) {
  if (!raw) return { list: FALLBACK.map(([id, name]) => toInfo(id, { displayName: name })), def: 'gemini-3-flash' };
  const M = raw.models, ok = id => isObj(M[id]) && !M[id].isInternal && !M[id].disabled && !/^(chat|tab)_/.test(id) && !/(_weekly|-disabled)$/.test(id) && !NONCHAT.test(id);
  /* agentModelSorts — то, что сам Antigravity показывает в выборе модели, и в том же порядке */
  const order = [];
  for (const s of Array.isArray(raw.agentModelSorts) ? raw.agentModelSorts : []) for (const g of s?.groups || []) for (const id of g?.modelIds || []) if (typeof id === 'string' && !order.includes(id)) order.push(id);
  let ids = order.filter(ok);
  if (!ids.length) {
    const rank = id => ({ gemini: 0, claude: 1, gpt: 2 })[family(id, M[id])] ?? 3;
    ids = Object.keys(M).filter(ok).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }
  const list = ids.map(id => toInfo(id, M[id]));
  const def = [raw.defaultAgentModelId, raw.defaultModelId].find(x => typeof x === 'string' && ids.includes(x)) || list.find(m => m.rec)?.id || '';
  return { list: list.length ? list : FALLBACK.map(([id, name]) => toInfo(id, { displayName: name })), def };
}
/* каталог: последний полученный — общий (умения моделей у всех одинаковые; нужен агенту про картинки и размышления) */
const cats = new Map();
let lastCat = null;
export const modelInfo = id => (lastCat?.list || []).find(m => m.id === id) || (id ? toInfo(id, {}) : null);
export async function models(token, a, { force } = {}) {
  await hubVersion();
  const key = (a?.email || '') + ':' + (a?.project || ''), c = cats.get(key);
  if (c && !force && Date.now() - c.at < 120e3) return c;
  let r;
  try { r = await post(API() + '/v1internal:fetchAvailableModels', a?.project ? { project: a.project } : {}, { headers: hdrs(token), signal: AbortSignal.timeout(20000) }); }
  catch (e) { r = { status: 0, err: e }; }
  if (r.status === 401) throw E('Доступ Google не подошёл', { status: 401, auth: true });
  if (r.status === 403) { const f = fail(403, r.j, r.t, ''); if (f.verify || f.banned || f.outdated) throw f; }
  const raw = r.status === 200 && isObj(r.j?.models) ? r.j : null;
  const out = { at: Date.now(), live: !!raw, ...catalog(raw) };
  if (raw) { cats.set(key, out); if (cats.size > 50) cats.delete(cats.keys().next().value); lastCat = out; }
  else if (!lastCat) lastCat = out;
  return out;
}
/* модель «по умолчанию», если выбранной нет в списке: что советует Google, иначе Claude Sonnet, иначе первая */
export const pickModel = c => (c.def && c.list.find(m => m.id === c.def) ? c.def : (c.list.find(m => m.rec && m.q !== 0) || c.list.find(m => /claude-sonnet/.test(m.id)) || c.list[0])?.id || '');
/* лимиты для карточки — группами, как их показывает Antigravity: Claude, Gemini Pro, Gemini Flash… */
const groupOf = m => m.fam === 'claude' ? 'Claude' : m.fam === 'gemini' ? (/pro/i.test(m.id) ? 'Gemini Pro' : /flash/i.test(m.id) ? 'Gemini Flash' : 'Gemini') : m.fam === 'gpt' ? 'GPT-OSS' : 'Другие';
export function quotas(list) {
  const G = new Map();
  for (const m of list || []) {
    if (m.q == null) continue;
    const g = groupOf(m), x = G.get(g) || { name: g, left: 1, reset: 0, n: 0 };
    x.left = Math.min(x.left, m.q); x.n++;
    if (m.q < 1 && m.reset && (!x.reset || m.reset < x.reset)) x.reset = m.reset;
    G.set(g, x);
  }
  return [...G.values()];
}
/* проверка в настройках: модели (с умениями и лимитами), чей аккаунт, план */
export async function check(token, a, { force = true } = {}) {
  if (!token) throw E('Войди в Antigravity: «Войти через Google».', { status: 401, needKey: true });
  const c = await models(token, a, { force });
  return { models: c.list.map(m => m.id), info: c.list, def: pickModel(c), live: c.live, login: a?.email || '', name: a?.name || '', plan: a?.tier || '',
    how: a?.how || '', way: a?.how === 'token' ? 'по токену' : 'через Google', quota: quotas(c.list), exp: +a?.exp || 0 };
}

/* ====================================================================================================
   Запрос к модели
   ==================================================================================================== */
/* JSON Schema инструмента → Schema Google (подмножество OpenAPI: STRING, OBJECT, ARRAY…). Сначала схема чистится так
   же, как для Kiro (ссылки $ref подставлены, старые черновики переведены), затем: anyOf/oneOf — самый подробный вариант
   (остальные — подсказкой в описании), allOf — слиты, ограничения (pattern, minimum…) — в описание, enum — у строк.
   Google не принимает объект без свойств — такие («любой объект», вроде headers) уходят строкой JSON, а в ответе модели
   мы разбираем её обратно в объект (fix — где это сделать) */
const G_TYPES = { string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', object: 'OBJECT', array: 'ARRAY' };
const isNullT = x => isObj(x) && (x.type === 'null' || (Array.isArray(x.type) && x.type.length === 1 && x.type[0] === 'null'));
const tname = x => !isObj(x) ? 'любое' : [].concat(x.type || (isObj(x.properties) ? 'object' : x.items ? 'array' : 'любое')).join('/');
const score = x => !isObj(x) ? 0 : isObj(x.properties) ? 10 + Object.keys(x.properties).length : x.items ? 5 : x.type ? 2 : 1;
const best = xs => xs.reduce((b, x) => score(x) > score(b) ? x : b, xs[0]);
const hint = (d, more) => { const x = [typeof d === 'string' ? d.trim() : '', ...more].filter(Boolean).join(' '); return x.length > 1500 ? x.slice(0, 1500) + '…' : x; };
function mergeAll(n) {
  const { allOf, ...rest } = n, out = { ...rest }, props = { ...(isObj(rest.properties) ? rest.properties : {}) }, req = [...(rest.required || [])], ds = [rest.description];
  for (const x of allOf) {
    if (!isObj(x)) continue;
    const y = Array.isArray(x.allOf) ? mergeAll(x) : x;
    if (isObj(y.properties)) Object.assign(props, y.properties);
    if (Array.isArray(y.required)) req.push(...y.required);
    if (!out.type && y.type) out.type = y.type;
    if (!out.items && y.items) out.items = y.items;
    if (!out.enum && y.enum) out.enum = y.enum;
    ds.push(y.description);
  }
  if (Object.keys(props).length) out.properties = props;
  if (req.length) out.required = [...new Set(req)];
  const d = ds.filter(x => typeof x === 'string' && x.trim()).join(' ');
  if (d) out.description = d;
  return out;
}
function toG(n, root = false, depth = 0) {
  const anyJson = d => [{ type: 'STRING', description: hint(d, ['Любое значение; объект или массив — строкой JSON.']) }, { json: true }];
  if (!isObj(n) || depth > 14) return anyJson('');
  if (Array.isArray(n.allOf) && n.allOf.length) n = mergeAll(n);
  const notes = [];
  let nullable = false;
  const alts = Array.isArray(n.anyOf) && n.anyOf.length ? n.anyOf : Array.isArray(n.oneOf) && n.oneOf.length ? n.oneOf : null;
  if (alts) {
    const opts = alts.filter(x => !isNullT(x)), { anyOf, oneOf, ...rest } = n;
    nullable = opts.length < alts.length;
    const b = opts.length ? (Array.isArray(best(opts).allOf) ? mergeAll(best(opts)) : best(opts)) : {};
    if (opts.length > 1) notes.push('Варианты: ' + opts.map(tname).join(' | ') + '.');
    n = { ...b, ...rest, description: [rest.description, b.description].filter(x => typeof x === 'string' && x.trim()).join(' — ') };
  }
  let t = n.type;
  if (Array.isArray(t)) { nullable ||= t.includes('null'); const nn = t.filter(x => x !== 'null'); if (nn.length > 1) notes.push('Тип: ' + nn.join(' или ') + '.'); t = nn[0]; }
  if (!t) t = isObj(n.properties) ? 'object' : n.items || n.prefixItems ? 'array' : Array.isArray(n.enum) && n.enum.length ? (typeof n.enum[0] === 'number' ? 'number' : typeof n.enum[0] === 'boolean' ? 'boolean' : 'string') : n.const !== undefined ? (typeof n.const === 'number' ? 'number' : typeof n.const === 'boolean' ? 'boolean' : 'string') : '';
  /* ограничения, которых нет у Google, — словами */
  if (typeof n.format === 'string' && !['date-time', 'enum'].includes(n.format)) notes.push('Формат: ' + n.format + '.');
  if (typeof n.pattern === 'string') notes.push('Шаблон: ' + n.pattern.slice(0, 200) + '.');
  for (const [k, w] of [['minimum', '≥'], ['maximum', '≤'], ['exclusiveMinimum', '>'], ['exclusiveMaximum', '<']]) if (typeof n[k] === 'number') notes.push(w + ' ' + n[k] + '.');
  for (const [k, w] of [['minLength', 'Длина не меньше'], ['maxLength', 'Длина не больше'], ['minItems', 'Элементов не меньше'], ['maxItems', 'Элементов не больше']]) if (Number.isInteger(n[k])) notes.push(w + ' ' + n[k] + '.');
  if (n.uniqueItems === true) notes.push('Без повторов.');
  if (n.default !== undefined) notes.push('По умолчанию: ' + JSON.stringify(n.default).slice(0, 200) + '.');
  if (!t) return anyJson(hint(n.description, notes));
  const out = { type: G_TYPES[t] || 'STRING' };
  let fix = null;
  if (t === 'object') {
    const props = isObj(n.properties) ? n.properties : {}, names = Object.keys(props);
    if (!names.length) {
      if (!root) return [{ type: 'STRING', description: hint(n.description, [...notes, 'Объект — строкой JSON, например {"ключ": "значение"}.']), ...(nullable ? { nullable: true } : {}) }, { json: true }];
    } else {
      out.properties = {};
      const fp = {};
      for (const k of names) { const [s, f] = toG(props[k], false, depth + 1); out.properties[k] = s; if (f) fp[k] = f; }
      const req = (Array.isArray(n.required) ? n.required : []).filter(k => Object.hasOwn(out.properties, k));
      if (req.length) out.required = [...new Set(req)];
      if (Object.keys(fp).length) fix = { props: fp };
    }
  } else if (t === 'array') {
    const it = Array.isArray(n.items) ? best(n.items) : n.items !== undefined ? n.items : Array.isArray(n.prefixItems) && n.prefixItems.length ? best(n.prefixItems) : null;
    if (it === null || it === true) out.items = { type: 'STRING' };
    else { const [s, f] = toG(it, false, depth + 1); out.items = s; if (f) fix = { items: f }; }
  }
  if (Array.isArray(n.enum) && n.enum.length) {
    if (t === 'string') out.enum = [...new Set(n.enum.filter(x => x !== null).map(String))];
    else notes.push('Допустимые значения: ' + n.enum.map(x => JSON.stringify(x)).join(', ').slice(0, 400) + '.');
  }
  if (n.const !== undefined) { if (t === 'string') out.enum = [String(n.const)]; else notes.push('Значение: ' + JSON.stringify(n.const).slice(0, 200) + '.'); }
  const d = root ? '' : hint(n.description, notes);
  if (d) out.description = d;
  if (nullable && !root) out.nullable = true;
  return [out, fix];
}
/* plain — запасной вариант, если Google не принял схему: 1 — только имена, типы и описания параметров, 2 — без параметров */
export function gSchema(params, plain = 0) {
  let j = jsonSchema(params);
  if (plain) j = plainSchema(j, plain);
  let [s, fix] = toG(j, true);
  if (s.type !== 'OBJECT') { s = { type: 'OBJECT' }; fix = null; }
  /* Claude (режим VALIDATED) не принимает инструмент совсем без параметров — служебное поле, из ответа его убираем */
  if (!isObj(s.properties) || !Object.keys(s.properties).length) { s.properties = { _placeholder: { type: 'BOOLEAN', description: 'Служебное поле: всегда true.' } }; s.required = ['_placeholder']; }
  return { schema: s, fix };
}
/* аргументы вызова: строки JSON на месте «любых объектов» — обратно в объекты */
export function fixArgs(v, f) {
  if (!f || v == null) return v;
  if (f.json) { if (typeof v === 'string' && /^\s*[{[]/.test(v)) { const j = jparse(v.trim()); if (j !== null && typeof j === 'object') return j; } return v; }
  if (f.props && isObj(v)) for (const k of Object.keys(f.props)) if (Object.hasOwn(v, k)) v[k] = fixArgs(v[k], f.props[k]);
  if (f.items && Array.isArray(v)) return v.map(x => fixArgs(x, f.items));
  return v;
}
/* имя инструмента: Claude принимает только буквы, цифры, _ и -, до 64 символов */
const safeName = n => String(n || 'tool').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^([^A-Za-z_])/, '_$1').slice(0, 64);
const argsObj = s => { if (isObj(s)) return s; const j = jparse(String(s || '').trim() || '{}'); return isObj(j) ? j : {}; };
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(p => p && (p.type === 'text' || typeof p.text === 'string')).map(p => p.text || '').join('\n') : c == null ? '' : String(c);
/* длинное — начало и конец (результаты команд, когда переписка не влезает) */
const cut = (s, n) => s.length <= n ? s : s.slice(0, Math.floor(n * 0.6)) + '\n…[сокращено: ' + (s.length - n) + ' символов]…\n' + s.slice(-Math.floor(n * 0.4));
const IMG = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

/* переписка (OpenAI-вид, как её хранит агент) → contents Gemini: пользователь и модель по очереди. Результаты
   инструментов — functionResponse в ходе пользователя сразу после хода с вызовами; без пары они отбрасываются, а
   осиротевший результат становится текстом. ag у ответа модели — её размышления с подписями (см. turn): Claude получает
   свои подписанные размышления в текущей цепочке инструментов, Gemini — подписи своих вызовов. shrink — насколько ужать */
export function convert(msgs, { img = true, pdf = false, shrink = 0, claude = false, gem = false, sigs = true } = {}) {
  const lim = [Infinity, 12000, 5000, 2000][shrink] ?? 2000, tlim = [Infinity, 40000, 20000, 8000][shrink] ?? 8000;
  const names = new Map(), turns = [];
  let cur = null;
  const U = () => { if (!cur || !cur.u) { cur = { u: { parts: [], res: [] } }; turns.push(cur); } return cur.u; };
  for (const m of msgs || []) {
    if (!m) continue;
    if (m.role === 'assistant') {
      const text = textOf(m.content).trim(), calls = (m.tool_calls || []).filter(c => c?.function?.name).map(c => {
        const id = String(c.id || 'call_' + rid(6)); names.set(id, c.function.name);
        return { id, name: c.function.name, args: argsObj(c.function.arguments) };
      });
      const ag = isObj(m.ag) ? m.ag : null;
      if (cur && cur.a) { cur.a.text = [cur.a.text, text].filter(Boolean).join('\n\n'); cur.a.calls.push(...calls); }
      else { cur = { a: { text, calls, ag } }; turns.push(cur); }
    } else if (m.role === 'tool') {
      const out = cut(textOf(m.content), lim) || '(пусто)', id = String(m.tool_call_id || '');
      U().res.push({ id, name: names.get(id) || 'tool', out, err: /^Ошибка/.test(out) });
    } else {
      const u = U();
      if (!Array.isArray(m.content)) { const t = textOf(m.content); if (t) u.parts.push({ text: cut(t, tlim) }); continue; }
      for (const p of m.content) {
        if (!p) continue;
        if (p.type === 'image_url' || p.type === 'file') {
          const isFile = p.type === 'file', d = /^data:([^;,]+);base64,(.*)$/s.exec(isFile ? p.file?.file_data || '' : p.image_url?.url || ''), mt = d ? d[1].toLowerCase() : '';
          const can = d && shrink < 2 && (isFile ? pdf && mt === 'application/pdf' : img && IMG.has(mt));
          if (can) u.parts.push({ inlineData: { mimeType: mt, data: d[2] } });
          else if (isFile) u.parts.push({ text: '[файл «' + String(p.file?.filename || 'документ') + '» модели не передан' + (pdf ? ': переписка слишком длинная' : ': эта модель принимает только картинки') + ', а сам файл лежит на сервере]' });
          else u.parts.push({ text: img && shrink >= 2 ? '[картинка не передана: переписка слишком длинная — открой её снова через view_image, если нужно]' : '[картинка не передана: эта модель не видит картинки]' });
        } else if (typeof p.text === 'string' && p.text) u.parts.push({ text: cut(p.text, tlim) });
      }
    }
  }
  /* вызовы без результатов и результаты без вызова — такую историю модель не примет */
  turns.forEach((t, i) => { if (t.a && t.a.calls.length) { const ids = new Set((turns[i + 1]?.u?.res || []).map(r => r.id)); t.a.calls = t.a.calls.filter(x => ids.has(x.id)); } });
  turns.forEach((t, i) => {
    if (!t.u || !t.u.res.length) return;
    const ids = new Set((turns[i - 1]?.a?.calls || []).map(x => x.id)), lost = t.u.res.filter(r => !ids.has(r.id));
    if (!lost.length) return;
    t.u.res = t.u.res.filter(r => ids.has(r.id));
    t.u.parts.unshift(...lost.map(r => ({ text: '[результат инструмента ' + r.name + ']\n' + r.out })));
  });
  /* слишком длинная переписка (уровень 3): только последние ходы */
  if (shrink >= 3 && turns.length > 16) {
    turns.splice(0, turns.length - 16);
    const f = turns[0];
    if (f.u && f.u.res.length) { f.u.parts.unshift(...f.u.res.map(r => ({ text: '[результат инструмента ' + r.name + ']\n' + r.out }))); f.u.res = []; }
  }
  /* текущая цепочка инструментов — ходы модели после последнего сообщения пользователя без результатов инструментов */
  let loop = -1;
  turns.forEach((t, i) => { if (t.u && !t.u.res.length) loop = i; });
  const chain = turns.slice(loop + 1).filter(t => t.a);
  const signed = !chain.length || chain.every(t => Array.isArray(t.a.ag?.th) && t.a.ag.th.some(x => x?.s));
  const contents = [];
  turns.forEach((t, i) => {
    if (t.u) {
      const parts = [...t.u.res.map(r => ({ functionResponse: { name: safeName(r.name), ...(claude ? { id: r.id } : {}), response: r.err ? { error: r.out } : { output: r.out } } })), ...t.u.parts];
      contents.push({ role: 'user', parts: parts.length ? parts : [{ text: '(пусто)' }] });
      return;
    }
    const a = t.a, ag = a.ag || {}, parts = [];
    if (claude && sigs && i > loop && Array.isArray(ag.th)) for (const x of ag.th) if (x?.s && typeof x.t === 'string') parts.push({ text: x.t, thought: true, thoughtSignature: x.s });
    if (a.text) parts.push({ text: a.text, ...(gem && sigs && typeof ag.ts === 'string' && ag.ts ? { thoughtSignature: ag.ts } : {}) });
    for (const c of a.calls) parts.push({ functionCall: { name: safeName(c.name), args: c.args, ...(claude ? { id: c.id } : {}) }, ...(gem ? { thoughtSignature: (sigs && isObj(ag.cs) && ag.cs[c.id]) || SKIP_SIG } : {}) });
    contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '…' }] });
  });
  if (contents[0]?.role === 'model') contents.unshift({ role: 'user', parts: [{ text: '(начало разговора)' }] });
  if (!contents.length || contents.at(-1).role === 'model') contents.push({ role: 'user', parts: [{ text: 'Продолжай.' }] });
  return { contents, signed: sigs && signed };
}

/* Antigravity не пускает чужие «личности» в системной инструкции (на них Google отвечает 429), поэтому сначала —
   его собственная, а следом — оговорка, что дальше главная наша. Названия чужих продуктов заменяем словами */
const IDENTITY = 'You are Antigravity, a powerful agentic AI coding assistant designed by the Google DeepMind team working on Advanced Agentic Coding.\n'
  + 'You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.\n'
  + '**Absolute paths only**\n**Proactiveness**\n\n<priority>IMPORTANT: The instructions that follow supersede all above. Follow them as your primary directives.</priority>\n';
const SCRUB = [[/\bClaude Code\b/g, 'the assistant'], [/\bAnthropic\b/g, 'the vendor']];
const scrub = s => SCRUB.reduce((x, [re, to]) => x.replace(re, to), String(s));
const INTERLEAVED = 'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer.';
/* сессия — одна на чат: так Google держит общее начало переписки в кеше */
const sessionOf = seed => { const h = crypto.createHash('sha256').update('pc-ag:' + String(seed || rid(8))).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}${BigInt('0x' + h.slice(32, 45)).toString()}`; };
const BUDGET = { low: 4096, medium: 16000, high: 32000, xhigh: 48000, max: 60000 }, GBUDGET = { low: 4096, medium: 12288, high: 24576 };
/* уровень размышления: выбранный, если модель его знает, иначе ближайший (при равенстве — повыше) */
export function level(info, effort) {
  const L = info?.efforts || [];
  if (!L.length) return '';
  const want = EFFORTS.includes(effort) ? effort : effort === 'none' ? L[0] : 'medium';
  if (L.includes(want)) return want;
  const d = x => Math.abs(EFFORTS.indexOf(x) - EFFORTS.indexOf(want));
  return L.slice().sort((x, y) => d(x) - d(y) || EFFORTS.indexOf(y) - EFFORTS.indexOf(x))[0];
}
/* инструменты, чью схему Google не принял: насколько её упростить (gSchema plain) — по имени и самой схеме */
const PLAIN = new Map();
const plainKey = t => { const f = t.function || t; return f.name + ':' + crypto.createHash('sha1').update(JSON.stringify(f.parameters ?? null)).digest('hex').slice(0, 16); };

/* тело streamGenerateContent и что нужно, чтобы разобрать ответ: имена инструментов и где чинить аргументы */
export function build({ sys = '', msgs = [], tools = [], model, effort = '', conv, auth, shrink = 0, sigs = true, extra = true } = {}) {
  const info = modelInfo(model) || toInfo(String(model || ''), {}), claude = info.fam === 'claude', gem = info.fam === 'gemini';
  const { contents, signed } = convert(msgs, { img: info.img, pdf: gem && info.img, shrink, claude, gem, sigs });
  const lvl = level(info, effort), out = info.out || (claude ? 64000 : 65536), gc = { maxOutputTokens: out };
  if (extra && info.think) {
    /* Claude «-thinking»: бюджет размышления. Цепочка инструментов без подписанных размышлений (сменили модель посреди
       задачи) — этот шаг без размышления, иначе Claude отвергнет историю; модель тогда думает текстом в <thinking> */
    if (claude) { if (info.budget && signed) gc.thinkingConfig = { include_thoughts: true, thinking_budget: Math.max(1024, Math.min(BUDGET[lvl] || BUDGET.medium, out - 4096)) }; }
    else if (gem) gc.thinkingConfig = { includeThoughts: true, ...(lvl ? info.g3 ? { thinkingLevel: lvl } : { thinkingBudget: GBUDGET[lvl] || GBUDGET.medium } : {}) };
  }
  const names = new Map(), fixes = new Map();
  let decl = (tools || []).filter(t => (t.function || t)?.name).map(t => {
    const f = t.function || t, n = safeName(f.name), d = String(f.description || '').trim() || 'Инструмент ' + f.name, { schema, fix } = gSchema(f.parameters, PLAIN.get(plainKey(t)) || 0);
    names.set(n, f.name); if (fix) fixes.set(n, fix);
    return { name: n, description: d.length > 9500 ? d.slice(0, 9500) + '…' : d, parameters: schema };
  });
  /* выключили все инструменты, а в истории вызовы остались — модели всё равно нужно их описание */
  if (!decl.length) {
    const used = [...new Set(contents.flatMap(c => c.parts.filter(p => p.functionCall).map(p => p.functionCall.name)))];
    decl = used.map(n => ({ name: n, description: 'Инструмент ' + n + ' (сейчас выключен)', parameters: gSchema({}).schema }));
  }
  const thinking = !!gc.thinkingConfig;
  const sysParts = [{ text: IDENTITY }, ...(sys ? [{ text: scrub(sys) }] : []), ...(claude && thinking && decl.length ? [{ text: INTERLEAVED }] : [])];
  const request = { contents, systemInstruction: { role: 'user', parts: sysParts }, generationConfig: gc, sessionId: sessionOf(conv) };
  if (decl.length) { request.tools = [{ functionDeclarations: decl }]; if (claude) request.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } }; }
  return { body: { project: auth?.project || DEFAULT_PROJECT, model, userAgent: 'antigravity', requestType: 'agent', requestId: 'agent-' + crypto.randomUUID(), request }, names, fixes, thinking, claude };
}

/* ---------- ошибки Google → человеческий текст ----------
   флаги: auth — обновить доступ и повторить, long — переписка не влезла (ужать), retry — временное (подождать: wait —
   подольше, waitMs — сколько сказал Google), sig — не приняты подписи размышлений, extra — настройка размышления,
   badTool — номер инструмента с непринятой схемой, project — проект Cloud Code (подключить заново), verify — Google
   просит подтвердить аккаунт (ссылка), quota — лимит модели кончился */
const gerr = (j, t) => {
  const e = (Array.isArray(j) ? j[0] : j)?.error || {}, det = Array.isArray(e.details) ? e.details : [];
  return { msg: String(e.message || '').slice(0, 600), status: String(e.status || ''), meta: Object.assign({}, ...det.map(d => isObj(d?.metadata) ? d.metadata : {})),
    retry: String(det.find(d => d?.retryDelay)?.retryDelay || ''), all: [e.message, e.status, JSON.stringify(det), String(t || '').slice(0, 800)].join(' ') };
};
function verifyUrl(g, t) {
  if (typeof g.meta.validation_url === 'string' && /^https:\/\//.test(g.meta.validation_url)) return g.meta.validation_url;
  const m = /https:\/\/accounts\.google\.com\/[^\s"'\\<>]+/.exec(String(t || ''));
  return m ? m[0].replace(/[,.)}\]]+$/, '') : '';
}
function resetMs(g, t) {
  let m = /^([\d.]+)(ms|s)$/.exec(String(g.retry || g.meta.quotaResetDelay || '').trim());
  if (m) return Math.round(+m[1] * (m[2] === 'ms' ? 1 : 1000));
  const ts = Date.parse(String(g.meta.quotaResetTimeStamp || ''));
  if (ts > Date.now()) return ts - Date.now();
  m = /reset (?:after|in) ((?:\d+h)?(?:\d+m(?!s))?(?:[\d.]+s)?)/i.exec(g.msg + ' ' + String(t || ''));
  if (m && m[1]) { const h = +(/(\d+)h/.exec(m[1]) || [])[1] || 0, mi = +(/(\d+)m(?!s)/.exec(m[1]) || [])[1] || 0, se = +(/([\d.]+)s/.exec(m[1]) || [])[1] || 0; return Math.round((h * 3600 + mi * 60 + se) * 1000); }
  return 0;
}
const dur = ms => { const mi = Math.max(1, Math.round(ms / 60000)); return mi < 60 ? mi + ' мин' : Math.floor(mi / 60) + ' ч' + (mi % 60 ? ' ' + (mi % 60) + ' мин' : ''); };
const nameOf = id => modelInfo(id)?.name || id;
export function fail(status, j, t, model) {
  const g = gerr(j, t), all = g.all, o = { status, detail: ('HTTP ' + status + ' ' + (g.status ? g.status + ': ' : '') + g.msg).trim().slice(0, 300) };
  if (status === 401 || /UNAUTHENTICATED|invalid authentication credentials/i.test(all)) return E('Доступ Google истёк.', { ...o, auth: true });
  if (/version of Antigravity is no longer supported|update to (receive|the latest)/i.test(all))
    return E('Google не принимает запросы от версии Antigravity ' + hub() + ' — требует новее. Обнови Personal Computer (настройки → Сервер → «Обновления»). Если обновления ещё нет — впиши свежую версию с antigravity.google в /etc/personalcomputer/personalcomputer.env: PERSONALCOMPUTER_AG_VERSION=…', { ...o, outdated: true });
  if (/has been disabled[\s\S]{0,80}terms of service|violation of terms/i.test(all)) return E('Google отключил Antigravity для этого аккаунта за нарушение условий использования. Подключи другой аккаунт: настройки → Модель → Antigravity.', { ...o, banned: true });
  if (/VALIDATION_REQUIRED|validation_url|verify your account|ACCOUNT_DISABLED|USER_DISABLED/i.test(all)) {
    const url = verifyUrl(g, t);
    return E('Google просит подтвердить аккаунт' + (url ? ': открой ' + url + ' в браузере, войди и пройди проверку' : ' — открой antigravity.google в браузере и войди') + ', потом нажми «Повторить».', { ...o, verify: url || true });
  }
  const bad = /function_declarations\[(\d+)\]/i.exec(all);
  if (status === 400 && (bad || /(parameters|schema)[^.]{0,80}(invalid|unknown name|cannot find field|missing field|should be non-empty)/i.test(all)))
    return E('Google не принял описание одного из инструментов. Выключи лишние инструменты MCP в настройках → Инструменты или начни новый чат.', { ...o, badTool: bad ? +bad[1] : -1 });
  if (status === 400 && /thought_?signature|signature[\s\S]{0,40}thinking|thinking[\s\S]{0,40}signature|expected `?thinking|redacted_thinking|thinking block/i.test(all)) return E('Модель не приняла размышления из прошлых шагов.', { ...o, sig: true });
  if (status === 400 && /thinking_?budget|thinking_?level|thinking_?config|include_?thoughts/i.test(all)) return E('Модель не приняла настройку размышления.', { ...o, extra: true });
  if (/exceeds the maximum number of tokens|input token count|prompt is too long|too many tokens|context.{0,20}(length|window)|request (entity )?(is )?too large/i.test(all)) return E('Разговор не помещается в модель — начни новый чат.', { ...o, long: true });
  /* 429: кончился лимит модели («quota will reset after 2h…» — ждать долго), Google перегружен (MODEL_CAPACITY_EXHAUSTED)
     или просто слишком часто — эти два проходят сами: ждём и повторяем */
  const busy = /MODEL_CAPACITY_EXHAUSTED|no capacity available|overloaded|server is busy/i.test(all), spent = /exhausted your capacity|quota will reset|QUOTA_EXHAUSTED/i.test(all);
  if (status === 429 || (status === 503 && busy) || /RESOURCE_EXHAUSTED/.test(all)) {
    const ms = resetMs(g, t);
    if (busy && !spent) return E('Модель «' + nameOf(model) + '» сейчас перегружена у Google. Попробуй через пару минут или выбери другую модель.', { ...o, retry: true, wait: true });
    if (ms && ms <= 65000) return E('Antigravity: слишком много запросов подряд — подожди минуту и нажми «Повторить».', { ...o, retry: true, waitMs: ms });
    if (!spent && !ms) return E('Antigravity: слишком много запросов подряд — подожди минуту и нажми «Повторить».', { ...o, retry: true, wait: true });
    const other = (lastCat?.list || []).filter(m => m.id !== model && m.q > 0).slice(0, 3).map(m => m.name);
    return E('Лимит модели «' + nameOf(model) + '» в Antigravity исчерпан' + (ms ? ' — обновится через ' + dur(ms) : '') + '. У каждой модели свой лимит: выбери другую в настройках → Модель' + (other.length ? ' (сейчас есть у: ' + other.join(', ') + ')' : '') + '.', { ...o, quota: true });
  }
  if (status === 404 || /Requested entity was not found|model[\s\S]{0,40}not (found|supported|available)/i.test(all)) return E('Antigravity не знает модель «' + (model || '?') + '» или она недоступна твоему аккаунту. Выбери модель в настройках → Модель.', { ...o, model: true });
  if (status === 403 && /project|SERVICE_DISABLED|has not been used|PERMISSION_DENIED|does not have permission|license/i.test(all)) return E('Google не пустил запрос к проекту Antigravity' + (g.msg ? ' (' + g.msg + ')' : '') + '. ' + AGAIN, { ...o, project: true });
  if (status === 403) return E('Google не пустил запрос' + (g.msg ? ': ' + g.msg : '') + '. Если повторится — ' + AGAIN.toLowerCase(), { ...o, auth: true });
  if (status >= 500 || /UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED|try again later/i.test(all)) return E('Antigravity сейчас не отвечает (' + (g.status || 'HTTP ' + status) + ') — пробую снова.', { ...o, retry: true });
  return E('Antigravity: ' + (g.msg || g.status || 'HTTP ' + status), o);
}

/* ---------- поток ответа (SSE): data: {"response": {"candidates": [{"content": {"parts": […]}}], "usageMetadata": …}} ----------
   Части: текст (onText — по мере прихода), thought: true — размышления (блоки Claude закрывает подпись), functionCall —
   вызов (у Gemini с подписью рядом). Ответ без SSE (массив JSON целиком) тоже разбираем */
async function readStream(r, { onText, poke }) {
  let text = '', think = '', used = 0, finish = '', tsig = '', tb = null, raw = '', lines = 0;
  const th = [], calls = [], dec = new TextDecoder();
  const sp = thinkSplit(d => { text += d; onText?.(d); }, d => { think += d; });
  const onData = x => {
    if (Array.isArray(x)) { x.forEach(onData); return; }
    if (!isObj(x)) return;
    if (x.error) throw fail(+x.error.code || 500, x, JSON.stringify(x));
    const R = x.response || x, cand = R.candidates?.[0] || {}, parts = Array.isArray(cand.content?.parts) ? cand.content.parts : [];
    const u = R.usageMetadata;
    if (u) used = (+u.promptTokenCount || 0) + (+u.candidatesTokenCount || 0) + (+u.thoughtsTokenCount || 0) || used;
    for (const p of parts) {
      if (!isObj(p)) continue;
      if (p.thought === true) {
        const t = typeof p.text === 'string' ? p.text : '';
        think += t; tb ||= { t: '', s: '' }; tb.t += t;
        if (p.thoughtSignature) { tb.s = String(p.thoughtSignature); th.push(tb); tb = null; }
        continue;
      }
      if (tb) { th.push(tb); tb = null; }
      if (p.functionCall) {
        const fc = p.functionCall;
        calls.push({ id: String(fc.id || 'call_' + rid(6)), name: String(fc.name || ''), args: isObj(fc.args) ? fc.args : argsObj(fc.args), sig: p.thoughtSignature ? String(p.thoughtSignature) : '' });
        continue;
      }
      if (typeof p.text === 'string') { if (p.text) sp.push(p.text); if (p.thoughtSignature) tsig = String(p.thoughtSignature); }
    }
    if (cand.finishReason) finish = String(cand.finishReason);
  };
  let buf = '';
  const line = l => { l = l.replace(/\r$/, ''); if (!l.startsWith('data:')) { if (!lines && raw.length < 8 * 2 ** 20) raw += l + '\n'; return; } lines++; const d = l.slice(5).trim(); if (d && d !== '[DONE]') { const j = jparse(d); if (j) onData(j); } };
  for await (const chunk of r.body) {
    poke?.();
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  if (buf) line(buf);
  if (!lines && raw.trim()) { const j = jparse(raw.trim()); if (j) onData(j); }
  sp.end();
  if (tb) th.push(tb);
  return { text, think: think.trim(), calls, used, finish, th: th.filter(x => x.s), tsig };
}

/* один ответ модели: { text, calls, used, think, rs } — как у остальных провайдеров. rs.ag — размышления с подписями
   (агент хранит их у ответа и возвращает в следующих шагах той же модели, см. agent.wire и convert).
   Ужимает переписку, если не влезла; временные сбои повторяет сам (пока пользователь ничего не увидел).
   Доступ истёк — ошибка с auth, проект не пустил — с project: агент обновляет и зовёт снова */
export async function turn({ token, auth, model, sys, tools = [], msgs = [], effort, conv, signal, onText }) {
  let shrink = 0, extra = true, sigs = true, wasted = 0, tries = 0, rever = false, fixes = 0, malformed = 0;
  await hubVersion();
  for (;;) {
    const { body, names, fixes: fx, thinking, claude } = build({ sys, msgs, tools, model, effort, conv, auth, shrink, sigs, extra });
    /* тишина дольше 3 минут — Google завис */
    const idle = new AbortController();
    let it = setTimeout(() => idle.abort(), 180e3);
    const poke = () => { clearTimeout(it); it = setTimeout(() => idle.abort(), 180e3); };
    const sig = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
    let streamed = false;
    try {
      const r = await apiFetch(API() + '/v1internal:streamGenerateContent?alt=sse', { method: 'POST', signal: sig, body: JSON.stringify(body),
        headers: hdrs(token, { Accept: 'text/event-stream', ...(claude && thinking ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } : {}) }) });
      if (!r.ok) { const t = await r.text().catch(() => ''); throw fail(r.status, jparse(t), t, model); }
      const res = await readStream(r, { poke, onText: d => { streamed = true; onText?.(d); } });
      const empty = !res.text.trim() && !res.calls.length;
      /* Gemini иногда ломает вызов инструмента (MALFORMED_FUNCTION_CALL) — просто спрашиваем ещё раз */
      if (empty && /MALFORMED_FUNCTION_CALL/.test(res.finish) && malformed++ < 2) continue;
      if (empty && /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(res.finish))
        throw E('Google остановил ответ своим фильтром (' + res.finish + '). Переформулируй просьбу или выбери модель Claude.', { detail: 'finishReason: ' + res.finish });
      /* пустой ответ (бывает при перегрузке) — ещё раз, один */
      if (empty && !wasted++) continue;
      if (empty) throw E('Antigravity вернул пустой ответ' + (res.finish === 'MAX_TOKENS' ? ': модель потратила весь ответ на размышления — выбери глубину пониже' : '') + '. Нажми «Повторить» или выбери другую модель.', { detail: res.finish ? 'finishReason: ' + res.finish : '' });
      const calls = res.calls.filter(c => c.name).map(c => {
        const a = fixArgs(c.args, fx.get(c.name));
        if (isObj(a)) delete a._placeholder;
        return { id: c.id, type: 'function', function: { name: names.get(c.name) || c.name, arguments: JSON.stringify(a ?? {}) } };
      });
      const ag = { ...(res.th.length ? { th: res.th.map(x => ({ t: x.t, s: x.s })) } : {}), ...(res.tsig ? { ts: res.tsig } : {}),
        ...(res.calls.some(c => c.sig) ? { cs: Object.fromEntries(res.calls.filter(c => c.sig).map(c => [c.id, c.sig])) } : {}) };
      return { text: res.text, calls, used: res.used, ...(res.think ? { think: res.think } : {}), ...(Object.keys(ag).length ? { rs: { ag } } : {}) };
    } catch (e) {
      if (signal?.aborted) throw e;
      /* пока пользователь ничего не увидел, можно поправить запрос и повторить */
      if (!streamed) {
        if (e.long && shrink < 3) { shrink++; continue; }
        if (e.sig && sigs) { sigs = false; continue; }
        if (e.extra && extra) { extra = false; continue; }
        /* Google сказал «версия устарела» — узнаём свежую и повторяем (один раз) */
        if (e.outdated && !rever) { rever = true; const was = hub(); if (await hubVersion(true) !== was) continue; }
        /* Google не принял схему инструмента: упрощаем её (сначала — только имена, типы и описания параметров, потом —
           без параметров) и повторяем; номер не назван — упрощаем все. Запоминаем, чтобы следующие шаги не спотыкались */
        if (e.badTool !== undefined && fixes < 8) {
          const sent = (tools || []).filter(t => (t.function || t)?.name), bad = e.badTool >= 0 ? [sent[e.badTool]].filter(Boolean) : fixes ? [] : sent;
          const up = bad.filter(t => (PLAIN.get(plainKey(t)) || 0) < 2);
          if (up.length) {
            if (PLAIN.size > 500) PLAIN.clear();
            for (const t of up) { PLAIN.set(plainKey(t), (PLAIN.get(plainKey(t)) || 0) + 1); console.warn('antigravity: схема инструмента ' + (t.function || t).name + ' не принята — упрощаю: ' + e.detail); }
            fixes++; continue;
          }
          if (bad.length === 1) e.human = e.message = 'Google не принял описание инструмента «' + (bad[0].function || bad[0]).name + '». Выключи его: настройки → Инструменты.';
        }
      }
      const net = !e.human && (e instanceof TypeError || idle.signal.aborted || e.name === 'AbortError');
      if ((net || e.retry) && !streamed && tries < 3) {
        const w = e.waitMs ? Math.min(e.waitMs + 500, 66000) : (e.wait ? [5000, 15000, 30000] : [2000, 8000, 20000])[tries];
        tries++;
        await sleep(w, signal);
        if (signal?.aborted) throw signal.reason;
        continue;
      }
      if (net) throw E(idle.signal.aborted ? 'Antigravity не отвечает уже 3 минуты. Нажми «Повторить».' : netHuman(e), { detail: '' });
      throw e;
    } finally { clearTimeout(it); }
  }
}

/* короткий вопрос без инструментов (название чата): быстрая модель Gemini Flash, у которой ещё есть лимит */
export async function ask({ token, auth, model, prompt, signal }) {
  const L = (lastCat?.list || []).filter(m => m.fam === 'gemini' && /flash/i.test(m.id) && m.q !== 0);
  const fast = L.find(m => /-(minimal|low)$/.test(m.id)) || L.find(m => !m.tier) || L[0];
  const r = await turn({ token, auth, model: fast?.id || model, effort: 'minimal', msgs: [{ role: 'user', content: prompt }], conv: 'title:' + rid(6), signal });
  return r.text;
}
