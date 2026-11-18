/* Субагенты: spawn_subagent и list_subagent_models — чистый контекст, выбор провайдера и модели, ошибки, лимит шагов,
   защита от рекурсии, «Стоп», настройки пользователя и события для питомца */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeModel, startPersonalComputer, registered, sleep } from './helpers.js';
import { SUB_SYS, findProvider, provOf, defaults, availability } from '../lib/subagent.js';

let m, model, model2;
const doneRun = evs => evs.some(e => e.ev === 'run' && e.d.running === false);
const isSub = body => String(body.messages?.[0]?.content || '').startsWith(SUB_SYS.slice(0, 40));
const subCalls = mdl => mdl.calls.filter(c => isSub(c.body));
const mainCalls = mdl => mdl.calls.filter(c => !isSub(c.body));
const toolNames = body => (body.tools || []).map(t => t.function.name);

before(async () => {
  model = await fakeModel(async body => {
    const msgs = body.messages || [], last = msgs[msgs.length - 1];
    if (!last) return { status: 400 };
    if (isSub(body)) {
      const task = String(msgs[1].content);
      if (body.model === 'bad-model') return { status: 404 };
      if (task.startsWith('посчитай')) return last.role === 'user' ? { text: 'Считаю', tools: [{ name: 'run_command', args: { action: 'Считаю', command: 'echo $((6*7))' } }] } : { text: 'Итог: посчитано. Результат: ' + last.content.split('\n')[0] };
      if (task.startsWith('бесконечно')) return String(last.content || '').startsWith('[Лимит шагов исчерпан') ? { text: 'Частичный отчёт: успел ' + msgs.filter(x => x.role === 'tool').length + ' шагов' } : { tools: [{ name: 'run_command', args: { action: 'Кручусь', command: 'true' } }] };
      if (task.startsWith('рекурсия')) return last.role === 'user' ? { tools: [{ name: 'spawn_subagent', args: { task: 'ещё глубже' } }] } : { text: 'вложенный: ' + last.content };
      if (task.startsWith('долго')) return last.role === 'user' ? { tools: [{ name: 'run_command', args: { action: 'Жду', command: 'sleep 30' } }] } : { text: 'дождался' };
      return { text: 'отчёт по: ' + task };
    }
    /* сценарий главного — по последнему сообщению пользователя */
    const u = [...msgs].reverse().find(x => x.role === 'user'), ut = String(u.content);
    if (ut.startsWith('делегируй ')) return last.role === 'user' ? { tools: [{ name: 'spawn_subagent', args: { action: 'Поручаю', ...JSON.parse(ut.slice(10)) } }] } : { text: 'итог: ' + last.content };
    if (ut.startsWith('модели')) return last.role === 'user' ? { tools: [{ name: 'list_subagent_models', args: JSON.parse(ut.slice(7) || '{}') }] } : { text: 'итог: ' + last.content };
    return { text: 'ок' };
  });
  model2 = await fakeModel(async body => !body.messages ? { status: 400 } : isSub(body) ? { text: 'второй провайдер: ' + body.model } : { text: 'главный на втором' });
  m = await startPersonalComputer({ PERSONALCOMPUTER_SUB_TIMEOUT_MS: '4000' });
});
after(async () => { await m?.stop(); model?.close(); model2?.close(); });

/* пользователь с двумя провайдерами: второй сохранён (ключ k2, модель m2), главный — первый */
async function user(name) {
  const c = await registered(m, name);
  await c.json('/api/settings', { base: model2.url, key: 'k2', model: 'm2' }, 'PUT');
  await c.json('/api/settings', { base: model.url, key: 'k1', model: 'fake-1' }, 'PUT');
  return c;
}
async function ask(c, text) {
  const p = c.events(doneRun, 20000);
  await sleep(150);
  assert.equal((await c.json('/api/chat', { text })).status, 200);
  const evs = await p;
  const snap = (await c.events(e => e.some(x => x.ev === 'snap' && !x.d.running))).find(e => e.ev === 'snap').d;
  const answer = snap.log.filter(e => e.kind === 'assistant').at(-1)?.text || '';
  const res = answer.startsWith('итог: {') ? JSON.parse(answer.slice(6)) : null;
  return { evs, snap, answer, res };
}
const deleg = args => 'делегируй ' + JSON.stringify(args);

