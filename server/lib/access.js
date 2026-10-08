/* Доступ агента: обычный пользователь mochi-agent или полный root (sudo без пароля).
   • Есть ли root прямо сейчас — спрашиваем исполнитель (он проверяет «sudo -n true» в своей службе).
   • Переключает root-служба mochi-access (server/bin/mochi-access): у сервера прав нет, он лишь кладёт
     файл-запрос в свои данные — одно слово, on или off. Служба правит sudoers и изоляцию исполнителя и терминала,
     перезапускает их и пишет ход и итог в CFG.updateDir/access.json (mode — что сейчас настроено).
   • Включить может только администратор и только с паролем; выключить — без пароля. */
import fs from 'node:fs';
import path from 'node:path';
import { CFG } from './config.js';
import { agentInfo } from './runner-client.js';

const STALE = 45 * 60e3;
const reqFile = () => path.join(CFG.data, 'access.request');
const str = (v, n = 400) => typeof v === 'string' && v ? v.slice(0, n) : null;

/* служба mochi-access установлена (установщик пишет MOCHI_ACCESS_CTL=1 вместе с ней) */
export const accessReady = () => CFG.accessCtl && !!CFG.updateDir && fs.existsSync(CFG.updateDir);

export function accessStatus() {
  let s = null, req = null;
  if (CFG.updateDir) try { s = JSON.parse(fs.readFileSync(path.join(CFG.updateDir, 'access.json'), 'utf8')); } catch {}
  try { const since = fs.statSync(reqFile()).mtimeMs; req = { since, want: fs.readFileSync(reqFile(), 'utf8').trim() === 'on' ? 'on' : 'off' }; } catch {}
  const out = { state: 'idle', mode: null };
  if (s && typeof s === 'object') {
    if (s.mode === 'on' || s.mode === 'off') out.mode = s.mode;
    if (['running', 'done', 'failed'].includes(s.state)) {
      Object.assign(out, { state: s.state, want: s.want === 'on' ? 'on' : s.want === 'off' ? 'off' : null, by: ['web', 'cli', 'install'].includes(s.by) ? s.by : null,
        started: +s.started * 1000 || null, finished: +s.finished * 1000 || null, error: str(s.error), note: str(s.note) });
      if (out.state === 'running') {
        let gone = false;
        if (Number.isInteger(s.pid) && s.pid > 1) try { process.kill(s.pid, 0); } catch (e) { gone = e.code === 'ESRCH'; }
        if (gone || Date.now() - out.started > STALE) Object.assign(out, { state: 'failed', error: gone ? 'Переключение прервалось (служба mochi-access остановилась)' : 'Переключение зависло' });
      }
      if (out.state === 'failed' && !out.error) out.error = 'Переключить доступ не удалось';
    }
  }
  /* запрос, который служба ещё не взяла, — «в очереди» */
  if (req && !(out.started && out.started >= req.since)) Object.assign(out, { state: 'queued', since: req.since, want: req.want });
  return out;
}

export async function accessInfo(u) {
  const I = await agentInfo(true), st = accessStatus();
  return { root: !!(I.sudo || I.root), user: I.user || 'mochi-agent', mode: st.mode, status: st, ready: accessReady(), admin: !!u.admin };
}

class AccessErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/* on — дать root, off — забрать. Пароль проверяет маршрут (server.js) */
export function requestAccess(on) {
  if (!accessReady()) throw new AccessErr(409, 'Переключать доступ отсюда пока нельзя: на сервере нет службы mochi-access. Выполни там «sudo mochi root ' + (on ? 'on' : 'off') + '» — или один раз «sudo mochi update», и дальше хватит этой кнопки.');
  if (accessStatus().state === 'running') throw new AccessErr(409, 'Доступ уже переключается — подожди пару секунд');
  fs.writeFileSync(reqFile(), (on ? 'on' : 'off') + '\n', { mode: 0o600 });
  return accessStatus();
}
/* передумали, пока служба не взяла запрос */
export function cancelAccess() {
  if (accessStatus().state !== 'queued') throw new AccessErr(409, 'Отменить уже нельзя: доступ переключается');
  try { fs.unlinkSync(reqFile()); } catch {}
  return accessStatus();
}
