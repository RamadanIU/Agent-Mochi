import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMochi, registered, fakeModel } from './helpers.js';

/* шлюз модели, как JustWoker за Cloudflare: /models отвечает, а запросы к модели режет правило WAF — и Node.js, и curl */
const WAF = '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n<head>\n<title>Attention Required! | Cloudflare</title>\n</head><body>'
  + '<h1>Sorry, you have been blocked</h1><h2>You are unable to access justwoker.icu</h2>' + ' '.repeat(400) + 'Performance &amp; security by Cloudflare</body></html>';
let m, gw, base;
const hits = [];
before(async () => {
  gw = http.createServer(async (q, s) => {
    let b = ''; for await (const c of q) b += c;
    hits.push({ url: q.url, ua: q.headers['user-agent'] || '', body: b });
    if (q.url.endsWith('/models')) { s.writeHead(200, { 'content-type': 'application/json' }); return s.end('{"data":[{"id":"gpt-x"}],"success":true}'); }
    if (q.url.startsWith('/waf/')) { s.writeHead(403, { 'content-type': 'text/html; charset=UTF-8', 'cf-ray': 'a46bb91dcc92d145-LHR', server: 'cloudflare' }); return s.end(WAF); }
    if (q.url.startsWith('/quota/')) { s.writeHead(403, { 'content-type': 'application/json' }); return s.end('{"error":{"message":"user quota is not enough","type":"new_api_error"}}'); }
    s.writeHead(400, { 'content-type': 'application/json' }); s.end('{"error":{"message":"model is required"}}');
  });
  await new Promise(ok => gw.listen(0, '127.0.0.1', ok));
  base = 'http://127.0.0.1:' + gw.address().port;
  m = await startMochi();
});
after(async () => { await m?.stop(); gw?.close(); });

/* ошибка могла случиться и до подключения к потоку — тогда она уже в снимке */
const errs = evs => evs.flatMap(e => e.ev === 'log' ? [e.d] : e.ev === 'snap' ? e.d.log : []).filter(x => x.kind === 'error');
const lastText = (c, ms) => c.events(evs => errs(evs).length > 0, ms).then(evs => errs(evs).pop().text);

test('проверка в настройках видит блокировку Cloudflare у запросов к модели, хотя /models отвечает', async () => {
  const c = await registered(m, 'waf');
  const r = await c.json('/api/models', { base: base + '/waf/v1', key: 'sk-test' });
  assert.equal(r.status, 502);
  assert.match(r.j.error, /^Это не ключ: Cloudflare перед 127\.0\.0\.1:\d+ заблокировал/);
  assert.match(r.j.error, /Ray ID: a46bb91dcc92d145-LHR/);
  /* пустой запрос к модели: без модели и сообщений — ничего не запускается */
  assert.equal(hits.find(h => h.url === '/waf/v1/chat/completions').body, '{}');
});

