/* Запросы через прокси без сторонних библиотек: туннель SOCKS5 или HTTP CONNECT до сервера назначения,
   поверх — обычный HTTP/1.1 (node:http / node:https с keep-alive). proxyFetch отдаёт настоящий Response, как fetch:
   потоковое тело (SSE модели читается так же), распаковка gzip/deflate/br, переадресации, отмена через signal.
   Имя хоста уходит прокси как есть (SOCKS5 с доменом): DNS спрашивает прокси, а не сервер — подмена DNS не мешает
   и не видно, куда сервер ходит. Прокси — { type: 'socks'|'http', host, port, user, pass, tls, key }. */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { Readable, pipeline } from 'node:stream';

const SOCKS_REP = ['', 'общая ошибка прокси', 'правила прокси не пускают туда', 'сеть недоступна', 'адрес недоступен', 'сервер отказал в соединении', 'истекло время', 'команда не поддерживается', 'тип адреса не поддерживается'];

/* ошибка на пути через прокси: code — сразу понятный текст (его показывают как «(…)» после «не достучался») */
export function perr(msg, errno) {
  const text = 'через прокси: ' + msg;
  return Object.assign(new Error(text), { code: text, errno: errno || 'EPROXY', proxy: true });
}

function connectProxy(px, ms) {
  return new Promise((ok, no) => {
    const s = px.tls ? tls.connect({ host: px.host, port: px.port, servername: net.isIP(px.host) ? undefined : px.host, ALPNProtocols: ['http/1.1'] }) : net.connect(px.port, px.host);
    const t = setTimeout(() => { s.destroy(); no(perr('прокси не отвечает', 'ETIMEDOUT')); }, ms);
    /* дальше ошибки сокета ловит тот, кто им пользуется; пустой обработчик — чтобы ошибка в промежутке не уронила процесс */
    s.once(px.tls ? 'secureConnect' : 'connect', () => { clearTimeout(t); s.off('error', bad); s.on('error', () => {}); ok(s); });
    const bad = e => { clearTimeout(t); no(perr(px.local ? 'Xray не отвечает (' + (e.code || e.message) + ')' : 'прокси-сервер недоступен (' + (e.code || e.message) + ')', e.code)); };
    s.once('error', bad);
  });
}

/* читаем ответ прокси кусками, пока reader не скажет «хватит» (вернёт число съеденных байт) */
function talk(s, ms, reader) {
  return new Promise((ok, no) => {
    let buf = Buffer.alloc(0);
    const done = (e, v) => { clearTimeout(t); s.pause(); s.off('data', on); s.off('error', er); s.off('close', cl); e ? (s.destroy(), no(e)) : ok(v); };
    const t = setTimeout(() => done(perr('прокси не ответил', 'ETIMEDOUT')), ms);
    const er = e => done(perr('связь с прокси оборвалась (' + (e.code || e.message) + ')', e.code));
    const cl = () => done(perr('прокси закрыл соединение', 'ECONNRESET'));
    const on = d => {
      buf = Buffer.concat([buf, d]);
      let r;
      try { r = reader(buf); } catch (e) { return done(e); }
      if (r == null) return;
      const rest = buf.subarray(r.used);
      if (rest.length) s.unshift(rest);
      done(null, r.value);
    };
    /* после прошлого шага сокет на паузе (чтобы не потерять байты) — сам по себе он не пойдёт */
    s.on('data', on); s.once('error', er); s.once('close', cl); s.resume();
  });
}

async function socks5(px, host, port, ms) {
  const s = await connectProxy(px, ms);
  const auth = !!(px.user || px.pass);
  s.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
  const m = await talk(s, ms, b => b.length < 2 ? null : { used: 2, value: b[1] });
  if (m === 2) {
    const u = Buffer.from(String(px.user || '')), p = Buffer.from(String(px.pass || ''));
    s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const st = await talk(s, ms, b => b.length < 2 ? null : { used: 2, value: b[1] });
    if (st !== 0) { s.destroy(); throw perr('прокси не принял логин и пароль', 'EPROXYAUTH'); }
  } else if (m !== 0) { s.destroy(); throw perr(m === 255 ? 'прокси требует логин и пароль' : 'прокси ответил не по SOCKS5', 'EPROXYAUTH'); }
  const h = String(host).replace(/^\[|\]$/g, '');
  const addr = net.isIPv4(h) ? Buffer.from([1, ...h.split('.').map(Number)]) : (() => { const n = Buffer.from(h); if (n.length > 255) throw perr('слишком длинное имя хоста'); return Buffer.concat([Buffer.from([3, n.length]), n]); })();
  s.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([port >> 8, port & 255])]));
  await talk(s, ms, b => {
    if (b.length < 5) return null;
    if (b[0] !== 5) throw perr('прокси ответил не по SOCKS5');
    if (b[1] !== 0) throw perr(SOCKS_REP[b[1]] || 'отказ прокси (код ' + b[1] + ')', 'EPROXYREP');
    const len = b[3] === 1 ? 4 : b[3] === 4 ? 16 : b[3] === 3 ? 1 + b[4] : -1;
    if (len < 0) throw perr('прокси ответил не по SOCKS5');
    return b.length < 4 + len + 2 ? null : { used: 4 + len + 2, value: true };
  });
  return s;
}

