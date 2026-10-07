/* ---------- Мочи · режим сервера ----------
   Страница та же, что и на GitHub Pages, но мозги и Linux — на сервере:
   • вход/регистрация (по приглашению);
   • агент работает на сервере в фоне: чат подписан на поток событий и после возвращения
     показывает и прогресс, и итог;
   • вкладка «Терминал» — настоящий терминал сервера (ttyd за авторизацией);
   • в настройках — вкладка «Сервер»: Telegram, приглашения, пароль, выход.
   Используем функции основного скрипта (add, trayAdd, md, think, ask…), а не дублируем их. */
(() => {
if (typeof SRV === 'undefined' || !SRV) return;
const de = document.documentElement;
de.classList.add('srv');

/* ---------- стили серверного режима ---------- */
const css = document.createElement('style');
css.textContent = `
html.srv .scr.curve{filter:none}
html.srv #term{display:none}
#tty{flex:1;min-height:0;width:100%;border:0;background:var(--tbg);display:block}
.snote{align-self:center;max-width:92%;padding:6px 12px;color:var(--mut);background:var(--card);font:7px/1.6 var(--pf);box-shadow:var(--sh2);text-align:center}
.m.u .tgm{display:inline-block;margin-left:8px;padding:0 5px;background:var(--onacc);color:var(--acc);font:6px/12px var(--pf)}
#auth .sbody{padding:10px 20px 18px}
#auth .ws{margin:14px 4px 0;color:var(--mut);font-size:10px;line-height:1.7}
#auth .aerr{display:block;margin:14px 4px 0;color:var(--err);font-size:10px;line-height:1.6}#auth .aerr:empty{display:none}
#auth .wtitle{margin:14px 0 4px;text-align:center}
#auth .wfoot{justify-content:space-between}
#p-srv .acct{margin:12px 4px 0;font-size:11px;color:var(--fg);text-transform:none}
#p-srv .tgs{display:block;margin:12px 4px 0;font-size:10px;line-height:1.7;color:var(--fg);text-transform:none}
#p-srv .tgs a{color:var(--acc);word-break:break-all}
#p-srv .row2{display:flex;gap:14px;flex-wrap:wrap;margin-top:16px}
#p-srv .row2 .pbtn{flex:1 1 200px;width:auto}
#p-srv .note{display:block;margin-top:18px;font-size:9px;line-height:1.7;color:var(--mut);word-break:break-all}
`;
document.head.append(css);

/* ---------- API ---------- */
async function api(p, o = {}) {
  const h = { ...(o.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.method && o.method !== 'GET' ? { 'x-mochi': '1' } : {}), ...o.headers };
  const r = await fetch(p, { method: o.method || 'GET', headers: h, body: o.json !== undefined ? JSON.stringify(o.json) : o.body, credentials: 'same-origin', cache: 'no-store' });
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw Object.assign(new Error((j && j.error) || 'HTTP ' + r.status), { status: r.status, j });
  return j;
}
const post = (p, json = {}) => api(p, { method: 'POST', json });

let me = null, es = null, running = false, srvSet = null, bubble = null, hideT = 0, connected = false, replaying = false;
const ents = new Map();
const isImgN = n => /\.(png|jpe?g|gif|webp)$/i.test(n || '');
const READY = 'готово · сервер';

/* ---------- экран входа ---------- */
const auth = document.createElement('dialog');
auth.id = 'auth'; auth.className = 'win'; auth.setAttribute('aria-labelledby', 'auth-t');
auth.innerHTML = `<div class="wbar"><span></span><b id="auth-t">Вход</b><span></span></div>
<div class="stabs" role="tablist"><button role="tab" data-m="login" class="on">Вход</button><button role="tab" data-m="reg">Регистрация</button></div>
<div class="sbody"><div class="wtitle" aria-hidden="true">МОЧИ</div><p class="ws" id="auth-w"></p>
<label class="f">Имя<input id="a-name" autocapitalize="off" autocomplete="username" spellcheck="false" maxlength="32"></label>
<label class="f">Пароль<input id="a-pw" type="password" autocomplete="current-password" maxlength="256"></label>
<label class="f" id="a-pw2f" hidden>Пароль ещё раз<input id="a-pw2" type="password" autocomplete="new-password" maxlength="256"></label>
<label class="f" id="a-invf" hidden>Код приглашения<input id="a-inv" autocapitalize="off" autocomplete="one-time-code" spellcheck="false" placeholder="xxxx-xxxx-xxxx" maxlength="40"></label>
<small class="aerr" id="a-err" role="alert"></small></div>
<div class="wfoot"><span></span><button class="p" id="a-go" type="button">Войти</button></div>`;
document.body.append(auth);
auth.addEventListener('cancel', e => e.preventDefault()); /* без входа дальше нельзя */
let mode = 'login', authInfo = {};
const inviteFromUrl = new URLSearchParams(location.search).get('invite') || '';
function authMode(m) {
  mode = m;
  auth.querySelectorAll('.stabs button').forEach(b => { const on = b.dataset.m === m; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  const reg = m === 'reg';
  $('#auth-t').textContent = reg ? 'Регистрация' : 'Вход';
  $('#a-go').textContent = reg ? 'Создать' : 'Войти';
  $('#a-pw2f').hidden = !reg; $('#a-invf').hidden = !reg || authInfo.invite === false;
  $('#a-pw').autocomplete = reg ? 'new-password' : 'current-password';
  $('#auth-w').textContent = reg
    ? (authInfo.setup ? 'Первый вход на этот сервер! Придумай имя и пароль — ты станешь администратором. Код приглашения напечатал установщик.' : 'Нужен код приглашения от администратора сервера.')
    : 'Мочи живёт на этом сервере и работает, даже когда браузер закрыт. Войди, чтобы продолжить.';
  $('#a-err').textContent = '';
}
auth.querySelectorAll('.stabs button').forEach(b => b.onclick = () => authMode(b.dataset.m));
async function doAuth() {
  const name = $('#a-name').value.trim(), password = $('#a-pw').value, err = $('#a-err');
  err.textContent = '';
  if (!name || !password) { err.textContent = 'Введи имя и пароль'; return; }
  if (mode === 'reg' && password !== $('#a-pw2').value) { err.textContent = 'Пароли не совпадают'; return; }
  $('#a-go').disabled = true;
  try {
    const r = mode === 'reg' ? await post('api/register', { name, password, invite: $('#a-inv').value.trim() }) : await post('api/login', { name, password });
    me = r.user; $('#a-pw').value = $('#a-pw2').value = '';
    if (inviteFromUrl) history.replaceState(null, '', location.pathname);
    auth.close(); started();
  } catch (e) { err.textContent = e.message; window.sfx && sfx('err'); }
  finally { $('#a-go').disabled = false; }
}
$('#a-go').onclick = doAuth;
auth.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); doAuth(); } });
function showAuth(info) {
  authInfo = info || {};
  if (es) { es.close(); es = null; }
  if (inviteFromUrl) $('#a-inv').value = inviteFromUrl;
  authMode(authInfo.setup || inviteFromUrl ? 'reg' : 'login');
  setSt('нужен вход', 'on');
  window.petSet && petSet('wave', authInfo.setup ? 'Привет! Давай познакомимся~' : 'Кто там? Войди, пожалуйста ^_^', 4000);
  if (!auth.open) auth.showModal();
  setTimeout(() => (authInfo.setup || inviteFromUrl ? $('#a-name') : $('#a-name').value ? $('#a-pw') : $('#a-name')).focus(), 50);
}

