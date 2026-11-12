/* Окно проверки: настоящая страница сайта (chat.deepseek.com, chat.qwen.ai) в браузере на этом сервере, а её экран —
   в приложении.
   Зачем. Антибот-защита сайта (AWS WAF у DeepSeek, Alibaba Cloud у Qwen) иногда просит доказать, что ты человек
   (головоломка, слайдер), а DeepSeek ещё и не пускает вход по паролю с незнакомого устройства. Такое проходит только
   человек и только в настоящем браузере. Сервер открывает сайт с тем же адресом, прокси, User-Agent и cookies, что у
   запросов модели (webid.js), ты проходишь проверку (или входишь) в окне, а сервер забирает то, что выдал сайт:
   cookies (отметку о пройденной проверке), а при входе — токен и отпечаток устройства.
   За человека здесь ничего не решается: окно показывает страницу и передаёт твои нажатия.

   Вход в окне (why 'login') — для входа по email, телефону или GitHub: токен сайта забирается из вкладки сам.
   Вход через Google здесь не работает и обходить это мы не будем: Google нарочно не пускает в аккаунт браузер,
   которым управляет программа (страница «This browser or app may not be secure»). Для Google-аккаунтов —
   «Войти через Google» в настройках: вход идёт в твоём собственном браузере.

   Сеанс — один на пользователя: prov — сайт, why — 'check' (проверка) или 'login' (вход на сайте),
   url — страница проверки, если сайт её назвал (слайдер Qwen). Сам закрывается, когда дело сделано, через 15 минут
   или когда окно закрыли; браузер гаснет сам через 5 минут без вкладок (browser.js). */
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { CFG } from './config.js';
import { Browser, findChrome } from './browser.js';
import { ident } from './webid.js';
import * as DS from './deepseek.js';
import * as QW from './qwen.js';
import { curlProxy } from './proxy.js';

const env = (...k) => k.map(x => process.env[x]).find(Boolean);
/* сайты: куда вкладке можно (страницы — только сайт и его защита; картинки, скрипты и шрифты — ещё с CDN),
   где «браузер» пользователя, как сайт хранит токен во вкладке */
const PROV = {
  deepseek: {
    name: 'DeepSeek', base: DS.DS_BASE, site: () => env('PERSONALCOMPUTER_DEEPSEEK_SITE', 'PERSONALCOMPUTER_DEEPSEEK_URL') || DS.DS_BASE,
    doc: /(^|\.)(deepseek\.com|awswaf\.com)$/i,
    sub: /(^|\.)(deepseek\.com|awswaf\.com|fengkongcloud\.(com|cn)|ishumei\.com|cloudfront\.net|gstatic\.com|googleapis\.com)$/i,
    state: c => c.ds, token: c => DS.parseToken(c.dsToken()), login: '/sign_in',
    put: t => 'localStorage.setItem("userToken",' + JSON.stringify(JSON.stringify({ value: t, __version: '0' })) + ');', drop: 'localStorage.removeItem("userToken");',
    read: 'const v=localStorage.getItem("userToken");t=v?(JSON.parse(v).value||v):""',
    probe: DS.probe, absorb: DS.absorbCookies, list: DS.cookieList,
  },
  qwen: {
    name: 'Qwen', base: QW.QWEN_BASE, site: () => env('PERSONALCOMPUTER_QWEN_SITE', 'PERSONALCOMPUTER_QWEN_URL') || QW.QWEN_BASE,
    doc: /(^|\.)(qwen\.ai|aliyun\.com|alibaba\.com|alibabacloud\.com)$/i,
    sub: /(^|\.)(qwen\.ai|aliyun\.com|alibaba\.com|alibabacloud\.com|alicdn\.com|aliyuncs\.com|mmstat\.com|alibabausercontent\.com|gstatic\.com|googleapis\.com)$/i,
    state: c => c.qw, token: c => QW.parseToken(c.qwenToken()), login: '/auth?action=signin',
    put: t => 'localStorage.setItem("token",' + JSON.stringify(t) + ');', drop: 'localStorage.removeItem("token");',
    read: 't=localStorage.getItem("token")||""',
    probe: QW.probe, absorb: QW.absorbCookies, list: QW.cookieList,
  },
};
export const provOf = p => PROV[p] ? p : 'deepseek';
const SITE = P => P.site().replace(/\/+$/, '');
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };
const allowFor = P => (host, type) => host === hostOf(SITE(P)) || (type === 'Document' ? P.doc : P.sub).test(host);
/* страница проверки, которую назвал сайт (слайдер Qwen): только его же адрес */
const pageUrl = (P, u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && (x.hostname === hostOf(SITE(P)) || P.doc.test(x.hostname)) ? x.href : ''; } catch { return ''; } };
/* что на странице — защита (AWS WAF, слайдер Alibaba) или сайт; токен во вкладке */
const LOOK = read => `(()=>{const q=s=>document.querySelector(s);
  const aws=!!(window.gokuProps||window.AwsWafIntegration&&q('#captcha-container,awswaf-captcha,[id*=captcha]')||q('#captcha-container,awswaf-captcha'));
  const ali=/_____tmd_____/.test(location.pathname)||!!(window.noCaptcha||window.NoCaptcha||q('#nc_1_wrapper,#nc_1_n1z,.nc-container,#baxia-dialog-content,.baxia-dialog,[id^="nc_1"]'));
  let t='';try{${read}}catch(e){}
  const r=q('#root,#app,#__next,#__nuxt');
  return {w:aws||ali,sdk:!!window.AwsWafIntegration,ready:document.readyState==='complete',app:!!(r&&r.children.length),host:location.hostname,path:location.pathname,t:String(t||'').slice(0,8000)}})()`;
