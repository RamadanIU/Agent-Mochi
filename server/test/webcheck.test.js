/* DeepSeek: запросы «как из вкладки браузера» (заголовки, cookies), проверка «я не робот» (задача ждёт; окно с настоящей
   страницей в браузере на сервере — человек проходит проверку — работа продолжается), вход по email и паролю (отпечаток
   устройства из браузера на сервере, окно входа, повторный вход, когда токен истёк).
   Фальшивый chat.deepseek.com — с защитой как у AWS WAF (405 + x-amzn-waf-action: captcha, отметка — cookie aws-waf-token)
   и страницами для браузера. Тесты с браузером пропускаются, если на машине нет Chromium или Chrome */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startPersonalComputer, registered, sleep } from './helpers.js';
import { dsHash, hintsOf, wafOf, takeCookies, cookieHeader, loginBody, ident, chromeMajor, defaultUA } from '../lib/deepseek.js';
import { findChrome } from '../lib/browser.js';

const DEEPSEEK = 'https://chat.deepseek.com';
const BROWSER = !!findChrome();
const DEVICE = 'DEVICEID-0123456789abcdef-shumei';
const ACCTS = { 'me@ds.test': { id: 'u-1', pass: 'secret-pass' }, 'strict@ds.test': { id: 'u-2', pass: 'strict-pass' } };
const F = { waf: false, tokens: new Map([['tok-static-0000000000', 'me@ds.test']]), n: 0, logins: [], calls: [], pages: [], pows: new Map(), checks: 0 };
const ok = biz => ({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: biz } });
const bizErr = (code, msg) => ({ code: 0, msg: '', data: { biz_code: code, biz_msg: msg, biz_data: null } });
const solved = req => /(?:^|;\s*)aws-waf-token=solved-\d+/.test(String(req.headers.cookie || ''));

/* страницы для браузера: защита (головоломка — одна кнопка), сайт и вход (кнопка «войти» кладёт токен как сайт) */
const PAGE = body => '<!doctype html><html><head><meta charset="utf-8"><title>DeepSeek</title></head><body style="margin:0;font:16px sans-serif">' + body + '</body></html>';
const SDK = '<script>window.SMSdk={getDeviceId:function(){return "' + DEVICE + '"}}</script>';
const CAPTCHA = PAGE('<script>window.gokuProps={key:"k",iv:"i",context:"c"}</script><div id="captcha-container"><button id="solve" style="position:absolute;left:40px;top:40px;width:240px;height:90px" onclick="document.cookie=\'aws-waf-token=solved-\'+Date.now()+\'; path=/; max-age=600\';location.reload()">Я не робот</button></div>');
const APP = PAGE('<div id="root"><div>DeepSeek</div></div>' + SDK);
const SIGNIN = PAGE('<div id="root"><button id="in" style="position:absolute;left:40px;top:200px;width:240px;height:90px" onclick="localStorage.setItem(\'userToken\',JSON.stringify({value:\'tok-strict-1111111111\',__version:\'0\'}));location.href=\'/\'">Войти</button></div>' + SDK);