test('субагент: чистый контекст, все инструменты кроме субагентов, отчёт главному агенту', async () => {
  const c = await user('sub-ok');
  const n0 = model.calls.length;
  const { evs, snap, res } = await ask(c, deleg({ task: 'посчитай 6*7', role_prompt: 'Ты калькулятор' }));
  assert.equal(res.status, 'completed');
  assert.equal(res.provider_used, provOf(model.url).id);
  assert.equal(res.model_used, 'fake-1');
  assert.equal(res.steps_taken, 2);
  assert.deepEqual(res.tools_called, ['run_command']);
  assert.match(res.report, /Результат: 42/);
  assert.equal(res.error, null);
  /* субагент видел только свою подсказку и поручение — без переписки главного агента */
  const sc = subCalls({ calls: model.calls.slice(n0) });
  assert.equal(sc.length, 2);
  const first = sc[0].body;
  assert.equal(first.messages[0].role, 'system');
  assert.match(first.messages[0].content, /Твоя специализация: Ты калькулятор/);
  assert.equal(first.messages.length, 2);
  assert.deepEqual(first.messages[1], { role: 'user', content: 'посчитай 6*7' });
  assert.ok(!JSON.stringify(first.messages).includes('делегируй'));
  assert.equal(sc[0].auth, 'Bearer k1');
  /* инструменты: всё, что есть у главного, кроме инструментов субагентов */
  const main = mainCalls({ calls: model.calls.slice(n0) })[0].body;
  assert.ok(toolNames(main).includes('spawn_subagent') && toolNames(main).includes('list_subagent_models'));
  assert.ok(!toolNames(first).includes('spawn_subagent') && !toolNames(first).includes('list_subagent_models'));
  assert.deepEqual(toolNames(first).sort(), toolNames(main).filter(n => n !== 'spawn_subagent' && n !== 'list_subagent_models').sort());
  /* главный агент знает, когда и как звать субагентов; субагент — нет */
  assert.match(main.messages[0].content, /spawn_subagent/);
  assert.ok(!first.messages[0].content.includes('Субагенты:'));
  /* скрытое выполнение: в чат и журнал главного попал только сам вызов spawn_subagent, шаги субагента — нет */
  assert.deepEqual(snap.log.map(e => e.kind), ['user', 'tool', 'assistant']);
  const st = snap.log[1];
  assert.equal(st.name, 'spawn_subagent'); assert.equal(st.state, 'ok');
  assert.equal(st.sub.status, 'completed'); assert.equal(st.sub.model, 'fake-1');
  assert.equal(st.hint, provOf(model.url).name + ' · fake-1');
  assert.ok(!evs.some(e => e.ev === 'delta' && /Считаю|Результат/.test(e.d.d)));
  assert.ok(!evs.some(e => e.ev === 'log' && e.d.kind === 'tool' && e.d.name === 'run_command'));
  /* события для питомца: start → step… → end */
  const se = evs.filter(e => e.ev === 'subagent').map(e => e.d);
  assert.equal(se[0].phase, 'start'); assert.equal(se[0].model, 'fake-1'); assert.equal(se[0].max, 30);
  assert.ok(se.some(e => e.phase === 'step' && e.step === 1 && e.tool === 'run_command'));
  assert.equal(se.at(-1).phase, 'end'); assert.equal(se.at(-1).status, 'completed');
  /* во время работы субагента ход задачи несёт его (для индикатора после переподключения) */
  assert.ok(!('sub' in (evs.filter(e => e.ev === 'run').at(-1).d)));
});