async function connectVia(px, host, port, ms) {
  const s = await connectProxy(px, ms);
  const hp = (net.isIPv6(host) ? '[' + host + ']' : host) + ':' + port;
  const auth = px.user || px.pass ? 'Proxy-Authorization: Basic ' + Buffer.from(px.user + ':' + px.pass).toString('base64') + '\r\n' : '';
  s.write(`CONNECT ${hp} HTTP/1.1\r\nHost: ${hp}\r\n${auth}\r\n`);
  const code = await talk(s, ms, b => {
    const i = b.indexOf('\r\n\r\n');
    if (i < 0) { if (b.length > 16384) throw perr('прокси ответил не по HTTP'); return null; }
    const m = /^HTTP\/1\.[01] (\d{3})/.exec(b.subarray(0, i).toString('latin1'));
    if (!m) throw perr('прокси ответил не по HTTP');
    return { used: i + 4, value: +m[1] };
  });
  if (code === 200) return s;
  s.destroy();
  throw perr(code === 407 ? 'прокси не принял логин и пароль' : code === 403 ? 'правила прокси не пускают туда' : code === 502 || code === 504 ? 'прокси не смог подключиться к ' + host : 'прокси ответил HTTP ' + code, 'EPROXYREP');
}

/* сокет до host:port через прокси (дальше по нему идёт TLS или сразу HTTP) */
export async function tunnel(px, host, port, ms = 15000) {
  const s = await (px.type === 'socks' ? socks5(px, host, port, ms) : connectVia(px, host, port, ms));
  /* рукопожатие с прокси оставило сокет на паузе — дальше его читает HTTP или TLS */
  s.resume();
  return s;
}

/* ---------- пул соединений: свой агент на каждый прокси (keep-alive) ---------- */
const pools = new Map();
function agentFor(px, secure) {
  const k = (secure ? 's|' : 'p|') + (px.key || [px.type, px.host, px.port, px.user, px.pass, px.tls, px.ca ? 'ca' : ''].join('|'));
  let a = pools.get(k);
  if (a) return a;
  a = new (secure ? https : http).Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, scheduling: 'lifo' });
  a.createConnection = (o, cb) => {
    tunnel(px, o.host, +o.port).then(s => {
      if (!secure) return cb(null, s);
      const name = o.servername || (net.isIP(o.host) ? undefined : o.host);
      cb(null, tls.connect({ socket: s, servername: name, ALPNProtocols: ['http/1.1'], ...(px.ca ? { ca: px.ca } : {}) }));
    }, e => cb(e));
  };
  /* свободное соединение живёт 15 с: сервер всё равно скоро его закроет, а «протухшее» рвёт следующий запрос */
  const keep = a.keepSocketAlive.bind(a);
  a.keepSocketAlive = sock => { const r = keep(sock); if (r) sock.setTimeout(15000); return r; };
  const reuse = a.reuseSocket.bind(a);
  a.reuseSocket = (sock, req) => { sock.setTimeout(0); return reuse(sock, req); };
  pools.set(k, a);
  return a;
}
/* прокси поменялся или выключен: старые соединения больше не нужны (key — только этого прокси) */
export function dropAgents(key) {
  for (const [k, a] of pools) if (!key || k.slice(2) === key) { a.destroy(); pools.delete(k); }
}

/* ---------- fetch ---------- */
const NOBODY = new Set([101, 204, 205, 304]);
const fail = (e, hint) => {
  if (e?.proxy) return Object.assign(new TypeError('fetch failed', { cause: e }), { proxy: true });
  const c = e?.code || '';
  /* туннель есть, а дальше тишина: обычно это сервер прокси не смог (или не захотел) соединиться */
  const cut = /^(ECONNRESET|EPIPE|ECONNABORTED)$/.test(c) || /socket hang up|disconnected before secure TLS/i.test(e?.message || '');
  if (cut) return Object.assign(new TypeError('fetch failed', { cause: perr('соединение оборвалось' + (hint ? ' — ' + hint : ''), c || 'ECONNRESET') }), { proxy: true });
  return Object.assign(new TypeError('fetch failed', { cause: e }), { proxy: true });
};

