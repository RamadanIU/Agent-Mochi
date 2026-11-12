/* Провайдер Coarena (coarena.ai): Model API — OpenAI-совместимый, ключ coa_… с сайта (coarena.ai/account/api).
   Отличия от обычного OpenAI-совместимого шлюза, из-за которых он и выделен отдельно:
   — все модели думающие, у каждой свой набор уровней размышления (capabilities.efforts в /models): reasoning_effort;
   — размышления приходят в потоке отдельно от ответа (reasoning_content / reasoning / reasoning_details), и их состояние
     нужно вернуть модели в следующем шаге (иначе вызовы инструментов у думающих моделей рвутся);
   — без max_completion_tokens ответ ограничен 8192 токенами, а размышления на высоком уровне съедают их целиком —
     модель «отвечает» пустотой, хотя токены списаны. Поэтому всегда просим потолок (16384);
   — /models открыт всем: ключ проверяем по /limits — заодно видно, сколько из бесплатного дневного лимита осталось;
   — ошибки с кодом (model_api_terms_required, insufficient_quota, concurrency_limit_exceeded…) — объясняем по-человечески. */
import { apiFetch } from './net.js';

export const CO_BASE = 'https://coarena.ai/api/v1';
const api = () => (process.env.PERSONALCOMPUTER_COARENA_URL || CO_BASE).replace(/\/+$/, '');
export const isCoarena = base => {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (process.env.PERSONALCOMPUTER_COARENA_URL && b === api()) return true;
  try { return /(^|\.)coarena\.ai$/i.test(new URL(b).hostname); } catch { return false; }
};
/* куда слать запросы: вписали адрес для Anthropic-клиентов (…/api) или сайт целиком — всё равно OpenAI-путь /api/v1 */
export const apiBase = base => {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (process.env.PERSONALCOMPUTER_COARENA_URL && b === api()) return b;
  try { const u = new URL(b); if (/(^|\.)coarena\.ai$/i.test(u.hostname) && !/\/api\/v1$/.test(u.pathname)) return u.origin + '/api/v1'; } catch {}
  return b;
};
/* ключ вставляют с «Bearer», в кавычках, строкой COARENA_API_KEY=… */
export const parseKey = s => {
  s = String(s || '').trim().replace(/^(export\s+)?COARENA_API_KEY\s*=\s*/i, '').replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
  const m = s.match(/coa_[\w-]+/);
  return (m ? m[0] : s).slice(0, 500);
};

/* уровни: от «не думать» до максимума — по порядку, чтобы выбрать ближайший, если модель такого не знает */
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const EFFORT_NAMES = { none: 'Без размышлений', minimal: 'Минимальный', low: 'Низкий', medium: 'Средний', high: 'Высокий', xhigh: 'Очень высокий', max: 'Максимальный' };
export const MAX_OUT = 16384;

