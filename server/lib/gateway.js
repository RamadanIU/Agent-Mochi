/* OpenAI-совместимый API (/v1): провайдеры пользователя — для других проектов, по ключу sk-pc-… (apikeys.js).
   ─ GET  /v1/models                — модели всех настроенных провайдеров: «провайдер/модель» (kiro/claude-sonnet-4.5,
                                      openrouter/anthropic/claude-sonnet-4); у думающих моделей Qwen, DeepSeek, Kiro — и «…:thinking»
   ─ GET  /v1/models/{id}
   ─ POST /v1/chat/completions      — поток (SSE) и обычный ответ, инструменты (tools / tool_choice, старые functions),
                                      картинки и PDF, размышления (reasoning_content), JSON-режим (response_format), stop
   ─ POST /v1/completions           — старый формат (prompt → текст)
   ─ POST /v1/embeddings            — у обычных OpenAI-совместимых провайдеров
   Обычные провайдеры (OpenAI, OpenRouter, Ollama, LM Studio, Coarena, свои адреса) — прозрачный прокси: тело запроса уходит
   как есть (temperature, max_tokens, response_format, logprobs…), подставляются только модель и ключ.
   Qwen, DeepSeek, Kiro и Antigravity — через их адаптеры (как у агента): токены обновляются сами, инструменты и картинки
   переводятся в их формат. Сайты Qwen и DeepSeek хранят переписку у себя: шлюз помнит, какой ответ в каком их чате,
   и следующий запрос той же беседы продолжает тот же чат, отправляя только новое. Подписи размышлений Antigravity
   (без них думающая модель не продолжит после инструментов) шлюз тоже помнит и возвращает сам. */
import crypto from 'node:crypto';
import { CFG } from './config.js';
import { rid } from './store.js';
import * as A from './auth.js';
import * as AK from './apikeys.js';
import { getChat, friendly, hooks } from './agent.js';
import * as SA from './subagent.js';
import { apiFetch, netFetch, cfBlock, cfMessage } from './net.js';
import { isQwen } from './qwen.js';
import { isDeepSeek } from './deepseek.js';
import * as KR from './kiro.js';
import * as AG from './antigravity.js';
import * as ZC from './zcode.js';
import * as CO from './coarena.js';
import { tokens } from './ext.js';

const BODY_MAX = 64 * 2 ** 20, IMG_MAX = 20 * 2 ** 20;
const sleep = (ms, sig) => new Promise(ok => { const t = setTimeout(ok, ms); sig?.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true }); });
const isAdapter = b => isQwen(b) || isDeepSeek(b) || KR.isKiro(b) || AG.isAntigravity(b);
const isWeb = b => isQwen(b) || isDeepSeek(b);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Math.floor(Date.now() / 1000);

/* ---------- ошибки в формате OpenAI ---------- */
export class ApiErr extends Error {
  constructor(status, message, { type, code = null, param = null, headers } = {}) {
    super(message);
    this.status = status; this.code = code; this.param = param; this.headers = headers;
    this.type = type || (status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 404 ? 'not_found_error'
      : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error');
  }
}
const errBody = e => ({ error: { message: e.message, type: e.type, param: e.param ?? null, code: e.code ?? null } });

/* ошибка провайдера → понятный ответ клиенту. Провайдер не принял свой ключ — это не «неверный ключ sk-pc-»: 502, а не 401 */
export function fromProvider(e, provName = 'Провайдер') {
  if (e instanceof ApiErr) return e;
  const s = +e.status || 0;
  const msg = (e.captcha ? '' : friendly(e)) || e.message || 'ошибка провайдера';
  if (e.name === 'AbortError') return new ApiErr(499, 'Запрос отменён', { code: 'cancelled' });
  if (e.captcha) return new ApiErr(503, provName + ' просит пройти проверку «я не робот». Открой Personal Computer → настройки → Модель → выбери ' + provName + ' и нажми «Проверить» (или напиши что-нибудь в чат) — после проверки повтори запрос.', { code: 'provider_check_required' });
  if (e.cf) return new ApiErr(502, e.cf, { code: 'provider_blocked' });
  if (e.auth || e.relogin || s === 401 || s === 403) return new ApiErr(502, provName + ': ' + msg, { code: 'provider_auth_error' });
  if (s === 402) return new ApiErr(402, msg, { type: 'insufficient_quota', code: 'insufficient_quota' });
  if (s === 429) return new ApiErr(429, msg, { code: 'rate_limit_exceeded' });
  if (s === 404) return new ApiErr(404, msg, { code: 'model_not_found' });
  if (s === 413) return new ApiErr(413, msg, { code: 'context_length_exceeded' });
  if (s >= 400 && s < 500) return new ApiErr(400, msg, { code: 'provider_bad_request' });
  return new ApiErr(502, msg, { code: 'provider_error' });
}

/* ---------- CORS: ключ в заголовке, без cookie — открыто для любых сайтов ---------- */
function cors(req) {
  return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': String(req.headers['access-control-request-headers'] || 'authorization, content-type, x-api-key').slice(0, 1000),
    'access-control-expose-headers': 'x-request-id, x-pc-provider, x-pc-model, retry-after, x-ratelimit-limit-requests, x-ratelimit-remaining-requests' };
}
const SEC = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
function sendJson(res, status, obj, h = {}) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { ...SEC, ...h, 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
  res.end(b);
}
async function readJson(req) {
  if (+req.headers['content-length'] > BODY_MAX) throw new ApiErr(413, 'Слишком большой запрос (больше ' + (BODY_MAX >> 20) + ' МБ)', { code: 'request_too_large' });
  const parts = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > BODY_MAX) throw new ApiErr(413, 'Слишком большой запрос (больше ' + (BODY_MAX >> 20) + ' МБ)', { code: 'request_too_large' }); parts.push(c); }
  let v;
  try { v = JSON.parse(Buffer.concat(parts).toString('utf8') || 'null'); } catch { throw new ApiErr(400, 'Тело запроса — не JSON', { code: 'invalid_json' }); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ApiErr(400, 'Тело запроса должно быть JSON-объектом', { code: 'invalid_json' });
  return v;
}
/* ключ: Authorization: Bearer (OpenAI), x-api-key (Anthropic-клиенты), api-key (Azure) */
function keyOf(req) {
  const m = /^Bearer\s+(\S+)/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : String(req.headers['x-api-key'] || req.headers['api-key'] || '');
}

