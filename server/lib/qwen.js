/* Провайдер Qwen: прямой клиент веб-API chat.qwen.ai — того же, через который работает сам сайт.
   Никаких сторонних прокси: запросы идут с этого сервера прямо в chat.qwen.ai (через прокси из настроек → Сервер, если он включён).
   Нужен только токен аккаунта (localStorage.token на chat.qwen.ai) и модель из списка.

   Что включено у Qwen: только сам чат (chat_type t2t) и размышление вкл/выкл. Свои инструменты сайта —
   поиск в интернете, интерпретатор кода, картинки, видео, исследования — выключены принудительно:
   у агента свои инструменты (сервер, файлы, MCP), и модель не должна путать два рабочих пространства.

   Протокол инструментов, разбор ответа и сборка истории — общие с DeepSeek (webchat.js).

   Инструменты агента. Веб-API Qwen не знает вызовов функций, поэтому договариваемся текстом:
   модель пишет [TOOL CALL] {"name": …, "arguments": {…}} [END TOOL CALL], результаты приходят ей
   блоками [TOOL RESULT: имя] … [END TOOL RESULT]. Родной тег Qwen <tool_call> не используем — его перехватывает
   сама платформа chat.qwen.ai (и отвечает «такого инструмента нет»). Блоки вызовов пользователь не видит.

   История. Каждый чат Personal Computer — один и тот же чат на chat.qwen.ai. Под ответом модели в истории
   лежит скрытая метка _qw { c: chat_id, r: response_id, a: аккаунт, h: версия инструкции }. Её не видно ни в чате,
   ни другим провайдерам (wire() её убирает). Следующий шаг продолжает тот же чат Qwen от этого ответа
   (parent_id = response_id) и отправляет только новое: сообщения пользователя и результаты инструментов, —
   а не всю переписку. Нет метки (первое сообщение, другой аккаунт, чат на сайте удалили) — новый чат Qwen,
   и в него уходит инструкция и вся переписка. «Повторить» после ошибки продолжает от последнего сохранённого
   ответа — это ветка в том же чате Qwen, как «перегенерировать» на сайте. */
import crypto from 'node:crypto';
import { apiFetch } from './net.js';
import { callParser, wrapInstr, freshContent, render, anchorOf, names, sysHash, clip, NUDGE, dayOf, attach as attachFiles } from './webchat.js';
export { callParser, renderCall, renderResult, toolPrompt, anchorOf } from './webchat.js';

export const QWEN_BASE = 'https://chat.qwen.ai';
/* куда ходим на самом деле: в тестах — фальшивый Qwen */
const api = () => (process.env.PERSONALCOMPUTER_QWEN_URL || QWEN_BASE).replace(/\/+$/, '');
export const isQwen = base => { try { return new URL(String(base)).hostname === 'chat.qwen.ai'; } catch { return false; } };

/* ---------- токен ----------
   Принимаем, как ни скопируют: сам токен, «Bearer …», строку cookie (token=…; …), JSON {"token": "…"}, в кавычках */
export function parseToken(raw) {
  let s = String(raw || '').trim().replace(/^["'`]+|["'`;]+$/g, '').trim();
  s = s.replace(/^bearer\s+/i, '');
  const c = /(?:^|[;\s])token=([^;\s]+)/.exec(s);
  if (c) return decodeURIComponent(c[1]);
  if (s.startsWith('{')) try { const j = JSON.parse(s); if (typeof j.token === 'string') return j.token.trim(); } catch {}
  return s.replace(/\s+/g, '');
}
/* JWT: кто (id аккаунта — к нему привязаны чаты Qwen) и до какого времени действует */
export function tokenInfo(t) {
  try {
    const p = JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));
    return { id: String(p.id || p.sub || p.user_id || ''), exp: +p.exp || 0 };
  } catch { return { id: '', exp: 0 }; }
}
const account = t => tokenInfo(t).id || crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 16);

