/* Обновления: проверка GitHub (API, ETag, запасная лента коммитов), запрос «Обновить» от администратора
   и настоящий server/bin/mochi-update с поддельным установщиком */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMochi, registered, client, sleep } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'bin', 'mochi-update');
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40);
const COMMITS = [
  { sha: B, parents: [{ sha: A }, { sha: C }], commit: { message: 'Merge pull request #12 from me/upd\n\nОбновление прямо из настроек', committer: { date: '2026-10-07T20:00:00Z' } } },
  { sha: C, parents: [{ sha: D }], commit: { message: 'Обновление прямо из настроек\n\nподробности', committer: { date: '2026-10-07T19:00:00Z' } } },
  { sha: D, parents: [{ sha: A }], commit: { message: 'Питомец показывает ход обновления', committer: { date: '2026-10-07T18:00:00Z' } } },
  { sha: A, parents: [{ sha: 'e'.repeat(40) }, { sha: 'f'.repeat(40) }], commit: { message: 'Merge pull request #11 from me/term\n\nТерминал', committer: { date: '2026-10-05T10:00:00Z' } } },
];
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FEED = `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n` + COMMITS.map(c => `  <entry>
    <id>tag:github.com,2008:Grit::Commit/${c.sha}</id>
    <title>\n        ${esc(c.commit.message.split('\n')[0].slice(0, 60))}\n    </title>
    <updated>${c.commit.committer.date}</updated>
    <content type="html">\n      ${esc("<pre style='white-space:pre-wrap;width:81ex'>" + esc(c.commit.message) + '</pre>')}\n    </content>
  </entry>`).join('\n') + '\n</feed>\n';

let gh, st, m, admin;
/* поддельный GitHub: API (режимы ok / limit / gone) и лента коммитов; помнит, с каким ETag спрашивали */
async function fakeGitHub() {
  const s = { mode: 'ok', calls: [], v: 1 };
  const srv = http.createServer((req, res) => {
    s.calls.push({ url: req.url, inm: req.headers['if-none-match'] || null });
    if (req.url.startsWith('/repos/me/mochi/commits')) {
      if (s.mode === 'limit') { res.writeHead(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) }); return res.end('{"message":"API rate limit exceeded"}'); }
      if (s.mode === 'gone') { res.writeHead(404); return res.end('{"message":"Not Found"}'); }
      const etag = '"v' + s.v + '"';
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json', etag }); return res.end(JSON.stringify(COMMITS));
    }
    if (req.url === '/me/mochi/commits.atom') { res.writeHead(200, { 'content-type': 'application/atom+xml', etag: '"f1"' }); return res.end(FEED); }
    res.writeHead(404); res.end();
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  s.url = 'http://127.0.0.1:' + srv.address().port;
  s.close = () => srv.close();
  return s;
}
/* «root-служба» в миниатюре: настоящий mochi-update с поддельным установщиком */
function runUpdater(installer, mode = 'service') {
  const inst = path.join(st, 'fake-install.sh');
  fs.writeFileSync(inst, '#!/usr/bin/env bash\n' + installer, { mode: 0o755 });
  return spawnSync('bash', [SCRIPT, mode], { env: { ...process.env, MOCHI_STATE: st, MOCHI_ETC: path.join(st, 'etc'), MOCHI_INSTALL_SH: inst }, encoding: 'utf8' });
}

before(async () => {
  gh = await fakeGitHub();
  st = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-upd-'));
  fs.mkdirSync(path.join(st, 'update'));
  fs.writeFileSync(path.join(st, 'build.json'), JSON.stringify({ repo: 'me/mochi', ref: 'HEAD', commit: A, installed: '2026-10-05T11:00:00Z' }));
  m = await startMochi({ MOCHI_DATA: path.join(st, 'data'), MOCHI_BUILD: path.join(st, 'build.json'), MOCHI_UPDATE_DIR: path.join(st, 'update'), MOCHI_UPDATE_API: gh.url, MOCHI_UPDATE_WEB: gh.url });
  admin = await registered(m, 'boss');
});
after(async () => { await m?.stop(); gh?.close(); if (st) fs.rmSync(st, { recursive: true, force: true }); });

