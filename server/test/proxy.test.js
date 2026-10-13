/* Прокси: ключи и подписки, конфиг Xray, туннели SOCKS5 и HTTP CONNECT (и HTTPS поверх них), маршруты и исключения,
   настройки на сервере, команды агента, Telegram, строгий режим. С настоящим Xray (vless) — если он есть на машине:
   XRAY_BIN=/путь/к/xray npm test, иначе ищем /opt/personalcomputer/bin/xray и xray в PATH. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { parseLink, parseList, parseInput, isSubUrl, describe as keyDesc, xrayConfig, xrayErr } from '../lib/proxylink.js';
import { proxyFetch, dropAgents } from '../lib/tunnel.js';
import { bypassed, isLocalHost, reason, probeCert } from '../lib/proxy.js';
import { fakeModel, startPersonalComputer, registered, sleep } from './helpers.js';

/* самоподписанный сертификат secure.test (2020–2120) */
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgjGCX78kItYaHgo9e
Qq6vP9twmQIMJephWZ8JMbj4l2qhRANCAASXAvTEAvUaKnHxTU9TBx4YMl7/x0kh
+SEbFVP083OtXC+O9FeoG/jlW5xlsE94ddTzdeTWk/xnMqztC+gQx5YI
-----END PRIVATE KEY-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIBXDCCAQGgAwIBAgIUWM9FDqv/beDWIVsDePwAJdbmTMMwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLc2VjdXJlLnRlc3QwIBcNMjAwMTAxMDAwMDAwWhgPMjEyMDAx
MDEwMDAwMDBaMBYxFDASBgNVBAMMC3NlY3VyZS50ZXN0MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAElwL0xAL1Gipx8U1PUwceGDJe/8dJIfkhGxVT9PNzrVwvjvRX
qBv45VucZbBPeHXU83Xk1pP8ZzKs7QvoEMeWCKMrMCkwFgYDVR0RBA8wDYILc2Vj
dXJlLnRlc3QwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEAi1tv
hJ7dJmhlEtBq5Ul5DKyMAm1Ad5nW57dUcKr4vPkCIQCbX1YtbkziYDAp6M4zhqS0
CWGiabCCKV3CF909cgnAmg==
-----END CERTIFICATE-----`;
const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';
const REALITY = `vless://${UUID}@1.2.3.4:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBrjqnAw&sid=6ba85179e30d4fc2&spx=%2F&type=tcp&headerType=none#%F0%9F%87%B3%F0%9F%87%B1%20NL%20Reality`;
const listen = srv => new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));

/* ---------- поддельные прокси и «интернет» ---------- */
/* SOCKS5: запоминает, куда просили (адрес — как прислали: домен или IP), и ведёт туда, куда скажет map */
async function fakeSocks({ user, pass, map }) {
  const seen = [], conns = new Set();
  const srv = net.createServer(c => {
    conns.add(c); c.on('close', () => conns.delete(c));
    let buf = Buffer.alloc(0), st = 0;
    c.on('error', () => {});
    const on = d => {
      buf = Buffer.concat([buf, d]);
      if (st === 0) {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        const ms = [...buf.subarray(2, 2 + buf[1])], need = user ? 2 : 0;
        buf = buf.subarray(2 + buf[1]);
        if (!ms.includes(need)) return c.end(Buffer.from([5, 255]));
        c.write(Buffer.from([5, need])); st = user ? 1 : 2;
      }
      if (st === 1) {
        if (buf.length < 2) return;
        const ul = buf[1]; if (buf.length < 3 + ul) return;
        const pl = buf[2 + ul]; if (buf.length < 3 + ul + pl) return;
        const u = buf.subarray(2, 2 + ul).toString(), p = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        if (u !== user || p !== pass) return c.end(Buffer.from([1, 1]));
        c.write(Buffer.from([1, 0])); st = 2;
      }
      if (st === 2) {
        if (buf.length < 5) return;
        let host, off;
        if (buf[3] === 1) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); off = 8; }
        else if (buf[3] === 3) { if (buf.length < 7 + buf[4]) return; host = buf.subarray(5, 5 + buf[4]).toString(); off = 5 + buf[4]; }
        else return c.destroy();
        const port = buf.readUInt16BE(off);
        st = 3; c.off('data', on); c.pause();
        seen.push(host + ':' + port);
        const to = map(host, port);
        if (!to) return c.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
        const up = net.connect(to[1], to[0], () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); c.pipe(up); up.pipe(c); c.resume(); });
        up.on('error', () => c.destroy()); c.on('close', () => up.destroy());
      }
    };
    c.on('data', on);
  });
  const port = await listen(srv);
  /* закрыть — и уже открытые туннели тоже: «прокси упал» */
  return { port, seen, close: () => { srv.close(); for (const c of conns) c.destroy(); } };
}
/* HTTP-прокси: только CONNECT, с паролем */
async function fakeConnect({ user, pass, map }) {
  const seen = [];
  const srv = http.createServer((q, s) => { s.writeHead(405); s.end(); });
  srv.on('connect', (q, c, head) => {
    c.on('error', () => {});
    if (q.headers['proxy-authorization'] !== 'Basic ' + Buffer.from(user + ':' + pass).toString('base64')) return c.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    const i = q.url.lastIndexOf(':'), host = q.url.slice(0, i).replace(/^\[|\]$/g, ''), port = +q.url.slice(i + 1);
    seen.push(host + ':' + port);
    const to = map(host, port);
    if (!to) return c.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    const up = net.connect(to[1], to[0], () => { c.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) up.write(head); c.pipe(up); up.pipe(c); });
    up.on('error', () => c.destroy()); c.on('close', () => up.destroy());
  });
  const port = await listen(srv);
  return { port, seen, close: () => srv.close() };
}