test('провайдер и модель: аргументы, настройки пользователя, как у главного агента', async () => {
  const c = await user('sub-prov');
  /* явный провайдер (свой адрес) — его ключ и сохранённая модель */
  let r = (await ask(c, deleg({ task: 'кто ты', provider: model2.url }))).res;
  assert.equal(r.status, 'completed'); assert.equal(r.provider_used, provOf(model2.url).id); assert.equal(r.model_used, 'm2');
  assert.equal(r.report, 'второй провайдер: m2');
  assert.equal(model2.calls.at(-1).auth, 'Bearer k2');
  /* по id из list_subagent_models и с явной моделью */
  r = (await ask(c, deleg({ task: 'кто ты', provider: provOf(model2.url).id, model: 'm2-pro' }))).res;
  assert.equal(r.model_used, 'm2-pro'); assert.equal(r.report, 'второй провайдер: m2-pro');
  /* настройки пользователя: провайдер и модель по умолчанию, лимит шагов */
  const s = (await c.json('/api/settings', { subProvider: model2.url, subModel: 'm2-mini', subMaxSteps: 12 }, 'PUT')).j;
  assert.equal(s.subProvider, model2.url); assert.equal(s.subModel, 'm2-mini'); assert.equal(s.subMaxSteps, 12);
  const e = await ask(c, deleg({ task: 'кто ты' }));
  assert.equal(e.res.model_used, 'm2-mini'); assert.equal(e.res.provider_used, provOf(model2.url).id);
  assert.equal(e.evs.find(x => x.ev === 'subagent').d.max, 12);
  /* «как у главного агента» — снова провайдер и модель главного */
  await c.json('/api/settings', { subProvider: '', subModel: '' }, 'PUT');
  r = (await ask(c, deleg({ task: 'кто ты' }))).res;
  assert.equal(r.provider_used, provOf(model.url).id); assert.equal(r.model_used, 'fake-1');
  /* неверные значения настроек не сохраняются */
  assert.equal((await c.json('/api/settings', { subMaxSteps: 0 }, 'PUT')).status, 400);
  assert.equal((await c.json('/api/settings', { subProvider: 'ftp://x' }, 'PUT')).status, 400);
  assert.equal((await c.json('/api/settings', undefined, 'GET')).j.subMaxSteps, 12);
});

test('list_subagent_models: настройки по умолчанию, доступность провайдеров, модели', async () => {
  const c = await user('sub-list');
  await c.json('/api/settings', { subProvider: model2.url }, 'PUT');
  const { res } = await ask(c, 'модели {"refresh":true}');
  assert.equal(res.default_provider, provOf(model2.url).id);
  assert.equal(res.default_model, 'm2');
  assert.equal(res.default_max_steps, 30);
  assert.deepEqual(res.settings, { provider: provOf(model2.url).id, model: 'inherit' });
  const p1 = res.providers.find(p => p.base === model.url), p2 = res.providers.find(p => p.base === model2.url);
  assert.equal(p1.available, true); assert.equal(p1.main, true);
  assert.deepEqual(p1.models.map(x => x.id), ['fake-1', 'fake-2']);
  assert.ok(p1.models[0].tags.includes('main-agent'));
  assert.equal(p2.available, true);
  /* не настроенный провайдер — с причиной */
  const or = res.providers.find(p => p.id === 'openrouter');
  assert.equal(or.available, false); assert.match(or.reason, /ключ/);
  /* фильтр по провайдеру и неизвестный провайдер */
  const one = (await c.json('/api/subagent?provider=' + encodeURIComponent(provOf(model.url).id), undefined, 'GET')).j;
  assert.equal(one.providers.length, 1); assert.equal(one.providers[0].models.length, 2);
  const bad = (await c.json('/api/subagent?provider=nope', undefined, 'GET')).j;
  assert.match(bad.error, /Нет провайдера/);
  /* окно настроек без provider — быстро, без запросов к провайдерам */
  const n0 = model.calls.length;
  const all = (await c.json('/api/subagent', undefined, 'GET')).j;
  assert.ok(all.providers.length >= 10 && model.calls.length === n0);
});

