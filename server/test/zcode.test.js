/* Провайдер Z Code (z.ai): фальшивые zcode.z.ai (файл обновлений, поток входа init/poll, каталог моделей), кабинет
   Z.ai (z/login, проекты, API-ключи, подписка, лимиты) и OpenAI-совместимый API (Coding Plan и обычный) */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startPersonalComputer, registered, sleep } from './helpers.js';
import * as Z from '../lib/zcode.js';

const ZB = 'https://zcode.z.ai', KEY = 'kid0123456789abcdef.SECRETabcdef1234';
let m, srv, url;
const S = { ver: '4.1.0', ready: false, decline: false, flows: 0, polls: 0, keys: [], made: 0, plan: true, chat: [], script: [], inits: [], bizAuth: [], ua: [] };
const CATALOG = () => ({ config: {
  providerConfigRules: { providerRules: [{ providerId: 'account:zai-individual-coding-plan', builtinModelIds: ['GLM-5.3', 'GLM-5-Turbo'] }, { providerId: 'account:zai-start-plan', builtinModelIds: ['GLM-9-Secret'] }] },
  modelConfigRules: {
    builtinProviderModelRules: [{ providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-4.6V', config: { enabled: true } }, { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5-Turbo', config: { enabled: false } }],
    modelRules: [{ modelMatch: 'GLM-4\\.6V', config: { properties: { contextWindow: 128000, inputFormat: { supportsImage: true } }, optionSpecs: { maxOutputTokens: { max: 32000 }, reasoningLevel: { values: ['disabled', 'enabled'] } } } },
      { modelMatch: 'GLM-5\\.3.*', config: { properties: { contextWindow: 1000000, inputFormat: { supportsImage: false } }, optionSpecs: { maxOutputTokens: { max: 128000 }, reasoningLevel: { values: ['low', 'high', 'max'] } } } }],
  } } });

