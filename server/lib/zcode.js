/* Провайдер Z Code (zcode.z.ai — среда разработки от Z.ai): модели GLM по твоему аккаунту Z.ai (или BigModel в Китае)
   с подпиской GLM Coding Plan — тем же входом, что у самого Z Code, без сторонних шлюзов (включён прокси в настройках →
   Сервер — запросы идут через него).

   Вход — как у Z Code CLI: сервер просит у zcode.z.ai «поток входа» (oauth/cli/init) и получает адрес страницы входа
   Z.ai (или BigModel). Приложение открывает её окошком в ТВОЁМ браузере: там входишь как обычно (Google, GitHub,
   почта) и нажимаешь «Разрешить». Z.ai возвращает окно не на localhost, а на сервер самого Z Code — поэтому ничего не
   нужно ни копировать, ни вставлять, ни пробрасывать туннелем: наш сервер сам спрашивает zcode.z.ai «готово?»
   (oauth/cli/poll) и, как только ты разрешил, получает вход. Вход доводится до конца на сервере, даже если окно
   настроек закрыли.

   Дальше сервер сам — как Z Code при первом входе: меняет вход на доступ к кабинету (z/login), находит личный проект
   аккаунта, берёт (или создаёт) его API-ключ «zcode-api-key» и смотрит подписку. Есть GLM Coding Plan — модели идут
   через адрес Coding Plan; место в командной подписке — через ключ команды; подписки нет — через обычный API z.ai
   (бесплатные модели Flash и платные по балансу). API-ключ не истекает: обновлять нечего, войти снова нужно, только
   если ключ удалили в кабинете.

   Запрос к модели — обычный OpenAI-совместимый (chat/completions, поток SSE), его делает agent.js: инструменты родные,
   размышления (reasoning_content) возвращаются той же модели в следующих шагах — GLM продолжает мысль между вызовами
   инструментов. Здесь — вход, ключ, модели (каталог самого Z Code), лимиты Coding Plan и понятные ошибки. */
import crypto from 'node:crypto';
import { apiFetch } from './net.js';

export const ZC_BASE = 'https://zcode.z.ai';
export const isZcode = base => {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return false;
  try { return new URL(b).hostname.toLowerCase() === 'zcode.z.ai'; } catch { return false; }
};
export const SITES = ['zai', 'bigmodel'];
export const SITE_NAME = { zai: 'Z.ai', bigmodel: 'BigModel' };

/* ---------- адреса (для тестов — переменные окружения) ---------- */
const envUrl = k => String(process.env[k] || '').trim().replace(/\/+$/, '');
const ROOT = () => envUrl('PERSONALCOMPUTER_ZC_URL') || 'https://zcode.z.ai';
/* кабинет и API: у Z.ai — один адрес, у BigModel кабинет на bigmodel.cn, а API — на open.bigmodel.cn */
const ZAI = () => envUrl('PERSONALCOMPUTER_ZC_ZAI_URL') || 'https://api.z.ai';
const BM = () => envUrl('PERSONALCOMPUTER_ZC_BM_URL') || 'https://bigmodel.cn';
const BM_OPEN = () => envUrl('PERSONALCOMPUTER_ZC_BMOPEN_URL') || 'https://open.bigmodel.cn';
const bizRoot = site => site === 'bigmodel' ? BM() : ZAI();
const apiRoot = site => site === 'bigmodel' ? BM_OPEN() : ZAI();
/* адрес OpenAI-совместимого API: Coding Plan — свой (лимиты подписки), без подписки — обычный (баланс, бесплатные Flash) */
export const apiBase = a => apiRoot(a?.site) + (a?.api === 'paas' ? '/api/paas/v4' : '/api/coding/paas/v4');

/* ---------- версия Z Code ----------
   Запросы к zcode.z.ai идут «от имени» Z Code. Свежую версию берём там же, где её узнаёт сам Z Code, — в его файле
   обновлений (раз в 6 часов); своя версия — PERSONALCOMPUTER_ZC_VERSION */
