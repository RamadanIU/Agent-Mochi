/* Провайдер Antigravity: фальшивые Google OAuth (код входа с PKCE, обновление доступа, userinfo) и Cloud Code
   (loadCodeAssist, onboardUser, fetchAvailableModels, streamGenerateContent потоком SSE), файл обновлений Antigravity */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { startPersonalComputer, registered, sleep } from './helpers.js';
import * as A from '../lib/antigravity.js';

const AB = 'https://antigravity.google', GOOD = '4/0AGOODCODE-' + 'x'.repeat(30), BAD = '4/0ABADCODE-' + 'y'.repeat(30);
const future = () => new Date(Date.now() + 2 * 3600e3).toISOString();
const MODELS = () => ({
  'gemini-3-flash': { displayName: 'Gemini 3 Flash', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', quotaInfo: { remainingFraction: 0.8, resetTime: future() } },
  'gemini-3.1-pro-high': { displayName: 'Gemini 3.1 Pro (High)', supportsImages: true, supportsThinking: true, maxTokens: 1048576, maxOutputTokens: 65536, quotaInfo: { remainingFraction: 1 } },
  'claude-opus-4-6-thinking': { displayName: 'Claude Opus 4.6 (Thinking)', supportsImages: true, supportsThinking: true, maxTokens: 200000, maxOutputTokens: 64000, apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX', quotaInfo: { remainingFraction: 0.4, resetTime: future() } },
  'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', supportsImages: true, maxTokens: 200000, maxOutputTokens: 64000, quotaInfo: { remainingFraction: 0.4, resetTime: future() } },
  'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', supportsImages: false, quotaInfo: { remainingFraction: 1 } },
  'tab_flash_lite_preview': { displayName: 'Tab', isInternal: true },
  'gemini-3-pro-image': { displayName: 'Nano Banana Pro' },
  'gemini-4-argon-disabled': { displayName: 'Gemini 4 Argon' },
});
let m, srv, url, cbPort;
const S = { gen: [], refresh: 0, access: 'ya29.ACCESS0', gone: false, ver: '2.40.1', need: '', script: [], onboarded: false, onb: 0, challenge: '', loads: 0, fam: [] };
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

