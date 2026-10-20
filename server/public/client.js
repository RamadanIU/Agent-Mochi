/* ---------- Personal Computer · связь с сервером ----------
   index.html — оформление, компьютер в шапке, чат, проводник; здесь — всё, что говорит с сервером:
   • вход/регистрация (по приглашению);
   • агент работает на сервере в фоне: чат подписан на поток событий и после возвращения
     показывает и прогресс, и итог;
   • вкладка «Терминал» — настоящий терминал сервера (ttyd за авторизацией);
   • в настройках — вкладка «Сервер» (Telegram, прокси, приглашения, пароль, выход, обновления, доступ агента — root) и «Инструменты» (вкл/выкл, MCP, навыки).
   Используем функции основного скрипта (add, md, think, ask…), а не дублируем их. Работу агента (шаги, «думаю», итог)
   показывает компьютер в верхней панели — personalComputerRoom (index.html); в чате остаются только сообщения, файлы и ошибки. */
(() => {
const de = document.documentElement;
de.classList.add('srv');
/* экран загрузки (#boot в index.html): страница на месте — дальше шаги «сервер → вход → модель → чат → агент» двигаем отсюда */
const bt = (k, ...a) => { try { window.personalComputerBoot && personalComputerBoot[k](...a); } catch (e) {} };
bt('go', 'link');

/* ---------- стили серверного режима ---------- */
const css = document.createElement('style');
css.textContent = `
#tty{flex:1;min-height:0;width:100%;border:0;background:var(--tbg);display:block}
.more{align-self:center;display:flex;align-items:center;gap:8px;margin:0 4px;padding:9px 12px;background:var(--card);color:var(--fg);font:7px/1 var(--pf);box-shadow:var(--sh2)}
.more .pi{width:10px;height:6px;--ico:var(--i-up)}.more:hover,.more:focus-visible{color:var(--acc)}
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
[data-act=sretry] .pi{--ico:var(--i-restore)}
.snote .ea{justify-content:center;margin-top:10px}
#queue{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:12px 16px 0;background:var(--card)}#queue[hidden]{display:none}
#queue .qh{flex:1 1 100%;display:flex;align-items:center;gap:12px;margin:0 4px;color:var(--mut);font:7px/1.6 var(--pf)}
#queue .qh span{flex:1;min-width:0}#queue .qh .pbtn{flex:none;margin:4px}#queue .qh .pbtn .pi{--ico:var(--i-enter)}
#queue .chip{border-left:4px dashed var(--acc)}#queue .chip .n{color:var(--fg)}
/* ---------- история чатов ---------- */
:root{--j-search:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10' shape-rendering='crispEdges'%3E%3Cpath fill='%23000' fill-opacity='.4' d='M1 1h4v1H1zM1 2h4v1H1zM1 3h4v1H1zM1 4h4v1H1z'/%3E%3Cpath fill='%23000' d='M1 0h4v1H1zM0 1h1v1H0zM5 1h1v1H5zM0 2h1v1H0zM5 2h1v1H5zM0 3h1v1H0zM5 3h1v1H5zM0 4h1v1H0zM5 4h1v1H5zM1 5h4v1H1zM5 6h2v1H5zM6 7h2v1H6zM7 8h2v1H7zM8 9h2v1H8z'/%3E%3C/svg%3E")}
.chist{position:absolute;top:100%;right:8px;z-index:6;display:flex;flex-direction:column;width:min(460px,calc(100% - 16px));max-height:min(680px,calc(100vh - var(--hh,80px) - 96px));max-height:min(680px,calc(100dvh - var(--hh,80px) - 96px));margin-top:12px;background:var(--bg);color:var(--fg);box-shadow:var(--sh4),8px 8px 0 0 var(--dsh);animation:inUp .3s var(--ezb);outline:none}
.chist[hidden]{display:none}
.chist-top{flex:none;display:flex;flex-direction:column;gap:14px;padding:16px 16px 10px}
.chist .chist-new{width:auto;margin:4px;justify-content:flex-start;background:var(--acc);color:var(--onacc);animation:none}
.chist .chist-new:hover:not(:disabled){background:var(--acc);color:var(--onacc);filter:brightness(1.07)}
.chist .chist-new .pi{--ico:var(--j-plus);width:16px;height:16px}
.chist-new span{flex:1;text-align:left}
.chist-new kbd{font:6px/1 var(--pf);opacity:.75;text-transform:none;letter-spacing:0}
.chist-s{display:flex;align-items:center;gap:10px;margin:4px;padding:0 4px 0 12px;background:var(--card);box-shadow:var(--sh3),var(--sunk);transition:box-shadow .2s var(--ez);cursor:text}
.chist-s:focus-within{box-shadow:var(--sh4a),var(--sunk)}
.chist-s>.pi{--ico:var(--j-search);width:14px;height:14px;color:var(--mut)}
.chist-s input{flex:1;min-width:0;padding:12px 0;border:0;background:none;outline:none;font:8px/1.4 var(--pf);color:var(--fg);caret-color:var(--acc);-webkit-appearance:none;appearance:none}
.chist-s input::placeholder{color:var(--mut);opacity:1}
.chist-s input::-webkit-search-cancel-button{display:none}
.chist-x{flex:none;display:flex;padding:9px;color:var(--mut)}.chist-x[hidden]{display:none}.chist-x:hover{color:var(--acc)}
.chist-x .pi{--ico:var(--i-x);width:10px;height:10px}
.chist-l{flex:1 1 auto;min-height:90px;overflow-y:auto;overscroll-behavior:contain;padding:0 12px 12px;scrollbar-width:thin;scrollbar-color:var(--mut) transparent}
.chist-g{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:10px;margin:0 -12px;padding:12px 16px 8px;background:var(--bg);color:var(--mut);font:7px/1 var(--pf)}
.chist-g::after{content:"";flex:1;height:2px;background:repeating-linear-gradient(90deg,var(--mut) 0 4px,transparent 4px 8px);opacity:.5}
.crow{position:relative;display:flex;align-items:center;gap:12px;min-height:54px;margin:3px 4px;padding:8px 8px 8px 16px;cursor:pointer;outline:none;transition:background-color .15s,opacity .18s,transform .18s var(--ez)}
.crow::before{content:"";position:absolute;left:0;top:7px;bottom:7px;width:4px;background:transparent}
.crow:hover,.crow.sel{background:var(--card)}
.crow.sel{box-shadow:var(--sh2)}
.crow:focus-visible{box-shadow:var(--sh2a,var(--sh2)),0 0 0 4px color-mix(in srgb,var(--acc) 35%,transparent)}
.crow.on{background:var(--card)}.crow.on::before{background:var(--acc)}
.crow.on .crow-t{color:var(--acc)}
.crow.gone{opacity:0;transform:translateX(28px);pointer-events:none}
.crow-m{flex:1;min-width:0;display:flex;flex-direction:column;gap:7px}
.crow-t{display:block;font:8px/1.5 var(--pf);font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crow-p{display:block;color:var(--mut);font:18px/1 var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crow-p:empty{display:none}
.crow mark{background:color-mix(in srgb,var(--acc) 35%,transparent);color:inherit;padding:0}
.crow-r{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:46px}
.crow time{color:var(--mut);font:7px/1 var(--pf);white-space:nowrap}
.crow.run time{color:var(--acc)}
.crow.run time::before{content:"";display:inline-block;width:6px;height:6px;margin:0 6px 1px 0;background:var(--acc);animation:hpb 1s steps(2) infinite}
@keyframes hpb{50%{opacity:0}}
.crow-a{display:none;gap:2px}
.crow-a button{display:flex;padding:8px;color:var(--mut)}
.crow-a button:hover,.crow-a button:focus-visible{color:var(--acc);background:var(--bg)}
.crow-a [data-ha=del]:hover,.crow-a [data-ha=del]:focus-visible{color:var(--err)}
.crow-a .pi{width:14px;height:14px}
.crow-a [data-ha=ren] .pi{--ico:var(--j-pencil)}.crow-a [data-ha=del] .pi{--ico:var(--j-trash)}
@media(hover:hover){.crow:hover .crow-a,.crow.sel .crow-a,.crow:focus-within .crow-a{display:flex}.crow:hover time,.crow.sel time,.crow:focus-within time{display:none}}
/* на телефоне наведения нет: время сверху, карандаш и корзина — под ним, всегда под пальцем */
@media(hover:none){.crow{padding-right:2px}.crow-r{flex-direction:column;align-items:flex-end;gap:2px}.crow-a{display:flex}.crow time{padding:4px 8px 0}.crow-a button{padding:9px}}
.crow.edit{cursor:default;background:var(--card);box-shadow:var(--sh2)}
.crow.edit .crow-r{display:none}
.crow-in{display:block;width:100%;margin:0;padding:7px 9px;border:0;background:var(--bg);box-shadow:var(--sh2),var(--sunk);outline:none;font:8px/1.5 var(--pf);color:var(--fg);caret-color:var(--acc)}
.chist-e{margin:30px 18px;color:var(--mut);font:7px/1.9 var(--pf);text-align:center}
.chist-f{flex:none;display:flex;justify-content:space-between;gap:12px;padding:10px 16px 11px;border-top:2px dashed color-mix(in srgb,var(--mut) 55%,transparent);color:var(--mut);font:6px/1.5 var(--pf)}
.chist-f span:empty,.chist-k[hidden]{display:none}
.chist-k{text-align:right}
@media(max-width:560px){.chist{right:6px;width:calc(100% - 12px)}.chist-new kbd,.chist-k{display:none}}
@media(hover:none){.chist-new kbd{display:none}}
/* агент работает в другом чате — плашка над полем ввода */
#busy{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:12px 16px 0;background:var(--card)}#busy[hidden]{display:none}
#busy .bi{--ico:var(--j-steps);width:14px;height:14px;color:var(--acc);animation:hpb 1.2s steps(2) infinite}
#busy .bt{flex:1 1 180px;min-width:0;margin:0 4px;color:var(--mut);font:7px/1.6 var(--pf)}
#busy .pbtn{flex:none;margin:4px}#busy .pbtn[hidden]{display:none}
#busy [data-b=go] .pi{--ico:var(--i-enter)}#busy [data-b=stop] .pi{--ico:var(--i-stop)}
#busy.nudge{animation:hpn .42s var(--ez)}#busy.nudge .bt{color:var(--fg)}
@keyframes hpn{20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
/* «Чат удалён · Вернуть» */
.snack{position:absolute;left:0;right:0;bottom:16px;z-index:4;width:max-content;max-width:calc(100% - 24px);margin:auto;display:flex;align-items:center;gap:10px;padding:4px 4px 4px 14px;background:var(--ink);color:var(--bg);font:7px/1.6 var(--pf);box-shadow:4px 4px 0 0 var(--dsh);animation:inUp .3s var(--ezb);transition:opacity .25s}
.snack[hidden]{display:none}.snack.out{opacity:0}
.snack>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.snack .pbtn{flex:none;width:auto;margin:4px;background:var(--acc);color:var(--onacc);box-shadow:none;animation:none}
.snack .pbtn .pi{--ico:var(--i-restore)}
/* переключение чата: старая переписка гаснет, пока не пришла новая */
#msgs{transition:opacity .18s var(--ez)}#msgs.sw{opacity:.3;transition:none}
`;
document.head.append(css);

/* ---------- API ---------- */
async function api(p, o = {}) {
  const h = { ...(o.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.method && o.method !== 'GET' ? { 'x-personalcomputer': '1' } : {}), ...o.headers };
  const r = await fetch(p, { method: o.method || 'GET', headers: h, body: o.json !== undefined ? JSON.stringify(o.json) : o.body, credentials: 'same-origin', cache: 'no-store' });
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw Object.assign(new Error((j && j.error) || 'HTTP ' + r.status), { status: r.status, j });
  return j;
}
const post = (p, json = {}) => api(p, { method: 'POST', json });

let me = null, es = null, running = false, view = null, busyElse = null, srvSet = null, bubble = null, hideT = 0, connected = false, replaying = false, olderNow = false;
/* событие журнала → компьютер в шапке (при перерисовке истории — только в его журнал, без реакций; старую историю «Показать раньше» не трогаем) */
const room = (k, e) => { if (olderNow) return; try { window.personalComputerRoom && personalComputerRoom[k](e, replaying); } catch (x) { console.error(x); } };
const isImgN = n => /\.(png|jpe?g|gif|webp)$/i.test(n || '');
const READY = 'готово · сервер';

/* ---------- экран входа ---------- */
const auth = document.createElement('dialog');
auth.id = 'auth'; auth.className = 'win'; auth.setAttribute('aria-labelledby', 'auth-t');
auth.innerHTML = `<div class="wbar"><span></span><b id="auth-t">Вход</b><span></span></div>
<div class="stabs" role="tablist"><button role="tab" data-m="login" class="on">Вход</button><button role="tab" data-m="reg">Регистрация</button></div>
<div class="sbody"><div class="wtitle" aria-hidden="true">PERSONAL<br>COMPUTER</div><p class="ws" id="auth-w"></p>
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
    : 'Personal Computer живёт на этом сервере и работает, даже когда браузер закрыт. Войди, чтобы продолжить.';
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
  fr.className = 'fr'; ic.className = 'pi'; fi.className = 'fci'; /* не .fi: это класс значков проводника */ a.className = 'fn'; a.textContent = e.name;
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
/* «Продолжить» под последней отметкой «Остановлено»: остановили, а сообщения, присланные во время работы, остались
   без ответа. Нужна, только пока после остановки ничего не случилось — следующая запись её убирает */
let cont = null;
function note(text, retry) {
  const box = $('#msgs'); box.querySelector('.empty')?.remove();
  const d = document.createElement('div'); d.className = 'snote'; d.textContent = text;
  if (retry) { d.insertAdjacentHTML('beforeend', '<div class="ea"><button class="pbtn sm" data-act="sretry"><i class="pi"></i><span>Продолжить</span></button></div>'); cont = d.lastChild; }
  box.append(d); pin();
}
function errBox(e) {
  return esc(e.text || 'ошибка') + (e.detail ? '<small class="ed">' + esc(String(e.detail).slice(0, 220)) + '</small>' : '')
    + (e.retry ? '<div class="ea"><button class="pbtn sm" data-act="sretry"><i class="pi"></i><span>Повторить</span></button><button class="pbtn sm" data-act="set"><i class="pi"></i><span>Настройки</span></button></div>' : '');
}

function render(e) {
  curT = e.t;
  if (cont && e.kind !== 'note') { cont.remove(); cont = null; }
  switch (e.kind) {
    case 'user': {
      bubble = null;
      const d = add('u', esc(e.text || '') + (e.origin === 'tg' ? '<span class="tgm">TG</span>' : '') + (e.files || []).map(f => '<div class="uf">' + (f.fid && isImgN(f.name) ? '<img src="api/files/' + f.fid + '" alt="" loading="lazy">' : '') + '+ ' + esc(f.name) + ' <small>' + sz(f.size) + '</small></div>').join(''));
      stamp(d, e); room('user', e); if (!replaying) hist.sent();
      /* прежние ответы и развёрнутое сворачиваются, твоё длинное — тоже (на экране — плавно) */
      foldPrev(!replaying); foldUser(d, !replaying);
      /* сообщение из очереди ушло модели посреди задачи — она уже думает над ним */
      if (e.mid && running && !replaying) think(true);
      break;
    }
    case 'assistant': {
      const el = bubble || add('a', ''); bubble = null;
      aText(el, e.text || ''); stamp(el, e); foldKeep(el); pin(); room('answer', e);
      if (!replaying) { window.personalComputerSpeak && personalComputerSpeak(e.text); window.sfx && sfx('recv'); }
      break;
    }
    case 'tool': {
      room('tool', e);
      if (e.state !== 'run' && running && !replaying) think(true);
      break;
    }
    case 'file': fileCardS(e); room('file', e); break;
    case 'error': stamp(add('e', errBox(e)), e); room('error', e); break;
    case 'note': note(e.text, e.retry); room('note', e); break;
  }
  curT = null;
}

/* на время перерисовки истории — без звуков, счётчиков, озвучки и реакций компьютера. И без прокрутки вниз после каждого
   сообщения: она заставляет браузер заново раскладывать всю ленту. Вниз — один раз в конце (keep — оставить, где есть) */
function quietly(fn, keep) {
  replaying = true; window.personalComputerReplay = true; const sfxOn = cfg.sfx, u0 = unread, pin0 = pin; cfg.sfx = false; pin = () => {};
  /* и без анимации появления: перерисованное (.np) не «выпрыгивает» заново при каждом переподключении */
  const box = $('#msgs'); box.classList.add('rp');
  try { fn(); foldFlush(); } finally {
    box.querySelectorAll(':scope>:not(.empty)').forEach(n => n.classList.add('np')); box.classList.remove('rp');
    pin = pin0; replaying = false; unread = u0; badge(); if (!keep) pin(true);
    setTimeout(() => { cfg.sfx = sfxOn; window.personalComputerReplay = false; }, 0);
  }
}

/* ---------- длинная история: сначала только последние сообщения ----------
   Сотни ответов с таблицами и кодом рисуются секундами (на слабом телефоне — до четырёх). Поэтому при подключении
   рисуем последние HIST сообщений, а раньше — по кнопке «Показать раньше» или когда долистаешь до неё; позиция не прыгает */
const HIST = 100;
let older = [], seq0 = 0;
const isMsg = e => e.kind === 'user' || e.kind === 'assistant';
/* откуда рисовать: последние n сообщений (твоих и его), начиная с твоего — чтобы шаги инструментов не рвались */
function cutAt(log, n) {
  let k = log.length, c = 0;
  while (k > 0 && c < n) { k--; if (isMsg(log[k])) c++; }
  while (k > 0 && log[k].kind !== 'user') k--;
  return k;
}
const moreIO = 'IntersectionObserver' in window
  ? new IntersectionObserver(es => { if (!pinned && es.some(x => x.isIntersecting)) showOlder(); }, { root: $('#msgs'), rootMargin: '300px 0px 0px 0px' }) : null;
function moreUI() {
  const box = $('#msgs');
  let b = box.querySelector(':scope>.more');
  if (!older.length) { if (b) { moreIO && moreIO.unobserve(b); b.remove(); } return; }
  if (!b) { b = document.createElement('button'); b.type = 'button'; b.className = 'more'; b.onclick = showOlder; b.innerHTML = '<i class="pi"></i><span></span>'; }
  const n = older.filter(isMsg).length;
  b.lastChild.textContent = 'Показать раньше · ещё ' + (n ? plural(n, 'сообщение', 'сообщения', 'сообщений') : plural(older.length, 'запись', 'записи', 'записей'));
  box.prepend(b); moreIO && moreIO.observe(b);
}
/* дорисовать раньше: старые записи рисуем в конец ленты (метка start — чтобы разделитель дня считался заново)
   и переносим наверх. Показанные сообщения не трогаем — иначе их анимация появления проиграется снова */
function showOlder() {
  if (!older.length) return;
  const box = $('#msgs'), h0 = box.scrollHeight, t0 = box.scrollTop, cut = cutAt(older, HIST), part = older.slice(cut);
  older = older.slice(0, cut); seq0 = part[0].seq;
  const b = box.querySelector(':scope>.more'); if (b) { moreIO && moreIO.unobserve(b); b.remove(); }
  const head = box.firstElementChild, start = document.createElement('i'); box.append(start); box._day = start;
  const bubble0 = bubble, cont0 = cont; cont = null;
  olderNow = true;
  /* открытые сейчас — не трогаем; среди дорисованных старых открытым не остаётся ничего */
  const open0 = [...openF]; openF.clear();
  try { quietly(() => { bubble = null; for (const e of part) render(e); foldPrev(false); }, true); } finally { olderNow = false; open0.forEach(m => openF.add(m)); }
  if (cont) cont.remove(); /* старая отметка: после неё уже что-то было */
  bubble = bubble0; cont = cont0;
  const fresh = []; for (let n = start.nextSibling; n; n = n.nextSibling) fresh.push(n);
  start.remove(); box.prepend(...fresh); box._day = null;
  /* тот же день — второй разделитель на стыке не нужен */
  const days = fresh.filter(n => n.classList && n.classList.contains('day')), day = days[days.length - 1];
  if (day && head && head.classList.contains('day') && head.dataset.d === day.dataset.d) head.remove();
  moreUI();
  box.scrollTop = t0 + box.scrollHeight - h0;
}
function welcomeS(cleared) {
  const k = cfg.key, b = cfg.base;
  cfg.key = srvSet && srvSet.hasKey ? 'x' : ''; cfg.base = DEF.base;
  try { welcome(cleared); } finally { cfg.key = k; cfg.base = b; }
}
function onSnap(s) {
  if (s.user) me = s.user;
  seenBuild(s.build);
  /* какой чат на экране: просили другой, а его удалили — сервер прислал последний открытый */
  if (s.c) view = s.c;
  hist.shown(s);
  quietly(() => {
    const box = $('#msgs'); box.innerHTML = ''; bubble = null; cont = null; think(false); room('reset'); openF.clear(); fq.length = 0;
    const cut = cutAt(s.log, HIST);
    older = s.log.slice(0, cut); seq0 = cut < s.log.length ? s.log[cut].seq : 0;
    for (const e of s.log.slice(cut)) render(e);
    if (s.partial) { bubble = add('a', ''); aText(bubble, s.partial); }
    if (!s.log.length) welcomeS(s.seq > 0);
    moreUI();
  });
  setRun(s, true);
  try { window.personalComputerRoom && personalComputerRoom.snap({ ...s, running }); } catch (x) { console.error(x); }
  onQueue(s.queue);
  if (!connected) {
    connected = true; setSt(READY, 'on');
    const n = s.log.filter(e => e.kind === 'user' || e.kind === 'assistant').length;
    bt('ok', 'chat', n ? plural(n, 'сообщение', 'сообщения', 'сообщений') : 'пусто');
    bt('ok', 'agent', s.running ? 'работает' + (s.steps ? ' · шаг ' + s.steps : '') : 'свободен');
    bt('done');
  }
}
function onLog(e) {
  /* обновилась запись, которой нет на экране (она в непоказанной истории) — только запомнить */
  if (e.seq < seq0) { const o = older.find(x => x.seq === e.seq); if (o) Object.assign(o, e); return; }
  render(e);
}
function onDelta(d) {
  think(false);
  if (!bubble) { bubble = add('a', ''); bubble._raw = ''; }
  bubble._raw += d; bubble._b.innerHTML = md(bubble._raw); pin();
  try { window.personalComputerRoom && personalComputerRoom.delta(bubble._raw); } catch (x) {}
}
/* snap — состояние пришло с полной перерисовкой: компьютер в шапке обновит personalComputerRoom.snap, без реакций «началась задача» */
function setRun(r, snap) {
  /* агент один: работает в этом чате — обычный ход работы; в другом — плашка над полем ввода */
  const was = running; running = !!r.running && (!r.rc || r.rc === view);
  busyElse = r.running && r.rc && r.rc !== view ? { c: r.rc, t: r.rt || 'Новый чат' } : null;
  busyUI(); hist.run(r);
  ctl = running ? { abort: stopNow } : null;
  sendUI(running);
  if (!snap) try { window.personalComputerRoom && personalComputerRoom.run({ ...r, running }); } catch (x) { console.error(x); }
  if (running && !bubble) think(true);
  if (!running) { think(false); if (was) setSt(READY, 'on'); }
}

/* «Стоп»: кнопка откликается сразу, а сервер отвечает, когда задача уже остановлена, — итог виден,
   даже если поток событий отстал (телефон только что проснулся, плохая сеть) */
let stopping = false;
async function stopNow() {
  if (stopping) return;
  stopping = true;
  const b = $('#stop'); b.disabled = true; b.title = 'Останавливаю…';
  think(false); setSt('останавливаю…', 'on');
  try { const r = await post('api/chat/stop'); if (!r.running) { setRun(r); setSt(READY, 'on'); } }
  catch (e) { if (e.status === 401) check(); else { add('e', esc('Не получилось остановить: ' + e.message)); setSt(READY, 'on'); } }
  finally { stopping = false; b.disabled = false; b.title = 'Остановить (Esc)'; }
}

/* ---------- сообщения во время работы ----------
   Пока Personal Computer работает, написанное ждёт ближайшей паузы между шагами (после команды или ответа модели) — здесь, над полем
   ввода. Уйдёт модели — появится в переписке на своём месте. «Прочитать сейчас» бросает текущий шаг, «X» — отзывает
   сообщение: текст (и вложения, если отправляла эта вкладка) возвращаются в поле ввода */
const qbox = document.createElement('div');
qbox.id = 'queue'; qbox.hidden = true; qbox.setAttribute('aria-live', 'polite');
$('#chips').before(qbox);
const held = new Map(); /* id сообщения в очереди → вложения (File) */
function onQueue(q) {
  q = Array.isArray(q) ? q : [];
  try { window.personalComputerRoom && personalComputerRoom.queue(q); } catch (x) {}
  for (const id of [...held.keys()]) if (!q.some(x => x.id === id)) held.delete(id);
  qbox.hidden = !q.length; qbox.innerHTML = '';
  if (!q.length) return;
  const h = document.createElement('div'); h.className = 'qh';
  h.innerHTML = '<span></span><button class="pbtn sm" type="button" data-qnow title="Бросить текущий шаг и прочитать сразу"><i class="pi"></i><span>Прочитать сейчас</span></button>';
  h.firstChild.textContent = (q.length > 1 ? plural(q.length, 'сообщение', 'сообщения', 'сообщений') + ' · ' : '') + 'Personal Computer прочтёт после текущего шага';
  qbox.append(h);
  for (const x of q) {
    const d = document.createElement('span'), n = document.createElement('span'), b = document.createElement('button');
    const fl = (x.files || []).map(f => '+ ' + f.name).join(' ');
    d.className = 'chip'; n.className = 'n'; d.title = x.text || fl;
    n.textContent = [String(x.text || '').replace(/\s+/g, ' ').trim(), fl].filter(Boolean).join(' ');
    b.type = 'button'; b.textContent = 'X'; b.dataset.qx = x.id; b.setAttribute('aria-label', 'Отозвать сообщение'); b.title = 'Отозвать — вернуть в поле ввода';
    d.append(n, b); qbox.append(d);
  }
}
qbox.addEventListener('click', async e => {
  const now = e.target.closest('[data-qnow]');
  if (now) {
    now.disabled = true; now.lastChild.textContent = 'Читаю…';
    try { if (!(await post('api/chat/now')).ok) { now.disabled = false; now.lastChild.textContent = 'Прочитать сейчас'; } }
    catch (x) { if (x.status === 401) check(); else add('e', esc(x.message)); now.disabled = false; now.lastChild.textContent = 'Прочитать сейчас'; }
    return;
  }
  const b = e.target.closest('[data-qx]'); if (!b) return;
  const id = b.dataset.qx; b.disabled = true;
  try {
    const r = await post('api/chat/unqueue', { id }), i = $('#inp');
    if (r.text) { i.value = i.value.trim() ? r.text + '\n' + i.value : r.text; i.dispatchEvent(new Event('input')); }
    const fs = held.get(id); if (fs && fs.length) { staged.push(...fs); renderChips(); }
    i.focus();
  } catch (x) { if (x.status === 401) check(); else if (x.status !== 404) add('e', esc(x.message)); b.disabled = false; }
});

/* ---------- поток событий ---------- */
function connect() {
  if (es || !me) return;
  es = new EventSource('api/stream' + (view ? '?c=' + view : ''));
  es.addEventListener('snap', e => onSnap(JSON.parse(e.data)));
  es.addEventListener('log', e => onLog(JSON.parse(e.data)));
  es.addEventListener('delta', e => onDelta(JSON.parse(e.data).d));
  es.addEventListener('run', e => setRun(JSON.parse(e.data)));
  /* контекст агента вырос за шаг — цвет экрана и жалобы компьютера */
  es.addEventListener('ctx', e => { try { window.personalComputerRoom && personalComputerRoom.ctx(JSON.parse(e.data).ctx); } catch (x) {} });
  es.addEventListener('queue', e => onQueue(JSON.parse(e.data).queue));
  es.addEventListener('chats', () => hist.changed());
  /* этот чат удалили (в другой вкладке или в Telegram) — переходим в новый */
  es.addEventListener('gone', () => hist.fresh(true));
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
  /* приложение открывается в новом чате (пустой сервер отдаёт повторно); старые — в истории */
  if (!view) try { view = (await post('api/chats')).c; } catch (e) {}
  connect();
  initPane();
  updBoot(true);
}
function mirror() {
  if (!srvSet) return;
  Object.assign(cfg, { base: srvSet.base, model: srvSet.model, sys: srvSet.sys, vis: srvSet.vis, stepLimit: srvSet.stepLimit, maxSteps: srvSet.maxSteps, key: '' });
  provSaved = Object.fromEntries((srvSet.provs || []).map(p => [p.base, p]));
  provOpts();
}

/* ---------- отправка ---------- */
/* во время работы сообщение не отклоняется: сервер ставит его в очередь, и Personal Computer прочтёт его между шагами */
window.srvSubmit = async () => {
  if (upBusy) return;
  const i = $('#inp'), t = i.value.trim(), fs = staged.slice();
  if (!t && !fs.length) return;
  if (busyElse) { busyNudge(); return; }
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
  try {
    const r = await post('api/chat', { text: t, files, parts, c: view });
    if (r && r.queued) { if (fs.length) held.set(r.queued, fs); window.sfx && sfx('send'); }
  } catch (e) {
    if (e.status === 401) return check();
    if (!i.value) { i.value = t; i.dispatchEvent(new Event('input')); }
    /* агент занят в другом чате (запустили с другого устройства) — подсказка над полем, текст остаётся */
    if (e.j && e.j.busy) { busyElse = busyElse || { c: null, t: '' }; busyNudge(e.message); return; }
    add('e', esc(e.message));
  }
};
/* «Повторить» после ошибки — на сервере (перехватываем раньше общего обработчика кнопок в чате) */
$('#msgs').addEventListener('click', e => {
  const b = e.target.closest('[data-act=sretry]'); if (!b) return;
  e.stopImmediatePropagation(); b.closest('.ea')?.remove();
  post('api/chat/retry', { c: view }).catch(x => { if (x.j && x.j.busy) busyNudge(x.message); else add('e', esc(x.message)); });
}, true);

/* ---------- настройки: модель хранится на сервере, ключ наружу не отдаётся ---------- */
let clearKey = false;
const openSet0 = openSet;
openSet = function (p) {
  clearKey = false;
  (async () => {
    try { srvSet = await api('api/settings'); mirror(); } catch (e) { if (e.status === 401) return check(); }
    openSet0(p || (srvSet && srvSet.hasKey ? 'me' : 'ai'));
    $('#c-key').value = '';
    refreshPane();
  })();
};
$('#c-reset').onclick = async () => {
  if (!await ask('Сброс', 'Вернуть настройки как было с завода? Ключи API всех сохранённых провайдеров тоже сотрутся. Применится после «Сохранить».', null, 'Сбросить')) return;
  fill(DEF); $('#c-sys').value = ''; $('#c-steps').value = srvSet?.maxStepsDef || DEF.maxSteps; $('#c-key').placeholder = 'sk-…'; $('#c-forget').hidden = true; clearKey = true;
};
/* забыть сохранённого провайдера: ключ и модель стираются на сервере сразу, без «Сохранить» */
$('#c-forget').onclick = async () => {
  const base = $('#c-base').value.trim().replace(/\/+$/, ''), sv = provSaved[base]; if (!sv) return;
  const name = prov.options[prov.selectedIndex]?.text.replace(/ ✓$/, '') || base;
  const act = base === String(srvSet?.base || '').replace(/\/+$/, '');
  if (!await ask('Провайдер', 'Забыть ' + name + '? Ключ API и модель для него сотрутся с сервера.' + (act ? ' Сейчас Personal Computer работает через него — без ключа модель отвечать не будет.' : ''), null, 'Забыть')) return;
  try {
    srvSet = await api('api/settings', { method: 'PUT', json: { forget: base } });
    provSaved = Object.fromEntries((srvSet.provs || []).map(p => [p.base, p])); provOpts();
    $('#c-key').value = ''; syncSet(); loadModels();
  } catch (e) { const h = $('#mh'); h.textContent = 'Не получилось: ' + e.message; h.dataset.s = 'err'; }
};
$('#c-save').onclick = async () => {
  const st = readSteps(); if (!st) return;
  cfg.tts = $('#c-tts').checked; cfg.sfx = $('#c-sfx').checked; cfg.room = $('#c-room').checked; cfg.vlang = $('#c-vlang').value;
  try { window.personalComputerRoom && personalComputerRoom.sndUI(); } catch (x) {}
  if (!cfg.tts && window.personalComputerStop) personalComputerStop();
  const body = { base: $('#c-base').value.trim(), model: $('#c-model').value.trim(), sys: $('#c-sys').value.trim(), vis: $('#c-vis').checked, ...st };
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
    if ((e.status === 401 || e.status === 403 || u === 401 || u === 403) && !key && !(provSaved[base] && provSaved[base].hasKey)) { h.textContent = 'Вставь API ключ — после этого загружу список моделей'; delete h.dataset.s; return; }
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
/* оформление папок и вкладок окна — в index.html (слой v10: значок по data-k, итог справа, стрелка) */

/* ---------- вкладка «Сервер»: Аккаунт и Telegram ---------- */
const lxTab = $('#t-lx'), lxPane = $('#p-lx');
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
    pxLoad();
    $('#s-acct').textContent = a.user.name + (a.user.admin ? ' · администратор' : '') + ' · сессий: ' + a.sessions;
    foldMeta(fAcct, a.user.name + (a.user.admin ? ' · админ' : ''));
    $('#s-inv').hidden = !a.user.admin;
    $('#s-note').textContent = 'Рабочая папка на сервере: ' + a.work + (a.users ? ' · пользователей: ' + a.users.length : '');
    const s = $('#s-tg'), bb = $('#s-tgb'); bb.innerHTML = '';
    $('#s-tokf').hidden = t.connected; $('#s-ntf').hidden = !t.connected;
    foldMeta(fTg, !t.connected ? 'не подключён' : t.error ? 'ошибка' : '@' + t.bot + (t.linked ? '' : ' · не привязан'), t.connected && !!t.error);
    if (!t.connected) {
      s.textContent = 'Не подключён. Создай бота у @BotFather (/newbot) и вставь токен — или просто попроси в чате: «подключи Telegram».';
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
        if (!await ask('Telegram', 'Отключить бота от Personal Computer? Управление и уведомления перестанут работать.', null, 'Отключить')) return;
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
    const v = await ask('Приглашение', 'Одноразовая ссылка для регистрации (7 дней). Помни: у каждого пользователя Personal Computer есть доступ к терминалу сервера — приглашай только тех, кому доверяешь.', r.url, 'Скопировать');
    if (v != null) navigator.clipboard?.writeText(r.url).catch(() => {});
  } catch (e) { await ask('Приглашение', e.message, null, 'OK'); }
};
const logout = async all => {
  if (!await ask('Выход', all ? 'Выйти на всех устройствах? Personal Computer продолжит работать на сервере.' : 'Выйти? Personal Computer продолжит работать на сервере.', null, 'Выйти')) return;
  await post('api/logout' + (all ? '?all=1' : '')).catch(() => {});
  $('#dlg').close(); me = null; if (es) { es.close(); es = null; } connected = false;
  $('#msgs').innerHTML = ''; check();
};
$('#s-out').onclick = () => logout(false);
$('#s-outall').onclick = () => logout(true);

/* ---------- обновления ----------
   Сервер сам смотрит на GitHub, что нового. Если вышла новая версия, администратору при входе
   показывается окошко с Personal Computer: что изменилось и «Позже» / «Обновить». Обновляет root-служба на сервере
   (server/bin/personalcomputer-update): окошко показывает её шаги, переживает перезапуск сервера и перезагружает страницу.
   Остальные открытые страницы перезагружаются сами, когда видят новую сборку (build в snap). */
css.textContent += `
#upd{max-width:460px}
#upd .ubody{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:18px 20px 20px;font-size:9px;line-height:1.8}
#upd .uhead{display:flex;align-items:center;gap:18px}
#upd canvas{flex:none;width:106px;height:106px;image-rendering:pixelated}
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
/* в окошке — сам Personal Computer из верхней панели (там же меняем ему настроение; при обновлении экран показывает «ОБНОВЛЕНИЕ %») */
const upc = upd.querySelector('canvas'); upc.width = 106; upc.height = 106;
let upT = 0;
function upDraw(t) {
  if (!upd.open) return;
  requestAnimationFrame(upDraw);
  if (t - upT < 33) return; upT = t;
  try { window.personalComputerRoom && personalComputerRoom.mirror(upc.getContext('2d'), upc.width, upc.height); } catch (e) {}
}

const UPH = {
  offer: ['Ура! Вышло обновление!', 'Ура, есть обновление! Обновимся?', 'Смотри, я научился новому! Обновим?', 'Свеженькая версия приехала!'],
  unknown: ['Не знаю, какая у меня версия… Обновимся до свежей?'],
  fresh: ['У меня самая свежая версия!', 'Обновлений нет — я и так новенький ^_^'],
  done: ['Готово! Я обновился ^_^', 'Ура! Я теперь новенький!', 'Обновился! Сейчас перезагружусь~'],
  fail: ['Ой… обновиться не получилось', 'Хнык… обновление не вышло'],
};
const upick = a => a[Math.random() * a.length | 0];
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return n + ' ' + (m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c); };
const dday = s => { const d = s ? new Date(s) : null; return d && !isNaN(d) ? d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : ''; };
const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'только что' : m < 60 ? m + ' мин назад' : m < 1440 ? Math.round(m / 60) + ' ч назад' : dday(t); };
const ver = (c, d) => (c && c.commit ? c.commit : 'неизвестно') + ((d || c && c.date) ? ' от ' + dday(d || c.date) : '');
/* доля готовности — по шагам установщика (он печатает их по порядку) */
const UPCT = [[/что нового/, 4], [/Устанавливаю Personal Computer/, 8], [/системные пакеты/, 12], [/Пакеты на месте/, 26], [/Node\.js/, 38], [/ttyd/, 46], [/Xray/, 49], [/Caddy/, 52],
  [/код Personal Computer/, 58], [/^Код:/, 68], [/Запускаю службы/, 76], [/Сервер Personal Computer работает/, 88], [/сертификат/, 92], [/HTTPS/, 96]];
