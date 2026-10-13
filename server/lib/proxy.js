/* Прокси для всего, что Personal Computer отправляет в интернет (настройки → Сервер → «Прокси»).
   • Ключи: vless/vmess/trojan/ss/hysteria2 — через ядро Xray (его ставит установщик), socks5/http — через Xray
     или, если его нет, прямо из Node. Подписка — ссылка на список ключей: обновляется сама раз в 12 часов.
   • Xray — дочерний процесс сервера: слушает только 127.0.0.1 (SOCKS5 и HTTP на одном порту, с паролем) и уходит
     на выбранный сервер. Упал — перезапускаем; ключ не подошёл — понятная ошибка в настройках и в чате.
   • Что идёт через прокси, выбирает администратор: модель, поиск и MCP, Telegram, команды агента и терминал, проверка
     обновлений. Локальные адреса (localhost, 10.x, 192.168.x…) и исключения из настроек — всегда напрямую.
   • Строго: прокси включён, но не работает — запрос не уходит напрямую, а падает с ошибкой «через прокси: …».
     Иначе модель, которой нет в стране сервера, молча отвечала бы ошибкой, а адрес сервера утекал бы.
   Ключи и подписки лежат в приватных данных сервера (proxy.json, 0600) и в браузер не уходят. */
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { CFG } from './config.js';
import { Doc, rid, writeJSONSync } from './store.js';
import * as L from './proxylink.js';
import { proxyFetch, dropAgents, perr } from './tunnel.js';
import { setAgentProxy } from './runner-client.js';

export const KINDS = ['model', 'mcp', 'tg', 'agent', 'upd'];
const MAX_SERVERS = 300, MAX_SUBS = 10, SUB_EVERY = 12; /* часов, если провайдер не сказал иначе */
const bad = L.bad;

/* ---------- хранилище ---------- */
let doc = null;
const D = () => {
  if (!doc) {
    doc = new Doc(path.join(CFG.data, 'proxy.json'), () => ({}));
    const v = doc.v;
    v.on = !!v.on; v.active ||= ''; v.servers = Array.isArray(v.servers) ? v.servers : []; v.subs = Array.isArray(v.subs) ? v.subs : [];
    v.use = { ...Object.fromEntries(KINDS.map(k => [k, true])), ...(v.use || {}) };
    v.bypass = typeof v.bypass === 'string' ? v.bypass : '';
  }
  return doc.v;
};
const save = () => doc?.save();
const srvById = id => D().servers.find(s => s.id === id);
export const activeServer = () => srvById(D().active) || null;

/* ---------- ядро Xray ---------- */
let core;  /* undefined — ещё не искали; null — нет; { bin, version } */
function findBin() {
  if (CFG.xray === 'none') return null; /* PERSONALCOMPUTER_XRAY=none — без Xray (только socks5/http) */
  const c = [CFG.xray, '/opt/personalcomputer/bin/xray', ...String(process.env.PATH || '').split(':').filter(Boolean).map(d => path.join(d, 'xray'))].filter(Boolean);
  for (const f of c) { try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {} }
  return null;
}
export async function coreInfo(fresh) {
  if (core !== undefined && !fresh) return core;
  const bin = findBin();
  if (!bin) return core = null;
  const version = await new Promise(ok => execFile(bin, ['version'], { timeout: 10000 }, (e, out) => ok(e ? null : (/Xray\s+([\d.]+)/.exec(String(out)) || [])[1] || '?')));
  return core = version ? { bin, version } : null;
}

/* ---------- состояние ---------- */
/* state: off — выключен; starting — запускается; ok — работает; error — не работает (err); nocore — нужен Xray, а его нет */
const rt = { state: 'off', err: '', since: 0, mode: null, px: null, srv: '', sig: '', child: null, ready: null, restartT: null, tries: 0 };
const tests = new Map(); /* id сервера → итог последней проверки */
let chain = Promise.resolve();
let boot = null; /* первый запуск после старта сервера (см. initProxy) */
const serial = fn => (chain = chain.then(fn, fn));
const setState = (state, err = '') => { rt.state = state; rt.err = err; rt.since = Date.now(); pushEnv(); };

