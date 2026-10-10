/* ---------- Мочи · режим сервера ----------
   Страница та же, что и на GitHub Pages, но мозги и Linux — на сервере:
   • вход/регистрация (по приглашению);
   • агент работает на сервере в фоне: чат подписан на поток событий и после возвращения
     показывает и прогресс, и итог;
   • вкладка «Терминал» — настоящий терминал сервера (ttyd за авторизацией);
   • в настройках — вкладка «Сервер» (Telegram, приглашения, пароль, выход, обновления, доступ агента — root) и «Инструменты» (вкл/выкл, MCP, навыки).
   Используем функции основного скрипта (add, trayAdd, md, think, ask…), а не дублируем их. */
(() => {
if (typeof SRV === 'undefined' || !SRV) return;
const de = document.documentElement;
de.classList.add('srv');
/* экран загрузки (#boot в index.html): страница на месте — дальше шаги «сервер → вход → модель → чат → агент» двигаем отсюда */
const bt = (k, ...a) => { try { window.mochiBoot && mochiBoot[k](...a); } catch (e) {} };
bt('go', 'link');

/* ---------- стили серверного режима ---------- */
const css = document.createElement('style');
css.textContent = `
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
  bt('done', 'auth');
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
  const d = curT ? new Date(curT) : new Date(), k = d.toDateString();
  /* последний разделитель помним: искать его по всей ленте на каждое сообщение — квадратично на длинной истории */
  let last = box._day;
  if (!last || last.parentNode !== box) { const all = box.querySelectorAll('.day'); last = all[all.length - 1]; }
  if (last && last.dataset.d === k) { box._day = last; return; }
  const dd = document.createElement('div'); dd.className = 'day'; dd.dataset.d = k; dd.innerHTML = '<span></span>';
  dd.firstChild.textContent = (k === new Date().toDateString() ? 'Сегодня, ' : '') + d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  box.append(dd); box._day = dd;
};
const HM = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const stamp = (el, e) => { const t = el && el.querySelector('.mh time'); if (t && e.t) t.textContent = HM.format(e.t); };
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

/* на время перерисовки истории — без звуков, счётчиков и озвучки. И без прокрутки вниз после каждого сообщения:
   она заставляет браузер заново раскладывать всю ленту, и 400 записей рисовались секунды. Вниз — один раз в конце */
function quietly(fn) {
  replaying = true; const sfxOn = cfg.sfx, u0 = unread, pin0 = pin; cfg.sfx = false; pin = () => {};
  try { fn(); } finally { pin = pin0; replaying = false; unread = u0; badge(); pin(true); setTimeout(() => { cfg.sfx = sfxOn; }, 0); }
}
function welcomeS(cleared) {
  const k = cfg.key, b = cfg.base;
  cfg.key = srvSet && srvSet.hasKey ? 'x' : ''; cfg.base = DEF.base;
  try { welcome(cleared); } finally { cfg.key = k; cfg.base = b; }
}
function onSnap(s) {
  if (s.user) me = s.user;
  seenBuild(s.build);
  quietly(() => {
    const box = $('#msgs'); box.innerHTML = ''; tray = null; bubble = null; ents.clear(); think(false);
    for (const e of s.log) render(e);
    if (s.partial) { bubble = add('a', ''); aText(bubble, s.partial); }
    if (!s.log.length) welcomeS(s.seq > 0);
  });
  setRun(s);
  if (!connected) {
    connected = true; setSt(READY, 'on');
    const n = s.log.filter(e => e.kind === 'user' || e.kind === 'assistant').length;
    bt('ok', 'chat', n ? plural(n, 'сообщение', 'сообщения', 'сообщений') : 'пусто');
    bt('ok', 'agent', s.running ? 'работает' + (s.steps ? ' · шаг ' + s.steps : '') : 'свободна');
    bt('done');
  }
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
    if (!connected) bt('wait', 'chat', 'stream', 3);
    /* во время обновления сервер перезапускается — это не ошибка */
    if (connected) { connected = false; if (uMode === 'run') setSt('обновляюсь…', 'on'); else setSt('нет связи с сервером', 'err'); }
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
  bt('go', 'set');
  try { srvSet = await api('api/settings'); mirror(); bt('ok', 'set', srvSet.hasKey ? srvSet.model : 'нужен ключ'); } catch (e) { bt('ok', 'set', 'не загрузились'); }
  connect();
  initPane();
  updBoot(true);
}
function mirror() {
  if (!srvSet) return;
  Object.assign(cfg, { base: srvSet.base, model: srvSet.model, sys: srvSet.sys, search: srvSet.search, vis: srvSet.vis, stepLimit: srvSet.stepLimit, maxSteps: srvSet.maxSteps, key: '' });
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
  fill(DEF); $('#c-sys').value = ''; $('#c-steps').value = srvSet?.maxStepsDef || DEF.maxSteps; $('#c-key').placeholder = 'sk-…'; clearKey = true;
};
$('#c-save').onclick = async () => {
  const st = readSteps(); if (!st) return;
  cfg.tts = $('#c-tts').checked; cfg.sfx = $('#c-sfx').checked; cfg.vlang = $('#c-vlang').value;
  if (!cfg.tts && window.mochiStop) mochiStop();
  const body = { base: $('#c-base').value.trim(), model: $('#c-model').value.trim(), sys: $('#c-sys').value.trim(), search: $('#c-search').checked, vis: $('#c-vis').checked, ...st };
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
    const { models: ids, free, needKey } = await post('api/models', { base, key }); if (t !== mt) return;
    const f = ids.filter(x => !/embed|whisper|tts|dall-e|moderation|image|audio|realtime|transcribe/i.test(x));
    mdl = [...new Set(f.length ? f : ids)].sort();
    h.textContent = (mdl.length ? 'Связь есть, моделей: ' + mdl.length + '. нажми на поле, чтобы выбрать' : 'Связь есть') + (free ? '. ' + freeNote(free) : ''); h.dataset.s = 'ok';
    /* /models у OpenRouter и Ollama Cloud отвечает и без ключа, а модель без него — нет */
    if (needKey) { h.textContent += '. Вставь API ключ — без него модель не ответит'; delete h.dataset.s; }
    const cur = mi().value.trim(); if (mdl.length && (!cur || (cur === DEF.model && !mdl.includes(cur)) || (provNew && !mdl.includes(cur)) || (free && !isFree(cur)))) mi().value = pickModel(mdl);
    if (mdl.length) provNew = false;
  } catch (e) {
    if (t !== mt) return; mdl = []; h.dataset.s = 'err';
    const u = e.j && e.j.upstream;
    if ((e.status === 401 || e.status === 403 || u === 401 || u === 403) && !key && !(srvSet && srvSet.hasKey && String(srvSet.base || '').replace(/\/+$/, '') === base)) { h.textContent = 'Вставь API ключ — после этого загружу список моделей'; delete h.dataset.s; return; }
    h.textContent = e.status === 401 || e.status === 403 || u === 401 || u === 403 ? 'Ключ не подошёл. Проверь его' : e.message === 'format' ? 'Сервер ответил, но не списком моделей. Модель можно вписать вручную' : /^Это не ключ/.test(e.message) ? e.message : 'Список моделей недоступен (' + e.message + '). Впиши модель вручную';
  }
};

/* ---------- папки в настройках ----------
   Вкладки «Сервер» и «Инструменты» разложены по темам в сворачиваемые папки: при открытии видны только заголовки
   с коротким итогом справа («2 из 3 · ≈400 ток.»), подробности — внутри. Какие папки открыты, помним до перезагрузки. */
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const opened = {};
function fold(key, title, meta, bad) {
  const d = el('details', 'fold'), sm = el('summary'), b = el('div', 'fb');
  d.dataset.k = key; d.open = !!opened[key];
  sm.append(el('span', 'ft', title));
  if (meta) sm.append(el('span', 'fm' + (bad ? ' bad' : ''), meta));
  d.append(sm, b); d.body = b;
  d.addEventListener('toggle', () => { opened[key] = d.open; });
  return d;
}
const foldMeta = (d, text, bad) => { let m = d.querySelector(':scope>summary>.fm'); if (!m) { m = el('span', 'fm'); d.firstChild.append(m); } m.textContent = text; m.classList.toggle('bad', !!bad); };
css.textContent += `
#dlg .stabs{gap:6px;padding:14px 10px 0;overflow-x:auto;scrollbar-width:none}#dlg .stabs::-webkit-scrollbar{display:none}#dlg .stabs button{flex:none;padding-left:8px;padding-right:8px}
#dlg .fold{margin:14px 4px 0;border:0;background:var(--bg);box-shadow:var(--sh2)}
#dlg .fold>summary{padding:13px 12px;gap:10px;align-items:center;color:var(--fg);font:9px/1.4 var(--pf)}
#dlg .fold>summary .ft{flex:1;min-width:0;overflow-wrap:anywhere}
#dlg .fold>summary .fm{flex:none;max-width:52%;text-align:right;color:var(--mut);font:7px/1.5 var(--pf);text-transform:none}
#dlg .fold>summary .fm.bad{color:var(--err)}
#dlg .fold>summary::after{flex:none;content:"+"}#dlg .fold[open]>summary::after{content:"-"}
#dlg .fold[open]>summary{border-bottom:4px dashed var(--line)}
#dlg .fold>.fb{padding:2px 12px 16px}
#dlg .fold .fold{margin:12px 0 0;background:var(--card)}
#dlg .fold .fold .fold{background:var(--bg)}
#dlg .fold .sw{margin-top:14px}
#dlg .fold .f{margin-top:14px}
`;

/* ---------- вкладка «Сервер»: Аккаунт и Telegram ---------- */
const lxTab = $('#t-lx'), lxPane = $('#p-lx');
lxTab.textContent = 'Сервер';
[...lxPane.children].forEach(x => { x.hidden = true; x.style.display = 'none'; });
const pane = document.createElement('div'); pane.id = 'p-srv';
const fAcct = fold('acct', 'Аккаунт'), fTg = fold('tg', 'Telegram');
fAcct.body.innerHTML = `<div class="acct" id="s-acct">…</div>
<div class="row2"><button class="pbtn" type="button" id="s-pw"><span>Сменить пароль</span></button><button class="pbtn" type="button" id="s-inv" hidden><span>Пригласить</span></button></div>
<div class="row2"><button class="pbtn" type="button" id="s-out"><span>Выйти</span></button><button class="pbtn" type="button" id="s-outall"><span>Выйти везде</span></button></div>
<small class="note" id="s-note"></small>`;
fTg.body.innerHTML = `<span class="tgs" id="s-tg">…</span>
<label class="f" id="s-tokf">Токен бота от @BotFather<input id="s-tok" type="password" autocomplete="off" spellcheck="false" placeholder="123456789:AA…"></label>
<div class="row2" id="s-tgb"></div>
<div class="f" id="s-ntf" hidden>Уведомления в Telegram<div class="seg" id="s-nt" role="radiogroup"><button type="button" data-v="away">Когда меня нет</button><button type="button" data-v="always">Всегда</button><button type="button" data-v="off">Никогда</button></div></div>`;
pane.append(fAcct, fTg);
lxPane.append(pane);
const tgBtn = (txt, fn) => { const b = document.createElement('button'); b.className = 'pbtn'; b.type = 'button'; b.innerHTML = '<span></span>'; b.firstChild.textContent = txt; b.onclick = fn; return b; };
async function refreshPane() {
  try {
    const [a, t] = await Promise.all([api('api/account'), api('api/telegram')]);
    api('api/update').then(updState).catch(() => {});
    api('api/access').then(i => { accState(i); if (accBusy(i)) accTick(); }).catch(() => {});
    $('#s-acct').textContent = a.user.name + (a.user.admin ? ' · администратор' : '') + ' · сессий: ' + a.sessions;
    foldMeta(fAcct, a.user.name + (a.user.admin ? ' · админ' : ''));
    $('#s-inv').hidden = !a.user.admin;
    $('#s-note').textContent = 'Рабочая папка на сервере: ' + a.work + (a.users ? ' · пользователей: ' + a.users.length : '');
    const s = $('#s-tg'), bb = $('#s-tgb'); bb.innerHTML = '';
    $('#s-tokf').hidden = t.connected; $('#s-ntf').hidden = !t.connected;
    foldMeta(fTg, !t.connected ? 'не подключён' : t.error ? 'ошибка' : '@' + t.bot + (t.linked ? '' : ' · не привязан'), t.connected && !!t.error);
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

/* ---------- обновления ----------
   Сервер сам смотрит на GitHub, что нового. Если вышла новая версия, администратору при входе
   показывается окошко с Мочи: что изменилось и «Позже» / «Обновить». Обновляет root-служба на сервере
   (server/bin/mochi-update): окошко показывает её шаги, переживает перезапуск сервера и перезагружает страницу.
   Остальные открытые страницы перезагружаются сами, когда видят новую сборку (build в snap). */
css.textContent += `
#upd{max-width:460px}
#upd .ubody{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:18px 20px 20px;font-size:9px;line-height:1.8}
#upd .uhead{display:flex;align-items:center;gap:18px}
#upd canvas{flex:none;width:120px;height:108px;image-rendering:pixelated}
#upd .usay{flex:1;min-width:0;position:relative;margin:4px;padding:10px 12px;background:var(--bg);font-size:10px;line-height:1.7;box-shadow:var(--sh4)}
#upd .usay::before{content:"";position:absolute;left:-8px;top:14px;width:8px;height:8px;background:var(--bg);box-shadow:-4px 0 var(--ink),0 -4px var(--ink),0 4px var(--ink)}
#upd .uver{margin-top:16px;color:var(--mut);font-size:8px;white-space:pre-line}
#upd .uhd{margin-top:14px;color:var(--acc);font-size:8px;text-transform:uppercase}
#upd .uch,#upd .ust{margin:8px 0 0;padding:0;list-style:none}
#upd .uch li,#upd .ust li{position:relative;padding:3px 0 3px 18px;font-size:8px;line-height:1.7;overflow-wrap:anywhere}
#upd .uch li::before{content:"+";position:absolute;left:2px;color:var(--acc)}
#upd .uch li.umore{color:var(--mut)}#upd .uch li.umore::before{content:""}
#upd .ust li{color:var(--mut)}
#upd .ust li::before{position:absolute;left:2px}
#upd .ust li.ok::before{content:"✓";color:var(--ok)}
#upd .ust li.run{color:var(--fg)}#upd .ust li.run::before{content:">";color:var(--acc);animation:blk .6s steps(1) infinite}
#upd .ust li.warn::before{content:"!"}#upd .ust li.past::before{content:"·"}
#upd .ust li.err{color:var(--err)}#upd .ust li.err::before{content:"x";color:var(--err)}
#upd .ubar{height:14px;margin:20px 4px 8px;background:var(--bg);box-shadow:var(--sh4)}
#upd .ubar i{display:block;height:100%;width:0;background:repeating-linear-gradient(90deg,var(--acc) 0 8px,transparent 8px 12px);transition:width .5s steps(10)}
#upd .uerr{display:block;margin-top:14px;color:var(--err);font-size:8px;line-height:1.7;overflow-wrap:anywhere}
#upd .note{margin-top:16px}
#upd .wfoot .p{margin-left:auto}
#upd [hidden],#p-srv [hidden]{display:none!important}
#set{position:relative}
#set.upd::after,#t-lx.upd::after{content:"";position:absolute;top:-6px;right:-6px;width:8px;height:8px;background:var(--acc);box-shadow:0 0 0 2px var(--card);animation:blk 1.2s steps(1) infinite}
#dlg .fold>summary .fm.new{color:var(--acc)}
`;
const upd = document.createElement('dialog');
upd.id = 'upd'; upd.className = 'win ask'; upd.setAttribute('aria-labelledby', 'upd-h');
upd.innerHTML = `<div class="wbar"><span></span><b id="upd-h">Обновление</b><span></span></div>
<div class="ubody"><div class="uhead"><canvas aria-hidden="true"></canvas><p class="usay" id="upd-say" role="status" aria-live="polite"></p></div><div id="upd-m"></div></div>
<div class="wfoot"><button class="lnk" id="upd-no" type="button">Позже</button><button class="p" id="upd-ok" type="button">Обновить</button></div>`;
document.body.append(upd);
/* в окошке — сама Мочи: копируем кадры её холста из верхней панели (там же меняем ей настроение) */
const upc = upd.querySelector('canvas');
function upDraw() {
  if (!upd.open) return;
  const src = $('#pet');
  if (upc.width !== src.width || upc.height !== src.height) { upc.width = src.width; upc.height = src.height; }
  const g = upc.getContext('2d'); g.clearRect(0, 0, upc.width, upc.height); g.drawImage(src, 0, 0);
  requestAnimationFrame(upDraw);
}

const UPH = {
  offer: ['Ура! Вышло обновление!', 'Ура, есть обновление! Обновимся?', 'Смотри, я научилась новому! Обновим?', 'Свеженькая версия приехала!'],
  unknown: ['Не знаю, какая у меня версия… Обновимся до свежей?'],
  fresh: ['У меня самая свежая версия!', 'Обновлений нет — я и так новенькая ^_^'],
  done: ['Готово! Я обновилась ^_^', 'Ура! Я теперь новенькая!', 'Обновилась! Сейчас перезагружусь~'],
  fail: ['Ой… обновиться не получилось', 'Хнык… обновление не вышло'],
};
const upick = a => a[Math.random() * a.length | 0];
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return n + ' ' + (m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c); };
const dday = s => { const d = s ? new Date(s) : null; return d && !isNaN(d) ? d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : ''; };
const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'только что' : m < 60 ? m + ' мин назад' : m < 1440 ? Math.round(m / 60) + ' ч назад' : dday(t); };
const ver = (c, d) => (c && c.commit ? c.commit : 'неизвестно') + ((d || c && c.date) ? ' от ' + dday(d || c.date) : '');
/* доля готовности — по шагам установщика (он печатает их по порядку) */
const UPCT = [[/что нового/, 4], [/Устанавливаю Мочи/, 8], [/системные пакеты/, 12], [/Пакеты на месте/, 26], [/Node\.js/, 38], [/ttyd/, 46], [/Caddy/, 52],
  [/код Мочи/, 58], [/^Код:/, 68], [/Запускаю службы/, 76], [/Сервер Мочи работает/, 88], [/сертификат/, 92], [/HTTPS/, 96]];
const pct = steps => steps.reduce((p, s) => Math.max(p, ...UPCT.filter(([re]) => re.test(s.t)).map(x => x[1])), 3);
/* «Позже» — не напоминать об этой версии сутки */
const LATER = 'mochi-upd-later';
const snoozed = c => { try { const v = JSON.parse(localStorage.getItem(LATER) || 'null'); return !!v && v.c === c && Date.now() < v.t; } catch (e) { return false; } };
const snooze = c => { try { localStorage.setItem(LATER, JSON.stringify({ c, t: Date.now() + 864e5 })); } catch (e) {} };

let updI = null, uMode = '', uSince = 0, uPoll = 0, uLastOk = 0, uLast = null, uOdd = 0, updAt = 0, build0 = null, reloadT = 0;
const uSay = (t, mood, ms) => { $('#upd-say').textContent = t; window.petSet && petSet(mood, t, ms || 0); };
function uBtns(no, ok) {
  const n = $('#upd-no'), o = $('#upd-ok');
  n.hidden = !no; o.hidden = !ok;
  if (no) { n.textContent = no[0]; n.onclick = no[1]; }
  if (ok) { o.textContent = ok[0]; o.onclick = ok[1]; o.disabled = !ok[1]; }
}
const unote = (m, t) => m.append(el('small', 'note', t));

/* предложение обновиться: что стоит, что нового */
function uOffer(i) {
  uMode = 'offer';
  const m = $('#upd-m'), ch = i.changes || [];
  m.innerHTML = '';
  m.append(el('p', 'uver', 'Сейчас: ' + ver(i.current, i.current && (i.current.date || i.current.installed)) + (i.latest && i.available !== false ? '\nНовая: ' + ver(i.latest) : '')));
  if (ch.length) {
    m.append(el('p', 'uhd', 'Что нового'));
    const ul = el('ul', 'uch');
    for (const c of ch.slice(0, 8)) ul.append(el('li', null, c.title));
    if (ch.length > 8 || i.more) ul.append(el('li', 'umore', i.more ? 'и ещё много всего…' : 'и ещё ' + plural(ch.length - 8, 'изменение', 'изменения', 'изменений')));
    m.append(ul);
  }
  const can = i.admin && i.ready && i.available !== false;
  if (!i.admin) unote(m, 'Обновить Мочи может администратор сервера.');
  else if (!i.ready) unote(m, 'Чтобы обновлять прямо отсюда, один раз выполни на сервере «sudo mochi update» — эта команда поставит службу обновления. Дальше хватит кнопки.');
  else if (can) unote(m, 'Сервер перезапустится примерно на минуту. Переписка, настройки и файлы сохранятся' + (i.busy ? ', а начатые задачи продолжатся сами.' : '.'));
  uSay(i.available === false ? upick(UPH.fresh) : i.available ? upick(UPH.offer) : upick(UPH.unknown), i.available === false ? 'happy' : 'wow', 2500);
  uBtns([can ? 'Позже' : 'Закрыть', () => { if (can && i.latest) snooze(i.latest.commit); upd.close(); }], can ? ['Обновить', uGo] : null);
}
async function uGo() {
  $('#upd-ok').disabled = true;
  try { const i = await post('api/update'); updState(i); uSince = i.status.since || i.status.started || 0; uOdd = 0; uRun(i.status); uTick(); }
  catch (e) { uFail({ error: e.message, steps: [] }); }
}
/* ход обновления; down — сервер не отвечает (перезапускается) */
function uRun(st, down) {
  uMode = 'run'; uLast = st;
  const m = $('#upd-m');
  if (!m.querySelector('.ust')) m.innerHTML = '<div class="ubar"><i></i></div><ul class="ust"></ul>';
  const steps = st.steps || [], last = steps.filter(s => s.k === 'run' || s.k === 'ok').at(-1);
  m.querySelector('.ubar i').style.width = (st.state === 'queued' ? 3 : pct(steps)) + '%';
  const ul = m.querySelector('.ust'); ul.innerHTML = '';
  /* «🐾 делаю…» мигает, только пока это последний шаг; пройденные — точкой */
  steps.slice(-6).forEach((s, k, a) => ul.append(el('li', s.k === 'run' && (k < a.length - 1 || st.state !== 'running') ? 'past' : s.k, s.t)));
  m.querySelector('.note')?.remove();
  const stuck = st.state === 'queued' && Date.now() - st.since > 60e3;
  if (stuck) unote(m, 'Служба обновления на сервере пока не отвечает. Проверь её: «systemctl status mochi-update.path» (на Alpine — «rc-service mochi-updater status»). Обновить можно и командой «sudo mochi update».');
  uSay(down ? 'Сервер перезапускается… сейчас вернусь!' : st.state === 'queued' ? 'Передаю просьбу серверу…' : last ? last.t : 'Обновляюсь…', 'work');
  uBtns(stuck ? ['Отменить', async () => { try { updState(await api('api/update', { method: 'DELETE' })); clearTimeout(uPoll); uMode = ''; upd.close(); } catch (e) {} }] : ['Скрыть', () => upd.close()], ['Обновляю…', null]);
}
function uTick() {
  clearTimeout(uPoll);
  uPoll = setTimeout(async () => {
    let i = null;
    try { i = await api('api/update'); uLastOk = Date.now(); }
    catch (e) { if (e.status === 401) { uMode = ''; upd.close(); return check(); } }
    if (!i) {
      if (Date.now() - uLastOk > 10 * 60e3) return uFail({ error: 'Сервер не отвечает уже 10 минут. Загляни на сервер: «mochi status» и «mochi logs».', steps: uLast ? uLast.steps : [] });
      if (uMode === 'run' && upd.open) uRun(uLast || { state: 'running', steps: [] }, true);
      return uTick();
    }
    updState(i);
    const st = i.status, ours = st.started && st.started + 2000 >= uSince;
    if (st.state === 'done' && ours) return uDone(st);
    if (st.state === 'failed' && ours) return uFail(st);
    /* ни нашего запроса, ни нашего обновления: дадим службе 15 секунд — вдруг она как раз забирает запрос */
    if (st.state === 'idle' || !ours && st.state !== 'queued') {
      if (!uOdd) uOdd = Date.now();
      else if (Date.now() - uOdd > 15e3) return uFail({ error: 'Запрос на обновление пропал — попробуй ещё раз.', steps: [] });
      return uTick();
    }
    uOdd = 0;
    if (upd.open) uRun(st);
    uTick();
  }, 1500);
}
function uDone(st) {
  uMode = 'done';
  /* страница уже с новой версией (перезагрузилась, пока сервер доделывал) — перезагружать незачем */
  const fresh = !!(build0 && st.to && build0 === st.to);
  if (!upd.open) { if (!fresh) reloadSoon(); return; }
  uRun(st); uMode = 'done';
  $('#upd-m .ubar i').style.width = '100%';
  uSay(fresh ? UPH.done[0] : upick(UPH.done), 'love', 3000);
  if (fresh) { uBtns(null, ['Отлично', () => upd.close()]); uMode = ''; return; }
  uBtns(null, ['Перезагрузить', () => location.reload()]);
  setTimeout(() => location.reload(), 2500);
}
function uFail(st) {
  uMode = 'fail'; clearTimeout(uPoll);
  if (!upd.open) { upd.showModal(); requestAnimationFrame(upDraw); }
  const m = $('#upd-m'); m.innerHTML = '';
  m.append(el('small', 'uerr', st.error || 'Обновление не удалось'));
  if (st.steps && st.steps.length) { const ul = el('ul', 'ust'); for (const s of st.steps.slice(-6)) ul.append(el('li', s.k === 'run' ? 'past' : s.k, s.t)); m.append(ul); }
  unote(m, 'Повторять не страшно: установщик сохраняет данные и настройки, а Мочи работает дальше.');
  uSay(upick(UPH.fail), 'sad', 6000);
  uBtns(['Закрыть', () => upd.close()], updI && updI.admin && updI.ready ? ['Повторить', uGo] : null);
}
function updOpen(i) {
  const st = i.status;
  if (!upd.open) { upd.showModal(); requestAnimationFrame(upDraw); }
  if (i.admin && (st.state === 'running' || st.state === 'queued')) { if (uMode !== 'run') { uSince = st.since || st.started || 0; uOdd = 0; } uRun(st); uTick(); }
  else uOffer(i);
}
upd.addEventListener('close', () => { if (uMode !== 'run' && window.petSet) petSet('idle'); });

/* сервер обновился, пока страница была открыта: перезагружаемся, как только это никому не помешает */
function reloadSoon() {
  if (reloadT) return;
  window.petSet && petSet('wow', 'Я обновилась! Сейчас перезагружусь~', 3000);
  const go = () => { if (!$('#inp').value.trim() && !document.querySelector('dialog[open]')) location.reload(); else reloadT = setTimeout(go, 3000); };
  reloadT = setTimeout(go, 2000);
}
function seenBuild(b) {
  if (!b) return;
  if (build0 && b !== build0 && uMode !== 'run' && uMode !== 'done') reloadSoon();
  build0 = build0 || b;
}

/* настройки → Сервер → «Обновления» */
const fUpd = fold('upd', 'Обновления');
fUpd.body.innerHTML = `<span class="tgs" id="s-upd">…</span>
<div class="row2"><button class="pbtn" type="button" id="s-updc"><span>Проверить обновления</span></button><button class="pbtn" type="button" id="s-updgo" hidden><span>Обновить</span></button></div>
<small class="note" id="s-updn"></small>`;
pane.append(fUpd);
function updState(i) {
  if (!i || !i.status) return;
  updI = i;
  const st = i.status, on = !!(i.admin && i.available);
  $('#set').classList.toggle('upd', on); lxTab.classList.toggle('upd', on);
  const busy = st.state === 'running' || st.state === 'queued';
  const lines = [i.known ? 'Стоит версия ' + ver(i.current, i.current.date || i.current.installed) : 'Неизвестно, какая версия стоит: Мочи установлена без сведений о сборке.'];
  if (busy) lines.push('Сейчас идёт обновление…');
  else if (i.available) lines.push('Есть новая версия: ' + ver(i.latest) + (i.changes.length ? ' · ' + plural(i.changes.length, 'изменение', 'изменения', 'изменений') + (i.more ? ' и больше' : '') : ''));
  else if (i.available === false) lines.push('Это последняя версия ✓');
  if (i.error) lines.push('Не получилось проверить: ' + i.error);
  if (i.checked) lines.push('Проверено ' + ago(i.checked) + '.');
  else if (i.known && !i.error) lines.push('Ещё не проверяла.');
  $('#s-upd').textContent = lines.join('\n'); $('#s-upd').style.whiteSpace = 'pre-line';
  $('#s-updgo').hidden = !(i.admin && i.ready && (busy || i.available || (i.available === null && i.latest)));
  $('#s-updgo span').textContent = busy ? 'Показать ход' : 'Обновить';
  $('#s-updn').textContent = !i.admin ? 'Обновляет администратор сервера.' : !i.ready ? 'Чтобы обновлять из браузера, один раз выполни на сервере «sudo mochi update» — она поставит службу обновления.' : 'Мочи проверяет GitHub раз в 6 часов и сама предложит обновиться. Откуда берётся код: ' + (i.repo || '?') + (i.ref && i.ref !== 'HEAD' ? ' (ветка ' + i.ref + ')' : '') + '.';
  foldMeta(fUpd, busy ? 'обновляется…' : i.available ? 'есть новая' : i.available === false ? 'последняя' : i.error ? 'не проверить' : i.current && i.current.commit || '', !busy && !i.available && !!i.error);
  fUpd.querySelector(':scope>summary>.fm').classList.toggle('new', !!(busy || i.available));
}
$('#s-updc').onclick = async () => {
  const b = $('#s-updc'); b.disabled = true; $('#s-upd').textContent = 'Смотрю на GitHub…';
  try {
    const i = await post('api/update/check'); updAt = Date.now(); updState(i);
    if (i.admin && (i.available || i.status.state === 'running' || i.status.state === 'queued')) updOpen(i);
    else if (i.available === false && window.petSet) petSet('happy', upick(UPH.fresh), 3000);
  } catch (e) { $('#s-upd').textContent = 'Не получилось: ' + e.message; }
  finally { b.disabled = false; }
};
$('#s-updgo').onclick = () => updI && updOpen(updI);

/* ---------- настройки → Сервер → «Доступ агента» ----------
   Обычный пользователь mochi-agent или полный root (sudo без пароля). Переключает root-служба mochi-access:
   сервер кладёт запрос, служба правит sudoers и изоляцию, перезапускает исполнитель и терминал.
   Включить — только администратор и только с паролем; выключить — одной кнопкой. */
const fAcc = fold('acc', 'Доступ агента');
fAcc.body.innerHTML = `<span class="tgs" id="s-acc">…</span>
<div class="row2"><button class="pbtn" type="button" id="s-accgo" hidden><span></span></button><button class="pbtn" type="button" id="s-acccn" hidden><span>Отменить</span></button></div>
<small class="note" id="s-accn"></small>`;
pane.append(fAcc);
css.textContent += `#p-srv #s-acc{white-space:pre-line}#p-srv #s-acc b{color:var(--acc);font-weight:normal}#p-srv #s-acc .bad{color:var(--err)}
#dlg .fold>summary .fm.root{color:var(--acc)}`;
let accI = null, accPoll = 0, accWait = 0;
const accBusy = i => !!i && (i.status.state === 'queued' || i.status.state === 'running');
/* ask с переносами строк (в тексте предупреждения — абзацы) */
const askML = async (title, text, val, ok) => { const t = $('#ask-t'); t.style.whiteSpace = 'pre-line'; try { return await ask(title, text, val, ok); } finally { t.style.whiteSpace = ''; } };
function accState(i) {
  if (!i || !i.status) return;
  accI = i;
  const st = i.status, busy = accBusy(i), box = $('#s-acc');
  box.innerHTML = '';
  const line = (t, cls) => { if (box.childNodes.length) box.append('\n'); box.append(cls ? el('span', cls, t) : t); };
  if (busy) line(st.want === 'on' ? 'Даю агенту root… Исполнитель команд и терминал перезапускаются.' : st.want === 'off' ? 'Забираю root… Исполнитель команд и терминал перезапускаются.' : 'Переключаю доступ…');
  else if (i.root) {
    box.append(el('b', null, 'Полный доступ: root')); box.append(' — sudo без пароля. Агент ставит пакеты, настраивает службы, правит /etc.');
    if (i.mode === 'off') line('Права дала не Мочи: sudo для ' + i.user + ' настроен на сервере вручную.');
  } else {
    line('Обычный пользователь ' + i.user + ': без root, только свои папки и то, что разрешено всем.');
    if (i.mode === 'on') line('Root включён, но sudo у агента сейчас не работает. Включи ещё раз или выполни на сервере: sudo mochi root on', 'bad');
  }
  if (!busy && st.state === 'failed') line('Не получилось: ' + (st.error || 'ошибка'), 'bad');
  if (!busy && st.note) line('! ' + st.note);
  const can = i.admin && i.ready;
  const b = $('#s-accgo');
  b.hidden = !can || busy; b.firstChild.textContent = i.root ? 'Забрать root' : 'Дать полный root';
  $('#s-acccn').hidden = !(i.admin && st.state === 'queued' && Date.now() - st.since > 30e3);
  $('#s-accn').textContent = !i.admin ? 'Доступ агента меняет администратор сервера.'
    : !i.ready ? 'Переключатель заработает после «sudo mochi update» на сервере. Сразу — командой там же: sudo mochi root ' + (i.root ? 'off' : 'on') + '.'
    : st.state === 'queued' && Date.now() - st.since > 30e3 ? 'Служба на сервере пока не взяла запрос. Проверь её: «systemctl status mochi-access.path» (на Alpine — «rc-service mochi-updater status») или переключи командой: sudo mochi root ' + (st.want || 'on') + '.'
    : i.root ? 'Терминал: sudo -i — root-оболочка. Забрать root можно в любой момент; то, что агент уже поменял в системе, останется как есть.'
    : 'Полный доступ — как у администратора сервера: sudo без пароля, системные пакеты, службы, файлы в /etc. Включается с паролем от Мочи.';
  foldMeta(fAcc, busy ? 'переключается…' : i.root ? 'root' : 'без root', !busy && st.state === 'failed');
  fAcc.querySelector(':scope>summary>.fm').classList.toggle('root', !busy && !!i.root);
}
/* ждём, пока служба переключит доступ (исполнитель в это время перезапускается — сервер может пару секунд не знать, есть ли root) */
function accTick() {
  clearTimeout(accPoll);
  accPoll = setTimeout(async () => {
    let i = null;
    try { i = await api('api/access'); } catch (e) { if (e.status === 401) return check(); }
    if (i) {
      const was = accI && accI.root;
      accState(i);
      if (accBusy(i)) return accTick();
      if (i.status.state === 'failed') { window.petSet && petSet('sad', 'Не вышло переключить доступ…', 4000); return; }
      /* сразу после перезапуска исполнитель мог ещё не ответить — переспросим пару раз */
      if (accWait && i.root !== (accWait > 0) && Date.now() - Math.abs(accWait) < 20e3) return accTick();
      if (accWait) window.petSet && petSet(i.root ? 'love' : 'happy', i.root ? 'Теперь у меня root! Буду бережной ^_^' : 'Root отдала — я снова обычный пользователь', 3500);
      accWait = 0;
      if (was !== i.root) refreshPane();
      return;
    }
    accTick();
  }, 1500);
}
async function accSet(on) {
  const b = $('#s-accgo');
  if (on) {
    const n = accI ? accI.users : 1;
    const ok = await askML('Полный доступ', 'Агент получит root на этом сервере: sudo без пароля, системные пакеты и службы, любые файлы.'
      + '\n\nЧем это опасно:'
      + '\n· root получат все пользователи Мочи' + (n > 1 ? ' (их ' + n + ')' : '') + ' — агент и терминал у всех общие;'
      + '\n· инструкция, спрятанная на сайте или в файле, который прочтёт агент, сможет управлять всем сервером;'
      + '\n· агенту станут доступны ключи API и пароли Мочи.'
      + '\n\nИсполнитель команд и терминал перезапустятся' + (accI && accI.busy ? ': идущие команды оборвутся, агент продолжит сам.' : '.'), null, 'Дальше');
    if (!ok) return;
    const pw = await pwAsk('Полный доступ', 'Подтверди паролем от Мочи');
    if (pw == null) return;
    b.disabled = true;
    try { accState(await post('api/access', { root: true, password: pw })); accWait = Date.now(); accTick(); }
    catch (e) { await ask('Полный доступ', 'Не получилось: ' + e.message, null, 'OK'); }
    finally { b.disabled = false; }
  } else {
    if (!await askML('Забрать root', 'Агент снова станет обычным пользователем ' + (accI ? accI.user : 'mochi-agent') + '.\n\nИсполнитель команд и терминал перезапустятся. То, что агент уже поменял в системе с root, останется как есть.', null, 'Забрать')) return;
    b.disabled = true;
    try { accState(await post('api/access', { root: false })); accWait = -Date.now(); accTick(); }
    catch (e) { await ask('Забрать root', 'Не получилось: ' + e.message, null, 'OK'); }
    finally { b.disabled = false; }
  }
}
$('#s-accgo').onclick = () => accI && accSet(!accI.root);
$('#s-acccn').onclick = async () => { try { accState(await api('api/access', { method: 'DELETE' })); accWait = 0; clearTimeout(accPoll); } catch (e) { $('#s-accn').textContent = e.message; } };

/* при входе и при возвращении на вкладку (если давно не смотрели): есть новая версия — предлагаем */
async function updBoot(auto) {
  let i; try { i = await api('api/update'); } catch (e) { return; }
  updAt = Date.now(); updState(i);
  if (!i.admin || upd.open) return;
  const st = i.status;
  if (st.state === 'running' || st.state === 'queued') return updOpen(i);
  if (auto && i.available && i.latest && !snoozed(i.latest.commit)) setTimeout(() => { if (!document.querySelector('dialog[open]')) updOpen(i); }, 2000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && me && Date.now() - updAt > 3 * 3600e3) updBoot(true); });

/* ---------- вкладка «Инструменты»: Встроенные · MCP-серверы · Навыки ----------
   Всё применяется сразу. Выключенное не попадает в запросы к модели — рядом виден примерный «вес» в токенах.
   Встроенные инструменты переключает только пользователь: у агента для этого нет инструмента. */
const tlTab = document.createElement('button');
Object.assign(tlTab, { id: 't-tl', textContent: 'Инструменты' }); tlTab.type = 'button';
tlTab.setAttribute('role', 'tab'); tlTab.dataset.p = 'tl'; tlTab.setAttribute('aria-controls', 'p-tl');
lxTab.after(tlTab); stabs.push(tlTab);
tlTab.onclick = () => { stab('tl'); loadTools(); };
tlTab.onkeydown = e => { const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!d) return; e.preventDefault(); const n = stabs[(stabs.indexOf(tlTab) + d + stabs.length) % stabs.length]; n.click(); n.focus(); };
const tl = document.createElement('section');
tl.className = 'spane'; tl.id = 'p-tl'; tl.hidden = true; tl.setAttribute('role', 'tabpanel'); tl.setAttribute('aria-labelledby', 't-tl');
$('#dlg .sbody').append(tl);
css.textContent += `
#p-tl .xsum{display:block;margin-top:14px;font-size:9px;line-height:1.7;color:var(--mut)}
#p-tl .xmsg{display:block;margin-top:10px;font-size:9px;line-height:1.7;color:var(--err);word-break:break-word}#p-tl .xmsg:empty{display:none}#p-tl .xmsg[data-s=ok]{color:var(--ok)}
#p-tl .xs{display:block;margin-top:10px;font-size:9px;line-height:1.6;color:var(--mut);word-break:break-word}#p-tl .xs.bad{color:var(--err)}
#p-tl .xb{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px}
#p-tl .pbtn.xgo{margin-top:16px}
#p-tl .lnk{margin-top:12px}
`;
const TL_NAMES = { run_command: 'Команды на сервере', send_file: 'Отправка файлов', web_search: 'Поиск в интернете', web_fetch: 'Чтение страниц',
  telegram_connect: 'Подключение бота', telegram_status: 'Состояние бота', telegram_send: 'Сообщения в Telegram', telegram_notify_mode: 'Режим уведомлений', telegram_disconnect: 'Отключение бота',
  mcp_manage: 'Подключать MCP-серверы', skills_manage: 'Ставить и создавать навыки' };
