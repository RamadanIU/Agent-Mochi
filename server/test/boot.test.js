/* Быстрый старт: страница без образа Linux (он нужен только браузерной версии), экран загрузки,
   и агент, который не ждёт подключения к поиску в интернете */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fakeModel, startMochi, registered } from './helpers.js';
import { stripImages } from '../lib/server.js';
import { WEB_GRACE } from '../lib/mcp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let m, model, mcp, c, mode = 'hang';
const seen = [];

before(async () => {
  model = await fakeModel(() => ({ text: 'ок' }));
  /* поиск в интернете (MCP): «hang» — принимает запрос и молчит, «ok» — отвечает */
  mcp = http.createServer(async (req, res) => {
    let b = ''; for await (const ch of req) b += ch;
    const msg = JSON.parse(b || '{}');
    seen.push(msg.method);
    if (mode === 'hang') return;
    if (msg.id === undefined) { res.writeHead(202); return res.end(); }
    const result = msg.method === 'initialize' ? { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'search' } }
      : msg.method === 'tools/list' ? { tools: [{ name: 'web_search', description: 'Поиск в интернете', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] }
      : { content: [{ type: 'text', text: 'нашлось' }] };
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise(ok => mcp.listen(0, '127.0.0.1', ok));
  m = await startMochi({ MOCHI_SEARCH_MCP: 'http://127.0.0.1:' + mcp.address().port + '/mcp' });
  c = await registered(m, 'boot');
  await c.json('/api/settings', { base: model.url, key: 'k', model: 'fake-1', search: true }, 'PUT');
});
after(async () => { await m?.stop(); model?.close(); mcp?.closeAllConnections(); mcp?.close(); });

/* отправить сообщение и дождаться конца задачи; → сколько ждали, мс */
async function ask(text) {
  let ready; const rp = new Promise(r => ready = r);
  const w = c.events(evs => {
    if (evs.some(e => e.ev === 'snap')) ready();
    const k = evs.findIndex(e => e.ev === 'run' && e.d.running === true);
    return k >= 0 && evs.slice(k).some(e => e.ev === 'run' && e.d.running === false);
  }, 20000);
  await rp;
  const t0 = Date.now();
  assert.equal((await c.json('/api/chat', { text })).status, 200);
  await w;
  return Date.now() - t0;
}
const tools = () => (model.calls[model.calls.length - 1].body.tools || []).map(t => t.function.name);

test('страница сервера — без образа Linux и BIOS, скрипты целы и разрешены CSP', async () => {
  const r = await fetch(m.base + '/', { headers: { 'accept-encoding': 'br' } });
  const t = await r.text();
  assert.ok(t.length < 1.5 * 2 ** 20, 'страница весит ' + t.length);
  assert.match(t, /const BIOS='',VGA='';/);
  assert.match(t, /const ALP='';/);
  assert.doesNotMatch(t, /H4sIAAAAAAAC/); /* gzip в base64 — так начинался образ Alpine */
  assert.match(t, /<div id="boot"/);
  const csp = r.headers.get('content-security-policy');
  const scripts = [...t.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
  assert.ok(scripts.length >= 5);
  for (const s of scripts) {
    new vm.Script(s); /* вырезание не сломало синтаксис */
    assert.ok(csp.includes(`'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`), 'скрипт без хеша в CSP');
  }
  /* браузерной версии образ по-прежнему нужен — в самом файле он на месте */
  const src = fs.readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8');
  assert.ok(src.length > 4 * 2 ** 20);
  assert.equal(stripImages(stripImages(src)), stripImages(src));
});

test('вырезаются только длинные base64-строки образов', () => {
  const s = "const BIOS='" + 'A'.repeat(300) + "',VGA='" + 'B'.repeat(300) + "';\nconst ALP='" + 'H4sI'.repeat(100) + "';\nconst X='keep';";
  assert.equal(stripImages(s), "const BIOS='',VGA='';\nconst ALP='';\nconst X='keep';");
  const short = "const ALP='abc';";
  assert.equal(stripImages(short), short);
});

test('поиск в интернете молчит — агент отвечает, не дожидаясь его 10 секунд', async () => {
  const first = await ask('привет');
  assert.ok(first < WEB_GRACE + 3000, 'первый ответ ждал ' + first + ' мс');
  assert.ok(!tools().includes('web_search'));
  /* попытка подключения ещё висит — второе сообщение не ждёт совсем */
  const second = await ask('ещё раз');
  assert.ok(second < 2000, 'второй ответ ждал ' + second + ' мс');
});

test('поиск подключается заранее, при старте сервера', async () => {
  mode = 'ok'; seen.length = 0;
  await m.restart();
  for (let i = 0; i < 100 && !seen.includes('tools/list'); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(seen.includes('tools/list'), 'сервер не подключился к поиску при старте: ' + seen.join(', '));
  await ask('найди что-нибудь');
  assert.ok(tools().includes('web_search'), 'в запросе нет поиска: ' + tools().join(', '));
});