/* локальный вход Xray: порт и пароль помним, чтобы у долгих процессов агента не сбивались переменные прокси */
function local() {
  const v = D();
  if (!v.local?.port) { v.local = { port: 0, user: 'pc-' + rid(4), pass: rid(16) }; save(); }
  return v.local;
}
const portFree = port => new Promise(ok => { const s = net.createServer(); s.once('error', () => ok(false)); s.listen(port, '127.0.0.1', () => s.close(() => ok(true))); });
const randomPort = () => new Promise(ok => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
async function localPort(lc) {
  if (lc.port && await portFree(lc.port)) return lc.port;
  lc.port = await randomPort(); save();
  return lc.port;
}

/* журнал Xray: храним только ошибки, а из них — причину, почему соединение через прокси оборвалось */
const XLOG = /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d(?:\.\d+)? /;
export function reason(l) {
  const dial = /\[(dial \w+ [^\]]+)\]/.exec(l)?.[1] || '';
  const t = dial || l;
  if (/connection refused/i.test(t)) return 'сервер прокси не принимает соединения (выключен или порт другой)';
  if (/i\/o timeout|deadline exceeded|timed out/i.test(t)) return 'сервер прокси не отвечает (таймаут): он недоступен или его блокируют';
  if (/no such host|server misbehaving/i.test(t)) return 'адрес сервера прокси не находится в DNS';
  if (/network is unreachable|no route to host/i.test(t)) return 'до сервера прокси нет маршрута';
  if (/connection reset/i.test(t)) return 'соединение с сервером прокси сброшено — возможно, его блокируют';
  if (/x509|certificate|pinnedPeerCertSha256/i.test(l)) return 'сертификат сервера прокси не прошёл проверку (' + (/x509: ([^>\]]+)/.exec(l)?.[1] || 'x509').trim().slice(0, 120) + '). Если сервер сменил сертификат, удали ключ и добавь его заново';
  if (/reality/i.test(l)) return 'Reality: ' + l.split(' > ').at(-1).replace(/^.*?REALITY:\s*/i, '').slice(0, 160);
  const parts = l.replace(/^\[\w+\]\s*(\[\d+\]\s*)?/, '').split(' > ').map(s => s.replace(/^[\w/]+:\s*/, '').trim()).filter(Boolean);
  return parts.slice(-2).join(': ').slice(0, 300);
}
/* журнал одного процесса Xray → { push, hint, tail } */
function xjournal() {
  const log = []; let hint = '', at = 0, pri = 0;
  return {
    push(line) {
      const l = line.replace(XLOG, '').trim();
      if (!l || /^(Xray \d|A unified platform)/.test(l) || /is deprecated|core: Xray .* started/.test(l)) return;
      const out = /failed to process outbound traffic|failed to dial|\[dial /.test(l), warn = /^\[(Warning|Error)\]/.test(l);
      if (!out && !warn && !/^Failed|failed to (load|start)/i.test(l)) return;
      log.push(l); if (log.length > 40) log.shift();
      /* «не дозвонился до сервера» важнее, чем «оборвалось чтение» следом за ним */
      const p = out ? 2 : 1;
      if (p >= pri || Date.now() - at > 3000) { hint = reason(l); pri = p; at = Date.now(); }
    },
    hint: () => Date.now() - at < 20000 && hint ? 'Xray: ' + hint : '',
    tail: n => log.slice(-n).join('\n'),
  };
}
let J = xjournal();
const hint = () => J.hint();

function writeConf(file, cfg) {
  writeJSONSync(file, cfg);
  try { fs.chmodSync(file, 0o600); } catch {}
}

/* проверка конфига тем же Xray: ошибка — сразу понятным текстом, а работающий прокси не трогаем */
function xrayTest(bin, file) {
  return new Promise(ok => execFile(bin, ['run', '-test', '-c', file], { timeout: 20000 }, (e, out, err) => ok(e ? L.xrayErr(String(out) + '\n' + String(err)) : null)));
}

/* запустить Xray с конфигом и дождаться, пока он начнёт принимать соединения */
function runXray(bin, file, port, onLine) {
  const ch = spawn(bin, ['run', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XRAY_LOCATION_ASSET: path.dirname(bin) } });
  let buf = '';
  const feed = d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } if (buf.length > 65536) buf = ''; };
  ch.stdout.on('data', feed); ch.stderr.on('data', feed);
  const ready = new Promise((ok, no) => {
    let done = false;
    const end = (e) => { if (done) return; done = true; clearInterval(t); e ? no(e) : ok(); };
    const t0 = Date.now();
    const t = setInterval(() => {
      if (Date.now() - t0 > 10000) { end(new Error('Xray не запустился за 10 секунд')); try { ch.kill('SIGKILL'); } catch {} return; }
      const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); end(); }); s.on('error', () => s.destroy());
    }, 100);
    ch.once('exit', code => end(new Error('Xray завершился (код ' + code + ')')));
    ch.once('error', e => end(e));
  });
  return { ch, ready };
}
function killXray(ch) {
  if (!ch || ch.exitCode !== null || ch.signalCode) return;
  try { ch.kill('SIGTERM'); } catch {}
  const t = setTimeout(() => { try { ch.kill('SIGKILL'); } catch {} }, 2000); t.unref?.();
}
process.on('exit', () => { try { rt.child?.kill('SIGKILL'); } catch {} });

