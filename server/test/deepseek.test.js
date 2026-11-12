/* Провайдер DeepSeek: фальшивый chat.deepseek.com (тот же веб-API: users/current, create_pow_challenge, chat_session/create,
   chat/completion с потоком JSON-патчей, file/upload_file + fetch_files). Каждый ответ на задачу PoW фальшивый сайт проверяет сам */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { startPersonalComputer, registered, chatFile, sleep } from './helpers.js';
import { dsHash, solvePow, parseToken } from '../lib/deepseek.js';
import { callParser } from '../lib/webchat.js';

const DEEPSEEK = 'https://chat.deepseek.com';
const TOKEN = 'dsTok3n_' + 'a'.repeat(40), TOKEN2 = 'dsTok3n_' + 'b'.repeat(40);
const USERS = new Map([[TOKEN, { id: 'u-1', email: 'me@deepseek.test' }], [TOKEN2, { id: 'u-2', email: 'other@deepseek.test' }]]);

let m, srv;
const D = { chats: new Map(), calls: [], titles: [], attempts: 0, news: 0, dels: [], pows: new Map(), badPow: [], files: new Map(), polls: 0, uploads: [], script: null, muted: 0 };
const ok = biz => ({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: biz } });

/* поток ответа так, как его шлёт сайт: id сообщений, снимок, фрагменты THINK/RESPONSE, голые {"v"}, BATCH, статус, служебные события */
async function stream(res, { req, resp, text = '', think = '', status = 'FINISHED', safety = false }) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  const w = (j, ev) => res.write((ev ? 'event: ' + ev + '\n' : '') + 'data: ' + JSON.stringify(j) + '\n\n');
  w({ request_message_id: req, response_message_id: resp }, 'ready');
  w({ v: { response: { message_id: resp, parent_id: req, model: '', role: 'ASSISTANT', thinking_enabled: !!think, status: 'WIP', accumulated_token_usage: 0, files: [], fragments: [], search_enabled: false } } });
  const pieces = (s, n) => s.match(new RegExp('[\\s\\S]{1,' + n + '}', 'g')) || [];
  if (think) {
    const [a, ...rest] = pieces(think, 5);
    w({ p: 'response/fragments', o: 'APPEND', v: [{ id: 1, type: 'THINK', content: a, elapsed_secs: null, references: [], stage_id: 1 }] });
    for (const x of rest) w({ v: x });
    w({ p: 'response/fragments/-1/elapsed_secs', o: 'SET', v: 1.5 });
  }
  const body = (safety ? '<ds_safety>[分类]无 [判定]安全</ds_safety>Safe' : '') + text;
  const [a = '', ...rest] = pieces(body, 7);
  w({ p: 'response/fragments', o: 'APPEND', v: [{ id: 2, type: 'RESPONSE', content: a, references: [], stage_id: 1 }] });
  for (const [i, x] of rest.entries()) { w(i % 2 ? { v: x } : { p: 'response/fragments/-1/content', o: 'APPEND', v: x }); await sleep(1); }
  if (status) {
    w({ p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: 1234 }, { p: 'quasi_status', v: status }] });
    w({ p: 'response/status', o: 'SET', v: status });
  }
  w({ updated_at: Date.now() / 1000 }, 'update_session');
  w({ content: 'Название от сайта' }, 'title');
  w({ click_behavior: 'none', auto_resume: false }, 'close');
  res.end();
}
/* x-ds-pow-response: base64 JSON с ответом на выданную задачу */
function powOk(req, target) {
  try {
    const p = JSON.parse(Buffer.from(String(req.headers['x-ds-pow-response'] || ''), 'base64').toString('utf8'));
    const t = D.pows.get(p.signature);
    if (!t || t.used || t.answer !== p.answer || t.target !== target || p.target_path !== target || p.algorithm !== 'DeepSeekHashV1' || p.challenge !== t.challenge || p.salt !== t.salt) return false;
    t.used = true; return true;
  } catch { return false; }
}
/* multipart: имя и байты файла */
function multipart(buf, ct) {
  const bd = /boundary=([^;]+)/.exec(ct)?.[1]; if (!bd) return null;
  const s = buf.toString('latin1'), h = s.indexOf('\r\n\r\n'), end = s.lastIndexOf('\r\n--' + bd);
  const head = Buffer.from(s.slice(0, h), 'latin1').toString('utf8');
  return { name: decodeURIComponent(/filename\*=UTF-8''([^\r\n;]+)/.exec(head)?.[1] || ''), type: /Content-Type: ([^\r\n]+)/i.exec(head)?.[1], data: Buffer.from(s.slice(h + 4, end), 'latin1') };
}

