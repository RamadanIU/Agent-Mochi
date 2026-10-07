/* Запросы к API модели.
   Cloudflare перед некоторыми API (так делает OpenRouter) узнаёт Node.js по TLS-отпечатку и отвечает
   403 {"success":false,"error":"Access denied by security policy."} — ещё до проверки ключа. Браузер и curl он пускает.
   apiFetch делает обычный fetch, а на такой ответ повторяет запрос через curl и дальше ходит к этому хосту только через него.
   Так же пробуем curl и на другие страницы блокировки Cloudflare (см. cfBlock): если пустил — дальше через него.
   curlFetch отдаёт настоящий Response с потоковым телом: SSE-ответ модели читается так же, как от fetch. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const viaCurl = new Set();
let noCurl = false;

/* Cloudflare не пустил запрос — ещё до проверки ключа:
   'node'      — JSON «Access denied by security policy»: OpenRouter не пускает Node.js, curl пускает;
   'waf'       — страница «Sorry, you have been blocked» или «Access denied · Error 1020»: правило защиты сайта,
                 обычно по IP-адресу, стране или сети хостинга сервера;
   'challenge' — «Just a moment…»: проверка, которую проходит только браузер. */
export function cfBlock(status, text, headers) {
  if (status !== 403 && status !== 503) return null;
  const t = String(text || '');
  if (status === 403 && /access denied by security policy/i.test(t)) return 'node';
  if (headers?.get?.('cf-mitigated') === 'challenge' || /<title>\s*just a moment|_cf_chl_opt|challenges\.cloudflare\.com/i.test(t)) return 'challenge';
  if (status === 403 && /cloudflare/i.test(t) && /attention required|you have been blocked|error code:? 10\d\d|error 10\d\d/i.test(t)) return 'waf';
  return null;
}
/* что показать человеку: ключ тут ни при чём, и что можно сделать */
export function cfMessage(kind, url, headers) {
  let host = ''; try { host = new URL(url).host; } catch {}
  const ray = String(headers?.get?.('cf-ray') || '').replace(/[^\w-]/g, '').slice(0, 40);
  if (kind === 'node') return 'Это не ключ: Cloudflare перед API модели не пускает запросы с этого сервера (HTTP 403 «Access denied by security policy»). Обычно помогает curl — проверь, что он установлен на сервере (curl --version), и перезапусти Мочи.';
  const sup = 'Напиши в поддержку провайдера' + (ray ? ' (Cloudflare Ray ID: ' + ray + ')' : '');
  if (kind === 'challenge') return `Это не ключ: Cloudflare перед ${host || 'API модели'} требует проверку «я не робот», которую проходит только браузер, а сервер — нет. ${sup}: API не должен так отвечать.`;
  return `Это не ключ: Cloudflare перед ${host || 'API модели'} заблокировал запрос с этого сервера (HTTP 403 «Sorry, you have been blocked»). Так настроена защита у провайдера — обычно по IP-адресу или стране сервера. ${sup} или запусти Мочи на другом сервере.`;
}

export async function apiFetch(url, init = {}) {
  const host = new URL(url).host;
  if (viaCurl.has(host) && !noCurl) return curlFetch(url, init);
  const r = await fetch(url, init);
  if ((r.status !== 403 && r.status !== 503) || noCurl) return r;
  const text = await r.text().catch(() => '');
  const again = () => new Response(text, { status: r.status, statusText: r.statusText, headers: r.headers });
  const kind = cfBlock(r.status, text, r.headers);
  if (!kind) return again();
  let c;
  try { c = await curlFetch(url, init); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    noCurl = true;
    console.warn('net: ' + host + ' не пускает Node.js (Cloudflare), а curl не установлен');
    return again();
  }
  /* curl тоже не пустили (блокировка по IP) — отдаём ответ как есть, а в следующий раз снова попробуем fetch */
  if (c.status === 403 || c.status === 503) {
    const ct = await c.text().catch(() => '');
    if (cfBlock(c.status, ct, c.headers)) return again();
    return new Response(ct, { status: c.status, statusText: c.statusText, headers: c.headers });
  }
  viaCurl.add(host);
  console.warn('net: ' + host + ' не пускает Node.js (Cloudflare), дальше запросы идут через curl');
  return c;
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