before(async () => {
  srv = http.createServer(async (q, s) => {
    let b = ''; for await (const c of q) b += c;
    const p = new URL(q.url, 'http://x').pathname;
    const json = (st, o) => { s.writeHead(st, { 'content-type': 'application/json' }); s.end(JSON.stringify(o)); };
    const authed = () => q.headers.authorization === 'Bearer ' + S.access;
    const gErr = (code, status, message, details = []) => json(code, { error: { code, status, message, details } });
    /* файл обновлений Antigravity: отсюда сервер узнаёт свежую версию */
    if (p === '/manifest.yml') { s.writeHead(200, { 'content-type': 'text/yaml' }); return s.end(`version: ${S.ver}\nfiles:\n  - url: https://example.com/Antigravity.zip\n    version: 0.0.1\n`); }
    if (p === '/token') {
      const f = new URLSearchParams(b);
      if (!String(f.get('client_id')).startsWith('1071006060591-') || !String(f.get('client_secret')).startsWith('GOCSPX-')) return json(401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'authorization_code') {
        const ok = f.get('code') === GOOD && f.get('redirect_uri') === 'http://localhost:51121/oauth-callback'
          && crypto.createHash('sha256').update(String(f.get('code_verifier'))).digest('base64url') === S.challenge;
        if (!ok) return json(400, { error: 'invalid_grant', error_description: 'Bad Request' });
        return json(200, { access_token: S.access, refresh_token: '1//0gREFRESH-' + 'r'.repeat(40), expires_in: 3599, token_type: 'Bearer' });
      }
      if (f.get('grant_type') === 'refresh_token') {
        S.refresh++;
        if (S.gone || !String(f.get('refresh_token')).startsWith('1//0g')) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        S.access = 'ya29.ACCESS' + S.refresh;
        return json(200, { access_token: S.access, expires_in: 3599 });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (p === '/userinfo') return authed() ? json(200, { email: 'ag.user@gmail.com', name: 'Тест Тестов' }) : json(401, {});
    if (!authed()) return gErr(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
    const j = b ? JSON.parse(b) : {};
    if (p === '/v1internal:loadCodeAssist') {
      S.loads++;
      if (j.metadata?.ideType !== 'ANTIGRAVITY') return gErr(400, 'INVALID_ARGUMENT', 'bad metadata');
      return json(200, S.onboarded ? { cloudaicompanionProject: 'proj-123', currentTier: { id: 'free-tier' }, paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } } : { allowedTiers: [{ id: 'free-tier', isDefault: true }] });
    }
    if (p === '/v1internal:onboardUser') {
      if (!/google-api-nodejs-client/.test(q.headers['user-agent']) || j.tier_id !== 'free-tier') return gErr(400, 'INVALID_ARGUMENT', 'bad onboard');
      if (++S.onb < 2) return json(200, { name: 'operations/1', done: false });
      S.onboarded = true;
      return json(200, { name: 'operations/1', done: true, response: { cloudaicompanionProject: { id: 'proj-123', name: 'proj' } } });
    }
    if (p === '/v1internal:fetchAvailableModels') {
      if (j.project !== 'proj-123') return gErr(403, 'PERMISSION_DENIED', 'no project');
      return json(200, { models: MODELS(), defaultAgentModelId: 'gemini-3-flash', agentModelSorts: [{ displayName: 'Recommended', groups: [{ modelIds: ['gemini-3.1-pro-high', 'gemini-3-flash', 'claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gpt-oss-120b-medium', 'gemini-4-argon-disabled'] }] }] });
    }
    if (p === '/v1internal:streamGenerateContent') {
      const step = S.script.shift() || { text: 'конец' };
      S.gen.push({ body: j, auth: q.headers.authorization, ua: q.headers['user-agent'], beta: q.headers['anthropic-beta'] || '', alt: new URL(q.url, 'http://x').searchParams.get('alt') });
      if (step.expire) { S.access += 'X'; return gErr(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.'); }
      /* как у настоящего Google: старой версии — отказ */
      if (S.need && !String(q.headers['user-agent']).includes('antigravity/hub/' + S.need + ' ')) { S.script.unshift(step); return gErr(400, 'FAILED_PRECONDITION', 'This version of Antigravity is no longer supported. Please update to receive the latest features!'); }
      if (step.err) return gErr(step.err, step.status || 'RESOURCE_EXHAUSTED', step.msg || 'x', step.details || []);
      s.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = parts => 'data: ' + JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts } }], modelVersion: j.model }, traceId: 't1' }) + '\r\n\r\n';
      let out = '';
      if (step.think) { for (const w of step.think.match(/.{1,6}/gs)) out += ev([{ thought: true, text: w }]); out += ev([{ thought: true, text: '', thoughtSignature: step.sig || 'SIG-' + 'c'.repeat(60) }]); }
      for (const w of (step.text || '').match(/.{1,5}/gs) || []) out += ev([{ text: w }]);
      for (const c of step.calls || []) out += ev([{ functionCall: { name: c.name, args: c.args, ...(c.id ? { id: c.id } : {}) }, ...(c.sig ? { thoughtSignature: c.sig } : {}) }]);
      out += 'data: ' + JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: step.finish || 'STOP' }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 30, totalTokenCount: 1230 } } }) + '\r\n\r\n';
      /* поток режем как попало — разбор не должен зависеть от границ */
      for (let i = 0; i < out.length; i += 17) { s.write(out.slice(i, i + 17)); if (i % 170 === 0) await sleep(1); }
      return s.end();
    }
    json(404, { error: { code: 404, message: 'no route ' + p } });
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  url = 'http://127.0.0.1:' + srv.address().port;
  cbPort = await freePort();
  const env = { PERSONALCOMPUTER_AG_AUTH_URL: url + '/auth', PERSONALCOMPUTER_AG_TOKEN_URL: url + '/token', PERSONALCOMPUTER_AG_USERINFO_URL: url + '/userinfo', PERSONALCOMPUTER_AG_API_URL: url, PERSONALCOMPUTER_AG_VERSION_URL: url + '/manifest.yml' };
  /* этому процессу (прямые вызовы turn) — те же адреса */
  Object.assign(process.env, env);
  m = await startPersonalComputer({ ...env, PERSONALCOMPUTER_AG_CALLBACK_PORT: String(cbPort) });
});
after(async () => { await m?.stop(); srv?.close(); });