/* ---------- провайдеры и модели ---------- */
const allowed = (k, p) => !k.providers?.length || k.providers.includes(p.id);
const savedModel = (S, base) => SA.normBase(base) === SA.normBase(S.base) ? S.model : (S.provs || {})[SA.normBase(base)]?.model || '';
/* привычные имена моделей DeepSeek → модель сайта (одна) и режим размышлений */
const DS_ALIAS = { 'deepseek-chat': false, 'deepseek-v3': false, 'deepseek-reasoner': true, 'deepseek-r1': true };

/* все модели, к которым пускает ключ: [{ id, object, created, owned_by, … }] */
export async function modelList(chat, k, { refresh = false } = {}) {
  const r = await SA.listModels(chat, { refresh }, hooks.models, { fetch: true });
  const out = [], t = now();
  for (const p of r.providers || []) {
    if (!p.available || !allowed(k, p)) continue;
    const thinkable = isQwen(p.base) || isDeepSeek(p.base) || KR.isKiro(p.base);
    for (const m of p.models || []) {
      const row = (id, extra) => ({ id: p.id + '/' + id, object: 'model', created: t, owned_by: p.id, name: m.name || m.id, provider: p.name,
        ...(m.context ? { context_length: m.context } : {}), ...(m.tool_calling != null ? { tool_calling: m.tool_calling } : {}), ...(m.tags ? { tags: m.tags } : {}), ...extra });
      out.push(row(m.id));
      if (thinkable && m.tags?.includes('reasoning')) out.push(row(m.id + ':thinking', { name: (m.name || m.id) + ' (размышления)', thinking: true }));
    }
    if (isDeepSeek(p.base)) for (const [a, th] of Object.entries(DS_ALIAS)) out.push({ id: p.id + '/' + a, object: 'model', created: t, owned_by: p.id, name: 'DeepSeek' + (th ? ' (размышления)' : ''), provider: p.name, alias_of: p.id + '/deepseek', ...(th ? { thinking: true } : {}) });
  }
  return out;
}

/* какая модель имелась в виду: «провайдер/модель», «провайдер», «default» (модель ключа, иначе — как у агента),
   просто «модель» (ищем у провайдеров). Суффикс «:thinking» — с размышлениями */
export async function resolveModel(chat, k, want) {
  const S = chat.settings();
  let m = String(want ?? '').trim(), think = null;
  if (!m || /^(default|auto)$/i.test(m)) m = k.model || '';
  if (!m) {
    const prov = SA.provOf(S.base);
    if (!allowed(k, prov)) throw new ApiErr(400, 'Укажи model: «провайдер/модель» (список — GET /v1/models)', { code: 'model_required', param: 'model' });
    return { prov, model: S.model, think };
  }
  const tm = /:(thinking|think|reasoning)$/i.exec(m);
  if (tm) { think = true; m = m.slice(0, tm.index); }
  const i = m.indexOf('/');
  if (i > 0) {
    const p = SA.findProvider(S, m.slice(0, i));
    if (p) {
      let model = m.slice(i + 1) || savedModel(S, p.base);
      if (isDeepSeek(p.base) && model in DS_ALIAS) { if (think === null) think = DS_ALIAS[model]; model = 'deepseek'; }
      return { prov: p, model, think };
    }
  }
  if (!m.includes('/')) {
    const p = SA.findProvider(S, m);
    if (p && !/^https?:/i.test(m)) return { prov: p, model: savedModel(S, p.base), think };
  }
  /* просто имя модели: у какого доступного провайдера она есть (сначала — у провайдера модели ключа, потом — у агента) */
  const pref = [k.model && k.model.includes('/') ? SA.findProvider(S, k.model.split('/')[0])?.base : '', SA.normBase(S.base)].filter(Boolean);
  const rank = p => { const i = pref.indexOf(p.base); return i < 0 ? 99 : i; };
  const provs = SA.allProviders(S).filter(p => allowed(k, p) && SA.availability(S, p.base).available).sort((a, b) => rank(a) - rank(b));
  if (m in DS_ALIAS) { const ds = provs.find(p => isDeepSeek(p.base)); if (ds) return { prov: ds, model: 'deepseek', think: think ?? DS_ALIAS[m] }; }
  const find = () => provs.find(p => SA.cachedModels(chat.u, p.base)?.some(x => x.id === m)) || provs.find(p => savedModel(S, p.base) === m);
  let p = find();
  if (!p) { await SA.listModels(chat, {}, hooks.models, { fetch: true }).catch(() => null); p = find(); }
  if (!p && provs.length === 1) p = provs[0];
  if (!p) throw new ApiErr(404, 'Модель «' + m.slice(0, 120) + '» не найдена ни у одного провайдера. Укажи её как «провайдер/модель» — список: GET /v1/models', { code: 'model_not_found', param: 'model' });
  return { prov: p, model: m, think };
}