/* прокси для запросов: SOCKS5 у Xray или сам сервер из ключа (socks5/http без Xray) */
const pxOf = (p, lc) => lc ? { type: 'socks', host: '127.0.0.1', port: lc.port, user: lc.user, pass: lc.pass, local: true, key: 'x|' + lc.port + '|' + lc.user + '|' + rid(4) }
  : { type: p.kind === 'http' ? 'http' : 'socks', host: p.host, port: p.port, user: p.user, pass: p.pass, tls: !!p.tls, key: 'd|' + rid(6) };

/* ключ просит не проверять сертификат (allowInsecure / insecure=1), а Xray так больше не умеет. Смотрим сертификат сами:
   настоящий (цепочка и имя сходятся) — проверка как обычно; самоподписанный — закрепляем его отпечаток */
export function probeCert(p, ms = 8000) {
  const name = p.sni || L.list(p.hh)[0] || (L.isIPv4(p.host) || L.isIPv6(p.host) ? '' : p.host);
  return new Promise((ok, no) => {
    const s = tls.connect({ host: p.host, port: p.port, servername: name || undefined, rejectUnauthorized: false, ALPNProtocols: p.alpn?.length && p.kind !== 'hy2' ? p.alpn : undefined });
    const t = setTimeout(() => { s.destroy(); no(new Error('сервер не ответил за ' + ms / 1000 + ' с')); }, ms);
    s.once('secureConnect', () => {
      clearTimeout(t);
      const c = s.getPeerCertificate();
      const valid = s.authorized && name && !tls.checkServerIdentity(name, c);
      s.destroy();
      if (!c?.raw) return no(new Error('сервер не показал сертификат'));
      ok(valid ? '' : crypto.createHash('sha256').update(c.raw).digest('hex'));
    });
    s.once('error', e => { clearTimeout(t); no(e); });
  });
}
async function pinFor(srv, p) {
  if (p.sec !== 'tls' || !p.insecure || p.pcs) return '';
  if (srv.pin !== undefined && srv.pinFor === p.host + ':' + p.port) return srv.pin;
  try { srv.pin = await probeCert(p); srv.pinFor = p.host + ':' + p.port; save(); return srv.pin; }
  catch (e) {
    throw bad('Ключ просит не проверять сертификат сервера (insecure), а Xray так не умеет. Посмотреть сертификат самому не вышло: ' + (e.code || e.message)
      + (p.kind === 'hy2' ? '. Добавь в ключ pinSHA256=… (отпечаток сертификата сервера) — его знает тот, кто выдал ключ' : ''));
  }
}

/* собрать и проверить конфиг сервера: → { p, cfg } или ошибка */
async function prepare(srv, lc) {
  const p = L.parseLink(srv.link);
  const pin = await pinFor(srv, p);
  return { p, cfg: L.xrayConfig(p, { port: lc.port, user: lc.user, pass: lc.pass, pin }) };
}