const logOf = evs => evs.flatMap(e => e.ev === 'log' ? [e.d] : e.ev === 'snap' ? e.d.log : []);
const cbUrl = (state, code = GOOD) => 'http://localhost:51121/oauth-callback?state=' + encodeURIComponent(state) + '&code=' + encodeURIComponent(code) + '&scope=email%20profile%20https://www.googleapis.com/auth/cloud-platform';
async function startLogin(c) {
  const r = await c.json('/api/antigravity/login', {});
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.state, 'wait');
  const u = new URL(r.j.url);
  S.challenge = u.searchParams.get('code_challenge');
  return { state: u.searchParams.get('state'), u };
}
async function waitOk(c) {
  let r = await c.json('/api/antigravity/login', undefined, 'GET');
  for (let i = 0; i < 100 && r.j.state !== 'ok'; i++) { assert.notEqual(r.j.state, 'fail', r.j.msg); await sleep(150); r = await c.json('/api/antigravity/login', undefined, 'GET'); }
  assert.equal(r.j.state, 'ok', r.j.msg);
  return r.j;
}
async function login(c) { const { state } = await startLogin(c); assert.equal((await c.json('/api/antigravity/login', { text: cbUrl(state) }, 'PUT')).status, 200); return waitOk(c); }

test('разбор: адрес со страницы localhost, токен вручную, схемы Google, пары вызов–результат, подписи, ошибки', () => {
  assert.ok(A.isAntigravity('https://antigravity.google') && A.isAntigravity('https://antigravity.google/') && !A.isAntigravity('https://antigravity.google.evil.com') && !A.isAntigravity('https://kiro.dev'));
  /* что вставляют: адрес целиком, только ?…, сам код; отмена на странице Google — понятная ошибка */
  assert.deepEqual(A.parseCallback(cbUrl('ST1')), { code: GOOD, nonce: 'ST1' });
  assert.deepEqual(A.parseCallback('  "?state=ST2&code=4%2F0Aabc-' + 'q'.repeat(20) + '&scope=x"  '), { code: '4/0Aabc-' + 'q'.repeat(20), nonce: 'ST2' });
  assert.deepEqual(A.parseCallback('4%2F0AQQQ' + 'w'.repeat(20)), { code: '4/0AQQQ' + 'w'.repeat(20), nonce: '' });
  assert.throws(() => A.parseCallback('http://localhost:51121/oauth-callback?error=access_denied&state=x'), /отменён/);
  assert.throws(() => A.parseCallback('http://localhost:51121/oauth-callback'), /нет кода/);
  assert.throws(() => A.parseCallback(''), /Вставь адрес/);
  /* токен вручную: просто ключ, opencode (refresh|project|managed и antigravity-accounts.json), CLIProxyAPI, Antigravity CLI */
  const RT = '1//0gTOKEN-' + 'a'.repeat(40);
  assert.deepEqual(A.parseImport(RT), { refresh: RT, project: '', email: '' });
  assert.deepEqual(A.parseImport(RT + '|my-proj|managed-proj'), { refresh: RT, project: 'managed-proj', email: '' });
  assert.deepEqual(A.parseImport(JSON.stringify({ version: 3, accounts: [{ email: 'a@b.c', refreshToken: RT, projectId: '', managedProjectId: 'mp-1' }] })), { refresh: RT, project: 'mp-1', email: 'a@b.c' });
  assert.deepEqual(A.parseImport(JSON.stringify({ type: 'antigravity', email: 'x@y.z', refresh_token: RT, project_id: 'p-9', access_token: 'ya29.q' })), { refresh: RT, project: 'p-9', email: 'x@y.z' });
  assert.equal(A.parseImport(JSON.stringify({ auth_method: 'consumer', token: { access_token: 'ya29.q', refresh_token: RT, expiry: '2026-11-13T10:00:00Z' } })).refresh, RT);
  assert.throws(() => A.parseImport('aorKIROTOKEN-' + 'z'.repeat(30)), /не ключ Google/);

  /* схема Google: типы заглавными, $ref подставлен, anyOf с null — nullable, ограничения — в описании,
     «любой объект» — строкой JSON, которую в ответе разбираем обратно */
  const { schema, fix } = A.gSchema({ type: 'object', additionalProperties: false, required: ['q', 'nope'],
    properties: { q: { type: 'string', minLength: 2, description: 'запрос' }, mode: { enum: ['a', 'b'] }, n: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
      headers: { type: 'object', additionalProperties: { type: 'string' } }, list: { type: 'array' }, opts: { $ref: '#/$defs/O' }, any: {} },
    $defs: { O: { type: 'object', properties: { deep: { type: ['boolean', 'null'] }, meta: { type: 'object' } } } } });
  assert.deepEqual(schema.required, ['q']);
  assert.deepEqual(schema.properties.q, { type: 'STRING', description: 'запрос Длина не меньше 2.' });
  assert.deepEqual(schema.properties.mode, { type: 'STRING', enum: ['a', 'b'] });
  assert.deepEqual(schema.properties.n, { type: 'INTEGER', description: '≥ 1.', nullable: true });
  assert.equal(schema.properties.headers.type, 'STRING');
  assert.deepEqual(schema.properties.list, { type: 'ARRAY', items: { type: 'STRING' } });
  assert.deepEqual(schema.properties.opts.properties.deep, { type: 'BOOLEAN', nullable: true });
  assert.ok(!JSON.stringify(schema).match(/additionalProperties|\$ref|\$defs|minLength|anyOf/));
  const args = A.fixArgs({ headers: '{"X-A":"1"}', opts: { meta: '{"k":[1]}' }, any: '[1,2]', q: '{не json' }, fix);
  assert.deepEqual(args, { headers: { 'X-A': '1' }, opts: { meta: { k: [1] } }, any: [1, 2], q: '{не json' });
  /* совсем без параметров — служебное поле (Claude не принимает пустой объект) */
  assert.deepEqual(A.gSchema({ type: 'object' }).schema.required, ['_placeholder']);

  /* переписка → contents: вызовы без результатов и чужие результаты не уходят; подписи — Claude в текущей цепочке, Gemini — у вызовов */
  const H = [{ role: 'user', content: 'привет' },
    { role: 'assistant', content: 'смотрю', tool_calls: [{ id: 'a', function: { name: 'run_command', arguments: '{"command":"ls"}' } }, { id: 'b', function: { name: 'x', arguments: '' } }], ag: { th: [{ t: 'думаю', s: 'S1' }], cs: { a: 'GS1' } } },
    { role: 'tool', tool_call_id: 'a', content: 'файлы' }, { role: 'tool', tool_call_id: 'zzz', content: 'чужой' }];
  const cl = A.convert(H, { claude: true }).contents;
  assert.deepEqual(cl.map(c => c.role), ['user', 'model', 'user']);
  assert.deepEqual(cl[1].parts[0], { text: 'думаю', thought: true, thoughtSignature: 'S1' });
  assert.deepEqual(cl[1].parts.slice(1), [{ text: 'смотрю' }, { functionCall: { name: 'run_command', args: { command: 'ls' }, id: 'a' } }]);
  assert.deepEqual(cl[2].parts[0], { functionResponse: { name: 'run_command', id: 'a', response: { output: 'файлы' } } });
  assert.match(cl[2].parts[1].text, /чужой/);
  assert.equal(A.convert(H, { claude: true }).signed, true);
  /* новая просьба пользователя закрывает цепочку — старые размышления Claude больше не нужны */
  const cl2 = A.convert([...H, { role: 'assistant', content: 'готово' }, { role: 'user', content: 'ещё' }], { claude: true }).contents;
  assert.ok(!JSON.stringify(cl2).includes('thoughtSignature'));
  const gm = A.convert(H, { gem: true }).contents;
  assert.equal(gm[1].parts.at(-1).thoughtSignature, 'GS1');
  assert.equal(gm[1].parts.at(-1).functionCall.id, undefined);
  assert.equal(A.convert([{ role: 'assistant', content: '', tool_calls: [{ id: 'q', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'q', content: 'ok' }], { gem: true }).contents[1].parts[0].thoughtSignature, 'skip_thought_signature_validator');
  /* картинки — моделям со зрением, PDF — только Gemini */
  const parts = [{ type: 'text', text: 'смотри' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,BBBB' } }];
  assert.deepEqual(A.convert([{ role: 'user', content: parts }], { img: true, pdf: true }).contents[0].parts.slice(1), [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }, { inlineData: { mimeType: 'application/pdf', data: 'BBBB' } }]);
  assert.match(A.convert([{ role: 'user', content: parts }], { img: false }).contents[0].parts[1].text, /не видит картинки/);

  /* ошибки Google → понятный текст и что делать */
  assert.equal(A.fail(401, { error: { code: 401, status: 'UNAUTHENTICATED' } }, '').auth, true);
  assert.equal(A.fail(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource exhausted', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3.5s' }] } }, '').waitMs, 3500);
  const q = A.fail(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You have exhausted your capacity on this model. Your quota will reset after 2h5m10s.' } }, '', 'claude-x');
  assert.ok(q.quota); assert.match(q.human, /Лимит модели «claude-x».*обновится через 2 ч 5 мин/);
  assert.ok(A.fail(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'MODEL_CAPACITY_EXHAUSTED' } }, '').retry);
  assert.equal(A.fail(400, { error: { code: 400, message: "Invalid JSON payload received. Unknown name \"exclusiveMinimum\" at 'request.tools[0].function_declarations[3].parameters.properties[0].value': Cannot find field." } }, '').badTool, 3);
  assert.ok(A.fail(400, { error: { code: 400, message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } }, '').sig);
  const v = A.fail(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Verify your account to continue.', details: [{ reason: 'VALIDATION_REQUIRED', metadata: { validation_url: 'https://accounts.google.com/signin/continue?x=1' } }] } }, '');
  assert.equal(v.verify, 'https://accounts.google.com/signin/continue?x=1');
  assert.ok(A.fail(400, { error: { message: 'This version of Antigravity is no longer supported.' } }, '').outdated);
  /* глубина: выбранная, если модель её знает, иначе ближайшая (при равенстве — повыше) */
  assert.equal(A.level({ efforts: ['low', 'high'] }, 'medium'), 'high');
  assert.equal(A.level({ efforts: ['minimal', 'low', 'medium', 'high'] }, ''), 'medium');
  assert.equal(A.level({ efforts: [] }, 'high'), '');
  assert.deepEqual(A.caps('gemini-3.1-pro-high').efforts, []);
  assert.deepEqual(A.caps('gemini-3-flash').efforts, ['minimal', 'low', 'medium', 'high']);
  assert.ok(A.caps('claude-opus-4-6-thinking').budget && !A.caps('claude-sonnet-4-6').think);
});