const pct = steps => steps.reduce((p, s) => Math.max(p, ...UPCT.filter(([re]) => re.test(s.t)).map(x => x[1])), 3);
/* «Позже» — не напоминать об этой версии сутки */
const LATER = 'personalcomputer-upd-later';
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
  if (!i.admin) unote(m, 'Обновить Personal Computer может администратор сервера.');
  else if (!i.ready) unote(m, 'Чтобы обновлять прямо отсюда, один раз выполни на сервере «sudo personalcomputer update» — эта команда поставит службу обновления. Дальше хватит кнопки.');
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
  const up = st.state === 'queued' ? 3 : pct(steps);
  m.querySelector('.ubar i').style.width = up + '%';
  try { window.personalComputerRoom && personalComputerRoom.update(up); } catch (x) {} /* экран компьютера в шапке: «ОБНОВЛЕНИЕ n%» */
  const ul = m.querySelector('.ust'); ul.innerHTML = '';
  /* «🐾 делаю…» мигает, только пока это последний шаг; пройденные — точкой */
  steps.slice(-6).forEach((s, k, a) => ul.append(el('li', s.k === 'run' && (k < a.length - 1 || st.state !== 'running') ? 'past' : s.k, s.t)));
  m.querySelector('.note')?.remove();
  const stuck = st.state === 'queued' && Date.now() - st.since > 60e3;
  if (stuck) unote(m, 'Служба обновления на сервере пока не отвечает. Проверь её: «systemctl status personalcomputer-update.path» (на Alpine — «rc-service personalcomputer-updater status»). Обновить можно и командой «sudo personalcomputer update».');
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
      if (Date.now() - uLastOk > 10 * 60e3) return uFail({ error: 'Сервер не отвечает уже 10 минут. Загляни на сервер: «personalcomputer status» и «personalcomputer logs».', steps: uLast ? uLast.steps : [] });
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
  unote(m, 'Повторять не страшно: установщик сохраняет данные и настройки, а Personal Computer работает дальше.');
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
  window.petSet && petSet('wow', 'Я обновился! Сейчас перезагружусь~', 3000);
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
  const lines = [i.known ? 'Стоит версия ' + ver(i.current, i.current.date || i.current.installed) : 'Неизвестно, какая версия стоит: Personal Computer установлен без сведений о сборке.'];
  if (busy) lines.push('Сейчас идёт обновление…');
  else if (i.available) lines.push('Есть новая версия: ' + ver(i.latest) + (i.changes.length ? ' · ' + plural(i.changes.length, 'изменение', 'изменения', 'изменений') + (i.more ? ' и больше' : '') : ''));
  else if (i.available === false) lines.push('Это последняя версия ✓');
  if (i.error) lines.push('Не получилось проверить: ' + i.error);
  if (i.checked) lines.push('Проверено ' + ago(i.checked) + '.');
  else if (i.known && !i.error) lines.push('Ещё не проверял.');
  $('#s-upd').textContent = lines.join('\n'); $('#s-upd').style.whiteSpace = 'pre-line';
  $('#s-updgo').hidden = !(i.admin && i.ready && (busy || i.available || (i.available === null && i.latest)));
  $('#s-updgo span').textContent = busy ? 'Показать ход' : 'Обновить';
  $('#s-updn').textContent = !i.admin ? 'Обновляет администратор сервера.' : !i.ready ? 'Чтобы обновлять из браузера, один раз выполни на сервере «sudo personalcomputer update» — она поставит службу обновления.' : 'Personal Computer проверяет GitHub раз в 6 часов и сам предложит обновиться. Откуда берётся код: ' + (i.repo || '?') + (i.ref && i.ref !== 'HEAD' ? ' (ветка ' + i.ref + ')' : '') + '.';
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
   Обычный пользователь personalcomputer-agent или полный root (sudo без пароля). Переключает root-служба personalcomputer-access:
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
    if (i.mode === 'off') line('Права дал не Personal Computer: sudo для ' + i.user + ' настроен на сервере вручную.');
  } else {
    line('Обычный пользователь ' + i.user + ': без root, только свои папки и то, что разрешено всем.');
    if (i.mode === 'on') line('Root включён, но sudo у агента сейчас не работает. Включи ещё раз или выполни на сервере: sudo personalcomputer root on', 'bad');
  }
  if (!busy && st.state === 'failed') line('Не получилось: ' + (st.error || 'ошибка'), 'bad');
  if (!busy && st.note) line('! ' + st.note);
  const can = i.admin && i.ready;
  const b = $('#s-accgo');
  b.hidden = !can || busy; b.firstChild.textContent = i.root ? 'Забрать root' : 'Дать полный root';
  $('#s-acccn').hidden = !(i.admin && st.state === 'queued' && Date.now() - st.since > 30e3);
  $('#s-accn').textContent = !i.admin ? 'Доступ агента меняет администратор сервера.'
    : !i.ready ? 'Переключатель заработает после «sudo personalcomputer update» на сервере. Сразу — командой там же: sudo personalcomputer root ' + (i.root ? 'off' : 'on') + '.'
    : st.state === 'queued' && Date.now() - st.since > 30e3 ? 'Служба на сервере пока не взяла запрос. Проверь её: «systemctl status personalcomputer-access.path» (на Alpine — «rc-service personalcomputer-updater status») или переключи командой: sudo personalcomputer root ' + (st.want || 'on') + '.'
    : i.root ? 'Терминал: sudo -i — root-оболочка. Забрать root можно в любой момент; то, что агент уже поменял в системе, останется как есть.'
    : 'Полный доступ — как у администратора сервера: sudo без пароля, системные пакеты, службы, файлы в /etc. Включается с паролем от Personal Computer.';
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
      if (accWait) window.petSet && petSet(i.root ? 'love' : 'happy', i.root ? 'Теперь у меня root! Буду бережным ^_^' : 'Root отдал — я снова обычный пользователь', 3500);
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
      + '\n· root получат все пользователи Personal Computer' + (n > 1 ? ' (их ' + n + ')' : '') + ' — агент и терминал у всех общие;'
      + '\n· инструкция, спрятанная на сайте или в файле, который прочтёт агент, сможет управлять всем сервером;'
      + '\n· агенту станут доступны ключи API и пароли Personal Computer.'
      + '\n\nИсполнитель команд и терминал перезапустятся' + (accI && accI.busy ? ': идущие команды оборвутся, агент продолжит сам.' : '.'), null, 'Дальше');
    if (!ok) return;
    const pw = await pwAsk('Полный доступ', 'Подтверди паролем от Personal Computer');
    if (pw == null) return;
    b.disabled = true;
    try { accState(await post('api/access', { root: true, password: pw })); accWait = Date.now(); accTick(); }
    catch (e) { await ask('Полный доступ', 'Не получилось: ' + e.message, null, 'OK'); }
    finally { b.disabled = false; }
  } else {
    if (!await askML('Забрать root', 'Агент снова станет обычным пользователем ' + (accI ? accI.user : 'personalcomputer-agent') + '.\n\nИсполнитель команд и терминал перезапустятся. То, что агент уже поменял в системе с root, останется как есть.', null, 'Забрать')) return;
    b.disabled = true;
    try { accState(await post('api/access', { root: false })); accWait = -Date.now(); accTick(); }
    catch (e) { await ask('Забрать root', 'Не получилось: ' + e.message, null, 'OK'); }
    finally { b.disabled = false; }
  }
}
$('#s-accgo').onclick = () => accI && accSet(!accI.root);
$('#s-acccn').onclick = async () => { try { accState(await api('api/access', { method: 'DELETE' })); accWait = 0; clearTimeout(accPoll); } catch (e) { $('#s-accn').textContent = e.message; } };

