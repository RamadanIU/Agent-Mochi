/* Агент Мочи на сервере. Работа не зависит от браузера: чат только подписывается на события.
   Состояние чата (история для модели + журнал для экрана) лежит на диске и переживает перезапуск сервера:
   незаконченная задача после рестарта продолжается сама. */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CFG } from './config.js';
import { Doc, ensureDir, rid, writeJSONSync, readJSON } from './store.js';
import { runCmd, fileCmd, agentInfo } from './runner-client.js';
import { userDir, pullFile, storeFile, sz } from './files.js';
import { webTools, webCall } from './mcp.js';
import { apiFetch, cfBlock, cfMessage } from './net.js';
import { agentExt, extTool, mcpCall, MANAGE_TOOLS, EXT_TOOLS, BUILTIN, mcpPublic, skillList, tokens } from './ext.js';

export const DEF_SYS = 'Тебя зовут Мочи — ты милый пиксельный зверёк-помощник. Общайся тепло, по-доброму и чуть игриво (максимум один короткий смайл вроде ^_^ или «~» на ответ), но без лишней болтовни. Отвечай максимально коротко: одно-два предложения, а если хватает слова или числа — только им. Без вступлений, пересказа вопроса, пояснений и предложений помощи в конце. Делай строго то, что попросили, и ничего сверх этого: не добавляй советов и «бонусов», не выполняй лишних действий, не улучшай и не исправляй то, о чём не просили, не задавай уточняющих вопросов без крайней необходимости. У тебя есть доступ к настоящему Linux-серверу через инструмент run_command. Используй его, только когда нужно проверить факт или выполнить просьбу, а не угадывать. В поле action кратко и по-человечески пиши, что делаешь. Не показывай команды и сырой вывод, если пользователь сам не просил, — только итог простыми словами. Отвечай на языке пользователя.';
/* что умеет показывать веб-чат — модель должна знать, чтобы рисовать таблицы и схемы, а не ASCII-картинки */
const FMT = 'Оформление: чат показывает Markdown — заголовки, списки, таблицы, цитаты и врезки (> [!NOTE], > [!TIP], > [!WARNING]), `код` и блоки кода с языком, формулы LaTeX ($…$, $$…$$) и схемы в блоке ```mermaid (flowchart, sequenceDiagram, stateDiagram, pie, mindmap, timeline). Пользуйся этим, только когда правда помогает: сравнение — таблицей, процесс или связи — схемой, вычисления — формулой. Короткий ответ оставляй простым текстом.';
export const DEF_SETTINGS = { base: 'https://api.openai.com/v1', key: '', model: 'gpt-4o-mini', sys: DEF_SYS, search: true, vis: true, stepLimit: true, maxSteps: CFG.maxSteps };
/* лимит шагов подряд (настройки → Модель): число от 1 до MAX_STEPS */
export const MAX_STEPS = 10000;

/* к модулю Telegram (он подключается сам, чтобы не было кольцевых импортов) */
export const hooks = { tg: null };

const RUN_TOOL = { type: 'function', function: { name: 'run_command', description: 'Выполнить shell-команду (bash) на Linux-сервере и получить вывод и код выхода. Каждый вызов — новая оболочка: текущая папка сохраняется, переменные окружения — нет.',
  parameters: { type: 'object', properties: {
    action: { type: 'string', description: 'Что ты делаешь сейчас — для пользователя: 2–6 слов на его языке, например «Проверяю версию ядра». Без команд и технических деталей.' },
    command: { type: 'string', description: 'Команда' },
    timeout: { type: 'number', description: 'Таймаут, сек (по умолчанию 120, максимум 3600). Для более долгого — запуск в фоне через nohup.' } }, required: ['action', 'command'] } } };
/* файлы: читать, править и создавать без cat/sed/heredoc (см. fileops.js — там же все проверки) */
const P_PATH = { type: 'string', description: 'Путь к файлу: абсолютный или от текущей папки' };
const READ_TOOL = { type: 'function', function: { name: 'read_file', description: 'Прочитать текстовый файл. Строки выводятся как «номер<TAB>текст» — номер и табуляция не часть файла. Длинный файл — частями: внизу подсказка, с какого offset продолжить. Для папки — её содержимое. Поиск по файлам — run_command (grep -rn, find).',
  parameters: { type: 'object', properties: {
    path: P_PATH,
    offset: { type: 'integer', description: 'С какой строки начать (с 1); отрицательный — последние строки (-50 — хвост лога)' },
    limit: { type: 'integer', description: 'Сколько строк показать (по умолчанию до 1000)' } }, required: ['path'] } } };
const P_EDIT = {
  old_string: { type: 'string', description: 'Точный текст, который нужно заменить' },
  new_string: { type: 'string', description: 'Текст на замену (пустой — удалить)' },
  replace_all: { type: 'boolean', description: 'true — заменить все вхождения' } };