test('вход через Google: адрес со страницы localhost вставили — доступ, проект, модели и лимиты', async () => {
  const c = await registered(m, 'ag1');
  const { state, u } = await startLogin(c);
  assert.equal(u.origin + u.pathname, url + '/auth');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:51121/oauth-callback');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.match(u.searchParams.get('client_id'), /^1071006060591-/);
  assert.match(u.searchParams.get('scope'), /cloud-platform.*userinfo\.email.*cclog/);
  assert.ok(!/openid/.test(u.searchParams.get('scope')));
  /* чужой адрес (state от другого входа) — отказ; код, который Google не принял, — вход продолжается, можно вставить ещё раз */
  assert.equal((await c.json('/api/antigravity/login', { text: cbUrl('other-state') }, 'PUT')).status, 400);
  assert.equal((await c.json('/api/antigravity/login', { text: 'просто текст' }, 'PUT')).status, 400);
  let r = await c.json('/api/antigravity/login', { text: cbUrl(state, BAD) }, 'PUT');
  assert.equal(r.status, 200);
  for (let i = 0; i < 40 && !(r.j.state === 'wait' && r.j.msg); i++) { await sleep(100); r = await c.json('/api/antigravity/login', undefined, 'GET'); }
  assert.equal(r.j.state, 'wait');
  assert.match(r.j.msg, /не принял код/);
  assert.equal((await c.json('/api/antigravity/login', { text: cbUrl(state) }, 'PUT')).status, 200);
  const L = await waitOk(c);
  assert.equal(L.login, 'ag.user@gmail.com');
  assert.equal(S.onb, 2, 'новый аккаунт: проект подключён (onboardUser), как при первом входе в Antigravity');
  const st = (await c.json('/api/settings', undefined, 'GET')).j;
  assert.deepEqual(st.agLogin, { how: 'google', email: 'ag.user@gmail.com' });
  assert.ok(st.provs.find(p => p.base === AB)?.hasKey);
  assert.ok(!JSON.stringify(st).includes('1//0g'), 'refresh-токен наружу не отдаётся');
  /* модели — те, что Antigravity показывает агенту, в его порядке; лимиты — у каждой и группами */
  r = await c.json('/api/models', { base: AB });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.models, ['gemini-3.1-pro-high', 'gemini-3-flash', 'claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gpt-oss-120b-medium']);
  assert.equal(r.j.def, 'gemini-3-flash');
  assert.equal(r.j.plan, 'Pro');
  assert.equal(r.j.login, 'ag.user@gmail.com');
  const flash = r.j.info.find(x => x.id === 'gemini-3-flash');
  assert.equal(flash.q, 0.8); assert.ok(flash.reset > Date.now()); assert.deepEqual(flash.efforts, ['minimal', 'low', 'medium', 'high']);
  assert.equal(r.j.info.find(x => x.id === 'gpt-oss-120b-medium').img, false);
  assert.deepEqual(r.j.quota.map(g => [g.name, g.left]), [['Gemini Pro', 1], ['Gemini Flash', 0.8], ['Claude', 0.4], ['GPT-OSS', 1]]);
});