const tok = n => '≈' + n + ' ток.';
const sum = (a, f) => a.reduce((x, y) => x + f(y), 0);
function swRow(title, sub, on, fn) {
  const l = el('label', 'sw'), s = el('span', null, title), i = el('input');
  if (sub) s.append(el('small', null, sub));
  i.type = 'checkbox'; i.setAttribute('role', 'switch'); i.checked = on;
  i.onchange = async () => { i.disabled = true; try { await fn(i.checked); } catch (e) { i.checked = !i.checked; tlMsg(e.message); } finally { i.disabled = false; } };
  l.append(s, i); return l;
}
const sbtn = (txt, fn) => { const b = el('button', 'pbtn sm'); b.type = 'button'; b.append(el('span', null, txt)); b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { tlMsg(e.message); } finally { b.disabled = false; } }; return b; };
const gobtn = txt => { const b = el('button', 'pbtn xgo'); b.type = 'button'; b.append(el('span', null, txt)); return b; };
const field = (label, input) => { const l = el('label', 'f', label); l.append(input); return l; };
const inp = (ph, area) => { const i = el(area ? 'textarea' : 'input'); i.placeholder = ph || ''; i.spellcheck = false; i.setAttribute('autocapitalize', 'off'); i.autocomplete = 'off'; if (area) i.rows = 3; return i; };
/* сообщение — вверху вкладки и, если передано, прямо под кнопкой формы (иначе его не видно, когда форма внизу) */
function tlMsg(t, ok, near) { for (const m of [$('#x-msg'), near]) { if (!m) continue; m.textContent = t || ''; if (ok) m.dataset.s = 'ok'; else delete m.dataset.s; } }
const fmsg = () => { const m = el('small', 'xmsg'); m.setAttribute('role', 'status'); return m; };
const setTools = m => api('api/tools', { method: 'PUT', json: { tools: m } }).then(loadTools);

