/* Провайдер Kiro: фальшивые Kiro auth (вход по коду устройства, обновление доступа), AWS OIDC (Builder ID) и
   CodeWhisperer (ListAvailableModels, getUsageLimits, generateAssistantResponse потоком AWS EventStream) */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startPersonalComputer, registered, sleep } from './helpers.js';
import * as K from '../lib/kiro.js';

const KB = 'https://kiro.dev', ARN = 'arn:aws:codewhisperer:us-east-1:111122223333:profile/TESTPROFILE';
const MODELS = [
  { modelId: 'claude-sonnet-4.5', modelName: 'Claude Sonnet 4.5', rateMultiplier: 1.3, supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000 } },
  { modelId: 'claude-sonnet-5', modelName: 'Claude Sonnet 5', rateMultiplier: 2, supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 1000000 } },
  { modelId: 'glm-5', modelName: 'GLM-5', rateMultiplier: 0, supportedInputTypes: ['TEXT'] },
];
let m, srv, url;
const S = { gen: [], refresh: 0, polls: 0, oidcPolls: 0, script: [], access: 'aoaACCESS1', gone: false, ver: '2.0.0', need: '', providers: [] };

before(async () => {
  srv = http.createServer(async (q, s) => {
    let b = ''; for await (const c of q) b += c;
    const j = b ? JSON.parse(b) : {}, p = new URL(q.url, 'http://x').pathname;
    const json = (st, o) => { s.writeHead(st, { 'content-type': 'application/json' }); s.end(JSON.stringify(o)); };
    const authed = () => q.headers.authorization === 'Bearer ' + S.access;
    /* вход через Google/GitHub: первый опрос — «ещё нет», второй — вошёл */
    /* файл обновлений Kiro IDE: отсюда сервер узнаёт, какая версия сейчас свежая */
    if (p === '/meta.json') return json(200, { currentRelease: S.ver, releases: [{ version: S.ver }] });
    if (p === '/oauth/device/authorization') S.providers.push(j.loginProvider);
    if (p === '/oauth/device/authorization') return json(200, { deviceCode: 'DC-' + j.loginProvider, userCode: 'ABCD-EFGH', verificationUri: 'https://app.kiro.dev/account/device', verificationUriComplete: 'https://app.kiro.dev/account/device?user_code=ABCD-EFGH&login_provider=' + j.loginProvider, expiresInMilliseconds: 300000, intervalInMilliseconds: 1000 });
    if (p === '/oauth/device/poll') {
      if (j.clientId !== 'kiro-cli') return json(400, { message: 'bad client' });
      if (++S.polls % 2) return json(200, { accessToken: null, refreshToken: null, profileArn: null, status: 'authorization_pending' });
      return json(200, { accessToken: S.access, refreshToken: 'aorREFRESH-' + 'x'.repeat(40), profileArn: ARN, expiresIn: 3600, status: 'authorized' });
    }
    if (p === '/refreshToken') {
      S.refresh++;
      if (S.gone || !String(j.refreshToken).startsWith('aorREFRESH')) return json(401, { message: 'Bad credentials' });
      S.access = 'aoaACCESS' + (S.refresh + 1);
      return json(200, { accessToken: S.access, refreshToken: j.refreshToken, profileArn: ARN, expiresIn: 3600 });
    }
    /* AWS Builder ID (OIDC) */
    if (p === '/client/register') return json(200, { clientId: 'cid-1', clientSecret: 'secret-1', clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400 * 90 });
    if (p === '/device_authorization') return json(200, { deviceCode: 'ODC', userCode: 'WXYZ-1234', verificationUri: 'https://view.awsapps.com/start/#/device', verificationUriComplete: 'https://view.awsapps.com/start/#/device?user_code=WXYZ-1234', expiresIn: 600, interval: 1 });
    if (p === '/token') {
      if (j.grantType === 'refresh_token') { S.refresh++; S.access = 'aoaBUILDER' + S.refresh; return json(200, { accessToken: S.access, expiresIn: 3600 }); }
      if (++S.oidcPolls < 2) return json(400, { error: 'authorization_pending' });
      S.access = 'aoaBUILDER0';
      return json(200, { accessToken: S.access, refreshToken: 'aorBUILDERREFRESH-' + 'y'.repeat(30), expiresIn: 3600 });
    }
    if (p === '/ListAvailableModels') { if (!authed()) return json(403, { message: 'The bearer token included in the request is invalid.' }); return json(200, { models: MODELS, defaultModel: { modelId: 'claude-sonnet-4.5' } }); }
    if (p === '/getUsageLimits') {
      if (!authed()) return json(403, { message: 'The bearer token included in the request is invalid.' });
      return json(200, { userInfo: { email: 'kiro.user@example.com' }, subscriptionInfo: { subscriptionTitle: 'KIRO FREE' }, nextDateReset: 1798761600,
        usageBreakdownList: [{ resourceType: 'CREDIT', currentUsageWithPrecision: 12.5, usageLimitWithPrecision: 50, freeTrialInfo: { currentUsageWithPrecision: 20, usageLimitWithPrecision: 500, freeTrialStatus: 'ACTIVE', freeTrialExpiry: 1799000000 } }] });
    }
    if (p === '/generateAssistantResponse') {
      const step = S.script.shift() || { text: 'конец' };
      S.gen.push({ body: j, auth: q.headers.authorization, ua: q.headers['user-agent'] });
      if (step.expire) { S.access += 'X'; }
      if (!authed()) return json(403, { message: 'The bearer token included in the request is invalid.', reason: null });
      /* как у настоящего Kiro: старой версии IDE — отказ */
      if (S.need && !String(q.headers['user-agent']).includes('KiroIDE-' + S.need + '-')) { S.script.unshift(step); return json(400, { message: 'This version of Kiro is no longer supported. Please update to the latest version of Kiro to continue.', reason: null }); }
      if (step.err) return json(step.err, { message: step.msg || 'x', reason: step.reason || null });
      s.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
      const fr = [];
      if (step.think) fr.push(K.frame('reasoningContentEvent', { text: step.think }));
      for (const w of (step.text || '').match(/.{1,4}/gs) || []) fr.push(K.frame('assistantResponseEvent', { content: w }));
      for (const t of step.tools || []) { const a = JSON.stringify(t.args); fr.push(K.frame('toolUseEvent', { name: t.name, toolUseId: t.id, input: a.slice(0, 7) }), K.frame('toolUseEvent', { name: t.name, toolUseId: t.id, input: a.slice(7) }), K.frame('toolUseEvent', { name: t.name, toolUseId: t.id, stop: true })); }
      if (step.exc) fr.push(K.frame(step.exc, { message: step.msg || 'boom' }, 'exception'));
      fr.push(K.frame('meteringEvent', { unit: 'credit', unitPlural: 'credits', usage: 0.42 }), K.frame('contextUsageEvent', { contextUsagePercentage: 1.5 }));
      /* кадры режем как попало — разбор не должен зависеть от границ */
      const all = Buffer.concat(fr);
      for (let i = 0; i < all.length; i += 13) { s.write(all.subarray(i, i + 13)); if (i % 130 === 0) await sleep(1); }
      return s.end();
    }
    json(404, { message: 'no route ' + p });
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  url = 'http://127.0.0.1:' + srv.address().port;
  m = await startPersonalComputer({ PERSONALCOMPUTER_KIRO_AUTH_URL: url, PERSONALCOMPUTER_KIRO_OIDC_URL: url, PERSONALCOMPUTER_KIRO_API_URL: url, PERSONALCOMPUTER_KIRO_Q_URL: url, PERSONALCOMPUTER_KIRO_VERSION_URL: url + '/meta.json' });
});
after(async () => { await m?.stop(); srv?.close(); });

const logOf = evs => evs.flatMap(e => e.ev === 'log' ? [e.d] : e.ev === 'snap' ? e.d.log : []);
async function loginGoogle(c) {
  let r = await c.json('/api/kiro/login', { how: 'google' });
  assert.equal(r.status, 200);
  assert.equal(r.j.state, 'wait');
  assert.equal(r.j.code, 'ABCD-EFGH');
  assert.match(r.j.url, /login_provider=Google/);
  for (let i = 0; i < 60 && r.j.state !== 'ok'; i++) { await sleep(200); r = await c.json('/api/kiro/login', undefined, 'GET'); assert.notEqual(r.j.state, 'fail', r.j.msg); }
  assert.equal(r.j.state, 'ok');
  return r.j;
}

test('разбор: поток EventStream, размышления в начале ответа, пары вызов–результат, токен вручную', () => {
  const f = new K.Frames(), bin = Buffer.concat([K.frame('assistantResponseEvent', { content: '<thinking>план' }), K.frame('assistantResponseEvent', { content: '</thinking>Ответ' })]);
  const evs = []; for (let i = 0; i < bin.length; i += 5) evs.push(...f.push(bin.subarray(i, i + 5)));
  assert.equal(evs.length, 2);
  let t = '', th = ''; const sp = K.thinkSplit(d => { t += d; }, d => { th += d; });
  for (const e of evs) sp.push(e.j.content); sp.end();
  assert.equal(t, 'Ответ'); assert.equal(th, 'план');
  /* тег не в начале — это просто текст (например, в коде) */
  t = ''; th = ''; const sp2 = K.thinkSplit(d => { t += d; }, d => { th += d; }); sp2.push('Код: <think>x</think>'); sp2.end();
  assert.equal(t, 'Код: <think>x</think>'); assert.equal(th, '');
  /* вызов без результата и результат без вызова — Kiro такую историю не примет */
  const turns = K.convert([{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'x', arguments: '{"q":1}' } }, { id: 'b', function: { name: 'y', arguments: '' } }] }, { role: 'tool', tool_call_id: 'a', content: 'ok' }, { role: 'tool', tool_call_id: 'zzz', content: 'чужой' }]);
  assert.deepEqual(turns[1].a.uses.map(x => x.toolUseId), ['a']);
  assert.deepEqual(turns[2].u.res.map(x => x.toolUseId), ['a']);
  assert.match(turns[2].u.texts[0], /чужой/);
  assert.deepEqual(K.cleanSchema({ type: 'object', properties: { a: { type: 'object', additionalProperties: false, properties: {} } }, required: [], additionalProperties: false }), { type: 'object', properties: { a: { type: 'object', properties: {} } } });
  assert.equal(K.parseImport('{"accessToken":"aoa1","refreshToken":"aorAAAAAGabcdefghijklmnopqrstuv:sig","profileArn":"' + ARN + '","authMethod":"social","provider":"Google"}').how, 'token');
  assert.throws(() => K.parseImport('{"refreshToken":"aorAAAAAGabcdefghijklmnopqrstuv","authMethod":"IdC","provider":"BuilderId"}'), /clientId/);
  assert.throws(() => K.parseImport('hello'), /не токен Kiro/);
  assert.ok(K.isKiro('https://kiro.dev') && K.isKiro('https://app.kiro.dev/') && !K.isKiro('https://kiro.dev.evil.com'));
  assert.ok(K.caps('claude-sonnet-5').adapt && K.caps('claude-sonnet-4.5').inline && K.caps('gpt-5.6-sol').native && !K.caps('glm-5').think);
});

