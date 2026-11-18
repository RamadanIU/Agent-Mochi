/* Кэш провайдера: начало запроса к модели не меняется от шага к шагу (нет часов и минут в подсказке, окно истории
   сдвигается порциями), подсказки кэшу — только тем, кто их понимает, попадания в кэш видны в интерфейсе */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeModel, startPersonalComputer, registered, sleep } from './helpers.js';
import { winStart, WIN, WIN_STEP, HIST_MAX, cacheOf, cacheHints, tzName } from '../lib/agent.js';
import { sysHash, dayOf } from '../lib/webchat.js';

test('окно истории: начало стоит на месте 20 сообщений подряд и сдвигается сразу порцией', () => {
  for (let n = 0; n <= WIN; n++) assert.equal(winStart(n), 0);
  const starts = [];
  for (let n = WIN + 1; n <= 200; n++) {
    const k = winStart(n), keep = n - k;
    assert.ok(keep >= WIN && keep < WIN + WIN_STEP, `n=${n}: в окне ${keep}`);
    assert.equal(k % WIN_STEP, 0);
    if (k !== winStart(n - 1)) starts.push(n);
  }
  /* сдвиг — раз в 20 сообщений, а не на каждом */
  assert.deepEqual(starts.slice(0, 3), [WIN + WIN_STEP, WIN + 2 * WIN_STEP, WIN + 3 * WIN_STEP]);
});

test('обрезка истории не сдвигает начало окна: та же переписка уходит модели до и после обрезки', () => {
  /* сообщения пользователя пронумерованы; обрезка — как в trimHist */
  let hist = [], next = 0;
  const window = () => hist.slice(winStart(hist.length));
  for (let i = 0; i < 300; i++) {
    hist.push(next++);
    const before = window()[0];
    if (hist.length > HIST_MAX) hist = hist.slice(winStart(hist.length) - WIN_STEP);
    assert.equal(window()[0], before, `сообщение ${i}: начало окна сдвинулось из-за обрезки`);
    assert.ok(hist.length <= HIST_MAX && (i < WIN || hist.length > WIN));
  }
});

test('cacheOf: попадания в кэш у OpenAI/OpenRouter, DeepSeek, Kimi; нет сведений — null', () => {
  assert.deepEqual(cacheOf({ prompt_tokens: 10339, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 10318, cache_write_tokens: 0 } }), { in: 10339, hit: 10318 });
  assert.deepEqual(cacheOf({ prompt_tokens: 5000, prompt_cache_hit_tokens: 4096, prompt_cache_miss_tokens: 904 }), { in: 5000, hit: 4096 });
  assert.deepEqual(cacheOf({ prompt_tokens: 3000, cached_tokens: 0 }), { in: 3000, hit: 0 });
  assert.deepEqual(cacheOf({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 500 } }), { in: 100, hit: 100 });
  assert.equal(cacheOf({ prompt_tokens: 3000, completion_tokens: 5 }), null);
  assert.equal(cacheOf({ prompt_tokens_details: { cached_tokens: 10 } }), null);
  assert.equal(cacheOf(null), null);
});

test('cacheHints: OpenAI — prompt_cache_key; OpenRouter — session_id, Claude — cache_control, Qwen — метка на подсказке; остальным — ничего', () => {
  const U = { stream_options: { include_usage: true } };
  assert.deepEqual(cacheHints('https://api.openai.com/v1', 'gpt-5', 'pc-k'), { body: { prompt_cache_key: 'pc-k', ...U }, sysMark: false });
  /* DeepSeek API и DashScope кэшируют сами — им нужен только usage в потоке, чтобы было видно попадания */
  assert.deepEqual(cacheHints('https://api.deepseek.com/v1', 'deepseek-chat', 'pc-k'), { body: U, sysMark: false });
  assert.deepEqual(cacheHints('https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen-plus', 'pc-k'), { body: U, sysMark: false });
  assert.deepEqual(cacheHints('https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-5.5', 'pc-k'), { body: { session_id: 'pc-k', cache_control: { type: 'ephemeral' } }, sysMark: false });
  assert.deepEqual(cacheHints('https://openrouter.ai/api/v1', '~anthropic/claude-sonnet-latest', 'pc-k').body.cache_control, { type: 'ephemeral' });
  assert.deepEqual(cacheHints('https://openrouter.ai/api/v1', 'qwen/qwen3-max', 'pc-k'), { body: { session_id: 'pc-k' }, sysMark: true });
  assert.deepEqual(cacheHints('https://openrouter.ai/api/v1', 'deepseek/deepseek-chat', 'pc-k'), { body: { session_id: 'pc-k' }, sysMark: false });
  /* Ollama, свои адреса и т. п. могут не знать этих полей — не шлём */
  for (const b of ['https://ollama.com/v1', 'http://localhost:11434/v1', 'https://evil.example/openrouter.ai', 'not a url'])
    assert.deepEqual(cacheHints(b, 'anthropic/claude', 'pc-k'), { body: {}, sysMark: false }, b);
});