test('проверка: что нового — названия PR вместо «Merge…», без повторов; повторная проверка с ETag', async () => {
  assert.equal((await client(m.base).json('/api/update', undefined, 'GET')).status, 401, 'без входа не показываем');
  const r = await admin.json('/api/update/check', {});
  assert.equal(r.status, 200);
  const j = r.j;
  assert.equal(j.available, true);
  assert.equal(j.current.commit, 'aaaaaaa');
  assert.equal(j.current.date, '2026-10-05T10:00:00Z');
  assert.equal(j.latest.commit, 'bbbbbbb');
  assert.deepEqual(j.changes.map(c => c.title), ['Обновление прямо из настроек', 'Питомец показывает ход обновления']);
  assert.equal(j.more, false);
  assert.equal(j.admin, true); assert.equal(j.ready, true); assert.equal(j.status.state, 'idle');
  assert.equal((await admin.json('/api/me', undefined, 'GET')).j.build, 'aaaaaaa', 'номер сборки для автоперезагрузки страниц');

  await sleep(1100);
  const r2 = await admin.json('/api/update/check', {});
  assert.equal(r2.j.available, true, 'после 304 данные те же');
  assert.equal(gh.calls.filter(c => c.url.startsWith('/repos/')).at(-1).inm, '"v1"', 'спросили с If-None-Match');
});

test('лимит API GitHub — берём ленту коммитов; репозитория нет — понятная ошибка', async () => {
  gh.mode = 'limit';
  await sleep(1100);
  const r = await admin.json('/api/update/check', {});
  assert.equal(r.j.error, null);
  assert.equal(r.j.available, true);
  assert.deepEqual(r.j.changes.map(c => c.title), ['Обновление прямо из настроек', 'Питомец показывает ход обновления']);
  assert.ok(gh.calls.some(c => c.url === '/me/mochi/commits.atom'), 'ходили в ленту');

  gh.mode = 'gone';
  await sleep(1100);
  const g = await admin.json('/api/update/check', {});
  assert.match(g.j.error, /на GitHub нет me\/mochi/);
  assert.equal(g.j.available, true, 'прошлый ответ не теряем');
  gh.mode = 'ok';
});

test('обновить может только администратор; запрос, повтор и отмена', async () => {
  const u2 = await registered(m, 'guest');
  const g = await u2.json('/api/update', undefined, 'GET');
  assert.equal(g.status, 200); assert.equal(g.j.admin, false);
  assert.equal((await u2.json('/api/update', {})).status, 403);
  assert.ok(!fs.existsSync(path.join(st, 'data', 'update.request')));

  const r = await admin.json('/api/update', {});
  assert.equal(r.status, 200); assert.equal(r.j.status.state, 'queued');
  assert.ok(fs.existsSync(path.join(st, 'data', 'update.request')), 'запрос лёг в данные сервера');
  assert.equal((await admin.json('/api/update', {})).j.status.state, 'queued', 'повторное нажатие — не ошибка');
  const c = await admin.json('/api/update', undefined, 'DELETE');
  assert.equal(c.j.status.state, 'idle');
  assert.ok(!fs.existsSync(path.join(st, 'data', 'update.request')));
});

