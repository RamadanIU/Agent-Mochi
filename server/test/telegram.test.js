import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fakeModel, startMochi, registered, sleep } from './helpers.js';

const TOKEN = '123456789:AAEhBP0av18ZzsZiYQXbKBYWxx2ahfL0lzw';
let m, model, tg;

/* фальшивый api.telegram.org: очередь обновлений + журнал отправленного */
async function fakeTelegram() {
  const st = { updates: [], sent: [], id: 1, waiters: [] };
  const srv = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const mm = req.url.match(/^\/bot([^/]+)\/(\w+)/);
    const reply = r => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); };
    if (!mm || mm[1] !== TOKEN) return reply({ ok: false, error_code: 401, description: 'Unauthorized' });
    const method = mm[2], p = b && req.headers['content-type']?.includes('json') ? JSON.parse(b) : {};
    if (method === 'getMe') return reply({ ok: true, result: { id: 1, is_bot: true, username: 'mochi_test_bot', first_name: 'Mochi' } });
    if (method === 'getUpdates') {
      const t0 = Date.now();
      while (!st.updates.some(u => u.update_id >= (p.offset || 0)) && Date.now() - t0 < 800) await sleep(50);
      return reply({ ok: true, result: st.updates.filter(u => u.update_id >= (p.offset || 0)) });
    }
    if (method === 'sendMessage') { st.sent.push(p); return reply({ ok: true, result: { message_id: 100 + st.sent.length } }); }
    if (method === 'editMessageText') { st.sent.push({ ...p, edit: true }); return reply({ ok: true, result: true }); }
    return reply({ ok: true, result: true });
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  st.url = 'http://127.0.0.1:' + srv.address().port;
  st.push = (chatId, text) => st.updates.push({ update_id: st.id++, message: { message_id: st.id, text, chat: { id: chatId, type: 'private' }, from: { id: chatId, username: 'u' + chatId } } });
  st.close = () => srv.close();
  st.waitSent = async (re, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = st.sent.find(x => re.test(x.text || '')); if (s) return s; await sleep(50); } throw new Error('не дождалась ' + re + ': ' + JSON.stringify(st.sent)); };
  return st;
}

before(async () => {
  tg = await fakeTelegram();
  model = await fakeModel(async body => {
    const last = body.messages.at(-1);
    const u = [...body.messages].reverse().find(x => x.role === 'user');
    if (last.role === 'user' && /токен/.test(u.content)) return { tools: [{ name: 'telegram_connect', args: { token: u.content.match(/\d+:[\w-]+/)[0] } }] };
    if (last.role === 'tool') return { text: 'Готово: ' + last.content };
    assert.ok(body.messages[0].content.includes('@mochi_test_bot'), 'в системной подсказке есть состояние Telegram');
    return { text: 'Ответ на: ' + u.content };
  });
  m = await startMochi({ MOCHI_TG_API: tg.url, MOCHI_PUBLIC_URL: 'https://mochi.example' });
});
after(async () => { await m?.stop(); model?.close(); tg?.close(); });

test('подключение Telegram через инструмент агента, привязка и управление', async () => {
  const c = await registered(m, 'tguser');
  await c.json('/api/settings', { base: model.url, model: 'fake-1' }, 'PUT');
  await c.json('/api/chat', { text: 'подключи бота, вот токен ' + TOKEN });
  let link;
  for (let i = 0; i < 100 && !link; i++) { await sleep(100); link = (await c.json('/api/telegram', undefined, 'GET')).j.link; }
  assert.match(link, /^https:\/\/t\.me\/mochi_test_bot\?start=[0-9a-f]{20}$/);
  /* токен вычищен из истории чата */
  await sleep(500);
  const me = (await c.json('/api/me', undefined, 'GET')).j.user;
  const chatFile = fs.readFileSync(path.join(m.env.MOCHI_DATA, 'users', me.id, 'chat.json'), 'utf8');
  assert.ok(!chatFile.includes(TOKEN), 'токена нет в chat.json');
  assert.ok(fs.readFileSync(path.join(m.env.MOCHI_DATA, 'users', me.id, 'telegram.json'), 'utf8').includes(TOKEN));

  /* чужой человек не может управлять ботом */
  tg.push(555, 'rm -rf /');
  await tg.waitSent(/личный бот/);
  tg.push(555, '/start deadbeefdeadbeefdead');
  await tg.waitSent(/не подошла/);

  /* привязка по ссылке */
  tg.push(777, '/start ' + link.split('=')[1]);
  await tg.waitSent(/Готово! Теперь я, Мочи/);
  const s = (await c.json('/api/telegram', undefined, 'GET')).j;
  assert.equal(s.linked, true); assert.equal(s.link, null);

  /* задача из Telegram → прогресс и ответ туда же */
  tg.push(777, 'привет из тг');
  await tg.waitSent(/Думаю/);
  await tg.waitSent(/Ответ на: привет из тг/);
  await sleep(300);
  assert.ok(tg.sent.some(x => x.edit && /Готово/.test(x.text)));
  tg.push(777, '/status');
  await tg.waitSent(/Свободна/);
  tg.push(777, '/web');
  await tg.waitSent(/^https:\/\/mochi\.example\/$/);

  /* задача из веба, когда чат закрыт → уведомление в Telegram */
  await c.json('/api/chat', { text: 'веб-задача' });
  await tg.waitSent(/закончила задачу[\s\S]*Ответ на: веб-задача/);

  /* после перезапуска бот снова слушает */
  await m.restart();
  const n = tg.sent.filter(x => /Свободна/.test(x.text || '')).length;
  tg.push(777, '/status');
  for (let i = 0; i < 80 && tg.sent.filter(x => /Свободна/.test(x.text || '')).length === n; i++) await sleep(100);
  assert.equal(tg.sent.filter(x => /Свободна/.test(x.text || '')).length, n + 1);
  /* старые сообщения после перезапуска не выполнились повторно */
  await sleep(1000);
  assert.equal(tg.sent.filter(x => /Ответ на: привет из тг/.test(x.text || '')).length, 1);
});