/* ---------- сообщения OpenAI → внутренний формат ---------- */
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => typeof p === 'string' ? p : p && (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') ? String(p.text ?? '') : p?.type === 'refusal' ? String(p.refusal ?? '') : '').filter(Boolean).join('\n') : c == null ? '' : String(c);
const argStr = a => typeof a === 'string' ? a : JSON.stringify(a ?? {});
const canonArgs = a => { try { return JSON.stringify(JSON.parse(argStr(a))); } catch { return argStr(a); } };

/* картинка: data:-адрес как есть, http(s) — скачиваем (у адаптеров нет своего доступа к ссылкам) */
async function loadImage(url, signal) {
  url = String(url || '').trim();
  const d = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (d) {
    const data = d[2] ? Buffer.from(d[3], 'base64') : Buffer.from(decodeURIComponent(d[3]), 'utf8');
    return { mime: d[1].toLowerCase(), data };
  }
  if (!/^https?:\/\//i.test(url)) throw new ApiErr(400, 'image_url: нужен адрес http(s):// или data:', { code: 'invalid_image_url', param: 'messages' });
  /* адреса этой машины и локальной сети — нет: ключ (он бывает и во фронтенде) не должен открывать внутренние сервисы сервера */
  let host = ''; try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch {}
  if (!host || PRIVATE.test(host)) throw new ApiErr(400, 'image_url: адреса локальной сети не принимаются — пришли картинку как data:…;base64', { code: 'invalid_image_url', param: 'messages' });
  let r;
  try { r = await netFetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), headers: { Accept: 'image/*' } }, 'model'); }
  catch (e) { throw new ApiErr(400, 'Не скачалась картинка ' + url.slice(0, 200) + ': ' + (e.cause?.code || e.message), { code: 'invalid_image_url', param: 'messages' }); }
  if (!r.ok) throw new ApiErr(400, 'Не скачалась картинка ' + url.slice(0, 200) + ': HTTP ' + r.status, { code: 'invalid_image_url', param: 'messages' });
  const mime = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (+r.headers.get('content-length') > IMG_MAX) throw new ApiErr(400, 'Картинка больше ' + (IMG_MAX >> 20) + ' МБ', { code: 'image_too_large', param: 'messages' });
  const data = Buffer.from(await r.arrayBuffer());
  if (data.length > IMG_MAX) throw new ApiErr(400, 'Картинка больше ' + (IMG_MAX >> 20) + ' МБ', { code: 'image_too_large', param: 'messages' });
  if (!mime.startsWith('image/')) throw new ApiErr(400, 'По ссылке не картинка (' + (mime || 'тип не указан') + '): ' + url.slice(0, 200), { code: 'invalid_image_url', param: 'messages' });
  return { mime, data };
}
const PRIVATE = /^(localhost|.*\.localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|::1?|::ffff:.*|f[cd][0-9a-f]*:.*|fe80:.*|[^.:]+)$/;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/* body.messages → { sys, hist } — hist в формате истории агента: content (строка или части для Kiro/Antigravity),
   tool_calls, tool_call_id; _gwf — файлы сообщения для Qwen и DeepSeek (они загружают их на сайт), _sig — отпечаток для памяти */
export async function convert(body, { web = false, signal } = {}) {
  if (!Array.isArray(body.messages) || !body.messages.length) throw new ApiErr(400, 'Нужен непустой массив messages', { code: 'invalid_messages', param: 'messages' });
  if (body.messages.length > 5000) throw new ApiErr(400, 'Слишком много сообщений (больше 5000)', { param: 'messages' });
  const sys = [], hist = [], fnIds = new Map();
  for (const [n, m] of body.messages.entries()) {
    if (!m || typeof m !== 'object') throw new ApiErr(400, 'messages[' + n + ']: ожидался объект', { param: 'messages' });
    const role = m.role;
    if (role === 'system' || role === 'developer') { const t = textOf(m.content).trim(); if (t) sys.push(t); continue; }
    if (role === 'user') {
      const parts = Array.isArray(m.content) ? m.content : [], text = textOf(m.content), media = [], files = [];
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'image_url' || p.type === 'input_image') {
          const u = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url ?? p.url;
          media.push(await loadImage(u, signal));
        } else if (p.type === 'file' || p.type === 'input_file') {
          const fd = p.file?.file_data ?? p.file_data, d = /^data:([^;,]+);base64,(.*)$/s.exec(String(fd || ''));
          if (d) files.push({ name: String(p.file?.filename ?? p.filename ?? 'document').slice(0, 200), mime: d[1].toLowerCase(), data: Buffer.from(d[2], 'base64'), url: fd });
          else if (fd || p.file?.file_id) files.push({ note: '[файл «' + String(p.file?.filename || p.file?.file_id || 'документ').slice(0, 100) + '» не передан: нужен file_data (data:…;base64,…)]' });
        }
      }
      const notes = files.filter(f => f.note).map(f => f.note), real = files.filter(f => !f.note);
      const full = [text, ...notes].filter(Boolean).join('\n');
      const msg = { role: 'user', content: full, _sig: [sha(full), ...media.map(x => sha(x.data)), ...real.map(f => sha(f.data))] };
      if (media.length || real.length) {
        if (web) msg._gwf = [...media.map((x, i) => ({ name: 'image' + (i + 1) + '.' + (EXT[x.mime] || 'png'), mime: x.mime, data: x.data, at: '' })), ...real.map(f => ({ name: f.name, mime: f.mime, data: f.data, at: '' }))];
        else msg.content = [{ type: 'text', text: full || ' ' }, ...media.map(x => ({ type: 'image_url', image_url: { url: 'data:' + x.mime + ';base64,' + x.data.toString('base64') } })), ...real.map(f => ({ type: 'file', file: { filename: f.name, file_data: f.url } }))];
      }
      hist.push(msg);
      continue;
    }
    if (role === 'assistant') {
      const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : []).filter(c => c?.function?.name)
        .map(c => ({ id: String(c.id || 'call_' + rid(8)).slice(0, 200), type: 'function', function: { name: String(c.function.name).slice(0, 200), arguments: argStr(c.function.arguments) } }));
      if (m.function_call?.name) { const id = 'call_' + rid(8); fnIds.set(String(m.function_call.name), id); calls.push({ id, type: 'function', function: { name: String(m.function_call.name), arguments: argStr(m.function_call.arguments) } }); }
      const content = textOf(m.content);
      hist.push({ role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    if (role === 'tool') { hist.push({ role: 'tool', tool_call_id: String(m.tool_call_id || ''), content: textOf(m.content) }); continue; }
    /* старые functions: ответ функции — по имени */
    if (role === 'function') { hist.push({ role: 'tool', tool_call_id: fnIds.get(String(m.name)) || 'call_' + String(m.name || 'fn'), content: textOf(m.content) }); continue; }
    throw new ApiErr(400, 'messages[' + n + ']: неизвестная роль «' + String(role).slice(0, 40) + '»', { param: 'messages' });
  }
  if (!hist.length) throw new ApiErr(400, 'В messages нет ни одного сообщения пользователя', { code: 'invalid_messages', param: 'messages' });
  return { sys: sys.join('\n\n'), hist };
}