/* ---------- отрисовка журнала ---------- */
let curT = null;
/* разделитель дня — по времени сообщения, а не по «сейчас» */
dayMark = function (box) {
  const d = curT ? new Date(curT) : new Date(), k = d.toDateString(), all = box.querySelectorAll('.day'), last = all[all.length - 1];
  if (last && last.dataset.d === k) return;
  const dd = document.createElement('div'); dd.className = 'day'; dd.dataset.d = k; dd.innerHTML = '<span></span>';
  dd.firstChild.textContent = (k === new Date().toDateString() ? 'Сегодня, ' : '') + d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  box.append(dd);
};
const stamp = (el, e) => { const t = el && el.querySelector('.mh time'); if (t && e.t) t.textContent = new Date(e.t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); };
const btns = '<div class="mf"><button class="cp" data-k="a"><i class="pi"></i>копировать</button><button class="cp" data-k="s"><i class="pi"></i>вслух</button></div>';
function aText(el, text) { el._raw = text; el._b.innerHTML = md(text) + (text ? btns : ''); }

function fileCardS(e) {
  think(false); const box = $('#msgs'); dayMark(box);
  const url = 'api/files/' + e.fid, el = document.createElement('div'); el.className = 'fc';
  if (isImgN(e.name)) { const im = document.createElement('img'); im.src = url; im.alt = e.name; im.loading = 'lazy'; el.append(im); }
  const fr = document.createElement('div'), ic = document.createElement('i'), fi = document.createElement('div'), a = document.createElement('span'), s = document.createElement('small');
  fr.className = 'fr'; ic.className = 'pi'; fi.className = 'fi'; a.className = 'fn'; a.textContent = e.name;
  s.textContent = sz(e.size) + (e.note ? ' · ' + String(e.note).slice(0, 120) : ''); fi.append(a, s); fr.append(ic, fi);
  const fb = document.createElement('div'), b = document.createElement('button'); fb.className = 'fb'; b.textContent = 'Скачать';
  b.onclick = () => { const l = document.createElement('a'); l.href = url + '?dl=1'; l.download = e.name; document.body.append(l); l.click(); l.remove(); };
  fb.append(b);
  if (navigator.canShare) {
    const c = document.createElement('button'); c.className = 's'; c.textContent = 'Поделиться';
    c.onclick = async () => { try { const bl = await (await fetch(url)).blob(), f = new File([bl], e.name, { type: bl.type }); if (navigator.canShare({ files: [f] })) await navigator.share({ files: [f] }); } catch (x) {} };
    fb.append(c);
  }
  el.append(fr, fb); box.append(el); pin();
  if (!replaying && !$('#v-chat').classList.contains('on')) { unread++; badge(); }
}
function note(text) {
  const box = $('#msgs'); box.querySelector('.empty')?.remove();
  const d = document.createElement('div'); d.className = 'snote'; d.textContent = text; box.append(d); pin();
}
function errBox(e) {
  return esc(e.text || 'ошибка') + (e.detail ? '<small class="ed">' + esc(String(e.detail).slice(0, 220)) + '</small>' : '')
    + (e.retry ? '<div class="ea"><button class="pbtn sm" data-act="sretry"><i class="pi"></i><span>Повторить</span></button><button class="pbtn sm" data-act="set"><i class="pi"></i><span>Настройки</span></button></div>' : '');
}

