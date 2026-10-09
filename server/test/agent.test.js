import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeModel, startMochi, registered, client, sleep } from './helpers.js';

let m, model;
const doneRun = evs => evs.some(e => e.ev === 'run' && e.d.running === false);

before(async () => {
  /* сценарий: команда → файл → ответ; дальше — по тексту последнего сообщения */
  model = await fakeModel(async (body, i) => {
    const last = body.messages[body.messages.length - 1];
    const u = [...body.messages].reverse().find(x => x.role === 'user');
    const ut = typeof u.content === 'string' ? u.content : u.content[0].text;
    if (ut.startsWith('посмотри')) return { tools: [{ name: 'view_image', args: { path: 'pic.png' } }, { name: 'view_image', args: { path: 'note.txt' } }] };
    if (ut.startsWith('[Картинки из view_image')) {
      const img = u.content.find?.(p => p.type === 'image_url'), tool = body.messages.filter(x => x.role === 'tool').slice(-2);
      return { text: img ? 'вижу ' + img.image_url.url.slice(0, 22) + ' | ' + tool.map(x => x.content).join(' | ') : 'не вижу' };
    }
    if (ut.startsWith('цикл')) return body.messages.slice(body.messages.lastIndexOf(u)).filter(x => x.role === 'tool').length < 4 ? { tools: [{ name: 'run_command', args: { action: 'Кручусь', command: 'true' } }] } : { text: 'цикл готов' };
    if (ut.startsWith('спать')) return last.role === 'user' ? { tools: [{ name: 'run_command', args: { action: 'Сплю', command: 'sleep 30; echo проснулась' } }] } : { text: 'остановлена?' };
    if (ut.startsWith('медленно')) return last.role === 'user' ? { tools: [{ name: 'run_command', args: { action: 'Долго', command: 'sleep 2; echo ok > slow.txt' } }] } : { text: 'медленно готово' };
    if (ut.startsWith('украсть')) return last.role === 'user' ? { tools: [{ name: 'run_command', args: { action: 'Ссылка', command: `ln -sf ${process.env.__DATA}/users.json steal.json` } }] } : last.content.includes('steal') || last.content.includes('код выхода') && !last.content.includes('отправлен') && !/рабочей папки/.test(last.content) ? { tools: [{ name: 'send_file', args: { path: 'steal.json' } }] } : { text: 'итог: ' + last.content };
    if (last.role === 'user') return { text: 'Сейчас посмотрю', tools: [{ name: 'run_command', args: { action: 'Пишу файл', command: 'cd outbox && echo привет > hi.txt && pwd' } }] };
    if (last.content.includes('[код выхода: 0]') && !last.content.includes('отправлен')) return { tools: [{ name: 'send_file', args: { path: 'hi.txt', note: 'файлик' } }] };
    return { text: 'Готово ^_^' };
  });
  m = await startMochi();
  process.env.__DATA = m.env.MOCHI_DATA;
});
after(async () => { await m?.stop(); model?.close(); });

