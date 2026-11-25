/* Personal Computer: читалка PDF в проводнике — по одной странице.
   Панель сверху: ‹ [номер ▾] из N › — список всех страниц и листание, масштаб (− % +, «Страница», «По ширине»), поворот.
   Клавиши: ← → — листать, PgUp/PgDn и пробел — по экрану, а у края — на соседнюю страницу, Home/End — первая и последняя,
   + − 0 — масштаб, W — по ширине, R — повернуть. Мышь: Ctrl+колесо — масштаб, колесо у края страницы — листание,
   двойной щелчок — крупнее/обратно. Пальцы: щипок — масштаб, свайп вбок — листание.
   Текст на странице выделяется и копируется (слой текста pdf.js), ссылки оглавления ведут на нужную страницу.
   Рисует pdf.js (server/public/pdfjs, Apache-2.0) — грузится только при первом открытии PDF.
   Модуль зовёт окно просмотра проводника (index.html, vPdf) и получает от него всё нужное в X. */
const here = f => new URL(f, import.meta.url).href;
let lib = null, worker = null, css = null;
const pdfjs = () => lib || (lib = import(here('pdfjs/pdf.min.mjs')).then(m => { m.GlobalWorkerOptions.workerSrc = here('pdfjs/pdf.worker.min.mjs'); return m; }, x => { lib = null; throw x; }));
/* стили читалки — отдельным файлом, подключаем один раз */
const style = () => css || (css = new Promise(ok => {
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = here('pdf-reader.css');
  l.onload = l.onerror = () => ok(); document.head.append(l);
}));
/* на какой странице закрыли файл — откроется там же, пока вкладка открыта и файл не менялся */
const pos = new Map();
const CSS = 96 / 72, ZMIN = .1 * CSS, ZMAX = 6 * CSS, MAXPX = 16e6;

const errText = (x, errMsg) => {
  const n = x && x.name;
  return n === 'InvalidPDFException' ? 'Файл повреждён или это вовсе не PDF'
    : n === 'MissingPDFException' ? 'Файл не найден — может, его удалили или переименовали'
    : n === 'UnexpectedResponseException' ? 'Сервер не отдал файл' + (x.status ? ' (HTTP ' + x.status + ')' : '')
    : n === 'PasswordException' ? 'Без пароля этот PDF не открыть' : errMsg(x);
};

function password(X, bad) {
  return new Promise(ok => {
    const box = document.createElement('div');
    box.innerHTML = '<p>' + X.ea(bad ? 'Пароль не подошёл — попробуй ещё раз' : 'Файл «' + X.e.n + '» защищён паролем') + '</p><label class="f">Пароль<input type="password" autocomplete="off" spellcheck="false"></label>';
    const inp = box.querySelector('input');
    X.done(v => ok(v === 'ok' ? inp.value : null));
    X.showDlg('Пароль к PDF', box, '<button class="pbtn" type="button" data-d="x">Отмена</button><button class="pbtn p" type="button" data-d="=ok">Открыть</button>');
    inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); X.closeDlg('ok'); } });
    inp.focus();
  });
}

