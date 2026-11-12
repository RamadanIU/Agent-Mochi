/* Qwen: запросы «как из вкладки браузера» (заголовки, cookies), сообщение не больше ~96 КБ (на тело больше ~128 КБ сайт
   отвечает проверкой), слайдер «я не робот» антибота Alibaba (HTTP 200, ret RGV587, data.url …/_____tmd_____/punish):
   задача ждёт, окно открывает страницу слайдера в браузере на сервере, «человек» тянет слайдер — работа продолжается,
   вход по паролю повторяется. Тесты с браузером пропускаются, если на машине нет Chromium или Chrome */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startPersonalComputer, registered, sleep } from './helpers.js';
import { punishUrl, bytesOf } from '../lib/qwen.js';
import { findChrome } from '../lib/browser.js';

const QWEN = 'https://chat.qwen.ai';
const BROWSER = !!findChrome();
const jwt = p => ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', Buffer.from(JSON.stringify(p)).toString('base64url'), 'sig'].join('.');
const TOKEN = jwt({ id: 'acc-1', exp: Math.floor(Date.now() / 1000) + 30 * 86400 });
const PASS = 'мой-пароль', PH = crypto.createHash('sha256').update(PASS).digest('hex');
const F = { waf: false, calls: [], pages: [], signins: 0 };
const solved = req => /(?:^|;\s*)x5sec=solved-\d+/.test(String(req.headers.cookie || ''));
/* слайдер: тянуть оранжевый квадрат вправо больше чем на 220 px */
const SLIDER = '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;font:15px sans-serif">'
  + '<div id="nc_1_wrapper" style="position:absolute;left:30px;top:30px;width:340px;height:60px;background:#eee"><span id="nc_1_n1z" style="position:absolute;left:0;top:0;width:60px;height:60px;background:#f60"></span></div>'
  + '<script>let x0=null;const k=document.getElementById("nc_1_n1z");k.addEventListener("mousedown",e=>{x0=e.clientX});'
  + 'addEventListener("mousemove",e=>{if(x0!==null)k.style.left=Math.max(0,e.clientX-x0)+"px"});'
  + 'addEventListener("mouseup",e=>{if(x0!==null&&e.clientX-x0>220){document.cookie="x5sec=solved-"+Date.now()+"; path=/; max-age=600";location.replace("/")}x0=null})</script></body></html>';
