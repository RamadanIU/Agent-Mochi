/* Доступ агента (root): переключатель в настройках (только администратор, включение — с паролем),
   настоящий server/bin/mochi-access с поддельными sudo, visudo, runuser и systemctl,
   файловые инструменты от root через sudo и подсказка агенту */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMochi, registered, fakeModel, sleep } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ACCESS = path.join(here, '..', 'bin', 'mochi-access');
const UPDATE = path.join(here, '..', 'bin', 'mochi-update');
const MOCHI = path.join(here, '..', 'mochi.js');
const asRoot = process.getuid() === 0;

let st, fake, m, admin;
const P = (...a) => path.join(st, ...a);
const read = f => fs.readFileSync(f, 'utf8');
const exe = (f, body) => fs.writeFileSync(f, '#!/bin/sh\n' + body, { mode: 0o755 });

/* «система» в миниатюре: правила sudo — в st/sudoers.d, юниты — в st/units, вызовы systemctl — в st/systemctl.log */
function fakeSystem() {
  fake = P('bin');
  fs.mkdirSync(fake);
  exe(path.join(fake, 'systemctl'), `echo "$*" >> "$FAKE_LOG"
if [ "$1" = show ]; then
  if [ -e "$MOCHI_UNITS/$4.service.d/mochi-root.conf" ]; then echo NoNewPrivileges=no; else echo NoNewPrivileges=yes; fi
fi
exit 0
`);
  /* visudo: правило без NOPASSWD — «ошибка синтаксиса»; FAKE_STRICT — не понимает Defaults (как sudo-rs) */
  exe(path.join(fake, 'visudo'), `[ "$1" = -cf ] || exit 2
grep -q NOPASSWD "$2" || exit 1
[ -n "$FAKE_STRICT" ] && grep -q '^Defaults' "$2" && exit 1
exit 0
`);
  exe(path.join(fake, 'sudo'), `case "$*" in
  "-n -l -U mochi-agent")
    if [ -e "$MOCHI_SUDOERS_D/mochi-agent" ] || [ -n "$FAKE_OTHER_RULE" ]; then echo "User mochi-agent may run the following commands on host:"; echo "    (ALL : ALL) NOPASSWD: ALL"
    else echo "User mochi-agent is not allowed to run sudo on host."; fi ;;
  "-n true") [ -e "$MOCHI_SUDOERS_D/mochi-agent" ] ;;
  *) exit 1 ;;
esac
`);
  exe(path.join(fake, 'runuser'), 'shift 3\nexec "$@"\n');
  fs.mkdirSync(P('sudoers.d')); fs.mkdirSync(P('units')); fs.mkdirSync(P('etc'));
  fs.writeFileSync(P('etc', 'install.conf'), "DOMAIN=''\nPORT='8787'\nWITH_SUDO='0'\nREPO='me/mochi'\n", { mode: 0o600 });
  fs.writeFileSync(P('etc', 'mochi.env'), 'MOCHI_PORT=8787\nMOCHI_AGENT_SUDO=0\nMOCHI_ACCESS_CTL=1\n', { mode: 0o640 });
  fs.writeFileSync(P('cg-host'), '0::/user.slice/user-0.slice/session-1.scope\n');
  fs.writeFileSync(P('cg-agent'), '0::/system.slice/mochi-runner.service\n');
}
const env = (extra = {}) => ({ ...process.env, PATH: fake + ':' + process.env.PATH, MOCHI_STATE: st, MOCHI_ETC: P('etc'), MOCHI_SUDOERS_D: P('sudoers.d'),
  MOCHI_UNITS: P('units'), MOCHI_INIT: 'systemd', MOCHI_CGROUP: P('cg-host'), FAKE_LOG: P('systemctl.log'), ...extra });
const access = (args, extra) => spawnSync('bash', [ACCESS, ...args], { env: env(extra), encoding: 'utf8' });
const calls = () => fs.existsSync(P('systemctl.log')) ? read(P('systemctl.log')).trim().split('\n') : [];
const restarts = () => calls().filter(l => l === 'restart mochi-runner mochi-term').length;
const status = () => JSON.parse(read(P('update', 'access.json')));

before(async () => {
  st = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-acc-'));
  fs.mkdirSync(P('update'));
  fakeSystem();
  /* исполнитель — в процессе сервера; sudo у агента «нет» (поддельный sudo без правила) */
  m = await startMochi({ MOCHI_DATA: P('data'), MOCHI_UPDATE_DIR: P('update'), MOCHI_ACCESS_CTL: '1', MOCHI_SUDO: path.join(fake, 'sudo'), MOCHI_SUDOERS_D: P('none') });
  admin = await registered(m, 'boss');
});
after(async () => { await m?.stop(); if (st) fs.rmSync(st, { recursive: true, force: true }); });

