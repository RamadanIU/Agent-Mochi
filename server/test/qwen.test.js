/* Провайдер Qwen: фальшивый chat.qwen.ai (тот же веб-API: /api/models, /api/v2/chats/new, /api/v2/chat/completions с SSE) */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { startPersonalComputer, registered, chatFile, sleep } from './helpers.js';
import { callParser, parseToken, tokenInfo } from '../lib/qwen.js';

const jwt = (p) => ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', Buffer.from(JSON.stringify(p)).toString('base64url'), 'sig'].join('.');
const EXP = Math.floor(Date.now() / 1000) + 30 * 86400;
const TOKEN = jwt({ id: 'acc-1', exp: EXP }), TOKEN2 = jwt({ id: 'acc-2', exp: EXP });
const QWEN = 'https://chat.qwen.ai';

let m, srv;
const Q = { chats: new Map(), calls: [], news: [], dels: [], script: null };
before(async () => {
  srv = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const u = new URL(req.url, 'http://x'), auth = req.headers.authorization || '';
    const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (![TOKEN, TOKEN2].map(t => 'Bearer ' + t).includes(auth)) return send(401, { success: false, data: { code: 'Unauthorized', details: 'token expired' } });
    if (u.pathname === '/api/models') return send(200, { data: [
      { id: 'qwen3-max', name: 'Qwen3-Max', info: { meta: { abilities: { thinking: true }, chat_type: ['t2t', 'search'] } } },
      { id: 'qwen-image', name: 'Qwen Image', info: { meta: { chat_type: ['t2i'] } } },
      { id: 'qwen3-deep', name: 'Qwen3-Deep', info: { meta: { abilities: { thinking: true }, think_skip: { enable: false }, chat_type: ['t2t'] } } },
      { id: 'qwen3-coder', name: 'Qwen3-Coder', info: { meta: { chat_type: ['t2t'] } } },
    ] });
    if (u.pathname === '/api/v2/chats/new') {
      const id = 'chat-' + (Q.chats.size + 1) + '-' + Math.random().toString(36).slice(2, 6);
      Q.chats.set(id, { acct: auth, n: 0 }); Q.news.push({ id, body: JSON.parse(b) });
      return send(200, { success: true, data: { id } });
    }
    if (req.method === 'DELETE' && u.pathname.startsWith('/api/v2/chats/')) { Q.dels.push(u.pathname.split('/').pop()); return send(200, { success: true }); }
    if (u.pathname === '/api/v2/chat/completions') {
      const chatId = u.searchParams.get('chat_id'), body = JSON.parse(b), ch = Q.chats.get(chatId);
      if (!ch || ch.acct !== auth) return send(200, { success: false, data: { code: 'NotFound', details: 'chat not found' } });
      const msg = body.messages[0];
      const call = { chatId, parent: body.parent_id, content: msg.content, fc: msg.feature_config, model: body.model, headers: req.headers };
      Q.calls.push(call);
      const rid = 'resp-' + Q.calls.length;
      const step = await Q.script(call, Q.calls.length - 1);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const w = j => res.write('data: ' + JSON.stringify(j) + '\n\n');
      w({ 'response.created': { chat_id: chatId, parent_id: msg.fid, response_id: rid, response_index: 0 } });
      /* второй вариант ответа — его кадры надо пропустить */
      w({ 'response.created': { chat_id: chatId, parent_id: msg.fid, response_id: rid + 'b', response_index: 1 } });
      w({ choices: [{ delta: { role: 'assistant', content: 'ЛИШНЕЕ', phase: 'answer' } }], response_id: rid + 'b' });
      if (step.think) w({ choices: [{ delta: { role: 'assistant', content: step.think, phase: 'think' } }], response_id: rid });
      w({ choices: [{ delta: { role: 'function', name: 'web_search', content: 'поиск сайта', phase: 'answer' } }], response_id: rid });
      for (const piece of (step.text || '').match(/[\s\S]{1,7}/g) || []) { w({ choices: [{ delta: { role: 'assistant', content: piece, phase: 'answer', status: 'typing' } }], response_id: rid, usage: { input_tokens: 1000, output_tokens: 20 } }); await sleep(2); }
      w({ choices: [{ delta: { role: 'assistant', content: '', phase: 'answer', status: 'finished' } }], response_id: rid });
      return res.end();
    }
    send(404, { success: false, data: { code: 'NotFound' } });
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  m = await startPersonalComputer({ PERSONALCOMPUTER_QWEN_URL: 'http://127.0.0.1:' + srv.address().port });
});
after(async () => { await m?.stop(); srv?.close(); });