const APP = '<!doctype html><html><body><div id="root"><div>Qwen</div></div></body></html>';
/* страница входа: «Google» открывает отдельное окно (в окне приложения его не будет), «email» — входит и уходит в чат */
const AUTH = '<!doctype html><html><body style="margin:0"><button id="g" style="position:absolute;left:20px;top:20px;width:220px;height:60px" onclick="window.open(\'https://accounts.google.com/o/oauth2/v2/auth?client_id=x\',\'g\',\'popup\')">Google</button>'
  + '<button id="e" style="position:absolute;left:20px;top:120px;width:220px;height:60px" onclick="localStorage.setItem(\'token\',' + JSON.stringify(TOKEN).replace(/"/g, '&quot;') + ');location.href=\'/\'">email</button></body></html>';

let m, srv, base;
const punish = p => ({ ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试'], data: { url: base.replace(/^http:\/\/127\.0\.0\.1:(\d+)/, 'http://127.0.0.1:$1') + '/' + p + '/_____tmd_____/punish?x5secdata=abc&x5step=2&action=captcha&pureCaptcha=' } });
before(async () => {
  srv = http.createServer(async (req, res) => {
    const raw = []; for await (const c of req) raw.push(c);
    const buf = Buffer.concat(raw), u = new URL(req.url, 'http://x');
    const send = (j, h = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(j)); };
    if (!u.pathname.startsWith('/api/') || u.pathname.includes('_____tmd_____')) {
      if (u.pathname !== '/favicon.ico') F.pages.push({ path: u.pathname, ua: req.headers['user-agent'] });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(u.pathname.includes('_____tmd_____') ? SLIDER : u.pathname === '/auth' ? AUTH : APP);
    }
    /* антибот: без отметки о пройденном слайдере — HTTP 200 и ret RGV587 с адресом слайдера (как у chat.qwen.ai) */
    const gate = p => F.waf && !solved(req) ? (send(punish(p)), true) : false;
    if (u.pathname === '/api/v1/auths/signin') {
      if (gate('api/v1/auths/signin')) return;
      F.signins++;
      const q = JSON.parse(buf.toString());
      if (q.email !== 'me@qwen.test' || q.password !== PH) return send({ success: false, data: { code: 'Bad_Request', details: 'incorrect email or password' } });
      return send({ id: 'acc-1', email: q.email, token: TOKEN });
    }
    if (String(req.headers.authorization || '') !== 'Bearer ' + TOKEN) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"success":false,"data":{"code":"Unauthorized"}}'); }
    if (u.pathname === '/api/v1/auths/') return send({ id: 'acc-1', token: TOKEN });
    if (u.pathname === '/api/models') return send({ data: [{ id: 'qwen3-max', name: 'Qwen3-Max', info: { meta: { abilities: { thinking: true }, chat_type: ['t2t'] } } }] }, { 'set-cookie': 'acw_tc=tc-1; Path=/; HttpOnly' });
    if (u.pathname === '/api/v2/chats/new') return send({ success: true, data: { id: 'chat-' + crypto.randomBytes(3).toString('hex') } });
    if (req.method === 'DELETE') return send({ success: true });
    if (u.pathname === '/api/v2/chat/completions') {
      if (gate('api/v2/chat/completions')) return;
      const b = JSON.parse(buf.toString()), content = b.messages[0].content;
      F.calls.push({ content, bytes: buf.length, headers: req.headers });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const w = j => res.write('data: ' + JSON.stringify(j) + '\n\n');
      w({ 'response.created': { chat_id: b.chat_id, response_id: 'r-' + F.calls.length, response_index: 0 } });
      w({ choices: [{ delta: { role: 'assistant', content: 'Ответ на «' + content.split('\n').filter(Boolean).pop().slice(0, 30) + '»', phase: 'answer' } }], response_id: 'r-' + F.calls.length });
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  base = 'http://127.0.0.1:' + srv.address().port;
  m = await startPersonalComputer({ PERSONALCOMPUTER_QWEN_URL: base, PERSONALCOMPUTER_QWEN_GAP_MS: '0', PERSONALCOMPUTER_QWEN_RPM: '0', PERSONALCOMPUTER_QWEN_KEEPALIVE_MS: '600000' });
});
after(async () => { await m?.stop(); srv?.close(); srv?.closeAllConnections?.(); });

const doneRun = evs => { const k = evs.findIndex(e => e.ev === 'run' && e.d.running === true); return k >= 0 && evs.slice(k).some(e => e.ev === 'run' && e.d.running === false); };
const logs = evs => evs.filter(e => e.ev === 'log').map(e => e.d);
async function say(c, text, until = doneRun, ms) {
  const w = c.events(until, ms);
  await sleep(100);
  const r = await c.json('/api/chat', { text });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  return w;
}
const userDir = async c => path.join(m.env.PERSONALCOMPUTER_DATA, 'users', (await c.json('/api/account', undefined, 'GET')).j.user.id);
const qwState = async (c, ok = () => true) => {
  const f = path.join(await userDir(c), 'qwen.json');
  let v = {};
  for (let i = 0; i < 50; i++) { try { v = JSON.parse(fs.readFileSync(f, 'utf8')); if (ok(v)) return v; } catch {} await sleep(100); }
  return v;
};
function checkEvents(c, until, ms = 40000) {
  return new Promise(async (ok, no) => {
    const ac = new AbortController(), evs = [];
    const t = setTimeout(() => { ac.abort(); no(new Error('таймаут окна проверки: ' + JSON.stringify(evs.filter(e => e.ev === 'state').slice(-4)))); }, ms);
    try {
      const r = await fetch(m.base + '/api/check', { headers: { cookie: c.cookie() }, signal: ac.signal });
      const dec = new TextDecoder(); let buf = '';
      for await (const ch of r.body) {
        buf += dec.decode(ch, { stream: true }); let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (raw.match(/^event: (.*)$/m) || [])[1], d = (raw.match(/^data: (.*)$/m) || [])[1];
          if (!ev) continue;
          evs.push({ ev, d: JSON.parse(d) });
          if (until(evs)) { clearTimeout(t); ac.abort(); return ok(evs); }
        }
      }
      clearTimeout(t); ok(evs);
    } catch (e) { if (!ac.signal.aborted) { clearTimeout(t); no(e); } }
  });
}
const live = evs => evs.some(e => e.ev === 'frame') && evs.some(e => e.ev === 'state' && e.d.state === 'live');
/* человек начинает тянуть, когда видит слайдер: окно его уже распознало */
const slider = evs => live(evs) && evs.some(e => e.ev === 'state' && /Пройди проверку/.test(e.d.msg));
const done = evs => evs.some(e => e.ev === 'state' && /done|fail|closed|none/.test(e.d.state));
/* «человек» тянет слайдер: нажал на квадрат, повёл вправо, отпустил */
async function drag(c) {
  const fin = checkEvents(c, done);
  const ev = e => c.json('/api/check', { act: 'input', ev: e });
  await ev({ type: 'down', x: 60, y: 60 });
  for (const x of [100, 160, 220, 280, 330]) await ev({ type: 'move', x, y: 61 });
  await ev({ type: 'up', x: 330, y: 61 });
  const end = await fin;
  return end.filter(e => e.ev === 'state').at(-1).d;
}

test('слайдер Qwen: адрес из ответа без «:443» и «//», размер — в байтах', () => {
  const u = punishUrl({ data: { url: 'https://chat.qwen.ai:443//api/v2/chat/completions/_____tmd_____/punish?x5secdata=ab&x5step=2&action=captcha&pureCaptcha=' } });
  assert.equal(u, 'https://chat.qwen.ai/api/v2/chat/completions/_____tmd_____/punish?x5secdata=ab&x5step=2&action=captcha&pureCaptcha=');
  assert.match(punishUrl(null, '<html><a href="/x/_____tmd_____/punish?x5secdata=q&amp;x5step=1">'), /\/x\/_____tmd_____\/punish\?x5secdata=q&x5step=1$/);
  assert.equal(punishUrl({ data: { url: 'https://evil.example/' } }), '');
  assert.equal(bytesOf('ж'.repeat(10)), 20);
});

test('запросы — как из вкладки браузера, cookies сайта возвращаются, сообщение не больше ~96 КБ', async () => {
  const c = await registered(m, 'qwua');
  assert.equal((await c.json('/api/settings', { base: QWEN, key: TOKEN, model: 'qwen3-max' }, 'PUT')).status, 200);
  const evs = await say(c, 'привет');
  assert.match(logs(evs).find(e => e.kind === 'assistant')?.text || '', /Ответ на «привет»/);
  const h = F.calls.at(-1).headers;
  assert.match(h['user-agent'], /^Mozilla\/5\.0 .*Chrome\/\d+/); assert.match(h['sec-ch-ua'], /"Chromium"/); assert.equal(h['sec-fetch-site'], 'same-origin');
  assert.match(h.cookie, /^token=eyJ/); assert.match(h.cookie, /acw_tc=tc-1/, 'cookie, выданная сайтом, вернулась'); assert.equal(h.source, 'web');
  assert.equal(h['bx-ua'], undefined, 'отпечатки защиты не подделываем');
  /* огромное сообщение (кириллица — 2 байта на букву: 90 000 букв — 180 КБ) уходит сокращённым: тело запроса меньше 128 КБ,
     начало и конец на месте */
  await say(c, 'начало ' + 'ж'.repeat(90000) + ' конец');
  let last = F.calls.at(-1);
  assert.ok(last.bytes < 100000, 'тело ' + last.bytes + ' байт'); assert.match(last.content, /пропущено \d+ символов/); assert.match(last.content, /^начало/m); assert.match(last.content, /конец/);
  /* и в новом чате (первое сообщение) — тоже */
  const c2 = await registered(m, 'qwbig');
  await c2.json('/api/settings', { base: QWEN, key: TOKEN, model: 'qwen3-max' }, 'PUT');
  await say(c2, 'старт ' + 'ж'.repeat(90000) + ' финиш');
  last = F.calls.at(-1);
  assert.ok(last.bytes < 100000, 'тело ' + last.bytes + ' байт'); assert.match(last.content, /^\[Инструкция/); assert.match(last.content, /финиш/);
});

test('слайдер «я не робот»: задача не падает, а ждёт — карточка с адресом слайдера; «Стоп» снимает ожидание', async () => {
  const c = await registered(m, 'qwwait');
  await c.json('/api/settings', { base: QWEN, key: TOKEN, model: 'qwen3-max' }, 'PUT');
  F.waf = true;
  try {
    const evs = await say(c, 'привет', evs => evs.some(e => e.ev === 'run' && e.d.wait === 'check') && logs(evs).some(e => e.kind === 'check'));
    const card = logs(evs).find(e => e.kind === 'check');
    assert.equal(card.prov, 'qwen'); assert.equal(card.state, 'wait'); assert.equal(card.check, 'slider');
    assert.match(card.url, /\/api\/v2\/chat\/completions\/_____tmd_____\/punish\?x5secdata=abc/); assert.doesNotMatch(card.url, /\/\/api/);
    assert.match(card.text, /^Qwen просит подтвердить/);
    assert.ok(!logs(evs).some(e => e.kind === 'error'));
    assert.ok((await qwState(c, v => v.calm)).calm > Date.now(), 'после проверки — бережнее');
    const w = c.events(evs => logs(evs).some(e => e.kind === 'check' && e.state === 'stop') && evs.some(e => e.ev === 'run' && !e.d.running));
    await c.json('/api/chat/stop', {});
    assert.ok(!logs(await w).some(e => e.kind === 'error'));
  } finally { F.waf = false; }
});

test('слайдер в окне: страница слайдера в браузере на сервере, «человек» тянет — сайт пускает, задача продолжается сама', { skip: !BROWSER && 'нет Chromium/Chrome' }, async () => {
  const c = await registered(m, 'qwdrag');
  await c.json('/api/settings', { base: QWEN, key: TOKEN, model: 'qwen3-max' }, 'PUT');
  F.waf = true;
  try {
    const run = say(c, 'проверь диск', doneRun, 90000);
    const ws = await c.events(evs => logs(evs).some(e => e.kind === 'check'), 20000);
    const card = logs(ws).find(e => e.kind === 'check');
    const o = await c.json('/api/check', { act: 'open', prov: 'qwen', url: card.url, w: 800, h: 600 });
    assert.equal(o.status, 200, JSON.stringify(o.j)); assert.equal(o.j.prov, 'qwen');
    await checkEvents(c, slider);
    assert.match(F.pages.at(-1).path, /_____tmd_____\/punish$/, 'открылась страница слайдера, которую назвал сайт');
    const ua = (await qwState(c)).ua;
    assert.equal(F.pages.at(-1).ua, ua, 'тот же User-Agent, что у запросов');
    const last = await drag(c);
    assert.equal(last.state, 'done', JSON.stringify(last));
    const after = await run;
    assert.match(logs(after).find(e => e.kind === 'assistant')?.text || '', /Ответ на «проверь диск»/);
    assert.equal(logs(after).filter(e => e.kind === 'check').at(-1).state, 'ok');
    const h = F.calls.at(-1).headers;
    assert.match(h.cookie, /x5sec=solved-\d+/); assert.match(h.cookie, /^token=eyJ/); assert.equal(h['user-agent'], ua);
  } finally { F.waf = false; await c.json('/api/check', { act: 'close' }); }
});

test('вход по паролю попал на слайдер: понятно и с адресом; после слайдера в окне вход проходит', async () => {
  const c = await registered(m, 'qwlogin');
  await c.json('/api/settings', { base: QWEN, model: 'qwen3-max' }, 'PUT');
  F.waf = true;
  try {
    const r = await c.json('/api/qwen/login', { email: 'me@qwen.test', password: PASS });
    assert.equal(r.status, 403); assert.equal(r.j.captcha, true); assert.equal(r.j.prov, 'qwen'); assert.equal(r.j.browser, BROWSER);
    assert.match(r.j.url, /\/api\/v1\/auths\/signin\/_____tmd_____\/punish/); assert.match(r.j.error, /слайдер/);
    if (!BROWSER) return;
    assert.equal((await c.json('/api/check', { act: 'open', prov: 'qwen', url: r.j.url, w: 800, h: 600 })).status, 200);
    await checkEvents(c, slider);
    assert.equal((await drag(c)).state, 'done');
    const n0 = F.signins;
    const ok = await c.json('/api/qwen/login', { email: 'me@qwen.test', password: PASS });
    assert.equal(ok.status, 200, JSON.stringify(ok.j)); assert.equal(F.signins, n0 + 1);
    assert.equal((await c.json('/api/settings', undefined, 'GET')).j.qwEmail, 'me@qwen.test');
  } finally { F.waf = false; await c.json('/api/check', { act: 'close' }); }
});

test('вход в окне Qwen: вход через Google в окне не открывается — объясняем; вход по email — токен забирается сам', { skip: !BROWSER && 'нет Chromium/Chrome' }, async () => {
  const c = await registered(m, 'qwwin');
  await c.json('/api/settings', { base: QWEN, model: 'qwen3-max' }, 'PUT');
  try {
    const o = await c.json('/api/check', { act: 'open', why: 'login', prov: 'qwen', w: 800, h: 600 });
    assert.equal(o.status, 200, JSON.stringify(o.j)); assert.equal(o.j.why, 'login');
    await checkEvents(c, live);
    for (let i = 0; i < 50 && F.pages.at(-1)?.path !== '/auth'; i++) await sleep(100);
    assert.equal(F.pages.at(-1).path, '/auth');
    /* «Google» открыл всплывающее окно — его закрыли, а человеку объяснили, что делать */
    /* под нагрузкой страница может дорисоваться позже первого нажатия — «человек» нажимает ещё раз */
    let said = false;
    const heard = checkEvents(c, evs => evs.some(e => e.ev === 'state' && /отдельное окно/.test(e.d.msg)), 60000).then(() => { said = true; });
    for (let i = 0; i < 20 && !said; i++) { await c.json('/api/check', { act: 'input', ev: { type: 'click', x: 100, y: 50 } }); await sleep(1500); }
    await heard;
    let fin = false;
    const finished = checkEvents(c, evs => { const d = done(evs); if (d) fin = true; return d; }, 60000);
    for (let i = 0; i < 20 && !fin; i++) { await c.json('/api/check', { act: 'input', ev: { type: 'click', x: 100, y: 150 } }).catch(() => {}); await sleep(1500); }
    const last = (await finished).filter(e => e.ev === 'state').at(-1).d;
    assert.equal(last.state, 'done', JSON.stringify(last)); assert.match(last.msg, /Вход выполнен/);
    const st = (await c.json('/api/settings', undefined, 'GET')).j;
    assert.equal(st.hasKey, true); assert.ok(st.provs.find(p => p.base === QWEN)?.hasKey);
  } finally { await c.json('/api/check', { act: 'close' }); }
});
