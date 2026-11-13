/* Провайдер Kiro (kiro.dev, Amazon): модели Kiro по твоему аккаунту — с бесплатными кредитами каждый месяц.
   Сервер Personal Computer говорит с тем же API, что и сама Kiro IDE (AWS CodeWhisperer / Amazon Q Developer), — без
   сторонних прокси и шлюзов (включён прокси в настройках → Сервер — запросы идут через него).

   Вход — как у Kiro CLI: «по коду устройства». Сервер просит у Kiro (или у AWS) код входа и адрес страницы, приложение
   открывает эту страницу окошком в ТВОЁМ браузере (там ты уже вошёл в Google или GitHub — ничего вводить не надо),
   ты подтверждаешь вход, а сервер, опрашивая Kiro, сам забирает токены. Ни паролей, ни консоли, ни копирования токенов.
     google, github — вход в Kiro через Google или GitHub (prod.us-east-1.auth.desktop.kiro.dev, /oauth/device/*);
     email          — аккаунт Kiro по почте (там же регистрация): тот же вход, провайдер Cognito;
     builder        — AWS Builder ID: AWS SSO OIDC, device_authorization. Профиля Kiro (profileArn) такой вход не
                      даёт, а новые версии Kiro без него запросы не принимают, — в приложении кнопки нет, остался
                      для «Токена вручную» из Kiro IDE;
     token          — вручную: refresh-токен или файл kiro-auth-token.json из Kiro IDE.
   Доступ живёт час и обновляется сам по refresh-токену (тот лежит на сервере зашифрованным, store.seal).

   Запрос к модели — generateAssistantResponse: вся переписка каждый раз (у API нет своей истории), инструменты —
   родные (toolSpecification / toolUses / toolResults), картинки — у моделей, которые их видят. Ответ приходит потоком
   AWS EventStream (двоичные кадры): текст, вызовы инструментов, размышления, сколько занято контекста.
   Размышление: у Claude 5-го поколения — «адаптивное» с уровнем (additionalModelRequestFields), у моделей GPT — родное
   reasoning.effort, у остальных Claude — договорённость Kiro <thinking_mode> (модель пишет <thinking>…</thinking>
   в начале ответа, мы отделяем это от ответа). */
import crypto from 'node:crypto';
import { apiFetch } from './net.js';
import { seal, unseal, rid } from './store.js';

export const KR_BASE = 'https://kiro.dev';
export const isKiro = base => {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return false;
  try { return /^(app\.)?kiro\.dev$/i.test(new URL(b).hostname); } catch { return false; }
};

/* ---------- адреса (для тестов — переменные окружения) ---------- */
const envUrl = k => String(process.env[k] || '').trim().replace(/\/+$/, '');
const AUTH = () => envUrl('PERSONALCOMPUTER_KIRO_AUTH_URL') || 'https://prod.us-east-1.auth.desktop.kiro.dev';
const REGION_RE = /^[a-z]{2}-[a-z]+-\d{1,2}$/;
/* регион профиля (где живёт аккаунт Kiro) — из profileArn; у Builder ID профиля нет — us-east-1 */
export const regionOf = a => { const m = /^arn:aws:codewhisperer:([a-z0-9-]+):/.exec(String(a?.arn || '')); const r = m?.[1] || 'us-east-1'; return REGION_RE.test(r) ? r : 'us-east-1'; };
const OIDC = (r = 'us-east-1') => envUrl('PERSONALCOMPUTER_KIRO_OIDC_URL') || `https://oidc.${REGION_RE.test(r) ? r : 'us-east-1'}.amazonaws.com`;
const API = r => envUrl('PERSONALCOMPUTER_KIRO_API_URL') || (r === 'us-east-1' ? 'https://codewhisperer.us-east-1.amazonaws.com' : `https://q.${r}.amazonaws.com`);
const QAPI = r => envUrl('PERSONALCOMPUTER_KIRO_Q_URL') || `https://q.${r}.amazonaws.com`;
const SOCIAL_CLIENT = 'kiro-cli';
const SCOPES = ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'];
const START_URL = 'https://view.awsapps.com/start';

/* ---------- версия Kiro IDE ----------
   Kiro не отвечает «старым» версиям IDE («This version of Kiro is no longer supported»), а IDE обновляется часто.
   Поэтому версию берём там же, где её узнаёт сама Kiro IDE, — в файле обновлений (раз в 12 часов), а если Kiro
   всё-таки сказал «устарела» — перепроверяем сразу. Своя версия — PERSONALCOMPUTER_KIRO_IDE_VERSION */
const IDE_KNOWN = '1.4.154', SDK = '1.0.27';
const VER_URL = () => envUrl('PERSONALCOMPUTER_KIRO_VERSION_URL') || 'https://prod.download.desktop.kiro.dev/stable/metadata-linux-x64-stable.json';
const semver = v => /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(String(v || '')) ? String(v) : '';
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
let IDE = IDE_KNOWN, ideAt = 0, idePend = null;
export const ide = () => semver(process.env.PERSONALCOMPUTER_KIRO_IDE_VERSION) || IDE;
export function ideVersion(force) {
  if (semver(process.env.PERSONALCOMPUTER_KIRO_IDE_VERSION)) return Promise.resolve(ide());
  if (!force && Date.now() - ideAt < 12 * 3600e3) return Promise.resolve(IDE);
  return idePend ||= (async () => {
    try {
      const r = await apiFetch(VER_URL(), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      const j = r.ok ? jparse(await r.text()) : null, v = semver(j?.currentRelease || j?.releases?.[0]?.version);
      if (v && newer(v, IDE)) IDE = v;
      ideAt = Date.now();
    } catch { ideAt = Date.now() - 11 * 3600e3; /* сеть подвела — спросим снова через час */ }
    finally { idePend = null; }
    return IDE;
  })();
}

/* ---------- заголовки — как у Kiro IDE (AWS SDK) ---------- */
function hdrs(token, a, extra = {}) {
  const IDE = ide();
  const mid = /^[0-9a-f]{64}$/.test(a?.mid || '') ? a.mid : crypto.createHash('sha256').update('personalcomputer-kiro').digest('hex');
  return {
    Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json',
    'User-Agent': `aws-sdk-js/${SDK} ua/2.1 os/linux lang/js md/nodejs#22.12.0 api/codewhispererstreaming#${SDK} m/E KiroIDE-${IDE}-${mid}`,
    'x-amz-user-agent': `aws-sdk-js/${SDK} KiroIDE-${IDE}-${mid}`,
    'x-amzn-kiro-agent-mode': 'vibe', 'x-amzn-codewhisperer-optout': 'true',
    'amz-sdk-invocation-id': crypto.randomUUID(), 'amz-sdk-request': 'attempt=1; max=1', ...extra,
  };
}
const sleep = (ms, sig) => new Promise(ok => { const t = setTimeout(ok, ms); sig?.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true }); });
const jparse = t => { try { return JSON.parse(t); } catch { return null; } };
async function post(url, body, { signal, headers } = {}) {
  const r = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: signal || AbortSignal.timeout(25000) });
  const t = await r.text().catch(() => '');
  return { status: r.status, ok: r.ok, j: jparse(t), t };
}
const E = (msg, o = {}) => Object.assign(new Error(msg), { human: msg, ...o });
const netHuman = e => 'Не достучался до Kiro (' + (e?.cause?.code || e?.message || 'сеть') + '). ' + (e?.proxy ? 'Проверь прокси: настройки → Сервер → «Прокси».' : 'Проверь интернет на сервере.');
const AGAIN = 'Войди снова: настройки → Модель → Kiro → «Войти через Google» (или как входил раньше).';