test('mochi-update: забирает запрос, пишет шаги и итог; полный журнал — отдельно', async () => {
  await admin.json('/api/update', {});
  const ok = runUpdater(`echo "🐾 Устанавливаю Мочи · test"
echo "шум, который в браузер не попадает"
echo "✔ Пакеты на месте"
echo "  Код приглашения: abcd-efgh-ijkl"
echo "args=$* commit=[\${MOCHI_COMMIT}] updater=\${MOCHI_UPDATER}"
echo "✔ Сервер Мочи работает"`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!fs.existsSync(path.join(st, 'data', 'update.request')), 'запрос забран');
  const full = fs.readFileSync(path.join(st, 'update', 'install.log'), 'utf8');
  assert.match(full, /args=--update commit=\[\] updater=1/);
  assert.match(full, /Код приглашения/);
  assert.doesNotMatch(fs.readFileSync(path.join(st, 'update', 'steps.log'), 'utf8'), /приглашения|шум/, 'в браузер — только шаги');
  assert.equal(fs.statSync(path.join(st, 'update', 'install.log')).mode & 0o777, 0o600);

  const s = (await admin.json('/api/update', undefined, 'GET')).j.status;
  assert.equal(s.state, 'done');
  assert.equal(s.by, 'web');
  assert.deepEqual(s.steps.map(x => x.k + ':' + x.t), ['run:Смотрю, что нового на GitHub…', 'run:Устанавливаю Мочи · test', 'ok:Пакеты на месте', 'ok:Сервер Мочи работает']);

  const bad = runUpdater('echo "🐾 Ставлю код Мочи…"\necho "✘ Код не прошёл проверку синтаксиса"\nexit 3', 'cli');
  assert.equal(bad.status, 3);
  assert.match(bad.stdout, /Код не прошёл проверку/, 'в терминале видно ход');
  const f = (await admin.json('/api/update', undefined, 'GET')).j.status;
  assert.equal(f.state, 'failed'); assert.equal(f.by, 'cli'); assert.equal(f.code, 3);
  assert.equal(f.error, 'Код не прошёл проверку синтаксиса');

  /* вместо установщика скачалось что-то другое (страница ошибки) — не запускаем */
  fs.writeFileSync(path.join(st, 'not-installer.sh'), '<html>404</html>\n');
  const j2 = spawnSync('bash', [SCRIPT, 'service'], { env: { ...process.env, MOCHI_STATE: st, MOCHI_ETC: path.join(st, 'etc'), MOCHI_INSTALL_SH: path.join(st, 'not-installer.sh') }, encoding: 'utf8' });
  assert.equal(j2.status, 1);
  assert.match((await admin.json('/api/update', undefined, 'GET')).j.status.error, /не установщик Мочи/);
});

test('обновление, которое оборвалось (процесса нет), не висит вечно', async () => {
  const p = spawn('true'); await new Promise(r => p.on('exit', r));
  fs.writeFileSync(path.join(st, 'update', 'status.json'), JSON.stringify({ state: 'running', by: 'web', pid: p.pid, started: Math.floor(Date.now() / 1000), from: A }));
  const s = (await admin.json('/api/update', undefined, 'GET')).j.status;
  assert.equal(s.state, 'failed');
  assert.match(s.error, /прервалось/);
  /* а пока процесс жив — «идёт» */
  fs.writeFileSync(path.join(st, 'update', 'status.json'), JSON.stringify({ state: 'running', by: 'web', pid: process.pid, started: Math.floor(Date.now() / 1000), from: A }));
  assert.equal((await admin.json('/api/update', undefined, 'GET')).j.status.state, 'running');
  assert.equal((await admin.json('/api/update', {})).status, 409, 'второе обновление поверх идущего не запускаем');
  fs.rmSync(path.join(st, 'update', 'status.json'));
});

test('без службы обновления кнопка объясняет, что сделать', async () => {
  const m2 = await startMochi({ MOCHI_BUILD: path.join(st, 'build.json'), MOCHI_UPDATE_API: gh.url, MOCHI_UPDATE_WEB: gh.url });
  try {
    const c = await registered(m2, 'solo');
    const g = await c.json('/api/update', undefined, 'GET');
    assert.equal(g.j.ready, false);
    const r = await c.json('/api/update', {});
    assert.equal(r.status, 409);
    assert.match(r.j.error, /sudo mochi update/);
  } finally { await m2.stop(); }
});

test('сразу после обновления не предлагаем обновиться снова, а перепроверяем GitHub', async () => {
  /* поставили коммит X, которого в прошлой проверке ещё не было (вышел позже) */
  const X = '9'.repeat(40);
  COMMITS.unshift({ sha: X, parents: [{ sha: B }], commit: { message: 'Свежее исправление', committer: { date: '2026-10-07T21:00:00Z' } } });
  gh.v++;
  fs.writeFileSync(path.join(st, 'build.json'), JSON.stringify({ repo: 'me/mochi', ref: 'HEAD', commit: X, installed: new Date().toISOString() }));
  await m.restart();
  const now = (await admin.json('/api/update', undefined, 'GET')).j;
  assert.equal(now.current.commit, '9999999');
  assert.equal(now.available, null, 'старый список не знает новую версию — не «есть обновление»');
  assert.equal((await admin.json('/api/me', undefined, 'GET')).j.build, '9999999');
  let j;
  for (let k = 0; k < 60; k++) { await sleep(100); j = (await admin.json('/api/update', undefined, 'GET')).j; if (j.available !== null) break; }
  assert.equal(j.available, false, 'перепроверили сами через пару секунд: стоит последняя');
  assert.equal(j.latest.commit, '9999999');
});