test('API: смотреть может каждый, переключать — только администратор; включить — только с паролем', async () => {
  const g = await admin.json('/api/access', undefined, 'GET');
  assert.equal(g.status, 200);
  assert.equal(g.j.root, asRoot, 'без sudo агент — обычный пользователь');
  assert.equal(g.j.ready, true); assert.equal(g.j.admin, true); assert.equal(g.j.users, 1);
  assert.equal(g.j.status.state, 'idle');

  const guest = await registered(m, 'guest');
  assert.equal((await guest.json('/api/access', undefined, 'GET')).j.admin, false);
  assert.equal((await guest.json('/api/access', { root: true, password: 'password123' })).status, 403);
  assert.equal((await guest.json('/api/access', { root: false })).status, 403);

  assert.equal((await admin.json('/api/access', { root: 'yes' })).status, 400);
  const nopw = await admin.json('/api/access', { root: true });
  assert.equal(nopw.status, 400); assert.equal(nopw.j.field, 'password');
  assert.equal((await admin.json('/api/access', { root: true, password: 'неверный' })).status, 400);
  assert.ok(!fs.existsSync(P('data', 'access.request')), 'без пароля запроса нет');

  const r = await admin.json('/api/access', { root: true, password: 'password123' });
  assert.equal(r.status, 200);
  assert.equal(r.j.status.state, 'queued'); assert.equal(r.j.status.want, 'on');
  assert.equal(read(P('data', 'access.request')), 'on\n', 'в запросе — одно слово');
  assert.equal(fs.statSync(P('data', 'access.request')).mode & 0o777, 0o600);
  const c = await admin.json('/api/access', undefined, 'DELETE');
  assert.equal(c.j.status.state, 'idle');
  assert.ok(!fs.existsSync(P('data', 'access.request')));
  assert.equal((await admin.json('/api/access', undefined, 'DELETE')).status, 409, 'отменять нечего');

  const off = await admin.json('/api/access', { root: false });
  assert.equal(off.status, 200, 'забрать root — без пароля');
  assert.equal(read(P('data', 'access.request')), 'off\n');
  fs.rmSync(P('data', 'access.request'));
});

