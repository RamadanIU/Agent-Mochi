/* Субагенты: главный агент (оркестратор) поручает подзадачу отдельному агентному циклу с чистым контекстом.
   ─ Субагент — тот же цикл, что у главного агента (Chat.step: модель → инструменты → модель…), но со своим состоянием:
     история начинается с поручения (task), системная подсказка — своя (SUB_SYS + role_prompt), журнал и поток ответа
     наружу не уходят. Переписки с пользователем он не видит.
   ─ Провайдер и модель — свои: из аргументов вызова, из настроек пользователя (subProvider / subModel) или как у главного.
   ─ Инструменты — все включённые у главного агента, кроме инструментов субагентов (глубина не больше MAX_DEPTH = 1).
   ─ Любой исход — структурированный JSON для оркестратора (status, provider_used, model_used, steps_taken, tools_called,
     report, error): ни ошибка API, ни таймаут, ни сбой инструмента не роняют цикл главного агента.
   Модуль не импортирует agent.js (иначе кольцо): что нужно от чата, приходит параметрами. */
import { rid } from './store.js';
import { isQwen, QWEN_BASE } from './qwen.js';
import { isDeepSeek, DS_BASE } from './deepseek.js';
import * as KR from './kiro.js';
import * as AG from './antigravity.js';
import * as CO from './coarena.js';

export const MAX_DEPTH = 1;
export const SUB_TOOL_NAMES = new Set(['spawn_subagent', 'list_subagent_models']);
export const DEF_SUB_STEPS = 30, MAX_SUB_STEPS = 500;
/* потолок всей работы субагента: дольше — status: timeout (в тестах — переменной окружения) */
const timeoutMs = () => Math.max(1000, +process.env.PERSONALCOMPUTER_SUB_TIMEOUT_MS || 30 * 60e3);
/* отчёт в историю главного агента — не больше этого (остальное субагент пусть кладёт в файл) */
const REPORT_MAX = 40000;

/* ---------- подсказки ---------- */
export const SUB_SYS = 'Ты — автономный субагент-исполнитель Personal Computer. У тебя чистый контекст: переписку с пользователем ты не видишь, '
  + 'есть только поручение от оркестратора (главного агента) — оно в первом сообщении. Выполни его сам и до конца, используя инструменты. '
  + 'Пользователю ты не пишешь и вопросов не задаёшь: не хватает данных — сделай разумное допущение и отметь его в отчёте. '
  + 'Делай строго то, что поручено, ничего сверх этого. Проверяй факты инструментами, а не угадывай.\n'
  + 'Последнее сообщение (без вызовов инструментов) — отчёт оркестратору: чёткий, структурированный и исчерпывающий, без воды и вежливостей. Формат:\n'
  + '1. Итог — одной-двумя фразами: выполнено ли поручение.\n'
  + '2. Результаты — факты, данные, найденное; пути к созданным и изменённым файлам; команды, если они важны для проверки.\n'
  + '3. Что сделано — ключевые шаги, коротко.\n'
  + '4. Проблемы и допущения — что не удалось и почему, что осталось сделать.\n'
  + 'Большие данные (длинные таблицы, логи, код) сохраняй в файл и давай путь. Отвечай на языке поручения.';
/* абзац для главного агента: собирается из того, какие инструменты субагентов включены */
export function orchestratorPrompt(has) {
  if (!has('spawn_subagent')) return '';
  return '\nСубагенты: объёмную, изолированную или исследовательскую подзадачу (поиск и сводка по многим источникам, разбор большого кода или логов, независимая часть работы) поручай spawn_subagent — он выполнит её в чистом контексте теми же инструментами и вернёт отчёт, не засоряя этот разговор. Мелкое и быстрое делай сама.'
    + ' Субагент не видит переписку: в task пиши самодостаточное задание — цель, все вводные (пути, ссылки, данные, ограничения), что считать готовым и что вернуть в отчёте.'
    + ' provider и model обычно не указывай — возьмутся настройки пользователя' + (has('list_subagent_models') ? '; другая модель под задачу или после сбоя — сначала узнай доступные через list_subagent_models.' : '.')
    + ' Ответ spawn_subagent — JSON: status completed — опирайся на report; error, timeout или max_steps_exceeded — прочитай error и частичный report, затем реши сама: повторить с исправленным task, сменить модель или провайдера, увеличить max_steps или доделать без субагента.'
    + ' Пользователю пересказывай итог, а не сырой отчёт. Субагенты не могут звать субагентов.';
}