before(async () => {
  srv = http.createServer(async (q, s) => {
    let b = ''; for await (const c of q) b += c;
    const u = new URL(q.url, 'http://x'), p = u.pathname;
    const json = (st, o) => { s.writeHead(st, { 'content-type': 'application/json' }); s.end(JSON.stringify(o)); };
    const ok = data => json(200, { code: 200, msg: 'ok', data, success: true });
    const j = b ? JSON.parse(b) : {};
    /* zcode.z.ai */
    if (p === '/api/v1/releases/electron/manifest') { s.writeHead(200, { 'content-type': 'text/yaml' }); return s.end(`version: ${S.ver}\nfiles:\n  - url: ZCode-${S.ver}.deb\n    sha512: x\n`); }
    if (p === '/api/v1/oauth/cli/init') {
      S.inits.push({ auth: q.headers.authorization, dev: q.headers['x-device-mid'], ua: q.headers['user-agent'], body: j });
      S.flows++;
      return json(200, { code: 0, data: { flow_id: 'F' + S.flows, authorize_url: url + '/authorize?flow=F' + S.flows + '&provider=' + j.provider, poll_interval_sec: 0.2, expires_at: Math.floor(Date.now() / 1000) + 600 } });
    }
    if (p.startsWith('/api/v1/oauth/cli/poll/')) {
      S.polls++;
      const init = S.inits.at(-1);
      if (q.headers.authorization !== init.auth || q.headers['x-device-mid'] !== init.dev) return json(401, { code: 401, msg: 'bad flow auth' });
      if (S.decline) return ok({ status: 'denied' });
      if (!S.ready) return ok({ status: 'pending' });
      return ok({ status: 'ready', token: 'eyJ.JWT.x', zai: { access_token: 'ZAI-SITE-TOKEN' }, bigmodel: { accessToken: 'BM-SITE-TOKEN' }, user: { email: 'glm.fan@example.com', name: 'GLM Fan', user_id: 42 } });
    }
    if (p === '/api/v1/client/configs') return json(200, { code: 0, data: { configs: { builtin_provider_config_json: url + '/builtin.json' } } });
    if (p === '/builtin.json') return json(200, CATALOG());
    /* кабинет */
    if (p === '/api/auth/z/login') return j.token === 'ZAI-SITE-TOKEN' ? ok({ access_token: 'BIZTOKEN' }) : json(200, { code: 1001, msg: 'Z.ai user information is invalid' });
    if (p.startsWith('/api/biz/') && !p.startsWith('/api/biz/subscription')) {
      S.bizAuth.push(q.headers.authorization);
      if (!['Bearer BIZTOKEN', 'BM-SITE-TOKEN'].includes(q.headers.authorization)) return json(401, { code: 401, msg: 'no auth' });
    }
    if (p === '/api/biz/customer/getCustomerInfo') return ok({ organizations: [
      { organizationId: 'team-org', organizationName: 'Команда', projects: [{ projectId: 'tp', projectName: 'team', projectType: 2 }] },
      { organizationId: 'org1', organizationName: '默认机构', projects: [{ projectId: 'p0', projectName: 'другой', projectType: 1 }, { projectId: 'p1', projectName: '默认项目', projectType: 1 }] }] });
    if (p === '/api/biz/team/subscribe/product/querySubscribeDetail') return ok({ hasSubscription: true, status: 'EFFECTIVE', memberGrantStatus: 'UNASSIGNED', productName: 'GLM Coding Team' });
    if (p === '/api/biz/v1/organization/org1/projects/p1/api_keys') {
      if (q.method === 'POST') { S.made++; S.keys.push({ name: j.name, apiKey: 'kid0123456789abcdef' }); return ok({ apiKey: 'kid0123456789abcdef' }); }
      return ok(S.keys);
    }
    if (p === '/api/biz/v1/organization/org1/projects/p1/api_keys/copy/kid0123456789abcdef') return ok({ secretKey: 'SECRETabcdef1234' });
    if (p === '/api/biz/subscription/list') {
      if (q.headers.authorization !== KEY) return json(401, { code: 1002, msg: 'Authorization Token非法' });
      return ok(S.plan ? [{ status: 'EXPIRED', productName: 'GLM Coding Lite' }, { status: 'VALID', productName: 'GLM Coding Pro' }] : []);
    }
    if (p === '/api/monitor/usage/quota/limit') {
      if (q.headers.authorization !== KEY) return json(401, { code: 1002, msg: 'bad' });
      return ok({ limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 25, nextResetTime: Date.now() + 3600e3 }, { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 60, nextResetTime: Date.now() + 5 * 864e5 }, { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 0 }] });
    }
    /* OpenAI-совместимый API: Coding Plan и обычный */
    if (p === '/api/paas/v4/models') return json(200, { object: 'list', data: [{ id: 'glm-4.6' }, { id: 'glm-4.7-flash' }, { id: 'cogview-4' }] });
    if (p === '/api/coding/paas/v4/chat/completions' || p === '/api/paas/v4/chat/completions') {
      if (q.headers.authorization !== 'Bearer ' + KEY) return json(401, { error: { code: '1002', message: 'Authorization Token非法' } });
      if (j.stream === false) return json(200, { choices: [{ message: { role: 'assistant', content: 'Проверка сервера' } }] });
      S.chat.push({ p, body: j });
      const step = S.script.shift() || { text: 'конец' };
      if (step.err) return json(step.status || 429, { error: { code: step.err, message: step.msg || 'x' } });
      s.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = d => s.write('data: ' + JSON.stringify({ id: 'r1', model: j.model, choices: [{ index: 0, delta: d }] }) + '\n\n');
      for (const w of (step.think || '').match(/.{1,6}/gs) || []) ev({ role: 'assistant', reasoning_content: w });
      for (const w of (step.text || '').match(/.{1,5}/gs) || []) { ev({ content: w }); await sleep(2); }
      (step.calls || []).forEach((c, i) => ev({ tool_calls: [{ index: i, id: 'call_' + i, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] }));
      s.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: step.calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 20, total_tokens: 920 } }) + '\n\n');
      return s.end('data: [DONE]\n\n');
    }
    json(404, { code: 404, msg: 'no route ' + p });
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  url = 'http://127.0.0.1:' + srv.address().port;
  const env = { PERSONALCOMPUTER_ZC_URL: url, PERSONALCOMPUTER_ZC_ZAI_URL: url, PERSONALCOMPUTER_ZC_BM_URL: url, PERSONALCOMPUTER_ZC_BMOPEN_URL: url };
  Object.assign(process.env, env);
  m = await startPersonalComputer(env);
});
after(async () => { await m?.stop(); srv?.close(); });

