/* Окно проверки DeepSeek: настоящая страница chat.deepseek.com в браузере на этом сервере, а её экран — в приложении.
   Зачем. Защита сайта (AWS WAF) иногда просит доказать, что ты человек, а вход по паролю с незнакомого устройства
   сайт не пускает. Такое проходит только человек и только в настоящем браузере. Сервер открывает сайт с тем же адресом,
   прокси, User-Agent и cookies, что у запросов модели (deepseek.js), ты проходишь проверку (или входишь) в окне,
   а сервер забирает то, что выдал сайт: cookies (в том числе aws-waf-token), а при входе — токен и отпечаток устройства.
   За человека здесь ничего не решается: окно показывает страницу и передаёт твои нажатия.

   Сеанс — один на пользователя: why = 'check' (проверка) или 'login' (вход на сайте). Сам закрывается, когда дело
   сделано, через 15 минут или когда окно закрыли; браузер гаснет сам через 5 минут без вкладок (browser.js). */
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { CFG } from './config.js';
import { Browser, findChrome } from './browser.js';
import * as DS from './deepseek.js';
import { curlProxy } from './proxy.js';

const SITE = () => (process.env.PERSONALCOMPUTER_DEEPSEEK_SITE || process.env.PERSONALCOMPUTER_DEEPSEEK_URL || DS.DS_BASE).replace(/\/+$/, '');
const SITE_HOST = () => { try { return new URL(SITE()).hostname; } catch { return 'chat.deepseek.com'; } };
/* куда вкладке можно: сам сайт и его статика, защита AWS WAF (головоломка), SDK отпечатка Shumei.
   Страницы (документы) — только сайт и защита; картинки, скрипты и шрифты — ещё с CDN, которыми он пользуется */
const DOC_OK = /(^|\.)(deepseek\.com|awswaf\.com)$/i;
const SUB_OK = /(^|\.)(deepseek\.com|awswaf\.com|fengkongcloud\.(com|cn)|ishumei\.com|cloudfront\.net|gstatic\.com|googleapis\.com)$/i;
const allow = (host, type) => host === SITE_HOST() || (type === 'Document' ? DOC_OK : SUB_OK).test(host);
const LIFE = 15 * 60e3;

/* браузер — свой у каждого пользователя (профиль: cookies и хранилище сайта), живёт между проверками */
const browsers = new Map();
const profileOf = uid => path.join(CFG.data, 'browser', uid);
async function browserFor(chat) {
  const st = DS.ident(chat.ds.v), px = await curlProxy(DS.DS_BASE, 'model').catch(() => null);
  let br = browsers.get(chat.u.id);
  /* поменялись прокси или «браузер» (другой User-Agent) — перезапускаем с новыми */
  if (br && (br.proxy !== px || br.ua !== st.ua) && !br.pages.size) { br.kill(); br = null; }
  if (!br || (!br.alive && br.p)) { br = new Browser({ profile: profileOf(chat.u.id), proxy: px, ua: st.ua, lang: st.lang }); browsers.set(chat.u.id, br); }
  return br;
}
export const available = () => !!findChrome();
export function browserInfo() { const p = findChrome(true); return { ok: !!p, path: p || '' }; }