/* ---------- инструменты для главного агента ---------- */
export const LIST_TOOL = { type: 'function', function: { name: 'list_subagent_models', description: 'Узнать, какие провайдеры и модели сейчас доступны для субагентов: провайдер и модель по умолчанию из настроек пользователя, у каждого провайдера — настроен ли он (available, причина, если нет) и его модели (id, name, tool_calling, context, tags). Вызывай перед spawn_subagent, если нужна другая модель или прошлая вернула ошибку.',
  parameters: { type: 'object', properties: {
    provider: { type: 'string', description: 'Только этот провайдер: id (openai, openrouter, kiro…), имя или адрес API' },
    refresh: { type: 'boolean', description: 'true — заново запросить списки моделей у провайдеров' } } } } };
export const SPAWN_TOOL = { type: 'function', function: { name: 'spawn_subagent', description: 'Поручить подзадачу субагенту: он работает автономно в чистом контексте (без этой переписки) с теми же инструментами и возвращает JSON-отчёт {status, provider_used, model_used, steps_taken, tools_called, report, error}. Для объёмных, изолированных или исследовательских задач.',
  parameters: { type: 'object', properties: {
    task: { type: 'string', description: 'Полное самодостаточное задание: цель, все вводные данные (пути, ссылки, факты, ограничения), критерий готовности и что вернуть в отчёте. Субагент не знает ничего из этого разговора.' },
    role_prompt: { type: 'string', description: 'Специализация субагента, дополняет его системную подсказку (например: «Ты узкоспециализированный парсер логов nginx»)' },
    provider: { type: 'string', description: 'Провайдер (id из list_subagent_models). Не указан — из настроек пользователя или как у главного агента' },
    model: { type: 'string', description: 'Модель (id из list_subagent_models). Не указана — из настроек пользователя или как у главного агента' },
    max_steps: { type: 'integer', description: 'Сколько шагов (вызовов модели) субагенту можно сделать; по умолчанию — из настроек пользователя' } }, required: ['task'] } } };
export const SUB_TOOLS = [LIST_TOOL, SPAWN_TOOL];

/* ---------- провайдеры ----------
   Те же, что в настройках → Модель (PRESETS в index.html); свои адреса («Другой») — из сохранённых провайдеров пользователя */
export const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1' },
  { id: 'coarena', name: 'Coarena', base: 'https://coarena.ai/api/v1' },
  { id: 'qwen', name: 'Qwen (chat.qwen.ai)', base: QWEN_BASE },
  { id: 'deepseek', name: 'DeepSeek (chat.deepseek.com)', base: DS_BASE },
  { id: 'kiro', name: 'Kiro (kiro.dev)', base: KR.KR_BASE },
  { id: 'antigravity', name: 'Antigravity (Google)', base: AG.AG_BASE },
  { id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1' },
  { id: 'ollama-cloud', name: 'Ollama Cloud', base: 'https://ollama.com/v1' },
  { id: 'justwoker', name: 'JustWoker', base: 'https://api.justwoker.icu/v1' },
  { id: 'lmstudio', name: 'LM Studio', base: 'http://localhost:1234/v1' },
];
export const normBase = x => String(x || '').trim().replace(/\/+$/, '');
const hostOf = b => { try { return new URL(b).hostname.toLowerCase(); } catch { return ''; } };
/* свой сервер в локальной сети — ключ не нужен (Ollama, LM Studio, vLLM) */
const isLocal = b => /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local|host\.docker\.internal)$/.test(hostOf(b));
const provsOf = S => S.provs && typeof S.provs === 'object' && !Array.isArray(S.provs) ? S.provs : {};
const known = base => PROVIDERS.find(p => p.base === base) || PROVIDERS.find(p => p.id === 'qwen' && isQwen(base)) || PROVIDERS.find(p => p.id === 'deepseek' && isDeepSeek(base))
  || PROVIDERS.find(p => p.id === 'kiro' && KR.isKiro(base)) || PROVIDERS.find(p => p.id === 'antigravity' && AG.isAntigravity(base)) || PROVIDERS.find(p => p.id === 'coarena' && CO.isCoarena(base));
