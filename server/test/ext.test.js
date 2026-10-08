import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeModel, startMochi, registered } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let m, model, mcpHttp, mcpSrv, c;
const seen = { auth: [] };
const doneRun = evs => evs.some(e => e.ev === 'run' && e.d.running === false);
const names = body => (body.tools || []).map(t => t.function.name);
const sys = body => body.messages[0].content;
const lastReq = () => model.calls[model.calls.length - 1].body;

before(async () => {
  model = await fakeModel(async body => {
    const last = body.messages[body.messages.length - 1];
    const u = [...body.messages].reverse().find(x => x.role === 'user');
    const ut = typeof u.content === 'string' ? u.content : u.content[0].text;
    const first = last.role === 'user';
    const done = { text: 'итог: ' + last.content };
    if (ut.startsWith('включи себе'))  return first ? { tools: [{ name: 'mcp_manage', args: { action: 'enable', name: 'run_command' } }] } : done;
    if (ut.startsWith('выключено')) return first ? { tools: [{ name: 'run_command', args: { action: 'x', command: 'echo should-not-run' } }] } : done;
    if (ut.startsWith('навык')) return first ? { tools: [{ name: 'skill', args: { name: 'greet' } }] } : done;
    if (ut.startsWith('создай навык')) return first ? { tools: [{ name: 'skills_manage', args: { action: 'create', name: 'notes', description: 'Как вести заметки', instructions: 'Пиши кратко.' } }] } : done;
    if (ut.startsWith('mcp')) {
      if (first) return { tools: [{ name: 'mcp_connect', args: { server: 'fake' } }] };
      if (last.content.startsWith('Подключила')) return { tools: [{ name: 'fake__echo', args: { text: 'hi' } }] };
      return done;
    }
    if (ut.startsWith('http')) {
      if (first) return { tools: [{ name: 'mcp_manage', args: { action: 'add', name: 'remote', url: mcpHttp, headers: { Authorization: 'Bearer secret-token-123456' }, lazy: false } }] };
      if (last.content.includes('подключён')) return { tools: [{ name: 'remote__ping', args: {} }] };
      return done;
    }
    return { text: 'ок' };
  });
  /* HTTP-сервер MCP: отвечает обычным JSON */
  const srv = mcpSrv = http.createServer(async (req, res) => {
    let b = ''; for await (const ch of req) b += ch;
    seen.auth.push(req.headers.authorization);
    const msg = JSON.parse(b || '{}');
    if (msg.id === undefined) { res.writeHead(202); return res.end(); }
    const result = msg.method === 'initialize' ? { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'remote' } }
      : msg.method === 'tools/list' ? { tools: [{ name: 'ping', description: 'Пинг', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: 'PONG' }] };
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess1' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  mcpHttp = 'http://127.0.0.1:' + srv.address().port + '/mcp';
  m = await startMochi();
  c = await registered(m, 'ext');
  await c.json('/api/settings', { base: model.url, key: 'k', model: 'fake-1', search: false }, 'PUT');
});
after(async () => { await m?.stop(); model?.close(); mcpSrv?.close(); });

/* отправить сообщение (после подписки на поток) и дождаться конца задачи; → последний ответ или ошибка */
async function ask(text) {
  let ready; const rp = new Promise(r => ready = r);
  const w = c.events(evs => {
    if (evs.some(e => e.ev === 'snap')) ready();
    const k = evs.findIndex(e => e.ev === 'run' && e.d.running === true);
    return k >= 0 && doneRun(evs.slice(k));
  }, 20000);
  await rp;
  assert.equal((await c.json('/api/chat', { text })).status, 200);
  const evs = await w;
  return evs.filter(e => e.ev === 'log' && (e.d.kind === 'assistant' || e.d.kind === 'error')).map(e => e.d.text).pop();
}

test('выключенный инструмент не уходит в модель и не выполняется', async () => {
  const cat = (await c.json('/api/tools', undefined, 'GET')).j;
  assert.ok(cat.builtin.some(t => t.name === 'run_command' && t.on && t.size > 0));
  assert.ok(cat.builtin.some(t => t.name === 'telegram_send'));
  await c.json('/api/tools', { tools: { run_command: false, telegram_connect: false, telegram_status: false, telegram_send: false, telegram_notify_mode: false, telegram_disconnect: false } }, 'PUT');
  const out = await ask('выключено: запусти команду');
  const req = model.calls[model.calls.length - 2].body;
  assert.ok(!names(req).includes('run_command'));
  assert.ok(!names(req).some(n => n.startsWith('telegram_')));
  assert.match(sys(req), /Выключено пользователем: run_command, telegram_connect[^\n]*только он сам/);
  assert.doesNotMatch(sys(req), /BotFather/);
  assert.match(out, /сейчас нет/);
  assert.ok(!fs.readdirSync(path.join(m.env.MOCHI_WORK, 'ext')).includes('should-not-run'));
  const cat2 = (await c.json('/api/tools', undefined, 'GET')).j;
  assert.equal(cat2.builtin.find(t => t.name === 'run_command').on, false);
  /* агент не может включить встроенный инструмент сам */
  assert.match(await ask('включи себе shell'), /только пользователь/);
  assert.equal((await c.json('/api/tools', undefined, 'GET')).j.builtin.find(t => t.name === 'run_command').on, false);
  await c.json('/api/tools', { tools: { run_command: true } }, 'PUT');
  await c.json('/api/chat/clear', {});
});

test('навык: в подсказке только имя, описание и текст — по вызову skill', async () => {
  const bad = await c.json('/api/skills', { name: 'Bad Name!', description: '', instructions: '' });
  assert.equal(bad.status, 400);
  const r = await c.json('/api/skills', { name: 'greet', description: 'Как здороваться с гостями', instructions: 'СЕКРЕТНЫЙ-ТЕКСТ-ИНСТРУКЦИИ: всегда говори «привет».' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.ok(fs.existsSync(path.join(m.env.MOCHI_WORK, 'ext', 'skills', 'greet', 'SKILL.md')));
  fs.writeFileSync(path.join(m.env.MOCHI_WORK, 'ext', 'skills', 'greet', 'helper.sh'), 'echo hi');
  const out = await ask('навык: поздоровайся');
  const req = model.calls[model.calls.length - 2].body;
  assert.ok(names(req).includes('skill'));
  assert.match(sys(req), /Навыки[^\n]*: greet\./);
  assert.doesNotMatch(JSON.stringify(req), /СЕКРЕТНЫЙ-ТЕКСТ|Как здороваться/);
  assert.match(out, /СЕКРЕТНЫЙ-ТЕКСТ-ИНСТРУКЦИИ/);
  assert.match(out, /helper\.sh/);
  /* выключили — пропал и из подсказки, и инструмент skill (других навыков нет) */
  assert.equal((await c.json('/api/skills/greet', { on: false })).status, 200);
  await ask('просто привет');
  assert.doesNotMatch(sys(lastReq()), /greet/);
  assert.ok(!names(lastReq()).includes('skill'));
  assert.equal((await c.json('/api/skills/greet', undefined, 'GET')).j.raw.includes('description:'), true);
  await c.json('/api/skills/greet', { on: true });
  await c.json('/api/chat/clear', {});
});

test('агент сам создаёт навык; навыки можно удалить', async () => {
  const out = await ask('создай навык заметок');
  assert.match(out, /сохранён/);
  const sk = (await c.json('/api/skills', undefined, 'GET')).j.skills;
  assert.ok(sk.some(k => k.name === 'notes' && k.desc === 'Как вести заметки' && k.on));
  assert.equal((await c('/api/skills/notes', { method: 'DELETE' })).status, 200);
  assert.ok(!fs.existsSync(path.join(m.env.MOCHI_WORK, 'ext', 'skills', 'notes')));
  /* из формы: кириллица в имени — транслитом; занятое имя не перезаписывается молча */
  const ru = await c.json('/api/skills', { name: 'Отчёт за неделю', description: 'Еженедельный отчёт', instructions: 'По шаблону.', create: true });
  assert.equal(ru.status, 200, JSON.stringify(ru.j));
  assert.equal(ru.j.name, 'otchyot-za-nedelyu');
  const dup = await c.json('/api/skills', { name: 'otchyot-za-nedelyu', description: 'другое', instructions: 'другое', create: true });
  assert.equal(dup.status, 400);
  assert.match(dup.j.error, /уже есть/);
  assert.equal((await c('/api/skills/otchyot-za-nedelyu', { method: 'DELETE' })).status, 200);
  /* управление навыками можно выключить — инструмента не станет */
  await c.json('/api/tools', { tools: { skills_manage: false } }, 'PUT');
  await ask('просто привет');
  assert.ok(!names(lastReq()).includes('skills_manage'));
  assert.ok(names(lastReq()).includes('mcp_manage'));
  await c.json('/api/tools', { tools: { skills_manage: true } }, 'PUT');
  await c.json('/api/chat/clear', {});
});

test('stdio MCP: по запросу — в подсказке одна строка, инструменты после mcp_connect', async () => {
  const r = await c.json('/api/mcp', { name: 'fake', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(here, 'fixtures', 'fake-mcp.js'))}`, env: 'FAKE_KEY=k-123', description: 'тестовый сервер' });
  assert.equal(r.status, 200); assert.equal(r.j.err, null);
  const cat = (await c.json('/api/tools', undefined, 'GET')).j;
  const f = cat.mcp.find(x => x.name === 'fake');
  assert.deepEqual(f.tools.map(t => t.name), ['echo', 'add']);
  assert.deepEqual(f.env, ['FAKE_KEY']); assert.equal(JSON.stringify(cat).includes('k-123'), false);
  assert.equal(f.lazy, true);
  /* выключим один инструмент сервера */
  await c.json('/api/mcp/fake', { tools: { add: false } });
  const out = await ask('mcp: повтори hi');
  const i = model.calls.length;
  const r0 = model.calls[i - 3].body, r1 = model.calls[i - 2].body;
  assert.ok(names(r0).includes('mcp_connect')); assert.ok(!names(r0).includes('fake__echo'));
  assert.match(sys(r0), /fake — тестовый сервер \(1\)/);
  assert.ok(names(r1).includes('fake__echo')); assert.ok(!names(r1).includes('fake__add'));
  assert.match(r1.messages[r1.messages.length - 1].content, /FAKE-HINT/);
  assert.match(out, /ECHO:hi:k-123/);
  /* после очистки чата сервер снова «по запросу» */
  await c.json('/api/chat/clear', {});
  await ask('просто привет');
  assert.ok(!names(lastReq()).includes('fake__echo'));
  /* выключенный сервер не упоминается вовсе */
  await c.json('/api/mcp/fake', { on: false });
  await ask('просто привет');
  assert.ok(!names(lastReq()).includes('mcp_connect'));
  assert.doesNotMatch(sys(lastReq()), /fake/);
  assert.equal((await c('/api/mcp/fake', { method: 'DELETE' })).status, 200);
  await c.json('/api/chat/clear', {});
});

test('HTTP MCP подключает сам агент: ключ сохраняется на сервере и вычищается из истории', async () => {
  const out = await ask('http: подключи сервер');
  assert.match(out, /PONG/);
  assert.ok(seen.auth.includes('Bearer secret-token-123456'));
  const req = lastReq();
  assert.ok(names(req).includes('remote__ping'));
  assert.doesNotMatch(JSON.stringify(req.messages), /secret-token-123456/);
  const cat = (await c.json('/api/tools', undefined, 'GET')).j;
  const r = cat.mcp.find(x => x.name === 'remote');
  assert.deepEqual(r.headers, ['Authorization']); assert.equal(r.lazy, false);
  assert.doesNotMatch(JSON.stringify(cat), /secret-token/);
  const log = JSON.parse(fs.readFileSync(path.join(m.env.MOCHI_DATA, 'users', fs.readdirSync(path.join(m.env.MOCHI_DATA, 'users'))[0], 'chat.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(log), /secret-token-123456/);
});