let web, webPort, secure, securePort, model, tg, tgPort, sub, subPort;
const hosts = {};
const map = (h, p) => hosts[h] ? ['127.0.0.1', hosts[h]] : h === '127.0.0.1' ? ['127.0.0.1', p] : null;
const subBody = { text: '' };

before(async () => {
  web = http.createServer((q, s) => {
    let b = ''; q.on('data', d => { b += d; }); q.on('end', () => {
      if (q.url === '/cdn-cgi/trace') { s.writeHead(200, { 'content-type': 'text/plain' }); return s.end('fl=1\nip=203.0.113.77\nloc=NL\n'); }
      if (q.url === '/gz') { s.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' }); return s.end(zlib.gzipSync('сжато: ' + q.headers.host)); }
      if (q.url === '/br') { s.writeHead(200, { 'content-encoding': 'br' }); return s.end(zlib.brotliCompressSync('brotli')); }
      if (q.url === '/r') { s.writeHead(302, { location: '/gz' }); return s.end(); }
      if (q.url === '/away') { s.writeHead(307, { location: 'http://other.test/echo' }); return s.end(); }
      if (q.url === '/see') { s.writeHead(303, { location: '/echo' }); return s.end(); }
      if (q.url === '/sse') { s.writeHead(200, { 'content-type': 'text/event-stream' }); let i = 0; const t = setInterval(() => { s.write('data: ' + i + '\n\n'); if (++i === 4) { clearInterval(t); s.end(); } }, 40); return; }
      if (q.url === '/slow') { s.writeHead(200); s.write('начало'); return; }
      s.writeHead(200, { 'content-type': 'application/json', 'x-n': '1' });
      s.end(JSON.stringify({ method: q.method, host: q.headers.host, auth: q.headers.authorization || null, type: q.headers['content-type'] || null, body: b }));
    });
  });
  webPort = await listen(web);
  secure = https.createServer({ key: KEY, cert: CERT }, (q, s) => { s.writeHead(200); s.end('секретно ' + q.headers.host); });
  securePort = await listen(secure);
  model = await fakeModel(async body => {
    /* пустой запрос — так сервер проверяет ключ (см. models в server.js) */
    if (!Array.isArray(body.messages)) return { text: 'ok' };
    const last = body.messages.at(-1), u = [...body.messages].reverse().find(x => x.role === 'user');
    if (String(u.content).startsWith('прокси?') && last.role === 'user') return { tools: [{ name: 'run_command', args: { action: 'Смотрю', command: 'echo "P=$HTTPS_PROXY"; echo "N=$NO_PROXY"' } }] };
    if (last.role === 'tool') return { text: 'итог: ' + last.content };
    return { text: 'Привет через прокси' };
  });
  tg = http.createServer((q, s) => { q.resume(); q.on('end', () => { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify(/getMe/.test(q.url) ? { ok: true, result: { id: 1, is_bot: true, username: 'px_test_bot', first_name: 'PX' } } : /getUpdates/.test(q.url) ? { ok: true, result: [] } : { ok: true, result: true })); }); });
  tgPort = await listen(tg);
  sub = http.createServer((q, s) => {
    if (q.url !== '/sub/abc') { s.writeHead(404); return s.end(); }
    s.writeHead(200, { 'content-type': 'text/plain', 'subscription-userinfo': 'upload=1073741824; download=2147483648; total=53687091200; expire=1893456000', 'profile-title': 'base64:' + Buffer.from('Мой VPN').toString('base64') });
    s.end(subBody.text);
  });
  subPort = await listen(sub);
  Object.assign(hosts, { 'web.test': webPort, 'other.test': webPort, 'trace.test': webPort, 'secure.test': securePort, 'model.test': +new URL(model.url).port, 'tg.test': tgPort });
});
after(() => { dropAgents(); web.close(); secure.close(); model.close(); tg.close(); sub.close(); });