/* провайдер по адресу: известный — со своим id и именем, свой — «custom:хост» */
export function provOf(base) {
  base = normBase(base);
  const k = known(base);
  if (k) return { ...k, base };
  let h = base; try { h = new URL(base).host.toLowerCase(); } catch {}
  return { id: 'custom:' + h, name: h, base };
}
/* все, что можно выбрать: известные + сохранённые свои + активный главного агента */
export function allProviders(S) {
  const out = PROVIDERS.map(p => ({ ...p })), seen = new Set(out.map(p => p.base));
  for (const b of [S.base, ...Object.keys(provsOf(S))].map(normBase)) {
    if (!b || seen.has(b) || out.some(p => p.id === provOf(b).id)) continue;
    seen.add(b); out.push(provOf(b));
  }
  return out;
}
/* провайдер по тому, как его назвал агент или пользователь: id, имя, адрес API или хост */
export function findProvider(S, q) {
  q = String(q || '').trim();
  if (!q) return null;
  const all = allProviders(S), l = q.toLowerCase(), b = normBase(q);
  return all.find(p => p.id === l) || all.find(p => p.name.toLowerCase() === l) || all.find(p => p.base === b)
    || (/^https?:\/\//i.test(b) ? provOf(b) : null)
    || all.find(p => hostOf(p.base) === l) || all.find(p => p.name.toLowerCase().split(/[\s(]/)[0] === l) || null;
}
/* ключ провайдера: у активного — текущий, у остальных — сохранённый */
export const keyOf = (S, base) => normBase(base) === normBase(S.base) ? S.key || '' : provsOf(S)[normBase(base)]?.key || '';
/* настроен ли провайдер, а если нет — почему (по-человечески, с тем, где это исправить) */
export function availability(S, base) {
  base = normBase(base);
  const P = provsOf(S), saved = !!P[base] || base === normBase(S.base), key = keyOf(S, base);
  if (KR.isKiro(base)) return key ? { available: true } : { available: false, reason: 'нет входа в Kiro — пользователь входит в настройках → Модель → Kiro' };
  if (AG.isAntigravity(base)) return key ? { available: true } : { available: false, reason: 'нет входа в Antigravity — пользователь входит в настройках → Модель → Antigravity' };
  if (isQwen(base)) return key || S.qwAuth ? { available: true } : { available: false, reason: 'нет токена Qwen — пользователь подключает аккаунт в настройках → Модель' };
  if (isDeepSeek(base)) return key || S.dsAuth ? { available: true } : { available: false, reason: 'нет токена DeepSeek — пользователь подключает аккаунт в настройках → Модель' };
  if (key) return { available: true };
  if (saved && (isLocal(base) || base === normBase(S.base))) return { available: true };
  return { available: false, reason: saved ? 'нет API-ключа — пользователь сохраняет его в настройках → Модель' : 'провайдер не настроен: нет API-ключа (настройки → Модель)' };
}

/* ---------- модели ----------
   Списки моделей — у сервера (models в server.js: свой путь у Qwen, DeepSeek, Kiro, Antigravity, Coarena, OpenRouter).
   Помним их 15 минут на пользователя и провайдера; refresh — спросить заново */
const CACHE_MS = 15 * 60e3, cache = new Map();
const ckey = (u, base) => u.id + '|' + base;
export const cachedModels = (u, base) => cache.get(ckey(u, base))?.list || null;
function modelRow(id, info, base, S) {
  const i = info || {}, tags = [];
  if (i.think) tags.push('reasoning');
  if (i.img || i.vision) tags.push('vision');
  if (/:free$/i.test(id)) tags.push('free');
  if (i.rec) tags.push('recommended');
  if (i.q === 0) tags.push('limit-exhausted');
  if (normBase(base) === normBase(S.base) && id === S.model) tags.push('main-agent');
  /* свои адаптеры (Kiro, Antigravity, Qwen, DeepSeek, Coarena) сами переводят инструменты; OpenRouter отдаёт только модели с tools */
  const tc = typeof i.tools === 'boolean' ? i.tools : KR.isKiro(base) || AG.isAntigravity(base) || isQwen(base) || isDeepSeek(base) || CO.isCoarena(base) || /openrouter\.ai/.test(base) ? true : null;
  return { id, name: String(i.name || id).slice(0, 80), tool_calling: tc, context: +i.ctx || +i.context || null, ...(tags.length ? { tags } : {}) };
}
async function fetchModels(chat, base, modelsFn) {
  const r = await Promise.race([modelsFn(chat, base), new Promise((_, no) => setTimeout(() => no(new Error('провайдер не ответил за 20 с')), 20000).unref?.())]);
  const info = new Map((r?.info || r?.qwen || []).filter(x => x && x.id).map(x => [x.id, x]));
  const ids = (r?.models || []).filter(x => typeof x === 'string' && x);
  const list = ids.map(id => ({ id, info: info.get(id) || null }));
  cache.set(ckey(chat.u, base), { at: Date.now(), list });
  return list;
}

/* list_subagent_models (и окно настроек): провайдеры, их доступность и модели.
   fetch — спрашивать у провайдеров списки (у доступных, если в памяти нет свежего); refresh — спрашивать в любом случае */
export async function listModels(chat, a = {}, modelsFn, { fetch = true } = {}) {
  const S = chat.settings(), P = provsOf(S), refresh = a.refresh === true || a.refresh === 'true';
  const d = defaults(S);
  let provs = allProviders(S);
  if (a.provider) {
    const p = findProvider(S, a.provider);
    if (!p) return { error: 'Нет провайдера «' + String(a.provider).slice(0, 80) + '». Есть: ' + provs.map(x => x.id).join(', '), default_provider: d.provider.id, default_model: d.model };
    provs = [p];
  }
  const one = provs.length === 1, cap = one ? 500 : 150;
  const rows = await Promise.all(provs.map(async p => {
    const av = availability(S, p.base), c = cache.get(ckey(chat.u, p.base));
    let list = c?.list || null, err = '';
    const stale = !c || Date.now() - c.at > CACHE_MS;
    if (av.available && modelsFn && fetch && (refresh || stale)) {
      try { list = await fetchModels(chat, p.base, modelsFn); }
      catch (e) { err = String(e.message || e).slice(0, 300); }
    }
    /* модель, сохранённая для провайдера, есть всегда — даже если список не пришёл */
    const saved = P[p.base]?.model || (p.base === normBase(S.base) ? S.model : '');
    const all = list ? list.slice() : [];
    if (saved && !all.some(m => m.id === saved)) all.unshift({ id: saved, info: null });
    const models = all.slice(0, cap).map(m => modelRow(m.id, m.info, p.base, S));
    return { id: p.id, name: p.name, base: p.base, available: av.available, ...(av.reason ? { reason: av.reason } : {}),
      main: p.base === normBase(S.base), ...(saved ? { saved_model: saved } : {}), models, ...(all.length > cap ? { models_total: all.length, models_note: 'показаны первые ' + cap + ' — вызови с provider, чтобы увидеть больше' } : {}),
      ...(err ? { models_error: err } : !list && av.available ? { models_note: 'список моделей не запрашивался — refresh: true' } : {}) };
  }));
  return { default_provider: d.provider.id, default_model: d.model || null, default_max_steps: d.steps,
    main_agent: { provider: provOf(S.base).id, model: S.model },
    settings: { provider: S.subProvider ? provOf(S.subProvider).id : 'inherit', model: S.subModel || 'inherit' }, providers: rows };
}

/* что возьмёт субагент без аргументов: настройки пользователя → как у главного агента */
export function defaults(S) {
  const pb = normBase(S.subProvider) || normBase(S.base), provider = provOf(pb);
  let model = String(S.subModel || '').trim();
  if (!model) model = pb === normBase(S.base) ? S.model : provsOf(S)[pb]?.model || '';
  const st = Math.round(+S.subMaxSteps);
  return { provider, model, steps: st >= 1 && st <= MAX_SUB_STEPS ? st : DEF_SUB_STEPS };
}

/* ---------- ошибки → для оркестратора ---------- */
function errType(e) {
  const s = +e.status || 0;
  if (e.name === 'AbortError') return 'cancelled';
  if (e.captcha) return 'captcha';
  if (e.cf) return 'blocked_by_cloudflare';
  if (e.auth || e.relogin || s === 401 || s === 403) return 'auth';
  if (s === 402) return 'billing';
  if (s === 404) return 'model_or_endpoint_not_found';
  if (s === 408) return 'timeout';
  if (s === 429) return 'rate_limit';
  if (s >= 500) return 'provider_error';
  if (s >= 400) return 'bad_request';
  if (e instanceof TypeError || /Не достучался|не отвечает/.test(e.message || '')) return 'network';
  return 'error';
}
const oneLine = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/* ---------- запуск ----------
   chat — чат главного агента; a — аргументы spawn_subagent; sig — сигнал шага главного агента («Стоп», «Прочитать сейчас»).
   friendly — как объяснить ошибку модели (agent.js); progress(ev) — для питомца: start, step, end */
export async function runSubagent(chat, a, sig, { friendly = e => e.message, progress = () => {} } = {}) {
  const t0 = Date.now(), S = chat.settings(), d = defaults(S);
  const out = (status, x) => ({ status, provider_used: x.provider || null, model_used: x.model || null, steps_taken: x.steps || 0, tools_called: x.tools || [], report: x.report || '', error: x.error || null, duration_ms: Date.now() - t0 });
  const fail = (type, message, x = {}) => out('error', { ...x, error: { type, message, step: x.steps || 0 } });

  /* защита от рекурсии: субагент не зовёт субагентов */
  if ((chat.depth || 0) >= MAX_DEPTH) return fail('recursion_blocked', 'Субагент не может запускать субагентов (максимальная глубина — ' + MAX_DEPTH + '). Выполни задачу сам.');
  const task = typeof a.task === 'string' ? a.task.trim() : '';
  if (!task) return fail('invalid_arguments', 'Нет task: передай полное самодостаточное задание для субагента.');

  /* провайдер и модель: аргументы → настройки пользователя → как у главного агента */
  let prov = d.provider, model = '';
  if (a.provider !== undefined && String(a.provider).trim()) {
    prov = findProvider(S, a.provider);
    if (!prov) return fail('provider_not_found', 'Нет провайдера «' + oneLine(a.provider, 80) + '». Доступные id — в list_subagent_models.', {});
  }
  const fromArgs = prov.base !== d.provider.base;
  if (typeof a.model === 'string' && a.model.trim()) model = a.model.trim().slice(0, 200);
  else if (!fromArgs) model = d.model;
  else model = provsOf(S)[prov.base]?.model || (prov.base === normBase(S.base) ? S.model : '') || cachedModels(chat.u, prov.base)?.[0]?.id || '';
  const who = { provider: prov.id, model };
  const av = availability(S, prov.base);
  if (!av.available) return fail('provider_unavailable', prov.name + ' недоступен: ' + av.reason + '. Выбери другой провайдер (list_subagent_models).', who);
  if (!model) return fail('model_required', 'Для ' + prov.name + ' не выбрана модель — укажи model (см. list_subagent_models).', who);
  let max = a.max_steps === undefined || a.max_steps === null || a.max_steps === '' ? d.steps : Math.round(+a.max_steps);
  if (!(max >= 1)) max = d.steps;
  max = Math.min(max, MAX_SUB_STEPS);

  /* изолированный агент: прототип — чат главного (методы цикла, ключи и входы провайдеров, пользователь, MCP),
     а всё состояние разговора — своё. Журнал и поток ответа не уходят в чат; наружу — только файлы для пользователя */
  const base = prov.base, same = base === normBase(S.base);
  const hist = [{ role: 'user', content: task }];
  const sub = Object.create(chat);
  const tools = new Set(), log = [], x = { tool: null };
  Object.assign(sub, {
    depth: (chat.depth || 0) + 1, parent: chat,
    cid: chat.cid + '~sub-' + rid(4),
    doc: { v: { hist, log, th: [], seq: 0, cwd: chat.doc.v.cwd || null, act: [...(chat.doc.v.act || [])], sess: chat.doc.v.sess, ctx: 0 }, save() {}, flush() {}, drop() {} },
    partial: '', noVis: 0, gen: 0, turn: 1, phKey: null, chk: null, stepCtl: null, ctl: null, noTools: false,
    seen: new Map(),
    /* настройки: провайдер, модель и подсказка субагента; ключ — живой (Kiro и Antigravity обновляют его по ходу) */
    settings() {
      const P = chat.settings();
      return { ...P, base, key: keyOf(P, base), model, stepLimit: false,
        sys: SUB_SYS + (typeof a.role_prompt === 'string' && a.role_prompt.trim() ? '\nТвоя специализация: ' + a.role_prompt.trim().slice(0, 4000) : ''),
        think: same ? P.think : false, effort: same ? P.effort : '' };
    },
    /* наружу — только файл для пользователя (карточка в чате и Telegram); остальное — во внутренний журнал */
    emit(ev, ...x) { return ev === 'file' ? chat.emit(ev, ...x) : false; },
    push(e) {
      if (e.kind === 'file') return chat.push(e);
      e = { ...e, seq: ++this.doc.v.seq, t: Date.now() };
      log.push(e);
      if (e.kind === 'tool') { tools.add(e.name); x.tool = e.name; }
      return e;
    },
    update(e) { e.u = Date.now(); },
    /* секрет из инструмента (токен бота, ключ MCP) — вычистить и у главного: он мог быть в поручении */
    scrub(s, r) { Object.getPrototypeOf(chat).scrub.call(this, s, r); chat.scrub(s, r); },
    /* проверку «я не робот» субагент не ждёт: это решает пользователь в главном чате */
    async waitCheck(e) { throw Object.assign(e, { human: (e.human || 'Сайт попросил проверку «я не робот»') + ' — субагент не может ждать проверку.' }); },
  });

  const run = { steps: 0, t: t0 };
  const tmo = new AbortController(), tt = setTimeout(() => tmo.abort(), timeoutMs());
  tt.unref?.();
  const signal = AbortSignal.any([sig, tmo.signal]);
  const info = { provider: prov.id, providerName: prov.name, model, max };
  progress({ phase: 'start', ...info, step: 0 });
  const assistantText = () => hist.filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()).map(m => m.content.trim());
  const cap = s => s.length > REPORT_MAX ? s.slice(0, REPORT_MAX) + '\n…[отчёт обрезан: ' + s.length + ' символов]' : s;
  /* частичный результат: что субагент успел написать + последние шаги с итогом */
  const partial = () => {
    const said = assistantText().slice(-3).join('\n\n');
    const steps = log.filter(e => e.kind === 'tool').slice(-8).map(e => '- ' + e.name + ': ' + (e.label || '') + (e.state === 'bad' ? ' — сбой' + (e.tail ? ': ' + e.tail : '') : ''));
    return cap([said, steps.length ? 'Последние шаги субагента:\n' + steps.join('\n') : ''].filter(Boolean).join('\n\n'));
  };
  const done = (status, extra = {}) => {
    const r = out(status, { ...who, steps: run.steps, tools: [...tools], ...extra });
    progress({ phase: status === 'completed' ? 'end' : 'error', ...info, step: run.steps, status, ...(r.error ? { type: r.error.type, error: oneLine(r.error.message, 160) } : {}) });
    return r;
  };

  try {
    let text = null;
    while (run.steps < max) {
      x.tool = null;
      text = await sub.step(signal, 0, hist, run, false);
      progress({ phase: 'step', ...info, step: run.steps, tool: x.tool });
      if (text !== null) break;
    }
    if (text !== null) {
      const report = cap(String(text).trim()) || partial() || '(субагент закончил без текста отчёта)';
      return done('completed', { report });
    }
    /* шаги кончились, а работа — нет: одна попытка получить отчёт о сделанном (инструменты уже не выполняются) */
    let report = '';
    try {
      hist.push({ role: 'user', content: '[Лимит шагов исчерпан: ' + max + '] Инструменты больше недоступны — не вызывай их. Сразу напиши итоговый отчёт в обычном формате: что сделано, что найдено, что не успел и что осталось.' });
      sub.noTools = true;
      const t = await sub.step(signal, 0, hist, run, false);
      report = String(t || '').trim();
    } catch (e) { if (sig.aborted) throw e; }
    return done('max_steps_exceeded', { report: cap(report) || partial(), error: { type: 'max_steps_exceeded', message: 'Субагент сделал ' + max + ' шагов и не закончил. Можно повторить с большим max_steps, разбить задачу или продолжить по частичному отчёту.', step: run.steps, ...(x.tool ? { tool: x.tool } : {}) } });
  } catch (e) {
    if (tmo.signal.aborted && !sig.aborted) {
      return done('timeout', { report: partial(), error: { type: 'timeout', message: 'Субагент не уложился в ' + Math.round(timeoutMs() / 60000 * 10) / 10 + ' мин и был остановлен.', step: run.steps, ...(x.tool ? { tool: x.tool } : {}) } });
    }
    const type = sig.aborted ? 'cancelled' : errType(e);
    return done('error', { report: partial(), error: {
      type, message: type === 'cancelled' ? 'Остановлено пользователем.' : friendly(e),
      ...(e.detail ? { provider_message: oneLine(e.detail, 500) } : {}), ...(e.status ? { http_status: e.status } : {}),
      step: run.steps, ...(x.tool ? { tool: x.tool } : {}) } });
  } finally {
    clearTimeout(tt);
    /* картинки view_image субагента лежали рядом с вложениями чата — больше не нужны */
    try { chat.dropParts(hist); } catch {}
  }
}