/* каталог моделей: открыт без ключа, кешируем на 10 минут (у сайта лимит 120 запросов в минуту с адреса) */
let cat = null, catAt = 0;
export async function catalog(force) {
  if (cat && !force && Date.now() - catAt < 600e3) return cat;
  const r = await apiFetch(api() + '/models', { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Object.assign(new Error('Coarena: список моделей недоступен (HTTP ' + r.status + ')'), { status: r.status });
  const j = await r.json().catch(() => null);
  const arr = Array.isArray(j?.data) ? j.data : null;
  if (!arr) throw new Error('Coarena: /models ответил не списком моделей');
  if (!arr.length) throw new Error('Coarena: Model API сейчас выключен на сайте (список моделей пуст)');
  cat = arr.filter(m => m && typeof m.id === 'string' && m.lifecycle !== 'retired').map(m => {
    const c = m.capabilities || {};
    return { id: m.id, name: m.display_name || m.id, by: m.owned_by || '', vision: c.vision !== false, tools: c.tools !== false,
      efforts: (Array.isArray(c.efforts) ? c.efforts : []).filter(e => EFFORTS.includes(e)),
      out: +m.max_completion_tokens || +m.max_tokens || MAX_OUT, ctx: +m.context_length || +m.max_input_tokens || 0, aliases: Array.isArray(m.aliases) ? m.aliases : [] };
  });
  catAt = Date.now();
  return cat;
}
export const modelInfo = (id, list = cat) => (list || []).find(m => m.id === id || m.aliases.includes(id)) || null;

/* уровень, который пойдёт в запрос: выбранный, если модель его знает, иначе ближайший из её списка.
   '' — не указывать (модель думает как по умолчанию) */
export function effortFor(want, info) {
  want = String(want || '');
  if (!want || !EFFORTS.includes(want)) return '';
  const list = info?.efforts || [];
  if (!list.length || list.includes(want)) return want;
  /* «без размышлений» у модели, которая не умеет не думать, — самый низкий её уровень */
  const i = EFFORTS.indexOf(want);
  return list.slice().sort((a, b) => Math.abs(EFFORTS.indexOf(a) - i) - Math.abs(EFFORTS.indexOf(b) - i) || EFFORTS.indexOf(a) - EFFORTS.indexOf(b))[0];
}

/* добавка к телу /chat/completions: уровень размышления, потолок ответа, usage в потоке */
export function extra({ model, effort, stream = true }) {
  const info = modelInfo(model), e = effortFor(effort, info);
  return { ...(e ? { reasoning_effort: e } : {}), max_completion_tokens: Math.min(info?.out || MAX_OUT, MAX_OUT), ...(stream ? { stream_options: { include_usage: true } } : {}) };
}

/* ключ и лимиты: GET /limits (подходит ключ с любой из двух областей Model API) */
export async function limits(key) {
  const r = await apiFetch(api() + '/limits', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(human(r.status, j) || 'HTTP ' + r.status), { status: r.status, human: human(r.status, j) });
  const d = j?.data || {}, t = d.today || {};
  const n = x => x == null || x === '' || !Number.isFinite(+x) ? null : +x;
  return { usd: n(d.usd_per_day), used: n(t.used_usd), left: n(t.left_usd), reqs: n(t.requests), resets: t.resets_at || '', rpm: n(d.requests_per_minute_key), conc: n(d.concurrency) };
}

/* проверка в настройках: модели (с уровнями размышления) и, если есть ключ, — подходит ли он и сколько осталось на сегодня */
export async function check(key) {
  const list = await catalog();
  const out = { models: list.map(m => m.id), info: list.map(({ id, name, by, efforts, vision, out }) => ({ id, name, by, efforts, vision, out, think: true })), efforts: EFFORT_NAMES };
  if (!key) return { ...out, needKey: true };
  return { ...out, limits: await limits(key) };
}

/* ошибка Model API → человеческий текст (по коду ошибки из конверта OpenAI) */
export function human(status, j) {
  const e = j && typeof j === 'object' ? j.error || j : {}, code = String(e.code || e.type || ''), msg = String(e.message || '').slice(0, 300);
  const T = {
    invalid_api_key: 'Ключ Coarena не подошёл. Создай новый на coarena.ai/account/api (область inference:write) и вставь его в настройках.',
    api_key_revoked: 'Ключ Coarena отозван. Создай новый на coarena.ai/account/api.',
    api_key_expired: 'Срок ключа Coarena истёк (ключи живут 90 дней). Создай новый на coarena.ai/account/api.',
    insufficient_scope: 'У ключа Coarena нет права вызывать модели. Создай ключ с областью inference:write на coarena.ai/account/api.',
    model_api_terms_required: 'Coarena ждёт, что ты примешь условия Model API: открой coarena.ai/account/api, прими их один раз — и всё заработает.',
    insufficient_quota: 'На сегодня бесплатный лимит Coarena кончился. Он обновится в полночь по UTC; больше можно попросить на coarena.ai/account/api.',
    rate_limit_exceeded: 'Coarena: слишком много запросов в минуту. Подожду и попробую снова.',
    concurrency_limit_exceeded: 'Coarena: одновременно можно только 2 запроса на аккаунт — другой запрос ещё идёт.',
    model_not_found: 'Coarena не знает такую модель. Выбери модель из списка в настройках.',
    model_off: 'Эта модель Coarena сейчас выключена. Выбери другую в настройках.',
    provider_restricted: 'Coarena отключила тебе модели этого разработчика. Выбери модель другой компании.',
    context_length_exceeded: 'Разговор не помещается в модель Coarena (до 128 000 токенов). Начни новый чат.',
    account_blocked: 'Аккаунт Coarena заблокирован.',
    model_api_off: 'Model API на Coarena сейчас выключен.',
    model_api_disabled: 'Model API на Coarena сейчас выключен.',
  };
  return T[code] || (msg ? 'Coarena: ' + msg : '');
}

/* что сказать, если думающая модель так ничего и не ответила */
export function emptyWhy({ finish, reasoning, model, headers }) {
  const real = headers?.get?.('x-coarena-model') || '', sub = headers?.get?.('x-coarena-substituted-to') || '', dropped = headers?.get?.('x-coarena-dropped-params') || '';
  const who = sub ? ' (вместо ' + model + ' ответила ' + sub + ')' : real && real !== model ? ' (ответила ' + real + ')' : '';
  if (finish === 'length') return 'Модель Coarena' + who + ' потратила весь лимит ответа на размышления и не успела ответить. Понизь уровень размышления в настройках → Модель.';
  if (finish === 'content_filter') return 'Coarena: ответ остановил фильтр содержимого' + who + '.';
  return 'Модель Coarena' + who + ' вернула пустой ответ' + (reasoning ? ' (только размышления)' : '') + (dropped ? '; Coarena отбросила параметры: ' + dropped : '') + '. Нажми «Повторить» или выбери другую модель.';
}
