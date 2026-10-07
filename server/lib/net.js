/* Запросы к API модели.
   Cloudflare перед некоторыми API (так делает OpenRouter) узнаёт Node.js по TLS-отпечатку и отвечает
   403 {"success":false,"error":"Access denied by security policy."} — ещё до проверки ключа. Браузер и curl он пускает.
   apiFetch делает обычный fetch, а на такой ответ повторяет запрос через curl и дальше ходит к этому хосту только через него.
   curlFetch отдаёт настоящий Response с потоковым телом: SSE-ответ модели читается так же, как от fetch. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const viaCurl = new Set();
let noCurl = false;
export const isCfBlock = (status, text) => status === 403 && /access denied by security policy/i.test(text || '');

export async function apiFetch(url, init = {}) {
  const host = new URL(url).host;
  if (viaCurl.has(host) && !noCurl) return curlFetch(url, init);
  const r = await fetch(url, init);
  if (r.status !== 403 || noCurl) return r;
  const text = await r.text().catch(() => '');
  const again = () => new Response(text, { status: r.status, statusText: r.statusText, headers: r.headers });
  if (!isCfBlock(r.status, text)) return again();
  try {
    const c = await curlFetch(url, init);
    viaCurl.add(host);
    console.warn('net: ' + host + ' не пускает Node.js (Cloudflare), дальше запросы идут через curl');
    return c;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    noCurl = true;
    console.warn('net: ' + host + ' не пускает Node.js (Cloudflare), а curl не установлен');
    return again();
  }
}

const netErr = (msg, code) => Object.assign(new TypeError(msg), { cause: { code } });

/* fetch через curl: адрес и заголовки — конфигом через stdin (ключ не виден в списке процессов),
   тело — временным файлом 0600 (в stdin уже конфиг, а лишний fd у Node — сокет, curl его не читает) */
const q = v => '"' + String(v).replace(/[\r\n]/g, ' ').replace(/[\\"]/g, m => '\\' + m) + '"';
export function curlFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  return new Promise((ok, no) => {
    if (signal?.aborted) return no(signal.reason);
    let tmp = null;
    if (body != null) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-curl-'));
      fs.writeFileSync(path.join(tmp, 'body'), typeof body === 'string' || body instanceof Uint8Array ? body : String(body), { mode: 0o600 });
    }
    const conf = ['url = ' + q(url), 'request = ' + q(method), ...[...new Headers(headers)].map(([k, v]) => 'header = ' + q(k + ': ' + v)), 'header = "Expect:"'];
    if (tmp) conf.push('data-binary = ' + q('@' + path.join(tmp, 'body')));
    const p = spawn('curl', ['-sS', '-N', '-i', '--suppress-connect-headers', '--connect-timeout', '20', '-K', '-']);
    let err = '', head = Buffer.alloc(0), ctl = null, settled = false;
    const fail = e => { if (!settled) { settled = true; no(e); } else if (ctl) { try { ctl.error(e); } catch {} ctl = null; } };
    const abort = () => { p.kill(); fail(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    p.on('error', e => fail(e.code === 'ENOENT' ? Object.assign(netErr('curl не установлен', 'ENOENT'), { code: 'ENOENT' }) : e));
    p.stderr.on('data', d => { err += d; });
    p.stdin.on('error', () => {});
    p.stdin.end(conf.join('\n') + '\n');
    /* разбираем блоки заголовков (1xx пропускаем), остальное — тело */
    const onHead = chunk => {
      head = Buffer.concat([head, chunk]);
      for (;;) {
        let i = head.indexOf('\r\n\r\n'), n = 4;
        if (i < 0) { i = head.indexOf('\n\n'); n = 2; }
        if (i < 0) return;
        const lines = head.subarray(0, i).toString('latin1').split(/\r?\n/);
        const rest = head.subarray(i + n);
        const m = /^HTTP\/[\d.]+\s+(\d{3})\s*(.*)$/.exec(lines[0] || '');
        if (!m) { p.kill(); return fail(netErr('curl: непонятный ответ сервера', 'EPROTO')); }
        const status = +m[1];
        if (status < 200) { head = rest; continue; }
        const rh = new Headers();
        for (const l of lines.slice(1)) { const k = l.indexOf(':'); if (k > 0) try { rh.append(l.slice(0, k).trim(), l.slice(k + 1).trim()); } catch {} }
        p.stdout.off('data', onHead);
        const nobody = [101, 204, 205, 304].includes(status) || method === 'HEAD';
        const stream = nobody ? null : new ReadableStream({
          start(c) { ctl = c; if (rest.length) c.enqueue(new Uint8Array(rest)); },
          cancel() { ctl = null; p.kill(); },
        });
        if (!nobody) p.stdout.on('data', d => ctl?.enqueue(new Uint8Array(d)));
        settled = true;
        return ok(new Response(stream, { status, statusText: m[2], headers: rh }));
      }
    };
    p.stdout.on('data', onHead);
    p.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (tmp) fs.rm(tmp, { recursive: true, force: true }, () => {});
      if (signal?.aborted) return;
      if (code) return fail(netErr((err.trim().split('\n').pop() || 'curl: код ' + code), 'CURL_' + code));
      if (!settled) return fail(netErr('curl: пустой ответ', 'EPROTO'));
      if (ctl) { try { ctl.close(); } catch {} ctl = null; }
    });
  });
}
