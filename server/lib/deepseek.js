/* Провайдер DeepSeek: прямой клиент веб-API chat.deepseek.com — того же, через который работает сам сайт.
   Никаких сторонних прокси: запросы идут с этого сервера прямо в chat.deepseek.com (через прокси из настроек → Сервер, если он включён).
   Нужен только токен аккаунта (localStorage.userToken на chat.deepseek.com — в нём JSON {"value": "<токен>"}).

   Что включено у DeepSeek: только сам чат и «DeepThink» (размышление) вкл/выкл. Поиск в интернете самого сайта выключен
   принудительно: у агента свои инструменты (сервер, файлы, MCP), и модель не должна путать два рабочих пространства.

   Инструменты агента, история и чаты — как у Qwen (общая часть — webchat.js): текстовые блоки [TOOL CALL]/[TOOL RESULT],
   один чат Personal Computer = один чат на chat.deepseek.com. Под ответом модели в истории лежит скрытая метка
   _ds { c: chat_session_id, r: message_id ответа, a: аккаунт, h: версия инструкции, d: день }. Следующий шаг продолжает
   тот же чат от этого ответа (parent_message_id = r) и отправляет только новое. Нет метки — новый чат и вся переписка.

   Ограничения сайта, под которые всё устроено:
   * Длина одного ответа модели строго ограничена: упёрся — поток кончается со статусом INCOMPLETE (или вовсе без FINISHED).
     Такой ответ продолжаем сами: в тот же чат уходит «продолжи с места обрыва», продолжение приклеивается к ответу
     (повтор хвоста срезается) — и так до MAX_CONT раз. Пользователь видит один цельный ответ, вызов инструмента,
     оборванный посреди JSON, дописывается. Модель про предел знает и пишет большие файлы частями.
   * Длина одного сообщения тоже ограничена (на ~80 000 символов сайт отвечает пустым потоком): шлём не больше MAX_MSG,
     длинные результаты инструментов сокращаем, в новом чате старую переписку ужимаем.
   * Каждый запрос к модели и загрузка файла требуют «доказательства работы» (PoW): сайт выдаёт задачу, ответ — заголовок
     x-ds-pow-response. Алгоритм DeepSeekHashV1 — SHA3-256, у которого перестановка Keccak-f[1600] идёт с 1-го раунда
     по 23-й (нулевой пропущен); проверено на официальном sha3_wasm_bg.wasm сайта (см. тест). Считаем сами, без WASM.
   * Одновременно аккаунт генерирует только один ответ, а слишком частые запросы DeepSeek наказывает временной блокировкой
     аккаунта («user is muted»). Поэтому запросы одного аккаунта идут строго по очереди и с паузой в пару секунд. */
import crypto from 'node:crypto';
import { apiFetch } from './net.js';
import { callParser, wrapInstr, freshContent, render, anchorOf, names, sysHash, clip, NUDGE, dayOf, attach as attachFiles } from './webchat.js';

export const DS_BASE = 'https://chat.deepseek.com';
/* куда ходим на самом деле: в тестах — фальшивый DeepSeek */
const api = () => (process.env.PERSONALCOMPUTER_DEEPSEEK_URL || DS_BASE).replace(/\/+$/, '');
export const isDeepSeek = base => { try { return new URL(String(base)).hostname === 'chat.deepseek.com'; } catch { return false; } };
const COMPLETION = '/api/v0/chat/completion', UPLOAD = '/api/v0/file/upload_file';

/* ---------- токен ----------
   Принимаем, как ни скопируют: сам токен, «Bearer …», JSON из localStorage.userToken ({"value": "…", "__version": "0"}),
   {"token": "…"}, строку cookie (userToken=…), в кавычках */