/* ---------- ключи ---------- */
test('ключи: vless Reality, vmess v2rayN, trojan, ss (SIP002, 2022, старый вид), hysteria2, socks5, http', () => {
  let p = parseLink(REALITY);
  assert.equal(p.kind, 'vless'); assert.equal(p.name, '🇳🇱 NL Reality'); assert.equal(p.host, '1.2.3.4'); assert.equal(p.port, 443);
  assert.equal(p.flow, 'xtls-rprx-vision'); assert.equal(p.sec, 'reality'); assert.equal(p.sid, '6ba85179e30d4fc2');
  assert.equal(keyDesc(p), 'VLESS · Reality · Vision');
  const vm = 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: 'Германия', add: 'de.example.com', port: '8443', id: UUID, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: 'cdn.example.com', path: '/vm?ed=2048', tls: 'tls', fp: 'firefox' })).toString('base64');
  p = parseLink(vm);
  assert.deepEqual([p.kind, p.name, p.host, p.port, p.net, p.sec, p.hh, p.path, p.fp], ['vmess', 'Германия', 'de.example.com', 8443, 'ws', 'tls', 'cdn.example.com', '/vm?ed=2048', 'firefox']);
  p = parseLink('trojan://p%40ss+word@t.example.com?type=grpc&serviceName=tr&mode=multi#tr');
  assert.deepEqual([p.pass, p.port, p.sec, p.net, p.svc, p.mode], ['p@ss+word', 443, 'tls', 'grpc', 'tr', 'multi']);
  p = parseLink('ss://' + Buffer.from('aes-256-gcm:pa:ss@x').toString('base64url') + '@s.example.com:8388#ss');
  assert.deepEqual([p.method, p.pass, p.port], ['aes-256-gcm', 'pa:ss@x', 8388]);
  p = parseLink('ss://2022-blake3-aes-128-gcm:AAAAAAAAAAAAAAAAAAAAAA%3D%3D@s2.example.com:8388/?#');
  assert.deepEqual([p.method, p.pass, p.name], ['2022-blake3-aes-128-gcm', 'AAAAAAAAAAAAAAAAAAAAAA==', 's2.example.com:8388']);
  p = parseLink('ss://' + Buffer.from('chacha20-ietf-poly1305:p@w@old.example.com:8388').toString('base64') + '#старый');
  assert.deepEqual([p.method, p.pass, p.host, p.name], ['chacha20-ietf-poly1305', 'p@w', 'old.example.com', 'старый']);
  p = parseLink('hy2://user%3Apw@hy.example.com:443,20000-30000/?sni=hy.example.com&obfs=salamander&obfs-password=a%2Bb#hy');
  assert.deepEqual([p.kind, p.auth, p.port, p.hop, p.obfsPw, keyDesc(p)], ['hy2', 'user:pw', 443, '443,20000-30000', 'a+b', 'Hysteria 2 · Salamander · порты 443,20000-30000']);
  p = parseLink('socks://' + Buffer.from('u:p').toString('base64') + '@s5.example.com:1080#v2rayN');
  assert.deepEqual([p.kind, p.user, p.pass], ['socks', 'u', 'p']);
  p = parseLink('socks5://us%3Ar:p%40ss@[2001:db8::1]:1081');
  assert.deepEqual([p.user, p.pass, p.host, p.port], ['us:r', 'p@ss', '2001:db8::1', 1081]);
  p = parseLink('https://u:p@proxy.example.com:8443');
  assert.deepEqual([p.kind, p.tls, p.port, keyDesc(p)], ['http', true, 8443, 'HTTPS']);
  assert.equal(isSubUrl('https://sub.example.com/sub/abc'), true);
  assert.equal(isSubUrl('https://sub.example.com/?token=1'), true);
  assert.equal(isSubUrl('http://u:p@proxy.example.com:3128'), false);
  assert.equal(parseInput('  https://sub.example.com/s/1  ').sub, 'https://sub.example.com/s/1');
});

