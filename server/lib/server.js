/* HTTP-сервер Мочи: страница, API, поток событий чата (SSE), загрузка файлов, прокси терминала.
   Снаружи его закрывает Caddy (HTTPS); сам сервер слушает только 127.0.0.1. */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CFG } from './config.js';
import { ensureDir, flushAll } from './store.js';
import * as A from './auth.js';
import { getChat, resumeAll, DEF_SETTINGS, toolCatalog, setTools } from './agent.js';
import { apiFetch, cfBlock, cfMessage } from './net.js';
import * as X from './ext.js';
import { putInbox, storeCopy, getFile, dropFiles, userDir, safeName } from './files.js';
import * as TG from './telegram.js';
import { TERM_PREFIX, proxyHttp, proxyUpgrade } from './term.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
const COOKIE = CFG.secureCookie ? '__Host-mochi' : 'mochi';

/* ---------- мелочи ---------- */
class HttpErr extends Error { constructor(status, msg, extra) { super(msg); this.status = status; Object.assign(this, extra); } }
const SEC = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), payment=(), usb=()',
};
function json(res, code, obj, h = {}) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { ...SEC, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': b.length, ...h });
  res.end(b);
}
function cookies(req) {
  const o = {};
  for (const p of String(req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return o;
}
const setCookie = (tok, age) => `${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${CFG.secureCookie ? '; Secure' : ''}`;
async function body(req, limit = 2 ** 20) {
  const n = +req.headers['content-length'] || 0;
  if (n > limit) throw new HttpErr(413, 'слишком большой запрос');
  const parts = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpErr(413, 'слишком большой запрос'); parts.push(c); }
  return Buffer.concat(parts);
}
async function jbody(req, limit) {
  const b = await body(req, limit);
  try { const v = JSON.parse(b.toString('utf8') || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch {}
  throw new HttpErr(400, 'ожидался JSON');
}
function clientIp(req) {
  const ra = req.socket.remoteAddress || '';
  if (CFG.trustProxy && /^(::1|127\.|::ffff:127\.)/.test(ra) && req.headers['x-forwarded-for']) {
    const l = String(req.headers['x-forwarded-for']).split(',').map(s => s.trim()).filter(Boolean);
    return l[l.length - 1] || ra; /* последний адрес добавил наш Caddy — его не подделать */
  }
  return ra;
}
/* защита от CSRF: SameSite=Strict + обязательный заголовок (с чужого сайта без CORS его не отправить) + Origin */
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    const u = new URL(o);
    if (CFG.publicUrl && u.origin === new URL(CFG.publicUrl).origin) return true;
    return u.host === req.headers.host;
  } catch { return false; }
}
const userOf = req => A.sessionUser(cookies(req)[COOKIE]);

/* ---------- страница: внедряем режим сервера, CSP с хешами встроенных скриптов ---------- */
let page = null;
function loadPage() {
  const src = fs.readFileSync(path.join(CFG.web, 'index.html'), 'utf8')
    .replace('<head>', '<head>\n<meta name="mochi-server" content="1">')
    .replace(/<\/body>(?![\s\S]*<\/body>)/, '<script src="srv/client.js"></script>\n</body>');
  const hashes = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  const csp = ["default-src 'self'", `script-src 'self' ${hashes.join(' ')}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
    "connect-src 'self'", "media-src 'self' data: blob:", "frame-src 'self'", "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
  const raw = Buffer.from(src);
  page = { raw, gz: zlib.gzipSync(raw, { level: 9 }), br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } }), etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20) + '"', csp };
}
const STATIC = {
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/srv/client.js': [path.join('server', 'public', 'client.js'), 'text/javascript; charset=utf-8'],
};
for (const f of ['icon-192.png', 'icon-512.png', 'maskable-192.png', 'maskable-512.png', 'apple-touch-icon.png']) STATIC['/icons/' + f] = [path.join('icons', f), 'image/png'];
const statCache = new Map();
async function serveStatic(req, res, p) {
  const [file, type] = STATIC[p];
  let c = statCache.get(p);
  if (!c || CFG.dev) {
    const raw = await fsp.readFile(path.join(CFG.web, file));
    c = { raw, gz: /javascript|json|manifest/.test(type) ? zlib.gzipSync(raw) : null, etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20) + '"' };
    statCache.set(p, c);
  }
  sendBuf(req, res, c, { 'content-type': type, 'cache-control': p.startsWith('/icons/') ? 'public, max-age=86400' : 'no-cache', ...(p === '/sw.js' ? { 'service-worker-allowed': '/' } : {}) });
}
function sendBuf(req, res, c, h) {
  if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, { ...SEC, etag: c.etag }); return res.end(); }
  const ae = String(req.headers['accept-encoding'] || '');
  const [b, enc] = c.br && /\bbr\b/.test(ae) ? [c.br, 'br'] : c.gz && /\bgzip\b/.test(ae) ? [c.gz, 'gzip'] : [c.raw, null];
  res.writeHead(200, { ...SEC, ...h, etag: c.etag, vary: 'accept-encoding', 'content-length': b.length, ...(enc ? { 'content-encoding': enc } : {}) });
  res.end(req.method === 'HEAD' ? undefined : b);
}

/* ---------- поток событий чата (SSE) ---------- */
function stream(req, res, u) {
  const chat = getChat(u);
  res.writeHead(200, { ...SEC, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' });
  const send = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
  send('snap', { ...chat.snapshot(), user: A.publicUser(u) });
  const on = {
    log: e => send('log', e), delta: d => send('delta', { d }), run: r => send('run', r),
    reset: () => send('snap', chat.snapshot()),
  };
  for (const k in on) chat.on(k, on[k]);
  chat.clients.add(res);
  const hb = setInterval(() => res.write(': ping\n\n'), 25000);
  const done = () => { clearInterval(hb); chat.clients.delete(res); for (const k in on) chat.off(k, on[k]); };
  req.on('close', done); res.on('error', done);
}

/* ---------- настройки модели (ключ наружу не отдаём) ---------- */
const pubSettings = c => { const { key, ...s } = c.settings(); return { ...s, hasKey: !!key }; };
function putSettings(c, b) {
  const s = c.set.v;
  if (b.base !== undefined) {
    const base = String(b.base).trim().replace(/\/+$/, '');
    if (base && !/^https?:\/\/[^\s]+$/i.test(base)) throw new HttpErr(400, 'Адрес API должен начинаться с http:// или https://');
    s.base = base || DEF_SETTINGS.base;
  }
  if (b.clearKey) s.key = '';
  else if (typeof b.key === 'string' && b.key.trim()) s.key = b.key.trim().slice(0, 500);
  if (b.model !== undefined) s.model = String(b.model).trim().slice(0, 200) || DEF_SETTINGS.model;
  if (b.sys !== undefined) s.sys = String(b.sys).trim().slice(0, 20000) || DEF_SETTINGS.sys;
  if (b.search !== undefined) s.search = !!b.search;
  if (b.vis !== undefined) { s.vis = !!b.vis; c.noVis = 0; }
  c.set.save();
}
/* провайдеры, у которых /models открыт всем: по нему не понять, подходит ли ключ */
const hostIs = (base, re) => { try { return re.test(new URL(base).hostname); } catch { return false; } };
const isOpenRouter = base => hostIs(base, /(^|\.)openrouter\.ai$/i);
const isOllamaCloud = base => hostIs(base, /(^|\.)ollama\.com$/i);
async function models(c, b) {
  const S = c.settings();
  const base = String(b.base || S.base).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new HttpErr(400, 'неверный адрес API');
  const key = String(b.key || '').trim() || (base === S.base ? S.key : '');
  const auth = key ? { Authorization: 'Bearer ' + key } : {};
  const r = await apiFetch(base + '/models', { headers: auth, signal: AbortSignal.timeout(15000) })
    .catch(e => { throw new HttpErr(502, 'сервер модели не отвечает: ' + (e.cause?.code || e.message)); });
  if (!r.ok) {
    const cf = cfBlock(r.status, await r.clone().text().catch(() => ''), r.headers);
    if (cf) throw new HttpErr(502, cfMessage(cf, base + '/models', r.headers));
    throw new HttpErr(r.status === 401 || r.status === 403 ? r.status : 502, 'HTTP ' + r.status, { upstream: r.status });
  }
  const j = await r.json().catch(() => null);
  const arr = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : null;
  if (!arr) throw new HttpErr(502, 'format');
  let ids = arr.map(m => typeof m === 'string' ? m : m && (m.id || m.name || m.model)).filter(x => typeof x === 'string' && x);
  /* агент всегда шлёт инструменты: модели, которые про них не знают (OpenRouter это сообщает), отвечают 404 */
  const tl = arr.filter(m => Array.isArray(m?.supported_parameters) && m.supported_parameters.includes('tools')).map(m => m.id);
  if (tl.length) ids = tl;
  /* /models отвечает не всё. Пустой запрос к модели (модель не запускается, токены не тратятся): сервер сначала проверяет ключ (401),
     потом тело (400). Так видно, подходит ли ключ к Ollama Cloud, и не закрыл ли Cloudflare только запросы к модели (так у JustWoker) */
  const p = await apiFetch(base + '/chat/completions', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (p) {
    const cf = cfBlock(p.status, await p.text().catch(() => ''), p.headers);
    if (cf) throw new HttpErr(502, cfMessage(cf, base + '/chat/completions', p.headers));
    if (key && isOllamaCloud(base) && (p.status === 401 || p.status === 403)) throw new HttpErr(p.status, 'HTTP ' + p.status, { upstream: p.status });
  }
  /* /models у OpenRouter открыт всем — ключ проверяем отдельно; без купленных кредитов работают только модели «:free» (иначе 402) */
  let free = null;
  if (key && isOpenRouter(base)) {
    const k = await apiFetch(base + '/key', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (k && (k.status === 401 || k.status === 403)) throw new HttpErr(k.status, 'HTTP ' + k.status, { upstream: k.status });
    const d = k && k.ok ? (await k.json().catch(() => null))?.data : null;
    if (d?.is_free_tier) {
      free = { limit: d.free_model_daily_requests?.limit || 0 };
      const fr = ids.filter(x => /:free$/i.test(x));
      if (fr.length) ids = fr;
    }
  }
  return { models: ids.slice(0, 2000), free, needKey: !key && (isOpenRouter(base) || isOllamaCloud(base)) };
}

/* ---------- маршруты ---------- */
async function api(req, res, url) {
  const p = url.pathname, M = req.method;
  if (M !== 'GET' && M !== 'HEAD') {
    if (req.headers['x-mochi'] !== '1' || !sameOrigin(req)) throw new HttpErr(403, 'запрос отклонён (CSRF)');
  }
  if (p === '/api/health') return json(res, 200, { ok: true, version: VERSION });
  const ip = clientIp(req);

  if (p === '/api/register' && M === 'POST') {
    if (A.limited('ip:' + ip)) throw new HttpErr(429, 'Слишком много попыток. Подожди 15 минут.');
    const b = await jbody(req);
    let u;
    try { u = await A.register(b.name, b.password, b.invite); }
    catch (e) { if (e.code === 'invite') A.fail('ip:' + ip); throw new HttpErr(400, e.message, { field: e.code || null }); }
    userDir(u);
    return json(res, 200, { user: A.publicUser(u) }, { 'set-cookie': setCookie(A.newSession(u, req.headers['user-agent']), A.SESSION_MAX_AGE) });
  }
  if (p === '/api/login' && M === 'POST') {
    const b = await jbody(req), name = A.normName(b.name);
    if (A.limited('ip:' + ip, 'u:' + name)) throw new HttpErr(429, 'Слишком много попыток. Подожди 15 минут.');
    const u = await A.login(name, String(b.password || ''));
    if (!u) { A.fail('ip:' + ip, 'u:' + name); throw new HttpErr(401, 'Неверное имя или пароль'); }
    A.clearFails('u:' + name);
    return json(res, 200, { user: A.publicUser(u) }, { 'set-cookie': setCookie(A.newSession(u, req.headers['user-agent']), A.SESSION_MAX_AGE) });
  }

  const u = userOf(req);
  if (p === '/api/me') {
    if (!u) return json(res, 401, { error: 'нужен вход', setup: !A.hasUsers(), invite: !CFG.allowRegister });
    return json(res, 200, { user: A.publicUser(u), version: VERSION, publicUrl: CFG.publicUrl || null });
  }
  if (!u) throw new HttpErr(401, 'нужен вход');
  const chat = getChat(u);

  switch (p) {
    case '/api/logout':
      if (M !== 'POST') break;
      if (url.searchParams.get('all') === '1') A.dropSessions(u.id); else A.endSession(cookies(req)[COOKIE]);
      return json(res, 200, { ok: true }, { 'set-cookie': setCookie('', 0) });
    case '/api/password': {
      if (M !== 'POST') break;
      const b = await jbody(req);
      if (!await A.login(u.name, String(b.old || ''))) { A.fail('u:' + u.name); throw new HttpErr(400, 'Старый пароль не подошёл'); }
      await A.setPassword(u, b.password);
      return json(res, 200, { ok: true }, { 'set-cookie': setCookie(A.newSession(u, req.headers['user-agent']), A.SESSION_MAX_AGE) });
    }
    case '/api/stream': return stream(req, res, u);
    case '/api/settings':
      if (M === 'GET') return json(res, 200, pubSettings(chat));
      if (M === 'PUT') { putSettings(chat, await jbody(req)); return json(res, 200, pubSettings(chat)); }
      break;
    case '/api/models': if (M === 'POST') return json(res, 200, await models(chat, await jbody(req))); break;
    case '/api/chat': {
      if (M !== 'POST') break;
      const b = await jbody(req, 40 * 2 ** 20);
      const files = (Array.isArray(b.files) ? b.files : []).slice(0, 20).map(f => ({ name: safeName(f.name), path: String(f.path || ''), size: +f.size || 0, fid: /^[0-9a-f]{24}$/.test(f.fid) ? f.fid : null }))
        .filter(f => f.path.startsWith(userDir(u) + '/inbox/'));
      const parts = (Array.isArray(b.parts) ? b.parts : []).slice(0, 10).filter(x => x && (x.type === 'image_url' || x.type === 'file'));
      try { chat.submit({ text: b.text, files, parts, origin: 'web' }); } catch (e) { throw new HttpErr(e.status || 400, e.message); }
      return json(res, 200, { ok: true });
    }
    case '/api/chat/stop': if (M === 'POST') { chat.stop(); return json(res, 200, { ok: true }); } break;
    case '/api/chat/retry': if (M === 'POST') { try { chat.retry('web'); } catch (e) { throw new HttpErr(e.status || 400, e.message); } return json(res, 200, { ok: true }); } break;
    case '/api/chat/clear': if (M === 'POST') { chat.clear(); dropFiles(u); return json(res, 200, { ok: true }); } break;
    case '/api/upload': {
      if (M !== 'POST') break;
      const n = +req.headers['content-length'];
      if (!(n >= 0) || n > CFG.maxFile) throw new HttpErr(413, 'файл больше ' + Math.round(CFG.maxFile / 2 ** 20) + ' МБ');
      const f = await putInbox(u, url.searchParams.get('name') || 'file', req).catch(e => { throw new HttpErr(400, e.message); });
      const copy = await storeCopy(u, f);
      return json(res, 200, { ...f, fid: copy?.fid || null });
    }
    case '/api/telegram':
      if (M === 'GET') return json(res, 200, TG.tgState(u));
      if (M === 'POST') { const b = await jbody(req); const r = await TG.connect(u, b.token).catch(e => { throw new HttpErr(400, e.message); }); return json(res, 200, { ...TG.tgState(u), link: r.link }); }
      if (M === 'DELETE' && req.headers['x-mochi'] === '1') { TG.disconnect(u); return json(res, 200, TG.tgState(u)); }
      break;
    case '/api/telegram/link': if (M === 'POST') { try { return json(res, 200, { link: TG.newLink(u) }); } catch (e) { throw new HttpErr(400, e.message); } } break;
    case '/api/telegram/notify': if (M === 'POST') { const b = await jbody(req); try { TG.setNotify(u, b.mode); } catch (e) { throw new HttpErr(400, e.message); } return json(res, 200, TG.tgState(u)); } break;
    case '/api/invite':
      if (M !== 'POST') break;
      if (!u.admin) throw new HttpErr(403, 'только для администратора');
      { const code = A.createInvite(u.name); return json(res, 200, { code, url: (CFG.publicUrl || 'https://' + req.headers.host) + '/?invite=' + code }); }
    case '/api/tools':
      if (M === 'GET') return json(res, 200, await toolCatalog(chat));
      if (M === 'PUT') { const b = await jbody(req); setTools(chat, b.tools); return json(res, 200, await toolCatalog(chat)); }
      break;
    case '/api/mcp': {
      if (M !== 'POST') break;
      const name = X.mcpPut(u, await jbody(req));
      let err = null;
      try { await X.mcpRefresh(u, name); } catch (e) { err = e.message; }
      return json(res, 200, { name, err });
    }
    case '/api/skills':
      if (M === 'GET') return json(res, 200, { skills: await X.skillList(u), dir: X.skillsRoot(u) });
      if (M === 'POST') return json(res, 200, { name: await X.skillWrite(u, await jbody(req, 256 * 1024)) });
      break;
    case '/api/skill-install':
      if (M === 'POST') { const b = await jbody(req); return json(res, 200, { names: await X.skillInstall(u, b.url, b.name || undefined) }); }
      break;
    case '/api/account':
      if (M === 'GET') return json(res, 200, { user: A.publicUser(u), sessions: A.sessionCount(u.id), work: userDir(u), invites: u.admin ? A.inviteCount() : undefined, users: u.admin ? A.listUsers().map(A.publicUser) : undefined });
      break;
  }
  const mm = p.match(/^\/api\/mcp\/([a-z0-9_-]{1,24})$/);
  if (mm) {
    if (M === 'POST') {
      const b = await jbody(req);
      X.mcpPatch(u, mm[1], b);
      let err = null;
      if (b.refresh) try { await X.mcpRefresh(u, mm[1]); } catch (e) { err = e.message; }
      return json(res, 200, { ok: true, err });
    }
    if (M === 'DELETE') { X.mcpDel(u, mm[1]); return json(res, 200, { ok: true }); }
  }
  const sm = p.match(/^\/api\/skills\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/);
  if (sm) {
    if (M === 'GET') { const raw = await X.skillRaw(u, sm[1]); if (raw == null) throw new HttpErr(404, 'нет такого навыка'); return json(res, 200, { name: sm[1], raw }); }
    if (M === 'POST') { await X.skillSet(u, sm[1], !!(await jbody(req)).on); return json(res, 200, { ok: true }); }
    if (M === 'DELETE') { await X.skillDel(u, sm[1]); return json(res, 200, { ok: true }); }
  }
  const fm = p.match(/^\/api\/files\/([0-9a-f]{24})$/);
  if (fm && (M === 'GET' || M === 'HEAD')) {
    const f = getFile(u, fm[1]);
    if (!f) throw new HttpErr(404, 'файл не найден');
    const img = /^image\/(png|jpeg|gif|webp)$/.test(f.mime);
    const st = await fsp.stat(f.path).catch(() => null);
    if (!st) throw new HttpErr(404, 'файл не найден');
    res.writeHead(200, { ...SEC, 'content-type': img ? f.mime : 'application/octet-stream', 'content-length': st.size, 'cache-control': 'private, max-age=31536000, immutable',
      'content-disposition': `${img && url.searchParams.get('dl') !== '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'content-security-policy': "default-src 'none'; sandbox" });
    if (M === 'HEAD') return res.end();
    return fs.createReadStream(f.path).pipe(res);
  }
  throw new HttpErr(404, 'нет такого метода');
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) return await api(req, res, url);
    if (p === TERM_PREFIX || p.startsWith(TERM_PREFIX + '/')) {
      const u = userOf(req);
      if (!u) { res.writeHead(401, { ...SEC, 'content-type': 'text/plain; charset=utf-8' }); return res.end('Нужен вход в Мочи'); }
      if (p === TERM_PREFIX) { res.writeHead(301, { location: TERM_PREFIX + '/' }); return res.end(); }
      return proxyHttp(req, res, u);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpErr(405, 'метод не разрешён');
    if (p === '/' || p === '/index.html') {
      if (!page || CFG.dev) loadPage();
      return sendBuf(req, res, page, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': page.csp, 'x-frame-options': 'DENY' });
    }
    if (STATIC[p]) return await serveStatic(req, res, p);
    throw new HttpErr(404, 'не найдено');
  } catch (e) {
    const code = e.status || 500;
    if (code === 500) console.error('http:', req.method, p, e);
    if (res.headersSent) return res.destroy();
    json(res, code, { error: code === 500 ? 'внутренняя ошибка сервера' : e.message, ...(e.field ? { field: e.field } : {}), ...(e.upstream ? { upstream: e.upstream } : {}) });
  }
}

function upgrade(req, socket, head) {
  const p = new URL(req.url, 'http://x').pathname;
  const u = userOf(req);
  if (!p.startsWith(TERM_PREFIX + '/') || !u || !sameOrigin(req) || !req.headers.origin) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  proxyUpgrade(req, socket, head, u);
}

/* ---------- админ-сокет для команды `mochi` на сервере (доступ: только root и mochi) ---------- */
export const ADMIN_SOCK = () => path.join(CFG.data, 'admin.sock');
async function admin(cmd) {
  const [op, ...a] = cmd;
  switch (op) {
    case 'invite': {
      const days = Math.min(Math.max(+a[0] || 7, 1), 90), code = A.createInvite('cli', days * 864e5);
      return { code, url: CFG.publicUrl ? CFG.publicUrl + '/?invite=' + code : null, days };
    }
    case 'users': return { users: A.listUsers().map(u => ({ ...A.publicUser(u), sessions: A.sessionCount(u.id), running: getChat(u).running, telegram: TG.tgState(u).connected })) };
    case 'passwd': { const u = A.userByName(a[0]); if (!u) throw new Error('нет такого пользователя'); await A.setPassword(u, a[1]); return { ok: true }; }
    case 'admin': { const u = A.userByName(a[0]); if (!u) throw new Error('нет такого пользователя'); u.admin = a[1] !== 'off'; return { ok: true, admin: u.admin }; }
    case 'deluser': {
      const u = A.userByName(a[0]); if (!u) throw new Error('нет такого пользователя');
      getChat(u).clear(); TG.disconnect(u); X.dropExt(u); A.deleteUser(u.id);
      await fsp.rm(path.join(CFG.data, 'users', u.id), { recursive: true, force: true });
      return { ok: true, note: 'рабочая папка ' + path.join(CFG.work, u.name) + ' оставлена' };
    }
    case 'status': return { version: VERSION, users: A.listUsers().length, running: A.listUsers().filter(u => getChat(u).running).map(u => u.name), publicUrl: CFG.publicUrl, uptime: Math.round(process.uptime()) };
    default: throw new Error('неизвестная команда');
  }
}
function adminServer() {
  const sock = ADMIN_SOCK();
  try { fs.unlinkSync(sock); } catch {}
  const s = net.createServer(c => {
    let buf = '';
    c.on('data', async d => {
      buf += d; if (buf.length > 65536) return c.destroy();
      const i = buf.indexOf('\n'); if (i < 0) return;
      let r;
      try { r = { ok: true, ...(await admin(JSON.parse(buf.slice(0, i)))) }; } catch (e) { r = { ok: false, error: e.message }; }
      c.end(JSON.stringify(r) + '\n');
    });
    c.on('error', () => {});
  });
  const old = process.umask(0o077);
  s.listen(sock, () => { process.umask(old); fs.chmodSync(sock, 0o600); });
  return s;
}

export function startServer() {
  ensureDir(CFG.data);
  try { fs.chmodSync(CFG.data, 0o700); } catch {}
  ensureDir(path.join(CFG.data, 'users'));
  if (CFG.dev) fs.mkdirSync(CFG.work, { recursive: true });
  A.initAuth();
  TG.initTelegram(A.listUsers);
  resumeAll(A.listUsers());
  loadPage();
  const srv = http.createServer({ requestTimeout: 0, headersTimeout: 30000 }, handle);
  srv.on('upgrade', upgrade);
  srv.keepAliveTimeout = 65000;
  const adm = adminServer();
  srv.listen(CFG.port, CFG.host, () => console.log(`mochi ${VERSION}: http://${CFG.host}:${CFG.port}  данные: ${CFG.data}  работа: ${CFG.work}${CFG.publicUrl ? '  адрес: ' + CFG.publicUrl : ''}`));
  const bye = () => { flushAll(); try { fs.unlinkSync(ADMIN_SOCK()); } catch {} process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  return { srv, adm };
}