/* ====================================================================================================
   Вход по коду устройства
   ==================================================================================================== */
const WAYS = { google: 'Google', github: 'GitHub', email: 'email', builder: 'AWS Builder ID' };
const PROVIDER = { google: 'Google', github: 'Github', email: 'Cognito' };
export const wayName = h => WAYS[h] || 'токен';

/* начать вход: код, страница входа и как часто спрашивать */
export async function deviceStart(how) {
  if (!WAYS[how]) throw E('Неизвестный способ входа', { status: 400 });
  try {
    if (how !== 'builder') {
      const r = await post(AUTH() + '/oauth/device/authorization', { clientId: SOCIAL_CLIENT, loginProvider: PROVIDER[how] });
      const j = r.j || {};
      if (!r.ok || !j.deviceCode) throw E('Kiro не начал вход' + (j.message ? ': ' + j.message : ' (HTTP ' + r.status + ')') + '. Попробуй ещё раз через минуту.', { status: 502 });
      return { how, dc: j.deviceCode, code: j.userCode || '', url: j.verificationUriComplete || j.verificationUri || '', exp: Date.now() + (+j.expiresInMilliseconds || 300e3), every: Math.max(1000, +j.intervalInMilliseconds || 5000) };
    }
    /* AWS Builder ID: сначала регистрируем «приложение» (clientId/clientSecret живут ~90 дней), потом код */
    const reg = await post(OIDC() + '/client/register', { clientName: 'Personal Computer', clientType: 'public', scopes: SCOPES, grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'] });
    if (!reg.ok || !reg.j?.clientId) throw E('AWS не зарегистрировал вход (HTTP ' + reg.status + '). Попробуй ещё раз через минуту.', { status: 502 });
    const { clientId, clientSecret, clientSecretExpiresAt } = reg.j;
    const d = await post(OIDC() + '/device_authorization', { clientId, clientSecret, startUrl: START_URL });
    if (!d.ok || !d.j?.deviceCode) throw E('AWS не начал вход (HTTP ' + d.status + '). Попробуй ещё раз через минуту.', { status: 502 });
    return { how, dc: d.j.deviceCode, code: d.j.userCode || '', url: d.j.verificationUriComplete || d.j.verificationUri || '', exp: Date.now() + (+d.j.expiresIn || 600) * 1000,
      every: Math.max(1000, (+d.j.interval || 5) * 1000), cid: clientId, cs: clientSecret, csExp: (+clientSecretExpiresAt || 0) * 1000 };
  } catch (e) { if (e.human) throw e; throw E(netHuman(e), { status: 502 }); }
}

/* спросить, вошёл ли: { wait } — ещё нет, { tokens } — вошёл; ошибка с final — вход не состоится */
export async function devicePoll(d) {
  const tokens = j => ({ access: j.accessToken, refresh: j.refreshToken || '', arn: j.profileArn || '', expIn: +j.expiresIn || 3600 });
  if (d.how !== 'builder') {
    const r = await post(AUTH() + '/oauth/device/poll', { deviceCode: d.dc, clientId: SOCIAL_CLIENT });
    const j = r.j || {};
    if (j.accessToken) return { tokens: tokens(j) };
    const st = String(j.status || j.error || '');
    if (/pending/i.test(st) || (!st && r.status >= 500)) return { wait: true };
    if (/slow/i.test(st)) return { wait: true, slow: true };
    throw E(/denied|declin|cancel/i.test(st) ? 'Вход отменён на странице Kiro.' : /expired|invalid_token/i.test(st) ? 'Время на вход вышло — нажми кнопку ещё раз.' : 'Kiro не пустил: ' + (st || j.message || 'HTTP ' + r.status), { final: true });
  }
  const r = await post(OIDC() + '/token', { clientId: d.cid, clientSecret: d.cs, deviceCode: d.dc, grantType: 'urn:ietf:params:oauth:grant-type:device_code' });
  const j = r.j || {};
  if (j.accessToken) return { tokens: tokens(j) };
  const st = String(j.error || '');
  if (st === 'authorization_pending' || (!st && r.status >= 500)) return { wait: true };
  if (st === 'slow_down') return { wait: true, slow: true };
  throw E(st === 'access_denied' ? 'Вход отменён на странице AWS.' : st === 'expired_token' ? 'Время на вход вышло — нажми кнопку ещё раз.' : 'AWS не пустил: ' + (j.error_description || st || 'HTTP ' + r.status), { final: true });
}

/* что храним (настройки пользователя, krAuth): секреты — зашифрованными */
export function authFrom(t, d = {}, prev = {}) {
  return {
    how: d.how || prev.how || 'token', rt: t.refresh ? seal(t.refresh) : prev.rt || '', arn: t.arn || prev.arn || '',
    exp: Date.now() + Math.max(60, +t.expIn || 3600) * 1000,
    ...(d.cid ? { cid: d.cid, cs: seal(d.cs), csExp: d.csExp || 0 } : prev.cid ? { cid: prev.cid, cs: prev.cs, csExp: prev.csExp } : {}),
    mid: /^[0-9a-f]{64}$/.test(prev.mid || '') ? prev.mid : rid(32), email: prev.email || '', t: prev.t || Date.now(),
  };
}

/* ---------- окно входа: один вход на пользователя; сервер сам опрашивает Kiro, приложение — сервер ---------- */
const logins = new Map();
const pubLogin = s => s ? { state: s.state, how: s.how, way: wayName(s.how), code: s.code, url: s.url, exp: s.exp, msg: s.msg, login: s.login || '' } : { state: 'none' };
export const loginOf = uid => pubLogin(logins.get(uid));
export function loginStop(uid) { const s = logins.get(uid); if (s) { s.stopped = true; clearTimeout(s.timer); logins.delete(uid); } }
/* done(tokens, d) — сохранить вход (server.js); может вернуть, чей аккаунт */
export async function loginStart(uid, how, done) {
  loginStop(uid);
  const d = await deviceStart(how);
  const s = { how, code: d.code, url: d.url, exp: d.exp, state: 'wait', msg: '', d, stopped: false };
  logins.set(uid, s);
  const later = ms => { if (!s.stopped) { s.timer = setTimeout(tick, ms); s.timer.unref?.(); } };
  /* итог держим 3 минуты (вторая вкладка приложения тоже увидит), потом забываем */
  const finish = (state, msg) => { s.state = state; s.msg = msg; s.timer = setTimeout(() => { if (logins.get(uid) === s) logins.delete(uid); }, 180e3); s.timer.unref?.(); };
  const tick = async () => {
    if (s.stopped) return;
    if (Date.now() > s.exp) return finish('fail', 'Время на вход вышло — нажми кнопку ещё раз.');
    let r;
    try { r = await devicePoll(d); }
    catch (e) { if (e.final) return finish('fail', e.human || e.message); return later(d.every); /* сеть — спросим ещё раз */ }
    if (s.stopped) return;
    if (r.tokens) {
      s.state = 'save';
      try { s.login = (await done(r.tokens, d)) || ''; finish('ok', 'Kiro подключён' + (s.login ? ': ' + s.login : '') + '.'); }
      catch (e) { finish('fail', 'Вход прошёл, но сохранить не вышло: ' + (e.human || e.message)); }
      return;
    }
    if (r.slow) d.every += 5000;
    later(d.every);
  };
  later(Math.min(d.every, 3000));
  return pubLogin(s);
}

/* ---------- «Токен вручную»: refresh-токен или файл kiro-auth-token.json из Kiro IDE (можно вместе с файлом клиента AWS) ---------- */
export function parseImport(text) {
  const s = String(text || '').trim();
  if (!s) throw E('Вставь токен или содержимое kiro-auth-token.json', { status: 400 });
  /* несколько JSON подряд (файл токена + файл клиента из ~/.aws/sso/cache) — склеиваем поля */
  const objs = [];
  for (const m of s.matchAll(/\{[\s\S]*?\}(?=\s*(?:\{|$))/g)) { const j = jparse(m[0]); if (j && typeof j === 'object') objs.push(j); }
  const j = Object.assign({}, ...objs);
  const refresh = String(j.refreshToken || (objs.length ? '' : s.replace(/^Bearer\s+/i, ''))).trim();
  if (!/^aor\S{20,}$/.test(refresh)) throw E('Это не токен Kiro: нужен refreshToken (начинается с aor…) или файл ~/.aws/sso/cache/kiro-auth-token.json целиком.', { status: 400 });
  const idc = /idc|builder/i.test(String(j.authMethod || j.provider || ''));
  if (idc && !(j.clientId && j.clientSecret)) throw E('Это вход через AWS Builder ID: вставь вместе с ним файл клиента из ~/.aws/sso/cache (с clientId и clientSecret) или просто нажми «AWS Builder ID».', { status: 400 });
  return { refresh, arn: String(j.profileArn || ''), ...(j.clientId && j.clientSecret ? { cid: String(j.clientId), cs: String(j.clientSecret), how: 'builder' } : { how: 'token' }) };
}
/* проверить вставленное: сразу обновляем доступ по refresh-токену */
export async function importAuth(text) {
  const p = parseImport(text);
  const a = authFrom({ refresh: p.refresh, arn: p.arn, expIn: 1 }, p.cid ? { how: 'builder', cid: p.cid, cs: p.cs } : { how: 'token' });
  return refresh(a);
}

/* ---------- обновление доступа (час) по refresh-токену ---------- */
export async function refresh(a, signal) {
  const rt = unseal(a?.rt);
  if (!rt) throw E('Вход в Kiro не сохранился на сервере. ' + AGAIN, { relogin: true, status: 401 });
  let r;
  try {
    r = a.cid
      ? await post(OIDC() + '/token', { clientId: a.cid, clientSecret: unseal(a.cs), refreshToken: rt, grantType: 'refresh_token' }, { signal })
      : await post(AUTH() + '/refreshToken', { refreshToken: rt }, { signal });
  } catch (e) { throw E(netHuman(e), { status: 502, retry: true }); }
  const j = r.j || {};
  if (!j.accessToken) {
    const gone = r.status === 400 || r.status === 401 || r.status === 403;
    const why = String(j.error_description || j.message || j.error || 'HTTP ' + r.status);
    throw E(gone ? 'Вход в Kiro истёк или отозван (' + why + '). ' + AGAIN : 'Kiro не обновил доступ: ' + why, { relogin: gone, status: gone ? 401 : 502, retry: !gone });
  }
  return { token: j.accessToken, auth: authFrom({ refresh: j.refreshToken && j.refreshToken !== rt ? j.refreshToken : '', arn: j.profileArn, expIn: j.expiresIn }, {}, a) };
}
/* сколько осталось жить доступу, мс */
export const tokenLeft = a => (+a?.exp || 0) - Date.now();

/* ====================================================================================================
   Модели, кредиты
   ==================================================================================================== */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/* что модель умеет с размышлением (по семейству): adapt — Claude 5-го поколения и новее, native — GPT,
   inline — остальные Claude (договорённость <thinking_mode>), must — думает всегда (размышления приходят сами) */
export function caps(id) {
  id = String(id || '').toLowerCase();
  const adapt = /^claude-(?:opus|sonnet|haiku|fable)-(?:[5-9]|\d\d)/.test(id), native = /^gpt-/.test(id), inline = /^claude-/.test(id) && !adapt;
  const must = /^minimax-|(^|-)r1($|-)|-thinking$/.test(id);
  return { adapt, native, inline, must, think: adapt || native || inline || must, efforts: adapt || inline ? EFFORTS.slice() : native ? ['low', 'medium', 'high'] : [] };
}
/* без живого списка (сеть, аккаунт без каталога) — то, что у Kiro есть у всех */
const FALLBACK = [
  { modelId: 'claude-sonnet-4.5', modelName: 'Claude Sonnet 4.5', rateMultiplier: 1.3, supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000 } },
  { modelId: 'claude-haiku-4.5', modelName: 'Claude Haiku 4.5', rateMultiplier: 0.4, supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000 } },
  { modelId: 'claude-sonnet-4', modelName: 'Claude Sonnet 4', rateMultiplier: 1.3, supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000 } },
];
const num = x => x === null || x === undefined || x === '' || !Number.isFinite(+x) ? null : +x;
function toInfo(m) {
  const id = String(m.modelId || m.id || '').trim(), c = caps(id), types = Array.isArray(m.supportedInputTypes) ? m.supportedInputTypes.map(String) : null;
  return { id, name: String(m.modelName || m.name || id), desc: String(m.description || '').slice(0, 300), rate: num(m.rateMultiplier), unit: String(m.rateUnit || ''),
    ctx: num(m.tokenLimits?.maxInputTokens) || 200000, out: num(m.tokenLimits?.maxOutputTokens) || 0,
    img: types ? types.some(t => /image/i.test(t)) : /^claude-/i.test(id), think: c.think, must: c.must, efforts: c.efforts };
}
/* каталог: последний полученный — общий (он почти у всех одинаковый; нужен агенту, чтобы знать про картинки и контекст) */
const cats = new Map();
let lastCat = null;
export const modelInfo = id => (lastCat?.list || []).find(m => m.id === id) || (id ? toInfo({ modelId: id }) : null);
export async function models(token, a, { force } = {}) {
  await ideVersion();
  const key = (a?.mid || '') + ':' + regionOf(a), c = cats.get(key);
  if (c && !force && Date.now() - c.at < 600e3) return c;
  const get = async q => {
    const r = await apiFetch(QAPI(regionOf(a)) + '/ListAvailableModels?' + new URLSearchParams(q), { headers: hdrs(token, a), signal: AbortSignal.timeout(20000) });
    const t = await r.text().catch(() => '');
    return { status: r.status, j: jparse(t), t };
  };
  let r = null, list = null;
  try {
    r = await get({ origin: 'AI_EDITOR', ...(a?.arn ? { profileArn: a.arn } : {}) });
    if (!(r.status === 200 && Array.isArray(r.j?.models) && r.j.models.length) && a?.arn) r = await get({ origin: 'AI_EDITOR' });
  } catch (e) { r = { status: 0, err: e }; }
  if (r.status === 401 || isTokenErr(r.status, r.j, r.t)) throw E('Доступ Kiro не подошёл', { status: 401, auth: true });
  if (r.status === 200 && Array.isArray(r.j?.models) && r.j.models.length) list = r.j.models;
  const out = { at: Date.now(), live: !!list, list: (list || FALLBACK).map(toInfo).filter(m => m.id), def: String(r.j?.defaultModel?.modelId || '') };
  if (list) { cats.set(key, out); lastCat = out; }
  else if (!lastCat) lastCat = out;
  return out;
}
/* модель «по умолчанию», если выбранной нет в списке: то, что советует Kiro, иначе Sonnet, иначе первая */
export const pickModel = c => (c.def && c.list.find(m => m.id === c.def) ? c.def : (c.list.find(m => /^claude-sonnet-4\.5$/.test(m.id)) || c.list.find(m => /sonnet/.test(m.id)) || c.list[0])?.id || '');