function render(e) {
  curT = e.t;
  switch (e.kind) {
    case 'user': {
      tray = null; bubble = null;
      const d = add('u', esc(e.text || '') + (e.origin === 'tg' ? '<span class="tgm">TG</span>' : '') + (e.files || []).map(f => '<div class="uf">' + (f.fid && isImgN(f.name) ? '<img src="api/files/' + f.fid + '" alt="" loading="lazy">' : '') + '+ ' + esc(f.name) + ' <small>' + sz(f.size) + '</small></div>').join(''));
      stamp(d, e); break;
    }
    case 'assistant': {
      const el = bubble || add('a', ''); bubble = null;
      aText(el, e.text || ''); stamp(el, e); pin();
      if (!replaying) { window.mochiSpeak && mochiSpeak(e.text); window.sfx && sfx('recv'); }
      break;
    }
    case 'tool': {
      let h = ents.get(e.seq);
      if (!h) { h = trayAdd(e.label, e.hint, e.name); ents.set(e.seq, h); }
      if (e.state !== 'run') { h.done(e.state === 'ok'); if (running && !replaying) think(true); }
      break;
    }
    case 'file': fileCardS(e); break;
    case 'error': stamp(add('e', errBox(e)), e); break;
    case 'note': note(e.text); break;
  }
  curT = null;
}