const logOf = evs => evs.flatMap(e => e.ev === 'log' ? [e.d] : e.ev === 'snap' ? e.d.log : []);
async function waitLogin(c, want = 'ok') {
  let r = await c.json('/api/zcode/login', undefined, 'GET');
  for (let i = 0; i < 100 && (r.j.state === 'wait' || r.j.state === 'save'); i++) { await sleep(100); r = await c.json('/api/zcode/login', undefined, 'GET'); }
  assert.equal(r.j.state, want, r.j.msg);
  return r.j;
}
async function login(c, site = 'zai') {
  S.ready = false;
  const r = await c.json('/api/zcode/login', { site });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  S.ready = true;
  return waitLogin(c);
}

test('разбор: адрес провайдера, ключ вручную, личный проект, каталог Z Code, ошибки z.ai', () => {
  assert.ok(Z.isZcode('https://zcode.z.ai') && Z.isZcode('https://zcode.z.ai/') && !Z.isZcode('https://zcode.z.ai.evil.com') && !Z.isZcode('https://api.z.ai/api/paas/v4'));
  assert.equal(Z.apiBase({ site: 'zai', api: 'coding' }), url + '/api/coding/paas/v4');
  assert.equal(Z.apiBase({ site: 'zai', api: 'paas' }), url + '/api/paas/v4');
  /* ключ: как есть, из .env, из JSON-файла настроек (Claude Code с z.ai), с Bearer; не ключ — понятная ошибка */
  assert.equal(Z.parseKey(KEY), KEY);
  assert.equal(Z.parseKey('export ZAI_API_KEY=' + KEY), KEY);
  assert.equal(Z.parseKey(JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } })), KEY);
  assert.equal(Z.parseKey('Bearer ' + KEY), KEY);
  assert.throws(() => Z.parseKey('sk-просто-текст'), /не API-ключ z\.ai/);
  /* устройство входа — стабильное от ключа потока и похоже на UUID v4 */
  const dv = Z.deviceOf(Buffer.alloc(32, 7));
  assert.match(dv, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(dv, Z.deviceOf(Buffer.alloc(32, 7)));
  /* личный проект — в организации и проекте «по умолчанию»; командные (тип 2) не личные */
  assert.deepEqual(Z.personal({ organizations: [{ organizationId: 'o2', organizationName: 'x', projects: [{ projectId: 'a', projectType: 2 }] }, { organizationId: 9, organizationName: '默认机构', projects: [{ projectId: 'b', projectName: 'q' }, { projectId: 'c', projectName: '默认项目' }] }] }), { org: '9', project: 'c' });
  /* каталог: модели плана, выключенные — убраны, умения — по правилам имени */
  const L = Z.fromCatalog(CATALOG(), { site: 'zai' });
  assert.deepEqual(L.map(x => x.id), ['glm-5.3', 'glm-4.6v']);
  assert.deepEqual({ ...L[0] }, { id: 'glm-5.3', name: 'GLM-5.3', ctx: 1000000, out: 128000, img: false, think: true, must: true });
  assert.equal(L[1].img, true); assert.equal(L[1].must, false); assert.equal(L[1].think, true);
  assert.deepEqual(Z.fromCatalog(null, {}), []);
  /* ошибки z.ai → по-человечески; лимит и подписка — без повторов, перегрузка — с повтором */
  assert.match(Z.human(429, { error: { code: '1308', message: 'Usage limit reached for 5 hour. Your limit will reset at 2026-11-24 18:30:00' } }).text, /5 часов исчерпан.*2026-11-24 18:30/);
  assert.ok(!Z.human(429, { error: { code: '1308' } }).retry);
  assert.ok(Z.human(429, { error: { code: '1302', message: 'High concurrency' } }).retry);
  assert.ok(Z.human(401, { error: { code: '1002' } }).relogin);
  assert.match(Z.human(400, { error: { code: '1113' } }).text, /GLM Coding Plan не действует/);
  assert.match(Z.human(400, { error: { code: '1211' } }).text, /модели у Z Code нет/);
  assert.match(Z.human(400, { error: { code: '9999', message: 'странное' } }).text, /Z\.ai: странное \(код 9999\)/);
});