/* инструменты: tools (и старые functions), tool_choice; response_format — просьбой в системной подсказке */
export function toolsOf(body) {
  let tools = (Array.isArray(body.tools) ? body.tools : []).filter(t => t && (t.type === 'function' || !t.type) && t.function?.name)
    .map(t => ({ type: 'function', function: { name: String(t.function.name), description: String(t.function.description || ''), parameters: t.function.parameters && typeof t.function.parameters === 'object' ? t.function.parameters : { type: 'object', properties: {} } } }));
  if (!tools.length && Array.isArray(body.functions)) tools = body.functions.filter(f => f?.name).map(f => ({ type: 'function', function: { name: String(f.name), description: String(f.description || ''), parameters: f.parameters || { type: 'object', properties: {} } } }));
  const tc = body.tool_choice ?? body.function_call;
  let note = '';
  if (tc === 'none') tools = [];
  else if (tc && typeof tc === 'object') {
    const name = tc.function?.name || tc.name;
    if (name) { const one = tools.filter(t => t.function.name === name); if (one.length) { tools = one; note = 'Обязательно вызови инструмент ' + name + '.'; } }
  } else if (tc === 'required' && tools.length) note = 'Обязательно вызови один из инструментов — не отвечай текстом.';
  const rf = body.response_format;
  if (rf?.type === 'json_object') note += (note ? '\n' : '') + 'Отвечай только корректным JSON-объектом — без пояснений и без ```.';
  else if (rf?.type === 'json_schema') note += (note ? '\n' : '') + 'Отвечай только корректным JSON, строго по этой JSON Schema — без пояснений и без ```:\n' + JSON.stringify(rf.json_schema?.schema ?? rf.json_schema ?? {}).slice(0, 20000);
  return { tools, note, json: rf?.type === 'json_object' || rf?.type === 'json_schema' };
}

/* ---------- память бесед: чат Qwen/DeepSeek, подписи размышлений Antigravity ----------
   Ключ — отпечаток всей беседы до ответа включительно (без системной подсказки) + провайдер и модель + пользователь:
   клиент присылает историю целиком, а мы узнаём в ней свои ответы */
const MEMO_MAX = 5000, MEMO_TTL = 24 * 3600e3, memo = new Map();
const step = (h, m) => sha(h + '\n' + JSON.stringify([m.role, m.role === 'tool' ? m.tool_call_id : '', m._sig || textOf(m.content).trim(),
  (m.tool_calls || []).map(c => [c.id, c.function.name, canonArgs(c.function.arguments)])]));
function memoGet(k) { const v = memo.get(k); if (!v) return null; if (Date.now() - v.t > MEMO_TTL) { memo.delete(k); return null; } return v; }
function memoPut(k, v) {
  memo.delete(k); memo.set(k, { ...v, t: Date.now() });
  if (memo.size > MEMO_MAX) for (const x of memo.keys()) { memo.delete(x); if (memo.size <= MEMO_MAX * 0.9) break; }
}
/* размечаем историю тем, что помним; → отпечаток всей присланной истории (для ответа) */
function applyMemo(hist, scope) {
  let h = scope;
  for (const m of hist) {
    h = step(h, m);
    if (m.role !== 'assistant') continue;
    const v = memoGet(h);
    if (!v) continue;
    if (v.qw) m._qw = v.qw;
    if (v.ds) m._ds = v.ds;
    if (v.rs) Object.assign(m, v.rs);
  }
  return h;
}

/* ---------- stop: текст обрывается на первой из строк (в потоке — с задержкой на длину самой длинной) ---------- */
export class Stopper {
  constructor(stops, out) { this.s = stops; this.max = Math.max(0, ...stops.map(x => x.length)); this.buf = ''; this.hit = false; this.out = out; }
  push(d) {
    if (this.hit || !d) return;
    if (!this.s.length) return this.out(d);
    this.buf += d;
    const i = Math.min(...this.s.map(x => { const j = this.buf.indexOf(x); return j < 0 ? Infinity : j; }));
    if (i !== Infinity) { if (i) this.out(this.buf.slice(0, i)); this.buf = ''; this.hit = true; return; }
    const keep = this.max - 1;
    if (this.buf.length > keep) { const t = this.buf.slice(0, this.buf.length - keep); this.buf = this.buf.slice(this.buf.length - keep); this.out(t); }
  }
  end() { if (!this.hit && this.buf) this.out(this.buf); this.buf = ''; }
}
const stopsOf = s => (typeof s === 'string' ? [s] : Array.isArray(s) ? s : []).filter(x => typeof x === 'string' && x).slice(0, 8);
const unfence = t => { const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i.exec(t); return m ? m[1] : t; };

