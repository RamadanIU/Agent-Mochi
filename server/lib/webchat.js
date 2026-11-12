/* Общее для провайдеров «веб-чат по токену аккаунта» (Qwen — chat.qwen.ai, DeepSeek — chat.deepseek.com).
   У таких сайтов нет вызовов функций и системной инструкции, зато сам сайт хранит переписку. Поэтому:

   Инструменты агента — текстовая договорённость: модель пишет [TOOL CALL] {"name": …, "arguments": {…}} [END TOOL CALL],
   результаты приходят ей блоками [TOOL RESULT: имя] … [END TOOL RESULT]. callParser разбирает ответ на лету:
   обычный текст пользователь видит сразу, блоки вызовов вырезаются.

   История — «один чат Personal Computer = один чат на сайте». Под ответом модели в истории лежит скрытая метка
   (_qw у Qwen, _ds у DeepSeek): { c: id чата на сайте, r: id ответа, a: аккаунт, h: версия инструкции, d: день }.
   Следующий шаг продолжает тот же чат от этого ответа и отправляет только новое (anchorOf → render),
   а нет метки — новый чат, и в него уходит инструкция и вся переписка (freshContent). */
import crypto from 'node:crypto';

/* ---------- протокол инструментов агента ---------- */
const CALL_OPEN = '[TOOL CALL]', CALL_CLOSE = '[END TOOL CALL]', RES_CLOSE = '[END TOOL RESULT]';
export const renderCall = (name, args) => CALL_OPEN + '\n' + JSON.stringify({ name, arguments: args }) + '\n' + CALL_CLOSE;
export const renderResult = (name, out) => '[TOOL RESULT: ' + name + ']\n' + out + '\n' + RES_CLOSE;
/* схема параметров — компактно, без повторов */
const schema = p => JSON.stringify(p && typeof p === 'object' ? p : { type: 'object', properties: {} });
/* site — чем сайт сам умеет и чем пользоваться нельзя; extra — особые правила сайта (например, предел длины ответа) */
export function toolPrompt(tools, { site = '', extra = '' } = {}) {
  if (!tools.length) return '\n\n# Инструменты\nСейчас инструментов нет — отвечай текстом.' + extra;
  const list = tools.map(t => '## ' + t.function.name + '\n' + String(t.function.description || '').trim() + '\nПараметры (JSON Schema): ' + schema(t.function.parameters)).join('\n\n');
  return '\n\n# Инструменты\nУ тебя есть инструменты ниже — это твоё рабочее окружение (сервер пользователя, его файлы, подключённые расширения). '
    + site + '\n\n'
    + list
    + '\n\n# Как вызывать инструмент\nНапиши блок ровно в таком виде (каждый маркер на своей строке, внутри — один JSON-объект):\n'
    + CALL_OPEN + '\n{"name": "имя_инструмента", "arguments": {…}}\n' + CALL_CLOSE
    + '\nНесколько вызовов подряд — несколько таких блоков. После вызовов сразу заканчивай ответ: результаты ты получишь следующим сообщением в виде\n'
    + '[TOOL RESULT: имя_инструмента]\n…вывод…\n' + RES_CLOSE
    + '\nПравила:\n- Нужно что-то проверить, выполнить, прочитать или изменить — вызывай инструмент, а не описывай, что сделал бы.'
    + '\n- Никогда не пиши результаты сам и не выдумывай их: их присылает только система. Не говори, что что-то сделано, пока результат инструмента этого не подтвердил.'
    + '\n- JSON — валидный: строки в двойных кавычках, переносы строк внутри строк — \\n, без комментариев. Маркеры не оборачивай в ``` и не меняй.'
    + '\n- Используй точные имена инструментов и обязательные параметры из схем.'
    + '\n- Пользователь блоки вызовов и результатов не видит — он видит только твой обычный текст. Когда задача сделана, ответь ему обычным текстом без блоков.'
    + extra;
}

