/* Обновления Мочи.
   • Что стоит: build.json рядом с кодом — его пишет установщик (репозиторий, ветка, коммит).
   • Что нового: последние коммиты этой ветки на GitHub. Проверяем через 15 с после старта, потом раз в 6 часов
     и по кнопке. С ETag повторная проверка не тратит лимит GitHub (60 запросов в час без ключа).
   • Обновить: сам сервер не может — у него нет прав root. Он кладёт файл-запрос в свои данные, а root-служба
     mochi-update (systemd .path или OpenRC) запускает установщик с --update и пишет ход работы в CFG.updateDir.
     Что и откуда ставить, служба берёт только из своих настроек: из запроса — ничего. */
import fs from 'node:fs';
import path from 'node:path';
import { CFG } from './config.js';
import { readJSON, writeJSONSync } from './store.js';

const EVERY = 6 * 3600e3, RETRY = 30 * 60e3, MANUAL = CFG.dev ? 1000 : 15e3, STALE = 45 * 60e3;
const reqFile = () => path.join(CFG.data, 'update.request');
const cacheFile = () => path.join(CFG.data, 'update.json');

let build = null, cache = { list: [], checked: 0 }, inflight = null, lastTry = 0;

function readBuild() {
  try {
    const b = JSON.parse(fs.readFileSync(CFG.buildFile, 'utf8'));
    if (!/^[\w.-]+\/[\w.-]+$/.test(b.repo) || !/^[\w./-]+$/.test(b.ref || 'HEAD')) return null;
    return { repo: b.repo, ref: b.ref || 'HEAD', commit: /^[0-9a-f]{40}$/.test(b.commit) ? b.commit : '', installed: typeof b.installed === 'string' ? b.installed : null };
  } catch { return null; }
}

/* короткий номер сборки: по нему открытые страницы узнают, что сервер обновился */
export const buildId = () => build?.commit ? build.commit.slice(0, 7) : null;
/* служба обновления установлена (её папку создаёт установщик) */
export const updaterReady = () => !!CFG.updateDir && fs.existsSync(CFG.updateDir);

/* заголовок изменения: первая строка коммита. У слияния PR первая строка — «Merge pull request #N…»,
   а название PR — в теле: берём его. Слияния без названия («Merge branch…») пропускаем */
function title(msg, merge) {
  const lines = String(msg || '').trim().split('\n').map(s => s.trim());
  const t = merge ? lines.slice(1).find(Boolean) : lines[0];
  return t ? t.slice(0, 160) : null;
}