/* на время перерисовки истории — без звуков, счётчиков и озвучки */
function quietly(fn) {
  replaying = true; const sfxOn = cfg.sfx, u0 = unread; cfg.sfx = false;
  try { fn(); } finally { replaying = false; unread = u0; badge(); setTimeout(() => { cfg.sfx = sfxOn; }, 0); }
}
function welcomeS(cleared) {
  const k = cfg.key, b = cfg.base;
  cfg.key = srvSet && srvSet.hasKey ? 'x' : ''; cfg.base = DEF.base;
  try { welcome(cleared); } finally { cfg.key = k; cfg.base = b; }
}
function onSnap(s) {
  if (s.user) me = s.user;
  quietly(() => {
    const box = $('#msgs'); box.innerHTML = ''; tray = null; bubble = null; ents.clear(); think(false);
    for (const e of s.log) render(e);
    if (s.partial) { bubble = add('a', ''); aText(bubble, s.partial); }
    if (!s.log.length) welcomeS(s.seq > 0);
    pin(true);
  });
  setRun(s);
  if (!connected) { connected = true; setSt(READY, 'on'); }
}
function onLog(e) {
  if (ents.has(e.seq)) { render(e); return; }
  render(e);
}
function onDelta(d) {
  think(false);
  if (!bubble) { bubble = add('a', ''); bubble._raw = ''; }
  bubble._raw += d; bubble._b.innerHTML = md(bubble._raw); pin();
}
function setRun(r) {
  const was = running; running = !!r.running;
  ctl = running ? { abort: () => post('api/chat/stop').catch(() => {}) } : null;
  sendUI(running);
  if (running && !bubble) { const last = $('#msgs').lastElementChild; if (!last || !last.classList.contains('tray') || !last.querySelector('.th.s-run')) think(true); }
  if (!running) { think(false); stopTray(); if (was) setSt(READY, 'on'); }
}

/* ---------- поток событий ---------- */
function connect() {
  if (es || !me) return;
  es = new EventSource('api/stream');
  es.addEventListener('snap', e => onSnap(JSON.parse(e.data)));
  es.addEventListener('log', e => onLog(JSON.parse(e.data)));
  es.addEventListener('delta', e => onDelta(JSON.parse(e.data).d));
  es.addEventListener('run', e => setRun(JSON.parse(e.data)));
  es.onopen = () => { if (connected) setSt(READY, 'on'); };
  es.onerror = async () => {
    if (!es) return;
    if (connected) { connected = false; setSt('нет связи с сервером', 'err'); }
    if (es.readyState === 2) { es.close(); es = null; await check(); if (me) setTimeout(connect, 3000); }
  };
}
/* вкладка в фоне — отключаемся: сервер поймёт, что ты «отошёл», и пришлёт итог в Telegram */
document.addEventListener('visibilitychange', () => {
  clearTimeout(hideT);
  if (document.hidden) hideT = setTimeout(() => { if (es) { es.close(); es = null; connected = false; } }, 20000);
  else if (me && !es) connect();
});

async function check() {
  try { const r = await api('api/me'); me = r.user; return true; }
  catch (e) { if (e.status === 401) { me = null; showAuth(e.j); } return false; }
}
async function started() {
  try { srvSet = await api('api/settings'); mirror(); } catch (e) {}
  connect();
  initPane();
}
function mirror() {
  if (!srvSet) return;
  Object.assign(cfg, { base: srvSet.base, model: srvSet.model, sys: srvSet.sys, search: srvSet.search, vis: srvSet.vis, key: '' });
}

