/* Браузер на сервере: Chromium (или Chrome) по протоколу DevTools через pipe — без открытых портов и сторонних библиотек.
   Нужен для того, что может сделать только человек в настоящем браузере: пройти проверку «я не робот» или войти на сайт.
   Страница открывается здесь, на сервере (тот же адрес и прокси, что у запросов к модели), а её экран (скринкаст JPEG)
   и нажатия идут через окно в приложении (webcheck.js). Запускается по требованию и закрывается, когда не нужен.

   Безопасность: браузер работает от пользователя сервера Personal Computer, поэтому ходит только туда, куда разрешено
   (allow — список доменов: сайт и его защита), всё остальное отклоняется ещё до запроса (Fetch.requestPaused).
   Песочница Chromium в службе systemd недоступна (NoNewPrivileges, RestrictNamespaces) — её заменяют ограничения службы. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

/* ---------- где браузер ----------
   PERSONALCOMPUTER_CHROME — явный путь; дальше — свой (sudo personalcomputer browser → /opt/personalcomputer/browser)
   и системные. Snap-обёртки (Ubuntu: chromium-browser) в службе не запускаются — их берём последними */
const NAMES = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'chrome', 'chrome-headless-shell', 'microsoft-edge-stable'];
const OWN = () => process.env.PERSONALCOMPUTER_BROWSER_DIR || '/opt/personalcomputer/browser';
const exe = f => { try { const s = fs.statSync(f); return s.isFile() && !!(s.mode & 0o111); } catch { return false; } };
function ownBrowser(dir = OWN()) {
  /* раскладка «Chrome for Testing» / Playwright: dir/<сборка>/chrome-linux64/chrome или chrome-headless-shell */
  const out = [];
  const walk = (d, depth) => {
    let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(f, depth + 1);
      else if (/^(chrome|chromium|chrome-headless-shell|headless_shell)$/.test(e.name) && exe(f)) out.push(f);
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => (/headless/.test(a) ? 1 : 0) - (/headless/.test(b) ? 1 : 0))[0] || '';
}
let found = null;
export function findChrome(fresh) {
  /* нашли — помним; не нашли — ищем снова в следующий раз (браузер могли только что поставить) */
  if (found && !fresh) return found;
  const env = process.env.PERSONALCOMPUTER_CHROME;
  if (env !== undefined && env !== '') return (found = exe(env) ? env : '');
  const own = ownBrowser();
  if (own) return (found = own);
  const dirs = [...new Set([...(process.env.PATH || '').split(':'), '/usr/bin', '/usr/local/bin', '/opt/google/chrome', '/usr/lib/chromium'])].filter(Boolean);
  let snap = '';
  for (const n of NAMES) for (const d of dirs) {
    const f = path.join(d, n);
    if (!exe(f)) continue;
    if (/\/snap\//.test(f) || isSnapWrapper(f)) { snap ||= f; continue; }
    return (found = f);
  }
  return (found = snap);
}
function isSnapWrapper(f) {
  try { const s = fs.statSync(f); if (s.size > 8192) return false; return /\bsnap\b/.test(fs.readFileSync(f, 'utf8')); } catch { return false; }
}

/* ---------- CDP поверх pipe: сообщения JSON, разделитель — нулевой байт; fd 3 — в браузер, fd 4 — из браузера ---------- */
class Pipe extends EventEmitter {
  constructor(w, r) {
    super();
    this.w = w; this.id = 0; this.wait = new Map(); this.buf = '';
    r.setEncoding('utf8');
    r.on('data', d => {
      this.buf += d;
      for (let i; (i = this.buf.indexOf('\0')) >= 0;) {
        const raw = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        let m; try { m = JSON.parse(raw); } catch { continue; }
        if (m.id && this.wait.has(m.id)) {
          const { ok, no } = this.wait.get(m.id); this.wait.delete(m.id);
          if (m.error) no(Object.assign(new Error(m.error.message || 'CDP'), { cdp: m.error })); else ok(m.result || {});
        } else if (m.method) this.emit('event', m);
      }
    });
    r.on('error', () => {});
    w.on('error', () => {});
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((ok, no) => {
      this.wait.set(id, { ok, no });
      this.w.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
  close(e) { for (const { no } of this.wait.values()) no(e || new Error('браузер закрылся')); this.wait.clear(); }
}

/* ---------- браузер: один процесс на профиль (папка с cookies и хранилищем сайта) ---------- */
const IDLE_MS = 5 * 60e3;
export class Browser extends EventEmitter {
  constructor({ profile, proxy = null, ua = '', lang = 'en-US,en;q=0.9' }) {
    super();
    this.profile = profile; this.proxy = proxy; this.ua = ua; this.lang = lang;
    this.p = null; this.cdp = null; this.pages = new Set(); this.idleT = null;
  }
  get alive() { return !!this.p && this.p.exitCode === null && this.p.signalCode === null; }
  async start() {
    if (this.alive) return this;
    const bin = findChrome();
    if (!bin) throw Object.assign(new Error('На сервере нет браузера (Chromium или Chrome)'), { nobrowser: true });
    fs.mkdirSync(this.profile, { recursive: true, mode: 0o700 });
    const args = ['--headless=new', '--remote-debugging-pipe', '--user-data-dir=' + this.profile, '--no-first-run', '--no-default-browser-check',
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-sync',
      '--disable-component-update', '--disable-default-apps', '--disable-breakpad', '--disable-crash-reporter', '--mute-audio', '--hide-scrollbars',
      '--password-store=basic', '--use-mock-keychain', '--metrics-recording-only', '--window-size=1100,860',
      '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,InterestFeedContentSuggestions',
      ...(this.lang ? ['--lang=' + this.lang.split(',')[0], '--accept-lang=' + this.lang.replace(/;q=[\d.]+/g, '')] : []),
      ...(this.ua ? ['--user-agent=' + this.ua] : []),
      /* прокси с паролем Chromium из командной строки не берёт: пароль отдаём по запросу (Fetch.authRequired) */
      ...(this.proxy ? ['--proxy-server=' + proxyArg(this.proxy), '--proxy-bypass-list=<-loopback>'] : []),
      'about:blank'];
    const env = { ...process.env, HOME: this.profile, XDG_CONFIG_HOME: path.join(this.profile, '.config'), XDG_CACHE_HOME: path.join(this.profile, '.cache') };
    const p = spawn(bin, args, { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    this.p = p; this.err = '';
    p.stdio[2].on('data', d => { this.err = (this.err + d).slice(-4000); });
    const cdp = this.cdp = new Pipe(p.stdio[3], p.stdio[4]);
    cdp.on('event', m => this.emit('cdp', m));
    p.on('exit', () => { cdp.close(); this.cdp = null; for (const pg of this.pages) pg.gone(); this.pages.clear(); this.emit('exit'); });
    p.on('error', e => { this.err += '\n' + e.message; });
    try {
      const v = await Promise.race([cdp.send('Browser.getVersion'), new Promise((_, no) => setTimeout(() => no(new Error('браузер не ответил за 20 с')), 20000))]);
      this.version = v.product || '';
      /* настоящий User-Agent этого браузера (у headless в нём «HeadlessChrome» — показываем сайту обычный, как у запросов) */
      this.realUA = v.userAgent || '';
    } catch (e) { this.kill(); throw Object.assign(new Error('Браузер не запустился: ' + (lastLine(this.err) || e.message)), { nobrowser: true }); }
    return this;
  }
  /* новая вкладка: allow(host) — можно ли туда ходить */
  async page({ allow, width = 900, height = 760 } = {}) {
    await this.start();
    this.touch();
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const pg = new Page(this, targetId, sessionId, { allow });
    this.pages.add(pg);
    await pg.init({ width, height });
    return pg;
  }
  touch() { clearTimeout(this.idleT); this.idleT = setTimeout(() => { if (!this.pages.size) this.kill(); }, IDLE_MS); this.idleT.unref?.(); }
  kill() { clearTimeout(this.idleT); if (this.alive) { try { this.cdp?.send('Browser.close').catch(() => {}); } catch {} const p = this.p; setTimeout(() => { if (p.exitCode === null) p.kill('SIGKILL'); }, 3000).unref?.(); } }
}
const lastLine = s => String(s || '').trim().split('\n').filter(l => !/^\s*$|DevTools listening|^\[\d+:\d+:/.test(l)).pop() || String(s || '').trim().split('\n').pop() || '';
/* адрес прокси для --proxy-server: без логина и пароля (их Chromium спросит сам — отвечаем в Fetch.authRequired) */
function proxyArg(px) {
  try { const u = new URL(px); return (u.protocol === 'socks5h:' ? 'socks5:' : u.protocol) + '//' + u.host; } catch { return ''; }
}
const proxyAuth = px => { try { const u = new URL(px); return u.username || u.password ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : null; } catch { return null; } };

/* ---------- вкладка ---------- */
export class Page extends EventEmitter {
  constructor(br, targetId, sessionId, { allow }) {
    super();
    this.br = br; this.targetId = targetId; this.sid = sessionId; this.allow = allow || (() => true);
    this.url = ''; this.title = ''; this.closed = false; this.size = null; this.frameAck = 0;
    this.h = m => { if (m.sessionId === this.sid) this.event(m.method, m.params || {}); };
    br.on('cdp', this.h);
  }
  send(method, params) { if (this.closed || !this.br.cdp) return Promise.reject(new Error('вкладка закрыта')); return this.br.cdp.send(method, params, this.sid); }
  /* mobile: false — узкое окно обычного браузера: страницы без meta viewport не уменьшаются до 980 px */
  async init({ width, height }) {
    const px = this.br.proxy, auth = px ? proxyAuth(px) : null;
    await Promise.all([
      this.send('Page.enable'), this.send('Runtime.enable'), this.send('Network.enable'),
      this.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: !!auth }),
      this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
      this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {}),
      this.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {}),
    ]);
    if (this.br.ua) await this.send('Network.setUserAgentOverride', { userAgent: this.br.ua, acceptLanguage: this.br.lang.replace(/;q=[\d.]+/g, '') }).catch(() => {});
    this.size = { width, height };
    this.auth = auth;
  }
  event(method, p) {
    if (method === 'Fetch.requestPaused') {
      let host = ''; try { const u = new URL(p.request.url); host = /^(https?|wss?):$/.test(u.protocol) ? u.hostname : ''; if (/^(data|blob|about):$/.test(u.protocol)) host = '*'; } catch {}
      const ok = host === '*' || (host && this.allow(host, p.resourceType));
      if (!ok) this.emit('blocked', p.request.url);
      this.send(ok ? 'Fetch.continueRequest' : 'Fetch.failRequest', ok ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      return;
    }
    if (method === 'Fetch.authRequired') {
      const r = this.auth && p.authChallenge?.source === 'Proxy' ? { response: 'ProvideCredentials', ...this.auth } : { response: 'CancelAuth' };
      this.send('Fetch.continueWithAuth', { requestId: p.requestId, authChallengeResponse: r }).catch(() => {});
      return;
    }
    if (method === 'Page.screencastFrame') {
      this.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      this.emit('frame', { data: p.data, w: Math.round(p.metadata?.deviceWidth || this.size?.width || 0), h: Math.round(p.metadata?.deviceHeight || this.size?.height || 0) });
      return;
    }
    if (method === 'Page.frameNavigated' && !p.frame?.parentId) { this.url = p.frame.url || ''; this.emit('nav', this.url); return; }
    if (method === 'Page.lifecycleEvent' && p.name === 'load') { this.emit('load'); return; }
    if (method === 'Page.javascriptDialogOpening') { this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); return; }
    if (method === 'Inspector.detached' || method === 'Target.detachedFromTarget') this.gone();
  }
  /* скрипт, который выполняется в каждой новой странице до её собственных */
  onNew(source) { return this.send('Page.addScriptToEvaluateOnNewDocument', { source }); }
  go(url) { return this.send('Page.navigate', { url }); }
  async eval(expr, { timeout = 8000 } = {}) {
    const r = await Promise.race([this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), new Promise((_, no) => setTimeout(() => no(new Error('страница не ответила')), timeout))]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'ошибка на странице');
    return r.result?.value;
  }
  cookies(urls) { return this.send('Network.getCookies', urls ? { urls } : {}).then(r => r.cookies || []); }
  setCookies(cookies) { return cookies.length ? this.send('Network.setCookies', { cookies }) : Promise.resolve(); }
  screencast(on, o = {}) {
    this.casting = !!on;
    return on ? this.send('Page.startScreencast', { format: 'jpeg', quality: o.quality || 72, maxWidth: o.maxWidth || 2000, maxHeight: o.maxHeight || 2000, everyNthFrame: 1 })
      : this.send('Page.stopScreencast').catch(() => {});
  }
  /* разовый снимок — когда кадров нет (страница не меняется, а окно только открыли) */
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 62 }); return { data: r.data, w: this.size?.width || 0, h: this.size?.height || 0 }; }
  /* новый размер — и сразу свежий кадр (скринкаст сам шлёт кадры только на перерисовку) */
  async resize(width, height) {
    width = Math.max(320, Math.min(1400, Math.round(width))); height = Math.max(400, Math.min(1400, Math.round(height)));
    if (this.size && this.size.width === width && this.size.height === height) return;
    this.size = { width, height };
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    if (this.casting) { await this.screencast(false); await this.screencast(true); }
  }
  /* ---------- ввод: координаты — в пикселях страницы ---------- */
  async input(ev) {
    this.br.touch();
    const x = +ev.x || 0, y = +ev.y || 0, mods = (ev.alt ? 1 : 0) | (ev.ctrl ? 2 : 0) | (ev.meta ? 4 : 0) | (ev.shift ? 8 : 0);
    switch (ev.type) {
      case 'move': return this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: mods });
      case 'down': case 'up':
        return this.send('Input.dispatchMouseEvent', { type: ev.type === 'down' ? 'mousePressed' : 'mouseReleased', x, y, button: 'left', buttons: ev.type === 'down' ? 1 : 0, clickCount: 1, modifiers: mods });
      case 'click':
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        return this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      case 'wheel': return this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: +ev.dx || 0, deltaY: +ev.dy || 0 });
      case 'text': return ev.text ? this.send('Input.insertText', { text: String(ev.text).slice(0, 500) }) : null;
      case 'key': {
        const k = KEYS[ev.key];
        if (!k) return null;
        await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: mods, ...k });
        return this.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, ...k });
      }
    }
    return null;
  }
  gone() { if (this.closed) return; this.closed = true; this.br.off('cdp', this.h); this.br.pages.delete(this); this.emit('close'); }
  async close() {
    if (this.closed) return;
    const t = this.targetId;
    this.gone();
    await this.br.cdp?.send('Target.closeTarget', { targetId: t }).catch(() => {});
    this.br.touch();
  }
}
/* клавиши, которых нет в Input.insertText */
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }, ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }, End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
};