test('ошибки субагента не роняют главного: неверная модель, недоступный провайдер, лимит шагов, таймаут', async () => {
  const c = await user('sub-err');
  /* неверная модель — HTTP 404 от провайдера */
  let { res, snap } = await ask(c, deleg({ task: 'посчитай', model: 'bad-model' }));
  assert.equal(res.status, 'error'); assert.equal(res.model_used, 'bad-model');
  assert.equal(res.error.type, 'model_or_endpoint_not_found'); assert.equal(res.error.http_status, 404); assert.equal(res.error.step, 1);
  assert.match(res.error.message, /404/);
  /* в журнале главного — сбой с причиной; задача главного закончилась ответом, а не ошибкой */
  const st = snap.log.find(e => e.name === 'spawn_subagent');
  assert.equal(st.state, 'bad'); assert.match(st.tail, /404/);
  assert.ok(!snap.log.some(e => e.kind === 'error'));
  /* провайдер без ключа и неизвестный провайдер */
  res = (await ask(c, deleg({ task: 'x', provider: 'openrouter' }))).res;
  assert.equal(res.status, 'error'); assert.equal(res.error.type, 'provider_unavailable');
  res = (await ask(c, deleg({ task: 'x', provider: 'nope' }))).res;
  assert.equal(res.error.type, 'provider_not_found');
  /* пустое задание */
  res = (await ask(c, deleg({ task: '  ' }))).res;
  assert.equal(res.error.type, 'invalid_arguments');
  /* лимит шагов: отчёт о сделанном отдельным последним запросом без выполнения инструментов */
  res = (await ask(c, deleg({ task: 'бесконечно', max_steps: 3 }))).res;
  assert.equal(res.status, 'max_steps_exceeded'); assert.equal(res.error.type, 'max_steps_exceeded');
  assert.equal(res.steps_taken, 4);
  assert.match(res.report, /Частичный отчёт: успел 3 шагов/);
  /* таймаут (в тестах — 4 с): команда прервана, частичный результат — последние шаги */
  const t0 = Date.now();
  res = (await ask(c, deleg({ task: 'долго' }))).res;
  assert.equal(res.status, 'timeout'); assert.equal(res.error.type, 'timeout'); assert.equal(res.error.tool, 'run_command');
  assert.match(res.report, /run_command/);
  assert.ok(Date.now() - t0 < 15000);
});

test('защита от рекурсии: у субагента нет инструментов субагентов, вызов отклоняется', async () => {
  const c = await user('sub-rec');
  const n0 = model.calls.length;
  const { res } = await ask(c, deleg({ task: 'рекурсия' }));
  assert.equal(res.status, 'completed');
  assert.match(res.report, /инструмента spawn_subagent сейчас нет/);
  /* субагент второго уровня не запускался: ровно два запроса субагента */
  assert.equal(subCalls({ calls: model.calls.slice(n0) }).length, 2);
});

test('выключенные инструменты субагентов не уходят в запросы и подсказку', async () => {
  const c = await user('sub-off');
  const cat = (await c.json('/api/tools', undefined, 'GET')).j;
  assert.deepEqual(cat.builtin.filter(t => t.group === 'Субагенты').map(t => t.name).sort(), ['list_subagent_models', 'spawn_subagent']);
  await c.json('/api/tools', { tools: { spawn_subagent: false, list_subagent_models: false } }, 'PUT');
  const n0 = model.calls.length;
  await ask(c, 'привет');
  const b = mainCalls({ calls: model.calls.slice(n0) })[0].body;
  assert.ok(!toolNames(b).includes('spawn_subagent') && !toolNames(b).includes('list_subagent_models'));
  assert.ok(!b.messages[0].content.includes('Субагенты:'));
  /* модель всё-таки позвала выключенный — отказ, а не запуск */
  const { res, answer } = await ask(c, deleg({ task: 'посчитай' }));
  assert.equal(res, null); assert.match(answer, /инструмента spawn_subagent сейчас нет/);
});