/* GET с ETag: если с прошлого раза ничего не изменилось, GitHub отвечает 304 и не засчитывает запрос в лимит */
async function get(url, accept) {
  const h = { accept, 'user-agent': 'mochi-server' };
  if (cache.etag && cache.url === url && cache.list.length) h['if-none-match'] = cache.etag;
  try { return await fetch(url, { headers: h, signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw Object.assign(new Error('нет связи с GitHub (' + (e.cause?.code || e.name || e.message) + ')'), { fallback: true }); }
}
const done = (url, r, list) => ({ url, etag: r.headers.get('etag') || null, list });

/* откуда смотрим: API GitHub и запасная лента коммитов */
const apiUrl = b => `${CFG.updateApi}/repos/${b.repo}/commits?per_page=30` + (b.ref === 'HEAD' ? '' : '&sha=' + encodeURIComponent(b.ref));
const feedUrl = b => `${CFG.updateWeb}/${b.repo}/commits${b.ref === 'HEAD' ? '' : '/' + b.ref.split('/').map(encodeURIComponent).join('/')}.atom`;

/* API GitHub: 30 последних коммитов ветки */
async function viaApi(b) {
  const url = apiUrl(b);
  const r = await get(url, 'application/vnd.github+json');
  if (r.status === 304) return null;
  if (!r.ok) {
    const reset = +r.headers.get('x-ratelimit-reset');
    if (r.status === 429 || (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0'))
      throw Object.assign(new Error('GitHub ограничил число проверок' + (reset ? ' до ' + new Date(reset * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '') + ' — попробую позже'), { fallback: true });
    if (r.status === 404) throw new Error(`на GitHub нет ${b.repo}` + (b.ref === 'HEAD' ? '' : ` (ветка ${b.ref})`));
    throw Object.assign(new Error('GitHub ответил HTTP ' + r.status), { fallback: true });
  }
  const arr = await r.json().catch(() => null);
  if (!Array.isArray(arr)) throw Object.assign(new Error('GitHub ответил не списком изменений'), { fallback: true });
  return done(url, r, arr.filter(c => c && /^[0-9a-f]{40}$/.test(c.sha)).map(c => {
    const merge = (c.parents?.length || 0) > 1;
    return { sha: c.sha, merge, title: title(c.commit?.message, merge), date: c.commit?.committer?.date || c.commit?.author?.date || null };
  }));
}

/* запасной путь — лента коммитов github.com/…/commits.atom (20 последних): у неё нет лимита API в 60 запросов в час,
   который легко исчерпать с общего IP хостинга */
const unesc = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
async function viaFeed(b) {
  const url = feedUrl(b);
  const r = await get(url, 'application/atom+xml');
  if (r.status === 304) return null;
  if (!r.ok) throw new Error('лента коммитов: HTTP ' + r.status);
  const list = [...(await r.text()).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const sha = (e.match(/Grit::Commit\/([0-9a-f]{40})</) || [])[1];
    const head = unesc((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1]).trim();
    /* сообщение коммита: <pre>…</pre>, экранированное дважды (в XML и в HTML) */
    const msg = unesc(unesc((e.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1]).replace(/<[^>]*>/g, ''));
    const merge = /^Merge (pull request|branch|remote-tracking branch)\b/.test(head);
    /* <title> GitHub обрезает на ~70 символах — берём строку из полного сообщения */
    return sha && { sha, merge, title: title(msg, merge) || (merge ? null : head.slice(0, 160) || null), date: (e.match(/<updated>([^<]+)<\/updated>/) || [])[1] || null };
  }).filter(Boolean);
  if (!list.length) throw new Error('лента коммитов пустая');
  return done(url, r, list);
}

async function check() {
  let got;
  try { got = await viaApi(build); }
  catch (e) { if (!e.fallback) throw e; try { got = await viaFeed(build); } catch { throw e; } }
  if (got) Object.assign(cache, got);
}

/* проверить сейчас (вызовы подряд — одна проверка; по кнопке — не чаще раза в 15 секунд) */
export function refresh(manual) {
  if (!build) return Promise.resolve(summary());
  if (inflight) return inflight;
  if (manual && Date.now() - lastTry < MANUAL) return Promise.resolve(summary());
  lastTry = Date.now();
  inflight = check()
    .then(() => { cache.checked = Date.now(); cache.error = null; })
    .catch(e => { cache.error = e.message; cache.errorAt = Date.now(); })
    .then(() => { try { writeJSONSync(cacheFile(), cache); } catch {} inflight = null; return summary(); });
  return inflight;
}

/* что стоит и что нового — из последнего ответа GitHub */
export function summary() {
  const b = build, list = cache.list || [], cur = b?.commit || '';
  const latest = list[0] || null, i = cur ? list.findIndex(c => c.sha === cur) : -1;
  /* стоит версия новее последней проверки (только что обновились) — список устарел, ждём новой проверки */
  const stale = i < 0 && !!b?.installed && Date.parse(b.installed) > (cache.checked || 0);
  /* available: true — есть новее, false — стоит последняя, null — не знаем (не проверяли или неизвестно, что стоит) */
  const available = latest && cur && !stale ? latest.sha !== cur : null;
  /* повторы убираем: название PR совпадает с его коммитом, а уже установленное — не новое */
  const seen = new Set(i >= 0 ? list.slice(i).map(c => c.title) : []), changes = [];
  if (available) for (const c of i >= 0 ? list.slice(0, i) : list) {
    if (!c.title || seen.has(c.title)) continue;
    seen.add(c.title); changes.push({ commit: c.sha.slice(0, 7), title: c.title, date: c.date });
  }
  return {
    known: !!b, repo: b?.repo || null, ref: b?.ref || null,
    current: { commit: cur.slice(0, 7) || null, date: i >= 0 ? list[i].date : null, installed: b?.installed || null },
    latest: latest ? { commit: latest.sha.slice(0, 7), date: latest.date, title: latest.title } : null,
    available, changes: changes.slice(0, 15), more: available ? (i < 0 || changes.length > 15) : false,
    checked: cache.checked || null, error: cache.error || null,
  };
}

/* ход обновления: status.json и steps.log пишет root-служба; запрос, который она ещё не взяла, — «в очереди» */
export function updateStatus() {
  const dir = CFG.updateDir;
  let s = null, req = null;
  if (dir) try { s = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')); } catch {}
  try { req = fs.statSync(reqFile()).mtimeMs; } catch {}
  const out = { state: 'idle', steps: [] };
  if (s && typeof s === 'object' && ['running', 'done', 'failed'].includes(s.state)) {
    Object.assign(out, { state: s.state, by: s.by === 'cli' ? 'cli' : 'web', started: +s.started * 1000 || null, finished: +s.finished * 1000 || null,
      code: Number.isInteger(s.code) ? s.code : null, from: String(s.from || '').slice(0, 7) || null, to: String(s.to || '').slice(0, 7) || null });
    if (out.state === 'running') {
      let gone = false;
      if (Number.isInteger(s.pid) && s.pid > 1) try { process.kill(s.pid, 0); } catch (e) { gone = e.code === 'ESRCH'; }
      if (gone || Date.now() - out.started > STALE) Object.assign(out, { state: 'failed', error: gone ? 'Обновление прервалось (служба обновления остановилась)' : 'Обновление зависло' });
    }
  }
  if (req !== null && !(out.started && out.started >= req)) Object.assign(out, { state: 'queued', since: req });
  if (dir && out.state !== 'idle' && out.state !== 'queued') {
    try {
      const f = path.join(dir, 'steps.log'), st = fs.statSync(f), fd = fs.openSync(f, 'r');
      try {
        const n = Math.min(st.size, 32768), buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, st.size - n);
        const kind = { '🐾': 'run', '✔': 'ok', '!': 'warn', '✘': 'err' };
        out.steps = buf.toString('utf8').split('\n').map(l => { const m = l.match(/^(🐾|✔|!|✘)\s*(.*)$/u); return m && m[2] ? { k: kind[m[1]], t: m[2].slice(0, 300) } : null; }).filter(Boolean).slice(-40);
      } finally { fs.closeSync(fd); }
    } catch {}
  }
  if (out.state === 'failed' && !out.error) out.error = out.steps.find(x => x.k === 'err')?.t || 'Обновление не удалось' + (out.code ? ' (код ' + out.code + ')' : '');
  return out;
}

class UpdErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/* «Обновить» в браузере: кладём запрос — его заберёт root-служба */
export function requestUpdate(u) {
  if (!updaterReady()) throw new UpdErr(409, 'Обновлять из браузера пока нельзя: на сервере нет службы обновления. Один раз выполни там «sudo mochi update» — дальше можно будет отсюда.');
  const st = updateStatus();
  if (st.state === 'running') throw new UpdErr(409, 'Обновление уже идёт');
  if (st.state === 'queued' && Date.now() - st.since < 120e3) return st;
  fs.writeFileSync(reqFile(), JSON.stringify({ by: u.name, t: Date.now() }) + '\n', { mode: 0o600 });
  return updateStatus();
}
/* передумали, пока служба не взяла запрос */
export function cancelUpdate() {
  if (updateStatus().state !== 'queued') throw new UpdErr(409, 'Отменить уже нельзя: обновление идёт');
  try { fs.unlinkSync(reqFile()); } catch {}
  return updateStatus();
}

export function initUpdates() {
  build = readBuild();
  cache = readJSON(cacheFile(), { list: [], checked: 0 });
  if (!Array.isArray(cache.list)) cache.list = [];
  if (!build) return;
  /* сменили репозиторий или ветку — старый список не про нас */
  if (cache.url && cache.url !== apiUrl(build) && cache.url !== feedUrl(build)) cache = { list: [], checked: 0 };
  const due = () => { const last = Math.max(cache.checked || 0, cache.error ? cache.errorAt || 0 : 0); if (Date.now() - last > (cache.error ? RETRY : EVERY)) refresh(); };
  /* стоит версия, которой нет в списке (только что обновились), — проверяем сразу, иначе через 15 секунд после старта */
  const known = !build.commit || cache.list.some(c => c.sha === build.commit);
  setTimeout(known ? due : () => refresh(), known ? 15000 : 3000).unref();
  setInterval(due, RETRY).unref();
}
