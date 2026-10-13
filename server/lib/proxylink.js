/* Ключи прокси: разбор ссылок и подписок, конфиг для ядра Xray. Только чистые функции — запуском Xray
   и маршрутами запросов занимается proxy.js.
   Понимаем то, что выдают 3x-ui, Marzban, Remnawave, v2rayN, Hiddify и Shadowrocket:
     vless://uuid@host:port?type=…&security=reality|tls&…#имя
     vmess://base64(JSON v2rayN) · vmess://uuid@host:port?… · vmess://base64(cipher:uuid@host:port)?… (Shadowrocket)
     trojan://пароль@host:port?…#имя
     ss://base64(метод:пароль)@host:port#имя (SIP002) · ss://base64(метод:пароль@host:port)#имя
     hysteria2://auth@host:port?sni=…&obfs=salamander&obfs-password=…#имя (то же hy2://)
     socks5://[user:pass@]host:port · http(s)://[user:pass@]host:port — обычный прокси
   Подписка — https-ссылка (с путём) на список таких ключей: строками или одним base64. */

export const bad = m => Object.assign(new Error(m), { status: 400 });
const dec = s => { try { return decodeURIComponent(s); } catch { return s; } };
const isB64 = s => /^[A-Za-z0-9+/_-]+={0,2}$/.test(s) && s.length >= 8;
/* base64 и base64url, с паддингом и без */
export function unb64(s) {
  const t = String(s).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t)) return null;
  const b = Buffer.from(t, 'base64');
  const out = b.toString('utf8');
  return out.includes('�') ? null : out;
}