/* кредиты: сколько потрачено из месячных, пробный бонус, когда обнулится, чей аккаунт */
const when = x => { const n = num(x); if (n) return n < 1e12 ? n * 1000 : n; const t = Date.parse(String(x || '')); return Number.isFinite(t) ? t : 0; };
export async function usage(token, a) {
  await ideVersion();
  const q = new URLSearchParams({ isEmailRequired: 'true', origin: 'AI_EDITOR', resourceType: 'AGENTIC_REQUEST', ...(a?.arn ? { profileArn: a.arn } : {}) });
  const r = await apiFetch(API(regionOf(a)) + '/getUsageLimits?' + q, { headers: hdrs(token, a), signal: AbortSignal.timeout(20000) });
  const t = await r.text().catch(() => ''), j = jparse(t);
  if (r.status === 401 || isTokenErr(r.status, j, t)) throw E('Доступ Kiro не подошёл', { status: 401, auth: true });
  if (!r.ok || !j) throw E('Kiro не сказал, сколько кредитов осталось (HTTP ' + r.status + ')', { status: r.status });
  const L = Array.isArray(j.usageBreakdownList) ? j.usageBreakdownList : [];
  const b = L.find(x => /credit/i.test(x?.resourceType || x?.unit || '')) || L.find(x => /agentic/i.test(x?.resourceType || '')) || L[0] || {};
  const ft = b.freeTrialInfo || null, bon = Array.isArray(b.bonuses) ? b.bonuses : [];
  return {
    email: String(j.userInfo?.email || ''), plan: String(j.subscriptionInfo?.subscriptionTitle || j.subscriptionInfo?.type || '').trim(),
    used: num(b.currentUsageWithPrecision ?? b.currentUsage), limit: num(b.usageLimitWithPrecision ?? b.usageLimit), unit: String(b.displayNamePlural || b.unit || 'кредитов'),
    reset: when(j.nextDateReset || b.nextDateReset),
    trial: ft && (num(ft.usageLimitWithPrecision ?? ft.usageLimit) || 0) > 0 && !/expired/i.test(ft.freeTrialStatus || '')
      ? { used: num(ft.currentUsageWithPrecision ?? ft.currentUsage) || 0, limit: num(ft.usageLimitWithPrecision ?? ft.usageLimit) || 0, until: when(ft.freeTrialExpiry) } : null,
    bonus: bon.reduce((s, x) => s + (num(x.usageLimit ?? x.usageLimitWithPrecision) || 0) - (num(x.currentUsage ?? x.currentUsageWithPrecision) || 0), 0) || 0,
  };
}