const doneRun = evs => { const k = evs.findIndex(e => e.ev === 'run' && e.d.running === true); return k >= 0 && evs.slice(k).some(e => e.ev === 'run' && e.d.running === false); };
async function say(c, text) {
  const w = c.events(doneRun);
  await sleep(100);
  const r = await c.json('/api/chat', { text });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  return w;
}
const histOf = async c => { const me = (await c.json('/api/account', undefined, 'GET')).j.user; return JSON.parse(fs.readFileSync(chatFile(m.env.PERSONALCOMPUTER_DATA, me.id), 'utf8')); };
const logs = evs => evs.filter(e => e.ev === 'log').map(e => e.d);

test('разбор ответа: текст виден сразу, блоки вызовов вырезаются, выдуманные результаты не показываются', () => {
  const run = (s, step) => { let seen = ''; const P = callParser(t => { seen += t; }); for (let i = 0; i < s.length; i += step) P.push(s.slice(i, i + step)); return { seen, ...P.end() }; };
  for (const step of [1, 3, 50]) {
    const a = run('Сейчас посмотрю [ссылка](x) ~\n[TOOL CALL]\n{"name": "run_command", "arguments": {"action": "Смотрю", "command": "echo \\"}\\" [x]"}}\n[END TOOL CALL]\n[TOOL RESULT: run_command]\nвыдумка\n[END TOOL RESULT]\nГотово!', step);
    assert.equal(a.text, 'Сейчас посмотрю [ссылка](x) ~');
    assert.equal(a.seen.trim(), a.text);
    assert.equal(a.calls.length, 1);
    assert.deepEqual(JSON.parse(a.calls[0].function.arguments), { action: 'Смотрю', command: 'echo "}" [x]' });
    assert.doesNotMatch(a.seen, /выдумка|Готово|TOOL/);
    /* ```json вокруг, вариант маркера, аргументы строкой, два вызова подряд */
    const b = run('```json\n[tool_call]\n{"name":"read_file","arguments":{"path":"a"}}\n```\n[ TOOL CALLS ]\n```json\n{"function":{"name":"write_file","arguments":"{\\"path\\":\\"b\\",\\"content\\":\\"x\\"}"}}\n```', step);
    assert.equal(b.text, '');
    assert.deepEqual(b.calls.map(c => [c.function.name, JSON.parse(c.function.arguments).path]), [['read_file', 'a'], ['write_file', 'b']]);
    /* обычный текст со скобками остаётся как есть */
    assert.equal(run('Массив [1, 2] и [t', step).text, 'Массив [1, 2] и [t');
    /* обрезанный JSON — вызов с сырыми аргументами: агент скажет модели, что JSON битый */
    const d = run('[TOOL CALL]\n{"name":"write_file","arguments":{"content":"обре', step);
    assert.equal(d.calls[0].function.name, 'write_file');
    assert.throws(() => JSON.parse(d.calls[0].function.arguments));
  }
});

test('токен: как ни вставь — сохраняется сам токен', () => {
  assert.equal(parseToken('  Bearer ' + TOKEN + ' '), TOKEN);
  assert.equal(parseToken('"' + TOKEN + '"'), TOKEN);
  assert.equal(parseToken('acw_tc=1; token=' + TOKEN + '; x=2'), TOKEN);
  assert.equal(parseToken('{"token":"' + TOKEN + '"}'), TOKEN);
  assert.deepEqual(tokenInfo(TOKEN), { id: 'acc-1', exp: EXP });
});