export async function open(X) {
  const { e, url, tok, S, vb, vt, alive, tools, status, msgBox, fi, ea } = X;
  const tab = () => window.open(url, '_blank', 'noopener');
  const native = () => {
    if (navigator.pdfViewerEnabled === false) { vb.innerHTML = ''; vb.append(msgBox(e, 'Этот браузер не показывает PDF внутри страницы', 'Открой его в новой вкладке или скачай', [['Открыть', tab], ['Скачать', () => X.download([e])]])); return; }
    X.nat();
  };
  const fail = (t, x) => { vb.innerHTML = ''; vb.append(msgBox(e, t, x, [['Просмотрщик браузера', native], ['В новой вкладке', tab], ['Скачать', () => X.download([e])]])); };
  tools([['tab', 'В новой вкладке', 'fwd', 0, tab], ['ask', 'Спросить', 'chat', 0, X.ask]]);
  let L;
  try { [L] = await Promise.all([pdfjs(), style()]); } catch (x) { if (alive(tok)) native(); return; }
  if (!alive(tok)) return;
  X.loading('Открываю PDF…');
  /* один воркер на все документы: второй PDF открывается без повторной загрузки pdf.js */
  try { if (!worker || worker.destroyed) worker = new L.PDFWorker(); } catch (x) { worker = null; }
  const task = L.getDocument({
    url: new URL(url, document.baseURI).href, worker: worker || undefined, isEvalSupported: false, enableXfa: false,
    cMapUrl: here('pdfjs/cmaps/'), cMapPacked: true, standardFontDataUrl: here('pdfjs/standard_fonts/'),
  });
  let gaveUp = false;
  S.clean.push(() => { task.destroy().catch(() => {}); });
  task.onProgress = ({ loaded, total }) => {
    if (alive(tok) && total > 0 && loaded < total) { const b = vb.querySelector('.fx-vmsg b'); if (b) b.textContent = 'Открываю PDF… ' + Math.round(loaded / total * 100) + '%'; }
  };
  task.onPassword = (give, why) => {
    if (!alive(tok)) return;
    password(X, why === L.PasswordResponses.INCORRECT_PASSWORD).then(p => {
      if (!alive(tok)) return;
      if (p != null) return give(p);
      gaveUp = true; task.destroy().catch(() => {});
      vb.innerHTML = ''; vb.append(msgBox(e, 'PDF защищён паролем', 'Без пароля его не открыть', [['Ввести пароль', () => X.open(e, null, 'pdf')], ['Скачать', () => X.download([e])]]));
    });
  };
  let doc;
  try { doc = await task.promise; } catch (x) { if (alive(tok) && !gaveUp) fail('PDF не открылся', errText(x, X.errMsg)); return; }
  if (!alive(tok)) return;

  const N = doc.numPages, ver = e.m + '-' + e.s, was = pos.get(e.path);
  let n = was && was.v === ver ? Math.min(was.n, N) : 1, fit = X.cfg.pdffit === 'width' ? 'width' : 'page', s = CSS, rot = 0,
    vp1 = null, seq = 0, rt = null, tlo = null, rtimer = 0, title = '';
  vb.innerHTML = '<div class="fx-pv" tabindex="-1"><div class="fx-pg ld"><div class="textLayer"></div><div class="fx-plk"></div></div></div>'
    + '<button class="fx-nav l" type="button" aria-label="Предыдущая страница" title="Предыдущая страница (←)">' + fi('pgl') + '</button>'
    + '<button class="fx-nav r" type="button" aria-label="Следующая страница" title="Следующая страница (→)">' + fi('pgr') + '</button>';
  const pv = vb.querySelector('.fx-pv'), pg = pv.firstChild, tl = pg.querySelector('.textLayer'), lk = pg.querySelector('.fx-plk'),
    navL = vb.querySelector('.fx-nav.l'), navR = vb.querySelector('.fx-nav.r');
  navL.onclick = () => go(n - 1); navR.onclick = () => go(n + 1);
  let opts = ''; for (let i = 1; i <= N; i++) opts += '<option value="' + i + '">' + i + '</option>';
  tools([['pp', '', 'pgl', 0, () => go(n - 1), 'Предыдущая страница (←)'],
    '<label class="fx-pgs" title="Перейти к странице"><select class="fx-psel" aria-label="Страница"' + (N < 2 ? ' disabled' : '') + '>' + opts + '</select><span>из ' + N + '</span></label>',
    ['pn', '', 'pgr', 0, () => go(n + 1), 'Следующая страница (→)'], '<span class="fx-tsep"></span>',
    ['zo', '', 'minus', 0, () => zoomTo(s / 1.2), 'Мельче (−)'], '<span class="fx-zm"></span>', ['zi', '', 'plus', 0, () => zoomTo(s * 1.2), 'Крупнее (+)'],
    ['fp', 'Страница', 'fit', 0, () => setFit('page'), 'Вся страница целиком (0)'], ['fw', 'По ширине', 'wrap', 0, () => setFit('width'), 'По ширине окна (W)'],
    ['rot', '', 'refresh', 0, rotate, 'Повернуть (R)'], '|',
    ['tab', 'В новой вкладке', 'fwd', 0, tab], ['ask', 'Спросить', 'chat', 0, X.ask, 'Спросить Personal Computer об этом документе']]);
  const sel = vt.querySelector('.fx-psel');
  sel.addEventListener('change', () => go(+sel.value));

  /* страницы держим рядом с текущей, дальние отпускаем — память не растёт на толстых книгах */
  const pages = new Map();
  const getPage = k => { let p = pages.get(k); if (!p) { p = doc.getPage(k); pages.set(k, p); p.catch(() => pages.delete(k)); } return p; };
  const trim = () => { for (const [k, p] of pages) if (Math.abs(k - n) > 2) { pages.delete(k); p.then(x => x.cleanup()).catch(() => {}); } };
  const pad = () => pv.clientWidth < 560 ? 8 : 20;
  const fitS = () => {
    const p = pad(), W = Math.max(40, pv.clientWidth - 2 * p), H = Math.max(40, pv.clientHeight - 2 * p);
    return fit === 'width' ? W / vp1.width : Math.min(W / vp1.width, H / vp1.height);
  };
  function ui() {
    sel.value = String(n);
    const a = n <= 1, b = n >= N;
    vt.querySelector('[data-t=pp]').disabled = a; vt.querySelector('[data-t=pn]').disabled = b; navL.hidden = a; navR.hidden = b;
    vt.querySelector('[data-t=fp]').classList.toggle('on', fit === 'page'); vt.querySelector('[data-t=fw]').classList.toggle('on', fit === 'width');
    vt.querySelector('.fx-zm').textContent = Math.round(s / CSS * 100) + '%';
    status(ea(X.kindText(e)) + ' · страница ' + n + ' из ' + N + (title ? ' · ' + ea(title) : '') + ' · ' + X.fsz(e.s));
  }
  function size() {
    if (!vp1) return;
    pg.style.width = vp1.width * s + 'px'; pg.style.height = vp1.height * s + 'px'; pg.style.setProperty('--scale-factor', s); ui();
  }

  /* fresh — новая страница: старую картинку убираем сразу, а не растягиваем; 'end' — встать в её конец (листаем назад) */
  async function render(fresh) {
    clearTimeout(rtimer);
    const my = ++seq;
    let page;
    try { page = await getPage(n); } catch (x) { if (my === seq && alive(tok)) fail('Страница ' + n + ' не открылась', errText(x, X.errMsg)); return; }
    if (my !== seq || !alive(tok)) return;
    const rotation = (page.rotate + rot) % 360;
    vp1 = page.getViewport({ scale: 1, rotation });
    if (fit) s = fitS();
    if (fresh) { pg.querySelector('canvas')?.remove(); tlo && tlo.cancel(); tl.replaceChildren(); lk.replaceChildren(); pg.classList.add('ld'); }
    size();
    if (fresh) { pv.scrollTop = fresh === 'end' && pv.scrollHeight > pv.clientHeight + 4 ? pv.scrollHeight : 0; pv.scrollLeft = Math.max(0, (pv.scrollWidth - pv.clientWidth) / 2); }
    const vp = page.getViewport({ scale: s, rotation });
    /* чёткость под экран, но не больше ~16 Мп на холст: больше телефоны не выдерживают */
    let os = window.devicePixelRatio || 1;
    if (vp.width * vp.height * os * os > MAXPX) os = Math.sqrt(MAXPX / (vp.width * vp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.floor(vp.width * os)); cv.height = Math.max(1, Math.floor(vp.height * os));
    cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'Страница ' + n);
    if (rt) rt.cancel();
    const job = rt = page.render({ canvasContext: cv.getContext('2d', { alpha: false }), viewport: vp, transform: os !== 1 ? [os, 0, 0, os, 0, 0] : null });
    try { await job.promise; } catch (x) {
      if (x && x.name === 'RenderingCancelledException') return;
      if (my === seq && alive(tok)) fail('Страница ' + n + ' не нарисовалась', errText(x, X.errMsg));
      return;
    }
    if (rt === job) rt = null;
    if (my !== seq || !alive(tok)) return;
    pg.querySelector('canvas')?.remove(); pg.prepend(cv); pg.classList.remove('ld');
    text(page, vp, my); links(page, vp, my);
    trim(); if (n < N) getPage(n + 1);
  }
  const later = () => { clearTimeout(rtimer); rtimer = setTimeout(() => render(), 140); };
  function text(page, vp, my) {
    tlo && tlo.cancel(); tl.replaceChildren();
    try {
      const t = tlo = new L.TextLayer({ textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container: tl, viewport: vp });
      t.render().then(() => { if (my !== seq || tlo !== t) return; const d = document.createElement('div'); d.className = 'endOfContent'; tl.append(d); }).catch(() => {});
    } catch (x) {}
  }
  async function links(page, vp, my) {
    lk.replaceChildren();
    let an; try { an = await page.getAnnotations({ intent: 'display' }); } catch (x) { return; }
    if (my !== seq || !alive(tok)) return;
    for (const a of an) {
      if (a.subtype !== 'Link') continue;
      const el = document.createElement('a'), r = vp.convertToViewportRectangle(a.rect);
      const x = Math.min(r[0], r[2]), y = Math.min(r[1], r[3]), w = Math.abs(r[2] - r[0]), h = Math.abs(r[3] - r[1]);
      el.style.cssText = 'left:' + x / vp.width * 100 + '%;top:' + y / vp.height * 100 + '%;width:' + w / vp.width * 100 + '%;height:' + h / vp.height * 100 + '%';
      if (a.url && /^(https?:|mailto:)/i.test(a.url)) { el.href = a.url; el.target = '_blank'; el.rel = 'noopener noreferrer'; el.title = a.url; }
      else if (a.dest != null) { el.href = '#'; el.title = 'Перейти по ссылке в документе'; el.onclick = ev => { ev.preventDefault(); toDest(a.dest); }; }
      else if (a.action) {
        const t = { FirstPage: 1, LastPage: N, NextPage: n + 1, PrevPage: n - 1 }[a.action]; if (t == null) continue;
        el.href = '#'; el.onclick = ev => { ev.preventDefault(); go(t); };
      } else continue;
      lk.append(el);
    }
  }
  async function toDest(dest) {
    try {
      const d = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(d) || !alive(tok)) return;
      const ref = d[0], i = ref && typeof ref === 'object' ? await doc.getPageIndex(ref) : Number.isInteger(ref) ? ref : null;
      if (i != null && alive(tok)) go(i + 1);
    } catch (x) {}
  }

  function go(k, where) {
    k = Math.max(1, Math.min(N, Math.round(k) || 1)); if (k === n) return;
    n = k; pos.set(e.path, { n, v: ver }); ui(); render(where || 'top');
  }
  /* масштаб от точки (fx, fy) окна — она остаётся на месте; сразу растягиваем то, что есть, а чётко перерисовываем чуть позже */
  function zoomTo(ns, fx, fy) {
    if (!vp1) return;
    ns = Math.max(Math.min(ZMIN, s), Math.min(ZMAX, ns)); if (Math.abs(ns - s) < 1e-4) return;
    if (fx == null) { fx = pv.clientWidth / 2; fy = pv.clientHeight / 2; }
    const ux = (pv.scrollLeft + fx - pg.offsetLeft) / s, uy = (pv.scrollTop + fy - pg.offsetTop) / s;
    fit = null; s = ns; size();
    pv.scrollLeft = ux * s + pg.offsetLeft - fx; pv.scrollTop = uy * s + pg.offsetTop - fy;
    later();
  }
  function setFit(m) {
    fit = m; X.cfg.pdffit = m; X.save(); if (!vp1) return;
    s = fitS(); size(); pv.scrollTop = 0; pv.scrollLeft = Math.max(0, (pv.scrollWidth - pv.clientWidth) / 2); later();
  }
  function rotate() { rot = (rot + 90) % 360; render('top'); }
  /* листание по экрану: вниз по странице, а у её края — на соседнюю */
  const room = d => d > 0 ? pv.scrollTop + pv.clientHeight < pv.scrollHeight - 2 : pv.scrollTop > 1;
  function screen(d) { if (room(d)) pv.scrollBy({ top: d * Math.max(40, pv.clientHeight - 48), behavior: 'smooth' }); else go(n + d, d < 0 ? 'end' : 'top'); }

  /* колесо: Ctrl (и щипок на тачпаде) — масштаб; упёрлись в край страницы и крутим дальше — соседняя страница */
  let wacc = 0, wlast = 0;
  pv.addEventListener('wheel', ev => {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      const r = pv.getBoundingClientRect(), dy = Math.max(-25, Math.min(25, ev.deltaMode ? ev.deltaY * 20 : ev.deltaY));
      zoomTo(s * Math.exp(-dy * .008), ev.clientX - r.left, ev.clientY - r.top); return;
    }
    if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return;
    const d = ev.deltaY > 0 ? 1 : -1, now = Date.now();
    if (room(d)) { wacc = 0; return; }
    ev.preventDefault();
    if (now - wlast < 450) { wlast = now; return; } /* инерция тачпада после перелистывания не листает дальше */
    wacc += ev.deltaMode ? ev.deltaY * 40 : ev.deltaY;
    if (Math.abs(wacc) >= 160) { wacc = 0; wlast = now; if (d > 0 ? n < N : n > 1) go(n + d, d < 0 ? 'end' : 'top'); }
  }, { passive: false });
  /* пальцы: щипок — масштаб, быстрый свайп вбок (если страница не прокручивается вбок) — соседняя страница */
  let t0 = null, pinch = null;
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  pv.addEventListener('touchstart', ev => {
    const r = pv.getBoundingClientRect();
    if (ev.touches.length === 2) { const [a, b] = ev.touches; pinch = { d: dist(a, b), s, fx: (a.clientX + b.clientX) / 2 - r.left, fy: (a.clientY + b.clientY) / 2 - r.top }; t0 = null; }
    else if (ev.touches.length === 1 && !pinch) { const t = ev.touches[0]; t0 = { x: t.clientX, y: t.clientY, t: Date.now(), sl: pv.scrollLeft, max: pv.scrollWidth - pv.clientWidth }; }
  }, { passive: true });
  pv.addEventListener('touchmove', ev => {
    if (pinch && ev.touches.length === 2) { ev.preventDefault(); const [a, b] = ev.touches; zoomTo(pinch.s * dist(a, b) / pinch.d, pinch.fx, pinch.fy); }
  }, { passive: false });
  const tend = ev => {
    if (pinch) { if (!ev.touches.length) pinch = null; return; }
    if (!t0 || ev.touches.length) return;
    const t = ev.changedTouches[0], dx = t.clientX - t0.x, dy = t.clientY - t0.y, q = t0; t0 = null;
    if (ev.type !== 'touchend' || String(getSelection()) || Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * .6 || Date.now() - q.t > 600) return;
    if (dx < 0 && q.sl >= q.max - 2) go(n + 1); else if (dx > 0 && q.sl <= 2) go(n - 1);
  };
  pv.addEventListener('touchend', tend, { passive: true }); pv.addEventListener('touchcancel', tend, { passive: true });
  /* двойной щелчок: вписанная страница — вдвое крупнее в этой точке, увеличенная — обратно как было */
  pv.addEventListener('dblclick', ev => {
    if (ev.target.closest('a') || String(getSelection())) return;
    const r = pv.getBoundingClientRect();
    if (fit) zoomTo(s * 2, ev.clientX - r.left, ev.clientY - r.top); else setFit(X.cfg.pdffit === 'width' ? 'width' : 'page');
  });
  /* выделение мышью: подложка слоя текста растягивается на всю страницу, чтобы выделение не прыгало */
  pv.addEventListener('pointerdown', ev => { if (ev.pointerType === 'mouse' && ev.target.closest('.textLayer')) tl.classList.add('selecting'); });
  const unsel = () => tl.classList.remove('selecting');
  document.addEventListener('pointerup', unsel);
  const ro = new ResizeObserver(() => { if (fit && vp1) { const ns = fitS(); if (Math.abs(ns - s) > 1e-3) { s = ns; size(); later(); } } });
  ro.observe(pv);
  S.clean.push(() => { document.removeEventListener('pointerup', unsel); ro.disconnect(); clearTimeout(rtimer); rt && rt.cancel(); tlo && tlo.cancel(); });

  /* клавиши окна просмотра: true — нажатие наше */
  S.key = ev => {
    const k = ev.key, c = ev.code, t = ev.target;
    if (ev.ctrlKey || ev.metaKey || ev.altKey || (t && t.tagName === 'SELECT')) return false;
    if (k === ' ' && t && t.closest && t.closest('button,a')) return false;
    const act = k === 'ArrowLeft' ? () => go(n - 1) : k === 'ArrowRight' ? () => go(n + 1)
      : k === 'PageDown' || (k === ' ' && !ev.shiftKey) ? () => screen(1) : k === 'PageUp' || k === ' ' ? () => screen(-1)
      : k === 'ArrowDown' || k === 'ArrowUp' ? () => pv.scrollBy({ top: k === 'ArrowDown' ? 60 : -60 })
      : k === 'Home' ? () => go(1) : k === 'End' ? () => go(N)
      : k === '+' || k === '=' ? () => zoomTo(s * 1.2) : k === '-' ? () => zoomTo(s / 1.2)
      : k === '0' ? () => setFit('page') : c === 'KeyW' ? () => setFit('width') : c === 'KeyR' ? rotate : null;
    if (!act) return false;
    ev.preventDefault(); act(); return true;
  };

  doc.getMetadata().then(m => {
    const t = m && m.info && String(m.info.Title || '').trim();
    if (t && t !== e.n && alive(tok)) { title = t.length > 80 ? t.slice(0, 79) + '…' : t; ui(); }
  }).catch(() => {});
  pos.set(e.path, { n, v: ver });
  await render('top');
}