test('ключи: что не поддерживается — понятной ошибкой', () => {
  const err = (l, re) => assert.throws(() => parseLink(l), e => e.status === 400 && re.test(e.message), l);
  err('hello', /не ключ прокси/);
  err('tuic://a@b:1', /tuic:\/\/ не поддерживается/);
  err(`vless://${UUID}@h.example.com:443?type=h2`, /HTTP\/2 убран/);
  err(`vless://${UUID}@h.example.com:443?type=kcp`, /mKCP/);
  err(`vless://${UUID}@h.example.com:443?security=xtls`, /XTLS/);
  err(`vless://${UUID}@h.example.com:443?security=reality&sni=a.com`, /pbk/);
  err(`vless://${UUID}@h.example.com:99999`, /Неверный порт/);
  err(`vless://${UUID}@h.example.com:443?security=tls&pcs=abc`, /отпечаток/);
  err('ss://' + Buffer.from('aes-256-cfb:p').toString('base64url') + '@h.example.com:1', /aes-256-cfb/);
  err('ss://' + Buffer.from('aes-256-gcm:p').toString('base64url') + '@h.example.com:1?plugin=obfs-local%3Bobfs%3Dhttp', /плагином \(obfs-local\)/);
  err('hysteria2://a@h.example.com:443?obfs=salamander', /obfs-password/);
  err('vmess://bm90IGpzb24', /vmess/);
  err('socks4://h.example.com:1080', /SOCKS4/);
});

test('подписка: base64 целиком, построчно, строки в base64; JSON и Clash — понятной ошибкой', () => {
  const lines = [REALITY, 'trojan://pw@t.example.com:443#tr', 'tuic://x@y:1', '# комментарий', ''];
  let r = parseList(Buffer.from(lines.join('\n')).toString('base64'));
  assert.deepEqual(r.links.map(l => l.kind), ['vless', 'trojan']);
  assert.equal(r.links[0].link, REALITY);
  assert.match(r.errors[0], /^строка 3: Протокол tuic/);
  r = parseList(lines.slice(0, 2).map(l => Buffer.from(l).toString('base64')).join('\n'));
  assert.equal(r.links.length, 2);
  assert.throws(() => parseList('[{"outbounds":[]}]'), /JSON/);
  assert.throws(() => parseList('mixed-port: 7890\nproxies:\n  - name: a'), /Clash/);
});

test('конфиг Xray: вход SOCKS5/HTTP с паролем на 127.0.0.1, выход по ключу, частные сети — напрямую', () => {
  const c = xrayConfig(parseLink(REALITY), { port: 10808, user: 'u', pass: 'p' });
  assert.deepEqual(c.inbounds[0], { tag: 'in', listen: '127.0.0.1', port: 10808, protocol: 'socks', settings: { auth: 'password', accounts: [{ user: 'u', pass: 'p' }], udp: false } });
  const o = c.outbounds[0];
  assert.equal(o.protocol, 'vless');
  assert.deepEqual(o.settings.vnext[0].users[0], { id: UUID, encryption: 'none', flow: 'xtls-rprx-vision' });
  assert.deepEqual(o.streamSettings.realitySettings, { serverName: 'www.microsoft.com', fingerprint: 'chrome', publicKey: 'Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBrjqnAw', shortId: '6ba85179e30d4fc2', spiderX: '/' });
  assert.equal(c.routing.rules[0].outboundTag, 'direct');
  assert.ok(c.routing.rules[0].ip.includes('192.168.0.0/16'));
  /* ws без sni: имя сервера для TLS — из host; самоподписанный сертификат — отпечаток */
  const w = xrayConfig(parseLink('vmess://' + Buffer.from(JSON.stringify({ add: '1.1.1.1', port: 443, id: UUID, net: 'ws', host: 'cdn.example.com', path: '/x', tls: 'tls' })).toString('base64')), { port: 1, user: 'u', pass: 'p', pin: 'ab'.repeat(32) }).outbounds[0].streamSettings;
  assert.deepEqual(w.tlsSettings, { serverName: 'cdn.example.com', fingerprint: 'chrome', pinnedPeerCertSha256: 'ab'.repeat(32) });
  assert.deepEqual(w.wsSettings, { path: '/x', host: 'cdn.example.com' });
  const h = xrayConfig(parseLink('hysteria2://pw@hy.example.com:443,20000-30000?obfs=salamander&obfs-password=o'), { port: 1, user: 'u', pass: 'p' }).outbounds[0];
  assert.deepEqual(h.settings, { version: 2, address: 'hy.example.com', port: 443 });
  assert.deepEqual(h.streamSettings.hysteriaSettings, { version: 2, auth: 'pw' });
  assert.deepEqual(h.streamSettings.finalmask.udp.map(x => x.type), ['salamander', 'udphop']);
  assert.match(xrayErr('Failed to start: main: failed to load config files: [x.json] > infra/conf: failed to build outbound config with tag proxy > infra/conf: vless without TLS or other encryption is prohibited unless the server address is a private IP or domain'), /без шифрования/);
  assert.equal(xrayErr('Failed to start: main: failed > infra/conf: invalid "password": xyz'), 'invalid "password": xyz');
});