test('Personal Computer открыт на этом же компьютере: код со страницы localhost сервер ловит сам', async () => {
  const c = await registered(m, 'ag2');
  const { state } = await startLogin(c);
  let p;
  for (let i = 0; i < 40; i++) { try { p = await fetch(`http://127.0.0.1:${cbPort}/oauth-callback?state=nope&code=${encodeURIComponent(GOOD)}`); break; } catch { await sleep(50); } }
  assert.equal(p.status, 400, 'чужой state — не принимаем');
  p = await fetch(`http://127.0.0.1:${cbPort}/oauth-callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(GOOD)}&scope=x`);
  assert.equal(p.status, 200);
  assert.match(await p.text(), /Готово/);
  assert.equal((await waitOk(c)).login, 'ag.user@gmail.com');
});

test('чат с Claude: родные инструменты, размышления с подписью возвращаются модели, своя инструкция после Antigravity', async () => {
  const c = await registered(m, 'ag3');
  await login(c);
  assert.equal((await c.json('/api/settings', { base: AB, model: 'claude-opus-4-6-thinking', effort: 'high' }, 'PUT')).status, 200);
  await c.json('/api/models', { base: AB });
  S.gen.length = 0;
  S.script = [
    { think: 'Посмотрю сервер.', sig: 'CLAUDESIG-' + 'k'.repeat(60), text: 'Сейчас проверю.', calls: [{ id: 'toolu_1', name: 'run_command', args: { action: 'Смотрю', command: 'echo привет' } }] },
    { think: 'Готово.', text: 'На сервере всё хорошо ^_^' },
  ];
  const done = c.events(evs => logOf(evs).some(e => (e.kind === 'assistant' && e.text === 'На сервере всё хорошо ^_^') || e.kind === 'error'), 30000);
  assert.equal((await c.json('/api/chat', { text: 'проверь сервер' })).status, 200);
  const evs = await done, err = logOf(evs).find(e => e.kind === 'error');
  assert.equal(err, undefined, err?.text);
  assert.equal(S.gen.length, 2);
  const [g0, g1] = S.gen, b0 = g0.body, b1 = g1.body;
  assert.equal(g0.alt, 'sse');
  assert.match(g0.ua, /^antigravity\/hub\/2\.40\.1 \(aidev_client; os_type=darwin; arch=arm64\)$/, 'версия — свежая, из файла обновлений');
  assert.equal(g0.beta, 'interleaved-thinking-2025-05-14');
  assert.equal(b0.project, 'proj-123'); assert.equal(b0.model, 'claude-opus-4-6-thinking');
  assert.equal(b0.userAgent, 'antigravity'); assert.equal(b0.requestType, 'agent'); assert.match(b0.requestId, /^agent-[0-9a-f-]{36}$/);
  const R0 = b0.request;
  assert.equal(R0.systemInstruction.role, 'user');
  assert.match(R0.systemInstruction.parts[0].text, /^You are Antigravity/);
  assert.match(R0.systemInstruction.parts[1].text, /Personal Computer/);
  assert.deepEqual(R0.generationConfig, { maxOutputTokens: 64000, thinkingConfig: { include_thoughts: true, thinking_budget: 32000 } });
  assert.deepEqual(R0.toolConfig, { functionCallingConfig: { mode: 'VALIDATED' } });
  const rc = R0.tools[0].functionDeclarations.find(d => d.name === 'run_command');
  assert.equal(rc.parameters.type, 'OBJECT'); assert.equal(rc.parameters.properties.command.type, 'STRING');
  assert.equal(R0.sessionId, b1.request.sessionId, 'один чат — одна сессия');
  /* второй шаг: ход модели — подписанные размышления, текст и вызов с id; результат — functionResponse с тем же id */
  const mod = b1.request.contents.at(-2), usr = b1.request.contents.at(-1);
  assert.equal(mod.role, 'model');
  assert.deepEqual(mod.parts[0], { text: 'Посмотрю сервер.', thought: true, thoughtSignature: 'CLAUDESIG-' + 'k'.repeat(60) });
  assert.deepEqual(mod.parts[2], { functionCall: { name: 'run_command', args: { action: 'Смотрю', command: 'echo привет' }, id: 'toolu_1' } });
  assert.equal(usr.parts[0].functionResponse.id, 'toolu_1');
  assert.match(usr.parts[0].functionResponse.response.output, /привет/);
  /* размышления — не в чате, а в окне по долгому нажатию */
  assert.ok(!JSON.stringify(logOf(evs)).includes('Посмотрю сервер'));
  const th = (await c.json('/api/chat/thoughts', undefined, 'GET')).j.list;
  assert.equal(th[0].text, 'Посмотрю сервер.');
});

