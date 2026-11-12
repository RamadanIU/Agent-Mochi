/* Провайдер Coarena: фальшивый Model API (/models с уровнями размышления, /limits, /chat/completions с размышлениями в потоке) */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startPersonalComputer, registered } from './helpers.js';
import { parseKey, effortFor, apiBase, isCoarena } from '../lib/coarena.js';

const KEY = 'coa_test_' + 'k'.repeat(30);
const MODELS = [
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', max_completion_tokens: 16384, capabilities: { vision: true, tools: true, reasoning_text: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }, aliases: [] },
  { id: 'kimi-k3', display_name: 'Kimi K3', max_completion_tokens: 16384, capabilities: { vision: true, tools: true, reasoning_text: true, efforts: ['none', 'minimal', 'low', 'medium', 'high'] }, aliases: [] },
];
let m, srv, base;
const calls = [];
let script = [];

before(async () => {
  srv = http.createServer(async (q, s) => {
    let b = ''; for await (const c of q) b += c;
    const json = (st, j, h = {}) => { s.writeHead(st, { 'content-type': 'application/json', ...h }); s.end(JSON.stringify(j)); };
    if (q.url.endsWith('/models')) return json(200, { object: 'list', data: MODELS });
    if (q.url.endsWith('/limits')) {
      if (q.headers.authorization !== 'Bearer ' + KEY) return json(401, { error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } });
      return json(200, { data: { free: true, usd_per_day: 5, requests_per_minute_key: 30, concurrency: 2, today: { used_usd: 1.25, left_usd: 3.75, requests: 7 } } });
    }
    if (!q.url.endsWith('/chat/completions')) return json(404, { error: { message: 'nope' } });
    const body = JSON.parse(b || '{}');
    /* название чата: без потока — в сценарий не попадает */
    if (body.stream === false) return json(200, { choices: [{ message: { role: 'assistant', content: 'Тест', reasoning_content: 'думаю о названии' }, finish_reason: 'stop' }] });
    calls.push({ body, auth: q.headers.authorization });
    const step = script.shift() || { text: 'конец' };
    if (step.err) return json(step.err, { error: { message: step.msg || 'x', code: step.code } });
    s.writeHead(200, { 'content-type': 'text/event-stream', 'x-coarena-model': body.model });
    const ev = (d, fin) => s.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: fin || null }] }) + '\n\n');
    s.write('\n');
    /* как у шлюзов: тот же кусок размышлений сразу в двух полях */
    for (const w of (step.think || '').match(/.{1,6}/gs) || []) ev(step.both ? { reasoning_content: w, reasoning: w } : { reasoning_content: w });
    if (step.details) ev({ reasoning_details: step.details });
    for (const w of (step.text || '').match(/.{1,6}/gs) || []) ev({ content: w });
    (step.tools || []).forEach((t, i) => ev({ tool_calls: [{ index: i, id: 'call_' + i, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } }] }));
    ev({}, step.finish || (step.tools ? 'tool_calls' : 'stop'));
    s.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } }) + '\n\n');
    s.end('data: [DONE]\n\n');
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  base = 'http://127.0.0.1:' + srv.address().port + '/api/v1';
  m = await startPersonalComputer({ PERSONALCOMPUTER_COARENA_URL: base });
});
after(async () => { await m?.stop(); srv?.close(); });

const errs = evs => evs.flatMap(e => e.ev === 'log' ? [e.d] : e.ev === 'snap' ? e.d.log : []);
const logOf = evs => errs(evs);

test('ключ вставляют как попало — храним только coa_…', () => {
  assert.equal(parseKey('Bearer ' + KEY), KEY);
  assert.equal(parseKey('export COARENA_API_KEY="' + KEY + '"'), KEY);
  assert.equal(apiBase('https://coarena.ai/api'), 'https://coarena.ai/api/v1');
  assert.equal(apiBase('https://coarena.ai'), 'https://coarena.ai/api/v1');
  assert.ok(isCoarena('https://coarena.ai/api/v1') && !isCoarena('https://api.openai.com/v1'));
});

test('уровень размышления: нет у модели — ближайший из её списка', () => {
  const claude = { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }, kimi = { efforts: ['none', 'minimal', 'low', 'medium', 'high'] };
  assert.equal(effortFor('none', claude), 'low');
  assert.equal(effortFor('max', kimi), 'high');
  assert.equal(effortFor('medium', kimi), 'medium');
  assert.equal(effortFor('', kimi), '');
  assert.equal(effortFor('bogus', kimi), '');
});

test('настройки: модели с уровнями, ключ проверяется по /limits, остаток лимита', async () => {
  const c = await registered(m, 'co1');
  let r = await c.json('/api/models', { base });
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.models, ['claude-sonnet-5-5', 'kimi-k3']);
  assert.equal(r.j.needKey, true);
  assert.deepEqual(r.j.info.find(x => x.id === 'kimi-k3').efforts, ['none', 'minimal', 'low', 'medium', 'high']);
  r = await c.json('/api/models', { base, key: 'coa_wrong' });
  assert.equal(r.status, 401);
  assert.match(r.j.error, /Ключ Coarena не подошёл/);
  r = await c.json('/api/models', { base, key: KEY });
  assert.equal(r.status, 200);
  assert.equal(r.j.limits.used, 1.25);
  assert.equal(r.j.limits.usd, 5);
  assert.equal((await c.json('/api/settings', { base, key: 'x', model: 'kimi-k3', effort: 'turbo' }, 'PUT')).status, 400);
});