test('маршрут: локальные адреса и исключения — напрямую, остальное — через прокси', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.10', '169.254.1.1', '100.64.0.1', '[::1]', 'fd00::5', 'ollama', 'nas.local', 'box.internal'])
    assert.equal(isLocalHost(h), true, h);
  for (const h of ['api.openai.com', '8.8.8.8', '172.32.0.1', '2001:db8::1', 'openrouter.ai'])
    assert.equal(isLocalHost(h), false, h);
  const L = ['example.com', 'corp.lan', '203.0.113.0/24'];
  assert.equal(bypassed('example.com', L), true);
  assert.equal(bypassed('api.example.com', L), true);
  assert.equal(bypassed('notexample.com', L), false);
  assert.equal(bypassed('203.0.113.9', L), true);
  assert.equal(bypassed('203.0.114.9', L), false);
  assert.equal(bypassed('api.openai.com', L), false);
});

test('журнал Xray → причина по-человечески', () => {
  assert.match(reason('[Info] [1] app/proxyman/outbound: failed to process outbound traffic > proxy/vless/outbound: failed to find an available destination > common/retry: [dial tcp 1.2.3.4:443: connect: connection refused] > common/retry: all retry attempts failed'), /не принимает соединения/);
  assert.match(reason('[Info] [1] app/proxyman/outbound: failed to process outbound traffic > common/retry: [dial tcp 1.2.3.4:443: i/o timeout]'), /таймаут/);
  assert.match(reason('[Info] [1] failed to dial > common/retry: [dial tcp: lookup nope.example: no such host]'), /DNS/);
  assert.match(reason('[Warning] [1] transport/internet/tls: x509: certificate signed by unknown authority'), /сертификат.*unknown authority/);
});