/* привести запущенное к настройкам: включён ли, какой сервер (вызывать через serial) */
async function apply(force) {
  const v = D(), srv = v.on ? activeServer() : null;
  const sig = srv ? srv.id + '|' + crypto.createHash('sha1').update(srv.link + '|' + (srv.pin || '')).digest('hex') : '';
  if (!force && sig === rt.sig && (rt.state === 'ok' || rt.state === 'starting')) return;
  clearTimeout(rt.restartT); rt.restartT = null;
  const old = rt.child; rt.child = null; killXray(old);
  dropAgents();
  rt.sig = sig; rt.srv = srv?.id || ''; rt.px = null; rt.mode = null; J = xjournal();
  if (!v.on) return setState('off');
  if (!srv) return setState('error', 'Не выбран сервер прокси');
  let done;
  rt.ready = new Promise(ok => { done = ok; });
  local();
  setState('starting');
  try {
    const p = L.parseLink(srv.link), c = await coreInfo();
    if (!c) {
      if (L.needsXray(p)) { setState('nocore', 'Для ключей ' + L.describe(p).split(' · ')[0] + ' нужно ядро Xray, а его на сервере нет. Обнови Personal Computer (Настройки → Сервер → Обновления) — установщик поставит Xray'); return; }
      rt.mode = 'direct'; rt.px = pxOf(p);
      setState('ok');
      return;
    }
    const lc = local(); await localPort(lc);
    const { cfg } = await prepare(srv, lc);
    const file = path.join(CFG.data, 'xray.json');
    writeConf(file, cfg);
    const err = await xrayTest(c.bin, file);
    if (err) throw bad(err);
    const jr = J, x = runXray(c.bin, file, lc.port, l => jr.push(l));
    rt.child = x.ch;
    x.ch.once('exit', (code, sig) => {
      if (rt.child !== x.ch) return;
      rt.child = null;
      const why = L.xrayErr(jr.tail(8));
      console.warn('proxy: Xray завершился', code ?? sig, why);
      setState('error', 'Xray остановился' + (why && why !== 'Xray не запустился' ? ': ' + why : '') + ' — перезапускаю');
      /* перезапуск с паузой: 2, 5, 15, 30, 60 с */
      const d = [2, 5, 15, 30, 60][Math.min(rt.tries++, 4)] * 1000;
      rt.restartT = setTimeout(() => serial(() => apply(true)), d); rt.restartT.unref?.();
    });
    await x.ready;
    rt.mode = 'xray'; rt.px = pxOf(p, lc);
    setState('ok');
    /* проработал минуту — счётчик неудач сбрасываем */
    setTimeout(() => { if (rt.child === x.ch) rt.tries = 0; }, 60000).unref?.();
  } catch (e) {
    console.warn('proxy:', e.message);
    if (rt.child) { killXray(rt.child); rt.child = null; }
    setState('error', e.message);
  } finally { done(); }
}

/* ---------- маршрут запроса ---------- */
const PRIV4 = [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10], ['0.0.0.0', 8]];
const ip4 = s => s.split('.').reduce((a, b) => (a << 8) + +b, 0) >>> 0;
const inCidr = (ip, base, bits) => bits === 0 || ((ip4(ip) ^ ip4(base)) >>> (32 - bits)) === 0;
/* список «без прокси»: домены (и их поддомены), *.домен, IP и подсети IPv4 */
export function bypassList(text = D().bypass) {
  return String(text || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase().replace(/^\*?\./, '').replace(/\.$/, '')).filter(Boolean).slice(0, 200);
}
export function isLocalHost(h) {
  h = String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (L.isIPv4(h)) return PRIV4.some(([b, n]) => inCidr(h, b, n));
  if (L.isIPv6(h)) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^::ffff:(127|10|192\.168)\./.test(h);
  return !h.includes('.') || /\.(local|localhost|internal|lan|home\.arpa)$/.test(h);
}
export function bypassed(host, list = bypassList()) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isLocalHost(h)) return true;
  for (const b of list) {
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(b);
    if (m) { if (L.isIPv4(h) && +m[2] <= 32 && inCidr(h, m[1], +m[2])) return true; continue; }
    if (h === b || h.endsWith('.' + b)) return true;
  }
  return false;
}

/* куда идёт запрос kind ('model' | 'mcp' | 'tg' | 'agent' | 'upd'): null — напрямую, иначе прокси для tunnel.js */
export async function via(url, kind) {
  const v = D();
  if (!v.on || !v.use[kind]) return null;
  let host; try { host = new URL(url).hostname; } catch { return null; }
  if (bypassed(host)) return null;
  /* сервер только что запустился (задачи агента продолжаются сразу) или прокси перезапускается — ждём его, а не падаем */
  const wait = p => Promise.race([p, new Promise(ok => setTimeout(ok, 15000).unref?.())]);
  if (boot) await wait(boot);
  if (rt.state === 'starting') await wait(rt.ready);
  if (rt.state === 'ok' && rt.px) return rt.px;
  throw perr('прокси не работает' + (rt.err ? ' — ' + rt.err : ''), 'EPROXYDOWN');
}