test('чат: уровень размышления и потолок ответа в запросе, размышления — на экран и обратно модели после инструмента', async () => {
  const c = await registered(m, 'co2');
  assert.equal((await c.json('/api/settings', { base, key: 'Bearer ' + KEY, model: 'claude-sonnet-5-5', effort: 'high' }, 'PUT')).status, 200);
  calls.length = 0;
  script = [
    { think: 'Надо посмотреть, что на сервере.', tools: [{ name: 'run_command', args: { action: 'Смотрю', command: 'echo привет' } }],
      details: [{ type: 'reasoning.text', index: 0, text: '', signature: 'sig-123' }], both: true },
    { think: 'Команда сработала.', text: 'Готово ^_^', both: true },
  ];
  const done = c.events(evs => logOf(evs).some(e => e.kind === 'assistant' && e.text === 'Готово ^_^'), 30000);
  assert.equal((await c.json('/api/chat', { text: 'проверь сервер' })).status, 200);
  const evs = await done;
  const b0 = calls[0].body;
  assert.equal(calls[0].auth, 'Bearer ' + KEY);
  assert.equal(b0.reasoning_effort, 'high');
  assert.equal(b0.max_completion_tokens, 16384);
  assert.deepEqual(b0.stream_options, { include_usage: true });
  /* второй шаг: ассистент с вызовом инструмента несёт свои размышления и подпись */
  const a = calls[1].body.messages.find(x => x.role === 'assistant' && x.tool_calls);
  assert.equal(a.reasoning_content, 'Надо посмотреть, что на сервере.');
  assert.equal(a.reasoning_details[0].signature, 'sig-123');
  /* в чате размышлений нет — только ответ */
  const log = logOf(evs);
  assert.ok(!log.some(e => e.kind === 'think' || 'think' in e));
  assert.ok(!JSON.stringify(log).includes('Надо посмотреть'));
  /* окно по долгому нажатию: размышления по шагам, без удвоения слов, с подписью шага после размышления */
  const th = (await c.json('/api/chat/thoughts', undefined, 'GET')).j.list;
  assert.equal(th.length, 2);
  assert.equal(th[0].text, 'Надо посмотреть, что на сервере.');
  assert.deepEqual(th[0].tools, ['Смотрю']);
  assert.equal(th[1].text, 'Команда сработала.');
  assert.equal(th[1].tools, undefined);
});

test('размышления съели весь ответ — повтор уровнем ниже, без ошибки', async () => {
  const c = await registered(m, 'co3');
  await c.json('/api/settings', { base, key: KEY, model: 'claude-sonnet-5-5', effort: 'max' }, 'PUT');
  calls.length = 0;
  script = [{ think: 'долго-долго думаю', finish: 'length' }, { text: 'Ответ' }];
  const done = c.events(evs => logOf(evs).some(e => e.kind === 'assistant' && e.text === 'Ответ'), 30000);
  await c.json('/api/chat', { text: 'вопрос' });
  const evs = await done;
  assert.equal(calls[0].body.reasoning_effort, 'max');
  assert.equal(calls[1].body.reasoning_effort, 'low');
  assert.ok(logOf(evs).some(e => e.kind === 'note' && /весь ответ на размышления/.test(e.text)));
});

test('пустой ответ дважды — понятная ошибка, а не молчание', async () => {
  const c = await registered(m, 'co4');
  await c.json('/api/settings', { base, key: KEY, model: 'kimi-k3', effort: '' }, 'PUT');
  calls.length = 0;
  script = [{ think: 'хм' }, { think: 'хм' }];
  const done = c.events(evs => logOf(evs).some(e => e.kind === 'error'), 30000);
  await c.json('/api/chat', { text: 'вопрос' });
  const e = logOf(await done).find(x => x.kind === 'error');
  assert.equal(calls[0].body.reasoning_effort, undefined);
  assert.match(e.text, /Модель Coarena вернула пустой ответ \(только размышления\)/);
});

test('условия Model API не приняты — объясняем, что сделать', async () => {
  const c = await registered(m, 'co5');
  await c.json('/api/settings', { base, key: KEY, model: 'kimi-k3' }, 'PUT');
  calls.length = 0;
  script = [{ err: 403, code: 'model_api_terms_required', msg: 'Accept the terms' }];
  const done = c.events(evs => logOf(evs).some(e => e.kind === 'error'), 30000);
  await c.json('/api/chat', { text: 'вопрос' });
  const e = logOf(await done).find(x => x.kind === 'error');
  assert.match(e.text, /прими их один раз/);
  assert.equal(calls.length, 1);
});
