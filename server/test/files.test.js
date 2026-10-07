/* Файловые инструменты целиком: модель → агент → исполнитель → диск, и протокол исполнителя через unix-сокет */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fakeModel, startMochi, registered } from './helpers.js';
import { startRunner } from '../lib/runner.js';

let m, model;
const doneRun = evs => evs.some(e => e.ev === 'run' && e.d.running === false);

/* сценарий: шаг выбирается по числу ответов инструментов после последнего сообщения пользователя */
const STEPS = [
  { name: 'run_command', args: { action: 'Создаю файл', command: "printf 'старое\\n' > exist.txt" } },
  { name: 'write_file', args: { path: 'exist.txt', content: 'новое\n' } },
  { name: 'write_file', args: { path: 'src/app.js', content: 'const a = 1;\nconsole.log(a);\n' } },
  { name: 'read_file', args: { path: 'src/app.js' } },
  { name: 'read_file', args: { path: 'src/app.js' } },
  { name: 'edit_file', args: { path: 'src/app.js', old_string: 'const a = 1;', new_string: 'const a = 2;' } },
  { name: 'read_file', args: { path: 'exist.txt' } },
  { name: 'write_file', args: { path: 'exist.txt', content: 'новое\n' } },
  { name: 'edit_file', args: { path: 'src/app.js', old_string: 'console.log(a);', new_string: '// ... остальное без изменений ...' } },
  { name: 'edit_file', args: { path: 'src/app.js', old_string: 'console.log(a);', new_string: '// ... остальное без изменений ...' } },
];

before(async () => {
  model = await fakeModel(async body => {
    const msgs = body.messages, u = msgs.findLastIndex(x => x.role === 'user');
    const n = msgs.slice(u + 1).filter(x => x.role === 'tool').length;
    return n < STEPS.length ? { tools: [STEPS[n]] } : { text: 'готово' };
  });
  m = await startMochi();
});
after(async () => { await m?.stop(); model?.close(); });

test('read_file / edit_file / write_file через агента: защита от перезаписи, повторного чтения и заглушек', async () => {
  const c = await registered(m, 'filer');
  await c.json('/api/settings', { base: model.url, model: 'fake-1' }, 'PUT');
  const p = c.events(doneRun, 20000);
  await c.json('/api/chat', { text: 'поработай с файлами' });
  const evs = await p;
  const last = model.calls.at(-1).body, out = last.messages.filter(x => x.role === 'tool').map(x => x.content);
  /* инструменты и подсказка */
  const names = last.tools.map(t => t.function.name);
  for (const n of ['read_file', 'edit_file', 'write_file']) assert.ok(names.includes(n), n);
  assert.match(last.messages[0].content, /правь через edit_file/);
  /* файл, созданный командой и не прочитанный, перезаписать нельзя */
  assert.match(out[1], /^Ошибка: exist\.txt уже существует \(строк: 1, .*\), а ты его не читала/);
  assert.match(out[2], /^Создан src\/app\.js: строк 2/);
  assert.equal(out[3], '1\tconst a = 1;\n2\tconsole.log(a);');
  assert.match(out[4], /^\[src\/app\.js: файл не менялся с прошлого чтения — строки 1–2 уже есть выше/);
  assert.match(out[5], /^Изменён src\/app\.js \(строк: 2\)\.\n\[строка 1\]\n1\tconst a = 2;/);
  assert.equal(out[6], '1\tстарое');
  assert.match(out[7], /^Перезаписан exist\.txt: строк 1 → 1/);
  assert.match(out[8], /^Ошибка: похоже, вместо кода стоит заглушка/);
  /* та же правка повторно — модель настаивает, значит это не сокращение */
  assert.match(out[9], /^Изменён src\/app\.js/);
  const dir = path.join(m.env.MOCHI_WORK, 'filer');
  assert.equal(fs.readFileSync(path.join(dir, 'exist.txt'), 'utf8'), 'новое\n');
  assert.equal(fs.readFileSync(path.join(dir, 'src/app.js'), 'utf8'), 'const a = 2;\n// ... остальное без изменений ...\n');
  /* шаги на экране: понятные подписи, путь в подсказке, ошибки помечены */
  const tools = evs.filter(e => e.ev === 'log' && e.d.kind === 'tool' && e.d.state !== 'run').map(e => e.d);
  const w = tools.find(t => t.name === 'write_file');
  assert.equal(w.label, 'Пишу файл: exist.txt'); assert.equal(w.hint, 'exist.txt'); assert.equal(w.state, 'bad');
  assert.ok(tools.some(t => t.label === 'Правлю файл: app.js' && t.state === 'ok'));
  assert.ok(tools.some(t => t.label === 'Читаю файл: app.js'));
});

test('выключенные пользователем файловые инструменты не уходят модели и пропадают из подсказки', async () => {
  const c = await registered(m, 'nofiles');
  await c.json('/api/settings', { base: model.url, model: 'fake-1' }, 'PUT');
  const cat = (await c.json('/api/tools', undefined, 'GET')).j;
  assert.deepEqual(cat.builtin.filter(t => t.group === 'Файлы').map(t => t.name), ['read_file', 'edit_file', 'write_file']);
  await c.json('/api/tools', { tools: { read_file: false, edit_file: false, write_file: false } }, 'PUT');
  const n0 = model.calls.length, p = c.events(doneRun, 20000);
  await c.json('/api/chat', { text: 'ещё раз' });
  await p;
  const body = model.calls[n0].body;
  assert.ok(!body.tools.some(t => /_file$/.test(t.function.name) && t.function.name !== 'send_file'));
  assert.doesNotMatch(body.messages[0].content, /правь через edit_file/);
  assert.match(body.messages[0].content, /Выключено пользователем: read_file, edit_file, write_file/);
  /* модель «вспомнила» выключенный инструмент — вызов не выполняется */
  const res = model.calls.at(-1).body.messages.filter(x => x.role === 'tool');
  assert.ok(res.some(x => /инструмента write_file сейчас нет/.test(x.content)));
});

test('исполнитель: файловые операции по unix-сокету', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-runner-')), sock = path.join(dir, 'r.sock');
  const srv = startRunner(sock);
  await new Promise(ok => srv.once('listening', ok));
  const c = net.createConnection(sock);
  const call = msg => new Promise(ok => {
    let buf = '';
    const on = d => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { c.off('data', on); ok(JSON.parse(buf.slice(0, i))); } };
    c.on('data', on);
    c.write(JSON.stringify(msg) + '\n');
  });
  try {
    const w = await call({ id: 1, op: 'file', fop: 'write', path: 'a.txt', cwd: dir, content: 'раз\n' });
    assert.equal(w.id, 1); assert.equal(w.op, 'file'); assert.match(w.text, /^Создан a\.txt/);
    const e = await call({ id: 2, op: 'file', fop: 'edit', path: 'a.txt', cwd: dir, edits: [{ old_string: 'раз', new_string: 'два' }] });
    assert.match(e.text, /^Изменён a\.txt/);
    const r = await call({ id: 3, op: 'file', fop: 'read', path: path.join(dir, 'a.txt') });
    assert.equal(r.text, '1\tдва'); assert.equal(r.real, fs.realpathSync(path.join(dir, 'a.txt')));
    assert.match((await call({ id: 4, op: 'file', fop: 'read', path: '' })).err, /нет параметра path/);
  } finally {
    c.destroy(); srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