/* ---------- сеанс ---------- */
const sessions = new Map();
export const sessionOf = u => sessions.get(u.id) || null;
class Sess extends EventEmitter {
  constructor(chat, why, o = {}) {
    super();
    this.setMaxListeners(20);
    this.chat = chat; this.why = why; this.o = o;
    this.state = 'open'; this.msg = ''; this.frame = null; this.t = Date.now(); this.sawWaf = false; this.good = 0; this.tries = 0;
  }
  pub() { return { state: this.state, why: this.why, msg: this.msg, url: this.page?.url || '', t: this.t, login: this.login || '' }; }
  set(state, msg = '') { this.state = state; this.msg = msg; this.emit('state', this.pub()); }
  async open({ w = 900, h = 760 } = {}) {
    const st = DS.ident(this.chat.ds.v), token = DS.parseToken(this.chat.dsToken());
    const br = await browserFor(this.chat);
    this.page = await br.page({ allow, width: clamp(w, 320, 1400), height: clamp(h, 400, 1400) });
    this.page.on('frame', f => { this.frame = f; this.emit('frame', f); });
    this.page.on('close', () => { if (this.state !== 'done') this.end('closed'); });
    this.page.on('blocked', u => { if (/accounts\.google|apple\.com|github\.com|weixin|qq\.com/i.test(u)) this.set(this.state, 'Вход через Google, Apple или WeChat в этом окне не работает — войди по email (или телефону) и паролю.'); });
    /* cookies нашего «браузера» → в настоящий: проверка, пройденная раньше, засчитана и ему */
    await this.page.setCookies(DS.cookieList(st).map(c => c.url ? { ...c, url: SITE() } : c)).catch(() => {});
    /* аккаунт: для проверки — тот, что подключён; для входа — чистая страница входа. Один раз за вкладку (sessionStorage),
       чтобы не стереть токен, который сайт выдаст после входа */
    const tok = JSON.stringify(JSON.stringify({ value: token, __version: '0' }));
    await this.page.onNew('try{if(!sessionStorage.getItem("__pc")){sessionStorage.setItem("__pc","1");'
      + (this.why === 'login' || !token ? 'localStorage.removeItem("userToken");' : 'localStorage.setItem("userToken",' + tok + ');') + '}}catch(e){}');
    await this.page.screencast(true);
    await this.page.go(SITE() + (this.why === 'login' ? '/sign_in' : '/'));
    this.set('live', this.why === 'login' ? 'Войди в свой аккаунт DeepSeek — как на сайте.' : 'Открываю сайт…');
    this.poll = setInterval(() => this.tick().catch(() => {}), 1500);
    this.life = setTimeout(() => this.end('timeout'), LIFE);
    this.life.unref?.();
  }
  /* что сейчас на странице: страница защиты, сайт или вход прошёл */
  async tick() {
    if (this.busy || this.state !== 'live' || !this.page || this.page.closed) return;
    this.busy = true;
    try {
      const s = await this.page.eval(`(()=>{const w=!!(window.gokuProps||window.AwsWafIntegration&&document.querySelector('#captcha-container,awswaf-captcha,[id*=captcha]')||document.querySelector('#captcha-container,awswaf-captcha'));
        let t='';try{const v=localStorage.getItem('userToken');t=v?(JSON.parse(v).value||v):''}catch(e){}
        const r=document.querySelector('#root,#app,#__next');return {w,sdk:!!window.AwsWafIntegration,ready:document.readyState==='complete',app:!!(r&&r.children.length),host:location.hostname,path:location.pathname,t:String(t||'').slice(0,8000)}})()`, { timeout: 5000 });
      if (!s) return;
      if (s.w) { this.sawWaf = true; this.good = 0; if (!/проверк/i.test(this.msg)) this.set('live', 'Пройди проверку на странице — дальше всё сделаю сам.'); return; }
      if (this.why === 'login') {
        if (s.t && s.t !== this.o.had && !/sign_in|login/.test(s.path)) return this.finishLogin(s.t);
        return;
      }
      /* сайт открылся (а не страница защиты) и держится. Защита сайта (её скрипт на странице) выдаёт отметку не сразу —
         подождём её. Дальше главное: пускает ли сайт теперь запросы сервера — проверяем тем же запросом, что перед сообщением */
      if (!(s.ready && s.app && s.host === SITE_HOST())) { this.good = 0; return; }
      if (++this.good < 2) return;
      const has = (await this.page.cookies([SITE() + '/']).catch(() => [])).some(c => c.name === 'aws-waf-token');
      if (s.sdk && !has && this.good < 8) return;
      if (Date.now() < (this.probeAt || 0)) return;
      await this.takeCookies();
      const ok = await DS.probe(this.chat.dsToken(), this.chat.ds.v, () => this.chat.ds.save());
      if (ok !== false) return this.finishCheck();
      /* браузер сайт пустил, а запросы сервера — ещё нет: проверку на сайте показывают, когда отправляешь сообщение */
      this.probeAt = Date.now() + 6000;
      if (++this.tries === 1 || this.tries % 10 === 0) this.set('live', this.sawWaf
        ? 'Проверка пройдена, но сайт пока не пускает запросы сервера. Отправь здесь любое сообщение — если сайт покажет проверку, пройди её.'
        : 'Сайт открылся. Отправь здесь любое сообщение — если сайт покажет проверку, пройди её.');
    } finally { this.busy = false; }
  }
  async takeCookies() {
    const list = await this.page.cookies([SITE() + '/']).catch(() => []);
    DS.absorbCookies(this.chat.ds.v, list);
    /* User-Agent вкладки — тот же, что у запросов (browserFor), но проверим: что видел сайт, то и шлём */
    this.chat.ds.save();
    return list;
  }
  async finishCheck() {
    await this.takeCookies();
    this.set('done', 'Проверка пройдена — продолжаю.');
    this.chat.checkPassed?.();
    this.emit('done', { why: 'check' });
    setTimeout(() => this.end('done'), 1800).unref?.();
  }
  async finishLogin(raw) {
    const token = DS.parseToken(raw);
    const dev = await this.page.eval('(async()=>{try{const s=window.SMSdk;if(!s||!s.getDeviceId)return "";return String(await s.getDeviceId()||"")}catch(e){return ""}})()', { timeout: 6000 }).catch(() => '');
    await this.takeCookies();
    const st = this.chat.ds.v;
    if (dev && dev.length >= 16 && dev.length <= 1024) st.dev = dev;
    this.chat.ds.save();
    let who = '';
    try { who = (await DS.check(token, st, () => this.chat.ds.save())).login; } catch {}
    this.login = who;
    this.set('done', 'Вход выполнен' + (who ? ': ' + who : '') + '.');
    this.emit('done', { why: 'login', token, dev: st.dev || '', login: who });
    setTimeout(() => this.end('done'), 1800).unref?.();
  }
  async input(ev) { if (this.page && !this.page.closed && this.state === 'live') await this.page.input(ev); }
  async size(w, h) { if (this.page && !this.page.closed) await this.page.resize(w, h).catch(() => {}); }
  async reload() { if (this.page && !this.page.closed) { this.good = 0; await this.page.send('Page.reload', {}).catch(() => {}); } }
  end(why = 'closed') {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.poll); clearTimeout(this.life);
    if (this.state !== 'done') this.set(why === 'timeout' ? 'fail' : 'closed', why === 'timeout' ? 'Окно закрылось само: прошло 15 минут.' : '');
    this.page?.close().catch(() => {});
    if (sessions.get(this.chat.u.id) === this) sessions.delete(this.chat.u.id);
    this.emit('end');
  }
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(+v || a)));