/* query без «+ → пробел» (в паролях и путях «+» — это «+»); имена параметров — без учёта регистра */
function qs(q) {
  const o = {};
  for (const part of String(q || '').replace(/^\?/, '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = dec(i < 0 ? part : part.slice(0, i)).toLowerCase();
    if (!(k in o)) o[k] = i < 0 ? '' : dec(part.slice(i + 1));
  }
  return o;
}

/* схема://[userinfo@]host[:port][/path][?query][#name]; порт у hysteria2 бывает списком: 443,20000-30000 */
function splitUrl(s) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(?:#(.*))?$/is.exec(s);
  if (!m) return null;
  let auth = m[2], user = null;
  const at = auth.lastIndexOf('@');
  if (at >= 0) { user = auth.slice(0, at); auth = auth.slice(at + 1); }
  const hm = /^(\[[0-9a-f:.]+\]|[^:[\]]*)(?::([\d,-]*))?$/i.exec(auth);
  if (!hm) return null;
  return { scheme: m[1].toLowerCase(), user, host: hm[1].replace(/^\[|\]$/g, ''), port: hm[2] || '', path: m[3], q: qs(m[4]), name: m[5] != null ? dec(m[5]).trim() : '' };
}

const HOST_RE = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.?$/i;
export const isIPv4 = h => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(h);
export const isIPv6 = h => /^[0-9a-f:.]+$/i.test(h) && h.includes(':') && h.split(':').length <= 9;
const isIP = h => isIPv4(h) || isIPv6(h);
function hostOk(h) {
  if (!h) throw bad('В ключе нет адреса сервера');
  if (!isIP(h) && !(h.length <= 253 && HOST_RE.test(h))) throw bad('Странный адрес сервера: ' + h.slice(0, 60));
  return h.replace(/\.$/, '');
}
function portOk(p, def) {
  const n = p === '' || p == null ? def : +p;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw bad('Неверный порт: ' + String(p).slice(0, 20));
  return n;
}
const flag = v => /^(1|true|yes|on)$/i.test(String(v ?? ''));
/* отпечаток сертификата (pcs, pinSHA256): SHA-256 в hex, можно с двоеточиями, несколько — через запятую */
function pinOk(v) {
  for (const x of list(v)) if (!/^[0-9a-f]{64}$/i.test(x.replace(/:/g, ''))) throw bad('Неверный отпечаток сертификата в ключе (pcs / pinSHA256): нужен SHA-256 — 64 шестнадцатеричных знака');
  return v;
}
export const list = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
const clip = (s, n) => String(s ?? '').trim().slice(0, n);

/* транспорт и шифрование — общие для vless, vmess и trojan */
const NET = { tcp: 'raw', raw: 'raw', ws: 'ws', websocket: 'ws', grpc: 'grpc', gun: 'grpc', httpupgrade: 'httpupgrade', xhttp: 'xhttp', splithttp: 'xhttp' };
function stream(P, defSec) {
  const t = String(P.type || P.net || 'tcp').toLowerCase();
  if (t === 'h2' || t === 'http' || t === 'h3') throw bad('Транспорт HTTP/2 убран из Xray — попроси у провайдера ключ с XHTTP');
  if (t === 'quic') throw bad('Транспорт QUIC убран из Xray — попроси у провайдера ключ с XHTTP');
  if (t === 'kcp' || t === 'mkcp') throw bad('Транспорт mKCP не поддерживается — нужен ключ с TCP, WebSocket, gRPC, HTTPUpgrade или XHTTP');
  const net = NET[t];
  if (!net) throw bad('Неизвестный транспорт: ' + t.slice(0, 20));
  let sec = String(P.security ?? defSec ?? 'none').toLowerCase() || 'none';
  if (sec === 'xtls') throw bad('XTLS в таком виде убран из Xray — нужен ключ с Reality или TLS (flow=xtls-rprx-vision)');
  if (!['none', 'tls', 'reality'].includes(sec)) throw bad('Неизвестное шифрование: ' + sec.slice(0, 20));
  const s = {
    net, sec,
    sni: clip(P.sni || P.peer || P.servername, 253), fp: clip(P.fp || P.fingerprint, 32).toLowerCase(), alpn: list(P.alpn),
    insecure: flag(P.allowinsecure ?? P.insecure ?? P.allow_insecure ?? P.skip_cert_verify),
    pcs: clip(P.pcs || P.pinsha256, 2000), vcn: clip(P.vcn, 500), ech: clip(P.ech, 4000),
    path: clip(P.path, 2000), hh: clip(P.host, 500), htype: String(P.headertype || P.header || 'none').toLowerCase(),
    svc: clip(P.servicename ?? P.service_name ?? '', 200), authority: clip(P.authority, 253), mode: clip(P.mode, 30),
  };
  if (sec === 'reality') {
    Object.assign(s, { pbk: clip(P.pbk || P.publickey || P.password, 200), sid: clip(P.sid || P.shortid, 32), spx: clip(P.spx || P.spiderx, 500), pqv: clip(P.pqv, 4000) });
    if (!s.pbk) throw bad('В ключе Reality нет открытого ключа сервера (pbk)');
  }
  pinOk(s.pcs);
  if (net === 'grpc' && !s.svc && s.path) s.svc = s.path.replace(/^\//, '');
  if (P.extra) {
    try { s.extra = JSON.parse(P.extra); } catch { throw bad('Параметр extra в ключе — не JSON'); }
    if (!s.extra || typeof s.extra !== 'object' || Array.isArray(s.extra)) throw bad('Параметр extra в ключе — не объект JSON');
  }
  return s;
}

const SS = ['aes-128-gcm', 'aes-256-gcm', 'chacha20-poly1305', 'chacha20-ietf-poly1305', 'xchacha20-poly1305', 'xchacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305', 'none', 'plain'];

/* vmess в формате v2rayN: base64 от JSON */
function vmessJson(j) {
  const P = {
    type: j.net || 'tcp', security: j.tls === true ? 'tls' : String(j.tls || 'none'), sni: j.sni, fp: j.fp, alpn: j.alpn, host: j.host, path: j.path,
    allowinsecure: j.allowInsecure ?? j.insecure ?? j.skip_cert_verify, pbk: j.pbk, sid: j.sid, spx: j.spx,
  };
  const net = String(P.type).toLowerCase();
  if (net === 'tcp' || net === 'raw') P.headertype = j.type;
  else if (net === 'grpc') { P.servicename = j.path; P.mode = j.type === 'multi' ? 'multi' : ''; P.authority = j.host; P.host = ''; }
  else if (net === 'xhttp' || net === 'splithttp') P.mode = j.type && j.type !== 'none' ? j.type : '';
  return { kind: 'vmess', name: clip(j.ps, 120), host: hostOk(String(j.add || '').trim()), port: portOk(String(j.port ?? '').trim(), 443), id: clip(j.id, 64), scy: clip(j.scy || 'auto', 30).toLowerCase(), ...stream(P, 'none') };
}

/* одна ссылка → описание сервера (или ошибка с понятным текстом) */
export function parseLink(raw) {
  const s = String(raw || '').trim();
  const scheme = (/^([a-z][a-z0-9+.-]*):\/\//i.exec(s) || [])[1]?.toLowerCase();
  if (!scheme) throw bad('Это не ключ прокси: нужна ссылка vless://, vmess://, trojan://, ss://, hysteria2://, socks5:// или http://');
  if (s.length > 16000) throw bad('Слишком длинный ключ');
  let p;
  if (scheme === 'vmess') {
    const body = s.slice(8).split('#')[0];
    const [b64, query] = body.split('?');
    const txt = unb64(b64);
    if (txt && txt.trim().startsWith('{')) {
      let j; try { j = JSON.parse(txt); } catch { throw bad('Ключ vmess:// не читается: внутри испорченный JSON'); }
      p = vmessJson(j);
    } else if (txt && /^[\w-]+:[^@]+@[^:]+:\d+$/.test(txt.trim())) {
      /* Shadowrocket: base64(шифр:uuid@host:port)?remarks=…&obfs=websocket&tls=1&peer=… */
      const m = /^([\w-]+):(.+)@(.+):(\d+)$/.exec(txt.trim()), Q = qs(query);
      const obfs = String(Q.obfs || '').toLowerCase();
      p = { kind: 'vmess', name: clip(Q.remarks || Q.remark, 120), host: hostOk(m[3]), port: portOk(m[4]), id: m[2], scy: m[1].toLowerCase(),
        ...stream({ type: obfs === 'websocket' ? 'ws' : obfs === 'grpc' ? 'grpc' : 'tcp', headertype: obfs === 'http' ? 'http' : 'none', security: flag(Q.tls) ? 'tls' : 'none',
          sni: Q.peer || Q.sni, host: Q.obfsparam, path: Q.path, allowinsecure: Q.allowinsecure }, 'none') };
    } else {
      const u = splitUrl(s);
      if (!u || !u.user) throw bad('Ключ vmess:// не читается');
      p = { kind: 'vmess', name: u.name, host: hostOk(u.host), port: portOk(u.port, 443), id: dec(u.user), scy: clip(u.q.encryption || 'auto', 30).toLowerCase(), ...stream(u.q, 'none') };
    }
    if (!/^[\w-]{1,64}$/.test(p.id)) throw bad('В ключе vmess:// нет id пользователя');
  } else if (scheme === 'vless') {
    const u = splitUrl(s);
    if (!u || !u.user) throw bad('Ключ vless:// не читается: нужно vless://uuid@адрес:порт?…');
    p = { kind: 'vless', name: u.name, host: hostOk(u.host), port: portOk(u.port, 443), id: dec(u.user), flow: clip(u.q.flow, 40), enc: clip(u.q.encryption || 'none', 4000), ...stream(u.q, 'none') };
    if (!/^[^\s:@/?#]{1,64}$/.test(p.id)) throw bad('В ключе vless:// нет id пользователя');
  } else if (scheme === 'trojan') {
    const u = splitUrl(s);
    if (!u || !u.user) throw bad('Ключ trojan:// не читается: нужно trojan://пароль@адрес:порт');
    p = { kind: 'trojan', name: u.name, host: hostOk(u.host), port: portOk(u.port, 443), pass: dec(u.user), ...stream(u.q, 'tls') };
  } else if (scheme === 'ss') {
    let u = splitUrl(s);
    if (!u || u.user == null) {
      /* старый вид: ss://base64(метод:пароль@адрес:порт)#имя */
      const [b, name = ''] = s.slice(5).split('#');
      const txt = unb64(b.split(/[/?]/)[0]);
      if (!txt || !txt.includes('@')) throw bad('Ключ ss:// не читается');
      u = splitUrl('ss://' + txt.replace(/^([^:]+):(.*)@/s, (_, m, pw) => m + ':' + encodeURIComponent(pw) + '@') + (name ? '#' + name : ''));
      if (!u) throw bad('Ключ ss:// не читается');
    }
    let ui = dec(u.user);
    if (!ui.includes(':')) ui = unb64(u.user) || '';
    const i = ui.indexOf(':');
    if (i < 1) throw bad('В ключе ss:// нет метода шифрования и пароля');
    const method = ui.slice(0, i).toLowerCase(), pass = ui.slice(i + 1);
    if (u.q.plugin) throw bad('Shadowsocks с плагином (' + u.q.plugin.split(';')[0].slice(0, 30) + ') Xray не поддерживает');
    if (!SS.includes(method)) throw bad('Шифрование Shadowsocks «' + method.slice(0, 40) + '» не поддерживается (старые потоковые шифры Xray убрал)');
    p = { kind: 'ss', name: u.name, host: hostOk(u.host), port: portOk(u.port), method, pass, net: 'raw', sec: 'none' };
  } else if (scheme === 'hysteria2' || scheme === 'hy2') {
    const u = splitUrl(s);
    if (!u) throw bad('Ключ hysteria2:// не читается');
    const ports = u.port || '443', first = ports.split(/[,-]/)[0];
    const hop = /[,-]/.test(ports) ? ports : clip(u.q.mport, 200);
    if (hop && !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(hop)) throw bad('Неверный список портов: ' + hop.slice(0, 40));
    const obfs = String(u.q.obfs || '').toLowerCase();
    if (obfs && obfs !== 'salamander') throw bad('Маскировка Hysteria «' + obfs.slice(0, 20) + '» не поддерживается (только salamander)');
    p = { kind: 'hy2', name: u.name, host: hostOk(u.host), port: portOk(first), auth: dec(u.user || ''), hop, obfs, obfsPw: clip(u.q['obfs-password'] || u.q.obfs_password, 500),
      net: 'hysteria', sec: 'tls', sni: clip(u.q.sni || u.q.peer, 253), alpn: list(u.q.alpn), insecure: flag(u.q.insecure ?? u.q.allowinsecure), pcs: clip(u.q.pinsha256 || u.q.pcs, 2000), vcn: clip(u.q.vcn, 500) };
    if (obfs && !p.obfsPw) throw bad('Для маскировки salamander в ключе нет obfs-password');
    pinOk(p.pcs);
  } else if (/^(socks5h?|socks4a?|socks)$/.test(scheme)) {
    if (/^socks4/.test(scheme)) throw bad('SOCKS4 не поддерживается — нужен SOCKS5');
    const u = splitUrl(s);
    if (!u) throw bad('Адрес прокси не читается');
    let user = '', pass = '';
    if (u.user != null) {
      const i = u.user.indexOf(':');
      if (i >= 0) { user = dec(u.user.slice(0, i)); pass = dec(u.user.slice(i + 1)); }
      else { const t = /^[A-Za-z0-9+/_-]+={0,2}$/.test(u.user) ? unb64(u.user) : null; if (t && t.includes(':')) { user = t.slice(0, t.indexOf(':')); pass = t.slice(t.indexOf(':') + 1); } else user = dec(u.user); }
    }
    p = { kind: 'socks', name: u.name, host: hostOk(u.host), port: portOk(u.port, 1080), user, pass };
  } else if (scheme === 'http' || scheme === 'https') {
    const u = splitUrl(s);
    if (!u) throw bad('Адрес прокси не читается');
    let user = '', pass = '';
    if (u.user != null) { const i = u.user.indexOf(':'); user = dec(i < 0 ? u.user : u.user.slice(0, i)); pass = i < 0 ? '' : dec(u.user.slice(i + 1)); }
    p = { kind: 'http', name: u.name, host: hostOk(u.host), port: portOk(u.port, scheme === 'https' ? 443 : 80), user, pass, tls: scheme === 'https' };
  } else throw bad('Протокол ' + scheme + ':// не поддерживается. Подходят vless, vmess, trojan, ss, hysteria2, socks5, http');
  if (!p.name) p.name = p.host + ':' + p.port;
  p.name = clip(p.name, 120);
  return p;
}

/* http(s)-ссылка с путём или параметрами — подписка, без пути — обычный HTTP-прокси */
export const isSubUrl = s => { const u = splitUrl(String(s || '').trim()); return !!u && (u.scheme === 'http' || u.scheme === 'https') && (u.path.replace(/\/+$/, '') !== '' || Object.keys(u.q).length > 0); };

/* текст, который вставили в поле: ключ, несколько ключей, base64-подписка целиком или ссылка на подписку */
export function parseInput(text) {
  let t = String(text || '').trim();
  if (!t) throw bad('Вставь ключ: vless://, vmess://, trojan://, ss://, hysteria2://, socks5://, http:// — или ссылку на подписку');
  if (!/\s/.test(t) && isSubUrl(t)) return { sub: t, links: [], errors: [] };
  return { sub: null, ...parseList(t) };
}

/* тело подписки или вставленный текст → ключи; что не разобралось — в errors (с номером строки) */
export function parseList(body) {
  const t = String(body || '').trim().replace(/^﻿/, '');
  if (/^[[{]/.test(t)) throw bad('Подписка в формате JSON (Xray или sing-box) не поддерживается — нужна ссылка для v2rayN: список ключей или base64');
  if (/^(proxies|proxy-groups|port|mixed-port)\s*:/m.test(t)) throw bad('Это подписка Clash (YAML) — нужна ссылка для v2rayN: список ключей или base64');
  /* base64 бывает одним блоком (иногда с переносами строк) или построчно — берём то прочтение, где ключей больше */
  let r = scan(t);
  if (!t.includes('://')) {
    const d = unb64(t);
    if (d && d.includes('://')) { const r2 = scan(d.trim()); if (r2.links.length > r.links.length) r = r2; }
  }
  if (!r.links.length && !r.errors.length) throw bad('Ключей не нашлось');
  return r;
}
function scan(t) {
  const links = [], errors = [];
  t.split(/\r?\n/).forEach((l, n) => {
    l = l.trim();
    if (!l || l.startsWith('#') || l.startsWith('//')) return;
    /* строка может быть сама в base64 (так шлют некоторые панели) */
    if (!l.includes('://') && isB64(l)) { const d = unb64(l); if (d && /^[a-z0-9]+:\/\//i.test(d.trim())) l = d.trim(); }
    try { links.push({ ...parseLink(l), link: l }); } catch (e) { errors.push('строка ' + (n + 1) + ': ' + e.message); }
  });
  return { links, errors };
}

/* «VLESS · XHTTP · Reality · Vision» — одной строкой для настроек */
const TITLE = { vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', ss: 'Shadowsocks', hy2: 'Hysteria 2', socks: 'SOCKS5', http: 'HTTP' };
const NETN = { ws: 'WebSocket', grpc: 'gRPC', httpupgrade: 'HTTPUpgrade', xhttp: 'XHTTP' };
export function describe(p) {
  const a = [p.kind === 'http' && p.tls ? 'HTTPS' : TITLE[p.kind] || p.kind];
  if (NETN[p.net]) a.push(NETN[p.net]);
  else if (p.net === 'raw' && p.htype === 'http') a.push('TCP · HTTP');
  if (p.sec === 'reality') a.push('Reality');
  else if (p.sec === 'tls' && p.kind !== 'hy2') a.push('TLS');
  if (/vision/.test(p.flow || '')) a.push('Vision');
  if (p.enc && p.enc !== 'none') a.push('шифрование VLESS');
  if (p.kind === 'ss') a.push(p.method);
  if (p.obfs) a.push('Salamander');
  if (p.hop) a.push('порты ' + p.hop);
  return a.join(' · ');
}
/* что видно в браузере: ни ключа, ни пароля */
export const brief = p => ({ kind: p.kind, name: p.name, host: p.host, port: p.port, desc: describe(p), xray: needsXray(p) });
/* socks5 и http можно и без Xray (из Node напрямую), остальное — только через него */
export const needsXray = p => !(p.kind === 'socks' || p.kind === 'http');

/* ---------- конфиг Xray ---------- */
const prune = o => { for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === '' || (Array.isArray(o[k]) && !o[k].length)) delete o[k]; return o; };
/* частные сети и localhost — мимо прокси, даже если программа агента не послушалась NO_PROXY */
export const PRIVATE_NETS = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '::1/128', 'fc00::/7', 'fe80::/10'];

function streamSettings(p, pin) {
  const ss = { network: p.net, security: p.sec };
  const sni = p.sni || (['ws', 'httpupgrade', 'xhttp'].includes(p.net) && p.hh ? list(p.hh)[0] : '');
  if (p.sec === 'tls') {
    ss.tlsSettings = prune({ serverName: sni, fingerprint: p.kind === 'hy2' ? undefined : p.fp || 'chrome', alpn: p.alpn?.length ? p.alpn : p.kind === 'hy2' ? ['h3'] : undefined,
      pinnedPeerCertSha256: p.pcs || pin || undefined, verifyPeerCertByName: p.vcn, echConfigList: p.ech });
  } else if (p.sec === 'reality') {
    ss.realitySettings = prune({ serverName: p.sni, fingerprint: p.fp || 'chrome', publicKey: p.pbk, shortId: p.sid, spiderX: p.spx, mldsa65Verify: p.pqv });
  }
  if (p.net === 'raw' && p.htype === 'http') ss.rawSettings = { header: { type: 'http', request: { path: list(p.path || '/'), headers: p.hh ? { Host: list(p.hh) } : {} } } };
  else if (p.net === 'ws') ss.wsSettings = prune({ path: p.path || '/', host: p.hh });
  else if (p.net === 'httpupgrade') ss.httpupgradeSettings = prune({ path: p.path || '/', host: p.hh });
  else if (p.net === 'grpc') ss.grpcSettings = prune({ serviceName: p.svc, authority: p.authority, multiMode: p.mode === 'multi' || undefined });
  else if (p.net === 'xhttp') ss.xhttpSettings = prune({ path: p.path || '/', host: p.hh, mode: p.mode || 'auto', extra: p.extra });
  else if (p.net === 'hysteria') {
    ss.hysteriaSettings = { version: 2, auth: p.auth };
    const udp = [];
    if (p.obfs) udp.push({ type: 'salamander', settings: { password: p.obfsPw } });
    if (p.hop) udp.push({ type: 'udphop', settings: { remotePorts: p.hop, interval: 30, mode: 'intervalRemote' } });
    if (udp.length) ss.finalmask = { udp };
  }
  return ss;
}

export function outbound(p, pin) {
  const addr = { address: p.host, port: p.port };
  switch (p.kind) {
    case 'vless': return { tag: 'proxy', protocol: 'vless', settings: { vnext: [{ ...addr, users: [prune({ id: p.id, encryption: p.enc || 'none', flow: p.flow })] }] }, streamSettings: streamSettings(p, pin) };
    case 'vmess': return { tag: 'proxy', protocol: 'vmess', settings: { vnext: [{ ...addr, users: [{ id: p.id, security: p.scy || 'auto' }] }] }, streamSettings: streamSettings(p, pin) };
    case 'trojan': return { tag: 'proxy', protocol: 'trojan', settings: { servers: [{ ...addr, password: p.pass }] }, streamSettings: streamSettings(p, pin) };
    case 'ss': return { tag: 'proxy', protocol: 'shadowsocks', settings: { servers: [{ ...addr, method: p.method, password: p.pass }] } };
    case 'hy2': return { tag: 'proxy', protocol: 'hysteria', settings: { version: 2, ...addr }, streamSettings: streamSettings(p, pin) };
    case 'socks': return { tag: 'proxy', protocol: 'socks', settings: { servers: [{ ...addr, ...(p.user ? { users: [{ user: p.user, pass: p.pass }] } : {}) }] } };
    case 'http': return { tag: 'proxy', protocol: 'http', settings: { servers: [{ ...addr, ...(p.user ? { users: [{ user: p.user, pass: p.pass }] } : {}) }] },
      ...(p.tls ? { streamSettings: { security: 'tls', tlsSettings: prune({ serverName: p.sni }) } } : {}) };
  }
  throw bad('Неизвестный протокол');
}

/* весь конфиг: вход — SOCKS5 и HTTP-прокси на одном порту 127.0.0.1 (с паролем), выход — сервер из ключа */
export function xrayConfig(p, { port, user, pass, pin } = {}) {
  return {
    /* info: причина отказа (сервер выключен, таймаут, Reality не принял) пишется только на этом уровне */
    log: { loglevel: 'info', access: 'none' },
    inbounds: [{ tag: 'in', listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'password', accounts: [{ user, pass }], udp: false } }],
    outbounds: [outbound(p, pin), { tag: 'direct', protocol: 'freedom' }],
    routing: { domainStrategy: 'AsIs', rules: [{ type: 'field', ip: PRIVATE_NETS, outboundTag: 'direct' }, { type: 'field', domain: ['full:localhost'], outboundTag: 'direct' }] },
  };
}

/* ошибку Xray — по-человечески: последняя осмысленная часть цепочки «a > b > c» */
export function xrayErr(text) {
  const t = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const line = t.reverse().find(l => /Failed to start|failed|error|invalid|prohibited|unknown/i.test(l)) || t[0] || '';
  if (/vless without TLS|trojan without TLS/i.test(line)) return 'Xray не пускает ключ без шифрования (TLS или Reality) к публичному серверу: такое соединение читается по пути. Попроси у провайдера ключ с TLS или Reality';
  if (/allowInsecure/.test(line)) return 'Ключ просит не проверять сертификат сервера, а Xray так больше не умеет — нужен параметр pcs (отпечаток сертификата)';
  const parts = line.replace(/^.*?Failed to start:\s*/i, '').split(' > ').map(s => s.trim()).filter(Boolean);
  return (parts.at(-1) || line).replace(/^infra\/conf:\s*/, '').slice(0, 400) || 'Xray не запустился';
}