test('часовой пояс и строка даты: без времени, веб-чаты не начинаются заново после обновления', () => {
  assert.match(tzName(), /^(\S+ \()?UTC([+-]\d{1,2}(:\d\d)?)?\)?$/);
  const tools = [{ function: { name: 'run_command', description: 'x', parameters: {} } }];
  const old = 'Ты помощник.\nСегодня 18 ноября 2026 г., время сервера 14:37.\nРабочая папка: /w';
  const neu = 'Ты помощник.\nСегодня 18 ноября 2026 г., часовой пояс сервера Europe/Moscow (UTC+3). Точное время — команда date.\nРабочая папка: /w';
  const nextDay = neu.replace('18 ноября', '19 ноября');
  assert.equal(sysHash(neu, tools), sysHash(old, tools), 'хэш инструкции тот же, что у прежней подсказки со временем');
  assert.equal(sysHash(nextDay, tools), sysHash(neu, tools), 'смена дня не повод для нового чата на сайте');
  assert.notEqual(sysHash(neu.replace('/w', '/x'), tools), sysHash(neu, tools));
  assert.equal(dayOf(neu), '18 ноября 2026 г.');
});

let m, model;
before(async () => {
  model = await fakeModel(async (body) => {
    const last = body.messages[body.messages.length - 1];
    if (last.role === 'user') return { tools: [{ name: 'run_command', args: { action: 'Смотрю', command: 'true' } }], usage: { prompt_tokens: 4000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } } };
    return { text: 'готово', usage: { prompt_tokens: 4100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 3968 } } };
  });
  m = await startPersonalComputer();
});
after(async () => { await m?.stop(); model?.close(); });

test('подсказка без часов и минут и одинакова на всех шагах; попадания в кэш — в событиях и снимке', async () => {
  const c = await registered(m, 'cacher');
  await c.json('/api/settings', { base: model.url, model: 'fake-1' }, 'PUT');
  const p = c.events(e => e.some(x => x.ev === 'run' && x.d.running === false));
  await sleep(200);
  await c.json('/api/chat', { text: 'проверь' });
  const evs = await p;
  const sys = model.calls.map(x => x.body.messages[0]);
  assert.ok(sys.length >= 2);
  for (const s of sys) {
    assert.equal(s.role, 'system');
    assert.equal(typeof s.content, 'string');
    assert.doesNotMatch(s.content, /\b\d\d:\d\d\b/, 'в подсказке нет времени');
    assert.match(s.content, /\nСегодня [^\n,]+, часовой пояс сервера [^\n]+\. Точное время — команда date\./);
  }
  assert.ok(sys.every(s => s.content === sys[0].content), 'подсказка — одна и та же на всех шагах');
  /* локальный адрес — подсказок кэшу нет */
  for (const x of model.calls) for (const k of ['prompt_cache_key', 'session_id', 'cache_control']) assert.ok(!(k in x.body), k);
  const ctx = evs.filter(e => e.ev === 'ctx').map(e => e.d);
  assert.deepEqual(ctx.at(-1).cache, { in: 4100, hit: 3968 });
  const snap = (await (await c.events(e => e.some(x => x.ev === 'snap')))).find(e => e.ev === 'snap').d;
  assert.deepEqual(snap.cache, { in: 4100, hit: 3968 });
  await c.json('/api/chat/clear');
  const s2 = (await c.events(e => e.some(x => x.ev === 'snap'))).find(e => e.ev === 'snap').d;
  assert.equal(s2.cache, undefined, 'новый чат — без сведений о кэше');
});