test('вход окном Z.ai: ничего не вставляем — сервер сам дожидается разрешения, берёт ключ проекта и подписку', async () => {
  const c = await registered(m, 'zc1');
  S.ready = false;
  let r = await c.json('/api/zcode/login', { site: 'zai' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.state, 'wait');
  assert.equal(r.j.url, url + '/authorize?flow=F' + S.flows + '&provider=zai', 'адрес входа — как выдал Z Code, без изменений');
  const init = S.inits.at(-1);
  assert.deepEqual(init.body, { provider: 'zai' });
  assert.match(init.auth, /^Bearer [0-9a-f]{64}$/);
  assert.equal(init.dev, Z.deviceOf(Buffer.from(init.auth.slice(7), 'hex')), 'устройство — как у Z Code CLI');
  assert.equal(init.ua, 'ZCode/4.1.0', 'версия — свежая, из файла обновлений Z Code');
  /* пока ты не разрешил — ждём */
  await sleep(700);
  assert.ok(S.polls >= 2, 'сервер сам спрашивает «готово?»');
  assert.equal((await c.json('/api/zcode/login', undefined, 'GET')).j.state, 'wait');
  S.ready = true;
  const L = await waitLogin(c);
  assert.equal(L.login, 'glm.fan@example.com');
  assert.match(L.msg, /Z Code подключён/);
  assert.equal(S.made, 1, 'ключа «zcode-api-key» не было — создан');
  assert.equal(S.keys[0].name, 'zcode-api-key');
  assert.ok(S.bizAuth.every(a => a === 'Bearer BIZTOKEN'), 'кабинет — по доступу из z/login');
  const st = (await c.json('/api/settings', undefined, 'GET')).j;
  assert.deepEqual(st.zcLogin, { how: 'zcode', email: 'glm.fan@example.com', site: 'zai' });
  assert.ok(st.provs.find(p => p.base === ZB)?.hasKey);
  assert.ok(!JSON.stringify(st).includes('SECRET'), 'ключ наружу не отдаётся');
  /* модели плана (каталог Z Code), план, лимиты Coding Plan */
  r = await c.json('/api/models', { base: ZB });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.models, ['glm-5.3', 'glm-4.6v']);
  assert.equal(r.j.def, 'glm-5.3');
  assert.equal(r.j.plan, 'GLM Coding Pro');
  assert.equal(r.j.api, 'coding');
  assert.equal(r.j.live, true);
  assert.deepEqual(r.j.quota.map(g => [g.name, g.left]), [['Окно 5 часов', 0.75], ['Неделя', 0.4], ['Поиск и чтение страниц (MCP)', 1]]);
  assert.ok(r.j.quota[0].reset > Date.now());
  /* вход ещё раз — тот же ключ, новый не создаётся */
  await login(c);
  assert.equal(S.made, 1);
});

