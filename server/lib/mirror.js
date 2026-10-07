/* Команды агента — на экране терминала, как в браузерной версии: видно, как Мочи печатает команду
   и что та выводит. Сами команды по-прежнему выполняет исполнитель (свой bash на каждую команду),
   а сюда приходит только их «картинка»: пишем прямо в tty первой панели tmux (его и pid оболочки
   запоминает bin/mochi-pane). Ввод пользователя не трогаем: после команды отправляем в панель M-1 C-l —
   это штатное «перерисовать текущую строку» readline, и приглашение с недонабранным текстом возвращается.
   Если в панели сейчас работает программа пользователя (vim, top, долгая команда), экран не портим. */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX = 256 * 1024;  /* больше вывода одной команды в терминал не льём */
const ESC = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let q = Promise.resolve(); /* общая очередь записи: строки разных команд не перемешиваются посимвольно */
/* приглашение возвращаем, только когда агент притих: команды подряд не перебиваются перерисовкой */
let active = 0, redrawT = 0, redrawAt = 0;
function redraw(p) {
  clearTimeout(redrawT);
  redrawT = setTimeout(() => {
    if (active) return;
    const now = pane(); /* пока шёл вывод, пользователь мог запустить свою программу — ей клавиши не шлём */
    if (!now || now.pid !== p.pid || !p.id || !p.sock) return;
    redrawAt = Date.now();
    execFile('tmux', ['-S', p.sock, 'send-keys', '-t', p.id, 'M-1', 'C-l'], { timeout: 5000 }, () => {});
  }, 400);
  redrawT.unref?.();
}

function pane() {
  try {
    const [tty, pid, id, sock] = fs.readFileSync(path.join(os.homedir(), '.local/state/mochi/term'), 'utf8').split('\n');
    if (!/^\/dev\/pts\/\d+$/.test(tty) || !/^\d+$/.test(pid)) return null;
    const st = fs.statSync(tty);
    if (!st.isCharacterDevice() || st.uid !== process.getuid?.()) return null;
    /* оболочка жива и сама на переднем плане своего терминала (поле tpgid в /proc/PID/stat) */
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (+f[5] !== +pid) return null;
    return { tty, pid: +pid, id: /^%\d+$/.test(id) ? id : '', sock: sock && sock.startsWith('/') ? sock : '' };
  } catch { return null; }
}

/* → {out(chunk), end(result)} или null, если терминала нет (его ещё не открывали) */
export function mirror(cmd, cwd) {
  const p = pane();
  if (!p) return null;
  let fd;
  try { fd = fs.openSync(p.tty, fs.constants.O_WRONLY | fs.constants.O_NOCTTY); } catch { return null; }
  active++; clearTimeout(redrawT);
  const since = Date.now() - redrawAt; /* readline ещё дорисовывает приглашение — подождём */
  if (since < 300) q = q.then(() => sleep(300 - since));
  const put = s => { q = q.then(() => new Promise(r => fs.write(fd, s, () => r()))); };
  const home = os.homedir();
  const dir = cwd === home ? '~' : cwd && cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd || '~';
  /* приглашение агента: метка МОЧИ в инверсии, дальше — как обычная строка оболочки */
  put('\r\x1b[K\x1b[7m МОЧИ \x1b[27m ' + dir + '$ ');
  const chars = Array.from(String(cmd).replace(/\r/g, '').replace(ESC, '').replace(/\n/g, '\r\n> '));
  const step = chars.length > 400 ? 0 : Math.min(28, 1400 / Math.max(chars.length, 1));
  q = q.then(async () => {
    for (let i = 0; i < chars.length; i += step ? 1 : 64) {
      await new Promise(r => fs.write(fd, chars.slice(i, i + (step ? 1 : 64)).join(''), () => r()));
      if (step) await sleep(step);
    }
  });
  put('\r\n');
  let sent = 0, last = '\n', cut = false;
  return {
    out(s) {
      if (cut) return;
      s = String(s).replace(ESC, '');
      if (!s) return;
      if (sent + s.length > MAX) { s = s.slice(0, MAX - sent) + '\n…(дальше вывод не показан)\n'; cut = true; }
      sent += s.length; last = s.slice(-1);
      put(s.replace(/\r?\n/g, '\r\n'));
    },
    end(r = {}) {
      let tail = last === '\n' ? '' : '\r\n';
      const why = r.timedOut ? 'время вышло' : r.killed ? 'прервано' : r.code ? 'код ' + r.code : '';
      if (why) tail += '\x1b[2m[' + why + ']\x1b[22m\r\n';
      put(tail);
      q = q.then(() => {
        try { fs.closeSync(fd); } catch {}
        active--; redraw(p);
      });
    },
  };
}