async function loadTools() {
  let c;
  try { c = await api('api/tools'); } catch (e) { if (e.status === 401) return check(); tl.textContent = 'Не загрузилось: ' + e.message; return; }
  const keep = $('#x-msg') ? [$('#x-msg').textContent, $('#x-msg').dataset.s] : ['', ''], y = $('#dlg .sbody').scrollTop;
  tl.innerHTML = '';
  const bOn = c.builtin.filter(t => t.on), live = c.mcp.filter(s => s.on && !s.lazy);
  const weight = sum(bOn, t => t.size) + sum(live, s => sum(s.tools.filter(t => t.on), t => t.size));
  tl.append(el('small', 'xsum', 'Мочи видит только включённое. Сейчас описания инструментов занимают ' + tok(weight) + ' в каждом запросе.'));
  const msg = el('small', 'xmsg'); msg.id = 'x-msg'; msg.setAttribute('role', 'status'); msg.textContent = keep[0]; if (keep[1]) msg.dataset.s = keep[1]; tl.append(msg);

  /* встроенные — по группам; внутри группы с несколькими инструментами есть общий переключатель */
  const B = fold('b', 'Встроенные', bOn.length + ' из ' + c.builtin.length + ' · ' + tok(sum(bOn, t => t.size)));
  B.body.append(el('small', 'xs', 'Включает и выключает их только пользователь — Мочи этого не может.'));
  const groups = {};
  for (const t of c.builtin) (groups[t.group] ||= []).push(t);
  for (const [g, ts] of Object.entries(groups)) {
    const on = ts.filter(t => t.on), G = fold('b:' + g, g, on.length + '/' + ts.length + ' · ' + tok(sum(on, t => t.size)));
    if (ts.length > 1) G.body.append(swRow('Все', null, on.length === ts.length, v => setTools(Object.fromEntries(ts.map(t => [t.name, v])))));
    for (const t of ts) G.body.append(swRow(TL_NAMES[t.name] || t.name, t.name + ' · ' + tok(t.size), t.on, v => setTools({ [t.name]: v })));
    B.body.append(G);
  }
  if (!c.search) B.body.append(el('small', 'xs', 'Поиск в интернете выключен на вкладке «Модель».'));
  tl.append(B);

  /* MCP-серверы: каждый — своя папка */
  const mOn = c.mcp.filter(s => s.on);
  const mBad = c.mcp.some(s => s.on && s.err);
  const M = fold('m', 'MCP-серверы', c.mcp.length ? mOn.length + ' из ' + c.mcp.length + ' вкл.' + (mBad ? ' · ошибка' : '') : 'нет', mBad);
  if (!c.mcp.length) M.body.append(el('small', 'xs', 'Внешние инструменты. Подключи ниже или попроси Мочи в чате: «подключи MCP-сервер …».'));
  for (const s of c.mcp) {
    const on = s.tools.filter(t => t.on);
    const S = fold('m:' + s.name, s.name, !s.on ? 'выкл.' : s.err ? 'ошибка' : (s.lazy ? 'по запросу' : 'всегда') + (s.known ? ' · ' + on.length + '/' + s.tools.length : ''), s.on && !!s.err);
    S.body.append(el('small', 'xs', (s.server && s.server !== s.name ? s.server + ' · ' : '') + (s.type === 'http' ? s.url : s.command) + (s.headers.length ? ' · заголовки: ' + s.headers.join(', ') : '') + (s.env.length ? ' · env: ' + s.env.join(', ') : '')));
    if (s.desc) S.body.append(el('small', 'xs', s.desc));
    if (s.err) S.body.append(el('small', 'xs bad', 'Ошибка: ' + s.err));
    S.body.append(swRow('Включён', null, s.on, v => post('api/mcp/' + s.name, { on: v }).then(loadTools)));
    S.body.append(swRow('По запросу', 'Инструменты подключаются, только когда нужны Мочи', s.lazy, v => post('api/mcp/' + s.name, { lazy: v }).then(loadTools)));
    if (s.tools.length) {
      const T = fold('mt:' + s.name, 'Инструменты', on.length + '/' + s.tools.length + ' · ' + tok(sum(on, t => t.size)));
      if (s.tools.length > 1) T.body.append(swRow('Все', null, on.length === s.tools.length, v => post('api/mcp/' + s.name, { tools: Object.fromEntries(s.tools.map(t => [t.name, v])) }).then(loadTools)));
      for (const t of s.tools) T.body.append(swRow(t.name, (t.desc ? t.desc + ' · ' : '') + tok(t.size), t.on, v => post('api/mcp/' + s.name, { tools: { [t.name]: v } }).then(loadTools)));
      S.body.append(T);
    }
    const b = el('div', 'xb');
    b.append(sbtn('Обновить', async () => { const r = await post('api/mcp/' + s.name, { refresh: true }); tlMsg(r.err ? s.name + ': ' + r.err : s.name + ': подключён', !r.err); loadTools(); }));
    b.append(sbtn('Удалить', async () => { if (!await ask('MCP', 'Удалить сервер «' + s.name + '»?', null, 'Удалить')) return; await api('api/mcp/' + s.name, { method: 'DELETE' }); loadTools(); }));
    S.body.append(b); M.body.append(S);
  }
  {
    const A = fold('m+', 'Подключить сервер'), n = inp('например: github'), u = inp('https://…/mcp  или  npx -y @modelcontextprotocol/server-memory'),
      k = inp('Authorization: Bearer …   (для команды — КЛЮЧ=значение)', true), ds = inp('для чего он, коротко'), go = gobtn('Подключить');
    A.body.append(field('Имя', n), field('Адрес или команда запуска', u), field('Заголовки / переменные окружения · по одной в строке', k), field('Описание', ds));
    go.onclick = async () => {
      const v = u.value.trim(), http = /^https?:\/\//i.test(v), body = { name: n.value.trim(), description: ds.value.trim(), [http ? 'url' : 'command']: v };
      if (k.value.trim()) body[http ? 'headers' : 'env'] = k.value;
      go.disabled = true; tlMsg('Подключаю…', true, fm);
      try { const r = await post('api/mcp', body); tlMsg(r.err ? 'Сохранён, но не подключился: ' + r.err : 'Сервер «' + r.name + '» подключён', !r.err); opened['m+'] = false; opened['m:' + r.name] = true; await loadTools(); }
      catch (e) { tlMsg(e.message, false, fm); } finally { go.disabled = false; }
    };
    const fm = fmsg();
    A.body.append(go, fm, el('small', 'xs', 'Локальные серверы запускаются на сервере от имени агента (как его команды). Ключи хранятся на сервере и в браузер не возвращаются.'));
    M.body.append(A);
  }
  tl.append(M);

  /* навыки: каждый — своя папка; ниже — установка по ссылке и создание */
  const kOn = c.skills.filter(k => k.on);
  const K = fold('k', 'Навыки', c.skills.length ? kOn.length + ' из ' + c.skills.length + ' вкл.' : 'нет');
  K.body.append(el('small', 'xs', 'Навык — инструкция SKILL.md для определённых задач. Мочи помнит только имена включённых и читает навык целиком, когда он нужен.'));
  for (const k of c.skills) {
    const S = fold('k:' + k.name, k.name, k.on ? 'вкл.' : 'выкл.');
    if (k.title) S.body.append(el('small', 'xs', k.title));
    S.body.append(el('small', 'xs', k.desc || 'без описания'));
    S.body.append(swRow('Включён', null, k.on, v => post('api/skills/' + k.name, { on: v }).then(loadTools)));
    const b = el('div', 'xb');
    b.append(sbtn('Изменить', async () => { const r = await api('api/skills/' + encodeURIComponent(k.name)); skillForm(k.name, r.raw); }));
    b.append(sbtn('Удалить', async () => { if (!await ask('Навык', 'Удалить навык «' + k.name + '» вместе с его папкой?', null, 'Удалить')) return; await api('api/skills/' + encodeURIComponent(k.name), { method: 'DELETE' }); loadTools(); }));
    S.body.append(b); K.body.append(S);
  }
  {
    const U = fold('k+url', 'Установить по ссылке'), u = inp('https://github.com/anthropics/skills/tree/main/skills/pdf'), n = inp('необязательно'), go = gobtn('Установить');
    U.body.append(field('Папка или репозиторий GitHub, или URL на SKILL.md', u), field('Имя навыка (если в репозитории их несколько)', n));
    go.onclick = async () => {
      if (!u.value.trim()) { tlMsg('Вставь ссылку на навык', false, fm); u.focus(); return; }
      go.disabled = true; tlMsg('Скачиваю…', true, fm);
      try { const r = await post('api/skill-install', { url: u.value.trim(), name: n.value.trim() }); tlMsg('Установлено: ' + r.names.join(', '), true); opened['k+url'] = false; for (const x of r.names) opened['k:' + x] = true; await loadTools(); }
      catch (e) { tlMsg(e.message, false, fm); } finally { go.disabled = false; }
    };
    const fm = fmsg();
    U.body.append(go, fm); K.body.append(U);
  }
  const N = fold('k+new', 'Создать навык'); N.id = 'x-skf'; K.body.append(N); skillForm(null, null, N);
  tl.append(K);
  $('#dlg .sbody').scrollTop = y;
}
/* форма навыка: новый — имя, описание, инструкция; правка — весь SKILL.md целиком */
function skillForm(name, raw, d = $('#x-skf')) {
  if (!d) return;
  d.querySelector(':scope>summary>.ft').textContent = name ? 'Навык «' + name + '» · правка' : 'Создать навык';
  d.body.innerHTML = '';
  const n = inp('например: weekly-report'), ds = inp('когда применять: «Отчёт за неделю по шаблону компании»'), body = inp(raw != null ? '' : 'Что и как делать, по шагам. Markdown.', true), go = gobtn('Сохранить навык');
  body.rows = raw != null ? 14 : 6;
  if (name) { n.value = name; n.readOnly = true; }
  if (raw != null) body.value = raw;
  d.body.append(field('Имя', n));
  if (raw == null) d.body.append(field('Когда применять', ds));
  d.body.append(field(raw != null ? 'SKILL.md' : 'Инструкция', body));
  const fm = fmsg();
  go.onclick = async () => {
    const miss = !n.value.trim() ? [n, 'Нужно имя навыка (например: weekly-report)']
      : raw == null && !ds.value.trim() ? [ds, 'Нужно описание: когда применять навык']
      : !body.value.trim() ? [body, raw != null ? 'SKILL.md пустой' : 'Нужен текст инструкции'] : null;
    if (miss) { tlMsg(miss[1], false, fm); miss[0].focus(); return; }
    go.disabled = true; tlMsg('Сохраняю…', true, fm);
    try {
      const r = await post('api/skills', raw != null ? { name: n.value.trim(), raw: body.value } : { name: n.value.trim(), description: ds.value.trim(), instructions: body.value, create: true });
      tlMsg('Навык «' + r.name + '» сохранён', true); opened['k+new'] = false; opened['k:' + r.name] = true; await loadTools();
      $('#p-tl [data-k="k:' + r.name + '"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (e) { tlMsg(e.message, false, fm); } finally { go.disabled = false; }
  };
  d.body.append(go, fm);
  if (name) {
    const c = el('button', 'lnk'); c.type = 'button'; c.textContent = 'Отмена'; c.onclick = () => { skillForm(null, null, d); d.open = false; };
    d.body.append(c);
    d.open = true; d.parentElement.closest('details').open = true;
    d.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

/* ---------- терминал: ttyd за авторизацией ----------
   ttyd рисует xterm.js в iframe с того же адреса, поэтому оформляем его как экран браузерной версии:
   шрифт VT323, свечение люминофора, отступы, палитра из текущей темы (и меняется вместе с ней). */
let tty = null;
function ttyFrame() {
  if (tty) return tty;
  tty = document.createElement('iframe');
  tty.id = 'tty'; tty.title = 'Терминал сервера'; tty.setAttribute('allow', 'clipboard-read; clipboard-write');
  /* до оформления не показываем (иначе мелькнёт серый xterm); после подключения ttyd присылает свои
     настройки — оформление повторяем, чтобы оно точно осталось за нами */
  tty.style.visibility = 'hidden';
  tty.addEventListener('load', () => {
    ttyLook(); setTimeout(ttyLook, 1000); setTimeout(ttyLook, 3000);
    setTimeout(() => { tty.style.visibility = ''; }, 2500); /* xterm так и не появился (например, «Терминал не запущен») */
  });
  tty.src = 'term/';
  $('#scr').insertBefore(tty, $('#tstat'));
  return tty;
}
const xterm = () => { try { return tty && tty.contentWindow && tty.contentWindow.term; } catch (e) { return null; } };
const fit = () => { const t = xterm(); try { t && t.fit && t.fit(); } catch (e) {} };

/* цвета: #rrggbb → смесь. Палитра ANSI монохромная, как экран браузерной версии (там вывод без цветов):
   все цвета — люминофор темы; «чёрный» — фон, «ярко-чёрный» — приглушённый люминофор (подсказки, строка tmux) */
const hex = c => { c = String(c || '').trim().replace('#', ''); if (c.length === 3) c = c.replace(/./g, '$&$&'); const n = parseInt(c, 16); return /^[0-9a-f]{6}$/i.test(c) ? [n >> 16, n >> 8 & 255, n & 255] : null; };
const mix = (a, b, k) => { const x = hex(a), y = hex(b); if (!x || !y) return a || b; return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, '0')).join(''); };
function ttyTheme() {
  const cs = getComputedStyle(de), v = n => cs.getPropertyValue(n).trim();
  const bg = v('--tbg') || '#1b1230', fg = v('--tfg') || '#7dffb0';
  const th = { background: bg, foreground: fg, cursor: fg, cursorAccent: bg, selectionBackground: mix(bg, fg, .3), selectionForeground: fg, black: bg, brightBlack: mix(bg, fg, .55) };
  for (const c of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']) th[c] = th['bright' + c[0].toUpperCase() + c.slice(1)] = fg;
  return th;
}
/* шрифты страницы (VT323 и запасной Handjet встроены в index.html) — копируем их @font-face в iframe */
const fontCss = () => {
  let out = '';
  for (const sh of document.styleSheets) {
    let rules; try { rules = sh.cssRules; } catch (e) { continue; }
    for (const r of rules) if (r.type === CSSRule.FONT_FACE_RULE && /VT323|Handjet/.test(r.style.getPropertyValue('font-family'))) out += r.cssText + '\n';
  }
  return out;
};
let lookT = 0;
function ttyLook() {
  clearTimeout(lookT);
  let d; try { d = tty.contentDocument; } catch (e) { return; }
  const t = xterm();
  if (!d || !t || !t.options) { if (tty) lookT = setTimeout(ttyLook, 150); return; } /* xterm ещё не создан */
  let st = d.getElementById('mochi-look');
  if (!st) {
    st = d.createElement('style'); st.id = 'mochi-look';
    st.textContent = fontCss() + `
html,body{background:transparent!important}
#terminal-container{background:transparent!important}
#terminal-container .terminal{padding:18px 22px!important;height:100%!important;box-sizing:border-box}
.xterm-rows{text-shadow:0 0 6px var(--glow)}
.xterm-rows .xterm-cursor{box-shadow:0 0 8px var(--glow)}
.xterm-viewport{scrollbar-width:none}.xterm-viewport::-webkit-scrollbar{display:none}`;
    d.head.append(st);
  }
  const th = ttyTheme();
  tty.style.visibility = '';
  d.documentElement.style.setProperty('--glow', th.foreground + '8c');
  const mono = getComputedStyle(de).getPropertyValue('--mono').trim() || 'VT323, monospace';
  Object.assign(t.options, { theme: th, fontFamily: mono, fontSize: cfg.tfs || 18, lineHeight: 1.1, cursorBlink: true, cursorStyle: 'block', fontWeight: 'normal', fontWeightBold: 'normal' });
  /* метрики шрифта меряются при смене fontFamily — дождёмся загрузки VT323, потом подгоним размер */
  (d.fonts && d.fonts.load ? d.fonts.load(`${cfg.tfs || 18}px VT323`).catch(() => {}) : Promise.resolve()).then(() => {
    t.options.fontFamily = mono + ', monospace'; t.options.fontFamily = mono; fit();
  });
}
new MutationObserver(() => tty && ttyLook()).observe(de, { attributes: true, attributeFilter: ['data-theme'] });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => tty && ttyLook());

function tx(s) {
  const t = xterm(); if (!t) return false;
  try {
    if (typeof t.input === 'function') t.input(s, true);
    else if (t._core && t._core.coreService) t._core.coreService.triggerDataEvent(s, true);
    else t.paste(s);
    t.focus && t.focus(); return true;
  } catch (e) { return false; }
}
document.querySelector('nav [data-v=term]').addEventListener('click', () => { ttyFrame(); setTimeout(() => { fit(); const t = xterm(); t && t.focus && t.focus(); }, 80); });
/* проводник: «Открыть в терминале» — перейти в папку (терминал мог ещё не загрузиться — ждём xterm) */
window.mochiTermCd = dir => {
  navTo('term'); ttyFrame();
  const cmd = "cd '" + String(dir).replace(/'/g, "'\\''") + "'\r";
  let n = 0;
  const tryIt = () => { if (tx(cmd)) return; if (++n < 40) setTimeout(tryIt, 250); };
  setTimeout(tryIt, 120);
};
document.querySelectorAll('.keys button[data-k]').forEach(b => b.onclick = () => { tx(keyStr(b.dataset.k)); window.sfx && sfx('key'); });
$('#tcls').onclick = () => { tx('\x0c'); window.sfx && sfx('key'); };
const tfs = d => { cfg.tfs = Math.min(30, Math.max(12, (cfg.tfs || 18) + d)); save(); const t = xterm(); if (t && t.options) { t.options.fontSize = cfg.tfs; fit(); } };
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

/* ---------- старт ----------
   Сервер не ответил (перезапускается, обновляется, пропала сеть) — не висим на «подключаюсь…», а пробуем снова;
   экран загрузки показывает почему и сколько до следующей попытки */
let helloT = 0, tries = 0;
async function hello() {
  clearTimeout(helloT); helloT = 0;
  bt('go', 'link', tries ? 'попытка ' + (tries + 1) : undefined);
  const t0 = performance.now(), ms = () => Math.round(performance.now() - t0) + ' мс';
  try { me = (await api('api/me')).user; }
  catch (e) {
    if (e.status === 401) { me = null; bt('ok', 'link', 'пинг ' + ms()); showAuth(e.j); return; }
    const k = navigator.onLine === false ? 'offline' : !e.status ? 'down' : e.status >= 502 && e.status <= 504 ? 'restart' : 'http';
    const s = [1, 2, 3, 5, 5, 8, 10][Math.min(tries++, 6)];
    bt('wait', 'link', k, s, k === 'http' ? 'HTTP ' + e.status : '');
    setSt(k === 'offline' ? 'нет интернета' : 'сервер не отвечает', 'err');
    helloT = setTimeout(hello, s * 1000);
    return;
  }
  bt('ok', 'link', 'пинг ' + ms());
  bt('ok', 'auth', me.name);
  setSt('подключаюсь к серверу…', 'on');
  started();
}
addEventListener('online', () => { if (helloT) hello(); });
if (window.mochiBoot) mochiBoot.onRetry = () => { if (helloT) hello(); else if (me && !connected) { if (es) { es.close(); es = null; } connect(); } };
setSt('подключаюсь к серверу…', 'on');
hello();
})();