/* fetch с учётом прокси */
export async function pfetch(url, init, kind) {
  let px;
  try { px = await via(url, kind); } catch (e) { throw Object.assign(new TypeError('fetch failed', { cause: e }), { proxy: true }); }
  return px ? proxyFetch(url, init, px, hint) : fetch(url, init);
}

/* для curl (обход Cloudflare в net.js): адрес прокси или null */
export async function curlProxy(url, kind) {
  const px = await via(url, kind);
  if (!px) return null;
  const auth = px.user || px.pass ? encodeURIComponent(px.user || '') + ':' + encodeURIComponent(px.pass || '') + '@' : '';
  const host = L.isIPv6(px.host) ? '[' + px.host + ']' : px.host;
  return (px.type === 'socks' ? 'socks5h' : px.tls ? 'https' : 'http') + '://' + auth + host + ':' + px.port;
}

/* ---------- команды агента и терминал: переменные окружения ---------- */
const NO_PROXY = 'localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,.local,.localhost,.internal';
export function agentEnv() {
  const v = D();
  if (!v.on || !v.use.agent || !activeServer()) return {};
  let url;
  if (rt.mode === 'direct' && rt.px) {
    const px = rt.px, auth = px.user || px.pass ? encodeURIComponent(px.user || '') + ':' + encodeURIComponent(px.pass || '') + '@' : '';
    url = (px.type === 'socks' ? 'socks5h' : px.tls ? 'https' : 'http') + '://' + auth + (L.isIPv6(px.host) ? '[' + px.host + ']' : px.host) + ':' + px.port;
  } else {
    /* и пока Xray (пере)запускается: команды подождут прокси, а не уйдут напрямую */
    const lc = v.local;
    if (!lc?.port) return {};
    url = 'http://' + encodeURIComponent(lc.user) + ':' + encodeURIComponent(lc.pass) + '@127.0.0.1:' + lc.port;
  }
  const no = [NO_PROXY, ...bypassList().map(b => /^[\d./]+$/.test(b) ? b : '.' + b)].join(',');
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: no, no_proxy: no };
}
let envSent = null;
function pushEnv() {
  const e = agentEnv(), s = JSON.stringify(e);
  if (s === envSent) return;
  envSent = s;
  try { setAgentProxy(e); } catch (x) { console.warn('proxy: переменные для агента:', x.message); }
}
/* одна строка для системной подсказки агента */
export function agentNote() {
  const e = agentEnv();
  if (!e.HTTPS_PROXY) return '';
  const t = tests.get(D().active);
  return '\nИнтернет у твоих команд идёт через прокси: переменные HTTPS_PROXY/HTTP_PROXY уже заданы' + (t?.ok && t.loc ? ' (выход — ' + t.loc + ')' : '')
    + '. С sudo они теряются — пиши sudo -E. Прокси включает и меняет только пользователь в настройках; не отключай его и не обходи.';
}