/* открыть окно: why — 'check' или 'login'. Уже открыто — то же самое (вторая вкладка приложения видит тот же экран) */
export async function open(chat, why, o = {}) {
  let s = sessions.get(chat.u.id);
  if (s && !s.ended && s.why === why) return s;
  s?.end('closed');
  if (!available()) throw Object.assign(new Error('На сервере нет браузера'), { nobrowser: true });
  s = new Sess(chat, why, { had: why === 'login' ? '' : undefined, ...o });
  sessions.set(chat.u.id, s);
  try { await s.open(o); }
  catch (e) { s.end('closed'); throw e; }
  return s;
}
export function close(u) { sessions.get(u.id)?.end('closed'); }

/* отпечаток устройства без окна: страница входа сайта сама считает его (SDK Shumei) — читаем и закрываем.
   Нужен для входа по паролю: это настоящий отпечаток этого сервера, а не выдуманный */
export async function deviceId(chat, { timeout = 25000 } = {}) {
  if (!available()) return '';
  const br = await browserFor(chat), page = await br.page({ allow, width: 900, height: 760 });
  try {
    await page.onNew('try{if(!sessionStorage.getItem("__pc")){sessionStorage.setItem("__pc","1");localStorage.removeItem("userToken")}}catch(e){}');
    await page.go(SITE() + '/sign_in');
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      await new Promise(r => setTimeout(r, 1000));
      const d = await page.eval('(async()=>{try{const s=window.SMSdk;if(!s||!s.getDeviceId)return "";return String(await s.getDeviceId()||"")}catch(e){return ""}})()', { timeout: 5000 }).catch(() => '');
      if (d && d.length >= 16) {
        const list = await page.cookies([SITE() + '/']).catch(() => []);
        DS.absorbCookies(chat.ds.v, list);
        chat.ds.v.dev = d; chat.ds.save();
        return d;
      }
    }
    return '';
  } finally { page.close().catch(() => {}); }
}

/* ---------- установка браузера (администратор, у агента полный доступ) ----------
   sudo personalcomputer browser install — то же, что из терминала; ход — в журнале job */
let job = null;
export const installState = () => job ? { state: job.state, log: job.log.slice(-1500), t: job.t } : null;
export function install(runCmd) {
  if (job?.state === 'run') return installState();
  job = { state: 'run', log: '', t: Date.now() };
  const me = job;
  runCmd({ cmd: 'sudo -n personalcomputer browser install 2>&1', timeout: 1800 }).then(r => {
    me.log = String(r.out || '');
    me.state = r.code === 0 && findChrome(true) ? 'ok' : 'fail';
  }).catch(e => { me.log += '\n' + e.message; me.state = 'fail'; });
  return installState();
}
/* профиль браузера пользователя — стирается вместе с его данными («Отключить» аккаунт DeepSeek) */
export function forgetProfile(u) {
  close(u);
  const br = browsers.get(u.id); if (br) { br.kill(); browsers.delete(u.id); }
  fs.rm(profileOf(u.id), { recursive: true, force: true }, () => {});
}
/* сервер останавливается — браузеры гасим сразу (иначе они пережили бы его) */
export function shutdown() { for (const br of browsers.values()) try { br.p?.kill('SIGKILL'); } catch {} browsers.clear(); }