const LIFE = 15 * 60e3;

/* браузер — свой у каждого пользователя (профиль: cookies и хранилище сайтов), живёт между проверками */
const browsers = new Map();
const profileOf = uid => path.join(CFG.data, 'browser', uid);
async function browserFor(chat, P = PROV.deepseek) {
  const st = ident(P.state(chat).v), px = await curlProxy(P.base, 'model').catch(() => null);
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
  constructor(chat, prov, why, o = {}) {
    super();
    this.setMaxListeners(20);
    this.chat = chat; this.prov = prov; this.P = PROV[prov]; this.why = why; this.o = o;
    this.state = 'open'; this.msg = ''; this.frame = null; this.t = Date.now(); this.sawWaf = false; this.good = 0; this.tries = 0; this.errs = 0;
  }
  get doc() { return this.P.state(this.chat); }
  pub() { return { state: this.state, prov: this.prov, why: this.why, msg: this.msg, url: this.page?.url || '', t: this.t, login: this.login || '' }; }
  set(state, msg = '') { this.state = state; this.msg = msg; this.emit('state', this.pub()); }
  async open({ w = 900, h = 760, url = '' } = {}) {
    const P = this.P, st = ident(this.doc.v), token = P.token(this.chat), site = SITE(P);
    const br = await browserFor(this.chat, P);
    this.page = await br.page({ allow: allowFor(P), width: clamp(w, 320, 1400), height: clamp(h, 400, 1400) });
    this.page.on('frame', f => { this.frame = f; this.emit('frame', f); });
    this.page.on('close', () => { if (this.state !== 'done') this.end('closed'); });
    this.page.on('popup', () => this.set(this.state, 'Сайт открыл отдельное окно — в окне приложения такие не открываются (так обычно устроен вход через Google, а Google не пускает браузер на сервере). Войди по email или телефону, а для Google-аккаунта закрой окно и нажми в настройках «Войти через Google».'));
    this.page.on('blocked', u => {
      if (/accounts\.google|google\.com\/(o\/oauth|signin)/i.test(u)) this.set(this.state, 'Google не пускает вход в браузере на сервере — так он защищает аккаунты от программ. Закрой окно и нажми в настройках «Войти через Google»: вход пройдёт в твоём браузере.');
      else if (/apple\.com|weixin|qq\.com|github\.com/i.test(u)) this.set(this.state, 'Этот способ входа в окне не работает — войди по email (или телефону) и паролю, а для Google-аккаунта — «Войти через Google» в настройках.');
    });
    /* cookies нашего «браузера» → в настоящий: проверка, пройденная раньше, засчитана и ему */
    await this.page.setCookies(P.list(st).map(c => c.url ? { ...c, url: site } : c)).catch(() => {});
    /* аккаунт: для проверки — тот, что подключён; для входа — чистая страница входа. Один раз за вкладку (sessionStorage),
       чтобы не стереть токен, который сайт выдаст после входа */
    await this.page.onNew('try{if(!sessionStorage.getItem("__pc")){sessionStorage.setItem("__pc","1");' + (this.why === 'login' || !token ? P.drop : P.put(token)) + '}}catch(e){}');
    await this.page.screencast(true);
    /* слайдер, который назвал сайт, — сразу его; иначе — сам сайт (проверку он покажет сам) */
    await this.page.go(this.why === 'login' ? site + P.login : pageUrl(P, url) || site + '/');
    this.set('live', this.why === 'login' ? 'Войди в свой аккаунт ' + P.name + ' — как на сайте.' : 'Открываю сайт…');
    this.poll = setInterval(() => this.tick().catch(() => {}), 1500);
    this.life = setTimeout(() => this.end('timeout'), LIFE);
    this.life.unref?.();
  }
  /* что сейчас на странице: защита, сайт или вход прошёл */
  async tick() {
    if (this.busy || this.state !== 'live' || !this.page || this.page.closed) return;
    this.busy = true;
    try {
      const P = this.P, s = await this.page.eval(LOOK(P.read), { timeout: 5000 });
      if (!s) return;
      if (s.w) { this.sawWaf = true; this.good = 0; if (!/проверк|слайдер/i.test(this.msg)) this.set('live', 'Пройди проверку на странице — дальше всё сделаю сам.'); return; }
      if (this.why === 'login') {
        if (s.t && s.t !== this.o.had && !/sign_in|login|auth/.test(s.path)) return this.finishLogin(s.t);
        return;
      }
      /* страница защиты ушла (проверку прошли) или сайт открылся и держится. Защита сайта (её скрипт на странице) выдаёт
         отметку не сразу — подождём её. Дальше главное: пускает ли сайт теперь запросы сервера */
      if (!(s.ready && s.host === hostOf(SITE(P)) && (this.sawWaf || s.app))) { this.good = 0; return; }
      if (++this.good < 2) return;
      const has = (await this.page.cookies([SITE(P) + '/']).catch(() => [])).some(c => c.name === 'aws-waf-token');
      if (s.sdk && !has && this.good < 8) return;
      if (Date.now() < (this.probeAt || 0)) return;
      await this.takeCookies();
      /* «пройдено» — только когда сам сервер убедился, что сайт пускает его запросы. Страница в браузере открылась —
         ещё не значит, что пустят запросы сервера: раньше здесь хватало «не знаю», и окно закрывалось с галочкой зря */
      const r = await P.probe(P.token(this.chat), this.doc.v, () => this.doc.save());
      if (r?.s === 'ok') return this.finishCheck();
      /* спрашиваем не чаще раза в 6 с, а потом в 15 с: лишние запросы защиту только настораживают */
      this.probeAt = Date.now() + (this.tries + this.errs < 3 ? 6000 : 15000);
      if (r?.s === 'auth') { this.set('live', 'Токен ' + P.name + ' не подошёл — сайт пускает, но не тебя. Закрой окно и подключи аккаунт заново: настройки → Модель.'); return; }
      if (r?.s !== 'captcha') { if (++this.errs === 2 || this.errs % 10 === 0) this.set('live', 'Не получается спросить ' + P.name + ', пускает ли он сервер' + (r?.msg ? ': ' + r.msg : '') + '. Пробую ещё…'); return; }
      /* браузер сайт пустил, а запросы сервера — ещё нет: проверку на сайте показывают, когда отправляешь сообщение */
      if (++this.tries === 1 || this.tries % 10 === 0) this.set('live', this.sawWaf
        ? 'Проверка пройдена, но сайт пока не пускает запросы сервера. Отправь здесь любое сообщение — если сайт покажет проверку, пройди её.'
        : 'Сайт в браузере открылся, но запросы сервера он пока не пускает. Отправь здесь любое сообщение — если сайт покажет проверку, пройди её.');
    } finally { this.busy = false; }
  }
  async takeCookies() {
    const list = await this.page.cookies([SITE(this.P) + '/']).catch(() => []);
    this.P.absorb(this.doc.v, list);
    this.doc.save();
    return list;
  }
  async finishCheck() {
    await this.takeCookies();
    this.set('done', 'Проверка пройдена — продолжаю.');
    this.chat.checkPassed?.();
    this.emit('done', { why: 'check', prov: this.prov });
    setTimeout(() => this.end('done'), 1800).unref?.();
  }
  /* вход в окне: токен из вкладки (у DeepSeek — ещё и отпечаток устройства из SDK сайта), cookies — в «браузер» сервера */
  async finishLogin(raw) {
    if (this.prov === 'qwen') {
      const token = QW.parseToken(raw);
      if (!/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(token)) return;
      await this.takeCookies();
      this.set('done', 'Вход выполнен.');
      this.emit('done', { why: 'login', prov: 'qwen', token });
      setTimeout(() => this.end('done'), 1800).unref?.();
      return;
    }
    const token = DS.parseToken(raw);
    const dev = await this.page.eval('(async()=>{try{const s=window.SMSdk;if(!s||!s.getDeviceId)return "";return String(await s.getDeviceId()||"")}catch(e){return ""}})()', { timeout: 6000 }).catch(() => '');
    await this.takeCookies();
    const st = this.doc.v;
    if (dev && dev.length >= 16 && dev.length <= 1024) st.dev = dev;
    this.doc.save();
    let who = '';
    try { who = (await DS.check(token, st, () => this.doc.save())).login; } catch {}
    this.login = who;
    this.set('done', 'Вход выполнен' + (who ? ': ' + who : '') + '.');
    this.emit('done', { why: 'login', prov: this.prov, token, dev: st.dev || '', login: who });
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

/* открыть окно. Уже открыто то же самое — оно же (вторая вкладка приложения видит тот же экран) */
export async function open(chat, prov, why, o = {}) {
  prov = provOf(prov);
  let s = sessions.get(chat.u.id);
  /* уже готовое (галочка) не отдаём: новое нажатие — новая проверка */
  if (s && !s.ended && s.state !== 'done' && s.why === why && s.prov === prov) return s;
  s?.end('closed');
  if (!available()) throw Object.assign(new Error('На сервере нет браузера'), { nobrowser: true });
  s = new Sess(chat, prov, why, { had: why === 'login' ? '' : undefined, ...o });
  sessions.set(chat.u.id, s);
  try { await s.open(o); }
  catch (e) { s.end('closed'); throw e; }
  return s;
}
export function close(u) { sessions.get(u.id)?.end('closed'); }

/* отпечаток устройства без окна (DeepSeek): страница входа сайта сама считает его (SDK Shumei) — читаем и закрываем.
   Нужен для входа по паролю: это настоящий отпечаток этого сервера, а не выдуманный */
export async function deviceId(chat, { timeout = 25000 } = {}) {
  if (!available()) return '';
  const P = PROV.deepseek, site = SITE(P);
  const br = await browserFor(chat, P), page = await br.page({ allow: allowFor(P), width: 900, height: 760 });
  try {
    await page.onNew('try{if(!sessionStorage.getItem("__pc")){sessionStorage.setItem("__pc","1");localStorage.removeItem("userToken")}}catch(e){}');
    await page.go(site + '/sign_in');
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      await new Promise(r => setTimeout(r, 1000));
      const d = await page.eval('(async()=>{try{const s=window.SMSdk;if(!s||!s.getDeviceId)return "";return String(await s.getDeviceId()||"")}catch(e){return ""}})()', { timeout: 5000 }).catch(() => '');
      if (d && d.length >= 16) {
        const list = await page.cookies([site + '/']).catch(() => []);
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
/* профиль браузера пользователя — стирается вместе с его данными («Отключить» аккаунт DeepSeek или Qwen) */
export function forgetProfile(u) {
  close(u);
  const br = browsers.get(u.id); if (br) { br.kill(); browsers.delete(u.id); }
  fs.rm(profileOf(u.id), { recursive: true, force: true }, () => {});
}
/* сервер останавливается — браузеры гасим сразу (иначе они пережили бы его) */
export function shutdown() { for (const br of browsers.values()) try { br.p?.kill('SIGKILL'); } catch {} browsers.clear(); }