/* ---------- проверка: куда выходим, как быстро, отвечает ли модель ---------- */
const IPIFY = 'https://api.ipify.org?format=json';
async function exitInfo(fx) {
  const t0 = Date.now();
  try {
    const r = await fx(CFG.proxyTrace, { signal: AbortSignal.timeout(15000), headers: { 'cache-control': 'no-cache' } });
    const txt = await r.text();
    const ip = (/^ip=(.+)$/m.exec(txt) || [])[1], loc = (/^loc=([A-Z]{2})$/m.exec(txt) || [])[1];
    if (r.ok && ip) return { ip, loc: loc && loc !== 'XX' ? loc : '', ms: Date.now() - t0 };
  } catch (e) { if (e.proxy || e.cause?.proxy) throw e; }
  const t1 = Date.now();
  const r = await fx(IPIFY, { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  if (!j?.ip) throw new Error('не удалось узнать адрес выхода (HTTP ' + r.status + ')');
  return { ip: j.ip, loc: '', ms: Date.now() - t1 };
}
const why = e => e?.cause?.code || e?.cause?.message || (e?.name === 'TimeoutError' ? 'нет ответа за 15 с' : e?.message) || 'ошибка';

/* model: { base, key } — проверить и модель пользователя (через тот же прокси) */
export async function test(id, model) {
  const v = D(), srv = srvById(id || v.active);
  if (!srv) throw bad('Нет такого сервера');
  let px, tmp = null, h = hint;
  const c = await coreInfo();
  const live = rt.state === 'ok' && rt.srv === srv.id && rt.px;
  try {
    if (live) px = rt.px;
    else {
      const p = L.parseLink(srv.link);
      if (!c) {
        if (L.needsXray(p)) throw bad('Нужно ядро Xray, а его на сервере нет — обнови Personal Computer');
        px = pxOf(p);
      } else {
        /* свой Xray на время проверки — на свободном порту, работающий прокси не трогаем */
        const lc = { port: await randomPort(), user: 't-' + rid(4), pass: rid(12) };
        const { cfg } = await prepare(srv, lc);
        const file = path.join(CFG.data, 'xray-test-' + rid(4) + '.json');
        writeConf(file, cfg);
        const err = await xrayTest(c.bin, file);
        if (err) { fs.rm(file, { force: true }, () => {}); throw bad(err); }
        const tj = xjournal();
        tmp = { ...runXray(c.bin, file, lc.port, l => tj.push(l)), file };
        h = tj.hint;
        await tmp.ready;
        px = pxOf(p, lc);
      }
    }
    const fx = (u, init) => proxyFetch(u, init, px, h);
    /* для сравнения — адрес сервера без прокси; ради него долго не ждём */
    const directP = exitInfo((u, init) => fetch(u, init)).catch(() => null);
    const out = await exitInfo(fx).then(x => x, e => ({ err: why(e) }));
    const direct = await Promise.race([directP, new Promise(ok => setTimeout(ok, 2000, null).unref?.())]);
    const res = { id: srv.id, t: Date.now(), ok: !out.err, ...out, direct: direct && { ip: direct.ip, loc: direct.loc } };
    if (res.ok && model?.base && /^https?:\/\//i.test(model.base)) {
      let mh = ''; try { mh = new URL(model.base).hostname; } catch {}
      if (mh && !bypassed(mh) && v.use.model) {
        const t0 = Date.now();
        try {
          const r = await fx(model.base.replace(/\/+$/, '') + '/models', { headers: model.key ? { Authorization: 'Bearer ' + model.key } : {}, signal: AbortSignal.timeout(15000) });
          const body = await r.text().catch(() => '');
          res.model = { host: mh, status: r.status, ms: Date.now() - t0, region: /unsupported_country|not available in your (country|region)|country, region, or territory/i.test(body) };
        } catch (e) { res.model = { host: mh, err: why(e) }; }
      }
    }
    tests.set(srv.id, res);
    return res;
  } catch (e) {
    const res = { id: srv.id, t: Date.now(), ok: false, err: e.message };
    tests.set(srv.id, res);
    return res;
  } finally {
    /* свои соединения проверки — закрыть; работающий прокси (и ответ модели через него) не трогаем */
    if (px && !live) dropAgents(px.key);
    if (tmp) { killXray(tmp.ch); fs.rm(tmp.file, { force: true }, () => {}); }
  }
}

/* ---------- подписки ---------- */
const UA = 'PersonalComputer/1.0 (Xray; like v2rayN)';
function subInfo(h) {
  const o = {};
  const ui = h.get('subscription-userinfo');
  if (ui) for (const part of ui.split(';')) { const [k, val] = part.split('=').map(s => s.trim()); if (/^(upload|download|total|expire)$/.test(k) && /^\d+$/.test(val)) o[k] = +val; }
  let title = h.get('profile-title') || '';
  if (/^base64:/i.test(title)) title = L.unb64(title.slice(7)) || '';
  const every = +h.get('profile-update-interval');
  return { used: (o.upload || 0) + (o.download || 0) || undefined, total: o.total || undefined, expire: o.expire || undefined, title: title.trim().slice(0, 80) || undefined, every: every > 0 && every < 1000 ? every : undefined };
}
async function fetchSub(url) {
  const init = () => ({ headers: { 'user-agent': UA, accept: 'text/plain, */*' }, signal: AbortSignal.timeout(20000) });
  let r;
  /* сначала напрямую; не вышло, а прокси работает — через него */
  try { r = await fetch(url, init()); }
  catch (e) {
    if (rt.state !== 'ok' || !rt.px) throw bad('Подписка не скачалась: ' + why(e));
    r = await proxyFetch(url, init(), rt.px, hint).catch(e2 => { throw bad('Подписка не скачалась: ' + why(e2)); });
  }
  if (!r.ok) throw bad('Подписка не скачалась: HTTP ' + r.status);
  const body = (await r.text()).slice(0, 4 * 2 ** 20);
  if (/^\s*<(!doctype|html)/i.test(body)) throw bad('По ссылке веб-страница, а не подписка. Возьми у провайдера ссылку «для v2rayN» (список ключей)');
  const { links, errors } = L.parseList(body);
  if (!links.length) throw bad('В подписке нет подходящих ключей' + (errors.length ? ': ' + errors.slice(0, 3).join('; ') : ''));
  return { links, errors, info: subInfo(r.headers) };
}
const subName = (url, info) => info?.title || (() => { try { return new URL(url).hostname; } catch { return 'подписка'; } })();
const srvRec = (l, sub = '') => ({ id: rid(6), link: l.link, name: l.name, kind: l.kind, host: l.host, port: l.port, desc: L.describe(l), sub, t: Date.now() });

/* обновить серверы подписки: выбранный остаётся выбранным (по ключу, потом по имени) */
async function refreshSub(s) {
  try {
    const { links, errors, info } = await fetchSub(s.url);
    const v = D(), was = activeServer(), olds = v.servers.filter(x => x.sub === s.id);
    const recs = links.map(l => { const o = olds.find(x => x.link === l.link); return o ? { ...o, name: l.name, desc: L.describe(l) } : srvRec(l, s.id); });
    const rest = v.servers.filter(x => x.sub !== s.id);
    v.servers = [...rest, ...recs].slice(0, MAX_SERVERS);
    Object.assign(s, { t: Date.now(), n: recs.length, err: '', skipped: errors.length, info, name: subName(s.url, info) });
    if (was?.sub === s.id && !srvById(was.id)) {
      const same = recs.find(x => x.name === was.name) || recs[0];
      v.active = same?.id || '';
    }
    save();
    if (was?.sub === s.id) await serial(() => apply());
    return { n: recs.length, errors };
  } catch (e) {
    s.err = e.message; s.t = Date.now(); save();
    throw e;
  }
}
let subT = null;
function subTimer() {
  clearInterval(subT);
  subT = setInterval(() => {
    for (const s of D().subs) {
      const every = (s.info?.every || SUB_EVERY) * 3600e3;
      if (Date.now() - (s.t || 0) > Math.max(every, 3600e3)) refreshSub(s).catch(e => console.warn('proxy: подписка', s.name, e.message));
    }
  }, 30 * 60e3);
  subT.unref?.();
}

/* ---------- действия из настроек ---------- */
export async function addInput(text, select = true) {
  const v = D(), inp = L.parseInput(text);
  let errors = inp.errors, sub = null;
  const fresh = [], ids = [];
  if (inp.sub) {
    if (v.subs.some(s => s.url === inp.sub)) throw bad('Эта подписка уже добавлена — её можно обновить');
    if (v.subs.length >= MAX_SUBS) throw bad('Слишком много подписок (максимум ' + MAX_SUBS + ')');
    const r = await fetchSub(inp.sub);
    sub = { id: rid(6), url: inp.sub, name: subName(inp.sub, r.info), t: Date.now(), n: r.links.length, err: '', skipped: r.errors.length, info: r.info };
    for (const l of r.links) { const x = srvRec(l, sub.id); fresh.push(x); ids.push(x.id); }
    errors = r.errors;
  } else {
    if (!inp.links.length) throw bad(errors[0] ? 'Ключ не подошёл: ' + errors[0].replace(/^строка 1: /, '') : 'Ключей не нашлось');
    for (const l of inp.links) {
      const old = v.servers.find(x => x.link === l.link) || fresh.find(x => x.link === l.link);
      if (old) { ids.push(old.id); continue; }
      const x = srvRec(l); fresh.push(x); ids.push(x.id);
    }
  }
  if (v.servers.length + fresh.length > MAX_SERVERS) throw bad('Слишком много серверов (максимум ' + MAX_SERVERS + ')');
  if (sub) v.subs.push(sub);
  v.servers.push(...fresh);
  save();
  /* вставил ключ — им и пользуемся (подписка — только если ничего не выбрано); не прошёл проверку — остаётся в списке */
  let selErr = '';
  const want = ids[0] && (!activeServer() || (select && !sub)) ? ids[0] : '';
  if (want && want !== v.active) {
    try { await update({ active: want }); } catch (e) { selErr = e.message; }
  }
  return { added: fresh.length, ids, sub: sub?.id || null, errors: errors.slice(0, 20), selErr };
}

export async function update(b) {
  const v = D();
  if (b.use && typeof b.use === 'object') for (const k of KINDS) if (typeof b.use[k] === 'boolean') v.use[k] = b.use[k];
  if (typeof b.bypass === 'string') v.bypass = b.bypass.slice(0, 4000);
  if (typeof b.active === 'string') {
    const s = srvById(b.active);
    if (!s) throw bad('Нет такого сервера');
    if (v.on && s.id !== v.active) await check(s);
    v.active = s.id;
  }
  if (typeof b.on === 'boolean') {
    if (b.on && !activeServer()) throw bad('Сначала добавь ключ прокси');
    if (b.on && !v.on) await check(activeServer());
    v.on = b.on;
  }
  save();
  await serial(() => apply());
  pushEnv();
}
/* перед включением: ключ разбирается и Xray принимает конфиг — иначе не переключаем */
async function check(srv) {
  const p = L.parseLink(srv.link), c = await coreInfo(true);
  if (!c) { if (L.needsXray(p)) throw bad('Для этого ключа нужно ядро Xray, а его на сервере нет. Обнови Personal Computer (Настройки → Сервер → Обновления) — установщик поставит Xray'); return; }
  const lc = { port: 1080, user: 'x', pass: 'x' };
  const { cfg } = await prepare(srv, lc);
  const file = path.join(CFG.data, 'xray-check-' + rid(4) + '.json');
  writeConf(file, cfg);
  const err = await xrayTest(c.bin, file);
  fs.rm(file, { force: true }, () => {});
  if (err) throw bad(err);
}

export async function removeServer(id) {
  const v = D(), s = srvById(id);
  if (!s) throw bad('Нет такого сервера');
  v.servers = v.servers.filter(x => x !== s);
  tests.delete(id);
  if (v.active === id) { v.active = v.servers[0]?.id || ''; if (!v.active) v.on = false; }
  save();
  await serial(() => apply());
}
export async function removeSub(id) {
  const v = D(), s = v.subs.find(x => x.id === id);
  if (!s) throw bad('Нет такой подписки');
  v.subs = v.subs.filter(x => x !== s);
  v.servers = v.servers.filter(x => x.sub !== id);
  if (!activeServer()) { v.active = v.servers[0]?.id || ''; if (!v.active) v.on = false; }
  save();
  await serial(() => apply());
}
export async function refreshSubById(id) {
  const s = D().subs.find(x => x.id === id);
  if (!s) throw bad('Нет такой подписки');
  return refreshSub(s);
}

/* что показать в настройках: без ключей и адресов подписок */
const maskUrl = u => { try { const x = new URL(u); return x.host + (x.pathname.length > 1 ? '/…' : ''); } catch { return '…'; } };
export async function state(u) {
  const v = D(), c = await coreInfo();
  return {
    admin: !!u?.admin, on: v.on, active: v.active, use: { ...v.use }, bypass: v.bypass,
    core: c ? { version: c.version } : null,
    status: { state: rt.state, err: rt.err, since: rt.since, mode: rt.mode },
    servers: v.servers.map(s => ({ id: s.id, name: s.name, kind: s.kind, host: s.host, port: s.port, desc: s.desc, sub: s.sub || null, xray: L.needsXray(s), pinned: !!s.pin, test: tests.get(s.id) || null })),
    subs: v.subs.map(s => ({ id: s.id, name: s.name, url: maskUrl(s.url), t: s.t, n: s.n, err: s.err || '', skipped: s.skipped || 0, info: s.info || null })),
  };
}
export const summary = () => ({ on: D().on, state: rt.state, err: rt.err });

export function initProxy() {
  D();
  /* ядро ищем при старте: в настройках сразу видно, есть ли оно */
  boot = coreInfo().then(() => serial(() => apply())).catch(e => console.warn('proxy:', e.message)).finally(() => { boot = null; });
  subTimer();
}