/* ---------- туннели ---------- */
test('туннель SOCKS5: имя хоста уходит прокси, gzip и br, переадресации, POST и FormData, поток, отмена', async () => {
  const s5 = await fakeSocks({ user: 'u', pass: 'p', map });
  const px = { type: 'socks', host: '127.0.0.1', port: s5.port, user: 'u', pass: 'p' };
  try {
    let r = await proxyFetch('http://web.test/r', {}, px);
    assert.equal(r.status, 200); assert.equal(r.redirected, true); assert.equal(r.url, 'http://web.test/gz');
    assert.equal(await r.text(), 'сжато: web.test');
    assert.ok(s5.seen.includes('web.test:80'), 'DNS — на стороне прокси: ушло имя, а не IP');
    assert.equal(await (await proxyFetch('http://web.test/br', {}, px)).text(), 'brotli');
    r = await proxyFetch('http://web.test/echo', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k' }, body: '{"a":"кот"}' }, px);
    assert.deepEqual(await r.json(), { method: 'POST', host: 'web.test', auth: 'Bearer k', type: 'application/json', body: '{"a":"кот"}' });
    assert.equal(r.headers.get('x-n'), '1');
    const fd = new FormData(); fd.append('chat_id', '1'); fd.append('document', new Blob(['файл']), 'a.txt');
    const j = await (await proxyFetch('http://web.test/echo', { method: 'POST', body: fd }, px)).json();
    assert.match(j.type, /^multipart\/form-data; boundary=/); assert.match(j.body, /filename="a.txt"[\s\S]*файл/);
    /* на другой адрес ключ API не уходит; 303 — уже GET без тела */
    assert.equal((await (await proxyFetch('http://web.test/away', { headers: { authorization: 'Bearer k' } }, px)).json()).auth, null);
    assert.deepEqual(await (await proxyFetch('http://web.test/see', { method: 'POST', body: 'x' }, px)).json().then(x => [x.method, x.body]), ['GET', '']);
    r = await proxyFetch('http://web.test/sse', {}, px);
    const parts = []; for await (const c of r.body) parts.push(Buffer.from(c).toString());
    assert.ok(parts.length >= 3, 'поток приходит кусками, а не одним ответом: ' + parts.length);
    assert.equal(parts.join(''), 'data: 0\n\ndata: 1\n\ndata: 2\n\ndata: 3\n\n');
    const ac = new AbortController();
    r = await proxyFetch('http://web.test/slow', { signal: ac.signal }, px);
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(async () => { for await (const _ of r.body); }, e => e.name === 'AbortError');
    await assert.rejects(proxyFetch('http://web.test/slow', { signal: AbortSignal.timeout(1) }, px), e => e.name === 'TimeoutError' || e.name === 'AbortError');
    /* неверный пароль, прокси не пускает к адресу, прокси нет */
    await assert.rejects(proxyFetch('http://web.test/echo', {}, { ...px, pass: 'x' }), e => e instanceof TypeError && e.proxy && /не принял логин и пароль/.test(e.cause.code));
    await assert.rejects(proxyFetch('http://nowhere.test/', {}, px), e => /адрес недоступен/.test(e.cause.code));
    await assert.rejects(proxyFetch('http://web.test/', {}, { ...px, port: 1 }), e => e instanceof TypeError && /прокси-сервер недоступен/.test(e.cause.code));
  } finally { dropAgents(); s5.close(); }
});

test('туннель HTTP CONNECT: пароль, 407; HTTPS поверх туннеля — с проверкой сертификата', async () => {
  const hp = await fakeConnect({ user: 'u', pass: 'p:w', map });
  const px = { type: 'http', host: '127.0.0.1', port: hp.port, user: 'u', pass: 'p:w', ca: CERT };
  try {
    assert.equal(await (await proxyFetch('https://secure.test/', {}, px)).text(), 'секретно secure.test');
    assert.ok(hp.seen.includes('secure.test:443'));
    /* сертификат не тот (не доверяем ему) — ошибка, а не «как-нибудь» */
    await assert.rejects(proxyFetch('https://secure.test/', {}, { ...px, ca: undefined }), e => e instanceof TypeError && /SELF_SIGNED|self-signed|DEPTH_ZERO/i.test(e.cause?.code || e.cause?.message || ''));
    await assert.rejects(proxyFetch('http://web.test/', {}, { ...px, pass: 'нет' }), e => /не принял логин и пароль/.test(e.cause.code));
    assert.equal((await (await proxyFetch('http://web.test/echo', {}, px)).json()).host, 'web.test');
  } finally { dropAgents(); hp.close(); }
});

test('сертификат сервера из ключа с insecure: самоподписанный — отпечаток SHA-256', async () => {
  const pin = await probeCert({ host: '127.0.0.1', port: securePort, sni: 'secure.test' });
  assert.equal(pin, new crypto.X509Certificate(CERT).fingerprint256.replace(/:/g, '').toLowerCase());
});

/* ---------- на сервере ---------- */
test('сервер: socks5 для модели, команд агента и Telegram; проверка выхода; строго — без прокси никуда; ключи не уходят в браузер', async () => {
  const s5 = await fakeSocks({ user: 'u', pass: 'p', map });
  const m = await startPersonalComputer({ PERSONALCOMPUTER_XRAY: 'none', PERSONALCOMPUTER_PROXY_TRACE: 'http://trace.test/cdn-cgi/trace', PERSONALCOMPUTER_TG_API: 'http://tg.test' });
  try {
    const c = await registered(m), bob = await registered(m, 'bob');
    assert.equal((await c.json('/api/settings', { base: 'http://model.test/v1', key: 'sk-x', model: 'fake-1' }, 'PUT')).status, 200);
    let r = await c.json('/api/proxy/add', { text: 'vless://' + UUID + '@1.2.3.4:443?security=reality&pbk=Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBrjqnAw&sni=a.com#без Xray' });
    assert.equal(r.status, 200);
    assert.equal(r.j.state.core, null);
    /* vless без Xray не включить — сразу понятно почему */
    r = await c.json('/api/proxy', { on: true }, 'PUT');
    assert.equal(r.status, 400); assert.match(r.j.error, /ядро Xray/);
    r = await c.json('/api/proxy/add', { text: `socks5://u:p@127.0.0.1:${s5.port}#Мой SOCKS` });
    assert.equal(r.status, 200); assert.equal(r.j.added, 1);
    const st = r.j.state, mine = st.servers.find(s => s.name === 'Мой SOCKS');
    assert.equal(st.active, mine.id, 'вставленный ключ сразу выбран');
    assert.equal(mine.desc, 'SOCKS5');
    assert.ok(!JSON.stringify(st).includes(UUID) && !JSON.stringify(st).includes('u:p@'), 'ключи в браузер не уходят');
    /* смотреть может каждый, менять — администратор */
    assert.equal((await bob.json('/api/proxy', undefined, 'GET')).status, 200);
    assert.equal((await bob.json('/api/proxy', { on: true }, 'PUT')).status, 403);
    assert.equal((await bob.json('/api/proxy/add', { text: 'socks5://h.example.com:1' })).status, 403);
    r = await c.json('/api/proxy', { on: true }, 'PUT');
    assert.equal(r.status, 200); assert.deepEqual([r.j.on, r.j.status.state, r.j.status.mode], [true, 'ok', 'direct']);
    /* проверка: выход и модель — через прокси */
    r = await c.json('/api/proxy/test', {});
    assert.equal(r.j.result.ok, true); assert.equal(r.j.result.ip, '203.0.113.77'); assert.equal(r.j.result.loc, 'NL');
    assert.equal(r.j.result.model.host, 'model.test'); assert.equal(r.j.result.model.status, 200);
    /* модель отвечает через прокси (model.test есть только «за» ним), команды агента получают HTTPS_PROXY */
    r = await c.json('/api/chat', { text: 'прокси?' });
    const evs = await c.events(e => e.some(x => x.ev === 'log' && x.d.kind === 'assistant' && /итог/.test(x.d.text)), 20000);
    const ans = evs.find(x => x.ev === 'log' && x.d.kind === 'assistant' && /итог/.test(x.d.text)).d.text;
    assert.match(ans, new RegExp('P=socks5h://u:p@127\\.0\\.0\\.1:' + s5.port));
    assert.match(ans, /N=localhost,127\.0\.0\.1,.*192\.168\.0\.0\/16/);
    /* model.test есть только «за» прокси: ответ пришёл — значит, через него (соединение могло остаться с проверки) */
    assert.ok(s5.seen.includes('model.test:80'));
    const pe = path.join(m.env.HOME, '.local/state/personalcomputer/proxy.env');
    assert.match(fs.readFileSync(pe, 'utf8'), /^export HTTP_PROXY='socks5h:\/\/u:p@127\.0\.0\.1:\d+' /m);
    /* Telegram — тоже через прокси */
    r = await c.json('/api/telegram', { token: '123456789:AAEhBP0av18ZzsZiYQXbKBYWxx2ahfL0lzw' });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.ok(s5.seen.includes('tg.test:80'));
    /* исключения: адрес из списка — напрямую (тут прямого пути к model.test нет — значит, ошибка не прокси) */
    await c.json('/api/proxy', { bypass: 'model.test' }, 'PUT');
    r = await c.json('/api/models', { base: 'http://model.test/v1' });
    assert.equal(r.status, 502); assert.doesNotMatch(r.j.error, /через прокси/);
    /* модель без прокси (use.model = false) — тоже напрямую */
    await c.json('/api/proxy', { bypass: '', use: { model: false } }, 'PUT');
    r = await c.json('/api/models', { base: 'http://model.test/v1' });
    assert.equal(r.status, 502); assert.doesNotMatch(r.j.error, /через прокси/);
    await c.json('/api/proxy', { use: { model: true } }, 'PUT');
    assert.equal((await c.json('/api/models', { base: 'http://model.test/v1' })).status, 200);
    /* прокси упал — запрос не уходит напрямую, а падает с понятной ошибкой */
    s5.close(); dropAgents();
    r = await c.json('/api/models', { base: 'http://model.test/v1' });
    assert.equal(r.status, 502); assert.match(r.j.error, /через прокси: прокси-сервер недоступен/);
    /* выключили — переменные у команд и в терминале пропали */
    r = await c.json('/api/proxy', { on: false }, 'PUT');
    assert.equal(r.j.status.state, 'off');
    assert.equal(fs.existsSync(pe), false);
    /* удалить сервер */
    r = await c(`/api/proxy/servers/${mine.id}`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    assert.ok(!(await r.json()).state.servers.some(s => s.id === mine.id));
  } finally { s5.close(); await m.stop(); }
});

test('подписка в настройках: ключи, трафик и срок из заголовков; обновить — выбранный остаётся; удалить', async () => {
  const m = await startPersonalComputer({ PERSONALCOMPUTER_XRAY: 'none' });
  try {
    const c = await registered(m), url = `http://127.0.0.1:${subPort}/sub/abc`;
    subBody.text = Buffer.from(['socks5://a:b@10.0.0.1:1080#Первый', 'socks5://a:b@10.0.0.2:1080#Второй', 'tuic://x@y:1#нет'].join('\n')).toString('base64');
    let r = await c.json('/api/proxy/add', { text: url });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal(r.j.added, 2); assert.equal(r.j.errors.length, 1);
    const s = r.j.state.subs[0];
    assert.equal(s.name, 'Мой VPN'); assert.equal(s.url, '127.0.0.1:' + subPort + '/…');
    assert.deepEqual(s.info, { used: 3 * 2 ** 30, total: 50 * 2 ** 30, expire: 1893456000, title: 'Мой VPN' });
    assert.ok(!JSON.stringify(r.j.state).includes('/sub/abc'), 'адрес подписки в браузер не уходит');
    const second = r.j.state.servers.find(x => x.name === 'Второй');
    await c.json('/api/proxy', { active: second.id }, 'PUT');
    assert.equal((await c.json('/api/proxy/add', { text: url })).status, 400, 'та же подписка второй раз');
    subBody.text = ['socks5://a:b@10.0.0.2:1080#Второй', 'socks5://a:b@10.0.0.3:1080#Третий'].join('\n');
    r = await c.json('/api/proxy/subs/' + s.id, {});
    assert.equal(r.status, 200); assert.equal(r.j.n, 2);
    assert.deepEqual(r.j.state.servers.map(x => x.name), ['Второй', 'Третий']);
    assert.equal(r.j.state.active, second.id, 'выбранный сервер остался выбранным');
    r = await c(`/api/proxy/subs/${s.id}`, { method: 'DELETE' });
    const after = (await r.json()).state;
    assert.deepEqual([after.subs.length, after.servers.length, after.active], [0, 0, '']);
    subBody.text = '<!doctype html><title>Подписка</title>';
    r = await c.json('/api/proxy/add', { text: url });
    assert.equal(r.status, 400); assert.match(r.j.error, /веб-страница/);
  } finally { await m.stop(); }
});

/* ---------- с настоящим Xray ---------- */
function xrayBin() {
  for (const f of [process.env.XRAY_BIN, '/opt/personalcomputer/bin/xray', ...String(process.env.PATH).split(':').map(d => path.join(d, 'xray'))].filter(Boolean)) {
    try { execFileSync(f, ['version'], { stdio: 'ignore' }); return f; } catch {}
  }
  return null;
}
const XRAY = xrayBin();
test('с настоящим Xray: vless-ключ, модель и проверка идут через сервер прокси; сервер упал — причина из журнала Xray', { skip: !XRAY && 'нет Xray (XRAY_BIN=…)' }, async () => {
  /* «сервер прокси»: vless без TLS на 127.0.0.1 (частный адрес — Xray так разрешает); всё, что приходит, — в наш «интернет» */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-xray-'));
  const vport = await new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
  const fake = http.createServer((q, s) => {
    let b = ''; q.on('data', d => { b += d; }); q.on('end', () => {
      if (q.url.startsWith('/cdn-cgi/trace')) { s.writeHead(200); return s.end('ip=198.51.100.9\nloc=DE\n'); }
      if (q.url.endsWith('/models')) { s.writeHead(200, { 'content-type': 'application/json' }); return s.end('{"data":[{"id":"fake-1"}]}'); }
      s.writeHead(404); s.end();
    });
  });
  const fport = await listen(fake);
  fs.writeFileSync(path.join(dir, 'srv.json'), JSON.stringify({ log: { loglevel: 'warning' }, inbounds: [{ listen: '127.0.0.1', port: vport, protocol: 'vless', settings: { clients: [{ id: UUID }], decryption: 'none' } }],
    outbounds: [{ protocol: 'freedom', settings: { redirect: '127.0.0.1:' + fport, finalRules: [{ action: 'allow' }] } }] }));
  const prov = spawn(XRAY, ['run', '-c', path.join(dir, 'srv.json')], { stdio: 'ignore' });
  const m = await startPersonalComputer({ PERSONALCOMPUTER_XRAY: XRAY, PERSONALCOMPUTER_PROXY_TRACE: 'http://trace.test/cdn-cgi/trace' });
  try {
    await sleep(300);
    const c = await registered(m);
    await c.json('/api/settings', { base: 'http://model.test/v1', key: 'sk-x', model: 'fake-1' }, 'PUT');
    let r = await c.json('/api/proxy/add', { text: `vless://${UUID}@127.0.0.1:${vport}?type=tcp&security=none#Локальный` });
    assert.equal(r.status, 200);
    assert.equal(r.j.state.core.version.split('.').length, 3);
    r = await c.json('/api/proxy', { on: true }, 'PUT');
    assert.deepEqual([r.j.status.state, r.j.status.mode], ['ok', 'xray'], JSON.stringify(r.j.status));
    r = await c.json('/api/proxy/test', {});
    assert.deepEqual([r.j.result.ok, r.j.result.ip, r.j.result.loc, r.j.result.model?.status], [true, '198.51.100.9', 'DE', 200], JSON.stringify(r.j.result));
    r = await c.json('/api/models', { base: 'http://model.test/v1' });
    assert.equal(r.status, 200); assert.deepEqual(r.j.models, ['fake-1']);
    /* переменные для команд — локальный вход Xray с паролем */
    const pe = fs.readFileSync(path.join(m.env.HOME, '.local/state/personalcomputer/proxy.env'), 'utf8');
    assert.match(pe, /HTTPS_PROXY='http:\/\/pc-[0-9a-f]+:[0-9a-f]{32}@127\.0\.0\.1:\d+'/);
    /* сервер перезапустился — первый же запрос ждёт, пока поднимется Xray, а не падает */
    await m.restart();
    r = await c.json('/api/models', { base: 'http://model.test/v1' });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    /* ключ, который Xray не примет: включённый прокси не трогаем */
    r = await c.json('/api/proxy/add', { text: `vless://${UUID}@8.8.8.8:80?type=ws&security=none#Открытый` });
    assert.match(r.j.selErr, /без шифрования/);
    assert.equal(r.j.state.status.state, 'ok');
    /* сервер прокси упал — понятная причина */
    prov.kill(); await sleep(300);
    r = await c.json('/api/proxy/test', {});
    assert.equal(r.j.result.ok, false); assert.match(r.j.result.err, /через прокси: соединение оборвалось — Xray: сервер прокси не принимает соединения/);
  } finally { prov.kill(); await m.stop(); fake.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