function send(u, method, headers, data, px, signal) {
  return new Promise((ok, no) => {
    const secure = u.protocol === 'https:';
    const h = {};
    for (const [k, v] of headers) h[k] = v;
    if (!headers.has('accept')) h.accept = '*/*';
    if (!headers.has('accept-encoding')) h['accept-encoding'] = 'gzip, deflate, br';
    if (!headers.has('user-agent')) h['user-agent'] = 'node';
    if (data) h['content-length'] = String(data.length);
    const r = (secure ? https : http).request({ host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || (secure ? 443 : 80), path: u.pathname + u.search, method, headers: h, agent: agentFor(px, secure) });
    const ab = () => { r.destroy(signal.reason); no(signal.reason); };
    signal?.addEventListener('abort', ab, { once: true });
    r.once('response', res => { signal?.removeEventListener('abort', ab); ok(res); });
    r.once('error', e => { signal?.removeEventListener('abort', ab); no(Object.assign(e, { reused: r.reusedSocket })); });
    r.end(data || undefined);
  });
}

function toResponse(res, u, redirected, method, signal) {
  const status = res.statusCode;
  if (status < 200 || status > 599) { res.destroy(); throw new TypeError('fetch failed', { cause: new Error('неожиданный ответ HTTP ' + status) }); }
  const headers = new Headers();
  const raw = res.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) { try { headers.append(raw[i], raw[i + 1]); } catch {} }
  let body = null;
  if (method === 'HEAD' || NOBODY.has(status)) res.resume();
  else {
    const enc = String(res.headers['content-encoding'] || '').trim().toLowerCase();
    const Z = zlib.constants;
    const z = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip({ flush: Z.Z_SYNC_FLUSH, finishFlush: Z.Z_SYNC_FLUSH })
      : enc === 'deflate' ? zlib.createInflate({ flush: Z.Z_SYNC_FLUSH, finishFlush: Z.Z_SYNC_FLUSH })
      : enc === 'br' ? zlib.createBrotliDecompress({ flush: Z.BROTLI_OPERATION_FLUSH, finishFlush: Z.BROTLI_OPERATION_FLUSH }) : null;
    const src = z ? pipeline(res, z, () => {}) : res;
    if (signal) {
      const ab = () => src.destroy(signal.reason);
      if (signal.aborted) ab(); else signal.addEventListener('abort', ab, { once: true });
      src.once('close', () => signal.removeEventListener('abort', ab));
    }
    body = Readable.toWeb(src);
  }
  const resp = new Response(body, { status, statusText: res.statusMessage || '', headers });
  Object.defineProperty(resp, 'url', { value: u.href });
  Object.defineProperty(resp, 'redirected', { value: redirected });
  return resp;
}

/* fetch через прокси px; hint() — что знает о последней ошибке сам прокси (строка журнала Xray) */
export async function proxyFetch(url, init = {}, px, hint) {
  const rq = new Request(url, init);
  const signal = init.signal || null;
  if (signal?.aborted) throw signal.reason;
  let data = rq.body ? Buffer.from(await rq.arrayBuffer()) : null;
  let u = new URL(rq.url), method = rq.method;
  const headers = new Headers(rq.headers);
  for (let hop = 0; ; hop++) {
    if (!/^https?:$/.test(u.protocol)) throw new TypeError('fetch failed', { cause: new Error('поддерживаются только http и https') });
    let res;
    for (let tries = 0; ; tries++) {
      try { res = await send(u, method, headers, data, px, signal); break; }
      catch (e) {
        if (signal?.aborted) throw signal.reason;
        /* соединение из пула успело протухнуть — сервер ещё ничего не получил, повторяем по новому */
        if (e.reused && tries === 0) continue;
        /* причину Xray пишет в журнал чуть позже, чем рвёт соединение, — даём ему мгновение */
        if (px.local && hint && !e.proxy) await new Promise(r => setTimeout(r, 150));
        throw fail(e, hint?.());
      }
    }
    const loc = res.headers.location;
    if (loc && [301, 302, 303, 307, 308].includes(res.statusCode) && rq.redirect !== 'manual') {
      res.resume();
      if (rq.redirect === 'error' || hop >= 20) throw new TypeError('fetch failed', { cause: new Error(hop >= 20 ? 'слишком много переадресаций' : 'переадресация запрещена') });
      const next = new URL(loc, u);
      if (res.statusCode === 303 ? method !== 'HEAD' : res.statusCode < 307 && method === 'POST') {
        method = 'GET'; data = null;
        for (const k of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(k);
      }
      if (next.origin !== u.origin) for (const k of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(k);
      u = next;
      continue;
    }
    return toResponse(res, u, hop > 0, method, signal);
  }
}