/* ---------- SSE-ответ: заголовки — с первым кусочком ответа (до него ошибка уходит обычным HTTP-кодом),
   а если модель долго молчит — через 8 секунд, дальше «пинги», чтобы прокси не оборвал соединение ---------- */
function sseWriter(res, h) {
  let open = false, ping = null;
  const start = () => {
    if (open || res.writableEnded) return;
    open = true;
    res.writeHead(200, { ...SEC, ...h, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' });
    res.flushHeaders?.();
    clearTimeout(early);
    ping = setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, 15000);
  };
  const early = setTimeout(start, 8000);
  return {
    get open() { return open; },
    start,
    send(obj) { start(); if (!res.writableEnded) res.write('data: ' + JSON.stringify(obj) + '\n\n'); },
    done() { clearTimeout(early); clearInterval(ping); if (!res.writableEnded) { if (open) res.end('data: [DONE]\n\n'); } },
    stop() { clearTimeout(early); clearInterval(ping); },
  };
}

/* ---------- обычный провайдер: тело как есть, подставляем модель и ключ ---------- */
async function passthrough(res, X, { chat, prov, model, path, body }) {
  const S = chat.settings(), base = prov.base, key = SA.keyOf(S, base), co = CO.isCoarena(base), zc = ZC.isZcode(base);
  const url = (co ? CO.apiBase(base) : zc ? ZC.apiBase(S.zcAuth) : base) + path;
  const out = { ...body, model };
  /* Z Code: reasoning_effort клиента → размышление GLM (включено или нет) */
  if (zc && path === '/chat/completions' && out.thinking == null) {
    const re = String(body.reasoning_effort ?? body.reasoning?.effort ?? '').toLowerCase();
    if (re) out.thinking = { type: re === 'none' ? 'disabled' : 'enabled' };
    delete out.reasoning_effort; delete out.reasoning;
  }
  /* Coarena: потолок ответа у каждой модели свой — если клиент не указал, ставим как у агента */
  if (co && path === '/chat/completions' && out.max_tokens == null && out.max_completion_tokens == null) {
    await CO.catalog().catch(() => null);
    out.max_completion_tokens = CO.extra({ model, effort: body.reasoning_effort, stream: false }).max_completion_tokens;
  }
  const headers = { 'Content-Type': 'application/json', Accept: body.stream ? 'text/event-stream' : 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  let r;
  for (let attempt = 0; ; attempt++) {
    try { r = await apiFetch(url, { method: 'POST', headers, body: JSON.stringify(out), signal: X.signal }); }
    catch (e) {
      if (X.signal.aborted) throw new ApiErr(499, 'Запрос отменён', { code: 'cancelled' });
      if (attempt < 2) { await sleep([1000, 3000][attempt], X.signal); continue; }
      throw new ApiErr(502, prov.name + ' не отвечает: ' + (e.cause?.code || e.message) + (e.proxy ? ' (проверь прокси: настройки → Сервер → «Прокси»)' : ''), { code: 'provider_unreachable' });
    }
    /* перегрузка у провайдера — ещё раз, пока клиент ничего не получил */
    if ([502, 503, 504, 529].includes(r.status) && attempt < 2) { await r.body?.cancel().catch(() => {}); await sleep([1000, 3000][attempt], X.signal); continue; }
    break;
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const cf = cfBlock(r.status, text, r.headers);
    if (cf) throw new ApiErr(502, cfMessage(cf, url, r.headers), { code: 'provider_blocked' });
    let j = null; try { j = JSON.parse(text); } catch {}
    const um = (typeof j?.error === 'string' ? j.error : j?.error?.message) || j?.message || text.replace(/\s+/g, ' ').slice(0, 300) || 'HTTP ' + r.status;
    /* провайдер не принял свой ключ — для клиента это не «неверный ключ»: 502 */
    if (r.status === 401 || r.status === 403) throw new ApiErr(502, prov.name + ' не принял ключ провайдера (HTTP ' + r.status + '): ' + um + '. Проверь его в Personal Computer → настройки → Модель.', { code: 'provider_auth_error' });
    const st = r.status === 429 || r.status === 402 || r.status === 404 || r.status === 400 || r.status === 413 || r.status === 422 ? r.status : 502;
    const ra = r.headers.get('retry-after');
    throw new ApiErr(st, um, { code: j?.error?.code || (st === 429 ? 'rate_limit_exceeded' : st === 404 ? 'model_not_found' : st === 502 ? 'provider_error' : null), type: j?.error?.type, param: j?.error?.param, headers: ra ? { 'retry-after': ra } : undefined });
  }
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('event-stream')) {
    X.stream = true;
    res.writeHead(200, { ...SEC, ...X.h, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
    res.flushHeaders?.();
    const dec = new TextDecoder(); let buf = '', chars = 0;
    const scan = ls => {
      for (const l of ls) {
        if (!l.startsWith('data:')) continue;
        const p = l.slice(5).trim(); if (!p || p === '[DONE]') continue;
        let j; try { j = JSON.parse(p); } catch { continue; }
        if (j?.usage) X.usage = j.usage;
        const d = j?.choices?.[0]?.delta; if (d) chars += String(d.content || '').length + String(d.reasoning_content || d.reasoning || '').length + JSON.stringify(d.tool_calls || '').length;
        if (j?.error) X.err = String(j.error.message || j.error).slice(0, 200);
      }
    };
    try {
      for await (const ch of r.body) {
        if (res.writableEnded || res.destroyed) break;
        res.write(ch);
        buf += dec.decode(ch, { stream: true }); const ls = buf.split('\n'); buf = ls.pop(); scan(ls);
      }
      buf += dec.decode(); if (buf) scan([buf]);
    } catch (e) {
      if (!X.signal.aborted) { X.err = 'обрыв потока: ' + (e.cause?.code || e.message); if (!res.writableEnded) res.write('data: ' + JSON.stringify(errBody(new ApiErr(502, X.err, { code: 'provider_stream_error' }))) + '\n\n'); }
    }
    if (!X.usage) X.outEst = Math.ceil(chars / 3.5);
    if (!res.writableEnded) res.end();
    return;
  }
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (j?.usage) X.usage = j.usage;
  const b = Buffer.from(text);
  res.writeHead(200, { ...SEC, ...X.h, 'content-type': ct || 'application/json; charset=utf-8', 'content-length': b.length });
  res.end(b);
}

/* ---------- адаптер (Qwen, DeepSeek, Kiro, Antigravity): тот же вызов модели, что у агента ----------
   Изолированный «чат» поверх чата пользователя (как у субагента): ключи и входы провайдеров — его, а история —
   из запроса. Обновление токенов — через сам чат пользователя: два одновременных обновления одного входа не нужны */
export function caller(chat, { base, model, think, effort, hist, conv, onDelta }) {
  const g = Object.create(chat);
  const wire = hist.map(({ _qw, _ds, _gwf, _sig, ...m }) => m);
  Object.assign(g, {
    cid: 'api-' + conv, partial: '', noVis: 0, chk: null,
    doc: { v: { hist, log: [], th: [], seq: 0, sess: 'api-' + conv, ctx: 0 }, save() {}, flush() {}, drop() {} },
    settings() { const P = chat.settings(); return { ...P, base, key: SA.keyOf(P, base), model, think: !!think, effort: effort || '', vis: true }; },
    wire() { return wire; },
    emit(ev, d) { if (ev === 'delta') onDelta(d); return true; },
    push(e) { return e; }, update() {},
    webFiles(m) { return m._gwf || []; },
    qwenKey: f => chat.qwenKey(f), qwenToken: () => chat.qwenToken(),
    krKey: f => chat.krKey(f), agKey: f => chat.agKey(f),
    dsToken: () => chat.dsToken(), dsRelogin: s => chat.dsRelogin(s),
    /* проверку «я не робот» запрос API ждать не может — её проходят в приложении */
    async waitCheck(e) { throw e; },
  });
  return g;
}

const EFFORT_MAP = { none: '', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
async function adapter(res, X, { chat, prov, model, think, body, label, legacy }) {
  const base = prov.base, web = isWeb(base), stream = !!body.stream;
  const conv0 = await convert(legacy ? { messages: [{ role: 'user', content: legacy.prompt }] } : body, { web, signal: X.signal });
  const { tools, note, json } = toolsOf(body);
  const sys = [conv0.sys, note].filter(Boolean).join('\n\n');
  const hist = conv0.hist;
  /* размышления: «:thinking» в модели, reasoning_effort, reasoning: { effort } */
  const re = String(body.reasoning_effort ?? body.reasoning?.effort ?? '').toLowerCase();
  if (think === null) think = re ? re !== 'none' : false;
  let effort = '';
  if (KR.isKiro(base) && re && re !== 'none') effort = KR.EFFORTS.includes(re) ? re : EFFORT_MAP[re] || '';
  if (AG.isAntigravity(base) && re) effort = AG.EFFORTS.includes(re) ? re : re === 'none' ? 'minimal' : EFFORT_MAP[re] || '';
  const scope = sha([X.k.uid, base, model].join('|'));
  const full = applyMemo(hist, scope);
  /* id беседы для кэша провайдера: от клиента (user, X-Session-Id) или по началу беседы */
  const conv = sha(String(body.user || X.req.headers['x-session-id'] || (conv0.sys.slice(0, 2000) + '|' + textOf(hist[0].content).slice(0, 2000)))).slice(0, 16);
  X.inEst = tokens([sys, tools, hist.map(({ _gwf, _sig, ...m }) => m)]);

  const stops = stopsOf(body.stop), id = (legacy ? 'cmpl-' : 'chatcmpl-') + rid(12), created = now();
  const sse = stream ? sseWriter(res, X.h) : null;
  X.stream = stream;
  let sent = '';
  const chunk = (delta, finish = null) => legacy
    ? { id, object: 'text_completion', created, model: label, choices: [{ index: 0, text: delta.content || '', logprobs: null, finish_reason: finish }] }
    : { id, object: 'chat.completion.chunk', created, model: label, system_fingerprint: null, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] };
  const stopper = new Stopper(stops, d => { sent += d; if (sse) sse.send(chunk(sent.length === d.length && !legacy ? { role: 'assistant', content: d } : { content: d })); });
  const onAbort = () => sse?.stop();
  X.signal.addEventListener('abort', onAbort, { once: true });

  let r;
  try {
    const g = caller(chat, { base, model, think, effort, hist, conv, onDelta: d => { if (!json) stopper.push(d); } });
    r = await g.callModel(sys, tools, X.signal);
  } catch (e) {
    sse?.stop();
    const err = fromProvider(e, prov.name);
    if (sse?.open) { X.err = err.message; X.status = err.status; sse.send(errBody(err)); sse.done(); return; }
    throw err;
  } finally { X.signal.removeEventListener('abort', onAbort); }

  let calls = r.calls || [];
  /* текст целиком: то, что не пришло потоком (или JSON-режим, где ответ не льётся), — досылаем */
  let text = String(r.text || '');
  if (json) { text = unfence(text); stopper.push(text); }
  else if (text.length > sent.length + stopper.buf.length && text.startsWith(sent + stopper.buf)) stopper.push(text.slice(sent.length + stopper.buf.length));
  stopper.end();
  const hit = stopper.hit;
  if (hit) calls = [];
  text = sent;
  /* запоминаем чат на сайте и подписи размышлений — по тому ответу, который получит (и пришлёт обратно) клиент */
  if (r.qw || r.ds || r.rs) memoPut(step(full, { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }),
    { ...(r.qw ? { qw: r.qw } : {}), ...(r.ds ? { ds: r.ds } : {}), ...(r.rs && AG.isAntigravity(base) ? { rs: r.rs } : {}) });
  const finish = calls.length ? (body.functions && !body.tools ? 'function_call' : 'tool_calls') : 'stop';
  const outTok = tokens(text + JSON.stringify(calls));
  const used = +r.used || 0;
  const usage = { prompt_tokens: used > outTok ? used - outTok : X.inEst, completion_tokens: outTok };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  if (r.cache?.hit) usage.prompt_tokens_details = { cached_tokens: r.cache.hit };
  X.usage = usage;
  const reasoning = r.think && !legacy ? String(r.think) : '';
  const legacyFn = body.functions && !body.tools && calls.length ? { function_call: { name: calls[0].function.name, arguments: calls[0].function.arguments } } : null;

  if (sse) {
    if (reasoning) sse.send(chunk({ ...(sent ? {} : { role: 'assistant' }), reasoning_content: reasoning }));
    if (!sent && !reasoning && !legacy) sse.send(chunk({ role: 'assistant', content: '' }));
    if (legacyFn) sse.send(chunk(legacyFn));
    else if (calls.length) sse.send(chunk({ tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } })) }));
    sse.send(chunk({}, finish));
    if (body.stream_options?.include_usage) sse.send({ id, object: legacy ? 'text_completion' : 'chat.completion.chunk', created, model: label, choices: [], usage });
    sse.done();
    return;
  }
  const out = legacy
    ? { id, object: 'text_completion', created, model: label, choices: [{ index: 0, text, logprobs: null, finish_reason: finish }], usage }
    : { id, object: 'chat.completion', created, model: label, system_fingerprint: null,
      choices: [{ index: 0, message: { role: 'assistant', content: text || (calls.length ? null : ''), ...(reasoning ? { reasoning_content: reasoning } : {}), ...(legacyFn || (calls.length ? { tool_calls: calls } : {})), refusal: null }, logprobs: null, finish_reason: finish }], usage };
  sendJson(res, 200, out, X.h);
}