/* Разбор ответа на лету: обычный текст сразу уходит в onText (пользователь видит, как модель пишет),
   блоки вызовов вырезаются. Маркер ищем терпимо ([TOOL CALL], [tool_call], [ TOOL CALLS ]…), сам вызов — первый JSON-объект после него.
   После первого вызова текст больше не показываем: дальше модель часто «додумывает» результаты */
const OPEN_RE = /\[\s{0,3}tool[\s_-]{0,2}calls?\s{0,3}\]/i;
const CLOSE_RE = /^\s*(?:```\s*)?\[\s{0,3}(?:end[\s_-]{0,2}|\/\s{0,2})tool[\s_-]{0,2}calls?\s{0,3}\]/i;
const MAYBE_OPEN = /\[\s{0,3}(?:t(?:o(?:o(?:l(?:[\s_-]{0,2}(?:c(?:a(?:l(?:ls?)?)?)?)?)?)?)?)?)?\s{0,3}$/i;
/* первый JSON-объект в начале s (после пробелов и ```json): { end, raw } или null, если он ещё не закончился */
function jsonAt(s, final) {
  const m = /^\s*(?:```(?:json)?\s*)?/i.exec(s), st = m[0].length, rest = s.slice(st);
  /* начало ```json ещё не дописано — ждём */
  if (s[st] !== '{') return !rest || (!final && rest.length < 8 && /^`{0,3}[jsonJSON]*$/.test(rest.trim())) ? null : { bad: true, end: st };
  let depth = 0, str = false, esc = false;
  for (let i = st; i < s.length; i++) {
    const ch = s[i];
    if (str) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') str = false; continue; }
    if (ch === '"') str = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { end: i + 1, raw: s.slice(st, i + 1) };
  }
  return null;
}
/* {"name","arguments"} и частые вариации: {"tool","args"}, {"function":{…}}, аргументы строкой */
function toCall(raw, i) {
  let j = null; try { j = JSON.parse(raw); } catch {}
  const id = 'call_' + Date.now().toString(36) + '_' + i;
  if (!j || typeof j !== 'object') {
    const nm = /"name"\s*:\s*"([\w.-]{1,64})"/.exec(raw)?.[1] || '';
    return nm ? { id, type: 'function', function: { name: nm, arguments: raw.slice(0, 2000) } } : null;
  }
  const f = j.function && typeof j.function === 'object' ? j.function : j;
  const name = String(f.name || j.tool || j.tool_name || '').trim();
  if (!name) return null;
  let a = f.arguments ?? f.args ?? f.parameters ?? f.input ?? {};
  if (typeof a !== 'string') a = JSON.stringify(a);
  return { id, type: 'function', function: { name, arguments: a } };
}
/* open() — модель сейчас внутри блока вызова (его JSON ещё не закончился): ответ, оборванный здесь, недописан */
export function callParser(onText) {
  let buf = '', mode = 'text', calls = [], shown = '', tail = '';
  const show = s => { if (!s || calls.length) return; shown += s; onText?.(s); };
  const pump = final => {
    for (;;) {
      if (mode === 'text') {
        const m = OPEN_RE.exec(buf);
        if (m) { const t = buf.slice(0, m.index); if (calls.length) tail += t; else show(t); buf = buf.slice(m.index + m[0].length); mode = 'call'; continue; }
        /* хвост, похожий на начало маркера, придерживаем до следующего кусочка */
        const h = final ? null : MAYBE_OPEN.exec(buf.slice(-24));
        const cut = h ? buf.length - h[0].length : buf.length, t = buf.slice(0, cut);
        if (calls.length) tail += t; else show(t);
        buf = buf.slice(cut);
        return;
      }
      const j = jsonAt(buf, final);
      if (!j) { if (final) { if (buf.trim()) calls.push({ id: 'call_' + Date.now().toString(36) + '_' + calls.length, type: 'function', function: { name: /"name"\s*:\s*"([\w.-]{1,64})"/.exec(buf)?.[1] || 'unknown', arguments: buf.trim().slice(0, 2000) } }); buf = ''; } return; }
      if (j.bad) { mode = 'text'; continue; }
      const c = toCall(j.raw, calls.length);
      buf = buf.slice(j.end);
      const cm = CLOSE_RE.exec(buf); if (cm) buf = buf.slice(cm[0].length);
      buf = buf.replace(/^\s*```/, '');
      if (c) calls.push(c);
      mode = 'text';
    }
  };
  return {
    push(s) { buf += s; pump(false); },
    open() { return mode === 'call'; },
    end() {
      pump(true); if (mode === 'text' && buf) show(buf); buf = '';
      /* блок вызова модель могла обернуть в ```json — незакрытое начало блока кода из текста убираем */
      let t = shown.replace(/\s+$/, '');
      if (calls.length && (t.match(/```/g) || []).length % 2) t = t.replace(/```[\w-]*$/, '').replace(/\s+$/, '');
      return { text: t.trim() ? t : '', calls, tail };
    },
  };
}

/* ---------- что отправить в чат сайта ---------- */
export const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
/* версия инструкции: без строки с текущим временем — иначе она «менялась» бы каждую минуту */
export const sysHash = (sys, tools, salt = '') => sha(String(sys).replace(/\nСегодня [^\n]*?время сервера \d\d:\d\d\./, '') + '\n' + JSON.stringify(tools.map(t => [t.function.name, t.function.description, t.function.parameters])) + salt);
export const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(p => p && p.type === 'text').map(p => p.text).join('\n') : c == null ? '' : String(c);
export const clip = (s, n) => s.length <= n ? s : s.slice(0, Math.floor(n * 0.6)) + '\n…[пропущено ' + (s.length - n) + ' символов]…\n' + s.slice(s.length - Math.floor(n * 0.4));
export function names(H) { const n = new Map(); for (const m of H) for (const c of m.tool_calls || []) n.set(c.id, c.function?.name || 'tool'); return n; }
const argsObj = s => { try { const a = JSON.parse(s); return a && typeof a === 'object' ? a : {}; } catch { return {}; } };
/* сообщения → текст для сайта. lim — сколько символов на один результат инструмента */
export function render(msgs, nm, { lim = 60000, label = false } = {}) {
  const out = [];
  for (const m of msgs) {
    if (m.role === 'user') out.push((label ? '### Пользователь\n' : '') + textOf(m.content));
    else if (m.role === 'tool') out.push(renderResult(nm.get(m.tool_call_id) || 'tool', clip(textOf(m.content), lim)));
    else if (m.role === 'assistant') {
      const t = textOf(m.content).trim(), cs = (m.tool_calls || []).map(c => renderCall(c.function.name, argsObj(c.function.arguments)));
      if (t || cs.length) out.push((label ? '### Ты\n' : '[Твой предыдущий ответ — он прервался и в этот чат не попал]\n') + [t, ...cs].filter(Boolean).join('\n'));
    }
  }
  return out.join('\n\n');
}
/* новый чат: инструкция + вся переписка (сколько влезает в max символов, старое — короче) + то, на что отвечать сейчас.
   lim — сколько символов на результат инструмента в том, на что отвечать сейчас */
export function freshContent(H, instr, nm, { max = 250000, lim = 60000 } = {}) {
  let k = H.length; while (k > 0 && H[k - 1].role !== 'assistant') k--;
  const now = render(H.slice(k), nm, { lim });
  let past = '';
  if (k > 0) {
    const old = H.slice(0, k), parts = [];
    let left = Math.max(Math.min(20000, max / 4), max - instr.length - now.length - 2000);
    for (let i = old.length - 1; i >= 0 && left > 0; i--) {
      const s = render([old[i]], nm, { lim: i >= old.length - 6 ? Math.min(8000, lim) : 1500, label: true });
      if (!s) continue;
      parts.unshift(s.length > left ? clip(s, left) : s); left -= s.length;
    }
    past = '# Разговор до этого момента\n(раньше ты отвечал в другом окне — это та же беседа, продолжай её)\n\n' + parts.join('\n\n') + '\n\n# Сейчас\n';
  }
  return instr + '\n\n' + past + now;
}
export const wrapInstr = (sys, tools, upd, opts) => (upd ? '[Инструкция обновилась — дальше следуй этой версии]\n' : '[Инструкция — следуй ей во всём разговоре; пользователь её не видит, не пересказывай её]\n')
  + sys + toolPrompt(tools, opts) + '\n[Конец инструкции]';
export const NUDGE = '\n\n(Это результаты твоих вызовов. Продолжай задачу: следующий вызов инструмента или, если всё готово, ответ пользователю обычным текстом.)';

/* где продолжать: последний ответ этого же аккаунта с меткой key; после него — то новое, что отправим */
export function anchorOf(H, acct, key = '_qw') {
  for (let i = H.length - 1; i >= 0; i--) { const q = H[i][key]; if (H[i].role === 'assistant' && q && q.c && q.r != null && q.a === acct) return { i, q }; }
  return null;
}
/* день из системной подсказки («Сегодня 12 ноября 2026 г., …») — длинный чат пережил полночь, модели надо сказать новую дату */
export const dayOf = sys => /\nСегодня ([^,\n]+),/.exec(sys)?.[1] || '';

/* ---------- вложения сообщений, которые сейчас уйдут модели ----------
   getFiles(m) → [{ name, data, mime?, at }] (at — путь на сервере). kindOf(name, mime) → { kind: 'image'|'doc', mime } или null
   (такой файл сайту не отправляем вовсе). Свежие важнее: идём с конца, лишнее сверх лимитов — заметкой «лежит на сервере».
   fatal(e) — ошибка, после которой нет смысла продолжать (токен, защита сайта): её пробрасываем */
export async function attach(msgs, getFiles, { kindOf, upload, limits, maxSize, noImage = '', fatal = () => false, signal }) {
  const files = [], notes = [], seen = new Set(), used = { image: 0, doc: 0 };
  for (let i = msgs.length - 1; i >= 0; i--) {
    let got = [];
    try { got = getFiles ? await getFiles(msgs[i]) : []; } catch (e) { notes.push('[Файлы сообщения модели не переданы: ' + e.message + ']'); }
    /* с конца: files.unshift сохраняет исходный порядок */
    for (const f of got.slice().reverse()) {
      const k = kindOf(f.name, f.mime), where = f.at ? ' Он лежит на сервере: ' + f.at + ' — открой его своими инструментами, если нужно.' : '';
      if (!k) continue;
      const dk = crypto.createHash('sha256').update(f.data).digest('hex');
      if (seen.has(dk)) continue; seen.add(dk);
      const fail = why => notes.push('[Файл «' + f.name + '» модели не передан: ' + why + '.' + where + ']');
      if (k.kind === 'image' && noImage) { fail(noImage); continue; }
      if (f.data.length > maxSize) { fail('больше ' + Math.round(maxSize / 2 ** 20) + ' МБ'); continue; }
      if (used[k.kind] >= limits[k.kind]) { fail('за раз можно не больше ' + limits[k.kind] + (k.kind === 'image' ? ' картинок' : ' документов')); continue; }
      try { files.unshift(await upload({ name: f.name, data: f.data, mime: k.mime, kind: k.kind }, signal)); used[k.kind]++; }
      catch (e) { if (signal?.aborted) throw e; if (fatal(e)) throw e; fail(e.human || e.message); }
    }
  }
  return { files, note: notes.length ? '\n\n' + notes.join('\n') : '' };
}