const EDIT_TOOL = { type: 'function', function: { name: 'edit_file', description: 'Точечно изменить текстовый файл: заменить old_string на new_string. old_string копируй из read_file точно — с отступами, без номеров строк; он должен встречаться в файле один раз (добавь соседние строки для однозначности) или replace_all: true. Несколько правок одного файла — одним вызовом через edits: по порядку, все или ни одной. В ответе — изменённые строки с соседними, перечитывать файл не нужно.',
  parameters: { type: 'object', properties: { path: P_PATH, ...P_EDIT,
    edits: { type: 'array', description: 'Несколько правок {old_string, new_string, replace_all} вместо одной', items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old_string', 'new_string'] } } }, required: ['path'] } } };
const WRITE_TOOL = { type: 'function', function: { name: 'write_file', description: 'Создать файл (недостающие папки создаются) или целиком заменить его содержимое. Существующий файл сначала прочитай через read_file; для частичных изменений используй edit_file — он дешевле и надёжнее. Пиши содержимое полностью, без сокращений вроде «… остальное без изменений».',
  parameters: { type: 'object', properties: { path: P_PATH, content: { type: 'string', description: 'Полное содержимое файла' } }, required: ['path', 'content'] } } };
const FILE_TOOLS = new Set(['read_file', 'edit_file', 'write_file']);
/* картинка с диска → модели: результат инструмента бывает только текстом, поэтому сама картинка приходит
   следующим сообщением (как вложение пользователя) — так её видят все OpenAI-совместимые модели со зрением */
const VIEW_TOOL = { type: 'function', function: { name: 'view_image', description: 'Посмотреть картинку с сервера своими глазами: фото, скриншот, график, схему (PNG, JPEG, GIF, WebP до 8 МБ). Картинка придёт следующим сообщением. Другие форматы (SVG, PDF, HEIC, BMP) сначала сконвертируй в PNG через run_command.',
  parameters: { type: 'object', properties: { path: P_PATH }, required: ['path'] } } };
const SEND_TOOL = { type: 'function', function: { name: 'send_file', description: 'Передать пользователю файл с сервера: в чате появится карточка с кнопкой «Скачать» (и файл придёт в Telegram, если он подключён и пользователь не в чате). Используй, когда результат — файл (документ, архив, картинка, таблица, скрипт), а не текст. Один вызов — один файл; несколько файлов упакуй в архив (tar czf). Файл должен лежать в рабочей папке.',
  parameters: { type: 'object', properties: {
    path: { type: 'string', description: 'Путь к файлу (абсолютный или относительно текущей папки), например outbox/report.pdf' },
    name: { type: 'string', description: 'Имя файла для пользователя (необязательно)' },
    note: { type: 'string', description: 'Короткая подпись на языке пользователя (необязательно)' } }, required: ['path'] } } };
export const TG_TOOLS = [
  { type: 'function', function: { name: 'telegram_connect', description: 'Подключить Telegram-бота для управления Мочи и уведомлений. Нужен токен бота от @BotFather. Возвращает ссылку, по которой пользователь привязывает свой Telegram (её обязательно передай пользователю).',
    parameters: { type: 'object', properties: { token: { type: 'string', description: 'Токен бота вида 123456789:AA…' } }, required: ['token'] } } },
  { type: 'function', function: { name: 'telegram_status', description: 'Узнать, подключён ли Telegram: имя бота, привязан ли чат пользователя, режим уведомлений. Может выдать новую ссылку для привязки.',
    parameters: { type: 'object', properties: { new_link: { type: 'boolean', description: 'true — выдать новую ссылку привязки' } } } } },
  { type: 'function', function: { name: 'telegram_send', description: 'Отправить пользователю сообщение в Telegram (если бот подключён и привязан). Используй, когда пользователь просил уведомить его или прислать что-то в Telegram.',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'Текст сообщения' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'telegram_notify_mode', description: 'Настроить, когда Мочи пишет в Telegram о завершении задач: away — только если пользователь не смотрит чат, always — всегда, off — никогда.',
    parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['away', 'always', 'off'] } }, required: ['mode'] } } },
  { type: 'function', function: { name: 'telegram_disconnect', description: 'Отключить Telegram-бота от Мочи.', parameters: { type: 'object', properties: {} } } },
];

/* встроенные инструменты, которые пользователь может выключить (Настройки → Инструменты) */
const GROUPS = { run_command: 'Сервер', send_file: 'Сервер', read_file: 'Файлы', view_image: 'Файлы', edit_file: 'Файлы', write_file: 'Файлы', mcp_manage: 'Расширения', skills_manage: 'Расширения' };
const groupOf = n => GROUPS[n] || (n.startsWith('telegram_') ? 'Telegram' : 'Интернет');
const builtins = () => [RUN_TOOL, READ_TOOL, VIEW_TOOL, EDIT_TOOL, WRITE_TOOL, SEND_TOOL, ...TG_TOOLS];
/* встроенные включает и выключает только пользователь: агенту об этом нужно знать, чтобы не пытаться обойти */
for (const t of [...builtins(), ...MANAGE_TOOLS]) BUILTIN.add(t.function.name);
const isOn = (S, n) => (S.tools || {})[n] !== false;

/* что видит пользователь в настройках: все инструменты, их состояние и примерный «вес» в каждом запросе */
export async function toolCatalog(chat) {
  const S = chat.settings(), web = S.search ? await webTools() : [];
  const row = t => ({ name: t.function.name, group: groupOf(t.function.name), desc: t.function.description.split(/(?<=[.!?])\s/)[0].slice(0, 200), on: isOn(S, t.function.name), size: tokens(t) });
  return { builtin: [...builtins(), ...web, ...MANAGE_TOOLS].map(row), search: S.search !== false, mcp: mcpPublic(chat.u), skills: await skillList(chat.u) };
}
export function setTools(chat, m) {
  const t = chat.set.v.tools ||= {};
  for (const [n, on] of Object.entries(m || {})) if (/^[\w-]{1,64}$/.test(n)) { if (on) delete t[n]; else t[n] = false; }
  chat.set.save();
}

const argsOk = s => { try { const a = JSON.parse(s); return !!a && typeof a === 'object' && !Array.isArray(a); } catch { return false; } };
const sleep = (ms, sig) => new Promise(ok => { const t = setTimeout(ok, ms); sig?.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true }); });
const abortErr = () => Object.assign(new Error('остановлено'), { name: 'AbortError' });

