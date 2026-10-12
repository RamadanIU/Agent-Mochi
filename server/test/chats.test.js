import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeModel, startPersonalComputer, registered, sleep } from './helpers.js';
import { cleanTitle } from '../lib/agent.js';

let m, model;
const doneRun = evs => evs.some(e => e.ev === 'run' && e.d.running === false);
const flagged = async f => { for (let i = 0; i < 300 && !fs.existsSync(f); i++) await sleep(50); };
const list = async (c, q) => (await c.json('/api/chats' + (q ? '?q=' + encodeURIComponent(q) : ''), undefined, 'GET')).j;
/* сообщение в чат c → ждём конца задачи */
async function say(c, text, conv) {
  const w = c.events(evs => { const k = evs.findIndex(e => e.ev === 'run' && e.d.running === true); return k >= 0 && doneRun(evs.slice(k)); });
  await sleep(100);
  const r = await c.json('/api/chat', { text, c: conv });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  await w;
}
const waitFor = async (fn, ms = 5000) => { for (let i = 0; i < ms / 50; i++) { const v = await fn(); if (v) return v; await sleep(50); } return null; };

before(async () => {
  model = await fakeModel(async body => {
    const u = [...body.messages].reverse().find(x => x.role === 'user');
    if (u.content.startsWith('жди ')) await flagged(u.content.slice(4));
    return { text: 'Ответ на: ' + u.content };
  });
  m = await startPersonalComputer();
});
after(async () => { await m?.stop(); model?.close(); });

test('название от модели: без кавычек, рассуждений и «Название:»', () => {
  assert.equal(cleanTitle('«Тестовый чат».'), 'Тестовый чат');
  assert.equal(cleanTitle('<think>хм, о чём это…</think>\n\n**Название:** настройка nginx'), 'Настройка nginx');
  assert.equal(cleanTitle('<think>бесконечно думаю'), '');
  assert.ok(cleanTitle('очень '.repeat(30)).length <= 61);
});

test('история: первое сообщение — черновое название, после второго ответа — название от модели', async () => {
  const c = await registered(m, 'hist1');
  await c.json('/api/settings', { base: model.url, model: 'fake-1' }, 'PUT');
  assert.deepEqual((await list(c)).list, []);
  const t0 = model.titles.length;
  await say(c, 'Как   настроить nginx\nдля сайта?');
  let l = (await list(c)).list;
  assert.equal(l.length, 1);
  assert.equal(l[0].title, 'Как настроить nginx для сайта?');
  assert.equal(l[0].named, false);
  assert.equal(l[0].n, 2);
  assert.match(l[0].prev, /^Ответ на:/);
  await sleep(300);
  assert.equal(model.titles.length, t0, 'после первого ответа название не придумываем');
  await say(c, 'а https?');
  l = await waitFor(async () => { const x = (await list(c)).list; return x[0].named && x; });
  assert.ok(l, 'название не пришло');
  assert.equal(l[0].title, 'Тестовый чат');
  const req = model.titles.at(-1);
  assert.equal(req.model, 'fake-1');
  assert.match(req.messages[0].content, /название/);
  assert.match(req.messages[1].content, /Пользователь: Как настроить nginx[\s\S]*Ассистент: Ответ на/);
  /* дальше название не трогаем */
  const n = model.titles.length;
  await say(c, 'спасибо');
  await sleep(300);
  assert.equal(model.titles.length, n);
});

