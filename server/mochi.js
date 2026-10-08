#!/usr/bin/env node
/* mochi serve   — веб-сервер и агент (пользователь mochi)
   mochi runner  — исполнитель команд агента (пользователь mochi-agent)
   mochi fileop  — файловая операция агента от root (через sudo, при полном доступе)
   mochi invite [дней] | users | passwd <имя> | admin <имя> [off] | deluser <имя> | status — управление (root) */
import net from 'node:net';
import crypto from 'node:crypto';
import { CFG } from './lib/config.js';

const [cmd = 'serve', ...args] = process.argv.slice(2);

function adminCall(a) {
  return new Promise(async (ok, no) => {
    const { ADMIN_SOCK } = await import('./lib/server.js');
    const c = net.createConnection(ADMIN_SOCK());
    let buf = '';
    c.on('connect', () => c.write(JSON.stringify(a) + '\n'));
    c.on('data', d => buf += d);
    c.on('end', () => { try { ok(JSON.parse(buf)); } catch { no(new Error('пустой ответ')); } });
    c.on('error', e => no(new Error(e.code === 'EACCES' ? 'нет доступа: запусти через sudo' : e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'сервер Мочи не запущен (sudo mochi restart)' : e.message)));
  });
}

const out = r => { if (!r.ok) { console.error('Ошибка:', r.error); process.exit(1); } return r; };

switch (cmd) {
  case 'serve': (await import('./lib/server.js')).startServer(); break;
  case 'runner': (await import('./lib/runner.js')).startRunner(CFG.runnerSock); break;
  case 'invite': {
    const r = out(await adminCall(['invite', args[0] || '7']));
    console.log(`Код приглашения: ${r.code}  (действует ${r.days} дн., одноразовый)`);
    if (r.url) console.log('Ссылка для регистрации:', r.url);
    break;
  }
  case 'users': {
    const r = out(await adminCall(['users']));
    if (!r.users.length) console.log('Пользователей пока нет. Создай приглашение: sudo mochi invite');
    for (const u of r.users) console.log(`${u.name.padEnd(20)} ${u.admin ? 'админ ' : '      '} сессий: ${u.sessions}  ${u.running ? 'работает' : ''} ${u.telegram ? 'telegram' : ''}`);
    break;
  }
  case 'passwd': {
    if (!args[0]) { console.error('Использование: mochi passwd <имя>'); process.exit(2); }
    const pw = crypto.randomBytes(12).toString('base64url');
    out(await adminCall(['passwd', args[0], pw]));
    console.log(`Новый пароль для ${args[0]}: ${pw}\nВсе сессии пользователя завершены. Смени пароль после входа (настройки → Сервер).`);
    break;
  }
  case 'admin': out(await adminCall(['admin', args[0], args[1] || 'on'])); console.log('Готово'); break;
  case 'deluser': { const r = out(await adminCall(['deluser', args[0]])); console.log('Удалён.', r.note || ''); break; }
  case 'status': { const r = out(await adminCall(['status'])); console.log(JSON.stringify(r, null, 2)); break; }
  /* файловая операция агента от root: исполнитель зовёт «sudo -n -- node mochi.js fileop», когда у mochi-agent
     не хватило прав, а полный доступ включён. Запрос JSON — на stdin, ответ JSON — на stdout */
  case 'fileop': {
    let s = '';
    for await (const c of process.stdin) s += c;
    const { fileOp } = await import('./lib/fileops.js');
    let q; try { q = JSON.parse(s); } catch { q = null; }
    process.stdout.write(JSON.stringify(q && typeof q === 'object' ? await fileOp(q) : { err: 'неверный запрос' }) + '\n');
    break;
  }
  default:
    console.log('Команды: serve | runner | invite [дней] | users | passwd <имя> | admin <имя> [off] | deluser <имя> | status');
    process.exit(cmd === 'help' || cmd === '--help' ? 0 : 2);
}