let m, srv;
before(async () => {
  srv = http.createServer(async (req, res) => {
    const raw = []; for await (const c of req) raw.push(c);
    const buf = Buffer.concat(raw), u = new URL(req.url, 'http://x');
    const send = (j, h = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(j)); };
    /* страницы — для браузера на сервере */
    if (!u.pathname.startsWith('/api/')) {
      if (u.pathname !== '/favicon.ico') F.pages.push({ path: u.pathname, ua: req.headers['user-agent'], cookie: req.headers.cookie || '' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(F.waf && !solved(req) ? CAPTCHA : u.pathname === '/sign_in' ? SIGNIN : APP);
    }
    /* защита сайта: без отметки о пройденной проверке — головоломка (как AWS WAF: 405 и x-amzn-waf-action) */
    if (F.waf && !solved(req)) { res.writeHead(405, { 'content-type': 'text/html', 'x-amzn-waf-action': 'captcha' }); return res.end(CAPTCHA); }
    if (u.pathname === '/api/v0/users/login') {
      const b = JSON.parse(buf.toString()), a = ACCTS[b.email];
      F.logins.push({ ...b, headers: req.headers });
      if (!a || a.pass !== b.password) return send(bizErr(2, 'PASSWORD_OR_USER_NAME_IS_WRONG'));
      if (b.device_id !== DEVICE || b.email === 'strict@ds.test') return send({ code: 11, msg: 'RISK_DEVICE_DETECTED', data: null });
      const token = 'tok-' + (++F.n) + '-' + crypto.randomBytes(6).toString('hex');
      F.tokens.set(token, b.email);
      return send(ok({ code: 0, msg: '', user: { id: a.id, token, email: b.email, mobile_number: '', chat: { is_muted: 0, mute_until: null } } }));
    }
    const token = String(req.headers.authorization || '').replace(/^Bearer /, ''), email = F.tokens.get(token);
    if (!email) return send({ code: 40003, msg: 'Authorization Failed (invalid token)', data: null });
    const me = ACCTS[email];
    if (u.pathname === '/api/v0/users/auth_token/check_device') { F.checks++; return send(ok({ rotate: null })); }
    /* сайт выдаёт cookie сессии — «браузер» должен вернуть её дальше */
    if (u.pathname === '/api/v0/users/current') return send(ok({ id: me.id, email, token }), { 'set-cookie': ['ds_session_id=sess-' + me.id + '; Path=/; HttpOnly', 'gone=1; Max-Age=0; Path=/'] });
    if (u.pathname === '/api/v0/chat/create_pow_challenge') {
      const target = JSON.parse(buf.toString()).target_path, salt = crypto.randomBytes(6).toString('hex'), expire_at = Date.now() + 300000;
      const difficulty = 500, answer = crypto.randomInt(difficulty), signature = crypto.randomBytes(8).toString('hex');
      F.pows.set(signature, answer);
      return send(ok({ challenge: { algorithm: 'DeepSeekHashV1', challenge: dsHash(salt + '_' + expire_at + '_' + answer), salt, signature, difficulty, expire_at, target_path: target } }));
    }
    if (u.pathname === '/api/v0/chat_session/create') return send(ok({ chat_session: { id: 'sess-' + crypto.randomBytes(4).toString('hex') } }));
    if (u.pathname === '/api/v0/chat_session/delete') return send(ok(null));
    if (u.pathname === '/api/v0/chat/completion') {
      const b = JSON.parse(buf.toString());
      F.calls.push({ prompt: b.prompt, headers: req.headers });
      const text = 'Ответ на «' + String(b.prompt).split('\n').filter(Boolean).pop().slice(0, 40) + '»';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const w = (j, ev) => res.write((ev ? 'event: ' + ev + '\n' : '') + 'data: ' + JSON.stringify(j) + '\n\n');
      w({ request_message_id: 1, response_message_id: 2 }, 'ready');
      w({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: text }] });
      w({ p: 'response/status', o: 'SET', v: 'FINISHED' });
      w({ click_behavior: 'none' }, 'close');
      return res.end();
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  m = await startPersonalComputer({ PERSONALCOMPUTER_DEEPSEEK_URL: 'http://127.0.0.1:' + srv.address().port, PERSONALCOMPUTER_DEEPSEEK_GAP_MS: '0', PERSONALCOMPUTER_DEEPSEEK_RPM: '0' });
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
/* файлы сервер пишет с задержкой (несколько изменений — одна запись): ждём, пока появится нужное */
const fileOf = async (c, name, ok = () => true) => {
  const f = path.join(await userDir(c), name);
  let v = null;
  for (let i = 0; i < 50; i++) { try { v = JSON.parse(fs.readFileSync(f, 'utf8')); if (ok(v)) return v; } catch {} await sleep(100); }
  return v || {};
};
const dsState = (c, ok) => fileOf(c, 'deepseek.json', ok);
/* поток окна проверки: события, пока условие не выполнится */
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
/* человек нажимает, когда видит головоломку: окно её уже распознало */
const puzzle = evs => live(evs) && evs.some(e => e.ev === 'state' && /Пройди проверку/.test(e.d.msg));
const pageIs = async p => { for (let i = 0; i < 100 && F.pages.at(-1)?.path !== p; i++) await sleep(100); await sleep(600); };
const done = evs => evs.some(e => e.ev === 'state' && /done|fail|closed|none/.test(e.d.state));

test('«браузер»: sec-ch-ua как у Chromium, cookies по правилам, страница защиты распознаётся точно', () => {
  /* известные настоящие значения Chrome 131 и 140 */
  assert.equal(hintsOf(defaultUA(131))['sec-ch-ua'], '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"');
  assert.equal(hintsOf(defaultUA(140))['sec-ch-ua'], '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"');
  assert.equal(hintsOf(defaultUA(140))['sec-ch-ua-platform'], '"Windows"');
  assert.deepEqual(hintsOf('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'), {}, 'Firefox их не шлёт');
  assert.match(hintsOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0')['sec-ch-ua'], /"Microsoft Edge";v="150"/);
  assert.ok(chromeMajor(Date.UTC(2026, 10, 12)) >= 150, 'Chrome не застыл в прошлом');
  /* состояние: придуманный нами Chrome «обновляется», свой (из твоего браузера) — нет */
  const st = ident({ ua: defaultUA(120), auto: 1 });
  assert.match(st.ua, new RegExp('Chrome/' + chromeMajor())); assert.match(st.did, /^[0-9a-f-]{36}$/);
  const mine = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  assert.equal(ident({ ua: mine }).ua, mine);
  /* cookies: сессионные, со сроком, удаление, чужой домен */
  const s = ident({});
  takeCookies(s, ['a=1; Path=/', 'b=2; Max-Age=600', 'c=3; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'd=4; Domain=.deepseek.com', 'e=5; Domain=example.com', 'aws-waf-token=t0k; Max-Age=300; Secure'], 'chat.deepseek.com');
  assert.equal(cookieHeader(s), 'a=1; b=2; d=4; aws-waf-token=t0k');
  takeCookies(s, ['b=; Max-Age=0'], 'chat.deepseek.com');
  assert.doesNotMatch(cookieHeader(s), /b=/);
  /* AWS WAF: головоломка, проверка браузера, блокировка; JSON — не защита */
  const h = o => new Headers(o);
  assert.equal(wafOf(405, '<html>…</html>', h({ 'x-amzn-waf-action': 'captcha' })), 'captcha');
  assert.equal(wafOf(202, '', h({ 'x-amzn-waf-action': 'challenge' })), 'challenge');
  assert.equal(wafOf(403, '<HTML><TITLE>ERROR: The request could not be satisfied</TITLE>Request blocked. Generated by cloudfront (CloudFront)</HTML>', h({})), 'block');
  assert.equal(wafOf(405, '<!doctype html><script>window.gokuProps={}</script><div id="captcha-container"></div>', h({})), 'captcha');
  assert.equal(wafOf(200, '{"code":0}', h({})), null);
  /* вход: тело как у сайта — шесть полей */
  assert.deepEqual(loginBody('a@b.c', 'p', 'd'), { email: 'a@b.c', mobile: '', password: 'p', area_code: '', device_id: 'd', os: 'web' });
  assert.deepEqual(loginBody('+7 (912) 345-67-89', 'p'), { email: '', mobile: '9123456789', password: 'p', area_code: '+7', device_id: '', os: 'web' });
  assert.equal(loginBody('13812345678', 'p').area_code, '+86');
});

test('запросы — как из одной вкладки браузера: User-Agent, sec-ch-ua, sec-fetch, x-device-id и cookies сайта', async () => {
  const c = await registered(m, 'dsua');
  await c.json('/api/settings', { base: DEEPSEEK, key: 'tok-static-0000000000', model: 'deepseek' }, 'PUT');
  const a = logs(await say(c, 'привет')).find(e => e.kind === 'assistant');
  assert.match(a?.text || '', /Ответ на «привет»/);
  const h = F.calls.at(-1).headers;
  assert.match(h['user-agent'], /^Mozilla\/5\.0 .*Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/); assert.doesNotMatch(h['user-agent'], /node|undici|Headless/i);
  assert.match(h['sec-ch-ua'], /"Chromium";v="\d+"/); assert.equal(h['sec-fetch-site'], 'same-origin'); assert.equal(h['sec-fetch-mode'], 'cors');
  assert.match(h['accept-language'], /^en-US/); assert.match(h['x-device-id'], /^[0-9a-f-]{36}$/); assert.match(h.referer, /\/a\/chat\/s\/sess-/);
  assert.match(h.cookie || '', /ds_session_id=sess-u-1/, 'cookie, выданная сайтом, вернулась'); assert.doesNotMatch(h.cookie || '', /gone=/);
  /* «браузер» постоянный: тот же User-Agent и x-device-id и в следующем сообщении, и после перезапуска */
  const st = await dsState(c, v => v.ck?.ds_session_id);
  assert.equal(st.ua, h['user-agent']); assert.equal(st.did, h['x-device-id']); assert.equal(st.ck.ds_session_id.v, 'sess-u-1');
  await say(c, 'ещё');
  assert.equal(F.calls.at(-1).headers['user-agent'], h['user-agent']); assert.equal(F.calls.at(-1).headers['x-device-id'], h['x-device-id']);
});

test('проверка «я не робот»: задача не падает, а ждёт — карточка «Пройти проверку»; «Стоп» снимает ожидание', async () => {
  const c = await registered(m, 'dswait');
  await c.json('/api/settings', { base: DEEPSEEK, key: 'tok-static-0000000000', model: 'deepseek' }, 'PUT');
  F.waf = true;
  try {
    const evs = await say(c, 'привет', evs => evs.some(e => e.ev === 'run' && e.d.wait === 'check') && logs(evs).some(e => e.kind === 'check'));
    const card = logs(evs).find(e => e.kind === 'check');
    assert.equal(card.state, 'wait'); assert.equal(card.check, 'captcha'); assert.ok(card.at > Date.now() + 60e3, 'сама попробует снова позже');
    assert.ok(!logs(evs).some(e => e.kind === 'error'), 'не ошибка');
    /* после проверки — бережнее: настройки показывают это и не тратят запросы на название */
    assert.ok((await dsState(c, v => v.calm)).calm > Date.now());
    const w = c.events(evs => logs(evs).some(e => e.kind === 'check' && e.state === 'stop') && evs.some(e => e.ev === 'run' && !e.d.running));
    await c.json('/api/chat/stop', {});
    const after = await w;
    assert.ok(!logs(after).some(e => e.kind === 'error'));
  } finally { F.waf = false; }
});

test('проверка в окне: настоящая страница в браузере на сервере, нажатие человека — сайт пускает, задача продолжается сама', { skip: !BROWSER && 'нет Chromium/Chrome' }, async () => {
  const c = await registered(m, 'dsclick');
  await c.json('/api/settings', { base: DEEPSEEK, key: 'tok-static-0000000000', model: 'deepseek' }, 'PUT');
  F.waf = true;
  try {
    const run = say(c, 'проверь сервер', doneRun, 90000);
    await c.events(evs => evs.some(e => e.ev === 'run' && e.d.wait === 'check'), 20000);
    const o = await c.json('/api/check', { act: 'open', w: 900, h: 700 });
    assert.equal(o.status, 200, JSON.stringify(o.j));
    const evs = await checkEvents(c, puzzle);
    const fr = evs.find(e => e.ev === 'frame').d;
    assert.ok(fr.data.length > 500 && fr.w === 900, 'кадр экрана: ' + fr.w + '×' + fr.h);
    /* страница открылась с тем же User-Agent, что у запросов модели */
    const ua = (await dsState(c)).ua;
    assert.equal(F.pages.at(-1).ua, ua);
    /* «человек» нажимает кнопку головоломки */
    const fin = checkEvents(c, done);
    await c.json('/api/check', { act: 'input', ev: { type: 'click', x: 150, y: 80 } });
    const end = await fin;
    assert.equal(end.filter(e => e.ev === 'state').at(-1).d.state, 'done', JSON.stringify(end.filter(e => e.ev === 'state').map(e => e.d)));
    const after = await run;
    assert.match(logs(after).find(e => e.kind === 'assistant')?.text || '', /Ответ на «проверь сервер»/);
    assert.equal(logs(after).filter(e => e.kind === 'check').at(-1).state, 'ok');
    /* после проверки запрос модели пришёл с отметкой сайта и тем же User-Agent, что у браузера */
    const h = F.calls.at(-1).headers;
    assert.match(h.cookie, /aws-waf-token=solved-\d+/); assert.equal(h['user-agent'], ua);
  } finally { F.waf = false; await c.json('/api/check', { act: 'close' }); }
});

test('вход по email и паролю: неверный пароль — понятно; незнакомое устройство — отпечаток из браузера на сервере; пароль хранится зашифрованным', async () => {
  const c = await registered(m, 'dslogin');
  await c.json('/api/settings', { base: DEEPSEEK, model: 'deepseek' }, 'PUT');
  const bad = await c.json('/api/deepseek/login', { login: 'me@ds.test', password: 'wrong' });
  assert.equal(bad.status, 400); assert.match(bad.j.error, /неверный email \(телефон\) или пароль/);
  assert.equal((await c.json('/api/deepseek/login', { login: 'не логин', password: 'x' })).status, 400);
  const r = await c.json('/api/deepseek/login', { login: 'me@ds.test', password: 'secret-pass' });
  const L = F.logins.filter(x => x.email === 'me@ds.test' && x.password === 'secret-pass');
  assert.deepEqual(Object.keys(L[0]).filter(k => k !== 'headers'), ['email', 'mobile', 'password', 'area_code', 'device_id', 'os']);
  assert.equal(L[0].os, 'web'); assert.match(L[0].headers.referer, /\/sign_in$/); assert.equal(L[0].headers.authorization, undefined);
  if (!BROWSER) { assert.equal(r.status, 403); assert.equal(r.j.device, true); assert.equal(r.j.browser, false); return; }
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.login, 'me@ds.test');
  /* первая попытка — без отпечатка (сайт не узнал), вторая — с настоящим из браузера на сервере */
  assert.equal(L.length, 2); assert.equal(L[0].device_id, ''); assert.equal(L[1].device_id, DEVICE);
  assert.equal((await dsState(c, v => v.dev)).dev, DEVICE);
  const s = (await c.json('/api/settings', undefined, 'GET')).j;
  assert.equal(s.dsLogin, 'me@ds.test'); assert.equal(s.hasKey, true); assert.doesNotMatch(JSON.stringify(s), /secret-pass|tok-/);
  const raw = JSON.stringify(await fileOf(c, 'settings.json', v => v.dsAuth));
  assert.doesNotMatch(raw, /secret-pass/); assert.match(JSON.parse(raw).dsAuth.pw, /^v1\./);
  /* карточка аккаунта: вход по паролю — токен обновляется сам */
  const chk = await c.json('/api/models', { base: DEEPSEEK });
  assert.equal(chk.j.pw, 'me@ds.test'); assert.equal(chk.j.login, 'me@ds.test');
  /* токен истёк — агент входит заново сам и отвечает, пользователь ничего не замечает */
  for (const [t, e] of F.tokens) if (e === 'me@ds.test' && t !== 'tok-static-0000000000') F.tokens.delete(t);
  const n0 = F.logins.length;
  const evs = await say(c, 'после истечения');
  assert.match(logs(evs).find(e => e.kind === 'assistant')?.text || '', /Ответ на «после истечения»/);
  assert.ok(!logs(evs).some(e => e.kind === 'error'));
  assert.equal(F.logins.length, n0 + 1); assert.equal(F.logins.at(-1).device_id, DEVICE);
  /* и проверка в настройках с истёкшим токеном тоже входит заново сама */
  for (const [t, e] of F.tokens) if (e === 'me@ds.test' && t !== 'tok-static-0000000000') F.tokens.delete(t);
  const again = await c.json('/api/models', { base: DEEPSEEK });
  assert.equal(again.status, 200, JSON.stringify(again.j)); assert.equal(again.j.login, 'me@ds.test');
  /* «Отключить» стирает и пароль */
  await c.json('/api/settings', { forget: DEEPSEEK }, 'PUT');
  assert.equal((await c.json('/api/settings', undefined, 'GET')).j.dsLogin, '');
});

test('вход в окне DeepSeek: сайт не пустил по паролю — входишь на его странице, токен и вход по паролю сохраняются', { skip: !BROWSER && 'нет Chromium/Chrome' }, async () => {
  const c = await registered(m, 'dswin');
  await c.json('/api/settings', { base: DEEPSEEK, model: 'deepseek' }, 'PUT');
  const r = await c.json('/api/deepseek/login', { login: 'strict@ds.test', password: 'strict-pass' });
  assert.equal(r.status, 403); assert.equal(r.j.device, true); assert.equal(r.j.browser, true); assert.match(r.j.error, /не узнал устройство/);
  assert.equal((await c.json('/api/check', { act: 'open', why: 'login', w: 800, h: 600 })).status, 200);
  await checkEvents(c, live);
  await pageIs('/sign_in');
  assert.equal(F.pages.at(-1).path, '/sign_in');
  const fin = checkEvents(c, done);
  await c.json('/api/check', { act: 'input', ev: { type: 'click', x: 150, y: 240 } });
  const end = await fin, last = end.filter(e => e.ev === 'state').at(-1).d;
  assert.equal(last.state, 'done', JSON.stringify(last)); assert.match(last.msg, /Вход выполнен/);
  const s = (await c.json('/api/settings', undefined, 'GET')).j;
  assert.equal(s.hasKey, true); assert.equal(s.dsLogin, 'strict@ds.test', 'пароль, введённый до окна, сохранён для автообновления');
  assert.equal((await dsState(c, v => v.dev)).dev, DEVICE);
});

test('отпечаток и User-Agent из твоего браузера (закладка): сохраняются, мусор — нет', async () => {
  const c = await registered(m, 'dsdev');
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
  assert.equal((await c.json('/api/deepseek/device', { device: 'DEV-' + 'x'.repeat(30), ua })).j.device, true);
  let st = await dsState(c, v => v.ua === ua);
  assert.equal(st.ua, ua); assert.equal(st.auto, undefined, 'свой User-Agent не «обновляется»'); assert.equal(st.dev, 'DEV-' + 'x'.repeat(30));
  await c.json('/api/deepseek/device', { device: 'короткий', ua: 'curl/8.0' });
  st = await dsState(c);
  assert.equal(st.ua, ua); assert.equal(st.dev, 'DEV-' + 'x'.repeat(30));
  /* окна нет — поток сразу говорит «нет» */
  const evs = await checkEvents(c, () => false, 5000).catch(() => []);
  assert.ok(!evs.length || evs[0].d.state === 'none');
});