/* ---------- ошибки: человеческий текст сразу (agent.friendly берёт его как есть) ---------- */
const qErr = (human, extra = {}) => Object.assign(new Error(human), { human, detail: '', ...extra });
const EXPIRED = 'Токен Qwen не подошёл или истёк. Открой chat.qwen.ai, войди, скопируй новый токен (как — подсказка в настройках → Модель) и вставь его.';
const WAF = 'chat.qwen.ai не пустил запрос с этого сервера: антибот-защита Alibaba Cloud потребовала проверку «я не робот» (слайдер). Токен тут ни при чём — он рабочий. Так защита реагирует на IP-адрес сервера (часто — на адреса хостингов): включи прокси с «домашним» адресом в настройках → Сервер → «Прокси» или повтори позже.';
const isWafBody = t => /<html|<!doctype/i.test(t) && /captcha|punish|x5sec|nocaptcha|aliyun|baxia|unusual traffic|blocked/i.test(t);
/* {success:false,data:{code,details}} / {error:{…}} / {detail} — во что бы ни завернули */
const isWafJson = j => !!j && typeof j === 'object' && (/FAIL_SYS_USER_VALIDATE|RGV587|punish|x5sec|captcha/i.test(JSON.stringify(j.ret || '')) || /punish|x5sec|captcha/i.test(String(j.data?.url || '')));
function bizErr(j, status) {
  if (isWafJson(j)) return qErr(WAF, { status: 403, waf: true });
  const d = j?.data && typeof j.data === 'object' ? j.data : {}, e = j?.error;
  const code = String(d.code || (e && e.code) || j?.code || '');
  const msg = String(d.details || d.message || (typeof e === 'string' ? e : e?.message) || j?.message || j?.detail || j?.msg || '').slice(0, 300);
  const all = code + ' ' + msg;
  if (status === 401 || status === 403 || /unauthori[sz]ed|token.*(expired|invalid)|not ?login|login required|jwt/i.test(all)) return qErr(EXPIRED, { status: 401, code });
  if (status === 429 || /ratelimit|rate.?limit|too many|quota|daily.?limit|上限|次数/i.test(all)) {
    const h = +d.num || 0;
    return qErr('Qwen: исчерпан лимит запросов аккаунта' + (h ? ' — снова можно примерно через ' + h + ' ч.' : '. Подожди немного и нажми «Повторить».') + ' Можно вставить токен другого аккаунта.', { status: 429, code, wait: h });
  }
  if (/not.?found|不存在/i.test(all) && /chat|parent|message/i.test(all)) return qErr('Qwen: чат не найден', { status: 404, code, gone: true });
  const e2 = qErr('Qwen ответил ошибкой' + (status ? ' (HTTP ' + status + ')' : '') + (msg || code ? ': ' + (msg || code) : '') + '.', { status: status || 502, code });
  e2.detail = JSON.stringify(j || {}).slice(0, 300);
  return e2;
}

/* ---------- заголовки как у сайта ----------
   Version — версия фронтенда chat.qwen.ai: без неё (или со слишком старой) API отвечает Bad_Request.
   Если ответили так — один раз узнаём текущую со страницы сайта и повторяем */