test('без входа API закрыт, CSRF-заголовок обязателен', async () => {
  const c = client(m.base);
  assert.equal((await c('/api/stream')).status, 401);
  assert.equal((await c('/api/settings')).status, 401);
  const r = await fetch(m.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x","password":"y"}' });
  assert.equal(r.status, 403);
  const r2 = await fetch(m.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mochi': '1', origin: 'https://evil.example' }, body: '{"name":"x","password":"y"}' });
  assert.equal(r2.status, 403);
});

test('регистрация только по приглашению; вход и выход', async () => {
  const c = client(m.base);
  const bad = await c.json('/api/register', { name: 'eve', password: 'password123', invite: 'nope-nope-nope' });
  assert.equal(bad.status, 400);
  const c2 = await registered(m, 'alice');
  assert.equal((await c2.json('/api/me', undefined, 'GET')).j.user.name, 'alice');
  /* приглашение одноразовое — повторная регистрация с тем же кодом не пройдёт (проверено внутри registered через новый код) */
  const wrong = await c.json('/api/login', { name: 'alice', password: 'wrongpass' });
  assert.equal(wrong.status, 401);
  const ok = await c.json('/api/login', { name: 'ALICE', password: 'password123' });
  assert.equal(ok.status, 200);
  await c.json('/api/logout', {});
  assert.equal((await c('/api/me')).status, 401);
});

test('агент выполняет команду и отдаёт файл; работа идёт без открытого чата', async () => {
  const c = await registered(m, 'bob');
  await c.json('/api/settings', { base: model.url, key: 'sk-test', model: 'fake-1' }, 'PUT');
  const s = (await c.json('/api/settings', undefined, 'GET')).j;
  assert.equal(s.hasKey, true); assert.equal(s.key, undefined);
  assert.equal((await c.json('/api/chat', { text: 'сделай файл' })).status, 200);
  /* никто не слушает поток — ждём и только потом подключаемся */
  await sleep(1500);
  const evs = await c.events(evs => evs.some(e => e.ev === 'snap' && !e.d.running));
  const log = evs.find(e => e.ev === 'snap').d.log;
  assert.deepEqual(log.map(e => e.kind), ['user', 'assistant', 'tool', 'tool', 'file', 'assistant']);
  assert.equal(log[2].state, 'ok');
  assert.match(log[2].hint, /echo привет/);
  const file = log.find(e => e.kind === 'tool' && e.name === 'send_file');
  assert.equal(file.state, 'ok');
  assert.equal(log[5].text, 'Готово ^_^');
  assert.equal(model.calls.at(-1).auth, 'Bearer sk-test');
  /* ключ не попадает в журнал/поток */
  assert.ok(!JSON.stringify(evs).includes('sk-test'));
  const st = JSON.parse(fs.readFileSync(path.join(m.env.MOCHI_DATA, 'users', (await c.json('/api/me', undefined, 'GET')).j.user.id, 'chat.json')));
  assert.ok(st.log.some(e => e.kind === 'file'));
  const snapFile = (await c.events(e => e.some(x => x.ev === 'snap'))).find(e => e.ev === 'snap').d.log.find(e => e.kind === 'file');
  assert.equal(snapFile.name, 'hi.txt');
  const dl = await c('/api/files/' + snapFile.fid);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal((await dl.text()).trim(), 'привет');
  /* чужой пользователь файл не скачает */
  const other = await registered(m, 'carol');
  assert.equal((await other('/api/files/' + snapFile.fid)).status, 404);
  /* текущая папка запомнилась (cd outbox) */
  assert.match(st.cwd, /bob\/outbox$/);
});

test('live-поток: дельты текста, шаги и окончание', async () => {
  const c = await registered(m, 'dan');
  await c.json('/api/settings', { base: model.url, model: 'fake-1' }, 'PUT');
  const p = c.events(doneRun);
  await sleep(200);
  await c.json('/api/chat', { text: 'ещё раз' });
  const evs = await p;
  assert.ok(evs.some(e => e.ev === 'delta'));
  assert.ok(evs.some(e => e.ev === 'log' && e.d.kind === 'tool' && e.d.state === 'run'));
  assert.ok(evs.some(e => e.ev === 'run' && e.d.running === true));
  /* второе сообщение во время работы — 409 */
});

test('лимит шагов: из настроек, выключается', async () => {
  const c = await registered(m, 'lim');
  assert.equal((await c.json('/api/settings', { maxSteps: 0 }, 'PUT')).status, 400);
  assert.equal((await c.json('/api/settings', { maxSteps: 'много' }, 'PUT')).status, 400);
  const s = (await c.json('/api/settings', { base: model.url, model: 'fake-1', maxSteps: 2 }, 'PUT')).j;
  assert.equal(s.stepLimit, true); assert.equal(s.maxSteps, 2); assert.equal(s.maxStepsDef, 100);
  let p = c.events(doneRun);
  await sleep(200);
  await c.json('/api/chat', { text: 'цикл' });
  let evs = await p;
  assert.match(evs.filter(e => e.ev === 'log' && e.d.kind === 'error').at(-1).d.text, /2 шагов подряд/);
  assert.equal((await c.json('/api/settings', { stepLimit: false }, 'PUT')).j.stepLimit, false);
  p = c.events(doneRun);
  await sleep(200);
  await c.json('/api/chat', { text: 'цикл ещё' });
  evs = await p;
  assert.equal(evs.filter(e => e.ev === 'log' && e.d.kind === 'assistant').at(-1).d.text, 'цикл готов');
});

test('остановка убивает команду', async () => {
  const c = await registered(m, 'erin');
  await c.json('/api/settings', { base: model.url, model: 'fake-1' }, 'PUT');
  const p = c.events(doneRun, 20000);
  await sleep(200);
  await c.json('/api/chat', { text: 'спать' });
  await sleep(1200);
  assert.equal((await c.json('/api/chat', { text: 'ещё' })).status, 409);
  const t0 = Date.now();
  await c.json('/api/chat/stop', {});
  const evs = await p;
  assert.ok(Date.now() - t0 < 8000);
  const tool = evs.filter(e => e.ev === 'log' && e.d.kind === 'tool').at(-1).d;
  assert.equal(tool.state, 'bad');
  assert.ok(evs.some(e => e.ev === 'log' && e.d.kind === 'note' && /Остановлено/.test(e.d.text)));
});

test('send_file не отдаёт файлы вне рабочей папки (симлинк на данные сервера)', async () => {
  const c = await registered(m, 'frank');
  await c.json('/api/settings', { base: model.url, model: 'fake-1' }, 'PUT');
  const p = c.events(doneRun, 15000);
  await sleep(200);
  await c.json('/api/chat', { text: 'украсть' });
  const evs = await p;
  const last = evs.filter(e => e.ev === 'log' && e.d.kind === 'assistant').at(-1).d.text;
  assert.match(last, /рабочей папки/);
  assert.ok(!evs.some(e => e.ev === 'log' && e.d.kind === 'file'));
});

test('view_image: картинка с диска приходит модели следующим сообщением', async () => {
  const c = await registered(m, 'ivy');
  await c.json('/api/settings', { base: model.url, model: 'fake-1' }, 'PUT');
  const d = path.join(m.env.MOCHI_WORK, 'ivy');
  fs.mkdirSync(d, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(d, 'pic.png'), png);
  fs.writeFileSync(path.join(d, 'note.txt'), 'просто текст');
  const p = c.events(doneRun, 15000);
  await sleep(200);
  await c.json('/api/chat', { text: 'посмотри картинку' });
  const evs = await p;
  const last = evs.filter(e => e.ev === 'log' && e.d.kind === 'assistant').at(-1).d.text;
  assert.match(last, /^вижу data:image\/png;base64,/);
  assert.match(last, /pic\.png \(\d+ Б\) открыта/);
  assert.match(last, /Ошибка: note\.txt: не PNG, JPEG, GIF или WebP/);
  const tools = evs.filter(e => e.ev === 'log' && e.d.kind === 'tool' && e.d.state !== 'run').map(e => e.d);
  assert.deepEqual(tools.map(t => [t.label, t.state]), [['Смотрю картинку: pic.png', 'ok'], ['Смотрю картинку: note.txt', 'bad']]);
  /* картинка ушла модели целиком, а в системной подсказке есть про view_image */
  const req = model.calls.at(-1).body;
  assert.equal(req.messages.at(-1).content.find(x => x.type === 'image_url').image_url.url, 'data:image/png;base64,' + png.toString('base64'));
  assert.match(req.messages[0].content, /view_image/);
  assert.ok(req.tools.some(t => t.function.name === 'view_image'));
});

test('загрузка файла в inbox и сообщение с ним', async () => {
  const c = await registered(m, 'gina');
  const r = await c('/api/upload?name=' + encodeURIComponent('../../etc/отчёт.txt'), { method: 'POST', body: 'данные' });
  const f = await r.json();
  assert.equal(r.status, 200);
  assert.equal(f.name, '_.._etc_отчёт.txt');
  assert.ok(f.path.startsWith(path.join(m.env.MOCHI_WORK, 'gina', 'inbox') + '/'));
  assert.equal(fs.readFileSync(f.path, 'utf8'), 'данные');
  const r2 = await c('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: 'x' });
  assert.match((await r2.json()).name, /\(2\)/);
});

test('после перезапуска сервера незаконченная задача продолжается', async () => {
  const c = await registered(m, 'hank');
  await c.json('/api/settings', { base: model.url, model: 'fake-1' }, 'PUT');
  await c.json('/api/chat', { text: 'медленно' });
  await sleep(700);
  await m.restart();
  /* cookie остаётся валидной: сессии на диске */
  const evs = await c.events(evs => evs.some(e => e.ev === 'log' && e.d.kind === 'assistant' && /медленно готово/.test(e.d.text)) || evs.some(e => e.ev === 'snap' && e.d.log.some(x => /медленно готово/.test(x.text || ''))), 20000);
  const all = JSON.stringify(evs);
  assert.match(all, /Сервер перезапускался/);
});

test('страница отдаётся с режимом сервера и строгим CSP', async () => {
  const r = await fetch(m.base + '/');
  const t = await r.text();
  assert.match(t, /<meta name="mochi-server" content="1">/);
  assert.match(t, /srv\/client\.js/);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'sha256-/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.equal((await fetch(m.base + '/../server/lib/auth.js')).status, 404);
  assert.equal((await fetch(m.base + '/server/lib/auth.js')).status, 404);
  assert.equal((await fetch(m.base + '/term/')).status, 401);
});