test('несколько чатов: порядок по последнему сообщению, у каждого свой разговор и поток', async () => {
  const c = await registered(m, 'hist2');
  await c.json('/api/settings', { base: model.url, model: 'fake-1' }, 'PUT');
  await say(c, 'первый чат');
  const a = (await list(c)).list[0].id;
  /* пустой новый чат один: второй раз — тот же */
  const b = (await c.json('/api/chats', {})).j.c;
  assert.equal((await c.json('/api/chats', {})).j.c, b);
  assert.notEqual(a, b);
  assert.equal((await list(c)).list.length, 1, 'пустой чат в истории не показываем');
  await say(c, 'второй чат', b);
  assert.deepEqual((await list(c)).list.map(x => x.id), [b, a]);
  /* модель видит только свой разговор */
  const msgs = model.calls.at(-1).body.messages.filter(x => x.role === 'user').map(x => x.content);
  assert.deepEqual(msgs, ['второй чат']);
  await say(c, 'снова первый', a);
  assert.deepEqual((await list(c)).list.map(x => x.id), [a, b]);
  assert.deepEqual(model.calls.at(-1).body.messages.filter(x => x.role === 'user').map(x => x.content), ['первый чат', 'снова первый']);
  /* поток показывает выбранный чат */
  const snap = async conv => (await c.events(e => e.some(x => x.ev === 'snap'), 5000)).find(e => e.ev === 'snap').d;
  const s1 = await new Promise((ok, no) => {
    const ac = new AbortController();
    fetch(m.base + '/api/stream?c=' + b, { headers: { cookie: c.cookie() }, signal: ac.signal }).then(async r => {
      const dec = new TextDecoder(); let buf = '';
      for await (const ch of r.body) { buf += dec.decode(ch, { stream: true }); const i = buf.indexOf('\n\n'); if (i >= 0) { ac.abort(); return ok(JSON.parse(buf.slice(0, i).match(/^data: (.*)$/m)[1])); } }
    }).catch(e => { if (!ac.signal.aborted) no(e); });
  });
  assert.equal(s1.c, b);
  assert.deepEqual(s1.log.filter(e => e.kind === 'user').map(e => e.text), ['второй чат']);
  /* без ?c= — последний открытый */
  assert.equal((await snap()).c, b);
  /* «Очистить чат» (и /new в Telegram) — новый чат, прошлые остаются */
  const r = await c.json('/api/chat/clear', {});
  assert.notEqual(r.j.c, a);
  assert.equal((await list(c)).list.length, 2);
  assert.equal((await snap()).log.length, 0);
});

test('пока агент работает в одном чате, в другой писать нельзя; события чужого чата не приходят', async () => {
  const c = await registered(m, 'hist3');
  await c.json('/api/settings', { base: model.url, model: 'fake-1' }, 'PUT');
  await say(c, 'чат А');
  const a = (await list(c)).list[0].id, b = (await c.json('/api/chats', {})).j.c;
  const flag = path.join(m.dir, 'hist3.flag');
  /* смотрим чат Б, пока агент работает в А */
  const ac = new AbortController(), evs = [];
  const watching = fetch(m.base + '/api/stream?c=' + b, { headers: { cookie: c.cookie() }, signal: ac.signal }).then(async r => {
    const dec = new TextDecoder(); let buf = '';
    for await (const ch of r.body) { buf += dec.decode(ch, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 2); const ev = (raw.match(/^event: (.*)$/m) || [])[1]; if (ev) evs.push({ ev, d: JSON.parse(raw.match(/^data: (.*)$/m)[1]) }); } }
  }).catch(() => {});
  await sleep(200);
  assert.equal((await c.json('/api/chat', { text: 'жди ' + flag, c: a })).status, 200);
  await waitFor(() => evs.some(e => e.ev === 'run' && e.d.running));
  const busy = await c.json('/api/chat', { text: 'в чат Б', c: b });
  assert.equal(busy.status, 409);
  assert.equal(busy.j.busy, true);
  assert.match(busy.j.error, /работает в чате «чат А»/);
  const st = await list(c);
  assert.equal(st.running, true); assert.equal(st.rc, a); assert.equal(st.rt, 'чат А');
  fs.writeFileSync(flag, '');
  await waitFor(() => evs.some(e => e.ev === 'run' && !e.d.running));
  ac.abort(); await watching;
  assert.ok(!evs.some(e => e.ev === 'log' || e.ev === 'delta'), 'чужие сообщения не пришли: ' + JSON.stringify(evs.map(e => e.ev)));
  assert.ok(evs.some(e => e.ev === 'run' && e.d.rc === a));
  /* агент свободен — теперь можно */
  await say(c, 'в чат Б', b);
  assert.equal((await list(c)).list[0].id, b);
});