/* ---------- настройки → Сервер → «Прокси» ----------
   Ключ vless/vmess/trojan/ss/hysteria2, socks5/http или ссылка на подписку. Через прокси идёт то, что сервер отправляет
   в интернет: модель, поиск и MCP, Telegram, команды агента и терминал, проверка обновлений (что именно — выбирается ниже).
   Ключи хранятся на сервере и сюда не возвращаются: видно только имя, протокол и адрес. Менять может администратор. */
const fPx = fold('px', 'Прокси');
fTg.after(fPx);
css.textContent += `
#p-srv #s-px{white-space:pre-line}#p-srv #s-px b{color:var(--acc);font-weight:normal}#p-srv #s-px .bad{color:var(--err)}
#p-srv .pxl{display:flex;flex-direction:column;gap:8px;margin:16px 2px 0}
#p-srv .pxg{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:10px 2px 0;color:var(--mut);font:7px/1.7 var(--pf)}
#p-srv .pxg b{color:var(--fg);font-weight:normal}#p-srv .pxg .bad{color:var(--err)}#p-srv .pxg .pbtn{margin:2px}
#p-srv .pxr{position:relative;display:flex;align-items:center;gap:12px;width:100%;margin:0;padding:10px 6px 10px 12px;background:var(--bg);color:var(--fg);text-align:left;box-shadow:var(--sh2);cursor:pointer;transition:background-color .15s}
#p-srv .pxr::before{content:"";flex:none;width:10px;height:10px;background:var(--bg);box-shadow:var(--sh2)}
#p-srv .pxr[aria-checked=true]::before{background:var(--acc)}
#p-srv .pxr[aria-checked=true] .pxn{color:var(--acc)}
#p-srv .pxr[aria-disabled=true]{cursor:default}
@media(hover:hover){#p-srv .pxr:not([aria-disabled=true]):hover{background:color-mix(in srgb,var(--acc) 7%,var(--bg))}}
#p-srv .pxr:focus-visible{outline:none;box-shadow:var(--sh2),0 0 0 4px color-mix(in srgb,var(--acc) 35%,transparent)}
#p-srv .pxm{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
#p-srv .pxn{font:8px/1.5 var(--pf);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#p-srv .pxd{font:7px/1.6 var(--pf);color:var(--mut);overflow-wrap:anywhere}
#p-srv .pxd.ok{color:var(--ok)}#p-srv .pxd.bad{color:var(--err)}
#p-srv .pxx{flex:none;display:flex;padding:9px;color:var(--mut)}#p-srv .pxx:hover,#p-srv .pxx:focus-visible{color:var(--err)}
#p-srv .pxx .pi{--ico:var(--j-trash);width:14px;height:14px}
#p-srv .pxe{margin:14px 2px 0;color:var(--mut);font:7px/1.7 var(--pf)}
#p-srv .xmsg{display:block;margin:12px 4px 0;font-size:9px;line-height:1.7;color:var(--err);white-space:pre-line;overflow-wrap:anywhere}#p-srv .xmsg:empty{display:none}#p-srv .xmsg[data-s=ok]{color:var(--ok)}#p-srv .xmsg[data-s=wait]{color:var(--mut)}
#dlg .fold[data-k=px]>summary::before{content:"";flex:none;width:20px;height:20px;background:var(--acc);-webkit-mask:var(--j-globe) center/contain no-repeat;mask:var(--j-globe) center/contain no-repeat}
#dlg .fold>summary .fm.pxon{color:var(--acc)}
`;
const PX_USE = [
  ['model', 'Модель', 'Запросы к API модели'],
  ['mcp', 'Поиск и MCP-серверы', 'Поиск в интернете, внешние инструменты, установка навыков по ссылке'],
  ['tg', 'Telegram', 'Бот: команды и уведомления'],
  ['agent', 'Команды агента и терминал', 'HTTP_PROXY и HTTPS_PROXY для curl, pip, npm, git… В терминале — в новых окнах'],
  ['upd', 'Проверка обновлений', 'Запросы к GitHub'],
];
let pxI = null, pxMsgT = ['', ''], pxDraft = '';
const fmtB = n => n >= 2 ** 40 ? (n / 2 ** 40).toFixed(1) + ' ТБ' : n >= 2 ** 30 ? (n / 2 ** 30).toFixed(1) + ' ГБ' : Math.round(n / 2 ** 20) + ' МБ';
const pxRes = t => !t ? '' : t.ok ? '✓ выход ' + (t.loc ? t.loc + ' · ' : '') + t.ip + ' · ' + t.ms + ' мс' : '✗ ' + t.err;
function pxSay(t, s) { pxMsgT = [t || '', s || '']; const m = $('#s-pxm'); if (!m) return; m.textContent = pxMsgT[0]; if (pxMsgT[1]) m.dataset.s = pxMsgT[1]; else delete m.dataset.s; }
/* итог проверки — по-человечески: куда выходим, чем это отличается от сервера, отвечает ли модель */
function pxTold(r) {
  if (!r.ok) return 'Не работает: ' + r.err;
  const a = ['Работает: выход ' + (r.loc ? r.loc + ' · ' : '') + r.ip + ' · ' + r.ms + ' мс'];
  if (r.direct) a.push(r.direct.ip === r.ip ? 'Осторожно: адрес тот же, что у сервера без прокси (' + r.direct.ip + ')' : 'Без прокси сервер выходит как ' + (r.direct.loc ? r.direct.loc + ' · ' : '') + r.direct.ip);
  const m = r.model;
  if (m) a.push(m.err ? 'Модель (' + m.host + ') через прокси не отвечает: ' + m.err
    : m.region ? 'Модель (' + m.host + ') не работает в стране выхода — выбери сервер в другой стране'
    : m.status === 401 || m.status === 403 ? 'Модель (' + m.host + ') отвечает, но не принимает ключ API (HTTP ' + m.status + ') — проверь его на вкладке «Модель»'
    : 'Модель (' + m.host + ') отвечает: HTTP ' + m.status + ' · ' + m.ms + ' мс');
  return a.join('\n');
}
function pxSw(title, sub, on, fn) {
  const l = el('label', 'sw'), s = el('span', null, title), i = el('input');
  if (sub) s.append(el('small', null, sub));
  i.type = 'checkbox'; i.setAttribute('role', 'switch'); i.checked = on;
  i.onchange = async () => { i.disabled = true; try { await fn(i.checked); } catch (e) { i.checked = !i.checked; pxSay(e.message); } finally { i.disabled = false; } };
  l.append(s, i); return l;
}
const pxBtn = (txt, fn, cls = 'pbtn') => { const b = el('button', cls); b.type = 'button'; b.append(el('span', null, txt)); b.onclick = async () => { b.disabled = true; try { await fn(b); } catch (e) { pxSay(e.message); } finally { b.disabled = false; } }; return b; };