/* проверка в настройках: модели (с умениями), чей аккаунт и сколько кредитов */
export async function check(token, a) {
  if (!token) throw E('Войди в Kiro: «Войти через Google», «GitHub» или «AWS Builder ID».', { status: 401, needKey: true });
  const [c, u] = await Promise.all([models(token, a), usage(token, a).catch(e => { if (e.auth) throw e; return null; })]);
  return { models: c.list.map(m => m.id), info: c.list, def: pickModel(c), live: c.live, login: u?.email || a?.email || '', how: a?.how || '', way: wayName(a?.how), credits: u, exp: +a?.exp || 0 };
}

/* ====================================================================================================
   Запрос к модели
   ==================================================================================================== */
/* JSON Schema инструмента → то, что примет Kiro, а за ним Bedrock (строгая проверка по JSON Schema draft 2020-12).
   Kiro не принимает additionalProperties, пустой required и служебные $-поля. Ссылки $ref на $defs/definitions
   подставляем на место (схема становится самодостаточной, сами $defs не нужны: раньше в них по ошибке попадал
   type: 'object', и Bedrock отвергал всю схему — так было с send_feedback у поиска Parallel). Схемы — только значения
   ключей-схем (properties, items, anyOf…); default, enum, const, examples — данные, их не трогаем. Ключи старых
   черновиков переводим (exclusiveMinimum: true, items-массив, required: true у свойства, nullable), а неизвестные и
   испорченные (не того типа) — отбрасываем */