test('настройки: токен Qwen, список моделей (только чат), размышление, срок токена', async () => {
  const c = await registered(m, 'qset');
  const none = await c.json('/api/models', { base: QWEN });
  assert.equal(none.status, 401); assert.equal(none.j.needKey, true);
  const bad = await c.json('/api/models', { base: QWEN, key: 'nope' });
  assert.equal(bad.status, 401); assert.match(bad.j.error, /Токен Qwen не подошёл или истёк/); assert.equal(bad.j.human, true);
  const r = await c.json('/api/models', { base: QWEN, key: 'Bearer ' + TOKEN });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.models, ['qwen3-max', 'qwen3-deep', 'qwen3-coder']);
  assert.deepEqual(r.j.qwen.map(x => [x.id, x.think, x.must]), [['qwen3-max', true, false], ['qwen3-deep', true, true], ['qwen3-coder', false, false]]);
  assert.equal(r.j.exp, EXP * 1000);
  const s = (await c.json('/api/settings', { base: QWEN + '/', key: 'Bearer ' + TOKEN, model: 'qwen3-max', think: true }, 'PUT')).j;
  assert.equal(s.base, QWEN); assert.equal(s.think, true); assert.equal(s.hasKey, true);
  assert.doesNotMatch(JSON.stringify(s), /eyJ/);
  /* сохранённый токен: список моделей без повторного ввода */
  assert.equal((await c.json('/api/models', { base: QWEN })).status, 200);
});

