/* Быстрый старт: лёгкая страница без встроенного Linux, экран загрузки
   и агент, который не ждёт подключения к поиску в интернете; поиск — предустановленный MCP-сервер */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fakeModel, startPersonalComputer, registered } from './helpers.js';
import { MCP_GRACE } from '../lib/ext.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let m, model, mcp, c, mode = 'hang';
const seen = [], calls = [];

before(async () => {
  model = await fakeModel(body => {
    const last = body.messages[body.messages.length - 1];
    if (last.role === 'user' && String(last.content).startsWith('поищи')) return { tools: [{ name: 'search__web_search', args: { q: 'погода' } }] };
    return { text: 'ок' };
  });
  /* поиск в интернете (MCP): «hang» — принимает запрос и молчит, «ok» — отвечает */
  mcp = http.createServer(async (req, res) => {
    let b = ''; for await (const ch of req) b += ch;
    const msg = JSON.parse(b || '{}');
    seen.push(msg.method);
    if (msg.method === 'tools/call') calls.push(msg.params);
    if (mode === 'hang') return;
    if (msg.id === undefined) { res.writeHead(202); return res.end(); }
    const result = msg.method === 'initialize' ? { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'search' } }
      : msg.method === 'tools/list' ? { tools: [{ name: 'web_search', description: 'Поиск в интернете', inputSchema: { type: 'object', properties: { q: { type: 'string' }, session_id: { type: 'string' } }, required: ['q', 'session_id'] } }] }
      : { content: [{ type: 'text', text: 'нашлось' }] };
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise(ok => mcp.listen(0, '127.0.0.1', ok));
  m = await startPersonalComputer({ PERSONALCOMPUTER_SEARCH_MCP: 'http://127.0.0.1:' + mcp.address().port + '/mcp' });
  c = await registered(m, 'boot');
  await c.json('/api/settings', { base: model.url, key: 'k', model: 'fake-1' }, 'PUT');
});
after(async () => { await m?.stop(); model?.close(); mcp?.closeAllConnections(); mcp?.close(); });

/* отправить сообщение и дождаться конца задачи; → сколько ждали, мс */
async function ask(text) {
  let ready; const rp = new Promise(r => ready = r);
  const w = c.events(evs => {
    if (evs.some(e => e.ev === 'snap')) ready();
    const k = evs.findIndex(e => e.ev === 'run' && e.d.running === true);
    return k >= 0 && evs.slice(k).some(e => e.ev === 'run' && e.d.running === false);
  }, 20000);
  await rp;
  const t0 = Date.now();
  assert.equal((await c.json('/api/chat', { text })).status, 200);
  await w;
  return Date.now() - t0;
}
const tools = () => (model.calls[model.calls.length - 1].body.tools || []).map(t => t.function.name);

test('страница — без встроенного Linux, скрипты целы и разрешены CSP', async () => {
  const r = await fetch(m.base + '/', { headers: { 'accept-encoding': 'br' } });
  const t = await r.text();
  assert.ok(t.length < 700 * 1024, 'страница весит ' + t.length);
  assert.doesNotMatch(t, /H4sIAAAAAAAC|const (BIOS|VGA|ALP)=|new V86\(|libv86|wisps?:\/\//); /* ни образа, ни эмулятора, ни его сети */
  assert.match(t, /<div id="boot"/);
  const csp = r.headers.get('content-security-policy');
  const scripts = [...t.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
  assert.ok(scripts.length >= 5);
  for (const s of scripts) {
    new vm.Script(s);
    assert.ok(csp.includes(`'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`), 'скрипт без хеша в CSP');
  }
});

test('тема «Современная»: стили отдаёт сервер, страница их подключает, тема есть в настройках', async () => {
  const r = await fetch(m.base + '/theme-modern.css');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/css/);
  assert.match(await r.text(), /:root\[data-theme=modern\]\{/);
  const src = fs.readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8');
  assert.match(src, /<link rel="stylesheet" href="theme-modern\.css">/);
  assert.match(src, /role="radio" data-t="modern"/);
  assert.match(src, /\['boy','lamp','modern'\]\.includes\(t\)/);
});

test('тема «Современная»: компьютер — векторный ноутбук (pet-modern.js), в остальных темах — прежний пиксельный', async () => {
  const r = await fetch(m.base + '/pet-modern.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/javascript/);
  const js = await r.text();
  const src = fs.readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8');
  /* подключён до скрипта компьютера, движок отдаёт ему кадр только в современной теме; офлайн-кэш его хранит */
  assert.ok(src.indexOf('<script src="pet-modern.js"></script>') > 0 && src.indexOf('<script src="pet-modern.js"></script>') < src.indexOf('const room=window.personalComputerRoom='));
  assert.match(src, /const MD=\(\)=>skin==='modern'&&window\.PCModern;/);
  assert.match(src, /const md=MD\(\);if\(md\)return md\.draw\(ctx,\{/);
  assert.match(fs.readFileSync(path.join(here, '..', '..', 'sw.js'), 'utf8'), /'\.\/pet-modern\.js'/);

  /* каждый экран, лицо и картинка рисуются без ошибок (холст — заглушка, которая принимает любые вызовы) */
  const errors = [];
  const ctx2d = cv => new Proxy({ canvas: cv }, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return s => ({ width: String(s).length * 4 });
      if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (typeof k === 'string' && k.startsWith('create')) return () => ({ addColorStop() {} });
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const canvas = () => { const c = { width: 300, height: 150, getBoundingClientRect: () => ({ width: 76, height: 76 }) }; const x = ctx2d(c); c.getContext = () => x; return c; };
  const sb = { matchMedia: () => ({ matches: false }), document: { createElement: canvas, documentElement: { dataset: { theme: 'modern' } } }, performance, console: { error: (...a) => errors.push(a.join(' ')) } };
  sb.window = sb;
  vm.runInNewContext(js, sb);
  const P = sb.PCModern;
  assert.deepEqual([...P.box], [75, 68, 106, 92]);
  const main = canvas(), g = main.getContext(); main.width = 115; main.height = 100;
  const pal = ['#03130a', '#145128', '#2fae57', '#72ff9b', '#e3ffe9'];
  let T = 0;
  const frame = (st, d = {}, t = 1, extra = {}) => {
    T += 0.05;
    P.draw(g, { d: { bx: 0, by: -3, sx: 1, sy: 1, rot: 0.03, face: {}, ...d }, st, t, T, dt: 0.05, cur: extra.cur || 'idle', TH: pal, THEMES: { white: [], black: [] }, keys: new Float32Array(64).fill(0.1),
      live: { cmd: 'ls -la /var/log', res: extra.res ?? null, bar: 'NOTES.MD', q: 'ПОГОДА', ans: 'Готово! Вот **ответ**.', pct: extra.pct ?? null }, PS: [{ type: 'heart', x: 120, y: 90, life: 0.5, max: 1 }, { type: 'confetti', x: 110, y: 100, life: 0.5, max: 1, col: '#fff', seed: 0.3 }, { type: 'z', x: 150, y: 80, life: 1, max: 2 }],
      look: { x: 1, y: -1 }, bl: 0.4, term: { lines: ['PC TERM V2', '>help'], buf: 'snake' },
      snake: { b: [[3, 3], [2, 3], [1, 3], [31, 3]], d: [1, 0], a: [9, 9], score: 2, dead: extra.dead || 0 },
      tetris: { g: Array.from({ length: 11 }, (_, j) => Array(10).fill(j > 8 ? 2 : 0)), p: { sh: [[1, 1], [1, 1]], x: 3, y: 2, v: 3 }, flash: 0.1, lines: 4 },
      pong: { x: 30, y: 25, a: 25, b: 30, sa: 1, sb: 2 }, power: 1, shake: 1, note: 0.2, ...extra.o });
  };
  for (const app of ['shell', 'answer', 'listen', 'wait', 'plan', 'search', 'browse', 'read', 'process', 'analyze', 'code', 'write', 'build', 'test', 'debug',
    'download', 'upload', 'send', 'memory', 'translate', 'draw', 'calc', 'calendar', 'music', 'update', 'game', 'pong', 'terminal'])
    for (const t of [0.05, 1.2, 3.3, 7.9]) frame({ mode: 'app', app, label: 'Окно', loop: app === 'write' ? 10 : 0 }, { face: { l: 'h' } }, t, { res: t > 3 ? 'ok' : null, dead: app === 'game' && t > 3 ? 1 : 0 });
  for (const t of [1, 12, 20, 30]) frame({ mode: 'app', app: 'saver' }, { mode: 'raw' }, t);
  for (const full of ['check', 'err', 'off', 'boot', 'bsod', 'matrix', 'demo', 'credits', 'answer', 'rmrf', 'sudo', 'cheat'])
    for (const t of [0.1, 1.2, 2.2, 3.5]) frame({ mode: 'full', full }, {}, t);
  const eyes = ['n', 'up', 'd', 'w', 'scared', 'o', 'f', 't', 'ang', 'h', 'c', 'line', 'blink', 'heart', 'star', 'x', 'sp', '$', 'sq'];
  const mouths = ['smile', 'grin', 'flat', 'o', 'O', 'wavy', 'frown', 'cat', 'tongue', 'small', 'smirk', 'whistle', 'teeth', 'talk', 'pant'];
  eyes.forEach((l, i) => frame({}, { face: { l, r: eyes[(i + 3) % eyes.length], m: mouths[i % mouths.length], mo: 0.7, brow: ['up', 'ang', 'sad', 'flat', 'skep'][i % 5], blush: 1, sweat: 1, tear: 1, anger: 1, hand: 1, zz: 1, mug: 0.95, glasses: 0.5, text: 'DEAL WITH IT' }, thought: 1, rainCloud: 1, led: 3 }, 2, { cur: ['sleeping', 'listening', 'scared', 'hello'][i % 4] }));
  /* экран загрузки: тот же ноутбук в своём холсте */
  const boot = canvas(); P.mirror(boot.getContext());
  assert.equal(boot.width, 76);
  assert.deepEqual(errors, []);
  assert.ok(P.dbg().lid > 0, 'крышка не открылась');
  /* попадания: наклейка-радуга (титры), клавиатура (печатать), остальное — погладить */
  assert.equal(P.hit(128 + 35, 156 - 6, { bx: 0, by: 0 }), 'badge');
  assert.equal(P.hit(128, 156 - 13, { bx: 0, by: 0 }), 'keyboard');
  assert.equal(P.hit(128, 156 - 45, { bx: 0, by: 0 }), 'pc');
});

test('в index.html нет браузерного агента: модель зовёт только сервер', () => {
  const src = fs.readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8');
  assert.ok(src.length < 700 * 1024, 'index.html весит ' + src.length);
  assert.doesNotMatch(src, /chat\/completions|search\.parallel\.ai|indexedDB/);
});

test('верхняя панель — компактная, с Personal Computer в углу; шагов работы и «печатает» в чате нет', () => {
  const src = fs.readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8');
  assert.match(src, /<header id="petbar"[^>]*><div class="rv"><canvas id="room-cv"/);
  assert.match(src, /const room=window\.personalComputerRoom=/);
  assert.match(src, /id="jrnl"/);
  /* облачко: объяснение шага, строчка ниже для реплик, ход задачи */
  assert.match(src, /id="rbubt"[\s\S]*id="rbubs"[\s\S]*id="rbubf"/);
  /* панель не растягивается, кнопки звука на ней нет — звук в настройках; комнаты (окно, кот, лампа) больше нет */
  assert.doesNotMatch(src, /id="rgrip"|id="snd"|function buildBG|function drawCat|function computeLight/);
  assert.match(src, /id="c-sfx"[\s\S]*id="c-room"[\s\S]*id="c-vol"/);
  assert.doesNotMatch(src, /function trayAdd|function stopTray|className='dots'|\n\.tray\{/);
  const cl = fs.readFileSync(path.join(here, '..', 'public', 'client.js'), 'utf8');
  assert.doesNotMatch(cl, /trayAdd|stopTray|\bdots\b/);
});

test('приложение называется Personal Computer — и в окне браузера, и при установке', () => {
  const src = fs.readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8');
  assert.match(src, /<title>Personal Computer<\/title>/);
  assert.match(src, /name="apple-mobile-web-app-title" content="Personal Computer"/);
  const mf = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'manifest.webmanifest'), 'utf8'));
  assert.equal(mf.name, 'Personal Computer'); assert.equal(mf.short_name, 'Personal Computer');
  const cl = fs.readFileSync(path.join(here, '..', 'public', 'client.js'), 'utf8');
  /* прежнее имя в интерфейсе не осталось */
  assert.doesNotMatch(src, /Мочи|МОЧИ/);
  assert.doesNotMatch(cl, /Мочи|МОЧИ/);
});

test('поиск в интернете молчит — агент отвечает, не дожидаясь его 10 секунд', async () => {
  const first = await ask('привет');
  assert.ok(first < MCP_GRACE + 3000, 'первый ответ ждал ' + first + ' мс');
  assert.ok(!tools().includes('search__web_search'));
  /* попытка подключения ещё висит — второе сообщение не ждёт совсем */
  const second = await ask('ещё раз');
  assert.ok(second < 2000, 'второй ответ ждал ' + second + ' мс');
});

test('поиск подключается заранее, при старте сервера', async () => {
  mode = 'ok'; seen.length = 0;
  await m.restart();
  for (let i = 0; i < 100 && !seen.includes('tools/list'); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(seen.includes('tools/list'), 'сервер не подключился к поиску при старте: ' + seen.join(', '));
  await ask('найди что-нибудь');
  assert.ok(tools().includes('search__web_search'), 'в запросе нет поиска: ' + tools().join(', '));
});

const srv = async () => (await c.json('/api/tools', undefined, 'GET')).j.mcp.find(s => s.name === 'search');

test('поиск — обычный MCP-сервер в общем списке: сам появился, служебные параметры подставляет сервер', async () => {
  const cat = (await c.json('/api/tools', undefined, 'GET')).j;
  assert.ok(!cat.builtin.some(t => /web_/.test(t.name)), 'поиск остался среди встроенных');
  const s = cat.mcp.find(x => x.name === 'search');
  assert.ok(s && s.preset && s.on && !s.lazy, JSON.stringify(cat.mcp));
  assert.deepEqual(s.tools.map(t => t.name), ['web_search']);
  await ask('поищи погоду');
  const req = model.calls.find(x => x.body.messages[x.body.messages.length - 1].content === 'поищи погоду').body;
  assert.match(req.messages[0].content, /поиск в интернете \(search__web_search\)/);
  const def = req.tools.find(t => t.function.name === 'search__web_search').function.parameters;
  assert.ok(!def.properties.session_id && !def.required.includes('session_id'), 'модель видит session_id');
  const call = calls.pop();
  assert.equal(call.name, 'web_search'); assert.equal(call.arguments.q, 'погода');
  assert.match(call.arguments.session_id, /^\w{8,}$/);
});

test('предустановленный поиск выключается и удаляется — и после перезапуска не возвращается', async () => {
  assert.equal((await c.json('/api/mcp/search', { on: false })).status, 200);
  await ask('привет');
  assert.ok(!tools().includes('search__web_search'));
  assert.equal((await srv()).on, false);
  assert.equal((await c.json('/api/mcp/search', { on: true })).status, 200);
  assert.equal((await c.json('/api/mcp/search', undefined, 'DELETE')).status, 200);
  await m.restart();
  assert.equal(await srv(), undefined, 'удалённый поиск вернулся');
  await ask('привет');
  assert.ok(!tools().includes('search__web_search'));
  /* подключили снова по тому же адресу, под другим именем — служебные параметры по-прежнему скрыты */
  const r = await c.json('/api/mcp', { name: 'web', url: m.env.PERSONALCOMPUTER_SEARCH_MCP });
  assert.equal(r.j.err, null);
  const w = (await c.json('/api/tools', undefined, 'GET')).j.mcp.find(x => x.name === 'web');
  assert.ok(w.preset);
  assert.equal((await c.json('/api/mcp/web', { lazy: false })).status, 200);
  await ask('привет');
  const def = model.calls[model.calls.length - 1].body.tools.find(t => t.function.name === 'web__web_search');
  assert.ok(def && !def.function.parameters.properties.session_id);
  await c.json('/api/mcp/web', undefined, 'DELETE');
  /* удалённый предустановленный сервер возвращается кнопкой — с исходными настройками */
  assert.deepEqual((await c.json('/api/tools', undefined, 'GET')).j.presets, [{ name: 'search', title: 'Поиск в интернете' }]);
  const back = await c.json('/api/mcp-restore', { name: 'search' });
  assert.equal(back.j.err, null);
  const cat = (await c.json('/api/tools', undefined, 'GET')).j;
  assert.deepEqual(cat.presets, []);
  const s = cat.mcp.find(x => x.name === 'search');
  assert.ok(s.preset && s.on && !s.lazy && s.known);
  await ask('привет');
  assert.ok(tools().includes('search__web_search'));
  assert.match(model.calls.at(-1).body.messages[0].content, /не меняй адрес/);
});

test('у кого поиск был выключен (раньше — в настройках модели), предустановленный сервер появляется выключенным', async () => {
  const c2 = await registered(m, 'old');
  let id;
  for (let i = 0; i < 40 && !id; i++) {
    id = JSON.parse(fs.readFileSync(path.join(m.env.PERSONALCOMPUTER_DATA, 'users.json'), 'utf8')).users.find(u => u.name === 'old')?.id;
    if (!id) await new Promise(r => setTimeout(r, 50));
  }
  const dir = path.join(m.env.PERSONALCOMPUTER_DATA, 'users', id);
  assert.ok(id && !fs.existsSync(path.join(dir, 'ext.json')));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ search: false, tools: { web_fetch: false } }));
  await m.restart();
  const s = (await c2.json('/api/tools', undefined, 'GET')).j.mcp.find(x => x.name === 'search');
  assert.ok(s && s.preset && s.on === false, JSON.stringify(s));
  for (let i = 0; i < 40 && !fs.existsSync(path.join(dir, 'ext.json')); i++) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'ext.json'), 'utf8')).mcp.search.off, ['web_fetch']);
});