function labelFor(n, a) {
  let s;
  if (n === 'run_command') s = a.action || 'Работаю на сервере';
  else if (n === 'send_file') s = 'Отправляю файл: ' + (a.name || String(a.path || '').split('/').pop());
  else if (n === 'view_image') s = 'Смотрю картинку: ' + String(a.path || '').split('/').pop();
  else if (FILE_TOOLS.has(n)) s = { read_file: 'Читаю файл', edit_file: 'Правлю файл', write_file: 'Пишу файл' }[n] + ': ' + String(a.path || '').replace(/\/+$/, '').split('/').pop();
  else if (n === 'web_search') { const q = Array.isArray(a.search_queries) ? a.search_queries[0] : a.objective; s = 'Ищу в интернете' + (q ? ': ' + q : ''); }
  else if (n === 'web_fetch') { let h = ''; try { h = new URL([].concat(a.urls || [])[0]).hostname.replace(/^www\./, ''); } catch {} s = 'Читаю страницу' + (h ? ': ' + h : ''); }
  else if (n === 'telegram_connect') s = 'Подключаю Telegram';
  else if (n === 'telegram_send') s = 'Пишу в Telegram';
  else if (n.startsWith('telegram_')) s = 'Настраиваю Telegram';
  else if (n === 'skill') s = 'Читаю навык: ' + (a.name || '');
  else if (n === 'mcp_connect') s = 'Подключаю инструменты: ' + (a.server || '');
  else if (n === 'mcp_manage') s = a.action === 'list' ? 'Смотрю MCP-серверы' : 'Настраиваю MCP' + (a.name ? ': ' + a.name : '');
  else if (n === 'skills_manage') s = a.action === 'install' ? 'Устанавливаю навык' : a.action === 'list' ? 'Смотрю навыки' : 'Настраиваю навыки' + (a.name ? ': ' + a.name : '');
  else if (n.includes('__')) { const [srv, ...t] = n.split('__'); s = srv + ' · ' + t.join('__'); }
  else s = n;
  return String(s).slice(0, 80);
}

export function friendly(e) {
  const s = e.status;
  if (e.cf) return e.cf;
  /* шлюзы вроде New API (JustWoker) отвечают 401/403, когда на ключе кончилась квота, — это не «неверный ключ» */
  if ((s === 401 || s === 403) && /quota|额度|余额|balance|credits?\b|insufficient[ _](funds|balance|credits?)/i.test(e.detail || '')) return 'На ключе кончились деньги или квота (HTTP ' + s + '). Пополни баланс у провайдера или выбери модель подешевле.';
  if (s === 401 || s === 403) return 'Ключ API не подошёл (HTTP ' + s + '). Проверь его в настройках.';
  if (s === 402) return 'На счёте нет денег для этой модели (HTTP 402). Пополни баланс или выбери бесплатную модель (у OpenRouter — с «:free» в конце).';
  if (s === 404) return 'Не нашла модель или адрес API (HTTP 404). Проверь их в настройках.';
  if (s === 429) return 'Слишком много запросов или на счёте кончились деньги (HTTP 429). Подожди минутку и повтори.';
  if (s >= 500) return 'У сервера модели что-то сломалось (HTTP ' + s + '). Повтори чуть позже.';
  return e.message || 'ошибка';
}

const chats = new Map();
export function getChat(u) {
  if (!chats.has(u.id)) chats.set(u.id, new Chat(u));
  return chats.get(u.id);
}
export const allChats = () => chats.values();

export class Chat extends EventEmitter {
  constructor(u) {
    super();
    this.setMaxListeners(50);
    this.u = u;
    this.dir = path.join(CFG.data, 'users', u.id);
    ensureDir(this.dir);
    this.doc = new Doc(path.join(this.dir, 'chat.json'), { hist: [], log: [], seq: 0, run: null, cwd: null, sess: rid(16) });
    this.set = new Doc(path.join(this.dir, 'settings.json'), () => ({ ...DEF_SETTINGS }));
    this.clients = new Set();
    this.ctl = null; this.partial = ''; this.gen = 0; this.noVis = 0;
    /* что агент уже видел из файлов (только в памяти): настоящий путь → {sig: версия, rng: [[с, по, ход]]};
       нужно, чтобы не перезаписать непрочитанный файл и не выводить заново то, что уже есть в разговоре */
    this.seen = new Map(); this.turn = 0; this.phKey = null;
  }
  get running() { return !!this.ctl; }
  get away() { return this.clients.size === 0; }
  settings() { return { ...DEF_SETTINGS, ...this.set.v }; }
  runState() {
    const r = this.doc.v.run;
    return { running: this.running, ...(r ? { origin: r.origin, t: r.t, steps: r.steps } : {}) };
  }
  snapshot() { return { log: this.doc.v.log, seq: this.doc.v.seq, partial: this.partial, ...this.runState() }; }

  /* ---------- журнал для экрана ---------- */
  push(e) {
    const L = this.doc.v.log;
    e = { ...e, seq: ++this.doc.v.seq, t: Date.now() };
    L.push(e);
    if (L.length > 400) L.splice(0, L.length - 400);
    this.doc.save();
    this.emit('log', e);
    return e;
  }
  update(e) { e.u = Date.now(); this.doc.save(); this.emit('log', e); }

  /* ---------- вложения (картинки/PDF для модели) хранятся отдельными файлами ---------- */
  partsFile(id) { return path.join(this.dir, 'parts', id + '.json'); }
  saveParts(parts) { const id = rid(8); ensureDir(path.join(this.dir, 'parts')); writeJSONSync(this.partsFile(id), parts); return id; }
  loadParts(id) { return readJSON(this.partsFile(id), []); }
  dropParts(msgs) { for (const m of msgs) if (m._pf) fs.rm(this.partsFile(m._pf), { force: true }, () => {}); }