test('вход через Google по коду устройства: окно Kiro, токены сами, модели и кредиты', async () => {
  const c = await registered(m, 'kr1');
  const L = await loginGoogle(c);
  assert.equal(L.login, 'kiro.user@example.com');
  const st = (await c.json('/api/settings', undefined, 'GET')).j;
  assert.deepEqual(st.krLogin, { how: 'google', email: 'kiro.user@example.com' });
  assert.ok(st.provs.find(p => p.base === KB)?.hasKey);
  assert.ok(!JSON.stringify(st).includes('aorREFRESH'), 'refresh-токен наружу не отдаётся');
  const r = await c.json('/api/models', { base: KB });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.models, ['claude-sonnet-4.5', 'claude-sonnet-5', 'glm-5']);
  assert.equal(r.j.def, 'claude-sonnet-4.5');
  assert.equal(r.j.login, 'kiro.user@example.com');
  assert.equal(r.j.credits.used, 12.5); assert.equal(r.j.credits.limit, 50);
  assert.equal(r.j.credits.trial.limit, 500);
  const glm = r.j.info.find(x => x.id === 'glm-5');
  assert.equal(glm.img, false); assert.equal(glm.think, false); assert.equal(glm.rate, 0);
  assert.deepEqual(r.j.info.find(x => x.id === 'claude-sonnet-5').efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('чат: родные инструменты, размышление с уровнем, инструкция первым ходом, история по парам', async () => {
  const c = await registered(m, 'kr2');
  await loginGoogle(c);
  assert.equal((await c.json('/api/settings', { base: KB, model: 'claude-sonnet-5', think: true, effort: 'high' }, 'PUT')).status, 200);
  S.gen.length = 0;
  S.script = [
    { think: 'Посмотрю сервер.', text: 'Сейчас проверю.', tools: [{ name: 'run_command', id: 'tool-1', args: { action: 'Смотрю', command: 'echo привет' } }] },
    { think: 'Готово.', text: 'На сервере всё хорошо ^_^' },
  ];
  const done = c.events(evs => logOf(evs).some(e => e.kind === 'assistant' && e.text === 'На сервере всё хорошо ^_^'), 30000);
  assert.equal((await c.json('/api/chat', { text: 'проверь сервер' })).status, 200);
  const evs = await done;
  assert.equal(S.gen.length, 2);
  const [b0, b1] = S.gen.map(x => x.body);
  assert.equal(S.gen[0].auth, 'Bearer ' + S.access);
  assert.match(S.gen[0].ua, /KiroIDE-2\.0\.0-[0-9a-f]{64}$/, 'версия Kiro IDE — свежая, из файла обновлений');
  assert.equal(b0.profileArn, ARN);
  const cm0 = b0.conversationState.currentMessage.userInputMessage;
  assert.equal(cm0.modelId, 'claude-sonnet-5');
  assert.match(cm0.content, /^<thinking_mode>enabled<\/thinking_mode><max_thinking_length>32000<\/max_thinking_length>\n\nпроверь сервер/);
  assert.deepEqual(b0.additionalModelRequestFields, { output_config: { effort: 'high' }, thinking: { type: 'adaptive', display: 'summarized' } });
  assert.ok(cm0.userInputMessageContext.tools.some(t => t.toolSpecification.name === 'run_command'));
  assert.ok(!JSON.stringify(cm0.userInputMessageContext.tools).includes('additionalProperties'));
  assert.match(b0.conversationState.history[0].userInputMessage.content, /<system-instructions>/);
  assert.equal(b0.conversationState.conversationId, b1.conversationState.conversationId);
  /* второй шаг: ход с вызовом и результат с тем же id */
  const h1 = b1.conversationState.history, a = h1.at(-1).assistantResponseMessage;
  assert.equal(a.content, 'Сейчас проверю.');
  assert.deepEqual(a.toolUses, [{ toolUseId: 'tool-1', name: 'run_command', input: { action: 'Смотрю', command: 'echo привет' } }]);
  const res = b1.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults;
  assert.equal(res[0].toolUseId, 'tool-1');
  assert.match(res[0].content[0].text, /привет/);
  /* размышления — не в чате, а в окне по долгому нажатию */
  const log = logOf(evs);
  assert.ok(!JSON.stringify(log).includes('Посмотрю сервер'));
  const th = (await c.json('/api/chat/thoughts', undefined, 'GET')).j.list;
  assert.equal(th[0].text, 'Посмотрю сервер.'); assert.deepEqual(th[0].tools, ['Смотрю']);
});

test('доступ истёк посреди работы — обновляется сам и запрос повторяется; переписка не влезла — ужимается', async () => {
  const c = await registered(m, 'kr3');
  await loginGoogle(c);
  await c.json('/api/settings', { base: KB, model: 'claude-sonnet-4.5', think: false }, 'PUT');
  S.gen.length = 0; const r0 = S.refresh;
  S.script = [{ expire: true }, { err: 400, msg: 'Input is too long.', reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD' }, { text: 'Ответ после обновления' }];
  const done = c.events(evs => logOf(evs).some(e => (e.kind === 'assistant' && e.text === 'Ответ после обновления') || e.kind === 'error'), 30000);
  await c.json('/api/chat', { text: 'привет' });
  const e = logOf(await done).find(x => x.kind === 'error');
  assert.equal(e, undefined, e?.text);
  assert.equal(S.refresh, r0 + 1);
  assert.equal(S.gen.length, 3);
  assert.equal(S.gen[2].auth, 'Bearer ' + S.access);
  /* без размышления — ни директивы, ни поля */
  assert.ok(!S.gen[2].body.conversationState.currentMessage.userInputMessage.content.includes('thinking_mode'));
  assert.equal(S.gen[2].body.additionalModelRequestFields, undefined);
});

test('кредиты кончились — понятная ошибка; вход отозван — просьба войти снова', async () => {
  const c = await registered(m, 'kr4');
  await loginGoogle(c);
  await c.json('/api/settings', { base: KB, model: 'claude-sonnet-4.5' }, 'PUT');
  S.script = [{ err: 429, msg: 'You have reached the limit.', reason: 'MONTHLY_REQUEST_COUNT' }];
  let done = c.events(evs => logOf(evs).some(e => e.kind === 'error'), 30000);
  await c.json('/api/chat', { text: 'привет' });
  assert.match(logOf(await done).find(x => x.kind === 'error').text, /Кредиты Kiro на этот месяц кончились/);
  S.gone = true;
  S.script = [{ expire: true }];
  done = c.events(evs => logOf(evs).filter(e => e.kind === 'error').length >= 2, 30000);
  await c.json('/api/chat', { text: 'ещё' });
  const errs = logOf(await done).filter(x => x.kind === 'error');
  assert.match(errs.at(-1).text, /Войди снова/);
  S.gone = false;
});

test('AWS Builder ID и «токен вручную»; «Отключить» стирает вход', async () => {
  const c = await registered(m, 'kr5');
  let r = await c.json('/api/kiro/login', { how: 'builder' });
  assert.equal(r.j.code, 'WXYZ-1234');
  for (let i = 0; i < 60 && r.j.state !== 'ok'; i++) { await sleep(200); r = await c.json('/api/kiro/login', undefined, 'GET'); assert.notEqual(r.j.state, 'fail', r.j.msg); }
  assert.equal(r.j.state, 'ok');
  assert.equal((await c.json('/api/settings', undefined, 'GET')).j.krLogin.how, 'builder');
  r = await c.json('/api/kiro/import', { text: 'aorREFRESH-' + 'z'.repeat(40) });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.login, 'kiro.user@example.com');
  assert.equal((await c.json('/api/settings', undefined, 'GET')).j.krLogin.how, 'token');
  r = await c.json('/api/kiro/import', { text: 'не токен' });
  assert.equal(r.status, 400);
  await c.json('/api/settings', { forget: KB }, 'PUT');
  const st = (await c.json('/api/settings', undefined, 'GET')).j;
  assert.equal(st.krLogin, null);
  assert.ok(!st.provs.some(p => p.base === KB));
});

test('Kiro сказал «версия устарела» — сервер узнаёт свежую версию и повторяет; не помогло — объясняем, что делать', async () => {
  const c = await registered(m, 'kr6');
  await loginGoogle(c);
  await c.json('/api/settings', { base: KB, model: 'claude-sonnet-4.5', think: false }, 'PUT');
  S.gen.length = 0; S.ver = '3.1.0'; S.need = '3.1.0';
  S.script = [{ text: 'Ответ новой версии' }];
  let done = c.events(evs => logOf(evs).some(e => (e.kind === 'assistant' && e.text === 'Ответ новой версии') || e.kind === 'error'), 30000);
  await c.json('/api/chat', { text: 'привет' });
  const e = logOf(await done).find(x => x.kind === 'error');
  assert.equal(e, undefined, e?.text);
  assert.match(S.gen.at(-1).ua, /KiroIDE-3\.1\.0-/);
  S.need = '9.0.0';
  S.script = [{ text: 'не дойдёт' }];
  done = c.events(evs => logOf(evs).some(x => x.kind === 'error'), 30000);
  await c.json('/api/chat', { text: 'ещё' });
  assert.match(logOf(await done).find(x => x.kind === 'error').text, /Обнови Personal Computer/);
  S.need = ''; S.script = [];
});

test('вход по email — аккаунт Kiro (Cognito) тем же окном', async () => {
  const c = await registered(m, 'kr7');
  let r = await c.json('/api/kiro/login', { how: 'email' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.match(r.j.url, /login_provider=Cognito/);
  assert.equal(S.providers.at(-1), 'Cognito');
  for (let i = 0; i < 60 && r.j.state !== 'ok'; i++) { await sleep(200); r = await c.json('/api/kiro/login', undefined, 'GET'); }
  assert.equal(r.j.state, 'ok', r.j.msg);
  assert.equal((await c.json('/api/settings', undefined, 'GET')).j.krLogin.how, 'email');
  assert.equal((await c.json('/api/kiro/login', { how: 'bogus' })).status, 400);
});