const VER_KNOWN = '4.0.0', VER_MIN = '3.0.0';
const VER_URL = () => envUrl('PERSONALCOMPUTER_ZC_VERSION_URL') || ROOT() + '/api/v1/releases/electron/manifest?platform=linux-x86_64&channel=1';
const semver = v => /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(String(v || '')) ? String(v) : '';
const cmpv = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
let VER = VER_KNOWN, verAt = 0, verPend = null;
export const appVersion = () => semver(process.env.PERSONALCOMPUTER_ZC_VERSION) || VER;
export function version(force) {
  if (semver(process.env.PERSONALCOMPUTER_ZC_VERSION)) return Promise.resolve(appVersion());
  if (!force && Date.now() - verAt < 6 * 3600e3) return Promise.resolve(VER);
  return verPend ||= (async () => {
    try {
      const r = await apiFetch(VER_URL(), { headers: { 'User-Agent': 'ZCode/' + VER, Accept: 'application/x-yaml,text/yaml,text/plain,*/*' }, signal: AbortSignal.timeout(8000) });
      const t = r.ok ? (await r.text()).slice(0, 8192) : '';
      const v = semver((/^version:\s*['"]?([\d.]+)['"]?\s*(?:#.*)?$/m.exec(t) || [])[1]);
      if (v && cmpv(v, VER_MIN) >= 0 && cmpv(v, VER) > 0) VER = v;
      verAt = Date.now();
    } catch { verAt = Date.now() - 5 * 3600e3; /* сеть подвела — спросим снова через час */ }
    finally { verPend = null; }
    return VER;
  })();
}

/* ---------- запросы ---------- */
const sleep = (ms, sig) => new Promise(ok => { const t = setTimeout(ok, ms); sig?.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true }); });
const jparse = t => { try { return JSON.parse(t); } catch { return null; } };
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const str = v => v === null || v === undefined ? '' : typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
const E = (msg, o = {}) => Object.assign(new Error(msg), { human: msg, ...o });
const netHuman = (e, who = 'Z.ai') => 'Не достучался до ' + who + ' (' + (e?.cause?.code || e?.message || 'сеть') + '). ' + (e?.proxy ? 'Проверь прокси: настройки → Сервер → «Прокси».' : 'Проверь интернет на сервере.');
const AGAIN = 'Войди снова: настройки → Модель → Z Code → «Войти через Z.ai».';
const uuidOf = buf => { const d = Buffer.from(buf.subarray(0, 16)); d[6] = (d[6] & 0x0f) | 0x40; d[8] = (d[8] & 0x3f) | 0x80; const h = d.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
/* устройство входа — как у Z Code CLI: из случайного ключа потока, чтобы опрос шёл от того же «устройства» */
export const deviceOf = bearer => uuidOf(crypto.createHash('sha256').update(Buffer.concat([Buffer.from('zcode-device-v1\0'), bearer])).digest());

/* ответ кабинета и zcode.z.ai: { code, msg, data } — код 0 или 200 значит «всё хорошо» */
async function call(method, url, { auth, device, headers, body, signal } = {}) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'ZCode/' + appVersion(), ...headers };
  if (auth) h.Authorization = auth;
  if (device) h['X-Device-Mid'] = device;
  let r;
  try { r = await apiFetch(url, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: signal || AbortSignal.timeout(25000) }); }
  catch (e) { throw E(netHuman(e, /bigmodel/.test(url) ? 'BigModel' : 'Z.ai'), { status: 502, net: true }); }
  const t = await r.text().catch(() => ''), j = jparse(t);
  const code = isObj(j) ? str(j.code) : '';
  if (!r.ok || !isObj(j) || (code && code !== '0' && code !== '200')) {
    const msg = isObj(j) ? str(j.msg || j.message || j.error?.message || (typeof j.error === 'string' ? j.error : '')) : '';
    throw Object.assign(new Error('HTTP ' + r.status + (code ? ' · код ' + code : '') + (msg ? ': ' + msg.slice(0, 200) : '')), { status: r.status, code, msg, body: t.slice(0, 500) });
  }
  return j.data !== undefined ? j.data : j;
}

/* ====================================================================================================
   Вход окном Z.ai (или BigModel): без localhost и вставки адресов — сервер сам спрашивает zcode.z.ai «готово?»
   ==================================================================================================== */
