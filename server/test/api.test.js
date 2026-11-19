/* API для других проектов (/v1): ключи sk-pc-…, OpenAI-совместимые ответы, прозрачный прокси к обычному провайдеру
   и ответы через адаптер (Antigravity: свой протокол, подписи размышлений, инструменты) */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startPersonalComputer, registered } from './helpers.js';
import { Stopper, convert, toolsOf } from '../lib/gateway.js';

/* ---------- обычный OpenAI-совместимый провайдер ---------- */
const UP = { reqs: [] };
let up, upUrl;
/* ---------- Antigravity (Google Cloud Code) ---------- */
const AG = { gen: [], script: [], access: 'ya29.ACCESS0' };
let ag, agUrl, m;
const AGB = 'https://antigravity.google';
const RT = '1//0gREFRESH-' + 'z'.repeat(40);

before(async () => {
  up = http.createServer(async (q, s) => {
    let b = ''; for await (const c of q) b += c;
    const p = new URL(q.url, 'http://x').pathname, j = b ? JSON.parse(b) : {};
    UP.reqs.push({ p, body: j, auth: q.headers.authorization });
    const json = (st, o) => { s.writeHead(st, { 'content-type': 'application/json' }); s.end(JSON.stringify(o)); };
    if (p.startsWith('/bad/')) return json(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
    if (p.endsWith('/models')) return json(200, { data: [{ id: 'up-small' }, { id: 'up-large' }, { id: 'text-embed' }] });
    if (p.endsWith('/embeddings')) return json(200, { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: j.model, usage: { prompt_tokens: 3, total_tokens: 3 } });
    if (p.endsWith('/chat/completions')) {
      /* проверка ключа из настроек: пустой запрос — 400 */
      if (!j.messages) return json(400, { error: { message: 'messages required' } });
      if (j.model === 'up-limit') { s.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' }); return s.end('{"error":{"message":"slow down","type":"rate_limit"}}'); }
      if (!j.stream) return json(200, { id: 'x1', object: 'chat.completion', created: 1, model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: 'привет от ' + j.model }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } });
      s.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const w of ['при', 'вет']) s.write('data: ' + JSON.stringify({ id: 'x2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: w } }] }) + '\n\n');
      s.write('data: ' + JSON.stringify({ id: 'x2', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } }) + '\n\n');
      return s.end('data: [DONE]\n\n');
    }
    json(404, { error: { message: 'no route' } });
  });
  await new Promise(ok => up.listen(0, '127.0.0.1', ok));
  upUrl = 'http://127.0.0.1:' + up.address().port + '/v1';

  ag = http.createServer(async (q, s) => {
    let b = ''; for await (const c of q) b += c;
    const p = new URL(q.url, 'http://x').pathname;
    const json = (st, o) => { s.writeHead(st, { 'content-type': 'application/json' }); s.end(JSON.stringify(o)); };
    if (p === '/manifest.yml') { s.writeHead(200, { 'content-type': 'text/yaml' }); return s.end('version: 2.40.1\n'); }
    if (p === '/token') return json(200, { access_token: AG.access, expires_in: 3599 });
    if (p === '/userinfo') return json(200, { email: 'ag@gmail.com', name: 'AG' });
    if (q.headers.authorization !== 'Bearer ' + AG.access) return json(401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'bad' } });
    const j = b ? JSON.parse(b) : {};
    if (p === '/v1internal:loadCodeAssist') return json(200, { cloudaicompanionProject: 'proj-1', currentTier: { id: 'free-tier' } });
    if (p === '/v1internal:fetchAvailableModels') return json(200, { models: { 'gemini-3-flash': { displayName: 'Gemini 3 Flash', supportsImages: true, supportsThinking: true, maxTokens: 1048576, quotaInfo: { remainingFraction: 1 } } }, defaultAgentModelId: 'gemini-3-flash' });
    if (p === '/v1internal:streamGenerateContent') {
      const st = AG.script.shift() || { text: 'ок' };
      AG.gen.push(j);
      s.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = parts => 'data: ' + JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts } }] } }) + '\r\n\r\n';
      let out = '';
      if (st.think) out += ev([{ thought: true, text: st.think }]) + ev([{ thought: true, text: '', thoughtSignature: 'SIG-' + 'q'.repeat(60) }]);
      for (const w of (st.text || '').match(/.{1,4}/gs) || []) out += ev([{ text: w }]);
      for (const c of st.calls || []) out += ev([{ functionCall: { name: c.name, args: c.args }, thoughtSignature: 'CSIG-' + 'w'.repeat(60) }]);
      out += 'data: ' + JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, totalTokenCount: 520 } } }) + '\r\n\r\n';
      return s.end(out);
    }
    json(404, { error: { code: 404, message: 'no route ' + p } });
  });
  await new Promise(ok => ag.listen(0, '127.0.0.1', ok));
  agUrl = 'http://127.0.0.1:' + ag.address().port;
  m = await startPersonalComputer({ PERSONALCOMPUTER_AG_AUTH_URL: agUrl + '/auth', PERSONALCOMPUTER_AG_TOKEN_URL: agUrl + '/token', PERSONALCOMPUTER_AG_USERINFO_URL: agUrl + '/userinfo', PERSONALCOMPUTER_AG_API_URL: agUrl, PERSONALCOMPUTER_AG_VERSION_URL: agUrl + '/manifest.yml' });
});
after(async () => { await m?.stop(); up?.close(); ag?.close(); });