test('обычный шлюз: список моделей, пустой запрос к модели не мешает', async () => {
  const c = await registered(m, 'gw');
  const r = await c.json('/api/models', { base: base + '/ok/v1', key: 'sk-test' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.models, ['gpt-x']);
  assert.equal(r.j.needKey, false);
});

test('блокировка Cloudflare в чате: понятная ошибка без повторов', async () => {
  const c = await registered(m, 'wafchat');
  await c.json('/api/settings', { base: base + '/waf/v1', key: 'sk-test', model: 'gpt-x' }, 'PUT');
  const n = hits.length;
  const ev = lastText(c);
  assert.equal((await c.json('/api/chat', { text: 'привет' })).status, 200);
  assert.match(await ev, /^Это не ключ: Cloudflare.*Ray ID: a46bb91dcc92d145-LHR/);
  const chat = hits.slice(n).filter(h => h.url.endsWith('/chat/completions'));
  /* одна попытка из Node.js и одна через curl — повторять бесполезно */
  assert.ok(chat.length >= 1 && chat.length <= 2, 'запросов к модели: ' + chat.length);
});

test('кончилась квота на ключе (403 у New API) — не «ключ не подошёл»', async () => {
  const c = await registered(m, 'quota');
  await c.json('/api/settings', { base: base + '/quota/v1', key: 'sk-test', model: 'gpt-x' }, 'PUT');
  const ev = lastText(c);
  assert.equal((await c.json('/api/chat', { text: 'привет' })).status, 200);
  assert.match(await ev, /кончились деньги или квота \(HTTP 403\)/);
});

test('вызов инструмента с обрезанным JSON: дальше модель получает историю с {} (иначе Ollama отвечает 400)', async () => {
  const fm = await fakeModel([{ tools: [{ name: 'run_command', raw: '{"action":"Смотрю","command":"ech' }] }, { text: 'готово' }]);
  try {
    const c = await registered(m, 'badargs');
    await c.json('/api/settings', { base: fm.url, key: 'sk-test', model: 'fake-1' }, 'PUT');
    const done = c.events(evs => evs.some(e => e.ev === 'log' && e.d.kind === 'assistant' && e.d.text === 'готово'));
    assert.equal((await c.json('/api/chat', { text: 'привет' })).status, 200);
    await done;
    const msgs = fm.calls[1].body.messages, a = msgs.find(x => x.tool_calls);
    assert.equal(a.tool_calls[0].function.arguments, '{}');
    assert.match(msgs.find(x => x.role === 'tool').content, /невалидный JSON/);
  } finally { fm.close(); }
});

test('сохранённые провайдеры: переключение без повторного ввода ключа, ключи наружу не уходят, «забыть»', async () => {
  const a = await fakeModel(() => ({ text: 'это A' })), b = await fakeModel(() => ({ text: 'это B' }));
  try {
    const c = await registered(m, 'provs');
    await c.json('/api/settings', { base: a.url, key: 'sk-aaa', model: 'fake-1' }, 'PUT');
    const r = await c.json('/api/settings', { base: b.url + '/', key: 'sk-bbb', model: 'fake-2' }, 'PUT');
    assert.equal(r.status, 200);
    assert.deepEqual(r.j.provs, [{ base: a.url, model: 'fake-1', hasKey: true }, { base: b.url, model: 'fake-2', hasKey: true }]);
    assert.doesNotMatch(JSON.stringify(r.j), /sk-aaa|sk-bbb/);

    /* назад к A: ни ключа, ни модели — сервер берёт сохранённые */
    const s = (await c.json('/api/settings', { base: a.url }, 'PUT')).j;
    assert.equal(s.base, a.url); assert.equal(s.model, 'fake-1'); assert.equal(s.hasKey, true);
    const say = async (fm, want) => {
      const done = c.events(evs => evs.some(e => e.ev === 'log' && e.d.kind === 'assistant' && e.d.text === want));
      assert.equal((await c.json('/api/chat', { text: 'кто ты?' })).status, 200);
      await done;
    };
    await say(a, 'это A');
    assert.equal(a.calls.at(-1).auth, 'Bearer sk-aaa');
    assert.equal(a.calls.at(-1).body.model, 'fake-1');

    /* список моделей нового провайдера проверяется его сохранённым ключом */
    assert.equal((await c.json('/api/models', { base: b.url })).status, 200);

    /* к B — с моделью из поля, ключ сохранённый */
    await c.json('/api/settings', { base: b.url, model: 'fake-2' }, 'PUT');
    await say(b, 'это B');
    assert.equal(b.calls.at(-1).auth, 'Bearer sk-bbb');

    /* новый ключ для B заменяет старый только у B */
    await c.json('/api/settings', { base: b.url, key: 'sk-bbb2', model: 'fake-2' }, 'PUT');
    await c.json('/api/settings', { base: a.url, model: 'fake-1' }, 'PUT');
    await c.json('/api/settings', { base: b.url, model: 'fake-2' }, 'PUT');
    await say(b, 'это B');
    assert.equal(b.calls.at(-1).auth, 'Bearer sk-bbb2');

    /* забыть неактивного: активный не трогаем */
    const f = (await c.json('/api/settings', { forget: a.url }, 'PUT')).j;
    assert.deepEqual(f.provs.map(p => p.base), [b.url]);
    assert.equal(f.base, b.url); assert.equal(f.hasKey, true);
    /* забыть активного — ключа больше нет */
    const g = (await c.json('/api/settings', { forget: b.url }, 'PUT')).j;
    assert.deepEqual(g.provs, []); assert.equal(g.hasKey, false);

    /* переход на несохранённый адрес не уносит туда чужой ключ */
    await c.json('/api/settings', { base: a.url, key: 'sk-aaa', model: 'fake-1' }, 'PUT');
    const h = (await c.json('/api/settings', { base: 'http://127.0.0.1:9/v1', model: 'x' }, 'PUT')).j;
    assert.equal(h.hasKey, false);
    assert.deepEqual(h.provs.map(p => [p.base, p.hasKey]), [[a.url, true], ['http://127.0.0.1:9/v1', false]]);

    /* «Сбросить всё» стирает ключи всех провайдеров */
    const z = (await c.json('/api/settings', { base: '', model: '', clearKey: true }, 'PUT')).j;
    assert.deepEqual(z.provs, []); assert.equal(z.hasKey, false);

    /* переживает перезапуск */
    await c.json('/api/settings', { base: a.url, key: 'sk-aaa', model: 'fake-1' }, 'PUT');
    await m.restart();
    assert.deepEqual((await c.json('/api/settings', undefined, 'GET')).j.provs, [{ base: a.url, model: 'fake-1', hasKey: true }]);
  } finally { a.close(); b.close(); }
});

test('настройки до сохранения провайдеров: текущий ключ становится первым сохранённым', async () => {
  const c = await registered(m, 'legacy');
  const me = (await c.json('/api/account', undefined, 'GET')).j.user;
  const fs = await import('node:fs'), path = await import('node:path');
  const dir = path.join(m.env.MOCHI_DATA, 'users', me.id);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ base: 'https://old.example/v1', key: 'sk-old', model: 'old-1' }));
  await m.restart();
  const s = (await c.json('/api/settings', undefined, 'GET')).j;
  assert.deepEqual(s.provs, [{ base: 'https://old.example/v1', model: 'old-1', hasKey: true }]);
  /* ушли на другой адрес и вернулись — старый ключ на месте */
  await c.json('/api/settings', { base: 'https://new.example/v1', key: 'sk-new', model: 'n' }, 'PUT');
  const back = (await c.json('/api/settings', { base: 'https://old.example/v1' }, 'PUT')).j;
  assert.equal(back.hasKey, true); assert.equal(back.model, 'old-1');
});