test('mochi-access: включает root по запросу из настроек — sudoers, drop-in, настройки, перезапуск', async () => {
  await admin.json('/api/access', { root: true, password: 'password123' });
  const r = access(['service']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(P('data', 'access.request')), 'запрос забран');

  const rule = read(P('sudoers.d', 'mochi-agent'));
  assert.match(rule, /^mochi-agent ALL=\(ALL:ALL\) NOPASSWD: ALL$/m);
  assert.match(rule, /^Defaults:mochi-agent !requiretty, !lecture, umask=0022, umask_override$/m, 'файлы root — 0644, а не 0640 из UMask службы');
  assert.match(rule, /env_keep \+= "DEBIAN_FRONTEND/);
  assert.equal(fs.statSync(P('sudoers.d', 'mochi-agent')).mode & 0o777, 0o440);
  for (const u of ['mochi-runner', 'mochi-term']) {
    const d = read(P('units', u + '.service.d', 'mochi-root.conf'));
    for (const k of ['NoNewPrivileges=no', 'ProtectSystem=no', 'ProtectHome=no', 'PrivateTmp=no', 'ProtectKernelTunables=no', 'ProtectKernelModules=no', 'RestrictSUIDSGID=no'])
      assert.match(d, new RegExp('^' + k + '$', 'm'), u + ': ' + k);
    assert.match(d, /^InaccessiblePaths=$/m, 'список скрытых путей сброшен');
  }
  assert.match(read(P('etc', 'install.conf')), /^WITH_SUDO='1'$/m, 'обновление сохранит root');
  assert.match(read(P('etc', 'install.conf')), /^REPO='me\/mochi'$/m, 'остальное не тронуто');
  assert.equal(fs.statSync(P('etc', 'install.conf')).mode & 0o777, 0o600, 'права файла те же');
  assert.match(read(P('etc', 'mochi.env')), /^MOCHI_AGENT_SUDO=1$/m);
  assert.deepEqual(calls().slice(0, 2), ['daemon-reload', 'restart mochi-runner mochi-term']);

  const s = status();
  assert.equal(s.state, 'done'); assert.equal(s.mode, 'on'); assert.equal(s.want, 'on'); assert.equal(s.by, 'web');
  const g = (await admin.json('/api/access', undefined, 'GET')).j;
  assert.equal(g.mode, 'on'); assert.equal(g.status.state, 'done');

  /* ещё раз «on» — ничего не изменилось, службы не дёргаем (не обрываем команды агента зря) */
  const again = access(['cli', 'on']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /У агента полный root/);
  assert.equal(restarts(), 1);
});

test('mochi-access: забирает root (sudo mochi root off) и предупреждает о правах не от Мочи', () => {
  const r = access(['cli', 'off'], { FAKE_OTHER_RULE: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(P('sudoers.d', 'mochi-agent')));
  assert.ok(!fs.existsSync(P('units', 'mochi-runner.service.d')), 'drop-in и пустая папка убраны');
  assert.match(read(P('etc', 'install.conf')), /^WITH_SUDO='0'$/m);
  assert.match(read(P('etc', 'mochi.env')), /^MOCHI_AGENT_SUDO=0$/m);
  assert.equal(restarts(), 2);
  assert.match(r.stdout, /Root у агента забран/);
  const s = status();
  assert.equal(s.mode, 'off'); assert.equal(s.by, 'cli'); assert.equal(s.state, 'done');
  assert.match(s.note, /остались права sudo из другого правила/);

  const q = access(['cli', 'status']);
  assert.match(q.stdout, /root\): выключен/);
});

test('mochi-access: sudo без Defaults (sudo-rs) — только само правило; мусор в запросе — отказ', async () => {
  const r = access(['apply', 'on', '--no-restart'], { FAKE_STRICT: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rule = read(P('sudoers.d', 'mochi-agent'));
  assert.doesNotMatch(rule, /Defaults/);
  assert.match(rule, /^mochi-agent ALL=\(ALL:ALL\) NOPASSWD: ALL$/m);
  assert.equal(restarts(), 2, 'установщик перезапускает службы сам');
  assert.equal(status().by, 'install');

  fs.writeFileSync(P('data', 'access.request'), 'rm -rf /\n');
  const bad = access(['service']);
  assert.equal(bad.status, 1);
  assert.match(status().error, /непонятный запрос/);
  assert.ok(fs.existsSync(P('sudoers.d', 'mochi-agent')), 'ничего не поменялось');
  assert.ok(!fs.existsSync(P('data', 'access.request')));
  const g = (await admin.json('/api/access', undefined, 'GET')).j;
  assert.equal(g.status.state, 'failed'); assert.match(g.status.error, /непонятный запрос/);
});

test('изнутри агента (исполнитель или терминал Мочи) mochi root/update не обрывают сами себя — идут через root-службу', () => {
  const n = restarts();
  const r = access(['cli', 'off'], { MOCHI_CGROUP: P('cg-agent') });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Запрос передан службе mochi-access/);
  assert.equal(read(P('data', 'access.request')), 'off\n');
  assert.ok(fs.existsSync(P('sudoers.d', 'mochi-agent')), 'сама команда ничего не меняет');
  assert.equal(restarts(), n);
  fs.rmSync(P('data', 'access.request'));

  const u = spawnSync('bash', [UPDATE, 'cli'], { env: env({ MOCHI_CGROUP: P('cg-agent') }), encoding: 'utf8' });
  assert.equal(u.status, 0, u.stderr);
  assert.match(u.stdout, /Запрос передан службе обновления/);
  assert.match(read(P('data', 'update.request')), /"by":"agent"/);
  fs.rmSync(P('data', 'update.request'));
});

test('переключение, которое оборвалось, не висит вечно; без службы — подсказка про sudo mochi root', async () => {
  const p = spawn('true'); await new Promise(r => p.on('exit', r));
  fs.writeFileSync(P('update', 'access.json'), JSON.stringify({ state: 'running', want: 'on', mode: 'off', by: 'web', pid: p.pid, started: Math.floor(Date.now() / 1000) }));
  const s = (await admin.json('/api/access', undefined, 'GET')).j.status;
  assert.equal(s.state, 'failed'); assert.match(s.error, /прервалось/);
  fs.writeFileSync(P('update', 'access.json'), JSON.stringify({ state: 'running', want: 'on', mode: 'off', by: 'web', pid: process.pid, started: Math.floor(Date.now() / 1000) }));
  assert.equal((await admin.json('/api/access', { root: true, password: 'password123' })).status, 409, 'второе переключение поверх идущего не запускаем');
  fs.rmSync(P('update', 'access.json'));

  const m2 = await startMochi({ MOCHI_SUDO: path.join(fake, 'sudo'), MOCHI_SUDOERS_D: P('none') });
  try {
    const c = await registered(m2, 'solo');
    assert.equal((await c.json('/api/access', undefined, 'GET')).j.ready, false);
    const r = await c.json('/api/access', { root: true, password: 'password123' });
    assert.equal(r.status, 409);
    assert.match(r.j.error, /sudo mochi root on/);
  } finally { await m2.stop(); }
});

test('mochi.js fileop: файловая операция по запросу на stdin (так её запускает sudo от root)', () => {
  fs.writeFileSync(P('conf.txt'), 'listen 80;\n');
  const r = spawnSync(process.execPath, [MOCHI, 'fileop'], { input: JSON.stringify({ fop: 'edit', path: P('conf.txt'), edits: [{ old_string: 'listen 80;', new_string: 'listen 8080;' }] }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.match(j.text, /Изменён/); assert.ok(j.sig);
  assert.equal(read(P('conf.txt')), 'listen 8080;\n');
  assert.match(JSON.parse(spawnSync(process.execPath, [MOCHI, 'fileop'], { input: 'не json', encoding: 'utf8' }).stdout).err, /неверный запрос/);
});

test('файловые инструменты: не хватило прав — повтор от root через sudo (только при полном доступе)', { skip: asRoot && 'под root прав хватает всегда — проверяется в CI' }, async () => {
  /* поддельный sudo: «-n true» — можно; иначе запоминает команду и запрос и отвечает «от root» */
  const log = P('sudo-root.log'), sudo = path.join(fake, 'sudo-root');
  exe(sudo, `[ "$*" = "-n true" ] && exit 0
echo "$*" >> "${log}"; cat > "${log}.in"
echo '{"text":"Изменён /etc/x.conf","real":"/etc/x.conf","sig":"1:2:3:4"}'
`);
  const saved = { ...process.env };
  Object.assign(process.env, { MOCHI_DEV: '1', MOCHI_SUDO: sudo, MOCHI_AGENT_SUDO: '1' });
  after(() => { for (const k of ['MOCHI_DEV', 'MOCHI_SUDO', 'MOCHI_AGENT_SUDO']) if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; });
  const { agentFileOp } = await import('../lib/runner.js');
  const { CFG } = await import('../lib/config.js');
  const locked = P('locked.conf');
  fs.writeFileSync(locked, 'a = 1\n'); fs.chmodSync(locked, 0);
  const q = { fop: 'edit', path: 'locked.conf', cwd: st, edits: [{ old_string: 'a = 1', new_string: 'a = 2' }] };

  const r = await agentFileOp(q);
  assert.equal(r.root, true);
  assert.match(r.text, /Изменён \/etc\/x\.conf\n\[сделано от root/);
  assert.match(read(log), new RegExp('^-n -- ' + process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' .*mochi\\.js fileop$', 'm'));
  assert.equal(JSON.parse(read(log + '.in')).path, locked, 'путь уже готовый (у root другой HOME и папка)');

  CFG.agentSudo = false;
  const r2 = await agentFileOp(q);
  assert.match(r2.err, /нет прав/, 'в разработке без MOCHI_AGENT_SUDO=1 — не трогаем sudo');
  assert.equal(r2.root, undefined);
  CFG.agentSudo = true;
  fs.chmodSync(locked, 0o600);
});

test('подсказка агенту: с root — как им пользоваться бережно; без root — кто и где его включает', async () => {
  const sysOf = async (extra, name) => {
    const model = await fakeModel([{ text: 'ок' }]);
    const mm = await startMochi(extra);
    try {
      const c = await registered(mm, name);
      await c.json('/api/settings', { base: model.url, model: 'fake-1' }, 'PUT');
      const done = c.events(evs => evs.some(e => e.ev === 'run' && e.d.running === false));
      await c.json('/api/chat', { text: 'привет' });
      await done;
      return model.calls[0].body.messages[0].content;
    } finally { await mm.stop(); model.close(); }
  };
  fs.writeFileSync(path.join(st, 'mochi-agent'), '');
  const on = await sysOf({ MOCHI_SUDO: path.join(fake, 'sudo'), MOCHI_SUDOERS_D: st /* «правило есть» — в st лежит файл mochi-agent */ }, 'rooty');
  assert.match(on, /полный root-доступ к серверу/);
  assert.match(on, /спроси пользователя/);
  assert.match(on, /Службы mochi\*/);
  if (!asRoot) {
    const off = await sysOf({ MOCHI_SUDO: path.join(fake, 'sudo'), MOCHI_SUDOERS_D: P('none') }, 'plain');
    assert.match(off, /Прав root и sudo нет/);
    assert.match(off, /«Доступ агента»/);
  }
});