/* ---------- отправка ---------- */
window.srvSubmit = async () => {
  if (running) { ctl && ctl.abort(); return; }
  if (upBusy) return;
  const i = $('#inp'), t = i.value.trim(), fs = staged.slice();
  if (!t && !fs.length) return;
  const files = []; let parts = [];
  if (fs.length) {
    upBusy = true; $('#send').disabled = true;
    try {
      if (!srvSet || srvSet.vis !== false) parts = (await Promise.all(fs.map(toPart))).filter(Boolean);
      for (const [k, f] of fs.entries()) {
        setSt('загружаю файлы ' + (k + 1) + '/' + fs.length + '…', 'on');
        files.push(await api('api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f, headers: { 'content-type': 'application/octet-stream' } }));
      }
    } catch (e) { add('e', esc('Файлы не загружены: ' + e.message)); setSt(READY, 'on'); return; }
    finally { upBusy = false; $('#send').disabled = false; }
    setSt(READY, 'on');
    for (const f of fs) { const k = staged.indexOf(f); if (k >= 0) staged.splice(k, 1); }
    renderChips();
  }
  if (i.value.trim() === t) { i.value = ''; i.style.height = ''; }
  lastSent = t;
  try { await post('api/chat', { text: t, files, parts }); }
  catch (e) {
    if (e.status === 401) return check();
    add('e', esc(e.message)); if (!i.value) i.value = t;
  }
};
/* «Повторить» после ошибки — на сервере (перехватываем раньше обработчика браузерного режима) */
$('#msgs').addEventListener('click', e => {
  const b = e.target.closest('[data-act=sretry]'); if (!b) return;
  e.stopImmediatePropagation(); b.closest('.ea')?.remove();
  post('api/chat/retry').catch(x => add('e', esc(x.message)));
}, true);
$('#clr').onclick = async () => {
  if (!await ask('Очистить чат', 'Вся переписка исчезнет, а Мочи забудет разговор. Файлы на сервере останутся.', null, 'Очистить')) return;
  staged.length = 0; renderChips();
  post('api/chat/clear').catch(e => add('e', esc(e.message)));
};

/* ---------- настройки: модель хранится на сервере, ключ наружу не отдаётся ---------- */
let clearKey = false;
const openSet0 = openSet;
openSet = function (p) {
  clearKey = false;
  (async () => {
    try { srvSet = await api('api/settings'); mirror(); } catch (e) { if (e.status === 401) return check(); }
    openSet0(p || (srvSet && srvSet.hasKey ? 'me' : 'ai'));
    $('#c-key').value = '';
    $('#c-key').placeholder = srvSet && srvSet.hasKey ? 'сохранён на сервере · пусто = не менять' : 'sk-…';
    refreshPane();
  })();
};
$('#c-reset').onclick = async () => {
  if (!await ask('Сброс', 'Вернуть настройки как было с завода? Ключ API тоже сотрётся. Применится после «Сохранить».', null, 'Сбросить')) return;
  fill(DEF); $('#c-sys').value = ''; $('#c-key').placeholder = 'sk-…'; clearKey = true;
};
$('#c-save').onclick = async () => {
  cfg.tts = $('#c-tts').checked; cfg.sfx = $('#c-sfx').checked; cfg.vlang = $('#c-vlang').value;
  if (!cfg.tts && window.mochiStop) mochiStop();
  const body = { base: $('#c-base').value.trim(), model: $('#c-model').value.trim(), sys: $('#c-sys').value.trim(), search: $('#c-search').checked, vis: $('#c-vis').checked };
  const k = $('#c-key').value.trim();
  if (k) body.key = k; else if (clearKey) body.clearKey = true;
  try {
    srvSet = await api('api/settings', { method: 'PUT', json: body }); mirror(); save();
    $('#dlg').close();
    const w = $('#msgs .empty'); if (w && !w.dataset.cleared) { w.remove(); welcomeS(); }
  } catch (e) { stab('ai'); const h = $('#mh'); h.textContent = 'Не сохранилось: ' + e.message; h.dataset.s = 'err'; }
};
loadModels = async function () {
  const base = $('#c-base').value.trim().replace(/\/+$/, ''), key = $('#c-key').value.trim(), h = $('#mh'), t = ++mt;
  if (!base) { h.textContent = ''; delete h.dataset.s; return; }
  h.textContent = 'Сервер проверяет связь с моделью…'; h.dataset.s = 'wait';
  try {
    const ids = (await post('api/models', { base, key })).models; if (t !== mt) return;
    const f = ids.filter(x => !/embed|whisper|tts|dall-e|moderation|image|audio|realtime|transcribe/i.test(x));
    mdl = [...new Set(f.length ? f : ids)].sort();
    h.textContent = mdl.length ? 'Связь есть, моделей: ' + mdl.length + '. нажми на поле, чтобы выбрать' : 'Связь есть'; h.dataset.s = 'ok';
    const cur = mi().value.trim(); if (mdl.length && (!cur || (cur === DEF.model && !mdl.includes(cur)))) mi().value = mdl[0];
  } catch (e) {
    if (t !== mt) return; mdl = []; h.dataset.s = 'err';
    const u = e.j && e.j.upstream;
    h.textContent = e.status === 401 || e.status === 403 || u === 401 || u === 403 ? 'Ключ не подошёл. Проверь его' : e.message === 'format' ? 'Сервер ответил, но не списком моделей. Модель можно вписать вручную' : 'Список моделей недоступен (' + e.message + '). Впиши модель вручную';
  }
};

/* ---------- вкладка «Сервер» ---------- */
const lxTab = $('#t-lx'), lxPane = $('#p-lx');
lxTab.textContent = 'Сервер';
[...lxPane.children].forEach(x => { x.hidden = true; x.style.display = 'none'; });
const pane = document.createElement('div'); pane.id = 'p-srv';
pane.innerHTML = `<div class="f">Аккаунт<div class="acct" id="s-acct">…</div></div>
<div class="f">Telegram<span class="tgs" id="s-tg">…</span></div>
<label class="f" id="s-tokf">Токен бота от @BotFather<input id="s-tok" type="password" autocomplete="off" spellcheck="false" placeholder="123456789:AA…"></label>
<div class="row2" id="s-tgb"></div>
<div class="f" id="s-ntf" hidden>Уведомления в Telegram<div class="seg" id="s-nt" role="radiogroup"><button type="button" data-v="away">Когда меня нет</button><button type="button" data-v="always">Всегда</button><button type="button" data-v="off">Никогда</button></div></div>
<div class="row2"><button class="pbtn" type="button" id="s-pw"><span>Сменить пароль</span></button><button class="pbtn" type="button" id="s-inv" hidden><span>Пригласить</span></button></div>
<div class="row2"><button class="pbtn" type="button" id="s-out"><span>Выйти</span></button><button class="pbtn" type="button" id="s-outall"><span>Выйти везде</span></button></div>
<small class="note" id="s-note"></small>`;
lxPane.append(pane);
const tgBtn = (txt, fn) => { const b = document.createElement('button'); b.className = 'pbtn'; b.type = 'button'; b.innerHTML = '<span></span>'; b.firstChild.textContent = txt; b.onclick = fn; return b; };
async function refreshPane() {
  try {
    const [a, t] = await Promise.all([api('api/account'), api('api/telegram')]);
    $('#s-acct').textContent = a.user.name + (a.user.admin ? ' · администратор' : '') + ' · сессий: ' + a.sessions;
    $('#s-inv').hidden = !a.user.admin;
    $('#s-note').textContent = 'Рабочая папка на сервере: ' + a.work + (a.users ? ' · пользователей: ' + a.users.length : '');
    const s = $('#s-tg'), bb = $('#s-tgb'); bb.innerHTML = '';
    $('#s-tokf').hidden = t.connected; $('#s-ntf').hidden = !t.connected;
    if (!t.connected) {
      s.textContent = 'Не подключён. Создай бота у @BotFather (/newbot) и вставь токен — или просто попроси Мочи в чате: «подключи Telegram».';
      bb.append(tgBtn('Подключить', async () => {
        try { await post('api/telegram', { token: $('#s-tok').value.trim() }); $('#s-tok').value = ''; refreshPane(); }
        catch (e) { s.textContent = 'Не получилось: ' + e.message; }
      }));
    } else {
      s.innerHTML = '';
      const line = document.createElement('span');
      line.textContent = 'Бот @' + t.bot + (t.linked ? ' · привязан к @' + t.tgUser : ' · ещё не привязан') + (t.error ? ' · ' + t.error : '');
      s.append(line);
      if (!t.linked && t.link) { s.append(document.createElement('br'), 'Открой ссылку и нажми «Старт»: '); const l = document.createElement('a'); l.href = t.link; l.target = '_blank'; l.rel = 'noopener'; l.textContent = t.link; s.append(l); }
      bb.append(tgBtn(t.linked ? 'Привязать заново' : 'Новая ссылка', async () => { await post('api/telegram/link'); refreshPane(); }));
      bb.append(tgBtn('Отключить', async () => {
        if (!await ask('Telegram', 'Отключить бота от Мочи? Управление и уведомления перестанут работать.', null, 'Отключить')) return;
        await api('api/telegram', { method: 'DELETE' }); refreshPane();
      }));
      document.querySelectorAll('#s-nt button').forEach(b => { const on = b.dataset.v === t.notify; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    }
  } catch (e) { if (e.status === 401) check(); }
}
document.querySelectorAll('#s-nt button').forEach(b => b.onclick = async () => { await post('api/telegram/notify', { mode: b.dataset.v }).catch(() => {}); refreshPane(); });
function initPane() { refreshPane(); }
lxTab.addEventListener('click', refreshPane);
const pwAsk = async (title, text) => { const i = $('#ask-i'); i.type = 'password'; try { return await ask(title, text, '', 'Дальше'); } finally { i.type = 'text'; } };
$('#s-pw').onclick = async () => {
  const old = await pwAsk('Пароль', 'Текущий пароль'); if (old == null) return;
  const nw = await pwAsk('Пароль', 'Новый пароль (минимум 8 символов). Все остальные сессии завершатся.'); if (nw == null) return;
  try { await post('api/password', { old, password: nw }); await ask('Пароль', 'Пароль изменён ^_^', null, 'OK'); }
  catch (e) { await ask('Пароль', 'Не получилось: ' + e.message, null, 'OK'); }
};
$('#s-inv').onclick = async () => {
  try {
    const r = await post('api/invite');
    const v = await ask('Приглашение', 'Одноразовая ссылка для регистрации (7 дней). Помни: у каждого пользователя Мочи есть доступ к терминалу сервера — приглашай только тех, кому доверяешь.', r.url, 'Скопировать');
    if (v != null) navigator.clipboard?.writeText(r.url).catch(() => {});
  } catch (e) { await ask('Приглашение', e.message, null, 'OK'); }
};
const logout = async all => {
  if (!await ask('Выход', all ? 'Выйти на всех устройствах? Мочи продолжит работать на сервере.' : 'Выйти? Мочи продолжит работать на сервере.', null, 'Выйти')) return;
  await post('api/logout' + (all ? '?all=1' : '')).catch(() => {});
  $('#dlg').close(); me = null; if (es) { es.close(); es = null; } connected = false;
  $('#msgs').innerHTML = ''; check();
};
$('#s-out').onclick = () => logout(false);
$('#s-outall').onclick = () => logout(true);

/* ---------- терминал: ttyd за авторизацией ---------- */
let tty = null;
function ttyFrame() {
  if (tty) return tty;
  tty = document.createElement('iframe');
  tty.id = 'tty'; tty.title = 'Терминал сервера'; tty.setAttribute('allow', 'clipboard-read; clipboard-write');
  tty.src = 'term/';
  $('#scr').insertBefore(tty, $('#tstat'));
  return tty;
}
const xterm = () => { try { return tty && tty.contentWindow && tty.contentWindow.term; } catch (e) { return null; } };
function tx(s) {
  const t = xterm(); if (!t) return false;
  try {
    if (typeof t.input === 'function') t.input(s, true);
    else if (t._core && t._core.coreService) t._core.coreService.triggerDataEvent(s, true);
    else t.paste(s);
    t.focus && t.focus(); return true;
  } catch (e) { return false; }
}
document.querySelector('nav [data-v=term]').addEventListener('click', () => { ttyFrame(); setTimeout(() => { const t = xterm(); t && t.fit && t.fit(); t && t.focus && t.focus(); }, 80); });
document.querySelectorAll('.keys button[data-k]').forEach(b => b.onclick = () => { tx(keyStr(b.dataset.k)); window.sfx && sfx('key'); });
$('#tcls').onclick = () => { tx('\x0c'); window.sfx && sfx('key'); };
const tfs = d => { cfg.tfs = Math.min(30, Math.max(10, (cfg.tfs || 16) + d)); save(); const t = xterm(); if (t && t.options) { t.options.fontSize = cfg.tfs; t.fit && t.fit(); } };
$('#tfm').onclick = () => tfs(-2); $('#tfp').onclick = () => tfs(2);
$('#tin').placeholder = 'команда и Enter (или печатай прямо в терминале)';
$('#tsend').onclick = () => { const i = $('#tin'); if (tx(i.value + '\r')) i.value = ''; window.sfx && sfx('key'); };
$('#tin').onkeydown = e => {
  const i = e.target;
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (tx(i.value + '\r')) i.value = ''; }
  else if (!i.value && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); tx(e.key === 'ArrowUp' ? '\x1b[A' : '\x1b[B'); }
  else if (e.ctrlKey && !e.altKey && !e.metaKey && /^[cdlz]$/i.test(e.key) && i.selectionStart === i.selectionEnd) { e.preventDefault(); tx(String.fromCharCode(e.key.toLowerCase().charCodeAt(0) - 96)); }
};
tstat = function () {
  const el = $('#tstat'); if (!el) return;
  el.innerHTML = '<span>сервер</span><span></span><span class="sst"></span>';
  el.children[1].textContent = location.host; el.querySelector('.sst').textContent = $('#st').textContent;
};

/* ---------- старт ---------- */
setSt('подключаюсь к серверу…', 'on');
check().then(ok => { if (ok) started(); });
})();