test('Gemini: подпись вызова уходит обратно, «любой объект» — строкой JSON и обратно; несломанное в повторе', async () => {
  const tools = [{ type: 'function', function: { name: 'http.get', description: 'запрос', parameters: { type: 'object', properties: { url: { type: 'string' }, headers: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['url'] } } }];
  const auth = { project: 'proj-123' };
  S.gen.length = 0;
  S.script = [{ finish: 'MALFORMED_FUNCTION_CALL' }, { calls: [{ name: 'http_get', args: { url: 'https://x', headers: '{"A":"1"}' }, sig: 'GEMSIG-1' }] }];
  const r = await A.turn({ token: S.access, auth, model: 'gemini-3-flash', tools, effort: 'low', msgs: [{ role: 'user', content: 'сходи' }], conv: 'g-test' });
  assert.equal(S.gen.length, 2, 'сломанный вызов (MALFORMED_FUNCTION_CALL) — спрашиваем ещё раз');
  const R = S.gen[0].body.request;
  assert.deepEqual(R.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'low' });
  assert.equal(R.toolConfig, undefined);
  const d = R.tools[0].functionDeclarations[0];
  assert.equal(d.name, 'http_get'); assert.equal(d.parameters.properties.headers.type, 'STRING');
  assert.deepEqual(r.calls.map(x => [x.function.name, JSON.parse(x.function.arguments)]), [['http.get', { url: 'https://x', headers: { A: '1' } }]]);
  assert.equal(r.rs.ag.cs[r.calls[0].id], 'GEMSIG-1');
  /* следующий шаг: подпись — у того же вызова */
  S.script = [{ text: 'Готово' }];
  const msgs = [{ role: 'user', content: 'сходи' }, { role: 'assistant', content: null, tool_calls: r.calls, ag: r.rs.ag }, { role: 'tool', tool_call_id: r.calls[0].id, content: '200 OK' }];
  assert.equal((await A.turn({ token: S.access, auth, model: 'gemini-3-flash', tools, msgs, conv: 'g-test' })).text, 'Готово');
  const fc = S.gen.at(-1).body.request.contents[1].parts[0];
  assert.equal(fc.thoughtSignature, 'GEMSIG-1');
  assert.deepEqual(fc.functionCall, { name: 'http_get', args: { url: 'https://x', headers: { A: '1' } } });
  assert.deepEqual(S.gen.at(-1).body.request.contents[2].parts[0].functionResponse, { name: 'http_get', response: { output: '200 OK' } });
});

