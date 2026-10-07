import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { apiFetch, curlFetch } from '../lib/net.js';
import { sleep } from './helpers.js';

/* сервер как Cloudflare перед OpenRouter: Node.js (undici) получает 403, curl — ответ */
let srv, base;
const seen = [];
before(async () => {
  srv = http.createServer((q, s) => {
    let b = ''; q.on('data', d => { b += d; }); q.on('end', async () => {
      seen.push({ ua: q.headers['user-agent'], auth: q.headers.authorization, body: b, url: q.url });
      if (q.url.includes('/other')) { s.writeHead(403, { 'content-type': 'application/json' }); return s.end('{"error":"no"}'); }
      if (/^(node|undici)/.test(q.headers['user-agent'] || '')) { s.writeHead(403, { 'content-type': 'application/json' }); return s.end('{ "success": false, "error": "Access denied by security policy." }'); }
      s.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < (q.url.includes('/long') ? 200 : 3); i++) { s.write('data: {"n":' + i + '}\n\n'); await sleep(20); }
      s.end('data: [DONE]\n\n');
    });
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  base = 'http://127.0.0.1:' + srv.address().port + '/v1';
});
after(() => srv.close());

test('на 403 Cloudflare запрос повторяется через curl, потом сразу идёт через curl', async () => {
  const init = () => ({ method: 'POST', headers: { Authorization: 'Bearer sk-test', 'Content-Type': 'application/json' }, body: '{"a":"кот \\"x\\""}' });
  let r = await apiFetch(base + '/chat/completions', init());
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /event-stream/);
  let text = ''; for await (const c of r.body) text += Buffer.from(c).toString();
  assert.match(text, /"n":2[\s\S]*\[DONE\]/);
  const last = seen.at(-1);
  assert.match(last.ua, /^curl\//);
  assert.equal(last.auth, 'Bearer sk-test');
  assert.equal(last.body, '{"a":"кот \\"x\\""}');
  const n = seen.length;
  r = await apiFetch(base + '/models', { headers: { Authorization: 'Bearer sk-test' } });
  assert.equal(r.status, 200); await r.text();
  assert.equal(seen.length, n + 1, 'второй запрос сразу через curl, без попытки из Node');
});

test('обычный 403 отдаётся как есть', async () => {
  const r = await apiFetch(base.replace('127.0.0.1', 'localhost') + '/other');
  assert.equal(r.status, 403);
  assert.equal(await r.text(), '{"error":"no"}');
});

test('curlFetch: отмена посреди потока', async () => {
  const ac = new AbortController();
  const r = await curlFetch(base + '/long', { signal: ac.signal });
  setTimeout(() => ac.abort(), 150);
  await assert.rejects(async () => { for await (const _ of r.body); }, e => e.name === 'AbortError');
});

test('curlFetch: сеть недоступна — TypeError, как у fetch', async () => {
  const port = srv.address().port + 1;
  await assert.rejects(curlFetch('http://127.0.0.1:' + port + '/x'), e => e instanceof TypeError && /^CURL_/.test(e.cause.code));
});