test('переименование, поиск, удаление с возвратом', async () => {
  const c = await registered(m, 'hist4');
  await c.json('/api/settings', { base: model.url, model: 'fake-1' }, 'PUT');
  await say(c, 'рецепт борща');
  const a = (await list(c)).list[0].id;
  const b = (await c.json('/api/chats', {})).j.c;
  await say(c, 'погода в Казани', b);
  /* своё название модель не перебивает */
  assert.equal((await c.json('/api/chats/' + a, { title: '  Суп  ' }, 'PATCH')).status, 200);
  assert.equal((await c.json('/api/chats/' + a, { title: ' ' }, 'PATCH')).status, 400);
  await say(c, 'а свёкла?', a);
  await sleep(300);
  assert.equal((await list(c)).list.find(x => x.id === a).title, 'Суп');
  /* поиск: по названию и по тексту, с кусочком найденного */
  assert.deepEqual((await list(c, 'суп')).list.map(x => x.id), [a]);
  assert.deepEqual((await list(c, 'КАЗАН')).list.map(x => x.id), [b]);
  const f = (await list(c, 'на: ПОГОДА')).list;
  assert.deepEqual(f.map(x => x.id), [b]);
  assert.equal(f[0].hit, 'Ответ на: погода в Казани');
  assert.deepEqual((await list(c, 'нет такого')).list, []);
  /* удаление: пропадает сразу, вернуть можно */
  assert.equal((await c.json('/api/chats/' + a, undefined, 'DELETE')).status, 200);
  assert.deepEqual((await list(c)).list.map(x => x.id), [b]);
  assert.equal((await c.json('/api/chats/' + a + '/restore', {})).status, 200);
  assert.deepEqual((await list(c)).list.map(x => x.id), [a, b]);
  /* удалили активный чат — агент переходит в новый; после перезапуска удалённое стирается насовсем */
  const d = await c.json('/api/chats/' + a, undefined, 'DELETE');
  assert.notEqual(d.j.c, a);
  assert.equal((await c.json('/api/chat', { text: 'писать в удалённый', c: a })).status, 404);
  await m.restart();
  assert.equal((await c.json('/api/chats/' + a + '/restore', {})).status, 404);
  const uid = (await c.json('/api/me', undefined, 'GET')).j.user.id;
  assert.ok(!fs.existsSync(path.join(m.env.PERSONALCOMPUTER_DATA, 'users', uid, 'chats', a + '.json')));
  assert.deepEqual((await list(c)).list.map(x => x.id), [b]);
});

test('прежний единственный чат (chat.json) переезжает в историю', async () => {
  const c = await registered(m, 'hist5');
  const uid = (await c.json('/api/me', undefined, 'GET')).j.user.id, ud = path.join(m.env.PERSONALCOMPUTER_DATA, 'users', uid);
  m.proc.kill('SIGTERM'); await new Promise(r => m.proc.once('exit', r));
  fs.rmSync(path.join(ud, 'chats'), { recursive: true, force: true });
  fs.rmSync(path.join(ud, 'chats.json'), { force: true });
  const t = Date.now() - 3600e3;
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'chat.json'), JSON.stringify({ hist: [{ role: 'user', content: 'старый вопрос' }, { role: 'assistant', content: 'старый ответ' }], seq: 2, run: null, cwd: null, sess: 'x',
    log: [{ kind: 'user', text: 'старый вопрос', seq: 1, t }, { kind: 'assistant', text: 'старый ответ', seq: 2, t: t + 1000 }] }));
  await m.restart();
  const l = (await list(c)).list;
  assert.equal(l.length, 1);
  assert.equal(l[0].title, 'старый вопрос');
  assert.equal(l[0].last, t + 1000);
  assert.ok(!fs.existsSync(path.join(ud, 'chat.json')));
  await c.json('/api/settings', { base: model.url, model: 'fake-1' }, 'PUT');
  await say(c, 'продолжаем');
  assert.deepEqual(model.calls.at(-1).body.messages.filter(x => x.role === 'user').map(x => x.content), ['старый вопрос', 'продолжаем']);
});