const SUB_ONE = new Set(['contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedItems']);
const SUB_LIST = new Set(['anyOf', 'oneOf', 'allOf']);
const SUB_MAP = new Set(['properties', 'patternProperties', 'dependentSchemas']);
const KW_NUM = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']);
const KW_INT = new Set(['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minContains', 'maxContains']);
const KW_STR = new Set(['title', 'description', 'pattern', 'format', 'contentMediaType', 'contentEncoding']);
const KW_BOOL = new Set(['uniqueItems', 'deprecated', 'readOnly', 'writeOnly']);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
export function cleanSchema(s) {
  const root = isObj(s) ? s : {};
  let budget = 5000; /* сколько узлов можно развернуть: ссылки друг на друга не раздуют схему без меры */
  /* #/$defs/Имя, #/definitions/Имя и любой путь внутри схемы (JSON Pointer) */
  const at = ref => {
    if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
    let o = root;
    for (const p of ref.slice(1).split('/').slice(1)) {
      let k; try { k = decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'); } catch { return undefined; }
      if (!o || typeof o !== 'object' || !Object.hasOwn(o, k)) return undefined;
      o = o[k];
    }
    return o;
  };
  const walk = (n, refs) => {
    budget--;
    if (n === false) return { not: {} };
    if (!isObj(n)) return {}; /* true, пусто, мусор — «что угодно» */
    if (typeof n.$ref === 'string') {
      const { $ref, ...own } = n, t = budget > 0 && !refs.includes($ref) ? at($ref) : undefined;
      /* ссылка на себя (дерево) или неизвестная — «что угодно»; соседние ключи важнее подставленных */
      return { ...(t === undefined ? {} : walk(t, [...refs, $ref])), ...walk(own, refs) };
    }
    const out = {}, req = [];
    for (const [k, v] of Object.entries(n)) {
      if (SUB_MAP.has(k)) {
        if (!isObj(v)) continue;
        out[k] = Object.fromEntries(Object.entries(v).map(([p, x]) => { if (k === 'properties' && x?.required === true) req.push(p); return [p, walk(x, refs)]; }));
      } else if (SUB_LIST.has(k)) { if (Array.isArray(v) && v.length) out[k] = v.map(x => walk(x, refs)); }
      else if (SUB_ONE.has(k)) out[k] = walk(v, refs);
      else if (k === 'items') {
        if (!Array.isArray(v)) out.items = walk(v, refs);
        else if (v.length) { out.prefixItems = v.map(x => walk(x, refs)); if (isObj(n.additionalItems) || n.additionalItems === false) out.items = walk(n.additionalItems, refs); }
      } else if (k === 'prefixItems') { if (Array.isArray(v) && v.length) out.prefixItems = v.map(x => walk(x, refs)); }
      else if (k === 'type') { const t = [...new Set((Array.isArray(v) ? v : [v]).filter(x => TYPES.has(x)))]; if (t.length) out.type = t.length === 1 ? t[0] : t; }
      else if (k === 'required') { if (Array.isArray(v)) req.push(...v.filter(x => typeof x === 'string')); }
      else if (k === 'enum') { if (Array.isArray(v) && v.length) out.enum = v; }
      else if (k === 'examples') { if (Array.isArray(v)) out.examples = v; }
      else if (k === 'default' || k === 'const') out[k] = v;
      else if (k === 'dependentRequired') { if (isObj(v)) out[k] = Object.fromEntries(Object.entries(v).filter(([, x]) => Array.isArray(x)).map(([p, x]) => [p, [...new Set(x.filter(y => typeof y === 'string'))]])); }
      else if (KW_NUM.has(k)) { if (typeof v === 'number' && Number.isFinite(v)) out[k] = v; }
      else if (KW_INT.has(k)) { if (Number.isInteger(v) && v >= 0) out[k] = v; }
      else if (KW_STR.has(k)) { if (typeof v === 'string') out[k] = v; }
      else if (KW_BOOL.has(k)) { if (typeof v === 'boolean') out[k] = v; }
      /* остальное — additionalProperties (Kiro не принимает), $defs (подставлены), $schema, $id и чужие ключи — не передаём */
    }
    if (req.length) out.required = [...new Set(req)];
    /* draft-04: exclusiveMinimum: true рядом с minimum */
    for (const [ex, lim] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) if (n[ex] === true && typeof out[lim] === 'number') { out[ex] = out[lim]; delete out[lim]; }
    /* OpenAPI: nullable: true */
    if (n.nullable === true && out.type && ![].concat(out.type).includes('null')) out.type = [...[].concat(out.type), 'null'];
    return out;
  };
  const out = walk(root, []);
  /* верх — всегда объект со свойствами (так требует API) */
  out.type = 'object';
  if (!isObj(out.properties)) out.properties = {};
  return out;
}
/* запасная схема, если Kiro не принял настоящую: level 1 — только имена и описания параметров, 2 — без параметров */
export function plainSchema(s, level = 1) {
  const pr = level < 2 && isObj(s?.properties) ? Object.entries(s.properties).filter(([n]) => /^[\w.-]{1,64}$/.test(n)) : [];
  const simple = t => typeof t === 'string' && TYPES.has(t) && t !== 'null' ? { type: t } : {};
  const props = Object.fromEntries(pr.map(([n, p]) => [n, { ...simple(p?.type), ...(typeof p?.description === 'string' ? { description: p.description.slice(0, 2000) } : {}) }]));
  const req = Array.isArray(s?.required) ? s.required.filter(n => Object.hasOwn(props, n)) : [];
  return { type: 'object', properties: props, ...(req.length ? { required: req } : {}) };
}
const spec = (t, plain = 0) => {
  const f = t.function || t, d = String(f.description || '').trim() || 'Инструмент ' + f.name, json = cleanSchema(f.parameters);
  return { toolSpecification: { name: f.name, description: d.length > 9500 ? d.slice(0, 9500) + '…' : d, inputSchema: { json: plain ? plainSchema(json, plain) : json } } };
};
const argsObj = s => { if (s && typeof s === 'object' && !Array.isArray(s)) return s; const j = jparse(String(s || '').trim() || '{}'); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; };
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(p => p && (p.type === 'text' || typeof p.text === 'string')).map(p => p.text || '').join('\n') : c == null ? '' : String(c);
/* длинное — начало и конец (результаты команд, когда переписка не влезает) */
const cut = (s, n) => s.length <= n ? s : s.slice(0, Math.floor(n * 0.6)) + '\n…[сокращено: ' + (s.length - n) + ' символов]…\n' + s.slice(-Math.floor(n * 0.4));
const FMT = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' };
const conversationId = seed => { const h = crypto.createHash('sha256').update('pc-kiro:' + String(seed || rid(8))).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };

/* переписка (OpenAI-вид, как её хранит агент) → ходы Kiro: пользователь и ассистент строго по очереди.
   Результаты инструментов — в ход пользователя (toolResults) сразу после хода с вызовами (toolUses); без пары они
   отбрасываются (Kiro не примет), а осиротевший результат становится текстом. shrink — насколько ужать (0…3) */
export function convert(msgs, { img = true, shrink = 0 } = {}) {
  const lim = [Infinity, 12000, 5000, 2000][shrink] || 2000, tlim = [Infinity, 40000, 20000, 8000][shrink] || 8000;
  const turns = [];
  let cur = null;
  const U = () => { if (!cur || !cur.u) { cur = { u: { texts: [], imgs: [], res: [] } }; turns.push(cur); } return cur.u; };
  for (const m of msgs || []) {
    if (!m) continue;
    if (m.role === 'assistant') {
      const text = textOf(m.content).trim(), uses = (m.tool_calls || []).filter(c => c?.function?.name).map(c => ({ toolUseId: String(c.id || 'call_' + rid(6)), name: c.function.name, input: argsObj(c.function.arguments) }));
      if (cur && cur.a) { cur.a.text = [cur.a.text, text].filter(Boolean).join('\n\n'); cur.a.uses.push(...uses); }
      else { cur = { a: { text, uses } }; turns.push(cur); }
    } else if (m.role === 'tool') {
      const out = cut(textOf(m.content), lim) || '(пусто)';
      U().res.push({ toolUseId: String(m.tool_call_id || ''), status: /^Ошибка/.test(out) ? 'error' : 'success', content: [{ text: out }] });
    } else {
      const u = U();
      if (typeof m.content === 'string' || !Array.isArray(m.content)) { const t = textOf(m.content); if (t) u.texts.push(cut(t, tlim)); continue; }
      for (const p of m.content) {
        if (!p) continue;
        if (p.type === 'image_url') {
          const d = /^data:([^;,]+);base64,(.*)$/s.exec(p.image_url?.url || '');
          if (d && img && FMT[d[1].toLowerCase()] && shrink < 2) u.imgs.push({ format: FMT[d[1].toLowerCase()], source: { bytes: d[2] } });
          else u.texts.push(img && shrink >= 2 ? '[картинка не передана: переписка слишком длинная — открой её снова через view_image, если нужно]' : '[картинка не передана: эта модель Kiro не видит картинки]');
        } else if (p.type === 'file') u.texts.push('[файл «' + String(p.file?.filename || 'документ') + '» модели не передан: Kiro принимает только картинки, а сам файл лежит на сервере]');
        else if (typeof p.text === 'string' && p.text) u.texts.push(cut(p.text, tlim));
      }
    }
  }
  /* вызовы без результатов и результаты без вызова — Kiro такую историю не примет */
  turns.forEach((t, i) => { if (t.a && t.a.uses.length) { const ids = new Set((turns[i + 1]?.u?.res || []).map(r => r.toolUseId)); t.a.uses = t.a.uses.filter(x => ids.has(x.toolUseId)); } });
  turns.forEach((t, i) => {
    if (!t.u || !t.u.res.length) return;
    const ids = new Set((turns[i - 1]?.a?.uses || []).map(x => x.toolUseId)), lost = t.u.res.filter(r => !ids.has(r.toolUseId));
    if (!lost.length) return;
    t.u.res = t.u.res.filter(r => ids.has(r.toolUseId));
    t.u.texts.unshift(...lost.map(r => '[результат инструмента]\n' + r.content[0].text));
  });
  /* слишком длинная переписка (уровень 3): только последние ходы */
  if (shrink >= 3 && turns.length > 16) { turns.splice(0, turns.length - 16); if (turns[0].u && turns[0].u.res.length) { turns[0].u.texts.unshift(...turns[0].u.res.map(r => '[результат инструмента]\n' + r.content[0].text)); turns[0].u.res = []; } }
  if (turns[0]?.a) turns.unshift({ u: { texts: ['(начало разговора)'], imgs: [], res: [] } });
  return turns;
}

/* тело generateAssistantResponse */
export function build({ sys = '', msgs = [], tools = [], model, think = false, effort = '', conv, auth, shrink = 0, extra = true } = {}) {
  const info = modelInfo(model), c = caps(model);
  const turns = convert(msgs, { img: info ? info.img : true, shrink });
  const um = (u, cont) => {
    const content = [cont, ...u.texts].filter(Boolean).join('\n\n');
    return { userInputMessage: { content: content || (u.res.length || u.imgs.length ? '' : '(пусто)'), modelId: model, origin: 'AI_EDITOR', ...(u.imgs.length ? { images: u.imgs } : {}), ...(u.res.length ? { userInputMessageContext: { toolResults: u.res } } : {}) } };
  };
  const am = a => ({ assistantResponseMessage: { content: a.text || '(empty)', ...(a.uses.length ? { toolUses: a.uses } : {}) } });
  const last = turns.at(-1);
  const curU = last?.u ? turns.pop().u : { texts: ['Продолжай.'], imgs: [], res: [] };
  /* инструкция (у Kiro нет системной роли) — первым ходом, с подтверждением модели */
  const history = [];
  if (sys) history.push({ userInputMessage: { content: '<system-instructions>\n' + sys + '\n</system-instructions>\nЭто твои инструкции на весь разговор.', modelId: model, origin: 'AI_EDITOR' } }, { assistantResponseMessage: { content: 'Поняла, следую этим инструкциям.' } });
  for (const t of turns) history.push(t.u ? um(t.u) : am(t.a));
  /* уровень размышления: выбранный, если модель его знает, иначе ближайший */
  let lvl = '';
  if (think && c.think && !c.must) {
    const want = EFFORTS.includes(effort) ? effort : effort === 'none' || effort === 'minimal' ? 'low' : 'medium';
    lvl = c.efforts.includes(want) ? want : c.efforts.slice().sort((x, y) => Math.abs(EFFORTS.indexOf(x) - EFFORTS.indexOf(want)) - Math.abs(EFFORTS.indexOf(y) - EFFORTS.indexOf(want)))[0] || '';
  }
  const LEN = { low: 8000, medium: 16000, high: 32000, xhigh: 64000, max: 120000 };
  const directive = lvl && (c.adapt || c.inline) ? '<thinking_mode>enabled</thinking_mode><max_thinking_length>' + LEN[lvl] + '</max_thinking_length>' : '';
  const cm = um(curU, directive);
  const ctx = cm.userInputMessage.userInputMessageContext ||= {};
  /* инструменты — у текущего хода; выключили все, а в истории вызовы остались — Kiro всё равно нужна их схема */
  let specs = (tools || []).filter(t => (t.function || t)?.name).map(t => spec(t, PLAIN.get(plainKey(t)) || 0));
  if (!specs.length) {
    const names = [...new Set(history.flatMap(h => (h.assistantResponseMessage?.toolUses || []).map(x => x.name)))];
    specs = names.map(n => ({ toolSpecification: { name: n, description: 'Инструмент ' + n + ' (сейчас выключен)', inputSchema: { json: { type: 'object', properties: {} } } } }));
  }
  if (specs.length) ctx.tools = specs;
  if (!Object.keys(ctx).length) delete cm.userInputMessage.userInputMessageContext;
  const body = { conversationState: { chatTriggerType: 'MANUAL', conversationId: conversationId(conv), currentMessage: cm, history }, ...(auth?.arn ? { profileArn: auth.arn } : {}) };
  if (lvl && extra && !NOEXTRA.has(model) && (c.adapt || c.native)) body.additionalModelRequestFields = c.native ? { reasoning: { effort: lvl } } : { output_config: { effort: lvl }, thinking: { type: 'adaptive', display: 'summarized' } };
  return body;
}
/* модели, которые не приняли additionalModelRequestFields — дальше без него (размышление остаётся через <thinking_mode>) */
const NOEXTRA = new Set();
/* инструменты, чью схему Kiro не принял: насколько её упростить (plainSchema) — по имени и самой схеме */
const PLAIN = new Map();
const plainKey = t => { const f = t.function || t; return f.name + ':' + crypto.createHash('sha1').update(JSON.stringify(f.parameters ?? null)).digest('hex').slice(0, 16); };

/* ---------- ошибки Kiro → человеческий текст ----------
   status, j — ответ API; флаги: auth — обновить доступ и повторить, long — переписка не влезла (ужать и повторить),
   retry — временное (подождать и повторить), extra — модель не приняла поле размышления */
const isTokenErr = (status, j, t) => status === 401 || (status === 403 && /bearer token|token (?:is )?(?:invalid|expired)|expiredtoken|unrecognizedclient|invalid.{0,20}token|security token/i.test(String(j?.message || j?.Message || t || '')));
export function fail(status, j, t, model) {
  const msg = String(j?.message || j?.Message || j?.error_description || '').slice(0, 400), reason = String(j?.reason || j?.__type || j?.code || ''), all = msg + ' ' + reason + ' ' + String(t || '').slice(0, 400);
  const o = { status, detail: ('HTTP ' + status + ' ' + (reason ? reason + ': ' : '') + msg).trim().slice(0, 300) };
  if (isTokenErr(status, j, t)) return E('Доступ Kiro истёк.', { ...o, auth: true });
  /* Bedrock не принял схему инструмента: «tools.13.custom.input_schema: JSON schema is invalid» — turn упростит её и повторит */
  const bad = /tools\.(\d+)\.(?:custom\.)?input_schema/i.exec(all);
  if (bad || /TOOL_SCHEMA_INVALID/i.test(all))
    return E('Kiro не принял описание одного из инструментов. Выключи лишние инструменты MCP в настройках → Инструменты или начни новый чат.', { ...o, badTool: bad ? +bad[1] : -1 });
  if (/profileArn is required/i.test(all))
    return E('Kiro не принимает этот вход без профиля Kiro (так бывает со входом через AWS Builder ID). Войди заново: настройки → Модель → Kiro → «Войти через Google», «GitHub» или «По email».', o);
  if (/version of Kiro is no longer supported|update to the latest version/i.test(all))
    return E('Kiro не принимает запросы от версии Kiro IDE ' + ide() + ' — требует новее. Обнови Personal Computer (настройки → Сервер → «Обновления»). Если обновления ещё нет — впиши свежую версию с kiro.dev/downloads в /etc/personalcomputer/personalcomputer.env: PERSONALCOMPUTER_KIRO_IDE_VERSION=…', { ...o, outdated: true });
  if (/CONTENT_LENGTH_EXCEEDS|too long|exceeds the maximum|input is too large|context.{0,20}(length|window)|prompt is too long/i.test(all)) return E('Разговор не помещается в модель Kiro — начни новый чат.', { ...o, long: true });
  if (/additionalModelRequestFields|output_config|reasoning.{0,20}not supported/i.test(all) && status === 400) return E('Модель Kiro не приняла настройку размышления.', { ...o, extra: true });
  if (/MONTHLY_REQUEST_COUNT|OVERAGE|insufficient.{0,10}credit|credit.{0,30}(limit|exhaust|exceed)|usage limit|limit (has been )?reached|ServiceQuotaExceeded/i.test(all))
    return E('Кредиты Kiro на этот месяц кончились. Они обновятся в начале следующего периода (дату видно в настройках → Модель); больше — на платном плане на kiro.dev.', o);
  if (/invalid model|model.{0,40}(not (found|supported|available)|unavailable)|select a different model/i.test(all)) return E('Kiro не знает модель «' + (model || '?') + '» или она недоступна на твоём плане. Выбери модель в настройках → Модель.', o);
  if (/suspend|banned|disabled|locked/i.test(all) && (status === 403 || status === 400)) return E('Kiro ограничил аккаунт: ' + (msg || reason) + '. Подробности — на kiro.dev.', o);
  if (status === 403) return E('Kiro не пустил запрос' + (msg ? ': ' + msg : '') + '. Если повторится — ' + AGAIN.toLowerCase(), { ...o, auth: true });
  if (status === 429 || /throttl|too many requests|rate exceeded/i.test(all)) return E('Kiro: слишком много запросов — подожду и попробую снова.', { ...o, retry: true, wait: true });
  if (status >= 500 || /INSUFFICIENT_MODEL_CAPACITY|capacity|temporar|unavailable|internal/i.test(all)) return E('Kiro сейчас не отвечает (' + (reason || 'HTTP ' + status) + ') — пробую снова.', { ...o, retry: true });
  if (/improperly formed/i.test(all)) return E('Kiro не принял запрос («Improperly formed request»). Нажми «Повторить»; если повторится — начни новый чат.', o);
  return E('Kiro: ' + (msg || reason || 'HTTP ' + status), o);
}

/* ---------- поток AWS EventStream: [длина 4][длина заголовков 4][CRC 4][заголовки][тело][CRC 4] ---------- */
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = b => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function headersOf(b) {
  const h = {};
  for (let i = 0; i < b.length;) {
    const nl = b[i++], name = b.toString('utf8', i, i + nl); i += nl;
    const ty = b[i++];
    let v;
    switch (ty) {
      case 0: v = true; break; case 1: v = false; break;
      case 2: v = b.readInt8(i); i += 1; break; case 3: v = b.readInt16BE(i); i += 2; break;
      case 4: v = b.readInt32BE(i); i += 4; break; case 5: case 8: v = Number(b.readBigInt64BE(i)); i += 8; break;
      case 6: case 7: { const l = b.readUInt16BE(i); i += 2; v = ty === 7 ? b.toString('utf8', i, i + l) : b.subarray(i, i + l); i += l; break; }
      case 9: v = b.toString('hex', i, i + 16); i += 16; break;
      default: return h;
    }
    h[name] = v;
  }
  return h;
}
export class Frames {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, Buffer.from(chunk)]) : Buffer.from(chunk);
    const out = [];
    while (this.buf.length >= 16) {
      const total = this.buf.readUInt32BE(0), hl = this.buf.readUInt32BE(4);
      if (total < 16 || total > 64 * 2 ** 20 || hl > total - 16) throw E('Kiro прислал повреждённый поток — нажми «Повторить».', { retry: true });
      if (this.buf.length < total) break;
      if (crc32(this.buf.subarray(0, 8)) !== this.buf.readUInt32BE(8)) throw E('Kiro прислал повреждённый поток — нажми «Повторить».', { retry: true });
      const h = headersOf(this.buf.subarray(12, 12 + hl)), body = this.buf.subarray(12 + hl, total - 4).toString('utf8');
      this.buf = this.buf.subarray(total);
      out.push({ h, j: body.trim() ? jparse(body) ?? { raw: body } : null });
    }
    return out;
  }
}
/* кадр (для тестов и фальшивого сервера) */
export function frame(type, payload, kind = 'event') {
  const hs = [[':message-type', kind], [kind === 'exception' ? ':exception-type' : ':event-type', type], [':content-type', 'application/json']];
  const hb = Buffer.concat(hs.map(([n, v]) => { const nb = Buffer.from(n), vb = Buffer.from(String(v)); const x = Buffer.alloc(1 + nb.length + 3); x[0] = nb.length; nb.copy(x, 1); x[1 + nb.length] = 7; x.writeUInt16BE(vb.length, 2 + nb.length); return Buffer.concat([x, vb]); }));
  const body = Buffer.from(JSON.stringify(payload)), total = 16 + hb.length + body.length, pre = Buffer.alloc(12);
  pre.writeUInt32BE(total, 0); pre.writeUInt32BE(hb.length, 4); pre.writeUInt32BE(crc32(pre.subarray(0, 8)), 8);
  const msg = Buffer.concat([pre, hb, body]), end = Buffer.alloc(4); end.writeUInt32BE(crc32(msg), 0);
  return Buffer.concat([msg, end]);
}