/* ---------- маршруты ---------- */
async function chatCompletions(res, X, body, { legacy = false } = {}) {
  if (legacy && (body.prompt === undefined || body.prompt === null)) throw new ApiErr(400, 'Нужен prompt', { param: 'prompt' });
  if (legacy && Array.isArray(body.prompt) && body.prompt.length > 1) throw new ApiErr(400, 'Несколько prompt в одном запросе не поддерживаются — отправь их по одному', { param: 'prompt' });
  if (!legacy && (!Array.isArray(body.messages) || !body.messages.length)) throw new ApiErr(400, 'Нужен непустой массив messages', { code: 'invalid_messages', param: 'messages' });
  const chat = getChat(X.u), S = chat.settings();
  const { prov, model, think } = await resolveModel(chat, X.k, body.model);
  if (!allowed(X.k, prov)) throw new ApiErr(403, 'Этому ключу провайдер «' + prov.name + '» не разрешён', { code: 'provider_not_allowed', param: 'model' });
  const av = SA.availability(S, prov.base);
  if (!av.available) throw new ApiErr(400, prov.name + ' не настроен: ' + av.reason, { code: 'provider_unavailable', param: 'model' });
  if (!model) throw new ApiErr(400, 'Для ' + prov.name + ' не выбрана модель — укажи «' + prov.id + '/модель»', { code: 'model_required', param: 'model' });
  X.model = prov.id + '/' + model + (think ? ':thinking' : '');
  X.h['x-pc-provider'] = prov.id; X.h['x-pc-model'] = encodeURIComponent(model);
  const label = String(body.model || X.model).slice(0, 240);
  if (isAdapter(prov.base)) {
    const prompt = legacy ? (Array.isArray(body.prompt) ? String(body.prompt[0] ?? '') : String(body.prompt)) : null;
    return adapter(res, X, { chat, prov, model, think, body, label, legacy: legacy ? { prompt } : null });
  }
  X.inEst = tokens(legacy ? body.prompt : body.messages || '');
  return passthrough(res, X, { chat, prov, model, path: legacy ? '/completions' : '/chat/completions', body });
}