test('чат через Coding Plan: адрес плана, свой ключ, размышление GLM возвращается модели между шагами', async () => {
  const c = await registered(m, 'zc2');
  await login(c);
  assert.equal((await c.json('/api/settings', { base: ZB, model: 'glm-5.3', think: false }, 'PUT')).status, 200);
  await c.json('/api/models', { base: ZB });
  S.chat.length = 0;
  S.script = [
    { think: 'Посмотрю, что на сервере.', text: 'Сейчас проверю.', calls: [{ name: 'run_command', args: { action: 'Смотрю', command: 'echo привет' } }] },
    { think: 'Всё в порядке.', text: 'На сервере всё хорошо ^_^' },
  ];
  const done = c.events(evs => logOf(evs).some(e => (e.kind === 'assistant' && e.text === 'На сервере всё хорошо ^_^') || e.kind === 'error'), 30000);
  assert.equal((await c.json('/api/chat', { text: 'проверь сервер' })).status, 200);
  const evs = await done, err = logOf(evs).find(e => e.kind === 'error');
  assert.equal(err, undefined, err?.text);
  assert.equal(S.chat.length, 2);
  const [a, b] = S.chat;
  assert.equal(a.p, '/api/coding/paas/v4/chat/completions');
  assert.equal(a.body.model, 'glm-5.3');
  assert.equal(a.body.stream, true);
  /* GLM-5.3 без размышления не работает — включено, хоть переключатель и выключен; мысль сохраняется между шагами */
  assert.deepEqual(a.body.thinking, { type: 'enabled', clear_thinking: false });
  assert.ok(a.body.tools.some(t => t.function.name === 'run_command'), 'инструменты — родные');
  const asst = b.body.messages.find(x => x.role === 'assistant');
  assert.equal(asst.reasoning_content, 'Посмотрю, что на сервере.', 'размышление вернулось той же модели');
  assert.equal(asst.tool_calls[0].function.name, 'run_command');
  assert.match(b.body.messages.find(x => x.role === 'tool').content, /привет/);
});

test('ошибки: лимит Coding Plan — сразу и по-человечески, перегрузка — повтор, ключ удалён — «войди снова»', async () => {
  const c = await registered(m, 'zc3');
  await login(c);
  await c.json('/api/settings', { base: ZB, model: 'glm-4.6v', think: true }, 'PUT');
  await c.json('/api/models', { base: ZB });
  /* итог именно этой просьбы: первая ошибка или ответ после неё (в снимке чата есть и прошлые) */
  const after = (evs, text) => { const L = logOf(evs), i = L.findLastIndex(e => e.kind === 'user' && e.text === text); return i < 0 ? null : L.slice(i + 1).find(e => e.kind === 'error' || (e.kind === 'assistant' && e.text)); };
  const run = async (text, script) => {
    S.chat.length = 0; S.script = script;
    const done = c.events(evs => !!after(evs, text), 60000);
    assert.equal((await c.json('/api/chat', { text })).status, 200);
    return after(await done, text);
  };
  let e = await run('раз', [{ err: '1308', status: 429, msg: 'Usage limit reached for 5 hour. Your limit will reset at 2026-11-24 18:30:00' }]);
  assert.equal(e.kind, 'error');
  assert.match(e.text, /лимит GLM Coding Plan на эти 5 часов исчерпан/i);
  assert.equal(S.chat.length, 1, 'лимит — без бесполезных повторов');
  /* модель с выбором размышления — как в переключателе */
  e = await run('два', [{ err: '1305', status: 429, msg: 'overloaded' }, { text: 'Готово' }]);
  assert.equal(e.kind, 'assistant', e.text);
  assert.equal(S.chat.length, 2, 'перегрузка — подождали и повторили');
  assert.deepEqual(S.chat[0].body.thinking, { type: 'enabled', clear_thinking: false });
});