const logins = new Map();
const pubLogin = s => s ? { state: s.st, url: s.url, exp: s.exp, msg: s.msg, login: s.login || '', site: s.site } : { state: 'none' };
export const loginOf = uid => pubLogin(logins.get(uid));
export function loginStop(uid) {
  const s = logins.get(uid);
  if (s) { s.stopped = true; clearTimeout(s.timer); logins.delete(uid); }
}
/* итог держим 3 минуты (вторая вкладка приложения тоже увидит), потом забываем */
function finish(s, st, msg) {
  s.st = st; s.msg = msg; clearTimeout(s.timer);
  s.timer = setTimeout(() => { if (logins.get(s.uid) === s) logins.delete(s.uid); }, 180e3); s.timer.unref?.();
}
/* адрес страницы входа — только https (http — лишь для своего компьютера: так устроены тесты) */
const okUrl = u => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(x.hostname)); } catch { return false; } };
/* начать вход: адрес страницы входа; done(t) — подключить аккаунт (server.js), может вернуть, чей он */
export async function loginStart(uid, site, done) {
  loginStop(uid);
  if (!SITES.includes(site)) site = 'zai';
  await version();
  const bearer = crypto.randomBytes(32), device = deviceOf(bearer), auth = 'Bearer ' + bearer.toString('hex');
  let d;
  try { d = await call('POST', ROOT() + '/api/v1/oauth/cli/init', { auth, device, body: { provider: site } }); }
  catch (e) { throw E(e.human || 'Z Code не начал вход: ' + e.message, { status: 502 }); }
  const flow = str(d?.flow_id), url = str(d?.authorize_url), expS = +d?.expires_at || 0;
  if (!flow || !okUrl(url)) throw E('Z Code вернул непонятный адрес входа — попробуй ещё раз чуть позже.', { status: 502 });
  /* срок — как сказал Z Code, но не больше 15 минут и не меньше 2 */
  const exp = Math.min(Date.now() + 15 * 60e3, Math.max(Date.now() + 2 * 60e3, expS > 1e9 ? expS * 1000 : 0));
  const s = { uid, site, st: 'wait', flow, auth, device, url, exp, every: Math.min(10e3, Math.max(200, (+d?.poll_interval_sec || 2) * 1000)), msg: '', login: '', done, stopped: false, fails: 0 };
  logins.set(uid, s);
  s.timer = setTimeout(() => poll(s), s.every); s.timer.unref?.();
  return pubLogin(s);
}
async function poll(s) {
  if (s.stopped || s.st !== 'wait') return;
  if (Date.now() >= s.exp) return finish(s, 'fail', 'Время на вход вышло — нажми «Войти через ' + SITE_NAME[s.site] + '» ещё раз.');
  const again = (ms = s.every) => { if (!s.stopped && s.st === 'wait') { s.timer = setTimeout(() => poll(s), ms); s.timer.unref?.(); } };
  let d;
  try { d = await call('GET', ROOT() + '/api/v1/oauth/cli/poll/' + encodeURIComponent(s.flow), { auth: s.auth, device: s.device, signal: AbortSignal.timeout(20000) }); }
  catch (e) {
    if (s.stopped) return;
    /* сеть, перегрузка, «слишком часто» — просто спросим ещё раз (реже) */
    if (e.net || !e.status || e.status >= 500 || e.status === 408 || e.status === 429) { s.fails++; return again(Math.min(15e3, s.every * (1 + s.fails))); }
    return finish(s, 'fail', e.status === 404 || e.status === 410 ? 'Этот вход уже закончился — нажми «Войти через ' + SITE_NAME[s.site] + '» ещё раз.' : 'Z Code не пустил: ' + (e.msg || 'HTTP ' + e.status) + '. Нажми «Войти» ещё раз.');
  }
  if (s.stopped) return;
  s.fails = 0;
  const st = str(d?.status).toLowerCase();
  if (!st || st === 'pending' || st === 'waiting') return again();
  if (st !== 'ready' && st !== 'success' && st !== 'done') return finish(s, 'fail', st === 'expired' ? 'Время на вход вышло — нажми «Войти» ещё раз.' : 'Вход отменён на странице ' + SITE_NAME[s.site] + ' — нажми «Войти» ещё раз.');
  /* у BigModel токен бывает под двумя именами */
  const siteToken = s.site === 'bigmodel' ? str(d?.bigmodel?.access_token) || str(d?.bigmodel?.accessToken) : str(d?.zai?.access_token);
  const jwt = str(d?.token), u = isObj(d?.user) ? d.user : {};
  if (!siteToken || !jwt) return finish(s, 'fail', 'Z Code сказал «готово», но не прислал вход — нажми «Войти» ещё раз.');
  const email = str(u.email).replace(/@phone\.local$/i, ''), name = str(u.name);
  s.st = 'save'; s.msg = '';
  try {
    s.login = (await s.done({ site: s.site, siteToken, jwt, device: s.device, email: email.slice(0, 200), name: name.slice(0, 100), uid: str(u.user_id || u.id).slice(0, 100) })) || email || name;
    if (!s.stopped) finish(s, 'ok', 'Z Code подключён' + (s.login ? ': ' + s.login : '') + '.');
  } catch (e) { if (!s.stopped) finish(s, 'fail', 'Вход прошёл, но подключить аккаунт не вышло: ' + (e.human || e.message)); }
}