test('«Стоп» останавливает и субагента; индикатор гаснет', async () => {
  const c = await user('sub-stop');
  const p = c.events(evs => doneRun(evs) && evs.some(e => e.ev === 'subagent' && e.d.phase !== 'start' && e.d.phase !== 'step'), 15000);
  await sleep(150);
  await c.json('/api/chat', { text: deleg({ task: 'долго' }) });
  /* пока субагент работает, ход задачи знает о нём */
  let run = null;
  for (let i = 0; i < 40 && !run?.sub; i++) { await sleep(100); run = (await c.events(e => e.some(x => x.ev === 'snap'))).find(e => e.ev === 'snap').d; }
  assert.equal(run.sub.model, 'fake-1');
  const t0 = Date.now();
  const r = await c.json('/api/chat/stop', {});
  assert.equal(r.j.running, false); assert.ok(Date.now() - t0 < 3000);
  const evs = await p;
  const last = evs.filter(e => e.ev === 'subagent').at(-1).d;
  assert.equal(last.phase, 'error'); assert.equal(last.status, 'error');
  const snap = (await c.events(e => e.some(x => x.ev === 'snap'))).find(e => e.ev === 'snap').d;
  assert.equal(snap.sub, undefined);
  assert.equal(snap.log.at(-1).text, 'Остановлено');
});

test('выбор провайдера и значения по умолчанию (модуль)', () => {
  const S = { base: 'https://api.openai.com/v1', key: 'k', model: 'gpt', provs: { 'https://openrouter.ai/api/v1': { key: 'o', model: 'x/y' }, 'http://10.0.0.5:11434/v1': { key: '', model: 'llama' } } };
  assert.equal(findProvider(S, 'OpenRouter').id, 'openrouter');
  assert.equal(findProvider(S, 'openrouter.ai').id, 'openrouter');
  assert.equal(findProvider(S, 'https://openrouter.ai/api/v1/').id, 'openrouter');
  assert.equal(findProvider(S, 'custom:10.0.0.5:11434').base, 'http://10.0.0.5:11434/v1');
  assert.equal(findProvider(S, 'nope'), null);
  assert.deepEqual(defaults(S), { provider: findProvider(S, 'openai'), model: 'gpt', steps: 30 });
  assert.equal(defaults({ ...S, subProvider: 'https://openrouter.ai/api/v1' }).model, 'x/y');
  assert.equal(defaults({ ...S, subProvider: 'https://openrouter.ai/api/v1', subModel: 'z', subMaxSteps: 7 }).steps, 7);
  /* свой сервер в локальной сети — без ключа, но настроен */
  assert.equal(availability(S, 'http://10.0.0.5:11434/v1').available, true);
  assert.equal(availability(S, 'https://ollama.com/v1').available, false);
  assert.equal(availability(S, 'https://kiro.dev').available, false);
});

test('индикатор субагента и питомец: все темы, только токены темы', async () => {
  const fs = await import('node:fs'), root = new URL('../../', import.meta.url);
  const read = p => fs.readFileSync(new URL(p, root), 'utf8');
  const html = read('index.html'), cl = read('server/public/client.js'), mod = read('server/public/theme-modern.css'), pet = read('server/public/pet-modern.js');
  /* питомец: состояние «делегирую» с экраном субагента — в пиксельном компьютере и в ноутбуке «Современной» */
  assert.match(html, /delegating:\{label:'Субагент',mode:'app',app:'delegate'/);
  assert.match(html, /spawn_subagent:\['delegating'\]/);
  assert.match(html, /\n delegate\(t\)\{/);
  assert.match(pet, /\n delegate\(t,o\)\{/);
  /* события сервера → компьютер; строка в облачке создаётся и прячется клиентом */
  assert.match(cl, /addEventListener\('subagent', e => onSub\(/);
  assert.match(cl, /subBar\(running && r\.sub \|\| null\)/);
  /* стили строки субагента: ни одного своего цвета — только переменные темы (пиксельные темы и «Современная») */
  const rules = [...cl.matchAll(/^(\.bs[a-z]|#sah|@keyframes bsa)[^\n]*$/gm), ...mod.matchAll(/^:root\[data-theme=modern\] (\.bs[a-z]|#sah)[^\n]*$|^@keyframes mdsub[^\n]*$/gm)].map(x => x[0]);
  assert.ok(rules.length >= 12, 'правил: ' + rules.length);
  for (const r of rules) assert.doesNotMatch(r.replace(/var\(--[\w-]+\)/g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, r);
});