/* клиент API: как OpenAI SDK — ключ в заголовке, без cookie */
const v1 = (key, p, body, method = body === undefined ? 'GET' : 'POST', h = {}) => fetch(m.base + '/v1' + p, { method, headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
const jv1 = async (...a) => { const r = await v1(...a); return { status: r.status, h: r.headers, j: await r.json().catch(() => null) }; };
/* поток: куски data: … до [DONE] */
async function sse(r) {
  const t = await r.text(), out = [];
  for (const l of t.split('\n')) { if (!l.startsWith('data: ')) continue; const d = l.slice(6); out.push(d === '[DONE]' ? d : JSON.parse(d)); }
  return out;
}
async function userWithKey(name, keyOpts = {}) {
  const c = await registered(m, name);
  await c.json('/api/settings', { base: upUrl, key: 'sk-upstream-' + name, model: 'up-small' }, 'PUT');
  const r = await c.json('/api/keys', { name: 'проект', ...keyOpts });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  return { c, key: r.j.key, row: r.j.row };
}
const custom = () => 'custom:' + new URL(upUrl).host;

test('ключи: создать (виден один раз), список без секрета, выключить, удалить', async () => {
  const { c, key, row } = await userWithKey('keys1', { name: 'Мой бот', model: 'default', rpm: 0 });
  assert.match(key, /^sk-pc-[A-Za-z0-9_-]{43}$/);
  assert.equal(row.name, 'Мой бот');
  assert.ok(row.hint.startsWith(key.slice(0, 10)) && row.hint.endsWith(key.slice(-4)));
  let L = await c.json('/api/keys', undefined, 'GET');
  assert.equal(L.status, 200);
  assert.equal(L.j.keys.length, 1);
  assert.ok(!JSON.stringify(L.j).includes(key), 'ключ целиком наружу не отдаётся');
  assert.ok(L.j.endpoint.endsWith('/v1'));
  assert.ok(L.j.providers.some(p => p.id === custom() && p.available));
  /* без ключа и с чужим — 401 в формате OpenAI */
  let r = await jv1('', '/models');
  assert.equal(r.status, 401); assert.equal(r.j.error.code, 'invalid_api_key'); assert.equal(r.j.error.type, 'authentication_error');
  r = await jv1('sk-pc-' + 'A'.repeat(43), '/models');
  assert.equal(r.status, 401);
  assert.equal((await jv1(key, '/models')).status, 200);
  /* x-api-key тоже подходит (клиенты в стиле Anthropic) */
  assert.equal((await fetch(m.base + '/v1/models', { headers: { 'x-api-key': key } })).status, 200);
  /* выключили — 401 с понятной причиной; включили — снова работает */
  assert.equal((await c.json('/api/keys/' + row.id, { off: true }, 'PATCH')).status, 200);
  r = await jv1(key, '/models');
  assert.equal(r.status, 401); assert.equal(r.j.error.code, 'api_key_disabled');
  await c.json('/api/keys/' + row.id, { off: false, name: 'Новое имя' }, 'PATCH');
  assert.equal((await jv1(key, '/models')).status, 200);
  L = await c.json('/api/keys', undefined, 'GET');
  assert.equal(L.j.keys[0].name, 'Новое имя');
  assert.ok(L.j.keys[0].last > 0, 'видно, когда ключом пользовались');
  /* чужой ключ не изменить и не удалить */
  const other = await registered(m, 'keys1b');
  assert.equal((await other.json('/api/keys/' + row.id, { off: true }, 'PATCH')).status, 404);
  assert.equal((await other.json('/api/keys/' + row.id, undefined, 'DELETE')).status, 404);
  /* удалили — ключ больше не действует */
  assert.equal((await c.json('/api/keys/' + row.id, undefined, 'DELETE')).status, 200);
  assert.equal((await jv1(key, '/models')).status, 401);
  /* управление ключами — только из приложения (cookie + защита от CSRF) */
  assert.equal((await fetch(m.base + '/api/keys', { method: 'POST', headers: { authorization: 'Bearer ' + key } })).status, 403);
});

test('модели: «провайдер/модель» всех настроенных провайдеров', async () => {
  const { key } = await userWithKey('models1');
  const r = await jv1(key, '/models');
  assert.equal(r.status, 200);
  assert.equal(r.j.object, 'list');
  const ids = r.j.data.map(x => x.id);
  assert.ok(ids.includes(custom() + '/up-small'), ids.join(', '));
  assert.ok(r.j.data.every(x => x.object === 'model' && typeof x.created === 'number' && x.owned_by));
  const one = await jv1(key, '/models/' + encodeURIComponent(custom() + '/up-large'));
  assert.equal(one.status, 200); assert.equal(one.j.id, custom() + '/up-large');
});

test('прозрачный прокси: параметры как есть, своя модель и ключ провайдера, учёт токенов', async () => {
  const { c, key } = await userWithKey('pass1');
  const n = UP.reqs.length;
  /* просто имя модели — шлюз находит провайдера сам */
  let r = await jv1(key, '/chat/completions', { model: 'up-large', messages: [{ role: 'user', content: 'Привет' }], temperature: 0.3, max_tokens: 50, response_format: { type: 'json_object' }, seed: 7 });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.choices[0].message.content, 'привет от up-large');
  assert.equal(r.h.get('x-pc-provider'), custom());
  const sent = UP.reqs.slice(n).find(x => x.p.endsWith('/chat/completions') && x.body.messages);
  assert.equal(sent.auth, 'Bearer sk-upstream-pass1', 'к провайдеру — его собственный ключ, не sk-pc-');
  assert.deepEqual({ ...sent.body, messages: undefined }, { model: 'up-large', temperature: 0.3, max_tokens: 50, response_format: { type: 'json_object' }, seed: 7, messages: undefined });
  /* «провайдер/модель» и «default» (модель агента) */
  r = await jv1(key, '/chat/completions', { model: custom() + '/up-small', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.j.choices[0].message.content, 'привет от up-small');
  r = await jv1(key, '/chat/completions', { model: 'default', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.j.choices[0].message.content, 'привет от up-small');
  /* поток — байт в байт от провайдера */
  const s = await v1(key, '/chat/completions', { model: 'up-small', stream: true, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(s.status, 200);
  assert.match(s.headers.get('content-type'), /event-stream/);
  const ch = await sse(s);
  assert.equal(ch.filter(x => x !== '[DONE]').map(x => x.choices[0]?.delta?.content || '').join(''), 'привет');
  assert.equal(ch.at(-1), '[DONE]');
  /* embeddings */
  r = await jv1(key, '/embeddings', { model: custom() + '/text-embed', input: 'abc' });
  assert.equal(r.status, 200); assert.deepEqual(r.j.data[0].embedding, [0.1, 0.2]);
  /* учёт: запросы и токены из usage провайдера */
  await new Promise(ok => setTimeout(ok, 50));
  const k = (await c.json('/api/keys', undefined, 'GET')).j.keys[0];
  assert.equal(k.stats.req, 5);
  assert.ok(k.stats.in >= 11 + 11 + 11 + 20 + 3, JSON.stringify(k.stats));
  assert.equal(k.recent[0].p, '/embeddings');
  assert.ok(k.recent.some(x => x.stream === 1 && x.in === 20 && x.out === 2));
});

test('ошибки: провайдер не принял свой ключ — 502, а не 401; 429 с retry-after; неизвестная модель — 404', async () => {
  const { c, key } = await userWithKey('errs1');
  let r = await jv1(key, '/chat/completions', { model: custom() + '/up-limit', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 429); assert.equal(r.h.get('retry-after'), '7'); assert.match(r.j.error.message, /slow down/);
  r = await jv1(key, '/chat/completions', { model: 'up-small', messages: 'x' });
  assert.equal(r.status, 400);
  r = await jv1(key, '/nope', {});
  assert.equal(r.status, 404); assert.equal(r.j.error.code, 'unknown_url');
  /* ключ провайдера неверный */
  const badUrl = upUrl.replace('127.0.0.1', 'localhost').replace('/v1', '/bad/v1');
  await c.json('/api/settings', { base: badUrl, key: 'sk-wrong', model: 'm1' }, 'PUT');
  const bad = (await c.json('/api/keys', undefined, 'GET')).j.providers.find(p => p.id === 'custom:' + new URL(badUrl).host);
  assert.ok(bad, 'второй провайдер виден');
  r = await jv1(key, '/chat/completions', { model: bad.id + '/m1', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 502); assert.equal(r.j.error.code, 'provider_auth_error'); assert.match(r.j.error.message, /Incorrect API key/);
  /* провайдеров теперь два, и ни у одного нет такой модели */
  r = await jv1(key, '/chat/completions', { model: 'nope-model', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 404); assert.equal(r.j.error.code, 'model_not_found'); assert.match(r.j.error.message, /GET \/v1\/models/);
});

test('ограничения ключа: только свои провайдеры, лимит в минуту', async () => {
  const { key } = await userWithKey('lim1', { providers: ['openai'] });
  let r = await jv1(key, '/chat/completions', { model: custom() + '/up-small', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 403); assert.equal(r.j.error.code, 'provider_not_allowed');
  assert.ok(!(await jv1(key, '/models')).j.data.some(x => x.owned_by === custom()));
  const k2 = (await userWithKey('lim2', { rpm: 2 })).key;
  for (let i = 0; i < 2; i++) assert.equal((await jv1(k2, '/chat/completions', { model: 'default', messages: [{ role: 'user', content: 'x' }] })).status, 200);
  r = await jv1(k2, '/chat/completions', { model: 'default', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 429); assert.ok(+r.h.get('retry-after') >= 1); assert.equal(r.h.get('x-ratelimit-limit-requests'), '2');
});

test('CORS: браузерные приложения с других сайтов', async () => {
  const r = await fetch(m.base + '/v1/chat/completions', { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-allow-headers'), /authorization/);
});

test('адаптер (Antigravity): ответ, поток с инструментами, подписи размышлений возвращаются сами', async () => {
  const { c, key } = await userWithKey('ag1');
  let r0 = await c.json('/api/antigravity/import', { text: JSON.stringify({ version: 3, accounts: [{ email: 'ag@gmail.com', refreshToken: RT, managedProjectId: 'proj-1' }] }) });
  assert.equal(r0.status, 200, JSON.stringify(r0.j));
  /* Antigravity — не активный провайдер агента: ключ всё равно к нему пускает */
  const ids = (await jv1(key, '/models')).j.data.map(x => x.id);
  assert.ok(ids.includes('antigravity/gemini-3-flash'), ids.join(', '));

  AG.script.push({ text: 'Привет, мир!', think: 'думаю…' });
  let r = await jv1(key, '/chat/completions', { model: 'antigravity/gemini-3-flash', messages: [{ role: 'system', content: 'Ты тест.' }, { role: 'user', content: 'Скажи привет' }] });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.object, 'chat.completion');
  assert.equal(r.j.choices[0].message.content, 'Привет, мир!');
  assert.equal(r.j.choices[0].message.reasoning_content, 'думаю…');
  assert.equal(r.j.choices[0].finish_reason, 'stop');
  assert.ok(r.j.usage.total_tokens > 0);
  const g0 = AG.gen.at(-1);
  assert.match(JSON.stringify(g0.request.systemInstruction), /Ты тест\./);

  /* поток с вызовом инструмента */
  AG.script.push({ text: 'Смотрю погоду. ', think: 'нужен инструмент', calls: [{ name: 'get_weather', args: { city: 'Москва' } }] });
  const tools = [{ type: 'function', function: { name: 'get_weather', description: 'Погода', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
  const msgs = [{ role: 'user', content: 'Какая погода в Москве?' }];
  const s = await v1(key, '/chat/completions', { model: 'antigravity/gemini-3-flash', stream: true, stream_options: { include_usage: true }, tools, messages: msgs });
  assert.equal(s.status, 200);
  const ch = await sse(s), data = ch.filter(x => x !== '[DONE]');
  assert.equal(ch.at(-1), '[DONE]');
  assert.equal(data[0].choices[0].delta.role, 'assistant');
  assert.equal(data.map(x => x.choices[0]?.delta?.content || '').join(''), 'Смотрю погоду. ');
  const tc = data.find(x => x.choices[0]?.delta?.tool_calls).choices[0].delta.tool_calls[0];
  assert.equal(tc.function.name, 'get_weather'); assert.deepEqual(JSON.parse(tc.function.arguments), { city: 'Москва' });
  assert.equal(data.find(x => x.choices[0]?.finish_reason).choices[0].finish_reason, 'tool_calls');
  assert.ok(data.at(-1).usage?.total_tokens > 0, 'usage в конце потока по include_usage');

  /* клиент присылает историю с результатом инструмента — шлюз сам вернул модели подписи размышлений */
  AG.script.push({ text: 'В Москве +5.' });
  r = await jv1(key, '/chat/completions', { model: 'antigravity/gemini-3-flash', tools, messages: [...msgs,
    { role: 'assistant', content: 'Смотрю погоду. ', tool_calls: [{ id: tc.id, type: 'function', function: { name: 'get_weather', arguments: tc.function.arguments } }] },
    { role: 'tool', tool_call_id: tc.id, content: '{"t":5}' }] });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.choices[0].message.content, 'В Москве +5.');
  const sent = JSON.stringify(AG.gen.at(-1).request.contents);
  assert.match(sent, /CSIG-w{60}/, 'подпись вызова инструмента ушла модели');
  assert.match(sent, /"city":"Москва"/);
  assert.ok(sent.includes('{\\"t\\":5}'), 'результат инструмента ушёл модели');

  /* stop и JSON-режим */
  AG.script.push({ text: 'раз два STOP три' });
  r = await jv1(key, '/chat/completions', { model: 'antigravity/gemini-3-flash', stop: ['STOP'], messages: [{ role: 'user', content: 'считай' }] });
  assert.equal(r.j.choices[0].message.content, 'раз два ');
  AG.script.push({ text: '```json\n{"a":1}\n```' });
  r = await jv1(key, '/chat/completions', { model: 'antigravity/gemini-3-flash', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'json' }] });
  assert.deepEqual(JSON.parse(r.j.choices[0].message.content), { a: 1 });
  assert.match(JSON.stringify(AG.gen.at(-1).request.systemInstruction), /JSON/);
  /* старый /v1/completions */
  AG.script.push({ text: 'дополнено' });
  r = await jv1(key, '/completions', { model: 'antigravity/gemini-3-flash', prompt: 'дополни' });
  assert.equal(r.status, 200); assert.equal(r.j.object, 'text_completion'); assert.equal(r.j.choices[0].text, 'дополнено');
  /* embeddings у адаптера нет — понятная ошибка */
  r = await jv1(key, '/embeddings', { model: 'antigravity/gemini-3-flash', input: 'x' });
  assert.equal(r.status, 400); assert.equal(r.j.error.code, 'unsupported');
});

test('разбор запроса: части сообщений, старые functions, tool_choice, stop в потоке', async () => {
  const { sys, hist } = await convert({ messages: [
    { role: 'developer', content: 'правила' }, { role: 'system', content: [{ type: 'text', text: 'ещё' }] },
    { role: 'user', content: [{ type: 'text', text: 'что на картинке?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] },
    { role: 'assistant', content: null, function_call: { name: 'f', arguments: '{"x":1}' } },
    { role: 'function', name: 'f', content: 'ok' }] }, {});
  assert.equal(sys, 'правила\n\nещё');
  assert.equal(hist[0].content[1].type, 'image_url');
  assert.equal(hist[1].tool_calls[0].function.name, 'f');
  assert.equal(hist[2].role, 'tool'); assert.equal(hist[2].tool_call_id, hist[1].tool_calls[0].id);
  const web = await convert({ messages: [{ role: 'user', content: [{ type: 'text', text: 'фото' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } }] }] }, { web: true });
  assert.equal(web.hist[0].content, 'фото'); assert.equal(web.hist[0]._gwf[0].mime, 'image/jpeg');
  await assert.rejects(convert({ messages: [{ role: 'robot', content: 'x' }] }), /неизвестная роль/);
  /* картинки по ссылке — не с этой машины и не из локальной сети */
  for (const u of ['http://127.0.0.1:8787/api/me', 'http://localhost/x.png', 'http://[::1]/x.png', 'http://192.168.1.5/x.png', 'http://169.254.169.254/latest/meta-data', 'http://intranet/x.png'])
    await assert.rejects(convert({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: u } }] }] }, { signal: AbortSignal.timeout(5000) }), /локальной сети/, u);
  const t = [{ type: 'function', function: { name: 'a' } }, { type: 'function', function: { name: 'b' } }];
  assert.equal(toolsOf({ tools: t, tool_choice: 'none' }).tools.length, 0);
  const one = toolsOf({ tools: t, tool_choice: { type: 'function', function: { name: 'b' } } });
  assert.deepEqual(one.tools.map(x => x.function.name), ['b']); assert.match(one.note, /вызови инструмент b/);
  assert.equal(toolsOf({ functions: [{ name: 'z', parameters: { type: 'object' } }] }).tools[0].function.name, 'z');
  /* stop посреди кусочков потока */
  let out = '';
  const st = new Stopper(['<END>'], d => out += d);
  for (const d of ['абв<E', 'N', 'D>где']) st.push(d);
  st.end();
  assert.equal(out, 'абв'); assert.ok(st.hit);
});