/* ====================================================================================================
   После входа: доступ к кабинету, личный проект, его API-ключ и подписка (так же делает сам Z Code)
   ==================================================================================================== */
const DEF_ORG = '默认机构', DEF_PROJ = '默认项目';
/* личный проект: в организации «по умолчанию», проект «по умолчанию»; командные (тип 2) — не личные */
export function personal(info) {
  let org = '', project = '';
  for (const o of Array.isArray(info?.organizations) ? info.organizations : []) {
    const oid = str(o?.organizationId);
    if (!oid) continue;
    let picked = '';
    for (const p of Array.isArray(o.projects) ? o.projects : []) {
      const pid = str(p?.projectId);
      if (!pid || str(p.projectType) === '2') continue;
      if (!picked || String(p.projectName || '').includes(DEF_PROJ)) picked = pid;
      if (String(p.projectName || '').includes(DEF_PROJ)) break;
    }
    if (!picked) continue;
    if (!org || String(o.organizationName || '').includes(DEF_ORG)) { org = oid; project = picked; }
    if (String(o.organizationName || '').includes(DEF_ORG)) break;
  }
  return { org, project };
}
const teamHeaders = (org, project) => ({ 'Bigmodel-Organization': org, 'Bigmodel-Project': project, 'Set-Language': 'en', 'Accept-Language': 'en-US,en' });
/* ключ проекта: тот же «zcode-api-key», что создаёт сам Z Code (нет — создаём), целиком — «id.секрет» */
async function projectKey(site, biz, org, project, team) {
  const url = bizRoot(site) + '/api/biz/v1/organization/' + encodeURIComponent(org) + '/projects/' + encodeURIComponent(project) + '/api_keys';
  const headers = team ? teamHeaders(org, project) : {}, name = team ? 'zcode-team-api-key' : 'zcode-api-key';
  const list = await call('GET', url, { auth: biz, headers });
  let id = '';
  for (const k of Array.isArray(list) ? list : []) if (k?.name === name && (!team || str(k.keyType) === '2') && str(k.apiKey)) id = str(k.apiKey);
  if (!id) {
    const made = await call('POST', url, { auth: biz, headers, body: team ? { name, keyType: 2 } : { name } });
    id = str(made?.apiKey);
    if (!id) throw E('кабинет не создал API-ключ', { status: 502 });
  }
  const sec = await call('GET', url + '/copy/' + encodeURIComponent(id), { auth: biz, headers });
  if (!str(sec?.secretKey)) throw E('кабинет не отдал секрет API-ключа', { status: 502 });
  return id + '.' + str(sec.secretKey);
}
/* подписка по ключу: { plan } — действующая GLM Coding Plan, null — нет */
async function subscription(site, key) {
  const subs = await call('GET', bizRoot(site) + '/api/biz/subscription/list', { auth: key });
  const v = (Array.isArray(subs) ? subs : []).find(x => String(x?.status || '').toUpperCase() === 'VALID');
  return v ? { plan: str(v.productName) || 'GLM Coding Plan' } : null;
}
/* место в командной подписке: ключ команды; нет места — почему (по-человечески) */
async function team(site, biz, info) {
  let why = '';
  for (const o of Array.isArray(info?.organizations) ? info.organizations : []) {
    for (const p of Array.isArray(o?.projects) ? o.projects : []) {
      const org = str(o.organizationId), project = str(p?.projectId);
      if (!org || !project || str(p.projectType) !== '2') continue;
      let d;
      try { d = await call('GET', bizRoot(site) + '/api/biz/team/subscribe/product/querySubscribeDetail', { auth: biz, headers: teamHeaders(org, project) }); }
      catch { continue; }
      const st = String(d?.status || '').toUpperCase(), grant = String(d?.memberGrantStatus || '').toUpperCase();
      if (d?.hasSubscription !== false && st === 'EFFECTIVE' && grant === 'VALID') {
        const key = await projectKey(site, biz, org, project, true).catch(() => '');
        if (key) return { key, plan: str(d.productName) || 'GLM Coding Team', org, project };
        why ||= 'ключ командной подписки недоступен';
      }
      if (!why && st === 'EFFECTIVE' && grant === 'UNASSIGNED') why = 'ты в команде с GLM Coding Plan, но место в подписке тебе ещё не выдали — попроси админа команды и войди снова';
      if (!why && st === 'EXPIRED') why = 'командная GLM Coding Plan истекла';
    }
  }
  return { why };
}
/* t — что прислал вход: { site, siteToken, jwt, email, name }. Итог: { key, auth } — ключ провайдера и что храним */
export async function connect(t) {
  const site = SITES.includes(t.site) ? t.site : 'zai';
  let biz = t.siteToken;
  /* Z.ai: вход Z Code → доступ к кабинету api.z.ai; у BigModel кабинет принимает вход как есть */
  if (site === 'zai') {
    let d;
    try { d = await call('POST', ZAI() + '/api/auth/z/login', { body: { token: t.siteToken } }); }
    catch (e) { throw E(e.human || 'Z.ai не пустил в кабинет (' + (e.msg || 'HTTP ' + e.status) + '). Нажми «Войти» ещё раз.', { status: 502 }); }
    if (!str(d?.access_token)) throw E('Z.ai не выдал доступ к кабинету — нажми «Войти» ещё раз.', { status: 502 });
    biz = 'Bearer ' + str(d.access_token);
  }
  let info;
  try { info = await call('GET', bizRoot(site) + '/api/biz/customer/getCustomerInfo', { auth: biz }); }
  catch (e) { throw E(e.human || 'не узнал аккаунт в кабинете ' + SITE_NAME[site] + ' (' + (e.msg || 'HTTP ' + e.status) + ')', { status: 502 }); }
  const base = { site, email: t.email || '', name: t.name || '', how: 'zcode', t: Date.now() };
  /* 1) личная подписка */
  const { org, project } = personal(info);
  let key = '', keyErr = null;
  if (org) {
    try { key = await projectKey(site, biz, org, project, false); } catch (e) { keyErr = e; }
    if (key) {
      const sub = await subscription(site, key).catch(() => null);
      if (sub) return { key, auth: { ...base, api: 'coding', plan: sub.plan } };
    }
  }
  /* 2) место в командной подписке */
  const tm = await team(site, biz, info);
  if (tm.key) return { key: tm.key, auth: { ...base, api: 'coding', plan: tm.plan, team: true, org: tm.org, project: tm.project } };
  /* 3) подписки нет — обычный API по личному ключу: бесплатные модели Flash и платные по балансу */
  if (key) return { key, auth: { ...base, api: 'paas', plan: '', why: tm.why || '' } };
  throw E(tm.why ? 'У аккаунта нет своего проекта, а ' + tm.why : 'Не получил API-ключ в кабинете ' + SITE_NAME[site] + (keyErr ? ' (' + (keyErr.msg || keyErr.message) + ')' : ': у аккаунта нет проекта') + '. Открой ' + (site === 'bigmodel' ? 'bigmodel.cn' : 'z.ai') + ' один раз в браузере и войди снова.', { status: 502 });
}