/* размышление в тексте (<thinking>…</thinking>, у некоторых моделей <think>…</think>) — только в самом начале ответа:
   дальше эти теги — обычный текст (например, в коде) */
export function thinkSplit(onText, onThink) {
  let mode = 'start', buf = '', close = '';
  const OPEN = ['<thinking>', '<think>'];
  const push = s => {
    buf += s;
    for (;;) {
      if (mode === 'out') { if (buf) onText(buf); buf = ''; return; }
      if (mode === 'start') {
        const lead = buf.length - buf.trimStart().length, rest = buf.slice(lead);
        const tag = OPEN.find(t => rest.startsWith(t));
        if (tag) { mode = 'in'; close = tag.replace('<', '</'); buf = rest.slice(tag.length); continue; }
        if (!rest || OPEN.some(t => t.startsWith(rest))) return;
        mode = 'out'; buf = rest; continue;
      }
      const i = buf.indexOf(close);
      if (i < 0) {
        /* хвост может оказаться началом закрывающего тега — придержим его */
        let keep = 0; for (let k = Math.min(close.length - 1, buf.length); k > 0; k--) if (close.startsWith(buf.slice(-k))) { keep = k; break; }
        if (buf.length > keep) onThink(buf.slice(0, buf.length - keep));
        buf = buf.slice(buf.length - keep); return;
      }
      if (i) onThink(buf.slice(0, i));
      buf = buf.slice(i + close.length).replace(/^\s+/, ''); mode = 'start';
    }
  };
  return { push, end: () => { if (buf) (mode === 'in' ? onThink : onText)(buf); buf = ''; } };
}