async function pxLoad() { try { pxRender(await api('api/proxy')); } catch (e) { if (e.status === 401) check(); } }
async function pxPut(body, quiet) {
  const i = await api('api/proxy', { method: 'PUT', json: body });
  pxRender(i);
  /* включили или сменили сервер — сразу видно, куда теперь выходим */
  if (!quiet && i.on && (body.on || body.active)) await pxRun();
  return i;
}
async function pxRun(id) {
  pxSay('Проверяю: подключаюсь через прокси и узнаю адрес выхода…', 'wait');
  try {
    const r = await post('api/proxy/test', id ? { id } : {});
    pxRender(r.state); pxSay(pxTold(r.result), r.result.ok && !(r.result.model && (r.result.model.err || r.result.model.region)) ? 'ok' : '');
    if (window.petSet) petSet(r.result.ok ? 'happy' : 'sad', r.result.ok ? 'Прокси работает' + (r.result.loc ? ': выхожу из ' + r.result.loc : '') + ' ^_^' : 'Прокси не отвечает…', 3000);
  } catch (e) { pxSay(e.message); }
}

function pxRender(i) {
  if (!i || !i.status) return;
  pxI = i;
  const b = fPx.body, draft = $('#s-pxk') ? $('#s-pxk').value : pxDraft, by = $('#s-pxby') ? $('#s-pxby').value : null;
  const st = i.status, act = i.servers.find(s => s.id === i.active) || null, adm = i.admin, y = $('#dlg .sbody').scrollTop;
  b.innerHTML = '';
  /* что сейчас */
  const box = el('span', 'tgs'); box.id = 's-px';
  const line = (t, cls) => { if (box.childNodes.length) box.append('\n'); box.append(cls ? el('span', cls, t) : t); };
  if (!i.on) line(i.servers.length ? 'Выключен: сервер ходит в интернет напрямую.' + (act ? ' Выбран «' + act.name + '».' : '') : 'Не настроен. Вставь ключ vless://, vmess://, trojan://, ss://, hysteria2://, socks5:// или ссылку на подписку — и включи.');
  else if (st.state === 'starting') line('Запускаю прокси…');
  else if (st.state === 'ok' && act) { box.append('Работает через '); box.append(el('b', null, '«' + act.name + '»')); box.append(' — ' + act.desc + (st.mode === 'direct' ? ' (без Xray, напрямую из сервера)' : '')); if (act.test) line(pxRes(act.test), act.test.ok ? null : 'bad'); }
  else { line('Не работает: ' + (st.err || 'ошибка'), 'bad'); line('Пока прокси не заработает, запросы через него не уходят никуда — в том числе напрямую. Выбери другой сервер или выключи прокси.'); }
  if (!i.core) line('Ядра Xray на сервере нет: без него работают только socks5:// и http://. Обнови Personal Computer — установщик поставит Xray.');
  b.append(box);
  if (adm) b.append(pxSw('Через прокси', 'Запросы сервера идут через выбранный ниже сервер', i.on, v => pxPut({ on: v })));
  /* серверы: свои, потом по подпискам */
  if (i.servers.length) {
    const lst = el('div', 'pxl'); lst.setAttribute('role', 'radiogroup'); lst.setAttribute('aria-label', 'Серверы прокси');
    const row = s => {
      const r = el('div', 'pxr'), m = el('span', 'pxm');
      r.setAttribute('role', 'radio'); r.setAttribute('aria-checked', String(s.id === i.active)); r.tabIndex = s.id === i.active || !act ? 0 : -1;
      if (!adm) r.setAttribute('aria-disabled', 'true');
      m.append(el('span', 'pxn', s.name), el('span', 'pxd', s.desc + ' · ' + (s.host.includes(':') ? '[' + s.host + ']' : s.host) + ':' + s.port + (s.pinned ? ' · сертификат закреплён' : '') + (s.xray && !i.core ? ' · нужен Xray' : '')));
      if (s.test) m.append(el('span', 'pxd ' + (s.test.ok ? 'ok' : 'bad'), pxRes(s.test)));
      r.append(m);
      const pick = async () => { if (!adm || s.id === i.active) return; pxSay('Переключаю на «' + s.name + '»…', 'wait'); try { await pxPut({ active: s.id }); if (!pxI.on) pxSay('Выбран «' + s.name + '». Включи прокси, когда будешь готов.', 'ok'); } catch (e) { pxSay(e.message); } };
      r.onclick = e => { if (!e.target.closest('.pxx')) pick(); };
      r.onkeydown = e => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pick(); return; }
        const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0; if (!d) return;
        e.preventDefault(); const all = [...lst.querySelectorAll('.pxr')], n = all[(all.indexOf(r) + d + all.length) % all.length]; n.focus();
      };
      if (adm && !s.sub) {
        const x = el('button', 'pxx'); x.type = 'button'; x.title = 'Удалить «' + s.name + '»'; x.setAttribute('aria-label', x.title); x.append(el('i', 'pi'));
        x.onclick = async () => {
          if (!await ask('Прокси', 'Удалить «' + s.name + '»?' + (s.id === i.active && i.on ? ' Сейчас сервер работает через него — прокси переключится на следующий из списка или выключится.' : ''), null, 'Удалить')) return;
          try { pxRender((await api('api/proxy/servers/' + s.id, { method: 'DELETE' })).state); pxSay(''); } catch (e) { pxSay(e.message); }
        };
        r.append(x);
      }
      return r;
    };
    for (const s of i.servers.filter(s => !s.sub)) lst.append(row(s));
    for (const sb of i.subs) {
      const g = el('div', 'pxg'), inf = sb.info || {};
      g.append(el('b', null, 'Подписка «' + sb.name + '»'), (sb.n || 0) + ' · обновлена ' + (sb.t ? ago(sb.t) : '—'));
      if (inf.total) g.append(' · трафик ' + fmtB(inf.used || 0) + ' из ' + fmtB(inf.total));
      if (inf.expire) g.append(' · до ' + dday(inf.expire * 1000));
      if (sb.err) g.append(el('span', 'bad', ' · ' + sb.err));
      if (adm) {
        g.append(pxBtn('Обновить', async () => { pxSay('Обновляю подписку…', 'wait'); const r = await post('api/proxy/subs/' + sb.id); pxRender(r.state); pxSay('Подписка обновлена: серверов ' + r.n + (r.errors && r.errors.length ? '. Не подошли: ' + r.errors.slice(0, 3).join('; ') : ''), 'ok'); }, 'pbtn sm'));
        g.append(pxBtn('Удалить', async () => { if (!await ask('Прокси', 'Удалить подписку «' + sb.name + '» вместе с её серверами?', null, 'Удалить')) return; pxRender((await api('api/proxy/subs/' + sb.id, { method: 'DELETE' })).state); pxSay(''); }, 'pbtn sm'));
      }
      lst.append(g);
      for (const s of i.servers.filter(s => s.sub === sb.id)) lst.append(row(s));
    }
    b.append(lst);
  }
  if (adm) {
    const f = el('label', 'f', 'Ключ или подписка'), t = el('textarea');
    t.id = 's-pxk'; t.rows = 3; t.spellcheck = false; t.autocomplete = 'off'; t.setAttribute('autocapitalize', 'off'); t.value = draft;
    t.placeholder = 'vless://…  vmess://…  trojan://…  ss://…  hysteria2://…  socks5://…  или https://… (подписка)';
    t.oninput = () => { pxDraft = t.value; };
    f.append(t); b.append(f);
    const rw = el('div', 'row2');
    rw.append(pxBtn('Добавить', async () => {
      const v = t.value.trim(); if (!v) { pxSay('Вставь ключ или ссылку на подписку'); t.focus(); return; }
      pxSay(/^https?:\/\/\S+\/\S/.test(v) ? 'Скачиваю подписку…' : 'Проверяю ключ…', 'wait');
      const r = await post('api/proxy/add', { text: v });
      t.value = pxDraft = '';
      pxRender(r.state);
      const sel = r.state.servers.find(s => s.id === r.state.active);
      pxSay((r.sub ? 'Подписка добавлена: серверов ' + r.added : r.added ? 'Добавлено: ' + plural(r.added, 'сервер', 'сервера', 'серверов') : 'Такой ключ уже есть') + (sel && r.ids.includes(sel.id) ? ' · выбран «' + sel.name + '»' : '') + '.'
        + (r.errors.length ? '\nНе подошли: ' + r.errors.slice(0, 3).join('; ') + (r.errors.length > 3 ? ' и ещё ' + (r.errors.length - 3) : '') : '')
        + (r.selErr ? '\nНе переключил: ' + r.selErr : '')
        + (!r.state.on && !r.selErr ? '\nВключи «Через прокси», когда будешь готов.' : ''), r.selErr ? '' : 'ok');
      if (r.state.on && sel && r.ids.includes(sel.id) && !r.selErr) await pxRun();
    }));
    const tb = pxBtn('Проверить', () => pxRun()); tb.hidden = !act; rw.append(tb);
    b.append(rw);
  }
  const msg = el('small', 'xmsg'); msg.id = 's-pxm'; msg.setAttribute('role', 'status'); b.append(msg); pxSay(...pxMsgT);
  if (adm) {
    const U = fold('px:use', 'Что идёт через прокси', PX_USE.filter(([k]) => i.use[k]).length + ' из ' + PX_USE.length);
    for (const [k, title, sub] of PX_USE) U.body.append(pxSw(title, sub, !!i.use[k], v => pxPut({ use: { [k]: v } }, true)));
    const bf = el('label', 'f', 'Без прокси: домены и адреса через запятую или с новой строки'), bt = el('textarea');
    bt.id = 's-pxby'; bt.rows = 2; bt.spellcheck = false; bt.setAttribute('autocapitalize', 'off'); bt.value = by ?? i.bypass; bt.placeholder = 'example.com, *.corp.lan, 203.0.113.0/24';
    bf.append(bt); U.body.append(bf);
    U.body.append(pxBtn('Сохранить исключения', async () => { await pxPut({ bypass: bt.value }, true); pxSay('Исключения сохранены', 'ok'); }, 'pbtn xgo'));
    U.body.append(el('small', 'pxe', 'Локальные адреса — localhost, 127.x, 10.x, 172.16–31.x, 192.168.x, *.local и имена без точки (свой Ollama, LM Studio) — всегда идут напрямую.'));
    b.append(U);
  }
  b.append(el('small', 'note', adm ? 'Ключи и подписки хранятся на сервере и в браузер не возвращаются. Подписки обновляются сами раз в 12 часов.' : 'Прокси настраивает администратор сервера.'));
  foldMeta(fPx, !i.on ? 'выкл.' : st.state === 'starting' ? 'запуск…' : st.state === 'ok' ? ((act && act.test && act.test.ok && act.test.loc ? act.test.loc + ' · ' : '') + (act ? act.desc.split(' · ')[0] : '')) : st.state === 'nocore' ? 'нет Xray' : 'не работает', i.on && st.state !== 'ok' && st.state !== 'starting');
  fPx.querySelector(':scope>summary>.fm').classList.toggle('pxon', i.on && st.state === 'ok');
  $('#dlg .sbody').scrollTop = y;
  /* запускается — заглянем ещё раз */
  if (i.on && st.state === 'starting') setTimeout(() => { if ($('#dlg').open) pxLoad(); }, 1500);
}

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
const TL_NAMES = { run_command: 'Команды на сервере', send_file: 'Отправка файлов',
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
  tl.append(el('small', 'xsum', 'Personal Computer видит только включённое. Сейчас описания инструментов занимают ' + tok(weight) + ' в каждом запросе.'));
  const msg = el('small', 'xmsg'); msg.id = 'x-msg'; msg.setAttribute('role', 'status'); msg.textContent = keep[0]; if (keep[1]) msg.dataset.s = keep[1]; tl.append(msg);

  /* встроенные — по группам; внутри группы с несколькими инструментами есть общий переключатель */
  const B = fold('b', 'Встроенные', bOn.length + ' из ' + c.builtin.length + ' · ' + tok(sum(bOn, t => t.size)));
  B.body.append(el('small', 'xs', 'Включает и выключает их только пользователь — Personal Computer этого не может.'));
  const groups = {};
  for (const t of c.builtin) (groups[t.group] ||= []).push(t);
  for (const [g, ts] of Object.entries(groups)) {
    const on = ts.filter(t => t.on), G = fold('b:' + g, g, on.length + '/' + ts.length + ' · ' + tok(sum(on, t => t.size)));
    if (ts.length > 1) G.body.append(swRow('Все', null, on.length === ts.length, v => setTools(Object.fromEntries(ts.map(t => [t.name, v])))));
    for (const t of ts) G.body.append(swRow(TL_NAMES[t.name] || t.name, t.name + ' · ' + tok(t.size), t.on, v => setTools({ [t.name]: v })));
    B.body.append(G);
  }
  tl.append(B);

  /* MCP-серверы: каждый — своя папка */
  const mOn = c.mcp.filter(s => s.on);
  const mBad = c.mcp.some(s => s.on && s.err);
  const M = fold('m', 'MCP-серверы', c.mcp.length ? mOn.length + ' из ' + c.mcp.length + ' вкл.' + (mBad ? ' · ошибка' : '') : 'нет', mBad);
  if (!c.mcp.length) M.body.append(el('small', 'xs', 'Внешние инструменты. Подключи ниже или попроси в чате: «подключи MCP-сервер …».'));
  /* предустановленный сервер удалили или поменяли ему адрес — его можно вернуть как было */
  for (const p of c.presets || []) {
    const b = el('div', 'xb');
    b.append(sbtn('Вернуть: ' + p.title, async () => { const r = await post('api/mcp-restore', { name: p.name }); opened['m:' + p.name] = true; tlMsg(r.err ? p.title + ': вернул, но не подключился: ' + r.err : p.title + ': вернул исходные настройки', !r.err); loadTools(); }));
    M.body.append(b);
  }
  for (const s of c.mcp) {
    const on = s.tools.filter(t => t.on);
    const S = fold('m:' + s.name, s.name, !s.on ? 'выкл.' : s.err ? 'ошибка' : (s.lazy ? 'по запросу' : 'всегда') + (s.known ? ' · ' + on.length + '/' + s.tools.length : ''), s.on && !!s.err);
    if (s.preset) S.body.append(el('small', 'xs', 'Предустановлен в Personal Computer. Его можно выключить или удалить, как любой другой.'));
    S.body.append(el('small', 'xs', (s.server && s.server !== s.name ? s.server + ' · ' : '') + (s.type === 'http' ? s.url : s.command) + (s.headers.length ? ' · заголовки: ' + s.headers.join(', ') : '') + (s.env.length ? ' · env: ' + s.env.join(', ') : '')));
    if (s.desc) S.body.append(el('small', 'xs', s.desc));
    if (s.err) S.body.append(el('small', 'xs bad', 'Ошибка: ' + s.err));
    S.body.append(swRow('Включён', null, s.on, v => post('api/mcp/' + s.name, { on: v }).then(loadTools)));
    S.body.append(swRow('По запросу', 'Инструменты подключаются, только когда понадобятся в работе', s.lazy, v => post('api/mcp/' + s.name, { lazy: v }).then(loadTools)));
    if (s.tools.length) {
      const T = fold('mt:' + s.name, 'Инструменты', on.length + '/' + s.tools.length + ' · ' + tok(sum(on, t => t.size)));
      if (s.tools.length > 1) T.body.append(swRow('Все', null, on.length === s.tools.length, v => post('api/mcp/' + s.name, { tools: Object.fromEntries(s.tools.map(t => [t.name, v])) }).then(loadTools)));
      for (const t of s.tools) T.body.append(swRow(t.name, (t.desc ? t.desc + ' · ' : '') + tok(t.size), t.on, v => post('api/mcp/' + s.name, { tools: { [t.name]: v } }).then(loadTools)));
      S.body.append(T);
    }
    const b = el('div', 'xb');
    b.append(sbtn('Обновить', async () => { const r = await post('api/mcp/' + s.name, { refresh: true }); tlMsg(r.err ? s.name + ': ' + r.err : s.name + ': подключён', !r.err); loadTools(); }));
    b.append(sbtn('Удалить', async () => { if (!await ask('MCP', 'Удалить сервер «' + s.name + '»?' + (s.preset ? ' Сам он не вернётся: подключить снова можно здесь же, по адресу ' + s.url : ''), null, 'Удалить')) return; await api('api/mcp/' + s.name, { method: 'DELETE' }); loadTools(); }));
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
  K.body.append(el('small', 'xs', 'Навык — инструкция SKILL.md для определённых задач. Personal Computer помнит только имена включённых и читает навык целиком, когда он нужен.'));
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
   ttyd рисует xterm.js в iframe с того же адреса, поэтому оформляем его как ЭЛТ-экран:
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

/* цвета: #rrggbb → смесь. Палитра ANSI монохромная, как у старого ЭЛТ-экрана:
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
  let st = d.getElementById('personalcomputer-look');
  if (!st) {
    st = d.createElement('style'); st.id = 'personalcomputer-look';
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
window.personalComputerTermCd = dir => {
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

/* ---------- история чатов ----------
   Кнопка с часами в шапке → окно со списком: новые сверху (по последнему сообщению), по дням, с поиском по названиям
   и тексту. Название сначала — начало первого сообщения, после второго ответа его придумывает модель (карандаш — своё).
   Удаление без вопросов, зато с «Вернуть». Клавиатура: Ctrl+K — история, Ctrl+Shift+O — новый чат, в списке ↑↓ Enter Del F2.
   Агент один: пока он работает в одном чате, другие можно читать, а писать — когда он закончит (плашка над полем ввода) */
const busy = document.createElement('div');
busy.id = 'busy'; busy.hidden = true; busy.setAttribute('role', 'status');
busy.innerHTML = '<i class="pi bi"></i><span class="bt"></span><button class="pbtn sm" type="button" data-b="go"><i class="pi"></i><span>Перейти</span></button><button class="pbtn sm" type="button" data-b="stop"><i class="pi"></i><span>Стоп</span></button>';
$('#chips').before(busy);
function busyUI() {
  busy.hidden = !busyElse;
  if (!busyElse) return;
  busy.querySelector('.bt').textContent = busyElse.t ? 'Работаю в чате «' + busyElse.t + '». Сюда напишешь, когда закончу.' : 'Работаю в другом чате. Сюда напишешь, когда закончу.';
  busy.querySelector('[data-b=go]').hidden = !busyElse.c;
}
/* попытались написать, пока агент занят в другом чате: плашка вздрагивает, текст остаётся в поле */
function busyNudge(msg) {
  if (msg && !busyElse?.t) { const m = /«(.+)»/.exec(msg); if (m) busyElse = { c: busyElse?.c || null, t: m[1] }; }
  busyUI(); busy.classList.remove('nudge'); void busy.offsetWidth; busy.classList.add('nudge');
  window.sfx && sfx('err');
}
busy.addEventListener('click', e => {
  const b = e.target.closest('[data-b]'); if (!b) return;
  if (b.dataset.b === 'go' && busyElse?.c) hist.open(busyElse.c);
  if (b.dataset.b === 'stop') post('api/chat/stop').catch(x => add('e', esc(x.message)));
});

const hist = (() => {
  const btn = $('#hist'), P = el('div', 'chist'), drafts = new Map();
  P.id = 'hpan'; P.hidden = true; P.setAttribute('role', 'dialog'); P.setAttribute('aria-label', 'История чатов');
  P.innerHTML = `<div class="wbar"><button class="wx" type="button" aria-label="Закрыть историю"><i class="pi"></i></button><b>ИСТОРИЯ</b><span></span></div>
<div class="chist-top"><button class="pbtn chist-new" type="button"><i class="pi"></i><span>Новый чат</span><kbd>Ctrl+Shift+O</kbd></button>
<label class="chist-s"><i class="pi"></i><input type="search" placeholder="поиск по чатам" autocomplete="off" spellcheck="false" enterkeyhint="go" aria-label="Поиск по названиям и сообщениям" aria-controls="chist-l"><button type="button" class="chist-x" aria-label="Очистить поиск" hidden><i class="pi"></i></button></label></div>
<div class="chist-l" id="chist-l" role="listbox" aria-label="Чаты"></div>
<div class="chist-f"><span class="chist-n"></span><span class="chist-k">↑↓ выбрать · Enter открыть · F2 имя · Del удалить</span></div>`;
  $('#petbar').append(P);
  const L = P.querySelector('.chist-l'), qi = P.querySelector('input'), qx = P.querySelector('.chist-x');
  let open = false, items = [], loaded = false, q = '', sel = -1, runR = null, t0 = 0, editing = null, moreT = 0, title = '', empty = true;
  const fine = matchMedia('(hover:hover) and (pointer:fine)');

  /* ---- даты: группы «Сегодня / Вчера / Последние 7 дней / … / Сентябрь», справа — время, день недели или число ---- */
  const day = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const ago = t => Math.round((day(Date.now()) - day(t)) / 864e5);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  function group(t) {
    const n = ago(t), d = new Date(t);
    if (n <= 0) return 'Сегодня';
    if (n === 1) return 'Вчера';
    if (n < 7) return 'Последние 7 дней';
    if (n < 30) return 'Последние 30 дней';
    return cap(d.toLocaleDateString('ru-RU', { month: 'long' })) + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
  }
  function when(t) {
    const n = ago(t), d = new Date(t);
    if (n <= 1) return HM.format(d);
    if (n < 7) return d.toLocaleDateString('ru-RU', { weekday: 'short' });
    if (d.getFullYear() !== new Date().getFullYear()) return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
  }
  const full = t => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  /* найденное в тексте — подсветкой */
  function marked(box, text, needle) {
    const lo = text.toLowerCase(), n = needle.toLowerCase();
    let i = 0, k;
    while (n && (k = lo.indexOf(n, i)) >= 0) {
      box.append(text.slice(i, k));
      const m = document.createElement('mark'); m.textContent = text.slice(k, k + n.length); box.append(m);
      i = k + n.length;
    }
    box.append(text.slice(i));
  }

  /* ---- список ---- */
  const rows = () => [...L.querySelectorAll('.crow')];
  async function load() {
    const t = ++t0;
    try {
      const r = await api('api/chats' + (q ? '?q=' + encodeURIComponent(q) : ''));
      if (t !== t0) return;
      items = r.list; loaded = true; runR = r;
      if (!editing) draw();
    } catch (e) {
      if (t !== t0) return;
      if (e.status === 401) { check(); return; }
      L.textContent = ''; L.append(el('p', 'chist-e', 'Список не загрузился: ' + e.message));
    }
  }
  function draw() {
    const keep = rows()[sel]?.dataset.id;
    L.textContent = '';
    if (!loaded) { L.append(el('p', 'chist-e', 'Загружаю…')); return foot(); }
    if (!items.length) L.append(el('p', 'chist-e', q ? 'Ничего не нашёл по «' + q + '»' : 'Здесь будут твои разговоры. Напиши что-нибудь — и чат появится в списке.'));
    let g = null;
    for (const m of items) {
      const gg = q ? 'Найдено' : group(m.last);
      if (gg !== g) { g = gg; const h = el('div', 'chist-g'); h.append(el('span', '', g)); h.setAttribute('role', 'presentation'); L.append(h); }
      const run = !!(runR && runR.running && runR.rc === m.id), on = m.id === view;
      const r = el('div', 'crow' + (on ? ' on' : '') + (run ? ' run' : ''));
      r.dataset.id = m.id; r.id = 'crow-' + m.id; r.tabIndex = -1; r.setAttribute('role', 'option'); r.setAttribute('aria-selected', on);
      r.innerHTML = '<span class="crow-m"><b class="crow-t"></b><span class="crow-p"></span></span><span class="crow-r"><time></time><span class="crow-a"><button type="button" data-ha="ren" title="Переименовать (F2)" aria-label="Переименовать"><i class="pi"></i></button><button type="button" data-ha="del" title="Удалить (Del)" aria-label="Удалить"><i class="pi"></i></button></span></span>';
      const tt = r.querySelector('.crow-t'), pv = r.querySelector('.crow-p'), tm = r.querySelector('time');
      if (q) marked(tt, m.title, q); else tt.textContent = m.title;
      tt.title = m.title;
      if (!m.named) tt.classList.add('draft');
      if (m.hit) marked(pv, m.hit, q); else pv.textContent = m.prev || '';
      tm.dateTime = new Date(m.last).toISOString(); tm.title = full(m.last);
      tm.textContent = run ? 'работаю' : when(m.last);
      r.setAttribute('aria-label', m.title + (run ? ', Personal Computer работает здесь' : '') + (on ? ', открыт сейчас' : '') + ', ' + full(m.last));
      L.append(r);
    }
    const rs = rows();
    sel = keep ? rs.findIndex(x => x.dataset.id === keep) : -1;
    hl(false);
    foot();
  }
  function foot() {
    const n = P.querySelector('.chist-n');
    n.textContent = !loaded ? '' : q ? 'найдено: ' + items.length : items.length ? plural(items.length, 'чат', 'чата', 'чатов') : '';
    P.querySelector('.chist-new').classList.toggle('here', empty);
  }
  /* выбранная строка: подсветка и прокрутка; фокус — если управляют с клавиатуры */
  function hl(focus) {
    const rs = rows();
    rs.forEach((x, k) => x.classList.toggle('sel', k === sel));
    const r = rs[sel];
    if (r) { r.scrollIntoView({ block: 'nearest' }); if (focus) r.focus({ preventScroll: true }); }
    qi.setAttribute('aria-activedescendant', r ? r.id : '');
  }
  function move(d) {
    const rs = rows(); if (!rs.length) return;
    sel = sel < 0 ? (d > 0 ? 0 : rs.length - 1) : Math.max(0, Math.min(rs.length - 1, sel + d));
    hl(true);
  }

  /* ---- открыть, закрыть ---- */
  function show(on) {
    if (on === open) return;
    open = on; P.hidden = !on; btn.setAttribute('aria-expanded', on);
    if (on) {
      if ($('#jrn').getAttribute('aria-expanded') === 'true') $('#jclose').click();
      if (!$('#v-chat').classList.contains('on')) navTo('chat');
      sel = -1; draw(); load();
      /* на телефоне клавиатуру сами не открываем — список виден целиком */
      setTimeout(() => (fine.matches ? qi : P).focus({ preventScroll: true }), 30);
      window.sfx && sfx('key');
    } else if (editing) editing(false);
  }
  P.tabIndex = -1;
  btn.onclick = () => show(!open);
  P.querySelector('.wx').onclick = () => { show(false); btn.focus(); };
  document.addEventListener('pointerdown', e => { if (open && !P.contains(e.target) && !btn.contains(e.target) && !e.target.closest('#ask')) show(false); }, true);

  /* переключиться на чат: текст в поле ввода у каждого чата свой (черновик) */
  function go(id, stay) {
    if (!id) return;
    if (!stay) show(false);
    if (id === view) return;
    const i = $('#inp');
    drafts.set(view, i.value);
    view = id;
    i.value = drafts.get(id) || ''; drafts.delete(id); i.dispatchEvent(new Event('input'));
    if (es) { es.close(); es = null; }
    $('#msgs').classList.add('sw');
    connect();
    if (fine.matches && !stay) i.focus();
  }
  /* новый чат; уже в пустом — просто к полю ввода. stay — окно истории не закрывать (удалили открытый чат) */
  async function fresh(silent, stay) {
    if (!stay) show(false);
    if (!$('#v-chat').classList.contains('on')) navTo('chat');
    if (empty && !silent) { $('#inp').focus(); return; }
    try { go((await post('api/chats')).c, stay); }
    catch (e) { if (e.status === 401) check(); else add('e', esc('Новый чат не создался: ' + e.message)); }
    if (fine.matches && !stay) $('#inp').focus();
  }
  P.querySelector('.chist-new').onclick = () => fresh();

  /* ---- удалить (с «Вернуть»), переименовать ---- */
  const snack = el('div', 'snack'); snack.hidden = true; snack.setAttribute('role', 'status');
  $('#v-chat .mw').append(snack);
  let snT = 0;
  const unsnack = () => { clearTimeout(snT); snack.classList.add('out'); setTimeout(() => { snack.hidden = true; snack.classList.remove('out'); }, 250); };
  async function del(id) {
    const m = items.find(x => x.id === id); if (!m) return;
    const run = runR && runR.running && runR.rc === id;
    if (run && !await ask('Удалить чат', 'Personal Computer сейчас работает в этом чате. Остановить задачу и удалить чат?', null, 'Удалить')) return;
    const rs = rows(), k = rs.findIndex(x => x.dataset.id === id), r = rs[k];
    r && r.classList.add('gone');
    try { await api('api/chats/' + id, { method: 'DELETE' }); }
    catch (e) { r && r.classList.remove('gone'); if (e.status === 401) check(); else add('e', esc('Не удалился: ' + e.message)); return; }
    window.sfx && sfx('key');
    const was = id === view;
    items = items.filter(x => x.id !== id);
    sel = Math.min(k, items.length - 1);
    setTimeout(() => { if (!editing) { draw(); if (open && sel >= 0) hl(true); else if (open) qi.focus(); } }, 180);
    if (was) fresh(true, open);
    snack.innerHTML = '<span></span><button class="pbtn sm" type="button"><i class="pi"></i><span>Вернуть</span></button>';
    snack.firstChild.textContent = 'Чат «' + m.title + '» удалён';
    snack.hidden = false; clearTimeout(snT); snT = setTimeout(unsnack, 8000);
    snack.querySelector('button').onclick = async () => {
      unsnack();
      try { await post('api/chats/' + id + '/restore'); if (was) go(id, open); if (open) load(); }
      catch (e) { add('e', esc('Не получилось вернуть: ' + e.message)); }
    };
  }
  function rename(r) {
    if (editing) editing(false);
    const id = r.dataset.id, m = items.find(x => x.id === id), t = r.querySelector('.crow-t'); if (!m || !t) return;
    const inp = document.createElement('input');
    inp.className = 'crow-in'; inp.value = m.title; inp.maxLength = 80; inp.setAttribute('aria-label', 'Название чата'); inp.spellcheck = false;
    t.replaceWith(inp); r.classList.add('edit'); inp.focus(); inp.select();
    let done = false;
    editing = async ok => {
      if (done) return; done = true; editing = null;
      const v = inp.value.replace(/\s+/g, ' ').trim();
      r.classList.remove('edit');
      if (ok && v && v !== m.title) {
        Object.assign(m, { title: v, named: true });
        api('api/chats/' + id, { method: 'PATCH', json: { title: v } }).catch(e => { add('e', esc('Не переименовался: ' + e.message)); load(); });
        if (id === view) title = v;
      }
      draw();
      if (open) { sel = rows().findIndex(x => x.dataset.id === id); hl(true); }
    };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); editing && editing(true); } else if (e.key === 'Escape') { e.preventDefault(); editing && editing(false); } });
    inp.addEventListener('blur', () => editing && editing(true));
    inp.addEventListener('click', e => e.stopPropagation());
  }

  L.addEventListener('click', e => {
    const r = e.target.closest('.crow'); if (!r || r.classList.contains('edit')) return;
    const a = e.target.closest('[data-ha]');
    if (a) { e.stopPropagation(); if (a.dataset.ha === 'del') del(r.dataset.id); else rename(r); return; }
    go(r.dataset.id);
  });
  /* двойной клик по названию — переименовать */
  L.addEventListener('dblclick', e => { const r = e.target.closest('.crow'); if (r && e.target.closest('.crow-t')) { e.preventDefault(); rename(r); } });

  /* ---- поиск ---- */
  let qT = 0;
  qi.addEventListener('input', () => {
    qx.hidden = !qi.value;
    clearTimeout(qT);
    qT = setTimeout(() => { const v = qi.value.replace(/\s+/g, ' ').trim(); if (v === q) return; q = v; sel = -1; load(); }, 160);
  });
  qx.onclick = () => { qi.value = ''; qi.dispatchEvent(new Event('input')); qi.focus(); };

  /* ---- клавиатура ---- */
  P.addEventListener('keydown', e => {
    if (e.target.classList.contains('crow-in')) return;
    const inQ = e.target === qi, rs = rows(), r = rs[sel];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); return; }
    if (e.key === 'Enter' && !e.isComposing) {
      if (r) { e.preventDefault(); go(r.dataset.id); }
      else if (inQ && rs.length) { e.preventDefault(); go(rs[0].dataset.id); }
      return;
    }
    if (inQ) return;
    if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && r) { e.preventDefault(); del(r.dataset.id); return; }
    if (e.key === 'F2' && r) { e.preventDefault(); rename(r); return; }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); sel = e.key === 'Home' ? 0 : rs.length - 1; hl(true); return; }
    /* начали печатать в списке — это поиск */
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { qi.focus(); }
  });
  /* Esc: сначала закрывает историю (а не останавливает задачу) */
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !open || document.activeElement?.classList.contains('crow-in') || $('#ask').open) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (document.activeElement === qi && qi.value) { qi.value = ''; qi.dispatchEvent(new Event('input')); return; }
    show(false); btn.focus();
  }, true);
  /* Ctrl/⌘+K — история, Ctrl/⌘+Shift+O — новый чат (по коду клавиши: работает и в русской раскладке) */
  addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !me || $('#dlg').open || $('#ask').open || auth.open) return;
    if (e.code === 'KeyK' && !e.shiftKey) { e.preventDefault(); if (!open) show(true); else qi.focus(); }
    else if (e.code === 'KeyO' && e.shiftKey) { e.preventDefault(); fresh(); }
  });
  if (!fine.matches) P.querySelector('.chist-k').hidden = true;

  /* ---- события с сервера ---- */
  let chT = 0;
  return {
    open: go, fresh,
    /* на экране новый чат: подсветка в списке, название — в подсказке кнопки */
    shown(s) {
      title = s.title || ''; empty = !s.log.some(e => e.kind === 'user');
      btn.title = 'История чатов (Ctrl+K)' + (title ? ' · сейчас: «' + title + '»' : '');
      setTimeout(() => $('#msgs').classList.remove('sw'), 0);
      if (open) draw();
    },
    run(r) { runR = { ...(runR || {}), ...r }; if (open && !editing) draw(); },
    /* список поменялся (новое сообщение, название от модели, удаление в другой вкладке) */
    changed() {
      if (!open) return;
      clearTimeout(chT); chT = setTimeout(load, 150);
    },
    sent() { empty = false; foot(); },
  };
})();

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
if (window.personalComputerBoot) personalComputerBoot.onRetry = () => { if (helloT) hello(); else if (me && !connected) { if (es) { es.close(); es = null; } connect(); } };
setSt('подключаюсь к серверу…', 'on');
hello();
})();