test('чат: один и тот же чат Qwen, отправляется только новое, инструменты агента работают, метка скрыта', async () => {
  const c = await registered(m, 'qchat');
  await c.json('/api/settings', { base: QWEN, key: TOKEN, model: 'qwen3-max', think: false }, 'PUT');
  Q.script = call => {
    if (/\[TOOL RESULT: run_command\]/.test(call.content)) return { text: 'Ядро: ' + /привет-из-шелла/.exec(call.content)?.[0] };
    if (/какое ядро/.test(call.content)) return { think: 'надо проверить', text: 'Проверю.\n[TOOL CALL]\n{"name": "run_command", "arguments": {"action": "Смотрю ядро", "command": "echo привет-из-шелла"}}\n[END TOOL CALL]\n[TOOL RESULT: run_command]\nLinux 1.0\n[END TOOL RESULT]' };
    return { text: 'Ответ на «' + call.content.split('\n').pop() + '»' };
  };
  const n0 = Q.calls.length, news0 = Q.news.length;
  const evs = await say(c, 'какое ядро?');
  const L = logs(evs);
  const tool = L.filter(e => e.kind === 'tool').at(-1);
  assert.equal(tool.name, 'run_command'); assert.equal(tool.label, 'Смотрю ядро'); assert.equal(tool.state, 'ok');
  const said = L.filter(e => e.kind === 'assistant').map(e => e.text);
  assert.deepEqual(said, ['Проверю.', 'Ядро: привет-из-шелла']);
  /* ни маркеров, ни выдуманного результата, ни второго варианта ответа, ни размышлений, ни поиска сайта */
  const deltas = evs.filter(e => e.ev === 'delta').map(e => e.d.d).join('');
  assert.doesNotMatch(deltas + said.join(''), /TOOL|Linux 1\.0|ЛИШНЕЕ|надо проверить|поиск сайта/);

  const calls = Q.calls.slice(n0);
  assert.equal(calls.length, 2);
  assert.equal(Q.news.length, news0 + 1, 'один новый чат Qwen');
  assert.equal(calls[0].parent, null);
  assert.equal(calls[1].chatId, calls[0].chatId);
  assert.equal(calls[1].parent, 'resp-' + (n0 + 1), 'продолжение от ответа (главного варианта)');
  /* первый запрос: инструкция, протокол инструментов и сообщение; второй — только результат */
  assert.match(calls[0].content, /^\[Инструкция[\s\S]*Personal Computer[\s\S]*## run_command[\s\S]*\[TOOL CALL\][\s\S]*\[Конец инструкции\]\n\nкакое ядро\?$/);
  assert.match(calls[0].content, /Встроенных инструментов чата Qwen здесь нет/);
  assert.doesNotMatch(calls[0].content, /## view_image/, 'картинки Qwen не видит — инструмента нет');
  assert.match(calls[1].content, /^\[TOOL RESULT: run_command\]\nпривет-из-шелла\n\[код выхода: 0\]\n\[END TOOL RESULT\]/);
  assert.doesNotMatch(calls[1].content, /Инструкция|какое ядро/);
  /* встроенное у Qwen выключено, размышление — по настройке; заголовки как у сайта */
  assert.equal(calls[0].fc.auto_search, false); assert.equal(calls[0].fc.thinking_enabled, false); assert.equal(calls[0].fc.thinking_mode, 'Fast');
  assert.equal(calls[0].model, 'qwen3-max');
  assert.equal(calls[0].headers.source, 'web'); assert.match(calls[0].headers.cookie, /^token=eyJ/);

  /* следующее сообщение — в тот же чат Qwen, без истории */
  await c.json('/api/settings', { think: true }, 'PUT');
  await say(c, 'а ещё?');
  const c3 = Q.calls.at(-1);
  assert.equal(c3.chatId, calls[0].chatId); assert.equal(c3.parent, 'resp-' + (n0 + 2));
  assert.equal(c3.content, 'а ещё?');
  assert.equal(c3.fc.thinking_enabled, true); assert.equal(c3.fc.thinking_mode, 'Thinking');
  assert.equal(Q.news.length, news0 + 1);

  /* метка чата — только в истории для модели, в журнале её нет */
  /* история пишется на диск с задержкой */
  let v, marks;
  for (let i = 0; i < 100; i++) { v = await histOf(c); marks = v.hist.filter(x => x._qw).map(x => x._qw); if (marks.length >= 3) break; await sleep(50); }
  assert.equal(marks.length, 3);
  assert.deepEqual([marks[2].c, marks[2].r, marks[2].a], [calls[0].chatId, 'resp-' + (n0 + 3), 'acc-1']);
  assert.doesNotMatch(JSON.stringify(v.log), /_qw|resp-|chat-\d/);

  /* модель придумала название чату — во временном чате Qwen, который сразу удалён */
  for (let i = 0; i < 100 && !Q.dels.length; i++) await sleep(50);
  assert.equal(Q.dels.length, 1);
  assert.notEqual(Q.dels[0], calls[0].chatId);
});

test('чат на сайте удалили или сменили аккаунт — новый чат Qwen со всей перепиской', async () => {
  const c = await registered(m, 'qgone');
  await c.json('/api/settings', { base: QWEN, key: TOKEN, model: 'qwen3-deep', think: false }, 'PUT');
  Q.script = call => ({ text: 'ок: ' + call.content.split('\n').pop() });
  await say(c, 'первое');
  const first = Q.calls.at(-1);
  /* модель без отключаемого размышления: thinking_enabled всё равно включён */
  assert.equal(first.fc.thinking_enabled, true);
  Q.chats.delete(first.chatId);
  const n0 = Q.calls.length;
  await say(c, 'второе');
  const fresh = Q.calls[n0];
  assert.equal(Q.calls.length, n0 + 1, 'отказ продолжить старый чат — и сразу новый');
  assert.equal(fresh.parent, null); assert.notEqual(fresh.chatId, first.chatId);
  assert.match(fresh.content, /^\[Инструкция[\s\S]*# Разговор до этого момента[\s\S]*### Пользователь\nпервое\n\n### Ты\nок: первое\n\n# Сейчас\nвторое$/);

  /* другой аккаунт — чаты прежнего ему не видны: сразу новый чат */
  await c.json('/api/settings', { base: QWEN, key: TOKEN2, model: 'qwen3-deep' }, 'PUT');
  await say(c, 'третье');
  const third = Q.calls.at(-1);
  assert.equal(third.parent, null); assert.notEqual(third.chatId, fresh.chatId);
  assert.match(third.content, /первое[\s\S]*второе[\s\S]*# Сейчас\nтретье$/);
});

test('истёк токен — понятная ошибка в чате', async () => {
  const c = await registered(m, 'qexp');
  await c.json('/api/settings', { base: QWEN, key: jwt({ id: 'old', exp: 1 }), model: 'qwen3-max' }, 'PUT');
  const evs = await say(c, 'привет');
  const err = logs(evs).find(e => e.kind === 'error');
  assert.ok(err, 'нет ошибки');
  assert.match(err.text, /^Токен Qwen не подошёл или истёк/);
});