let FE = process.env.PERSONALCOMPUTER_QWEN_VERSION || '0.3.19', feAt = 0;
async function freshFE(signal) {
  if (Date.now() - feAt < 600e3) return false;
  feAt = Date.now();
  try {
    const r = await apiFetch(api() + '/', { headers: { Accept: 'text/html' }, signal: AbortSignal.any([signal || AbortSignal.timeout(15000), AbortSignal.timeout(15000)]) });
    const t = await r.text();
    const m = /["']?(?:fe_?version|web_?version|app_?version|VERSION|version)["']?\s*[:=]\s*["'](0\.\d+\.\d+)["']/i.exec(t);
    if (m && m[1] !== FE) { FE = m[1]; return true; }
  } catch {}
  return false;
}
const tz = () => new Date().toString().replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
function headers(token, chatId, accept = 'application/json') {
  return { 'Content-Type': 'application/json', Accept: accept, ...(token ? { Authorization: 'Bearer ' + token, Cookie: 'token=' + token } : {}),
    source: 'web', Version: FE, timezone: tz(), 'x-request-id': crypto.randomUUID(), 'x-accel-buffering': 'no',
    Origin: QWEN_BASE, Referer: QWEN_BASE + (chatId ? '/c/' + chatId : '/') };
}

/* JSON-запрос к API; ответ — data или ошибка с человеческим текстом */
async function call(token, method, p, body, signal, chatId) {
  for (let again = true; ;) {
    let r;
    try {
      r = await apiFetch(api() + p, { method, headers: headers(token, chatId), signal, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (e) { if (signal?.aborted) throw e; throw netErr(e); }
    const t = await r.text().catch(() => '');
    if (isWafBody(t)) throw qErr(WAF, { status: 403, waf: true });
    let j = null; try { j = JSON.parse(t); } catch {}
    if (r.ok && j && j.success !== false && !j.error) return j.data ?? j;
    const e = bizErr(j, r.ok ? 0 : r.status);
    if (again && /bad_?request|version/i.test(e.code + e.message) && await freshFE(signal)) { again = false; continue; }
    throw e;
  }
}
const netErr = e => qErr('Не достучался до chat.qwen.ai (' + (e.cause?.code || e.message) + '). ' + (e.proxy ? 'Проверь прокси: настройки → Сервер → «Прокси» → «Проверить».' : 'Проверь интернет на сервере или включи прокси в настройках → Сервер.'), { net: true, proxy: !!e.proxy });

/* ---------- вход и продление токена ----------
   Токен сайта живёт недолго (бывает — 15 минут). Обновляем его сами, до истечения:
   1) пока токен жив — спрашиваем сессию (/api/v1/auths/): если сайт выдал токен новее, берём его;
   2) есть email и пароль — входим заново (/api/v1/auths/signin, как сайт: пароль уходит хешем SHA-256).
   Сам пароль нигде не хранится — только этот хеш (ph), и только на сервере. */
export const hashPass = p => crypto.createHash('sha256').update(String(p), 'utf8').digest('hex');
export const tokenLeft = t => { const e = tokenInfo(t).exp; return e ? e * 1000 - Date.now() : Infinity; };
const BADPASS = 'Qwen не пустил: неверный email или пароль. Если входишь на chat.qwen.ai через Google или GitHub, пароля у аккаунта нет — используй «Токен в один клик».';
export async function signin(email, ph, signal) {
  email = String(email || '').trim();
  if (!email || !ph) throw qErr('Нужны email и пароль от chat.qwen.ai', { status: 400 });
  let d;
  try { d = await call('', 'POST', '/api/v1/auths/signin', { email, password: ph }, signal || AbortSignal.timeout(20000)); }
  catch (e) { if (e.status === 401 || /password|credential|incorrect|密码/i.test(e.message)) throw qErr(BADPASS, { status: 401, badPass: true }); throw e; }
  const token = parseToken(d?.token || d?.access_token || '');
  if (!token) throw qErr('chat.qwen.ai не выдал токен при входе', { status: 502, detail: JSON.stringify(d || {}).slice(0, 200) });
  return token;
}
/* новый токен или null (обновить нечем) */
export async function renew({ token, email, ph }, signal) {
  token = parseToken(token);
  let err = null;
  if (token && tokenLeft(token) > 20000) {
    try {
      const d = await call(token, 'GET', '/api/v1/auths/', null, signal || AbortSignal.timeout(15000));
      const t = parseToken(d?.token || d?.access_token || '');
      if (t && t !== token && tokenLeft(t) > tokenLeft(token)) return t;
    } catch (e) { err = e; }
  }
  if (email && ph) return signin(email, ph, signal);
  if (err && (err.waf || err.net)) throw err;
  return null;
}

/* ---------- модели ----------
   Только те, что умеют обычный чат (t2t). think — умеет размышлять, must — без размышления не работает
   (у таких моделей Qwen требует thinking_enabled), картинки/видео/исследования не показываем */
const mcache = new Map();
export async function listModels(rawToken, signal) {
  const token = parseToken(rawToken);
  if (!token) throw qErr('Вставь токен Qwen — после этого загружу список моделей', { status: 401, needKey: true });
  const c = mcache.get(token);
  if (c && Date.now() - c.t < 300e3) return c.list;
  const d = await call(token, 'GET', '/api/models', null, signal || AbortSignal.timeout(20000));
  const arr = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  const list = arr.map(m => {
    const meta = m?.info?.meta || {}, ab = meta.abilities || meta.capabilities || {}, ct = meta.chat_type;
    return { id: String(m?.id || ''), name: String(m?.name || m?.id || ''), chat: !Array.isArray(ct) || ct.includes('t2t'),
      think: !!(ab.thinking || ab.thinking_budget || meta.think_skip), must: meta.think_skip?.enable === false,
      vision: ab.vision === undefined ? null : !!ab.vision };
  }).filter(m => m.id && m.chat && !/image|video|research|web-?dev|full-?stack|slides|tts|asr/i.test(m.id))
    .map(({ chat, ...m }) => m);
  if (!list.length) throw qErr('chat.qwen.ai не отдал список моделей', { status: 502 });
  mcache.set(token, { t: Date.now(), list });
  if (mcache.size > 20) mcache.delete(mcache.keys().next().value);
  return list;
}
async function modelInfo(token, model, signal) {
  try { return (await listModels(token, signal)).find(m => m.id === model) || null; } catch (e) { if (signal?.aborted) throw e; return null; }
}

/* ---------- один ответ модели в чате Qwen (поток) ----------
   Возвращает { chatId, responseId, text — ответ (фаза answer), usage }. Размышления (фаза think) не показываем:
   ими модель занята, пока «тишина», — onPoke сбрасывает таймер зависания */
async function newChat(token, model, signal) {
  const d = await call(token, 'POST', '/api/v2/chats/new', { title: 'Personal Computer', models: [model], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now(), project_id: '' }, signal);
  const id = d?.id || d?.chat_id || d?.chatId;
  if (!id) throw qErr('chat.qwen.ai не создал чат', { status: 502, detail: JSON.stringify(d || {}).slice(0, 300) });
  return id;
}
/* выключено всё, кроме самого чата: ни поиска, ни кода, ни картинок; размышление — по настройке */
const features = (think, must) => ({ output_schema: 'phase', thinking_enabled: !!(think || must), auto_thinking: false,
  thinking_mode: think ? 'Thinking' : 'Fast', thinking_format: 'summary', research_mode: 'normal', auto_search: false });

async function complete({ token, chatId, parent, model, content, files = [], think, must, signal, onText, onPoke }) {
  const now = Math.floor(Date.now() / 1000), fid = crypto.randomUUID();
  const msg = { fid, parentId: parent, parent_id: parent, childrenIds: [crypto.randomUUID()], role: 'user', content, user_action: 'chat', files,
    timestamp: now, models: [model], chat_type: 't2t', feature_config: features(think, must), extra: { meta: { subChatType: 't2t' } }, sub_chat_type: 't2t' };
  const body = { stream: true, version: '2.1', incremental_output: true, chat_id: chatId, chatId, chat_mode: 'normal', model, parent_id: parent, parentId: parent, messages: [msg], timestamp: now };
  let r;
  try {
    r = await apiFetch(api() + '/api/v2/chat/completions?chat_id=' + encodeURIComponent(chatId), { method: 'POST', headers: headers(token, chatId), body: JSON.stringify(body), signal });
  } catch (e) { if (signal?.aborted) throw e; throw netErr(e); }
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !ct.includes('event-stream')) {
    const t = await r.text().catch(() => '');
    if (isWafBody(t)) throw qErr(WAF, { status: 403, waf: true });
    let j = null; try { j = JSON.parse(t); } catch {}
    /* иногда поток приходит как text/plain — разбираем его тем же кодом */
    if (r.ok && !j && /^\s*data:/m.test(t)) return readStream([t], { onText, onPoke });
    throw bizErr(j || { message: t.slice(0, 200) }, r.ok ? 0 : r.status);
  }
  const dec = new TextDecoder();
  return readStream((async function* () { for await (const ch of r.body) yield dec.decode(ch, { stream: true }); yield dec.decode(); })(), { onText, onPoke });
}

/* разбор SSE Qwen. Фреймы: {"response.created":{chat_id,parent_id,response_id,response_index}},
   {"choices":[{"delta":{"role","content","phase":"think"|"answer","status"}}],"response_id","usage"}, ошибки {success:false,…}.
   Бывает несколько вариантов ответа сразу — берём главный (response_index 0); role:function — встроенные инструменты сайта, их пропускаем */
async function readStream(chunks, { onText, onPoke }) {
  let buf = '', text = '', usage = null, chatId = null, responseId = null, err = null, waf = false;
  const idx = new Map();
  const frame = j => {
    const cr = j['response.created'] || j.response?.created;
    if (cr && typeof cr === 'object') {
      const id = cr.response_id || cr.responseId, ix = Number(cr.response_index ?? cr.responseIndex);
      if (id && Number.isFinite(ix)) idx.set(id, ix);
      if (id && (ix === 0 || (!Number.isFinite(ix) && !responseId))) responseId = id;
      chatId = cr.chat_id || cr.chatId || chatId;
      return;
    }
    if (j.success === false || isWafJson(j) || (j.error && !Array.isArray(j.choices))) { err = bizErr(j, 0); return; }
    const rid = j.response_id;
    if (rid) {
      if (!responseId) { if (idx.has(rid) && idx.get(rid) !== 0) return; responseId = rid; }
      else if (rid !== responseId) return;
    }
    if (j.usage) usage = j.usage;
    const d = j.choices?.[0]?.delta;
    if (!d || d.role === 'function' || d.name === 'web_search' || d.function_call || d.tool_calls) return;
    const ph = String(d.phase || '');
    if (/think/i.test(ph)) return;
    if (typeof d.content === 'string' && d.content) { text += d.content; onText?.(d.content); }
  };
  const lines = ls => {
    for (const l0 of ls) {
      const l = l0.replace(/\r$/, '');
      const p = l.startsWith('data:') ? l.slice(5).trim() : l.trim().startsWith('{') ? l.trim() : '';
      if (!p || p === '[DONE]') { if (!waf && /<html|captcha|punish/i.test(l)) waf = true; continue; }
      let j; try { j = JSON.parse(p); } catch { continue; }
      if (j && typeof j === 'object') frame(j);
      if (err) throw err;
    }
  };
  for await (const s of chunks) {
    onPoke?.();
    buf += s;
    const ls = buf.split('\n'); buf = ls.pop(); lines(ls);
  }
  if (buf) lines([buf]);
  if (!text && waf) throw qErr(WAF, { status: 403, waf: true });
  const used = (+usage?.input_tokens || +usage?.prompt_tokens || 0) + (+usage?.output_tokens || +usage?.completion_tokens || 0);
  return { chatId, responseId, text, used };
}

/* ---------- файлы в чат Qwen ----------
   Как у сайта: STS-ключ на загрузку (/api/v1/files/getstsToken) → PUT в Alibaba OSS (подпись OSS V1 с временным ключом) →
   документ Qwen ещё разбирает у себя (/api/v2/files/parse, ждём готовности) → описание файла уходит в messages[0].files.
   Картинки (до 5) Qwen видит сам, документы (до 5: PDF, Word, Excel, PowerPoint, TXT, MD, CSV) читает целиком.
   Остальное (архивы, видео, код) модели не отправляем — оно лежит на сервере, и агент открывает его своими инструментами.
   Один и тот же файл в одном аккаунте загружаем один раз (кэш на 40 минут). */
const IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
const DOC = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
export const MAX_FILE = 20 * 2 ** 20, MAX_IMGS = 5, MAX_DOCS = 5;
export function kindOf(name, mime) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (IMG[ext] || /^image\/(png|jpe?g|gif|webp|bmp)$/.test(mime || '')) return { kind: 'image', mime: IMG[ext] || mime };
  if (DOC[ext]) return { kind: 'doc', mime: DOC[ext] };
  if (mime === 'application/pdf') return { kind: 'doc', mime };
  return null;
}
const ossBase = (bucket, endpoint) => process.env.PERSONALCOMPUTER_QWEN_OSS || 'https://' + bucket + '.' + endpoint;
async function ossPut(sts, data, mime, signal) {
  const bucket = sts.bucketname || sts.bucket, endpoint = sts.endpoint || (String(sts.region || '').replace(/\.aliyuncs\.com$/, '') + '.aliyuncs.com');
  const key = String(sts.file_path || '').replace(/^\/+/, ''), date = new Date().toUTCString();
  if (!bucket || !key || !sts.access_key_id) throw new Error('chat.qwen.ai не выдал ключ на загрузку');
  const str = 'PUT\n\n' + mime + '\n' + date + '\nx-oss-security-token:' + sts.security_token + '\n/' + bucket + '/' + key;
  const sig = crypto.createHmac('sha1', String(sts.access_key_secret)).update(str, 'utf8').digest('base64');
  let r;
  try {
    r = await apiFetch(ossBase(bucket, endpoint) + '/' + key.split('/').map(encodeURIComponent).join('/'), { method: 'PUT', signal, body: new Uint8Array(data),
      headers: { Date: date, 'Content-Type': mime, Authorization: 'OSS ' + sts.access_key_id + ':' + sig, 'x-oss-security-token': String(sts.security_token) } });
  } catch (e) { if (signal?.aborted) throw e; throw new Error('хранилище Qwen не отвечает (' + (e.cause?.code || e.message) + ')'); }
  if (!r.ok) throw new Error('хранилище Qwen не приняло файл (HTTP ' + r.status + ')');
  await r.arrayBuffer().catch(() => {});
}
/* документ Qwen разбирает у себя; пока не разобрал — модель его не видит */
async function parseDoc(token, id, signal) {
  await call(token, 'POST', '/api/v2/files/parse', { file_id: id }, signal);
  for (let i = 0; i < 90; i++) {
    const d = await call(token, 'POST', '/api/v2/files/parse/status', { file_id_list: [id] }, signal);
    const rec = (Array.isArray(d) ? d : d?.list || d?.items || [d]).find(x => x?.file_id === id) || (Array.isArray(d) ? d[0] : d);
    const st = String(rec?.status || '').toLowerCase();
    if (/^(success|completed|done|parsed)$/.test(st)) return;
    if (/^(failed|error)$/.test(st)) throw new Error(rec?.error_msg || rec?.message || 'Qwen не смог разобрать документ');
    await new Promise(ok => setTimeout(ok, i < 10 ? 500 : 1000));
    if (signal?.aborted) throw signal.reason;
  }
  throw new Error('Qwen слишком долго разбирает документ');
}
const fcache = new Map();
export async function upload(token, { name, data, mime, kind }, signal) {
  const ck = account(token) + ':' + crypto.createHash('sha256').update(data).digest('hex');
  const c = fcache.get(ck);
  if (c && Date.now() - c.t < 40 * 60e3) return c.desc;
  const sts = await call(token, 'POST', '/api/v1/files/getstsToken', { filename: name, filesize: data.length, filetype: kind === 'image' ? 'image' : 'file' }, signal);
  await ossPut(sts, data, mime, signal);
  const id = sts.file_id, url = sts.file_url;
  if (!id || !url) throw new Error('chat.qwen.ai не вернул адрес файла');
  let desc;
  if (kind === 'image') desc = { type: 'image', url };
  else {
    await parseDoc(token, id, signal);
    const t = Date.now();
    desc = { type: 'file', file: { created_at: t, data: {}, filename: name, hash: null, id, meta: { name, size: data.length, content_type: mime, parse_meta: { parse_status: 'success' } }, update_at: t, name, size: data.length, type: mime },
      id, url, name, collection_name: '', status: 'uploaded', progress: 100, greenNet: 'success', size: data.length, error: '', itemId: id, file_type: mime, showType: 'file', file_class: 'document', context: 'full' };
  }
  fcache.set(ck, { t: Date.now(), desc });
  if (fcache.size > 200) fcache.delete(fcache.keys().next().value);
  return desc;
}
/* вложения сообщений, которые сейчас уйдут модели (общий обход — webchat.attach): картинки и документы — в Qwen,
   лишнее сверх лимитов и то, что не загрузилось, — заметкой «лежит на сервере» */
const attach = (token, msgs, getFiles, { vision, signal }) => attachFiles(msgs, getFiles, { kindOf, limits: { image: MAX_IMGS, doc: MAX_DOCS }, maxSize: MAX_FILE, signal,
  noImage: vision === false ? 'эта модель не видит картинки' : '', upload: (f, sg) => upload(token, f, sg), fatal: e => e.waf || e.status === 401 });

/* ---------- что отправить в чат Qwen ----------
   Протокол [TOOL CALL]/[TOOL RESULT], сборка истории и поиск метки — webchat.js */
const SITE = 'Встроенных инструментов чата Qwen здесь нет: не пользуйся поиском в интернете, интерпретатором кода, генерацией картинок и видео самого чата — только инструментами из списка.';
const instr = (sys, tools, upd) => wrapInstr(sys, tools, upd, { site: SITE });
const MAX_MSG = 250000;

/* ---------- шаг агента ----------
   hist — история чата (с метками _qw), sys и tools — как для обычной модели. → { text, calls, used, qw } */
export async function turn({ key, model, think, sys, tools, hist, signal, onText, getFiles, idleMs = 180000 }) {
  const token = parseToken(key);
  if (!token) throw qErr('Вставь токен Qwen в настройках → Модель — без него модель не ответит.', { status: 401 });
  if (!model) throw qErr('Выбери модель Qwen в настройках → Модель.', { status: 400 });
  const acct = account(token), h = sysHash(sys, tools), nm = names(hist), day = dayOf(sys);
  const info = await modelInfo(token, model, signal);
  const must = !!info?.must, th = !!think && (info ? info.think || info.must : true);
  let fresh = false, shown = false;
  for (let attempt = 0; ; attempt++) {
    const an = fresh ? null : anchorOf(hist, acct);
    let content, sent;
    if (an) {
      const delta = sent = hist.slice(an.i + 1);
      content = render(delta, nm);
      if (delta.length && delta.at(-1).role === 'tool') content += NUDGE;
      if (an.q.h !== h) content = instr(sys, tools, true) + '\n\n' + content;
      /* длинный чат пережил полночь — модель должна знать, какое сегодня число */
      else if (day && an.q.d && an.q.d !== day) content = '[Сегодня ' + day + ']\n' + content;
      if (content.length > MAX_MSG) content = clip(content, MAX_MSG);
    } else { content = freshContent(hist, instr(sys, tools, false), nm, { max: MAX_MSG }); sent = hist; }
    if (!content.trim()) content = 'Продолжай.';
    /* файлы из того, что уходит сейчас (в новом чате — и из прежней переписки, сколько влезет) */
    const att = await attach(token, sent, getFiles, { vision: info?.vision, signal });
    content += att.note;
    /* «тишина» дольше idleMs — модель зависла */
    const idle = new AbortController();
    let it = setTimeout(() => idle.abort(), idleMs);
    const poke = () => { clearTimeout(it); it = setTimeout(() => idle.abort(), idleMs); };
    const sig = AbortSignal.any([signal, idle.signal]);
    const P = callParser(s => { shown = true; onText?.(s); });
    try {
      const chatId = an ? an.q.c : await newChat(token, model, sig);
      const r = await complete({ token, chatId, parent: an ? an.q.r : null, model, content, files: att.files, think: th, must, signal: sig, onText: s => P.push(s), onPoke: poke });
      const { text, calls } = P.end();
      if (!text && !calls.length) throw qErr('Qwen вернул пустой ответ. Нажми «Повторить» или выбери другую модель в настройках.', { empty: true });
      return { text, calls, used: r.used, qw: r.responseId ? { c: r.chatId || chatId, r: r.responseId, a: acct, h, d: day } : null };
    } catch (e) {
      if (signal.aborted) throw e;
      if (idle.signal.aborted) e = qErr('Qwen не отвечает уже ' + Math.round(idleMs / 60000) + ' мин. Нажми «Повторить».', { net: true });
      /* продолжить старый чат не вышло (его удалили на сайте, ветка битая) — новый чат со всей перепиской */
      if (an && !shown && !e.net && !e.waf && e.status !== 401 && e.status !== 429 && !fresh) { fresh = true; continue; }
      /* сеть или перегрузка: ещё раз, пока пользователь ничего не увидел */
      if (!shown && attempt < 2 && (e.net || e.status >= 500)) { await new Promise(ok => setTimeout(ok, [3000, 10000][attempt])); if (signal.aborted) throw e; continue; }
      throw e;
    } finally { clearTimeout(it); }
  }
}

/* короткий ответ без инструментов (название чата): во временном чате, который потом удаляем, — чтобы не засорять аккаунт */
export async function ask({ key, model, prompt, signal }) {
  const token = parseToken(key);
  const chatId = await newChat(token, model, signal);
  try {
    const r = await complete({ token, chatId, parent: null, model, content: prompt, think: false, must: !!(await modelInfo(token, model, signal))?.must, signal });
    return r.text;
  } finally { call(token, 'DELETE', '/api/v2/chats/' + encodeURIComponent(chatId), null, AbortSignal.timeout(15000), chatId).catch(() => {}); }
}

/* проверка в настройках: список моделей + до какого числа действует токен */
export async function check(rawKey) {
  const token = parseToken(rawKey), list = await listModels(token);
  const exp = tokenInfo(token).exp;
  return { models: list.map(m => m.id), qwen: list, exp: exp ? exp * 1000 : 0, needKey: false, free: null };
}