/* прочитать ответ: текст (onText — по мере прихода), вызовы инструментов, размышления, занятый контекст */
async function readStream(r, { model, onText, poke }) {
  let text = '', think = '', pct = 0, credits = 0, sent = false;
  const calls = new Map(), fr = new Frames();
  const sp = thinkSplit(d => { text += d; sent = true; onText?.(d); }, d => { think += d; });
  const handle = ({ h, j }) => {
    const mt = h[':message-type'], ev = h[':event-type'] || '';
    if (mt === 'exception' || mt === 'error') {
      const e = fail(400, { message: j?.message || h[':error-message'] || '', reason: h[':exception-type'] || h[':error-code'] || '' }, '', model);
      if (/throttl|internal|unavailable|capacity/i.test(h[':exception-type'] || '')) e.retry = true;
      throw Object.assign(e, { sent });
    }
    if (!j) return;
    if (ev === 'assistantResponseEvent' || ev === 'codeEvent') { if (typeof j.content === 'string' && j.content) sp.push(j.content); return; }
    if (ev === 'reasoningContentEvent' || j.reasoningText !== undefined) {
      const rt = j.reasoningText, t = typeof rt === 'string' ? rt : typeof rt?.text === 'string' ? rt.text : typeof j.text === 'string' ? j.text : '';
      if (t) think += t;
      return;
    }
    if (ev === 'toolUseEvent') {
      for (const x of Array.isArray(j) ? j : [j]) {
        if (!x?.name && !x?.toolUseId) continue;
        const id = String(x.toolUseId || 'call_' + calls.size), c = calls.get(id) || { id, name: '', args: '', obj: null };
        if (x.name) c.name = String(x.name);
        if (typeof x.input === 'string') c.args += x.input;
        else if (x.input && typeof x.input === 'object') c.obj = x.input;
        calls.set(id, c);
      }
      return;
    }
    if (ev === 'contextUsageEvent' && +j.contextUsagePercentage > 0) { pct = +j.contextUsagePercentage; return; }
    if (ev === 'meteringEvent' && +j.usage > 0) credits += +j.usage;
  };
  for await (const chunk of r.body) { poke?.(); for (const f of fr.push(chunk)) handle(f); }
  sp.end();
  const info = modelInfo(model);
  const out = [...calls.values()].filter(c => c.name).map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.obj ? JSON.stringify(c.obj) : c.args.trim() || '{}' } }));
  return { text, calls: out, think: think.trim(), used: pct ? Math.round(pct * (info?.ctx || 200000) / 100) : 0, credits };
}