  /* в запрос уходят вложения трёх последних сообщений с файлами; уровень отката: 1 — без PDF, 2 — без всего */
  wire() {
    const H = this.doc.v.hist, lvl = this.settings().vis === false ? 2 : this.noVis;
    const rec = new Set(H.map((m, i) => m._pf ? i : -1).filter(i => i >= 0).slice(-3));
    const us = H.map((m, i) => m.role === 'user' ? i : -1).filter(i => i >= 0), from = us.length > 40 ? us[us.length - 40] : 0;
    const out = [];
    for (let i = from; i < H.length; i++) {
      const { _pf, _vi, ...m } = H[i];
      /* Ollama не принимает историю, где аргументы вызова — не JSON-объект (обрезаны или пустые): шлём {} — модель и так получила ошибку */
      if (m.tool_calls) m.tool_calls = m.tool_calls.map(c => argsOk(c.function.arguments) ? c : { ...c, function: { ...c.function, arguments: '{}' } });
      if (_pf && lvl < 2 && rec.has(i)) {
        const ps = this.loadParts(_pf).filter(p => lvl < 1 || p.type === 'image_url');
        if (ps.length) m.content = [{ type: 'text', text: m.content }, ...ps];
      } else if (_vi) m.content += lvl < 2 ? ' (картинка была открыта давно и уже не передаётся — открой её снова, если нужно)' : ' (модель не принимает картинки — изображение не передано, ты его не видишь)';
      out.push(m);
    }
    return out;
  }
  hasPdf() { return this.wire().some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'file')); }

  trimHist() {
    const H = this.doc.v.hist, us = H.map((m, i) => m.role === 'user' ? i : -1).filter(i => i >= 0);
    if (us.length > 80) { const cut = us[us.length - 60]; this.dropParts(H.slice(0, cut)); H.splice(0, cut); }
  }

  /* незакрытые вызовы инструментов получают ответ, иначе модель не примет историю */
  repair(why = 'Прервано пользователем') {
    const H = this.doc.v.hist;
    let i = H.length - 1; while (i >= 0 && H[i].role === 'tool') i--;
    const a = H[i];
    if (a && a.tool_calls) {
      const got = new Set(H.slice(i + 1).map(x => x.tool_call_id));
      for (const c of a.tool_calls) if (!got.has(c.id)) H.push({ role: 'tool', tool_call_id: c.id, content: why });
    }
    for (const e of this.doc.v.log) if (e.kind === 'tool' && e.state === 'run') e.state = 'bad';
    this.doc.save();
  }

  /* ---------- управление ---------- */
  submit({ text = '', files = [], parts = [], origin = 'web' }) {
    if (this.running) throw Object.assign(new Error('Мочи ещё работает над прошлой задачей'), { status: 409 });
    text = String(text).slice(0, 100000);
    if (!text.trim() && !files.length) throw Object.assign(new Error('пустое сообщение'), { status: 400 });
    const content = (text.trim() || 'Файлы во вложении.') + (files.length
      ? '\n\n[Пользователь загрузил файлы на сервер:\n' + files.map(f => '- ' + f.path + ' (' + sz(f.size) + ')').join('\n') + ']' : '');
    const m = { role: 'user', content };
    if (parts.length) m._pf = this.saveParts(parts);
    this.doc.v.hist.push(m);
    this.turn++;
    this.trimHist();
    this.push({ kind: 'user', text, origin, files: files.map(f => ({ name: f.name, size: f.size, fid: f.fid || null })) });
    this.start(origin);
  }

  retry(origin = 'web') {
    if (this.running) throw Object.assign(new Error('Мочи уже работает'), { status: 409 });
    const H = this.doc.v.hist, last = H[H.length - 1];
    if (!last || last.role === 'assistant') throw Object.assign(new Error('нечего повторять'), { status: 400 });
    this.start(origin);
  }

  stop() { this.ctl?.abort(); }

  clear() {
    this.gen++;
    this.ctl?.abort(); this.ctl = null; this.partial = '';
    this.seen.clear(); this.phKey = null;
    this.dropParts(this.doc.v.hist);
    Object.assign(this.doc.v, { hist: [], log: [], run: null, sess: rid(16), act: [] });
    this.doc.save();
    this.emit('reset');
    this.emit('run', this.runState());
  }

  async start(origin, resumed) {
    const g = this.gen, ctl = new AbortController();
    this.ctl = ctl; this.partial = '';
    this.doc.v.run = resumed && this.doc.v.run ? this.doc.v.run : { origin, t: Date.now(), steps: 0 };
    this.doc.save();
    const run = this.doc.v.run;
    this.emit('run', this.runState());
    let text = '', err = null;
    try { text = await this.loop(ctl.signal, g); }
    catch (e) { if (!ctl.signal.aborted) err = e; }
    if (g !== this.gen) return; /* чат очистили — старая задача молча уходит */
    if (ctl.signal.aborted && this.partial.trim()) {
      /* остановили посреди ответа — то, что модель успела написать, оставляем */
      this.doc.v.hist.push({ role: 'assistant', content: this.partial });
      this.push({ kind: 'assistant', text: this.partial });
    }
    this.partial = '';
    this.repair(err ? 'Прервано: ' + friendly(err) : 'Прервано пользователем');
    if (err) { console.warn('agent:', this.u.name, err.message); this.push({ kind: 'error', text: friendly(err), detail: err.detail || '', retry: true }); }
    else if (ctl.signal.aborted) this.push({ kind: 'note', text: 'Остановлено' });
    this.doc.v.run = null; this.doc.save();
    this.ctl = null;
    this.emit('run', this.runState());
    this.emit('done', { origin: run.origin, text, err, stopped: ctl.signal.aborted && !err, steps: run.steps, ms: Date.now() - run.t });
  }

  /* подсказка собирается только из того, что сейчас включено: выключенный инструмент не занимает память */
  async system(names, extra = '', webOn = false, offB = []) {
    const S = this.settings(), has = n => names.has(n), dir = userDir(this.u), now = new Date();
    const run = has('run_command'), I = run ? await agentInfo() : null;
    const tgOn = TG_TOOLS.some(t => has(t.function.name));
    const FT = [['read_file', 'читай через read_file'], ['edit_file', 'правь через edit_file'], ['write_file', 'создавай через write_file']].filter(([n]) => has(n)).map(x => x[1]);
    const inst = I?.pm === 'apt-get' ? 'apt-get install -y' : I?.pm === 'apk' ? 'apk add' : I?.pm === 'pacman' ? 'pacman -S --noconfirm' : I?.pm === 'zypper' ? 'zypper -n install' : (I?.pm || 'dnf') + ' install -y';
    /* полный доступ включает администратор (настройки → Сервер → «Доступ агента»); сам агент его не включит */
    const pkg = !run ? '' : I.sudo || I.root
      ? `У тебя полный root-доступ к серверу${I.root ? '' : ': sudo без пароля'}. Системное делай${I.root ? '' : ' через sudo'}: пакеты — ${I.root ? '' : 'sudo '}${inst} …, службы — ${I.root ? '' : 'sudo '}systemctl …; системные файлы (/etc и т. п.) читай и правь файловыми инструментами — когда прав не хватает, они сами работают от root. Ты администратор сервера, но действуй бережно: перед необратимым (удаление чужих данных, переустановка системы, настройки SSH и firewall, из-за которых пропадёт доступ к серверу) спроси пользователя. Службы mochi*, /etc/mochi и /var/lib/mochi/data — это ты сама: не трогай их без прямой просьбы (перезапуск mochi-runner оборвёт твою же команду); обновиться — sudo mochi update.`
      : 'Прав root и sudo нет: системные пакеты ставить нельзя. Инструменты ставь к себе: python3 -m venv ~/venv && ~/venv/bin/pip install …, npm install -g … (префикс ~/.local), бинарники — в ~/.local/bin. Если для задачи нужен root (системные пакеты, службы, /etc), скажи пользователю: полный доступ включает администратор в настройках → Сервер → «Доступ агента» (или на сервере: sudo mochi root on).';
    return S.sys
      + '\n' + FMT
      + `\nСегодня ${now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}, время сервера ${now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}.`
      + (run ? `\nСервер: ${I.os}, ядро ${I.kernel}, ${I.arch}, ${I.cpus || '?'} CPU, ${I.mem || '?'} МБ RAM. Ты работаешь как пользователь ${I.user}. ${pkg} Установлено: ${(I.tools || []).join(', ') || '—'}, node.` : '')
      + `\nРабочая папка пользователя: ${dir} (inbox/ — файлы от пользователя, outbox/ — для файлов пользователю). Задачи выполняются на сервере в фоне: пользователь может закрыть браузер, работа продолжится, а результат он увидит в чате.`
      + ' У пользователя есть вкладка «Файлы» — проводник по серверу с твоими же правами: там он сам открывает, смотрит и правит файлы, поэтому, сделав файл, достаточно назвать путь. Пути в `обратных кавычках` в его сообщении — файлы, выбранные там.'
      + (run ? ' Долгие процессы (серверы, длинные загрузки, сборки дольше часа) запускай в фоне: nohup команда > файл.log 2>&1 & — и проверяй позже. Команды, ждущие ввода, не работают (stdin пустой): используй флаги -y и т. п.' : '')
      + (FT.length ? ` Файлы ${FT.join(', ')}${run ? ' — не через cat, sed, echo > или heredoc в run_command; run_command — для поиска (grep -rn, find), запуска, сборки и git' : ''}.` : '')
      + (has('send_file') ? ' Чтобы отдать файл пользователю, создай его (лучше в outbox/) и вызови send_file; не выводи содержимое файлов текстом вместо этого. Имена с пробелами бери в кавычки.' : '')
      + (webOn ? '\nУ тебя есть поиск в интернете (web_search, web_fetch): используй его для новостей, свежих данных и всего, что могло измениться; на простые вопросы отвечай сразу. Источники называй по имени сайта.' : '')
      + (tgOn ? '\n' + (hooks.tg?.statusLine(this.u) || 'Telegram не подключён.') + ' Если пользователь хочет управлять тобой из Telegram или получать уведомления: попроси создать бота у @BotFather (команда /newbot) и прислать токен, затем вызови telegram_connect и дай пользователю ссылку из ответа.' : '')
      + (offB.length ? '\nВыключено пользователем: ' + offB.join(', ') + '. Включить их может только он сам в настройках — ты не можешь.' : '')
      + extra
      + (this.wire().some(m => Array.isArray(m.content)) ? '\nКартинки и PDF из сообщений пользователя ты видишь напрямую; те же файлы лежат в inbox/, если их нужно обработать.' : '')
      + (has('view_image') ? '\nЧтобы увидеть картинку с сервера (фото, скриншот, график), вызови view_image — не гадай по имени файла и не читай её через read_file.' : '');
  }

  /* ---------- цикл агента ---------- */
  async loop(sig, g) {
    const chk = () => { if (sig.aborted || g !== this.gen) throw abortErr(); };
    const H = this.doc.v.hist, run = this.doc.v.run;
    for (;;) {
      const S = this.settings(), on = t => isOn(S, t.function.name);
      if (S.stepLimit !== false && run.steps >= S.maxSteps) throw new Error('Мочи сделала ' + S.maxSteps + ' шагов подряд и остановилась, чтобы не зациклиться. Нажми «Повторить», чтобы продолжить. Лимит шагов меняется в настройках → Модель.');
      run.steps++;
      const web0 = S.search ? await webTools() : [], web = web0.filter(on); chk();
      const offB = [...builtins(), ...web0, ...MANAGE_TOOLS].filter(t => !on(t)).map(t => t.function.name);
      const X = await agentExt(this, S.tools); chk();
      const tools = [...builtins().filter(on), ...web, ...X.defs], names = new Set(tools.map(t => t.function.name));
      const ctx = { web, X, names };
      const { text, calls } = await this.callModel(await this.system(names, X.prompt, web.length > 0, offB), tools, sig); chk();
      H.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      this.partial = '';
      if (text) this.push({ kind: 'assistant', text });
      this.doc.save();
      if (!calls.length) return text;
      ctx.imgs = [];
      for (const tc of calls) {
        let a = {}, bad = false;
        try { a = JSON.parse(tc.function.arguments || '{}') || {}; } catch { bad = true; }
        if (typeof a !== 'object' || Array.isArray(a)) { a = {}; bad = true; }
        const nm = tc.function.name;
        const e = this.push({ kind: 'tool', name: nm, label: labelFor(nm, a), hint: nm === 'run_command' ? String(a.command || '').slice(0, 2000) : FILE_TOOLS.has(nm) || nm === 'view_image' ? String(a.path || '').slice(0, 500) : '', state: 'run' });
        this.emit('tool', e);
        let out;
        try {
          out = bad ? 'Ошибка: аргументы вызова — невалидный JSON (возможно, обрезаны). Повтори вызов с корректным JSON, длинное содержимое раздели на части.'
            : !ctx.names.has(nm) ? 'Ошибка: инструмента ' + nm + ' сейчас нет (он выключен пользователем или не подключён). Обойдись без него.'
            : await this.tool(nm, a, sig, ctx);
        } catch (x) { if (sig.aborted || g !== this.gen) throw abortErr(); out = 'Ошибка: ' + x.message; }
        if (g !== this.gen) throw abortErr();
        out = String(out);
        e.state = /^Ошибка|\[таймаут|\[прервано|\[не выполнено/.test(out) ? 'bad' : 'ok';
        this.update(e);
        H.push({ role: 'tool', tool_call_id: tc.id, content: out });
        this.doc.save();
        chk();
      }
      if (ctx.imgs.length) {
        H.push({ role: 'user', content: '[Картинки из view_image: ' + ctx.imgs.map(x => x.at).join(', ') + ']', _pf: this.saveParts(ctx.imgs.map(x => x.part)), _vi: 1 });
        this.doc.save();
      }
    }
  }

  async tool(nm, a, sig, { web, X, imgs }) {
    if (nm === 'run_command') {
      if (!a.command) return 'Ошибка: нет параметра command';
      const r = await runCmd({ cmd: String(a.command), cwd: this.doc.v.cwd || userDir(this.u), timeout: a.timeout }, sig);
      if (r.cwd) this.doc.v.cwd = r.cwd;
      const note = r.killed ? '[прервано пользователем]' : r.timedOut ? '[таймаут: команда работала дольше ' + Math.min(Math.max(+a.timeout || 120, 1), 3600) + ' с и была прервана. Повтори с большим timeout или запусти в фоне через nohup]' : '';
      return (r.out || '(нет вывода)') + '\n[код выхода: ' + r.code + ']' + (note ? '\n' + note : '');
    }
    if (FILE_TOOLS.has(nm)) return await this.fileTool(nm, a, sig);
    if (nm === 'view_image') {
      if (this.settings().vis === false || this.noVis >= 2) return 'Ошибка: эта модель не видит картинки (или зрение выключено в настройках) — смотреть нечем. Опиши файл по метаданным (run_command: file, identify) или скажи пользователю, что нужна модель со зрением.';
      if (!String(a.path || '').trim()) return 'Ошибка: нет параметра path';
      if (imgs.length >= 5) return 'Ошибка: за один шаг — не больше 5 картинок; остальные открой следующим шагом';
      const r = await fileCmd({ fop: 'image', path: String(a.path), cwd: this.doc.v.cwd || userDir(this.u) }, sig);
      if (r.err) return 'Ошибка: ' + r.err;
      imgs.push({ at: r.text, part: { type: 'image_url', image_url: { url: 'data:' + r.type + ';base64,' + r.data } } });
      return 'Картинка ' + r.text + ' открыта — она в следующем сообщении.';
    }
    if (nm === 'send_file') {
      const f = await pullFile(a.path, this.doc.v.cwd || userDir(this.u));
      const name = a.name ? String(a.name).replace(/[\\/]/g, '_').slice(0, 120) : f.name;
      const st = await storeFile(this.u, name, f.data);
      const note = a.note ? String(a.note).slice(0, 200) : '';
      this.push({ kind: 'file', fid: st.fid, name: st.name, size: st.size, note });
      this.emit('file', { name: st.name, data: f.data, note });
      return 'Файл «' + st.name + '» (' + sz(st.size) + ') отправлен пользователю: в чате появилась кнопка «Скачать».';
    }
    if (nm.startsWith('telegram_')) {
      if (!hooks.tg) return 'Ошибка: Telegram недоступен на этом сервере';
      return await hooks.tg.tool(this, nm, a);
    }
    if (web.some(t => t.function.name === nm)) return await webCall(nm, a, { signal: sig, session: this.doc.v.sess, model: this.settings().model });
    if (X.route.has(nm)) return await mcpCall(this.u, X.route.get(nm), a, sig);
    if (EXT_TOOLS.has(nm)) return await extTool(this, nm, a);
    return 'Ошибка: неизвестный инструмент ' + nm;
  }

  /* ---------- файлы ---------- */
  remember(real, sig, rng) {
    const S = this.seen, k = S.get(real), v = k && k.sig === sig ? k : { sig, rng: [] };
    if (rng) { v.rng.push([...rng, this.turn]); if (v.rng.length > 20) v.rng.shift(); }
    S.delete(real); S.set(real, v);
    if (S.size > 300) S.delete(S.keys().next().value);
  }

  async fileTool(nm, a, sig) {
    const p = typeof a.path === 'string' ? a.path : '', cwd = this.doc.v.cwd || userDir(this.u);
    if (!p.trim()) return 'Ошибка: нет параметра path';
    if (nm === 'read_file') {
      const r = await fileCmd({ fop: 'read', path: p, cwd, offset: a.offset, limit: a.limit }, sig);
      if (r.err) return 'Ошибка: ' + r.err;
      if (r.sig) {
        /* тот же кусок той же версии файла уже есть выше в разговоре — не тратим токены повторно */
        const k = this.seen.get(r.real);
        if (r.from && k && k.sig === r.sig && k.rng.some(([f, t, turn]) => f <= r.from && r.to <= t && this.turn - turn < 30))
          return `[${p}: файл не менялся с прошлого чтения — строки ${r.from}–${r.to} уже есть выше в разговоре]`;
        this.remember(r.real, r.sig, r.from ? [r.from, r.to] : null);
      }
      return r.text;
    }
    /* заглушку («// ... остальное без изменений») пропускаем, только если модель повторила тот же вызов */
    const key = crypto.createHash('sha1').update(nm + '\0' + JSON.stringify(a)).digest('hex');
    let r;
    if (nm === 'edit_file') {
      let more = a.edits;
      if (typeof more === 'string') try { more = JSON.parse(more); } catch { return 'Ошибка: edits должен быть массивом объектов {old_string, new_string}'; }
      const edits = [];
      if (a.old_string !== undefined || a.new_string !== undefined) edits.push({ old_string: a.old_string, new_string: a.new_string, replace_all: a.replace_all });
      if (Array.isArray(more)) edits.push(...more);
      if (!edits.length) return 'Ошибка: нужны old_string и new_string (или массив edits)';
      if (edits.length > 50) return 'Ошибка: слишком много правок за раз (максимум 50) — раздели на несколько вызовов';
      r = await fileCmd({ fop: 'edit', path: p, cwd, edits, allowPh: this.phKey === key }, sig);
    } else {
      if (typeof a.content !== 'string') return 'Ошибка: нет параметра content (для пустого файла — пустая строка)';
      if (a.content.length > 4e6) return 'Ошибка: слишком большое содержимое для одного вызова — создай файл частями (write_file + edit_file) или командой';
      const q = { fop: 'write', path: p, cwd, content: a.content, allowPh: this.phKey === key };
      r = await fileCmd(q, sig);
      if (r.need) {
        /* непустой файл перезаписываем, только если агент видел именно эту его версию */
        const k = this.seen.get(r.real);
        if (!k) return `Ошибка: ${p} уже существует (${r.lines != null ? 'строк: ' + r.lines + ', ' : ''}${sz(r.size)}), а ты его не читала — перезапись стёрла бы содержимое. Прочитай его через read_file или правь через edit_file.`;
        if (k.sig !== r.sig) return `Ошибка: ${p} изменился после того, как ты его читала (например, командой). Перечитай его через read_file перед перезаписью или правь через edit_file.`;
        r = await fileCmd({ ...q, expect: r.sig }, sig);
        if (r.need) return `Ошибка: ${p} изменился прямо во время записи — перечитай его и повтори.`;
      }
    }
    if (r.ph) this.phKey = key;
    if (r.err) return 'Ошибка: ' + r.err;
    this.phKey = null;
    this.remember(r.real, r.sig, null);
    return r.text;
  }

  async callModel(sys, tools, sig) {
    const S = this.settings();
    for (let attempt = 0; ; attempt++) {
      const msgs = this.wire(), hasM = msgs.some(m => Array.isArray(m.content));
      const h = { 'Content-Type': 'application/json' };
      if (S.key) h.Authorization = 'Bearer ' + S.key;
      /* «тишина» дольше 3 минут — модель зависла */
      const idle = new AbortController();
      let it = setTimeout(() => idle.abort(), 180000);
      const poke = () => { clearTimeout(it); it = setTimeout(() => idle.abort(), 180000); };
      const signal = AbortSignal.any([sig, idle.signal]);
      try {
        const url = S.base.replace(/\/+$/, '') + '/chat/completions';
        const r = await apiFetch(url, { method: 'POST', headers: h, signal,
          body: JSON.stringify({ model: S.model, messages: [{ role: 'system', content: sys }, ...msgs], ...(tools.length ? { tools } : {}), stream: true }) });
        if (!r.ok) {
          const full = await r.text().catch(() => ''), et = full.slice(0, 300);
          /* страница блокировки Cloudflare: ключ ни при чём, повторять бесполезно */
          const cf = cfBlock(r.status, full, r.headers);
          if (cf) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status, cf: cfMessage(cf, url, r.headers), detail: '' });
          if (hasM && [400, 404, 413, 415, 422].includes(r.status) && this.noVis < 2) {
            this.noVis = this.hasPdf() && this.noVis < 1 ? 1 : 2;
            this.push({ kind: 'note', text: this.noVis === 1 ? 'Эта модель не принимает PDF напрямую — отправляю только картинки, а PDF остаётся на сервере.' : 'Эта модель не принимает картинки — отправляю только пути к файлам. Проверь модель в настройках.' });
            continue;
          }
          if ([408, 429, 500, 502, 503, 504, 529].includes(r.status) && attempt < 3) { await sleep([3000, 10000, 30000][attempt], sig); if (sig.aborted) throw abortErr(); continue; }
          throw Object.assign(new Error('HTTP ' + r.status), { status: r.status, detail: et });
        }
        return await this.readReply(r, poke);
      } catch (e) {
        if (sig.aborted) throw abortErr();
        const net = e instanceof TypeError || idle.signal.aborted || e.name === 'AbortError';
        if (net && attempt < 3) { await sleep([3000, 10000, 30000][attempt], sig); if (sig.aborted) throw abortErr(); continue; }
        if (net) throw Object.assign(new Error(idle.signal.aborted ? 'Модель не отвечает уже 3 минуты. Нажми «Повторить».' : 'Не достучалась до модели (' + (e.cause?.code || e.message) + '). Проверь адрес API в настройках.'), { detail: '' });
        throw e;
      } finally { clearTimeout(it); }
    }
  }

  async readReply(r, poke) {
    let text = '', calls = [];
    const apiErr = e => Object.assign(new Error(typeof e === 'string' ? e : (e && e.message) || 'ошибка модели'), { detail: e && typeof e === 'object' ? JSON.stringify(e).slice(0, 300) : '' });
    /* части вызовов инструментов: по index, а если его нет — по id */
    const merge = t => {
      let ix = t.index;
      if (typeof ix !== 'number') { if (t.id) { ix = calls.findIndex(c => c && c.id === t.id); if (ix < 0) ix = calls.length; } else ix = Math.max(0, calls.length - 1); }
      const c = calls[ix] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (t.id) c.id = t.id;
      const fn = t.function || {};
      if (fn.name && c.function.name !== fn.name) c.function.name += fn.name;
      if (fn.arguments != null) c.function.arguments += typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments);
    };
    const delta = d => { text += d; this.partial = text; this.emit('delta', d); };
    if (!(r.headers.get('content-type') || '').includes('event-stream')) {
      const j = await r.json();
      if (j && j.error) throw apiErr(j.error);
      const m = j?.choices?.[0]?.message;
      if (!m) throw new Error('пустой ответ модели');
      if (typeof m.content === 'string' && m.content) delta(m.content);
      calls = Array.isArray(m.tool_calls) ? m.tool_calls.slice() : [];
    } else {
      const dec = new TextDecoder(); let buf = '';
      const lines = ls => {
        for (const l0 of ls) {
          const l = l0.replace(/\r$/, ''); if (!l.startsWith('data:')) continue;
          const p = l.slice(5).trim(); if (!p || p === '[DONE]') continue;
          let j; try { j = JSON.parse(p); } catch { continue; }
          if (j && j.error) throw apiErr(j.error);
          const d = j?.choices?.[0]?.delta; if (!d) continue;
          if (typeof d.content === 'string' && d.content) delta(d.content);
          for (const t of d.tool_calls || []) if (t) merge(t);
        }
      };
      for await (const chunk of r.body) {
        poke();
        buf += dec.decode(chunk, { stream: true });
        const ls = buf.split('\n'); buf = ls.pop(); lines(ls);
      }
      buf += dec.decode(); if (buf) lines([buf]);
    }
    calls = calls.filter(c => c && c.function && c.function.name).map((c, i) => {
      const fn = c.function, ar = fn.arguments;
      return { ...c, type: 'function', id: c.id || 'call_' + Date.now().toString(36) + '_' + i, function: { name: fn.name, arguments: typeof ar === 'string' ? ar : JSON.stringify(ar ?? {}) } };
    });
    if (!text && !calls.length) throw new Error('Модель вернула пустой ответ. Нажми «Повторить» или выбери другую модель в настройках.');
    return { text, calls };
  }

  /* убрать секрет (токен бота) из истории и журнала — он уже сохранён в защищённом месте */
  scrub(secret, repl = '[токен бота сохранён на сервере]') {
    if (!secret) return;
    const fix = s => typeof s === 'string' ? s.split(secret).join(repl) : s;
    for (const m of this.doc.v.hist) {
      m.content = fix(m.content);
      for (const c of m.tool_calls || []) c.function.arguments = fix(c.function.arguments);
    }
    for (const e of this.doc.v.log) { e.text = fix(e.text); e.hint = fix(e.hint); }
    this.doc.save();
  }
}

/* после перезапуска сервера: незаконченные задачи продолжаются */
export function resumeAll(users) {
  for (const u of users) {
    const c = getChat(u), r = c.doc.v.run;
    if (!r) continue;
    c.repair('Прервано: сервер перезапускался. Если команда важна — проверь её результат и при необходимости повтори.');
    if (Date.now() - r.t < 6 * 3600e3) {
      c.push({ kind: 'note', text: 'Сервер перезапускался — продолжаю работу' });
      c.start(r.origin, true);
    } else {
      c.doc.v.run = null; c.doc.save();
      c.push({ kind: 'error', text: 'Работа прервалась: сервер был выключен.', retry: true });
    }
  }
}