/* ---------- «Ключ вручную»: API-ключ z.ai / BigModel (id.секрет) ---------- */
export function parseKey(text) {
  let s = String(text || '').trim().replace(/^["'`]+|["'`,;]+$/g, '').replace(/^Bearer\s+/i, '');
  const j = jparse(s);
  if (isObj(j)) {
    let found = '';
    const walk = (o, d = 0) => { if (!isObj(o) || d > 5 || found) return; for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && /^(api_?key|key|token|zai_?api_?key|anthropic_auth_token)$/i.test(k) && /\./.test(v)) { found = v.trim(); return; } walk(v, d + 1); } };
    walk(j); s = found;
  }
  /* строка из .env или export: ZAI_API_KEY=… */
  const m = /(?:^|[\s=:])([0-9a-zA-Z_-]{16,}\.[0-9a-zA-Z_-]{8,})(?:\s|$)/.exec(' ' + s + ' ');
  if (!m) throw E('Это не API-ключ z.ai: он выглядит как «длинный_id.секрет» — возьми его на z.ai → API Keys (или bigmodel.cn).', { status: 400 });
  return m[1];
}
/* проверить ключ: чей сайт (сначала выбранный), есть ли GLM Coding Plan */
export async function importKey(text, site) {
  const key = parseKey(text);
  const order = SITES.includes(site) ? [site, ...SITES.filter(x => x !== site)] : SITES;
  let last = null;
  for (const st of order) {
    try {
      const sub = await subscription(st, key);
      return { key, auth: { site: st, api: sub ? 'coding' : 'paas', plan: sub?.plan || '', email: '', name: '', how: 'key', t: Date.now() } };
    } catch (e) { last = e; if (e.net || (e.status && e.status !== 401 && e.status !== 403 && !/^100[0-4]$/.test(e.code))) break; }
  }
  if (last?.net) throw last;
  throw E(last && (last.status === 401 || last.status === 403 || /^100[0-4]$/.test(last.code)) ? 'Ключ не подошёл ни к Z.ai, ни к BigModel — проверь его в кабинете (API Keys).' : 'Не проверил ключ: ' + (last?.msg || last?.message || 'ошибка'), { status: 400 });
}