async function embeddings(res, X, body) {
  const chat = getChat(X.u), S = chat.settings();
  if (!body.model) throw new ApiErr(400, 'Укажи model: «провайдер/модель», например openai/text-embedding-3-small', { code: 'model_required', param: 'model' });
  const { prov, model } = await resolveModel(chat, X.k, body.model);
  if (!allowed(X.k, prov)) throw new ApiErr(403, 'Этому ключу провайдер «' + prov.name + '» не разрешён', { code: 'provider_not_allowed', param: 'model' });
  if (isAdapter(prov.base)) throw new ApiErr(400, prov.name + ' не умеет embeddings — выбери OpenAI-совместимого провайдера (OpenAI, OpenRouter, Ollama…)', { code: 'unsupported', param: 'model' });
  const av = SA.availability(S, prov.base);
  if (!av.available) throw new ApiErr(400, prov.name + ' не настроен: ' + av.reason, { code: 'provider_unavailable', param: 'model' });
  X.model = prov.id + '/' + model; X.h['x-pc-provider'] = prov.id; X.h['x-pc-model'] = encodeURIComponent(model);
  X.inEst = tokens(body.input ?? '');
  return passthrough(res, X, { chat, prov, model, path: '/embeddings', body });
}

/* вход: /v1/… — ключ, лимит, маршрут, учёт. Ответы и ошибки — в формате OpenAI */
export async function handleGateway(req, res, url) {
  const t0 = Date.now();
  const h = { ...cors(req), 'x-request-id': 'req_' + rid(12) };
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...h, 'access-control-max-age': '86400' }); return res.end(); }
  const p = url.pathname.replace(/\/+$/, '') || '/v1';
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  const X = { req, h, signal: ac.signal, k: null, u: null, model: '', status: 200, usage: null, inEst: 0, outEst: 0, stream: false, err: '' };
  try {
    if (!CFG.api) throw new ApiErr(404, 'API для других проектов выключен на этом сервере (PERSONALCOMPUTER_API=0)', { code: 'api_disabled' });
    const f = AK.findKey(keyOf(req));
    if (f.err) {
      const m = { invalid: 'Неверный API-ключ. Ключ создаётся в Personal Computer → настройки → Сервер → «API для других проектов» и передаётся заголовком Authorization: Bearer sk-pc-…',
        disabled: 'Этот API-ключ выключен — включи его в настройках Personal Computer', expired: 'Срок действия этого API-ключа истёк — создай новый в настройках Personal Computer' }[f.err];
      throw new ApiErr(401, m, { code: f.err === 'invalid' ? 'invalid_api_key' : 'api_key_' + f.err });
    }
    const u = A.userById(f.k.uid);
    if (!u) throw new ApiErr(401, 'Владельца ключа больше нет', { code: 'invalid_api_key' });
    X.k = f.k; X.u = u;
    const rl = AK.rate(f.k);
    if (rl.limit) Object.assign(h, { 'x-ratelimit-limit-requests': String(rl.limit), 'x-ratelimit-remaining-requests': String(rl.left) });
    if (!rl.ok) throw new ApiErr(429, 'Лимит ключа: ' + rl.limit + ' запросов в минуту. Повтори через ' + rl.retry + ' с', { code: 'rate_limit_exceeded', headers: { 'retry-after': String(rl.retry) } });

    const M = req.method;
    if (p === '/v1' && M === 'GET') return sendJson(res, 200, { object: 'personalcomputer.api', ok: true, key: f.k.name, endpoints: ['GET /v1/models', 'POST /v1/chat/completions', 'POST /v1/completions', 'POST /v1/embeddings'] }, h);
    if (p === '/v1/models' && M === 'GET') {
      const data = await modelList(getChat(u), f.k, { refresh: url.searchParams.get('refresh') === '1' });
      return sendJson(res, 200, { object: 'list', data }, h);
    }
    const mm = /^\/v1\/models\/(.+)$/.exec(p);
    if (mm && M === 'GET') {
      const want = decodeURIComponent(mm[1]), list = await modelList(getChat(u), f.k);
      let row = list.find(x => x.id === want);
      if (!row) { const r = await resolveModel(getChat(u), f.k, want); if (!allowed(f.k, r.prov)) throw new ApiErr(404, 'Нет такой модели', { code: 'model_not_found' }); row = { id: r.prov.id + '/' + r.model, object: 'model', created: now(), owned_by: r.prov.id, provider: r.prov.name }; }
      return sendJson(res, 200, row, h);
    }
    if (M !== 'POST' && ['/v1/chat/completions', '/v1/completions', '/v1/embeddings'].includes(p)) throw new ApiErr(405, 'Метод ' + M + ' не поддерживается — нужен POST', { code: 'method_not_allowed' });
    if (p === '/v1/chat/completions') return await chatCompletions(res, X, await readJson(req));
    if (p === '/v1/completions') return await chatCompletions(res, X, await readJson(req), { legacy: true });
    if (p === '/v1/embeddings') return await embeddings(res, X, await readJson(req));
    throw new ApiErr(404, 'Нет такого метода: ' + M + ' ' + p + '. Есть: GET /v1/models, POST /v1/chat/completions, POST /v1/completions, POST /v1/embeddings', { code: 'unknown_url' });
  } catch (e0) {
    const e = e0 instanceof ApiErr ? e0 : e0?.status === 413 ? new ApiErr(413, e0.message) : (console.error('api:', req.method, p, e0), new ApiErr(500, 'Внутренняя ошибка сервера', { code: 'internal_error' }));
    X.status = e.status; X.err = e.message;
    if (res.headersSent) { if (!res.writableEnded) res.end(); }
    else if (e.status !== 499) sendJson(res, e.status, errBody(e), { ...h, ...(e.headers || {}) });
    else res.destroy();
  } finally {
    /* учёт — запросы к модели; список моделей клиенты спрашивают часто — он только отмечает, что ключом пользовались */
    if (X.k && req.method === 'GET' && X.status < 400) AK.touch(X.k);
    else if (X.k) {
      const U = X.usage;
      AK.record(X.k, { path: p.replace(/^\/v1/, '') || '/', model: X.model, status: X.status, ms: Date.now() - t0, stream: X.stream, err: X.err,
        inTok: U ? +U.prompt_tokens || +U.input_tokens || 0 : X.status < 400 ? X.inEst : 0, outTok: U ? +U.completion_tokens || +U.output_tokens || 0 : X.outEst });
    }
  }
}