export function parseToken(raw) {
  let s = String(raw || '').trim();
  for (let i = 0; i < 2; i++) {
    if (!/^[{"']/.test(s)) break;
    try {
      const j = JSON.parse(s);
      if (typeof j === 'string') { s = j.trim(); continue; }
      if (j && typeof j === 'object') { const v = j.value ?? j.token ?? j.userToken ?? j.access_token; if (typeof v === 'string') { s = v.trim(); continue; } if (v && typeof v === 'object' && typeof v.value === 'string') { s = v.value.trim(); continue; } }
    } catch {}
    break;
  }
  s = s.replace(/^["'`]+|["'`;]+$/g, '').trim().replace(/^bearer\s+/i, '');
  const c = /(?:^|[;\s])(?:userToken|token)=([^;\s]+)/.exec(s);
  if (c) return parseToken(decodeURIComponent(c[1]));
  return s.replace(/\s+/g, '');
}

/* ---------- ошибки: человеческий текст сразу (agent.friendly берёт его как есть) ---------- */
const dErr = (human, extra = {}) => Object.assign(new Error(human), { human, detail: '', ...extra });
const EXPIRED = 'Токен DeepSeek не подошёл или истёк: у сайта токены со временем истекают. Подключи аккаунт заново — настройки → Модель → «Войти через Google» (или токен вручную), это пара секунд.';
const WAF = 'chat.deepseek.com не пустил запрос с этого сервера: защита сайта ответила страницей блокировки. Токен тут ни при чём. Так защита реагирует на IP-адрес сервера (часто — на адреса хостингов): включи прокси с «домашним» адресом в настройках → Сервер → «Прокси» или повтори позже.';
const RATE = 'DeepSeek: слишком частые запросы. Подожди минуту-другую и нажми «Повторить» — если торопить сайт, он может временно заблокировать аккаунт.';
const CAPTCHA = 'DeepSeek просит пройти проверку «я не робот». Открой chat.deepseek.com в браузере, отправь там любое сообщение (пройди проверку, если покажут) и нажми «Повторить».';
const LONG = 'DeepSeek: сообщение слишком длинное для одного запроса.';
const when = ms => { const d = new Date(ms); return ms - Date.now() < 864e5 ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }); };
const muted = until => dErr('DeepSeek временно ограничил аккаунт — так сайт отвечает на слишком частые запросы' + (until > Date.now() ? ': ограничение до ' + when(until) : '') + '. Пока оно действует, модель отвечать не будет: подожди или подключи другой аккаунт. Повторять сейчас не нужно — это только продлит блокировку.', { status: 429, muted: true, until });
const isWafBody = t => /<html|<!doctype/i.test(t) && /blocked|captcha|cloudfront|forbidden|access denied|request could not be satisfied/i.test(t);
/* ответ сайта: {code, msg, data: {biz_code, biz_msg, biz_data}} — или поток с {"type":"error","content":"…"} */
function bizErr(j, status) {
  const d = j?.data && typeof j.data === 'object' ? j.data : {};
  const code = Number.isFinite(+j?.code) ? +j.code : 0, biz = Number.isFinite(+d.biz_code) ? +d.biz_code : 0;
  const msg = String(d.biz_msg || j?.msg || j?.message || (j?.type === 'error' ? j.content : '') || (typeof j?.error === 'string' ? j.error : j?.error?.message) || '').slice(0, 300);
  if (biz === 5 || /muted/i.test(msg)) { const s = +(d.biz_data?.mute_until ?? 0); return muted(s > 0 ? s * 1000 : 0); }
  if ([40001, 40002, 40003].includes(code) || status === 401 || /authori[sz]ation failed|invalid token|token.*(expired|invalid)|missing token|not ?login|请先登录|登录.*(过期|失效)/i.test(msg)) return dErr(EXPIRED, { status: 401, code });
  if (/captcha|人机验证|验证码|安全验证|verify.*human/i.test(msg)) return dErr(CAPTCHA, { status: 403, captcha: true });
  if (status === 429 || /too many|too frequent|rate.?limit|频繁|频率/i.test(msg)) return dErr(RATE, { status: 429 });
  if (/too long|过长|超出.*(长度|限制)|length limit|context.*(length|limit|window)|maximum context|上下文/i.test(msg)) return dErr(LONG, { status: 400, long: true });
  if (/not.?found|不存在|invalid.*(session|parent|message)|session.*(invalid|deleted)/i.test(msg)) return dErr('DeepSeek: чат не найден', { status: 404, gone: true });
  if (status === 403) return dErr(EXPIRED, { status: 401, code });
  const e = dErr('DeepSeek ответил ошибкой' + (status ? ' (HTTP ' + status + ')' : '') + (msg || code || biz ? ': ' + (msg || 'код ' + (code || biz)) : '') + '.', { status: status >= 500 ? status : 502, code: code || biz });
  e.detail = JSON.stringify(j || {}).slice(0, 300);
  return e;
}
const netErr = e => dErr('Не достучался до chat.deepseek.com (' + (e.cause?.code || e.message) + '). ' + (e.proxy ? 'Проверь прокси: настройки → Сервер → «Прокси» → «Проверить».' : 'Проверь интернет на сервере или включи прокси в настройках → Сервер.'), { net: true, proxy: !!e.proxy });

/* ---------- заголовки как у сайта ----------
   x-client-version — версия веб-клиента; сайт по ней включает возможности. Можно задать PERSONALCOMPUTER_DEEPSEEK_VERSION */
const VER = () => process.env.PERSONALCOMPUTER_DEEPSEEK_VERSION || '2.7.0';
function headers(token, extra = {}) {
  return { 'Content-Type': 'application/json', Accept: '*/*', ...(token ? { Authorization: 'Bearer ' + token } : {}),
    'x-client-platform': 'web', 'x-client-version': VER(), 'x-app-version': VER(), 'x-client-locale': 'en_US',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60), Origin: DS_BASE, Referer: DS_BASE + '/', ...extra };
}
/* JSON-запрос к API; ответ — data.biz_data (или data) либо ошибка с человеческим текстом */
async function call(token, method, p, body, signal, extra) {
  let r;
  try {
    r = await apiFetch(api() + p, { method, headers: headers(token, extra), signal, ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch (e) { if (signal?.aborted) throw e; throw netErr(e); }
  const t = await r.text().catch(() => '');
  if (isWafBody(t)) throw dErr(WAF, { status: 403, waf: true });
  let j = null; try { j = JSON.parse(t); } catch {}
  /* biz_data: null — тоже ответ (так сайт отвечает на недействительный вход): отдаём null, а не обёртку */
  if (r.ok && j && (j.code === 0 || j.code === undefined) && !(+j.data?.biz_code)) return j.data && 'biz_data' in j.data ? j.data.biz_data : j.data ?? j;
  if (r.status >= 500 && !j) throw dErr('У chat.deepseek.com что-то сломалось (HTTP ' + r.status + '). Повтори чуть позже.', { status: r.status });
  throw bizErr(j || { msg: t.slice(0, 200) }, r.ok ? 0 : r.status);
}

/* ---------- аккаунт ----------
   id аккаунта — к нему привязаны чаты DeepSeek: токен другого аккаунта — новые чаты. Заодно проверка, что токен рабочий */
const acache = new Map();
async function accountOf(token, signal) {
  const c = acache.get(token);
  if (c && Date.now() - c.t < 3600e3) return c.me;
  const d = await call(token, 'GET', '/api/v0/users/current', null, signal || AbortSignal.timeout(20000));
  if (!d || typeof d !== 'object') throw dErr(EXPIRED, { status: 401 });
  const me = { id: String(d.id || d.user_id || '') || crypto.createHash('sha256').update(token).digest('hex').slice(0, 16), login: String(d.email || d.mobile_number || d.id_profile?.name || '') };
  acache.set(token, { t: Date.now(), me });
  if (acache.size > 20) acache.delete(acache.keys().next().value);
  return me;
}

/* ---------- модели ----------
   У сайта одна модель (сейчас — DeepSeek V4), отличия — переключателями: DeepThink и поиск (поиск выключен всегда) */
export const MODELS = [{ id: 'deepseek', name: 'DeepSeek', think: true, must: false, vision: true }];

/* ---------- PoW: DeepSeekHashV1 ----------
   SHA3-256 (rate 136 байт, padding 0x06), но Keccak-f[1600] — с 1-го раунда по 23-й. Состояние — 25 дорожек по 64 бита,
   каждая — две 32-битные половины (lo, hi). Задача: найти nonce из [0, difficulty), при котором
   hash(salt + "_" + expire_at + "_" + nonce) == challenge */
const RC = [0x00000001, 0x00000000, 0x00008082, 0x00000000, 0x0000808a, 0x80000000, 0x80008000, 0x80000000, 0x0000808b, 0x00000000, 0x80000001, 0x00000000,
  0x80008081, 0x80000000, 0x00008009, 0x80000000, 0x0000008a, 0x00000000, 0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a, 0x00000000,
  0x8000808b, 0x00000000, 0x0000008b, 0x80000000, 0x00008089, 0x80000000, 0x00008003, 0x80000000, 0x00008002, 0x80000000, 0x00000080, 0x80000000,
  0x0000800a, 0x00000000, 0x8000000a, 0x80000000, 0x80008081, 0x80000000, 0x00008080, 0x80000000, 0x80000001, 0x00000000, 0x80008008, 0x80000000];
/* Keccak-f[1600] без нулевого раунда. s — Int32Array(50): дорожка x + 5y лежит в s[2(x+5y)] (младшие 32 бита) и s[2(x+5y)+1].
   Полностью развёрнуто (сдвиги ρ и места π подставлены числами) — так в разы быстрее; проверено на векторах официального WASM */
function permute(s) {
  for (let r = 2; r < 48; r += 2) {
    /* θ: чётность столбцов, D[x] = C[x-1] ^ rotl1(C[x+1]) */
    const c0 = s[0] ^ s[10] ^ s[20] ^ s[30] ^ s[40], c1 = s[1] ^ s[11] ^ s[21] ^ s[31] ^ s[41];
    const c2 = s[2] ^ s[12] ^ s[22] ^ s[32] ^ s[42], c3 = s[3] ^ s[13] ^ s[23] ^ s[33] ^ s[43];
    const c4 = s[4] ^ s[14] ^ s[24] ^ s[34] ^ s[44], c5 = s[5] ^ s[15] ^ s[25] ^ s[35] ^ s[45];
    const c6 = s[6] ^ s[16] ^ s[26] ^ s[36] ^ s[46], c7 = s[7] ^ s[17] ^ s[27] ^ s[37] ^ s[47];
    const c8 = s[8] ^ s[18] ^ s[28] ^ s[38] ^ s[48], c9 = s[9] ^ s[19] ^ s[29] ^ s[39] ^ s[49];
    const d0 = c8 ^ ((c2 << 1) | (c3 >>> 31)), d1 = c9 ^ ((c3 << 1) | (c2 >>> 31));
    const d2 = c0 ^ ((c4 << 1) | (c5 >>> 31)), d3 = c1 ^ ((c5 << 1) | (c4 >>> 31));
    const d4 = c2 ^ ((c6 << 1) | (c7 >>> 31)), d5 = c3 ^ ((c7 << 1) | (c6 >>> 31));
    const d6 = c4 ^ ((c8 << 1) | (c9 >>> 31)), d7 = c5 ^ ((c9 << 1) | (c8 >>> 31));
    const d8 = c6 ^ ((c0 << 1) | (c1 >>> 31)), d9 = c7 ^ ((c1 << 1) | (c0 >>> 31));
    /* ρ и π (вместе с поправкой θ): каждая дорожка поворачивается и переезжает */
    const b0 = s[0] ^ d0, b1 = s[1] ^ d1;
    const l1 = s[2] ^ d2, h1 = s[3] ^ d3;
    const b20 = (l1 << 1) | (h1 >>> 31), b21 = (h1 << 1) | (l1 >>> 31);
    const l2 = s[4] ^ d4, h2 = s[5] ^ d5;
    const b40 = (h2 << 30) | (l2 >>> 2), b41 = (l2 << 30) | (h2 >>> 2);
    const l3 = s[6] ^ d6, h3 = s[7] ^ d7;
    const b10 = (l3 << 28) | (h3 >>> 4), b11 = (h3 << 28) | (l3 >>> 4);
    const l4 = s[8] ^ d8, h4 = s[9] ^ d9;
    const b30 = (l4 << 27) | (h4 >>> 5), b31 = (h4 << 27) | (l4 >>> 5);
    const l5 = s[10] ^ d0, h5 = s[11] ^ d1;
    const b32 = (h5 << 4) | (l5 >>> 28), b33 = (l5 << 4) | (h5 >>> 28);
    const l6 = s[12] ^ d2, h6 = s[13] ^ d3;
    const b2 = (h6 << 12) | (l6 >>> 20), b3 = (l6 << 12) | (h6 >>> 20);
    const l7 = s[14] ^ d4, h7 = s[15] ^ d5;
    const b22 = (l7 << 6) | (h7 >>> 26), b23 = (h7 << 6) | (l7 >>> 26);
    const l8 = s[16] ^ d6, h8 = s[17] ^ d7;
    const b42 = (h8 << 23) | (l8 >>> 9), b43 = (l8 << 23) | (h8 >>> 9);
    const l9 = s[18] ^ d8, h9 = s[19] ^ d9;
    const b12 = (l9 << 20) | (h9 >>> 12), b13 = (h9 << 20) | (l9 >>> 12);
    const l10 = s[20] ^ d0, h10 = s[21] ^ d1;
    const b14 = (l10 << 3) | (h10 >>> 29), b15 = (h10 << 3) | (l10 >>> 29);
    const l11 = s[22] ^ d2, h11 = s[23] ^ d3;
    const b34 = (l11 << 10) | (h11 >>> 22), b35 = (h11 << 10) | (l11 >>> 22);
    const l12 = s[24] ^ d4, h12 = s[25] ^ d5;
    const b4 = (h12 << 11) | (l12 >>> 21), b5 = (l12 << 11) | (h12 >>> 21);
    const l13 = s[26] ^ d6, h13 = s[27] ^ d7;
    const b24 = (l13 << 25) | (h13 >>> 7), b25 = (h13 << 25) | (l13 >>> 7);
    const l14 = s[28] ^ d8, h14 = s[29] ^ d9;
    const b44 = (h14 << 7) | (l14 >>> 25), b45 = (l14 << 7) | (h14 >>> 25);
    const l15 = s[30] ^ d0, h15 = s[31] ^ d1;
    const b46 = (h15 << 9) | (l15 >>> 23), b47 = (l15 << 9) | (h15 >>> 23);
    const l16 = s[32] ^ d2, h16 = s[33] ^ d3;
    const b16 = (h16 << 13) | (l16 >>> 19), b17 = (l16 << 13) | (h16 >>> 19);
    const l17 = s[34] ^ d4, h17 = s[35] ^ d5;
    const b36 = (l17 << 15) | (h17 >>> 17), b37 = (h17 << 15) | (l17 >>> 17);
    const l18 = s[36] ^ d6, h18 = s[37] ^ d7;
    const b6 = (l18 << 21) | (h18 >>> 11), b7 = (h18 << 21) | (l18 >>> 11);
    const l19 = s[38] ^ d8, h19 = s[39] ^ d9;
    const b26 = (l19 << 8) | (h19 >>> 24), b27 = (h19 << 8) | (l19 >>> 24);
    const l20 = s[40] ^ d0, h20 = s[41] ^ d1;
    const b28 = (l20 << 18) | (h20 >>> 14), b29 = (h20 << 18) | (l20 >>> 14);
    const l21 = s[42] ^ d2, h21 = s[43] ^ d3;
    const b48 = (l21 << 2) | (h21 >>> 30), b49 = (h21 << 2) | (l21 >>> 30);
    const l22 = s[44] ^ d4, h22 = s[45] ^ d5;
    const b18 = (h22 << 29) | (l22 >>> 3), b19 = (l22 << 29) | (h22 >>> 3);
    const l23 = s[46] ^ d6, h23 = s[47] ^ d7;
    const b38 = (h23 << 24) | (l23 >>> 8), b39 = (l23 << 24) | (h23 >>> 8);
    const l24 = s[48] ^ d8, h24 = s[49] ^ d9;
    const b8 = (l24 << 14) | (h24 >>> 18), b9 = (h24 << 14) | (l24 >>> 18);
    /* χ по строкам */
    s[0] = b0 ^ (~b2 & b4); s[1] = b1 ^ (~b3 & b5);
    s[2] = b2 ^ (~b4 & b6); s[3] = b3 ^ (~b5 & b7);
    s[4] = b4 ^ (~b6 & b8); s[5] = b5 ^ (~b7 & b9);
    s[6] = b6 ^ (~b8 & b0); s[7] = b7 ^ (~b9 & b1);
    s[8] = b8 ^ (~b0 & b2); s[9] = b9 ^ (~b1 & b3);
    s[10] = b10 ^ (~b12 & b14); s[11] = b11 ^ (~b13 & b15);
    s[12] = b12 ^ (~b14 & b16); s[13] = b13 ^ (~b15 & b17);
    s[14] = b14 ^ (~b16 & b18); s[15] = b15 ^ (~b17 & b19);
    s[16] = b16 ^ (~b18 & b10); s[17] = b17 ^ (~b19 & b11);
    s[18] = b18 ^ (~b10 & b12); s[19] = b19 ^ (~b11 & b13);
    s[20] = b20 ^ (~b22 & b24); s[21] = b21 ^ (~b23 & b25);
    s[22] = b22 ^ (~b24 & b26); s[23] = b23 ^ (~b25 & b27);
    s[24] = b24 ^ (~b26 & b28); s[25] = b25 ^ (~b27 & b29);
    s[26] = b26 ^ (~b28 & b20); s[27] = b27 ^ (~b29 & b21);
    s[28] = b28 ^ (~b20 & b22); s[29] = b29 ^ (~b21 & b23);
    s[30] = b30 ^ (~b32 & b34); s[31] = b31 ^ (~b33 & b35);
    s[32] = b32 ^ (~b34 & b36); s[33] = b33 ^ (~b35 & b37);
    s[34] = b34 ^ (~b36 & b38); s[35] = b35 ^ (~b37 & b39);
    s[36] = b36 ^ (~b38 & b30); s[37] = b37 ^ (~b39 & b31);
    s[38] = b38 ^ (~b30 & b32); s[39] = b39 ^ (~b31 & b33);
    s[40] = b40 ^ (~b42 & b44); s[41] = b41 ^ (~b43 & b45);
    s[42] = b42 ^ (~b44 & b46); s[43] = b43 ^ (~b45 & b47);
    s[44] = b44 ^ (~b46 & b48); s[45] = b45 ^ (~b47 & b49);
    s[46] = b46 ^ (~b48 & b40); s[47] = b47 ^ (~b49 & b41);
    s[48] = b48 ^ (~b40 & b42); s[49] = b49 ^ (~b41 & b43);
    /* ι */
    s[0] ^= RC[r]; s[1] ^= RC[r + 1];
  }
}
const word = (u, k) => u[k] | (u[k + 1] << 8) | (u[k + 2] << 16) | (u[k + 3] << 24);
/* первые 32 байта состояния — сам хеш (дорожки little-endian, независимо от процессора) */
const digest = s => { const o = Buffer.alloc(32); for (let i = 0; i < 8; i++) o.writeUInt32LE(s[i] >>> 0, i * 4); return o; };
/* хеш строки или байтов → hex (для проверки на векторах официального WASM) */
export function dsHash(input) {
  const m = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  const n = Math.floor(m.length / 136) + 1, P = new Uint8Array(n * 136);
  P.set(m); P[m.length] ^= 0x06; P[P.length - 1] ^= 0x80;
  const s = new Int32Array(50);
  for (let k = 0; k < n; k++) { for (let i = 0; i < 34; i++) s[i] ^= word(P, k * 136 + i * 4); permute(s); }
  return digest(s).toString('hex');
}
/* решение задачи сайта. Считаем кусками и уступаем очередь событий: сервер в это время обслуживает остальных */
export async function solvePow({ challenge, salt, expire_at, difficulty }, signal) {
  const pre = Buffer.from(String(salt) + '_' + String(expire_at) + '_', 'utf8'), max = Math.floor(+difficulty || 0);
  const want = Buffer.from(String(challenge || ''), 'hex');
  if (want.length !== 32 || !(max > 0)) throw dErr('DeepSeek прислал непонятную задачу защиты запросов (PoW) — нужно обновить Personal Computer.', { status: 502 });
  const t = Array.from({ length: 8 }, (_, i) => word(want, i * 4));
  const s = new Int32Array(50), blk = new Uint8Array(136), w = new Int32Array(34), p0 = pre.length;
  if (p0 + String(max).length >= 136) { for (let k = 0; k < max; k++) if (dsHash(Buffer.concat([pre, Buffer.from(String(k))])) === want.toString('hex')) return k; return null; }
  /* блок один: префикс не меняется, меняются только цифры nonce и байт 0x06 за ними — пересчитываем лишь эти слова */
  blk.set(pre); blk[135] = 0x80;
  for (let i = 0; i < 34; i++) w[i] = word(blk, i * 4);
  const w0 = p0 >> 2;
  for (let k = 0; k < max; k++) {
    if ((k & 4095) === 4095) { await new Promise(ok => setImmediate(ok)); if (signal?.aborted) throw signal.reason; }
    const ds = String(k), e = p0 + ds.length;
    for (let i = 0; i < ds.length; i++) blk[p0 + i] = ds.charCodeAt(i);
    blk[e] = e === 135 ? 0x86 : 0x06;
    for (let i = w0, z = e >> 2; i <= z; i++) w[i] = word(blk, i * 4);
    w[33] = word(blk, 132);
    s.set(w); s.fill(0, 34);
    permute(s);
    let i = 0; while (i < 8 && s[i] === t[i]) i++;
    if (i === 8) return k;
  }
  return null;
}
/* заголовок x-ds-pow-response для запроса к target (у модели и загрузки файлов — свои задачи) */
async function pow(token, target, signal) {
  const d = await call(token, 'POST', '/api/v0/chat/create_pow_challenge', { target_path: target }, signal);
  const ch = d?.challenge;
  /* сайт отвечает 200 без задачи, когда вход недействителен */
  if (!ch || typeof ch !== 'object') throw dErr(EXPIRED, { status: 401 });
  if (ch.algorithm && ch.algorithm !== 'DeepSeekHashV1') throw dErr('DeepSeek сменил защиту запросов (алгоритм «' + String(ch.algorithm).slice(0, 40) + '») — нужно обновить Personal Computer.', { status: 502 });
  const answer = await solvePow(ch, signal);
  if (answer === null) throw dErr('Не получилось решить задачу защиты запросов DeepSeek (PoW). Нажми «Повторить».', { status: 502 });
  return Buffer.from(JSON.stringify({ algorithm: ch.algorithm || 'DeepSeekHashV1', challenge: ch.challenge, salt: ch.salt, answer, signature: ch.signature, target_path: ch.target_path || target })).toString('base64');
}

/* ---------- очередь запросов аккаунта ----------
   Один ответ за раз и пауза между запросами: иначе DeepSeek временно блокирует аккаунт.
   Пауза — случайная в [gap, 2·gap], отсчёт от конца прошлого запроса (пока работают инструменты, она уже идёт) */
const gates = new Map();
const GAP = () => { const g = process.env.PERSONALCOMPUTER_DEEPSEEK_GAP_MS; return g !== undefined && Number.isFinite(+g) ? +g : 1500; };
const sleep = (ms, signal) => new Promise(ok => { if (ms <= 0) return ok(); const t = setTimeout(ok, ms); signal?.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true }); });
function gated(acct, signal, fn) {
  let g = gates.get(acct);
  if (!g) { g = { p: Promise.resolve(), last: 0 }; gates.set(acct, g); if (gates.size > 50) gates.delete(gates.keys().next().value); }
  const run = g.p.then(async () => {
    const gap = GAP(); await sleep(g.last + gap + Math.random() * gap - Date.now(), signal);
    if (signal?.aborted) throw signal.reason;
    try { return await fn(); } finally { g.last = Date.now(); }
  });
  g.p = run.catch(() => {});
  return run;
}

/* ---------- чаты ---------- */
async function newChat(token, signal) {
  const d = await call(token, 'POST', '/api/v0/chat_session/create', { character_id: null }, signal);
  const id = d?.chat_session?.id || d?.id || d?.chat_session_id;
  if (!id) throw dErr('chat.deepseek.com не создал чат', { status: 502, detail: JSON.stringify(d || {}).slice(0, 300) });
  return String(id);
}
const dropChat = (token, id) => call(token, 'POST', '/api/v0/chat_session/delete', { chat_session_id: id }, AbortSignal.timeout(15000)).catch(() => {});

/* ---------- один ответ модели (поток) ----------
   Поток — JSON-патчи к объекту ответа:
     {"request_message_id":1,"response_message_id":2}                — id сообщений (первым кадром, после event: ready)
     {"v":{"response":{"message_id":2,"fragments":[…],"status":"WIP"}}} — снимок
     {"p":"response/fragments","o":"APPEND","v":[{"type":"THINK"|"RESPONSE","content":"…"}]}
     {"p":"response/fragments/-1/content","o":"APPEND","v":"…"} и голое {"v":"…"} — дописать туда же
     {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":42},{"p":"quasi_status","v":"FINISHED"}]}
     {"p":"response/status","o":"SET","v":"FINISHED"|"INCOMPLETE"|…}, ошибка — {"type":"error","content":"…"}
   Старые форматы: response/content и response/thinking_content, choices[0].delta {content, type:"thinking"|"text"}.
   Размышления (THINK) не показываем: модель ими занята, пока «тишина», — onPoke сбрасывает таймер зависания */
const SERVICE = new Set(['title', 'update_session', 'close', 'keep-alive', 'ping']);
function streamState(onAnswer) {
  const frags = [];
  let lastPath = '', status = '', reqId = null, respId = null, used = 0, err = null, think = 0;
  const kind = f => /^(THINK|REASONING|THINKING)$/i.test(String(f?.type || '')) ? 'think' : /^(RESPONSE|TEXT|ANSWER|SEARCH)?$/i.test(String(f?.type || '')) ? 'text' : 'skip';
  const add = (f, s) => { if (!s) return; f.content = (f.content || '') + s; const k = kind(f); if (k === 'text') onAnswer(s); else if (k === 'think') think += s.length; };
  const take = f => { if (!f || typeof f !== 'object') return; const g = { type: f.type || 'RESPONSE', content: '' }; frags.push(g); add(g, typeof f.content === 'string' ? f.content : ''); };
  const at = i => { const n = +i; return frags[n < 0 ? frags.length + n : n]; };
  const pseudo = type => { let f = frags.findLast(x => x.type === type); if (!f) { f = { type, content: '' }; frags.push(f); } return f; };
  const setStatus = v => { if (typeof v === 'string' && v) status = v.toUpperCase(); };
  const ids = o => {
    if (typeof o?.request_message_id === 'number') reqId = o.request_message_id;
    if (typeof o?.response_message_id === 'number') respId = o.response_message_id;
  };
  const apply = (p, o, v) => {
    if (p === 'response' && Array.isArray(v)) { for (const ch of v) if (ch && typeof ch === 'object') apply(ch.p ? 'response/' + String(ch.p).replace(/^response\//, '') : 'response', ch.o, ch.v); return; }
    if (p === 'response/fragments') { for (const f of Array.isArray(v) ? v : [v]) take(f); lastPath = 'response/fragments/-1/content'; return; }
    let m = /^response\/fragments\/(-?\d+)\/content$/.exec(p);
    if (m && typeof v === 'string') { const f = at(m[1]); if (f) { if (o === 'SET') f.content = ''; add(f, v); } lastPath = p; return; }
    if (p === 'response/content' && typeof v === 'string') { add(pseudo('RESPONSE'), v); lastPath = p; return; }
    if (p === 'response/thinking_content' && typeof v === 'string') { add(pseudo('THINK'), v); lastPath = p; return; }
    if (/^response\/(quasi_)?status$/.test(p) || p === 'quasi_status' || p === 'status') { setStatus(v); return; }
    if (/accumulated_token_usage$/.test(p)) { if (+v > 0) used = +v; return; }
    if (p === 'response/message_id' && typeof v === 'number') { respId = v; return; }
  };
  return {
    frame(j, ev) {
      if (!j || typeof j !== 'object') return;
      if (j.type === 'error' || (typeof j.code === 'number' && j.code !== 0) || +j.data?.biz_code) { err = bizErr(j, 0); return; }
      ids(j);
      if (SERVICE.has(ev)) return; /* название чата, время обновления, конец потока — служебное */
      if (Array.isArray(j.choices)) {
        const ch = j.choices[0] || {}, d = ch.delta || {};
        if (typeof d.content === 'string' && d.content) { if (/think/i.test(String(d.type || ''))) think += d.content.length; else add(pseudo('RESPONSE'), d.content); }
        if (ch.finish_reason) setStatus(ch.finish_reason === 'length' ? 'INCOMPLETE' : 'FINISHED');
        if (typeof j.message_id === 'number') respId = j.message_id;
        return;
      }
      const v = j.v;
      if (!j.p && v && typeof v === 'object' && !Array.isArray(v) && v.response && typeof v.response === 'object') {
        const r = v.response;
        ids(r);
        if (typeof r.message_id === 'number') respId = r.message_id;
        setStatus(r.status);
        if (+r.accumulated_token_usage > 0) used = +r.accumulated_token_usage;
        if (Array.isArray(r.fragments)) { for (const f of r.fragments) take(f); lastPath = 'response/fragments/-1/content'; }
        if (typeof r.thinking_content === 'string' && r.thinking_content) add(pseudo('THINK'), r.thinking_content);
        if (typeof r.content === 'string' && r.content) { add(pseudo('RESPONSE'), r.content); lastPath = 'response/content'; }
        return;
      }
      if (j.p) { apply(String(j.p), j.o, v); return; }
      /* голое значение — продолжение прошлого пути */
      if (typeof v === 'string') { if (lastPath) apply(lastPath, 'APPEND', v); else add(frags.at(-1) || pseudo('RESPONSE'), v); }
    },
    get err() { return err; },
    result: () => ({ status, reqId, respId, used, think }),
  };
}
/* служебные вставки сайта в текст ответа (<ds_safety>…</ds_safety>Safe) — не слова модели: вырезаем на лету */
function safety(out) {
  let buf = '', after = false;
  const OPEN = '<ds_safety>', CLOSE = '</ds_safety>';
  const pump = final => {
    for (;;) {
      /* сразу за меткой сайт пишет вердикт Safe/Unsafe — он может прийти следующим кусочком: ждём, пока станет ясно */
      if (after) {
        const t = buf.replace(/^\s+/, '');
        if (!final && t.length < 6 && ('Unsafe'.startsWith(t) || 'Safe'.startsWith(t))) return;
        buf = buf.replace(/^\s*(?:Unsafe|Safe)/, ''); after = false;
      }
      const i = buf.indexOf(OPEN);
      if (i < 0) {
        /* хвост, похожий на начало метки, придерживаем */
        let keep = 0;
        if (!final) for (let k = Math.min(OPEN.length - 1, buf.length); k > 0; k--) if (OPEN.startsWith(buf.slice(-k))) { keep = k; break; }
        out(buf.slice(0, buf.length - keep)); buf = buf.slice(buf.length - keep); return;
      }
      out(buf.slice(0, i));
      const j = buf.indexOf(CLOSE, i);
      if (j < 0) { if (final) buf = ''; else buf = buf.slice(i); return; }
      buf = buf.slice(j + CLOSE.length); after = true;
    }
  };
  return { push(s) { buf += s; pump(false); }, end() { pump(true); } };
}
/* продолжение оборванного ответа: бывает, модель повторяет хвост — срезаем перекрытие; «[END]» — продолжать нечего.
   Срезаем, только если перекрытие однозначно: в повторяющемся тексте (одинаковые строки кода) точное продолжение
   тоже «совпадает» с хвостом на кратную периоду длину — там лучше оставить как есть, чем вырезать настоящие символы */
function stitch(prevTail, out) {
  let buf = '', open = true;
  const flush = () => {
    open = false;
    let s = buf.replace(/^\s*\[END\]\s*/i, '');
    const hit = [];
    for (let k = Math.min(s.length, prevTail.length, 400); k >= 16 && hit.length < 2; k--) if (prevTail.endsWith(s.slice(0, k))) hit.push(k);
    if (hit.length === 1) s = s.slice(hit[0]);
    if (s) out(s);
  };
  return {
    push(s) { if (!open) return out(s); buf += s; if (buf.length >= 400) flush(); },
    end() { if (open) flush(); },
  };
}
async function complete({ token, chatId, parent, prompt, files = [], think, signal, onText, onPoke }) {
  const ph = await pow(token, COMPLETION, signal);
  const body = { chat_session_id: chatId, parent_message_id: parent ?? null, model_type: null, prompt, ref_file_ids: files, thinking_enabled: !!think, search_enabled: false, action: null, preempt: false };
  let r;
  try {
    r = await apiFetch(api() + COMPLETION, { method: 'POST', headers: headers(token, { Accept: 'text/event-stream', 'x-ds-pow-response': ph }), body: JSON.stringify(body), signal });
  } catch (e) { if (signal?.aborted) throw e; throw netErr(e); }
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !/event-stream|text\/plain/.test(ct)) {
    const t = await r.text().catch(() => '');
    if (isWafBody(t)) throw dErr(WAF, { status: 403, waf: true });
    let j = null; try { j = JSON.parse(t); } catch {}
    if (r.ok && !j && /^\s*data:/m.test(t)) return readStream([t], { onText, onPoke });
    throw bizErr(j || { msg: t.slice(0, 200) }, r.ok ? 0 : r.status);
  }
  const dec = new TextDecoder();
  /* обрыв связи посреди ответа — сетевая ошибка с понятным текстом */
  return readStream((async function* () {
    try { for await (const ch of r.body) yield dec.decode(ch, { stream: true }); }
    catch (e) { if (signal?.aborted) throw e; throw netErr(e); }
    yield dec.decode();
  })(), { onText, onPoke });
}
async function readStream(chunks, { onText, onPoke }) {
  let text = '', buf = '', ev = '';
  const F = safety(s => { if (!s) return; text += s; onText?.(s); });
  const S = streamState(s => F.push(s));
  const lines = ls => {
    for (const l0 of ls) {
      const l = l0.replace(/\r$/, '');
      if (!l) { ev = ''; continue; }
      if (l.startsWith('event:')) { ev = l.slice(6).trim(); continue; }
      const p = l.startsWith('data:') ? l.slice(5).trim() : l.trim().startsWith('{') ? l.trim() : '';
      if (!p || p === '[DONE]') continue;
      let j; try { j = JSON.parse(p); } catch { continue; }
      S.frame(j, ev);
      if (S.err) throw S.err;
    }
  };
  for await (const s of chunks) {
    onPoke?.();
    buf += s;
    const ls = buf.split('\n'); buf = ls.pop(); lines(ls);
  }
  if (buf) lines([buf]);
  F.end();
  return { text, ...S.result() };
}

/* оборван ли ответ: сайт так и сказал (INCOMPLETE), поток кончился без «готово», оборван блок вызова
   или длинный ответ кончился посреди слова (бывает, что сайт обрывает и при FINISHED). Пункт списка, заголовок,
   строка таблицы или код без точки в конце — это нормально, их не трогаем */
const MID = /[\p{L}\p{N},:;(\[{«"*_-]$/u;
export function cutOff(r, P, all) {
  if (r.status === 'INCOMPLETE' || r.status === 'WIP' || r.status === '') return !!(all.trim() || r.think);
  if (r.status !== 'FINISHED') return false;
  if (P.open()) return true;
  const t = all.trimEnd(), line = t.slice(t.lastIndexOf('\n') + 1);
  return t.length >= 2500 && MID.test(t) && !/^\s*(?:[-*+#>|]|\d+[.)]\s)|```/.test(line);
}
const CONTINUE = '[Твой ответ оборвался: длина одного ответа в этом чате ограничена. Продолжи ровно с того символа, где остановился: без повторов уже написанного, без вступлений и пояснений. Если оборвался блок [TOOL CALL], допиши его JSON с места обрыва и закрой маркером. Если на самом деле ответ уже закончен — ответь ровно: [END]]';
export const MAX_CONT = 6;

/* ---------- файлы в чат DeepSeek ----------
   Как у сайта: задача PoW на загрузку → POST /api/v0/file/upload_file (multipart) → сайт разбирает файл у себя
   (/api/v0/file/fetch_files, ждём готовности) → id файла уходит в ref_file_ids. Картинки (до 5) и документы (до 5:
   PDF, Word, Excel, PowerPoint, TXT, MD, CSV, JSON). Остальное (архивы, видео, код) модели не отправляем — оно лежит
   на сервере, и агент открывает его своими инструментами. Один и тот же файл в одном аккаунте загружаем один раз */
const IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const DOC = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
export const MAX_FILE = 20 * 2 ** 20;
export function kindOf(name, mime) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (IMG[ext] || /^image\/(png|jpe?g|gif|webp)$/.test(mime || '')) return { kind: 'image', mime: IMG[ext] || mime };
  if (DOC[ext]) return { kind: 'doc', mime: DOC[ext] };
  if (mime === 'application/pdf') return { kind: 'doc', mime };
  return null;
}
const READY = /^(SUCCESS|PARSED|DONE|COMPLETED?|FINISHED|READY)$/i, FAILED = /FAIL|ERROR|REJECT|UNSUPPORT|INVALID/i;
const fcache = new Map();
export async function upload(token, acct, { name, data, mime }, signal) {
  const ck = acct + ':' + crypto.createHash('sha256').update(data).digest('hex');
  const c = fcache.get(ck);
  if (c && Date.now() - c.t < 40 * 60e3) return c.id;
  const ph = await gated(acct, signal, () => pow(token, UPLOAD, signal));
  const bd = '----PersonalComputer' + crypto.randomBytes(12).toString('hex'), fname = String(name).replace(/["\r\n\\]/g, '_');
  const body = Buffer.concat([Buffer.from('--' + bd + '\r\nContent-Disposition: form-data; name="file"; filename="' + fname + '"; filename*=UTF-8\'\'' + encodeURIComponent(name) + '\r\nContent-Type: ' + mime + '\r\n\r\n'), Buffer.from(data), Buffer.from('\r\n--' + bd + '--\r\n')]);
  let r;
  try {
    r = await apiFetch(api() + UPLOAD, { method: 'POST', signal, body: new Uint8Array(body),
      headers: headers(token, { 'Content-Type': 'multipart/form-data; boundary=' + bd, 'x-ds-pow-response': ph, 'x-file-size': String(data.length) }) });
  } catch (e) { if (signal?.aborted) throw e; throw netErr(e); }
  const t = await r.text().catch(() => '');
  if (isWafBody(t)) throw dErr(WAF, { status: 403, waf: true });
  let j = null; try { j = JSON.parse(t); } catch {}
  if (!r.ok || !j || (j.code && j.code !== 0) || +j.data?.biz_code) throw bizErr(j || { msg: t.slice(0, 200) }, r.ok ? 0 : r.status);
  const d = j.data?.biz_data || {}, id = d.id || d.file_id || d.file?.id;
  if (!id) throw new Error('chat.deepseek.com не вернул id файла');
  let st = String(d.status || '');
  for (let i = 0; !READY.test(st); i++) {
    if (FAILED.test(st)) throw new Error('DeepSeek не смог разобрать файл' + (d.error_msg ? ': ' + d.error_msg : ''));
    if (i >= 120) throw new Error('DeepSeek слишком долго разбирает файл');
    await sleep(i < 10 ? 500 : 1000, signal);
    if (signal?.aborted) throw signal.reason;
    const q = await call(token, 'GET', '/api/v0/file/fetch_files?file_ids=' + encodeURIComponent(id), null, signal);
    const list = Array.isArray(q?.files) ? q.files : Array.isArray(q) ? q : q && q[id] ? [q[id]] : q ? [q] : [];
    const rec = list.find(x => x && (x.id === id || x.file_id === id)) || (list.length === 1 ? list[0] : null);
    st = String(rec?.status || '');
    if (FAILED.test(st) && rec?.error_msg) throw new Error('DeepSeek не смог разобрать файл: ' + String(rec.error_msg).slice(0, 200));
  }
  fcache.set(ck, { t: Date.now(), id });
  if (fcache.size > 200) fcache.delete(fcache.keys().next().value);
  return id;
}

/* ---------- что отправить ----------
   MAX_MSG — сколько символов уходит одним сообщением (сайт молча не отвечает на ~80 000+), TOOL_LIM — на один результат инструмента */
const MAX_MSG = 60000, TOOL_LIM = 24000;
/* версия правил протокола: поменялась — инструкция уходит в чат заново */
const PROTO = 'ds1';
const SITE = 'Встроенных инструментов чата DeepSeek здесь нет: не пользуйся поиском в интернете самого чата — только инструментами из списка.';
const LIMITS = '\n\n# Предел длины ответа\nОдин твой ответ в этом чате ограничен по длине (вместе с размышлениями). Если ответ оборвётся, система попросит продолжить — тогда продолжай ровно с места обрыва, без повторов. Но лучше не доводить до обрыва:'
  + '\n- большой файл (больше ~250 строк или ~15 000 символов) создавай частями: write_file с первой частью, следующие части — следующими ответами через edit_file (old_string — последние строки файла, new_string — они же и продолжение);'
  + '\n- в одном ответе — не больше одного большого вызова; длинный текст пользователю — тоже частями, если он просит очень много.'
  + '\nСообщения тебе тоже ограничены: длинные результаты инструментов приходят сокращёнными — читай большие файлы частями (read_file с offset/limit).';
const instr = (sys, tools, upd) => wrapInstr(sys, tools, upd, { site: SITE, extra: LIMITS });

/* ---------- шаг агента ----------
   hist — история чата (с метками _ds), sys и tools — как для обычной модели. → { text, calls, used, ds } */
export async function turn({ key, think, sys, tools, hist, signal, onText, getFiles, idleMs = 180000 }) {
  const token = parseToken(key);
  if (!token) throw dErr('Вставь токен DeepSeek в настройках → Модель — без него модель не ответит.', { status: 401 });
  const me = await accountOf(token, signal), acct = me.id;
  const h = sysHash(sys, tools, PROTO), nm = names(hist), day = dayOf(sys);
  let fresh = false, shown = false, max = MAX_MSG;
  for (let attempt = 0; ; attempt++) {
    const an = fresh ? null : anchorOf(hist, acct, '_ds');
    /* head — инструкция (её не сокращаем), body — переписка */
    let head = '', body, sent;
    if (an) {
      const delta = sent = hist.slice(an.i + 1);
      body = render(delta, nm, { lim: TOOL_LIM });
      if (delta.length && delta.at(-1).role === 'tool') body += NUDGE;
      if (an.q.h !== h) head = instr(sys, tools, true);
      else if (day && an.q.d && an.q.d !== day) body = '[Сегодня ' + day + ']\n' + body;
    } else { head = instr(sys, tools, false); body = freshContent(hist, '', nm, { max: max - head.length, lim: TOOL_LIM }).replace(/^\n\n/, ''); sent = hist; }
    /* 100 — на пометку «…[пропущено N символов]…» */
    const room = Math.max(4000, max - head.length - 100);
    if (body.length > room) body = clip(body, room);
    let content = head ? head + '\n\n' + body : body;
    if (!content.trim()) content = 'Продолжай.';
    /* файлы из того, что уходит сейчас (в новом чате — и из прежней переписки, сколько влезет) */
    const att = await attachFiles(sent, getFiles, { kindOf, limits: { image: 5, doc: 5 }, maxSize: MAX_FILE, signal,
      upload: (f, sg) => upload(token, acct, f, sg), fatal: e => e.waf || e.muted || e.status === 401 });
    content += att.note;
    /* «тишина» дольше idleMs — модель зависла */
    const idle = new AbortController();
    let it = setTimeout(() => idle.abort(), idleMs);
    const poke = () => { clearTimeout(it); it = setTimeout(() => idle.abort(), idleMs); };
    const sig = AbortSignal.any([signal, idle.signal]);
    const P = callParser(s => { shown = true; onText?.(s); });
    try {
      const chatId = an ? an.q.c : await newChat(token, sig);
      /* all — весь ответ (с продолжениями), каким его получил разборщик вызовов */
      let all = '';
      const push = s => { all += s; P.push(s); };
      const one = (o, pipe) => gated(acct, sig, () => complete({ token, chatId, signal: sig, onPoke: poke, ...o, onText: pipe }));
      let r = await one({ parent: an ? an.q.r : null, prompt: content, files: att.files, think }, push);
      let last = r.respId ?? null, used = r.used;
      /* упёрлись в предел длины ответа — просим продолжить в том же чате и приклеиваем продолжение */
      for (let k = 0; k < MAX_CONT && last !== null && cutOff(r, P, all); k++) {
        const S = stitch(all.slice(-400), push), had = all.length;
        try { r = await one({ parent: last, prompt: CONTINUE, think: false }, s => S.push(s)); }
        catch (e) { if (signal.aborted) throw e; console.warn('deepseek: продолжение ответа не вышло:', e.message); break; }
        S.end();
        if (r.respId !== null) last = r.respId;
        used = r.used || used;
        /* продолжать нечего («[END]» или пусто) — ответ такой, какой есть */
        if (all.length === had) break;
      }
      const { text, calls } = P.end();
      if (!text && !calls.length) throw dErr('DeepSeek вернул пустой ответ. Нажми «Повторить».', { empty: true });
      return { text, calls, used, ds: last !== null ? { c: chatId, r: last, a: acct, h, d: day } : null };
    } catch (e) {
      if (signal.aborted) throw e;
      if (e.status === 401) acache.delete(token);
      if (idle.signal.aborted) e = dErr('DeepSeek не отвечает уже ' + Math.round(idleMs / 60000) + ' мин. Нажми «Повторить».', { net: true });
      const final = e.waf || e.muted || e.captcha || e.status === 401 || e.status === 429;
      /* продолжить старый чат не вышло (его удалили на сайте, ветка битая, переполнен) — новый чат со всей перепиской */
      if (an && !shown && !e.net && !final && !fresh) { fresh = true; continue; }
      /* пустой ответ или «слишком длинно» в новом чате — сайт не переварил сообщение: короче */
      if (!an && !shown && (e.empty || e.long) && max > 20000) { max = Math.floor(max / 2); continue; }
      /* сеть или перегрузка: ещё раз, пока пользователь ничего не увидел */
      if (!shown && attempt < 2 && (e.net || e.status >= 500)) { await sleep([3000, 10000][attempt], signal); if (signal.aborted) throw e; continue; }
      throw e;
    } finally { clearTimeout(it); }
  }
}

/* короткий ответ без инструментов (название чата): во временном чате, который потом удаляем, — чтобы не засорять аккаунт */
export async function ask({ key, prompt, signal }) {
  const token = parseToken(key), { id: acct } = await accountOf(token, signal);
  const chatId = await newChat(token, signal);
  try { return (await gated(acct, signal, () => complete({ token, chatId, parent: null, prompt, think: false, signal }))).text; }
  finally { dropChat(token, chatId); }
}

/* проверка в настройках: токен рабочий, чей аккаунт, какие модели */
export async function check(rawKey) {
  const token = parseToken(rawKey);
  if (!token) throw dErr('Вставь токен DeepSeek — после этого проверю связь', { status: 401, needKey: true });
  const me = await accountOf(token);
  return { models: MODELS.map(m => m.id), info: MODELS, login: me.login, exp: 0, needKey: false, free: null };
}