/* ====================================================================================================
   Модели: каталог самого Z Code (какие модели у Coding Plan, контекст, картинки, размышление)
   ==================================================================================================== */
/* запасной список — если каталог не пришёл: как у Z Code сейчас */
const FALLBACK = [
  ['glm-5.3', 'GLM-5.3', 1000000, 128000, false, ['low', 'high', 'max']],
  ['glm-5.3-flash', 'GLM-5.3-Flash', 1000000, 128000, false, ['low', 'high', 'max']],
  ['glm-5.2', 'GLM-5.2', 1000000, 128000, false, ['none', 'high', 'max']],
  ['glm-5-turbo', 'GLM-5-Turbo', 200000, 64000, false, ['none', 'high']],
];
/* обычный API без подписки: бесплатные Flash — первыми */
const FALLBACK_PAAS = [
  ['glm-4.7-flash', 'GLM-4.7-Flash', 200000, 128000, false, ['none', 'high'], true],
  ['glm-4.5-flash', 'GLM-4.5-Flash', 128000, 96000, false, ['none', 'high'], true],
  ['glm-4.6v-flash', 'GLM-4.6V-Flash', 128000, 32000, true, ['none', 'high'], true],
];
const toInfo = (id, name, ctx, out, img, levels, free) => {
  const lv = (levels || []).map(v => v === 'disabled' ? 'none' : v === 'enabled' ? 'high' : v);
  const think = lv.some(v => v !== 'none'), must = think && !lv.includes('none');
  return { id: String(id).toLowerCase(), name: name || id, ctx: +ctx || 0, out: +out || 0, img: img ?? /v(-|$)|vision|ocr/i.test(id), think, must, ...(free ? { free: true } : {}) };
};
let cat = { at: 0, ver: '', doc: null }, catPend = null;
async function catalog() {
  const v = appVersion();
  if (cat.doc && cat.ver === v && Date.now() - cat.at < 10 * 60e3) return cat.doc;
  return catPend ||= (async () => {
    let doc = null;
    try {
      const d = await call('GET', ROOT() + '/api/v1/client/configs?' + new URLSearchParams({ app_version: v, platform: 'linux-x64' }), { device: crypto.randomUUID(), signal: AbortSignal.timeout(15000) });
      const u = str(d?.configs?.builtin_provider_config_json);
      if (okUrl(u)) {
        const r = await apiFetch(u, { headers: { 'User-Agent': 'ZCode/' + v }, signal: AbortSignal.timeout(15000) });
        doc = r.ok ? jparse(await r.text()) : null;
      }
    } catch {}
    cat = { at: Date.now() - (doc ? 0 : 8 * 60e3), ver: v, doc: isObj(doc) ? doc : null };
    catPend = null;
    return cat.doc;
  })();
}
/* модели плана из каталога: какие включены и что умеют (правила по шаблону имени) */
export function fromCatalog(doc, a) {
  if (!isObj(doc?.config)) return [];
  const plan = 'account:' + (a?.site === 'bigmodel' ? 'bigmodel' : 'zai') + '-individual-coding-plan';
  const ids = [], seen = new Set(), off = new Set();
  const add = id => { id = str(id); const k = id.toLowerCase(); if (id && !seen.has(k)) { seen.add(k); ids.push(id); } };
  for (const r of doc.config.providerConfigRules?.providerRules || []) if (r?.providerId === plan) for (const id of r.builtinModelIds || []) add(id);
  for (const r of doc.config.modelConfigRules?.builtinProviderModelRules || []) {
    if (r?.providerId !== plan) continue;
    if (r.config?.enabled === false) off.add(str(r.modelId).toLowerCase()); else add(r.modelId);
  }
  const rules = (doc.config.modelConfigRules?.modelRules || []).map(r => { try { return { re: new RegExp('^(?:' + r.modelMatch + ')$', 'i'), c: r.config || {} }; } catch { return null; } }).filter(Boolean);
  return ids.filter(id => !off.has(id.toLowerCase())).map(id => {
    const fb = FALLBACK.find(f => f[0] === id.toLowerCase());
    let ctx = fb?.[2] || 0, out = fb?.[3] || 0, img = fb ? fb[4] : undefined, levels = fb?.[5] || null;
    for (const { re, c } of rules) {
      if (!re.test(id)) continue;
      if (+c.properties?.contextWindow > 0) ctx = +c.properties.contextWindow;
      if (+c.optionSpecs?.maxOutputTokens?.max > 0) out = +c.optionSpecs.maxOutputTokens.max;
      if (typeof c.properties?.inputFormat?.supportsImage === 'boolean') img = c.properties.inputFormat.supportsImage;
      if (Array.isArray(c.optionSpecs?.reasoningLevel?.values) && c.optionSpecs.reasoningLevel.values.length) levels = c.optionSpecs.reasoningLevel.values;
    }
    return toInfo(id, id, ctx, out, img, levels);
  });
}
/* модели аккаунта: у Coding Plan — из каталога Z Code; у обычного API — что ответит /models (бесплатные Flash — первыми) */
let lastList = [];
export const modelInfo = id => lastList.find(m => m.id === String(id || '').toLowerCase()) || null;
export async function models(key, a) {
  let list = [], live = false;
  if (a?.api !== 'paas') {
    list = fromCatalog(await catalog(), a);
    live = list.length > 0;
    if (!list.length) list = FALLBACK.map(f => toInfo(...f));
  } else {
    try {
      const r = await apiFetch(apiBase(a) + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
      const j = r.ok ? jparse(await r.text()) : null, arr = Array.isArray(j?.data) ? j.data : [];
      const ids = arr.map(m => str(m?.id)).filter(x => /^glm/i.test(x));
      if (ids.length) {
        live = true;
        list = ids.map(id => { const f = FALLBACK_PAAS.find(x => x[0] === id.toLowerCase()); return f ? toInfo(...f) : toInfo(id, id.toUpperCase().replace(/V-FLASH$/, 'V-Flash').replace(/-FLASH/, '-Flash').replace(/-AIR/, '-Air').replace(/-TURBO/, '-Turbo'), 0, 0, undefined, ['none', 'high'], /flash$/i.test(id) && !/flashx/i.test(id)); });
        list.sort((x, y) => (y.free ? 1 : 0) - (x.free ? 1 : 0));
      }
    } catch {}
    if (!list.length) list = FALLBACK_PAAS.map(f => toInfo(...f));
  }
  lastList = list;
  return { list, live };
}

/* ====================================================================================================
   Лимиты Coding Plan: окно 5 часов, неделя, MCP (поиск и чтение страниц у z.ai)
   ==================================================================================================== */
export async function quota(key, a) {
  if (a?.api === 'paas' || !key) return [];
  let url = bizRoot(a.site) + '/api/monitor/usage/quota/limit', headers = {};
  if (a.team && a.org && a.project) { url += '?type=2'; headers = teamHeaders(a.org, a.project); }
  else if (a.site === 'bigmodel') url = BM_OPEN() + '/api/monitor/usage/quota/limit';
  let d;
  try { d = await call('GET', url, { auth: key, headers, signal: AbortSignal.timeout(15000) }); } catch { return []; }
  const out = [];
  for (const l of Array.isArray(d?.limits) ? d.limits : []) {
    const pct = +l?.percentage;
    if (!Number.isFinite(pct)) continue;
    const unit = +l.unit, n = +l.number || 0;
    let name = '';
    if (l.type === 'TOKENS_LIMIT' && unit === 3 && (n === 5 || n === 0)) name = 'Окно 5 часов';
    else if (l.type === 'TOKENS_LIMIT' && ((unit === 6 && (n === 1 || n === 0)) || (unit === 4 && n === 7))) name = 'Неделя';
    else if (l.type === 'TIME_LIMIT') name = 'Поиск и чтение страниц (MCP)';
    else continue;
    const reset = +l.nextResetTime > 0 ? +l.nextResetTime : 0;
    out.push({ name, left: Math.max(0, Math.min(1, 1 - pct / 100)), reset: reset && reset < 1e12 ? reset * 1000 : reset });
  }
  return out;
}

/* проверка в настройках: модели, чей аккаунт, план, лимиты */
export async function check(key, a) {
  if (!key) throw E('Войди в Z Code: «Войти через Z.ai».', { status: 401, needKey: true });
  await version();
  const [m, q] = await Promise.all([models(key, a || {}), quota(key, a || {})]);
  /* ключ удалили в кабинете — понять можно по лимитам (у Coding Plan) или по /models (у обычного API) */
  if (a?.api !== 'paas' && !q.length) {
    try { await call('GET', bizRoot(a?.site) + '/api/biz/subscription/list', { auth: key, signal: AbortSignal.timeout(15000) }); }
    catch (e) { if (e.status === 401 || /^100[0-4]$/.test(e.code)) throw E('Ключ Z Code больше не действует (его удалили в кабинете?). ' + AGAIN, { status: 401, relogin: true }); }
  }
  const def = m.list.find(x => x.id === 'glm-5.3')?.id || m.list.find(x => x.free)?.id || m.list[0]?.id || '';
  return { models: m.list.map(x => x.id), info: m.list, def, live: m.live, login: a?.email || a?.name || '', plan: a?.plan || '', site: a?.site || 'zai', api: a?.api || 'coding',
    team: !!a?.team, how: a?.how || 'zcode', why: a?.why || '', quota: q };
}

/* ====================================================================================================
   Запрос к модели: дополнения к телу chat/completions и понятные ошибки (сам запрос — в agent.js)
   ==================================================================================================== */
/* размышление GLM: включено или нет; при включённом — GLM сохраняет мысль между шагами (мы возвращаем reasoning_content) */
export function extra({ model, think }) {
  const m = modelInfo(model);
  const on = m?.must ? true : m && !m.think ? false : !!think;
  return { thinking: on ? { type: 'enabled', clear_thinking: false } : { type: 'disabled' } };
}
const fmtReset = s => { const m = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/.exec(String(s || '')); return m ? ' Обновится ' + m[1].replace('T', ' ').slice(0, 16) + ' (по Пекину).' : ''; };
/* ошибка API z.ai ({ error: { code, message } }) → по-человечески; retry — подождать и повторить имеет смысл */
export function human(status, j) {
  const e = isObj(j?.error) ? j.error : isObj(j) ? j : {}, code = str(e.code), msg = str(e.message || e.msg);
  if (status === 401 || /^100[0-4]$/.test(code)) return { text: 'Ключ Z Code не подошёл (его удалили в кабинете или он истёк). ' + AGAIN, relogin: true };
  if (code === '1113') return { text: 'Нет денег на балансе или подписка GLM Coding Plan не действует. Продли её на z.ai/subscribe (или пополни баланс) и войди снова — или выбери бесплатную модель Flash.' };
  if (code === '1308') return { text: 'Лимит GLM Coding Plan на эти 5 часов исчерпан.' + fmtReset(msg) };
  if (code === '1310') return { text: 'Недельный лимит GLM Coding Plan исчерпан.' + fmtReset(msg) };
  if (code === '1309') return { text: 'Подписка GLM Coding Plan истекла — продли её на z.ai/subscribe и войди снова.' };
  if (code === '1211' || status === 404) return { text: 'Такой модели у Z Code нет — выбери другую в настройках.' };
  if (code === '1220' || code === '1221' || code === '1311') return { text: 'Эта модель не входит в твой план — выбери другую в настройках.' };
  if (code === '1301') return { text: 'Z.ai отклонил запрос: в нём нашлось что-то запрещённое правилами сервиса. Переформулируй.' };
  if (code === '1261' || status === 413) return { text: 'Переписка не влезла в контекст модели — начни новый чат или выбери модель с большим контекстом.' };
  if (code === '1302' || code === '1303' || code === '1305' || status === 429 || status === 529) return { text: 'Z.ai сейчас перегружен или запросов слишком много — подожду и повторю.', retry: true };
  if (status >= 500) return { text: 'У Z.ai что-то сломалось (HTTP ' + status + '). Повтори чуть позже.', retry: true };
  return msg ? { text: 'Z.ai: ' + msg.slice(0, 300) + (code ? ' (код ' + code + ')' : '') } : null;
}