before(async () => {
  srv = http.createServer(async (req, res) => {
    const raw = []; for await (const c of req) raw.push(c);
    const buf = Buffer.concat(raw), u = new URL(req.url, 'http://x');
    const send = j => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    const token = String(req.headers.authorization || '').replace(/^Bearer /, ''), me = USERS.get(token);
    /* как у сайта: без токена или с чужим — HTTP 200 и код ошибки в теле */
    if (!token) return send({ code: 40002, msg: 'Missing Token', data: null });
    if (!me) return send({ code: 40003, msg: 'Authorization Failed (invalid token)', data: null });
    if (u.pathname === '/api/v0/users/current') return send(ok({ id: me.id, email: me.email, token, mobile_number: '' }));
    if (u.pathname === '/api/v0/chat/create_pow_challenge') {
      const target = JSON.parse(buf.toString()).target_path, salt = crypto.randomBytes(10).toString('hex'), expire_at = Date.now() + 300000;
      const difficulty = 3000, answer = crypto.randomInt(difficulty), signature = crypto.randomBytes(8).toString('hex');
      const challenge = dsHash(salt + '_' + expire_at + '_' + answer);
      D.pows.set(signature, { answer, target, challenge, salt });
      return send(ok({ challenge: { algorithm: 'DeepSeekHashV1', challenge, salt, signature, difficulty, expire_at, expire_after: 300000, target_path: target } }));
    }
    if (u.pathname === '/api/v0/chat_session/create') {
      const id = 'sess-' + (++D.news) + '-' + crypto.randomBytes(3).toString('hex');
      D.chats.set(id, { acct: me.id, msgs: new Set(), next: 1 });
      return send(ok({ chat_session: { id, title: null, seq_id: D.news } }));
    }
    if (u.pathname === '/api/v0/chat_session/delete') { D.dels.push(JSON.parse(buf.toString()).chat_session_id); return send(ok(null)); }
    if (u.pathname === '/api/v0/file/upload_file') {
      if (!powOk(req, '/api/v0/file/upload_file')) { D.badPow.push('upload'); return send({ code: 40301, msg: 'INVALID_POW_RESPONSE', data: null }); }
      const f = multipart(buf, req.headers['content-type']), id = 'file-' + (D.files.size + 1);
      D.files.set(id, { ...f, size: +req.headers['x-file-size'], polls: 0 }); D.uploads.push(f.name);
      return send(ok({ id, status: 'PENDING', file_name: f.name, file_size: f.data.length }));
    }
    if (u.pathname === '/api/v0/file/fetch_files') {
      const id = u.searchParams.get('file_ids'), f = D.files.get(id); D.polls++;
      return send(ok({ files: [{ id, status: ++f.polls < 2 ? 'PARSING' : 'SUCCESS', file_name: f.name, token_usage: 10 }] }));
    }
    if (u.pathname === '/api/v0/chat/completion') {
      D.attempts++;
      if (!powOk(req, '/api/v0/chat/completion')) { D.badPow.push('completion'); return send({ code: 40301, msg: 'INVALID_POW_RESPONSE', data: null }); }
      if (D.muted) return send({ code: 0, msg: '', data: { biz_code: 5, biz_msg: 'user is muted', biz_data: { is_muted: 1, mute_until: D.muted / 1000 } } });
      const body = JSON.parse(buf.toString()), ch = D.chats.get(body.chat_session_id);
      if (!ch || ch.acct !== me.id) return send({ code: 0, msg: '', data: { biz_code: 1, biz_msg: 'Chat session not found', biz_data: null } });
      if (body.parent_message_id !== null && !ch.msgs.has(body.parent_message_id)) return send({ code: 0, msg: '', data: { biz_code: 2, biz_msg: 'invalid parent message', biz_data: null } });
      const reqId = ch.next, resp = ch.next + 1; ch.next += 2; ch.msgs.add(reqId); ch.msgs.add(resp);
      const call = { chat: body.chat_session_id, parent: body.parent_message_id, prompt: body.prompt, files: body.ref_file_ids, think: body.thinking_enabled, search: body.search_enabled, model_type: body.model_type, resp, headers: req.headers };
      /* название чата — отдельный короткий запрос во временном чате: в сценарий не попадает */
      if (/^Придумай короткое название/.test(body.prompt)) { D.titles.push(call); return stream(res, { req: reqId, resp, text: '«Про сервер».' }); }
      D.calls.push(call);
      const step = await D.script(call, D.calls.length - 1);
      if (step.empty) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: ready\ndata: ' + JSON.stringify({ request_message_id: reqId, response_message_id: resp }) + '\n\n'); return res.end(); }
      return stream(res, { req: reqId, resp, ...step });
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  m = await startPersonalComputer({ PERSONALCOMPUTER_DEEPSEEK_URL: 'http://127.0.0.1:' + srv.address().port, PERSONALCOMPUTER_DEEPSEEK_GAP_MS: '0', PERSONALCOMPUTER_DEEPSEEK_RPM: '0' });
});
after(async () => { await m?.stop(); srv?.close(); });

const doneRun = evs => { const k = evs.findIndex(e => e.ev === 'run' && e.d.running === true); return k >= 0 && evs.slice(k).some(e => e.ev === 'run' && e.d.running === false); };
async function say(c, text, files) {
  const w = c.events(doneRun);
  await sleep(100);
  const r = await c.json('/api/chat', { text, ...(files ? { files } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  return w;
}
const histOf = async c => { const me = (await c.json('/api/account', undefined, 'GET')).j.user; return JSON.parse(fs.readFileSync(chatFile(m.env.PERSONALCOMPUTER_DATA, me.id), 'utf8')); };
const logs = evs => evs.filter(e => e.ev === 'log').map(e => e.d);
const said = evs => logs(evs).filter(e => e.kind === 'assistant').map(e => e.text);
const marksOf = async (c, n) => { let v; for (let i = 0; i < 100; i++) { v = await histOf(c); if (v.hist.filter(x => x._ds).length >= n) break; await sleep(50); } return v; };

test('PoW DeepSeekHashV1: совпадает с официальным sha3_wasm_bg.wasm сайта, задача решается', async () => {
  /* векторы получены вызовом wasm_deepseek_hash_v1 из chat.deepseek.com/…/sha3_wasm_bg.7b9ca65ddd.wasm */
  assert.equal(dsHash(''), 'e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3');
  assert.equal(dsHash('abc'), 'f841106c601ce9be9bc38525e90d4178d47f21dd8eb9f238fc55ffaa4ca94506');
  assert.equal(dsHash('DeepSeekHashV1_1700000000_42'), '2f0459ee44b10d411994923362c9b38f337bca161292dd4dfe2af5f8cea1b06b');
  assert.equal(dsHash('salt_1735689600_123'), '7334e78a5b819f98818b820dfb35ef312b75fc2c69e708bad3a63b5a52c964d9');
  assert.equal(dsHash('y'.repeat(136)), 'd64717c313c6ddbabebdfc6de1c25ba66f04ff0b9d8f95ad0b1c7acb8fb9e564', 'два блока');
  assert.equal(dsHash('привет'), '6a7b035d38522813083a2bb0077e39f8d311e2298224112c0eefb0ce70e878c3');
  /* это не обычный SHA3-256 */
  assert.notEqual(dsHash('abc'), crypto.createHash('sha3-256').update('abc').digest('hex'));
  /* wasm_solve(challenge, "kM0rN3xS_1762958400_", 144000) = 137042 */
  assert.equal(await solvePow({ challenge: 'f860300ed94bef96fd61ea1b1a49732e22cf41a101008b76e0b885ceca134585', salt: 'kM0rN3xS', expire_at: 1762958400, difficulty: 144000 }), 137042);
  assert.equal(await solvePow({ challenge: dsHash('s_1_0'), salt: 's', expire_at: 1, difficulty: 10 }), 0, 'nonce 0 — тоже ответ');
  assert.equal(await solvePow({ challenge: dsHash('s_1_10'), salt: 's', expire_at: 1, difficulty: 10 }), null, 'nonce из [0, difficulty)');
  /* граница блока: префикс + цифры = 135 байт, байт дополнения совпадает с последним (0x86) */
  const salt = 's'.repeat(118), pre = salt + '_1700000000_';
  assert.equal(await solvePow({ challenge: dsHash(pre + '54321'), salt, expire_at: 1700000000, difficulty: 99999 }), 54321);
});

test('токен: как ни вставь — сохраняется сам токен', () => {
  assert.equal(parseToken('  Bearer ' + TOKEN + ' '), TOKEN);
  assert.equal(parseToken('{"value":"' + TOKEN + '","__version":"0"}'), TOKEN, 'JSON из localStorage.userToken');
  assert.equal(parseToken(JSON.stringify(JSON.stringify({ value: TOKEN, __version: '0' }))), TOKEN, 'он же, скопированный строкой');
  assert.equal(parseToken('"' + TOKEN + '"'), TOKEN);
  assert.equal(parseToken('ds_session_id=1; userToken=' + encodeURIComponent(TOKEN) + '; x=2'), TOKEN);
});

test('настройки: токен DeepSeek проверяется, видно аккаунт, модель одна, токен хранится как есть', async () => {
  const c = await registered(m, 'dset');
  const none = await c.json('/api/models', { base: DEEPSEEK });
  assert.equal(none.status, 401); assert.equal(none.j.needKey, true);
  const bad = await c.json('/api/models', { base: DEEPSEEK, key: 'nope-nope-nope-nope' });
  assert.equal(bad.status, 401); assert.match(bad.j.error, /Токен DeepSeek не подошёл или истёк/); assert.equal(bad.j.human, true);
  const r = await c.json('/api/models', { base: DEEPSEEK, key: '{"value":"' + TOKEN + '","__version":"0"}' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.models, ['deepseek']); assert.equal(r.j.login, 'me@deepseek.test'); assert.equal(r.j.info[0].think, true);
  const s = (await c.json('/api/settings', { base: DEEPSEEK + '/', key: '{"value":"' + TOKEN + '","__version":"0"}', model: 'deepseek', think: true }, 'PUT')).j;
  assert.equal(s.base, DEEPSEEK); assert.equal(s.think, true); assert.equal(s.hasKey, true);
  assert.doesNotMatch(JSON.stringify(s), /dsTok3n/);
  /* сохранённый токен: проверка без повторного ввода */
  assert.equal((await c.json('/api/models', { base: DEEPSEEK })).status, 200);
});

test('чат: один и тот же чат DeepSeek, отправляется только новое, инструменты агента работают, метка скрыта', async () => {
  const c = await registered(m, 'dchat');
  await c.json('/api/settings', { base: DEEPSEEK, key: TOKEN, model: 'deepseek', think: true }, 'PUT');
  D.script = call => {
    if (/\[TOOL RESULT: run_command\]/.test(call.prompt)) return { text: 'Ядро: ' + /привет-из-шелла/.exec(call.prompt)?.[0], safety: true };
    if (/какое ядро/.test(call.prompt)) return { think: 'надо проверить ядро', text: 'Проверю.\n[TOOL CALL]\n{"name": "run_command", "arguments": {"action": "Смотрю ядро", "command": "echo привет-из-шелла"}}\n[END TOOL CALL]\n[TOOL RESULT: run_command]\nLinux 1.0\n[END TOOL RESULT]' };
    return { text: 'Ответ на «' + call.prompt.split('\n').pop() + '»' };
  };
  const n0 = D.calls.length, news0 = D.news, dels0 = D.dels.length, t0 = D.titles.length;
  const evs = await say(c, 'какое ядро?');
  const L = logs(evs), tool = L.filter(e => e.kind === 'tool').at(-1);
  assert.equal(tool.name, 'run_command'); assert.equal(tool.label, 'Смотрю ядро'); assert.equal(tool.state, 'ok');
  assert.deepEqual(said(evs), ['Проверю.', 'Ядро: привет-из-шелла']);
  /* ни маркеров, ни выдуманного результата, ни размышлений, ни служебной вставки сайта, ни его названия чата */
  const deltas = evs.filter(e => e.ev === 'delta').map(e => e.d.d).join('');
  assert.doesNotMatch(deltas + said(evs).join(''), /TOOL|Linux 1\.0|надо проверить|ds_safety|Safe|Название от сайта|FINISHED/);

  const calls = D.calls.slice(n0);
  assert.equal(calls.length, 2);
  assert.equal(D.news, news0 + 1, 'один новый чат DeepSeek');
  assert.equal(calls[0].parent, null);
  assert.equal(calls[1].chat, calls[0].chat);
  assert.equal(calls[1].parent, calls[0].resp, 'продолжение от ответа модели');
  assert.match(calls[0].prompt, /^\[Инструкция[\s\S]*Personal Computer[\s\S]*## run_command[\s\S]*\[TOOL CALL\][\s\S]*# Предел длины ответа[\s\S]*\[Конец инструкции\]\n\nкакое ядро\?$/);
  assert.match(calls[0].prompt, /Встроенных инструментов чата DeepSeek здесь нет/);
  assert.match(calls[1].prompt, /^\[TOOL RESULT: run_command\]\nпривет-из-шелла\n\[код выхода: 0\]\n\[END TOOL RESULT\]/);
  assert.doesNotMatch(calls[1].prompt, /Инструкция|какое ядро/);
  /* поиск сайта выключен всегда, DeepThink — по настройке; заголовки как у сайта; все PoW верны */
  assert.equal(calls[0].search, false); assert.equal(calls[0].think, true); assert.equal(calls[0].model_type, null);
  assert.equal(calls[0].headers['x-client-platform'], 'web'); assert.equal(calls[0].headers.authorization, 'Bearer ' + TOKEN);
  assert.deepEqual(D.badPow, []);

  /* следующее сообщение — в тот же чат, без истории */
  await c.json('/api/settings', { think: false }, 'PUT');
  await say(c, 'а ещё?');
  const c3 = D.calls.at(-1);
  assert.equal(c3.chat, calls[0].chat); assert.equal(c3.parent, calls[1].resp);
  assert.equal(c3.prompt, 'а ещё?'); assert.equal(c3.think, false);

  /* метка чата — только в истории для модели, в журнале её нет */
  const v = await marksOf(c, 3), marks = v.hist.filter(x => x._ds).map(x => x._ds);
  assert.equal(marks.length, 3);
  assert.deepEqual([marks[2].c, marks[2].r, marks[2].a], [calls[0].chat, c3.resp, 'u-1']);
  assert.doesNotMatch(JSON.stringify(v.log), /_ds|sess-/);

  /* название чата модель придумывает во временном чате DeepSeek, который сразу удалён */
  for (let i = 0; i < 100 && D.dels.length === dels0; i++) await sleep(50);
  assert.equal(D.dels.length, dels0 + 1); assert.notEqual(D.dels.at(-1), calls[0].chat);
  assert.equal(D.titles.length, t0 + 1); assert.equal(D.titles.at(-1).chat, D.dels.at(-1)); assert.equal(D.titles.at(-1).think, false);
  let title = '';
  for (let i = 0; i < 100 && title !== 'Про сервер'; i++) { title = (await c.json('/api/chats', undefined, 'GET')).j.list[0]?.title; await sleep(50); }
  assert.equal(title, 'Про сервер');
  assert.deepEqual(D.badPow, []);
});

test('предел длины ответа: вызов инструмента, оборванный посреди JSON, дописывается продолжением и выполняется', async () => {
  const c = await registered(m, 'dcut');
  await c.json('/api/settings', { base: DEEPSEEK, key: TOKEN, model: 'deepseek', think: true }, 'PUT');
  const big = Array.from({ length: 300 }, (_, i) => 'строка ' + (i + 1)).join('\n'), args = JSON.stringify({ name: 'write_file', arguments: { action: 'Пишу файл', path: 'outbox/big.txt', content: big } });
  const cut = Math.floor(args.length / 2);
  D.script = call => {
    if (/Пиши большой файл/.test(call.prompt)) return { think: 'большой файл', text: 'Пишу.\n[TOOL CALL]\n' + args.slice(0, cut), status: 'INCOMPLETE' };
    /* продолжение: модель повторила кусок хвоста — его надо срезать */
    if (/^\[Твой ответ оборвался/.test(call.prompt)) return { text: args.slice(cut - 30, cut) + args.slice(cut) + '\n[END TOOL CALL]' };
    if (/\[TOOL RESULT: write_file\]/.test(call.prompt)) return { text: 'Файл готов' };
    return { text: 'ок' };
  };
  const n0 = D.calls.length;
  const evs = await say(c, 'Пиши большой файл');
  const tool = logs(evs).filter(e => e.kind === 'tool').at(-1);
  assert.equal(tool?.name, 'write_file', JSON.stringify(logs(evs)));
  assert.equal(tool.state, 'ok', tool.tail);
  const calls = D.calls.slice(n0);
  assert.equal(calls.length, 3, 'ответ, продолжение, ответ на результат');
  assert.match(calls[1].prompt, /^\[Твой ответ оборвался/);
  assert.equal(calls[1].chat, calls[0].chat); assert.equal(calls[1].parent, calls[0].resp, 'продолжение — от оборванного ответа');
  assert.equal(calls[1].think, false, 'продолжению размышления не нужны');
  assert.equal(calls[2].parent, calls[1].resp, 'дальше — от продолжения');
  assert.match(calls[2].prompt, /^\[TOOL RESULT: write_file\]/);
  assert.deepEqual(said(evs), ['Пишу.', 'Файл готов']);
  /* файл записан целиком: без дыры и без повтора на стыке */
  const me = (await c.json('/api/account', undefined, 'GET')).j;
  const f = fs.readFileSync(me.work + '/outbox/big.txt', 'utf8');
  assert.equal(f, big);
});

test('предел длины ответа: текст без «готово» продолжается, повтор хвоста срезается; продолжать нечего — [END]', async () => {
  const c = await registered(m, 'dcut2');
  await c.json('/api/settings', { base: DEEPSEEK, key: TOKEN, model: 'deepseek', think: false }, 'PUT');
  const A = 'Первая часть длинного ответа про то, как устроен сервер и что в нём', B = ' лежит: папки, службы и логи.';
  D.script = call => {
    if (/расскажи/.test(call.prompt)) return { text: A, status: '' };
    if (/^\[Твой ответ оборвался/.test(call.prompt) && D.calls.at(-2)?.prompt.includes('расскажи')) return { text: A.slice(-20) + B };
    if (/^\[Твой ответ оборвался/.test(call.prompt)) return { text: '[END]' };
    if (/потом/.test(call.prompt)) return { text: 'Ответ, который сайт зря не закрыл', status: 'INCOMPLETE' };
    return { text: 'ок' };
  };
  const evs = await say(c, 'расскажи про сервер');
  assert.deepEqual(said(evs), [A + B]);
  const deltas = evs.filter(e => e.ev === 'delta').map(e => e.d.d).join('');
  assert.equal(deltas, A + B, 'пользователь видел, как ответ пишется, — без повтора на стыке');
  const n0 = D.calls.length;
  const e2 = await say(c, 'а потом?');
  assert.deepEqual(said(e2), ['Ответ, который сайт зря не закрыл']);
  assert.equal(D.calls.length, n0 + 2, 'одно продолжение ответило [END] — больше не просим');
  /* следующее сообщение — от последнего ответа ([END]), в тот же чат */
  await say(c, 'ясно');
  assert.equal(D.calls.at(-1).parent, D.calls.at(-2).resp);
  assert.equal(D.calls.at(-1).prompt, 'ясно');
});

test('чат на сайте удалили или сменили аккаунт — новый чат DeepSeek со всей перепиской', async () => {
  const c = await registered(m, 'dgone');
  await c.json('/api/settings', { base: DEEPSEEK, key: TOKEN, model: 'deepseek', think: false }, 'PUT');
  D.script = call => ({ text: 'ок: ' + call.prompt.split('\n').pop() });
  await say(c, 'первое');
  const first = D.calls.at(-1);
  D.chats.delete(first.chat);
  const n0 = D.calls.length;
  const a0 = D.attempts;
  await say(c, 'второе');
  assert.equal(D.attempts, a0 + 2, 'отказ продолжить старый чат — и сразу новый');
  assert.equal(D.calls.length, n0 + 1);
  const fresh = D.calls.at(-1);
  assert.equal(fresh.parent, null); assert.notEqual(fresh.chat, first.chat);
  assert.match(fresh.prompt, /^\[Инструкция[\s\S]*# Разговор до этого момента[\s\S]*### Пользователь\nпервое\n\n### Ты\nок: первое\n\n# Сейчас\nвторое$/);
  /* другой аккаунт — чаты прежнего ему не видны: сразу новый чат */
  await c.json('/api/settings', { base: DEEPSEEK, key: TOKEN2 }, 'PUT');
  await say(c, 'третье');
  const third = D.calls.at(-1);
  assert.equal(third.parent, null); assert.notEqual(third.chat, fresh.chat);
  assert.match(third.prompt, /первое[\s\S]*второе[\s\S]*# Сейчас\nтретье$/);
});

test('сообщение длиннее предела сайта сокращается, а не уходит целиком', async () => {
  const c = await registered(m, 'dlong');
  await c.json('/api/settings', { base: DEEPSEEK, key: TOKEN, model: 'deepseek' }, 'PUT');
  D.script = call => ({ text: 'длина ' + call.prompt.length });
  await say(c, 'начало ' + 'ж'.repeat(90000) + ' конец');
  const p = D.calls.at(-1).prompt;
  assert.ok(p.length <= 60000, 'ушло ' + p.length);
  assert.match(p, /^\[Инструкция/); assert.match(p, /конец$/); assert.match(p, /пропущено \d+ символов/);
});

test('истёк токен и временная блокировка аккаунта — понятные ошибки, без лишних повторов', async () => {
  const c = await registered(m, 'dexp');
  await c.json('/api/settings', { base: DEEPSEEK, key: 'expired-token-0000000000', model: 'deepseek' }, 'PUT');
  const err = logs(await say(c, 'привет')).find(e => e.kind === 'error');
  assert.ok(err, 'нет ошибки'); assert.match(err.text, /^Токен DeepSeek не подошёл или истёк/);

  await c.json('/api/settings', { key: TOKEN2 }, 'PUT');
  D.muted = Date.now() + 3600e3;
  try {
    const a0 = D.attempts;
    const e2 = logs(await say(c, 'ещё')).find(e => e.kind === 'error');
    assert.match(e2?.text || '', /DeepSeek временно ограничил аккаунт[\s\S]*до \d\d:\d\d/);
    assert.equal(D.attempts, a0 + 1, 'заблокированному аккаунту запрос не повторяли');
  } finally { D.muted = 0; }
});

test('файлы в чат: картинка и документ уходят в DeepSeek (PoW → upload_file → fetch_files), остальное — путём на сервере', async () => {
  const c = await registered(m, 'dfiles');
  await c.json('/api/settings', { base: DEEPSEEK, key: TOKEN, model: 'deepseek' }, 'PUT');
  D.script = call => ({ text: 'вижу файлов: ' + call.files.length });
  const up = async (name, data) => { const r = await c('/api/upload?name=' + encodeURIComponent(name), { method: 'POST', body: data, headers: { 'content-type': 'application/octet-stream' } }); assert.equal(r.status, 200); return r.json(); };
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f30000000049454e44ae426082', 'hex');
  const files = [await up('кот.png', png), await up('отчёт.pdf', Buffer.from('%PDF-1.4 тест')), await up('архив.zip', Buffer.from('PK..'))];
  const u0 = D.uploads.length;
  const L = logs(await say(c, 'посмотри', files));
  assert.equal(L.filter(e => e.kind === 'assistant').at(-1).text, 'вижу файлов: 2');
  assert.deepEqual(D.uploads.slice(u0).sort(), ['кот.png', 'отчёт.pdf']);
  const call = D.calls.at(-1);
  assert.equal(call.files.length, 2); assert.ok(call.files.every(id => D.files.has(id)));
  /* на сайт легли настоящие байты с правильным типом; файл ждали, пока сайт его разберёт */
  const img = [...D.files.values()].find(f => f.name === 'кот.png');
  assert.equal(img.type, 'image/png'); assert.ok(img.data.equals(png)); assert.equal(img.size, png.length);
  assert.ok(D.polls >= 2);
  /* путь к файлам на сервере модель тоже знает — архив она откроет инструментами */
  assert.match(call.prompt, /inbox\/архив\.zip/);
  /* следующее сообщение файлы не повторяет: они уже в чате DeepSeek */
  await say(c, 'ещё раз');
  assert.deepEqual(D.calls.at(-1).files, []);
  assert.equal(D.uploads.length, u0 + 2);
  assert.deepEqual(D.badPow, []);
});

test('разбор ответа: открытый блок вызова виден разборщику (по нему ловим обрыв)', () => {
  const P = callParser(() => {});
  P.push('Сейчас.\n[TOOL CALL]\n{"name": "write_file", "arguments": {"content": "обре');
  assert.equal(P.open(), true);
  P.push('зано"}}\n[END TOOL CALL]');
  assert.equal(P.open(), false);
  assert.equal(JSON.parse(P.end().calls[0].function.arguments).content, 'обрезано');
});