/* один ответ модели: { text, calls, used, think } — как у остальных провайдеров.
   Ужимает переписку, если не влезла; временные сбои повторяет сам (пока пользователь ничего не увидел).
   Доступ истёк — ошибка с auth: агент обновляет его и зовёт снова */
export async function turn({ token, auth, model, sys, tools = [], msgs = [], think, effort, conv, signal, onText }) {
  let shrink = 0, extra = true, wasted = 0, tries = 0, rever = false, fixes = 0;
  await ideVersion();
  for (;;) {
    const body = build({ sys, msgs, tools, model, think, effort, conv, auth, shrink, extra });
    /* тишина дольше 3 минут — Kiro завис */
    const idle = new AbortController();
    let it = setTimeout(() => idle.abort(), 180e3);
    const poke = () => { clearTimeout(it); it = setTimeout(() => idle.abort(), 180e3); };
    const sig = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
    let streamed = false;
    try {
      const r = await apiFetch(API(regionOf(auth)) + '/generateAssistantResponse', { method: 'POST', headers: hdrs(token, auth), body: JSON.stringify(body), signal: sig });
      if (!r.ok) { const t = await r.text().catch(() => ''); throw fail(r.status, jparse(t), t, model); }
      const res = await readStream(r, { model, poke, onText: d => { streamed = true; onText?.(d); } });
      /* пустой ответ (бывает при перегрузке) — ещё раз, один */
      if (!res.text.trim() && !res.calls.length && !wasted++) continue;
      if (!res.text.trim() && !res.calls.length) throw E('Kiro вернул пустой ответ. Нажми «Повторить» или выбери другую модель.', { detail: '' });
      return res;
    } catch (e) {
      if (signal?.aborted) throw e;
      /* пока пользователь ничего не увидел, можно поправить запрос и повторить */
      if (!streamed) {
        if (e.long && shrink < 3) { shrink++; continue; }
        if (e.extra && extra) { extra = false; NOEXTRA.add(model); continue; }
        /* Kiro сказал «версия устарела» — узнаём свежую и повторяем (один раз) */
        if (e.outdated && !rever) { rever = true; const was = ide(); if (await ideVersion(true) !== was) continue; }
        /* Kiro не принял схему инструмента: упрощаем её (сначала — только имена и описания параметров, потом — без
           параметров) и повторяем; номер не назван — упрощаем все. Запоминаем, чтобы следующие шаги не спотыкались */
        if (e.badTool !== undefined && fixes < 8) {
          const sent = (tools || []).filter(t => (t.function || t)?.name), bad = e.badTool >= 0 ? [sent[e.badTool]].filter(Boolean) : fixes ? [] : sent;
          const up = bad.filter(t => (PLAIN.get(plainKey(t)) || 0) < 2);
          if (up.length) {
            if (PLAIN.size > 500) PLAIN.clear();
            for (const t of up) { PLAIN.set(plainKey(t), (PLAIN.get(plainKey(t)) || 0) + 1); console.warn('kiro: схема инструмента ' + (t.function || t).name + ' не принята — упрощаю: ' + e.detail); }
            fixes++; continue;
          }
          if (bad.length === 1) e.human = e.message = 'Kiro не принял описание инструмента «' + (bad[0].function || bad[0]).name + '». Выключи его: настройки → Инструменты.';
        }
      }
      const net = !e.human && (e instanceof TypeError || idle.signal.aborted || e.name === 'AbortError');
      if ((net || e.retry) && !streamed && tries < 3) {
        await sleep((e.wait ? [5000, 15000, 30000] : [2000, 8000, 20000])[tries++], signal);
        if (signal?.aborted) throw signal.reason;
        continue;
      }
      if (net) throw E(idle.signal.aborted ? 'Kiro не отвечает уже 3 минуты. Нажми «Повторить».' : netHuman(e), { detail: '' });
      throw e;
    } finally { clearTimeout(it); }
  }
}

/* короткий вопрос без инструментов (название чата): самая «дешёвая» модель из каталога */
export async function ask({ token, auth, model, prompt, signal }) {
  const cheap = (lastCat?.list || []).filter(m => m.rate !== null && !caps(m.id).must).sort((a, b) => a.rate - b.rate)[0]?.id;
  const r = await turn({ token, auth, model: cheap || model, msgs: [{ role: 'user', content: prompt }], conv: 'title:' + rid(6), signal });
  return r.text;
}
