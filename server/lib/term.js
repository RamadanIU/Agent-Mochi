/* Терминал: ttyd слушает только unix-сокет (/run/mochi-term/ttyd.sock, доступ — группа mochi) и пускает
   лишь запросы с заголовком X-Mochi-User (ttyd --auth-header). Этот заголовок ставит только наш прокси —
   после проверки сессии, а для WebSocket ещё и Origin (защита от подключения с чужого сайта).
   Заголовок от клиента вырезается, cookie и прочие секреты в ttyd не уходят. */
import http from 'node:http';
import net from 'node:net';
import { CFG } from './config.js';

export const TERM_PREFIX = '/term';
const AUTH_H = 'x-mochi-user';
const DROP = new Set(['cookie', 'authorization', AUTH_H, 'x-forwarded-for', 'x-real-ip', 'proxy-authorization']);

function headersFor(req, user) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k)) h[k] = v;
  h[AUTH_H] = user.name;
  return h;
}

export function proxyHttp(req, res, user) {
  const up = http.request({ socketPath: CFG.ttydSock, path: req.url, method: req.method, headers: headersFor(req, user) }, r => {
    const h = { ...r.headers };
    delete h['set-cookie'];
    h['x-frame-options'] = 'SAMEORIGIN';
    h['content-security-policy'] = "frame-ancestors 'self'";
    h['cache-control'] = 'no-store';
    h['referrer-policy'] = 'no-referrer';
    res.writeHead(r.statusCode, h);
    r.pipe(res);
  });
  up.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset=utf-8><body style="font:16px monospace;background:#1b1230;color:#7dffb0;padding:20px">Терминал не запущен.<br>На сервере: <b>sudo mochi restart</b> или <b>sudo mochi logs</b>.</body>');
  });
  req.pipe(up);
}

export function proxyUpgrade(req, socket, head, user) {
  const up = net.createConnection(CFG.ttydSock);
  const h = headersFor(req, user);
  up.once('connect', () => {
    let s = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(h)) for (const x of [].concat(v)) s += `${k}: ${String(x).replace(/[\r\n]/g, '')}\r\n`;
    up.write(s + '\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  const end = () => { up.destroy(); socket.destroy(); };
  up.on('error', () => { if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
  socket.on('error', end); up.on('close', end); socket.on('close', end);
  socket.setNoDelay?.(true); socket.setKeepAlive?.(true, 30000);
}