test('без GLM Coding Plan: обычный API z.ai — бесплатные Flash первыми, запросы на paas/v4', async () => {
  const c = await registered(m, 'zc4');
  S.plan = false;
  try {
    await login(c);
    let r = await c.json('/api/models', { base: ZB });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal(r.j.api, 'paas');
    assert.equal(r.j.plan, '');
    assert.deepEqual(r.j.models, ['glm-4.7-flash', 'glm-4.6']);
    assert.equal(r.j.info[0].free, true);
    assert.equal(r.j.def, 'glm-4.7-flash');
    assert.match(r.j.why, /место в подписке тебе ещё не выдали/, 'видно, почему нет командной подписки');
    assert.deepEqual(r.j.quota, []);
    await c.json('/api/settings', { base: ZB, model: 'glm-4.7-flash', think: false }, 'PUT');
    S.chat.length = 0; S.script = [{ text: 'Привет!' }];
    const done = c.events(evs => logOf(evs).some(e => e.kind === 'error' || (e.kind === 'assistant' && e.text)), 30000);
    await c.json('/api/chat', { text: 'привет' });
    const ev = logOf(await done).find(e => e.kind === 'error' || e.kind === 'assistant');
    assert.equal(ev.kind, 'assistant', ev.text);
    assert.equal(S.chat[0].p, '/api/paas/v4/chat/completions');
    assert.deepEqual(S.chat[0].body.thinking, { type: 'disabled' });
  } finally { S.plan = true; }
});

test('ключ вручную, отмена и отказ на странице входа, «Отключить» стирает вход', async () => {
  const c = await registered(m, 'zc5');
  let r = await c.json('/api/zcode/import', { text: 'просто текст' });
  assert.equal(r.status, 400);
  r = await c.json('/api/zcode/import', { text: 'ZAI_API_KEY=wrongid0123456789.WRONGsecret1234' });
  assert.equal(r.status, 400);
  assert.match(r.j.error, /не подошёл ни к Z\.ai, ни к BigModel/);
  r = await c.json('/api/zcode/import', { text: 'ZAI_API_KEY=' + KEY });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.plan, 'GLM Coding Pro');
  r = await c.json('/api/models', { base: ZB });
  assert.equal(r.status, 200);
  assert.equal(r.j.how, 'key');
  /* отмена: вход забыт; отказ на странице — понятная ошибка */
  S.ready = false;
  await c.json('/api/zcode/login', { site: 'zai' });
  assert.equal((await c.json('/api/zcode/login', undefined, 'DELETE')).status, 200);
  assert.equal((await c.json('/api/zcode/login', undefined, 'GET')).j.state, 'none');
  S.decline = true;
  try {
    await c.json('/api/zcode/login', { site: 'zai' });
    const L = await waitLogin(c, 'fail');
    assert.match(L.msg, /отменён на странице Z\.ai/);
  } finally { S.decline = false; }
  /* «Отключить» */
  await c.json('/api/settings', { base: ZB, model: 'glm-5.3' }, 'PUT');
  r = await c.json('/api/settings', { forget: ZB }, 'PUT');
  assert.equal(r.status, 200);
  assert.equal(r.j.zcLogin, null);
  assert.ok(!r.j.provs.find(p => p.base === ZB)?.hasKey);
  r = await c.json('/api/models', { base: ZB });
  assert.equal(r.status, 401);
  assert.ok(r.j.needKey);
});

test('API для других проектов: zcode/модель — через адрес Coding Plan с ключом аккаунта', async () => {
  const c = await registered(m, 'zc6');
  await login(c);
  await c.json('/api/settings', { base: ZB, model: 'glm-5.3' }, 'PUT');
  const k = await c.json('/api/keys', { name: 'бот' });
  assert.equal(k.status, 200, JSON.stringify(k.j));
  S.chat.length = 0; S.script = [{ text: 'привет от GLM' }];
  const r = await fetch(m.base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + k.j.key, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'zcode/glm-5.3', stream: true, reasoning_effort: 'high', messages: [{ role: 'user', content: 'привет' }] }) });
  assert.equal(r.status, 200);
  const t = await r.text();
  assert.match(t, /привет от GLM|прив/);
  assert.equal(S.chat[0].p, '/api/coding/paas/v4/chat/completions');
  assert.deepEqual(S.chat[0].body.thinking, { type: 'enabled' });
  assert.equal(S.chat[0].body.reasoning_effort, undefined);
});