test('доступ истёк посреди работы и «слишком часто» — сервер сам обновляет, ждёт и повторяет', async () => {
  const c = await registered(m, 'ag4');
  await login(c);
  await c.json('/api/settings', { base: AB, model: 'claude-sonnet-4-6' }, 'PUT');
  S.gen.length = 0; const r0 = S.refresh;
  S.script = [{ expire: true }, { err: 429, msg: 'Resource has been exhausted (e.g. check quota).', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.3s' }] }, { text: 'Ответ после обновления' }];
  const done = c.events(evs => logOf(evs).some(e => (e.kind === 'assistant' && e.text === 'Ответ после обновления') || e.kind === 'error'), 30000);
  await c.json('/api/chat', { text: 'привет' });
  const e = logOf(await done).find(x => x.kind === 'error');
  assert.equal(e, undefined, e?.text);
  assert.equal(S.refresh, r0 + 1);
  assert.equal(S.gen.length, 3);
  assert.equal(S.gen[2].auth, 'Bearer ' + S.access);
  /* Claude без «-thinking» — без настройки размышления и без заголовка */
  assert.equal(S.gen[2].body.request.generationConfig.thinkingConfig, undefined);
  assert.equal(S.gen[2].beta, '');
});

test('лимит модели кончился — понятная ошибка; вход отозван — просьба войти снова', async () => {
  const c = await registered(m, 'ag5');
  await login(c);
  await c.json('/api/settings', { base: AB, model: 'claude-sonnet-4-6' }, 'PUT');
  await c.json('/api/models', { base: AB });
  S.script = [{ err: 429, msg: 'You have exhausted your capacity on this model. Your quota will reset after 1h30m0s.' }];
  let done = c.events(evs => logOf(evs).some(e => e.kind === 'error'), 30000);
  await c.json('/api/chat', { text: 'привет' });
  const t = logOf(await done).find(x => x.kind === 'error').text;
  assert.match(t, /Лимит модели «Claude Sonnet 4\.6» в Antigravity исчерпан — обновится через 1 ч 30 мин/);
  assert.match(t, /сейчас есть у: Gemini 3\.1 Pro/);
  S.gone = true;
  S.script = [{ expire: true }];
  done = c.events(evs => logOf(evs).filter(e => e.kind === 'error').length >= 2, 30000);
  await c.json('/api/chat', { text: 'ещё' });
  assert.match(logOf(await done).filter(x => x.kind === 'error').at(-1).text, /Войди снова/);
  S.gone = false;
});

test('Google сказал «версия устарела» — сервер узнаёт свежую и повторяет', async () => {
  const c = await registered(m, 'ag6');
  await login(c);
  await c.json('/api/settings', { base: AB, model: 'gemini-3-flash' }, 'PUT');
  S.gen.length = 0; S.ver = '2.50.0'; S.need = '2.50.0';
  S.script = [{ text: 'Ответ новой версии' }];
  const done = c.events(evs => logOf(evs).some(e => (e.kind === 'assistant' && e.text === 'Ответ новой версии') || e.kind === 'error'), 30000);
  await c.json('/api/chat', { text: 'привет' });
  const e = logOf(await done).find(x => x.kind === 'error');
  assert.equal(e, undefined, e?.text);
  assert.match(S.gen.at(-1).ua, /^antigravity\/hub\/2\.50\.0 /);
  S.need = '';
});

test('«токен вручную» (файл opencode, CLIProxyAPI или просто ключ); «Отключить» стирает вход', async () => {
  const c = await registered(m, 'ag7');
  const RT = '1//0gREFRESH-' + 'm'.repeat(40);
  let r = await c.json('/api/antigravity/import', { text: JSON.stringify({ version: 3, accounts: [{ email: 'imp@gmail.com', refreshToken: RT, managedProjectId: 'proj-123' }] }) });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.login, 'imp@gmail.com');
  assert.deepEqual((await c.json('/api/settings', undefined, 'GET')).j.agLogin, { how: 'token', email: 'imp@gmail.com' });
  assert.equal((await c.json('/api/models', { base: AB })).status, 200);
  /* просто ключ — чей аккаунт и проект сервер узнаёт у Google сам */
  r = await c.json('/api/antigravity/import', { text: RT });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.login, 'ag.user@gmail.com');
  assert.equal((await c.json('/api/antigravity/import', { text: 'не токен' })).status, 400);
  S.gone = true;
  r = await c.json('/api/antigravity/import', { text: RT });
  assert.equal(r.status, 401); assert.match(r.j.error, /истёк или отозван/);
  S.gone = false;
  await c.json('/api/settings', { forget: AB }, 'PUT');
  const st = (await c.json('/api/settings', undefined, 'GET')).j;
  assert.equal(st.agLogin, null);
  assert.ok(!st.provs.some(p => p.base === AB));
  /* вход не начат — вставлять некуда */
  assert.equal((await c.json('/api/antigravity/login', { text: cbUrl('x') }, 'PUT')).status, 409);
});
