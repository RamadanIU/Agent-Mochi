/* «Вкладка браузера» для веб-чатов по аккаунту (DeepSeek, Qwen): сайты стоят за антибот-защитой (AWS WAF у DeepSeek,
   Alibaba Cloud у Qwen), и запрос, не похожий на вкладку браузера (User-Agent «node», без cookies и заголовков, которые
   браузер ставит сам), она встречает проверкой «я не робот». Поэтому сервер ходит на сайт как одна и та же вкладка:
   постоянный User-Agent (обычный Chrome, номер версии растёт сам, или твой — из закладки), подсказки sec-ch-ua ровно
   как у Chromium, Accept-Language, sec-fetch-* как у запроса со страницы сайта и все cookies, что сайт выдал
   (в том числе отметку о пройденной проверке). Состояние st — у каждого пользователя и сайта своё
   (agent.js: deepseek.json, qwen.json): { ua, auto, lang, did, dev, ck, calm }.
   Токены и отпечатки защиты (bx-ua, x-hif-* и т. п.) мы не подделываем: их считают скрипты сайта в настоящем браузере. */
import crypto from 'node:crypto';

/* текущий Chrome: выходит раз в 4 недели (142 — 28.10.2025); берём на версию старше — так у большинства людей */
export const chromeMajor = (now = Date.now()) => Math.max(142, 141 + Math.floor((now - Date.UTC(2025, 9, 28)) / (28 * 864e5)));
export const defaultUA = (v = chromeMajor()) => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + v + '.0.0.0 Safari/537.36';
/* sec-ch-ua — как его собирает сам Chromium (GREASE по номеру версии: components/embedder_support/user_agent_utils.cc).
   Только у Chrome и Edge; Firefox и Safari этих заголовков не шлют */
export function hintsOf(ua) {
  ua = String(ua || '');
  const m = /Chrome\/(\d+)/.exec(ua);
  if (!m || /Firefox|FxiOS|CriOS|EdgiOS|OPR\/|YaBrowser|SamsungBrowser|UCBrowser/.test(ua)) return {};
  const v = +m[1], edge = /Edg\/(\d+)/.exec(ua);
  const ch = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'], order = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]][v % 6];
  const list = [];
  list[order[0]] = ['Not' + ch[v % 11] + 'A' + ch[(v + 1) % 11] + 'Brand', ['8', '99', '24'][v % 3]];
  list[order[1]] = ['Chromium', String(v)];
  list[order[2]] = [edge ? 'Microsoft Edge' : 'Google Chrome', edge ? edge[1] : String(v)];
  const plat = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'Chrome OS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown';
  return { 'sec-ch-ua': list.map(([b, x]) => '"' + b + '";v="' + x + '"').join(', '), 'sec-ch-ua-mobile': /Mobile/.test(ua) ? '?1' : '?0', 'sec-ch-ua-platform': '"' + plat + '"' };
}
/* состояние «браузера»: недостающее дополняем, придуманный нами Chrome «обновляем» */
export function ident(st) {
  if (!st || typeof st !== 'object') st = {};
  if (typeof st.ua !== 'string' || !/^Mozilla\/5\.0 /.test(st.ua) || st.ua.length > 400) { st.ua = defaultUA(); st.auto = 1; }
  else if (st.auto) { const v = +(/Chrome\/(\d+)/.exec(st.ua)?.[1] || 0); if (v < chromeMajor() - 2) st.ua = defaultUA(); }
  if (typeof st.lang !== 'string' || !/^[\w,;=.\s*-]{2,200}$/.test(st.lang)) st.lang = 'en-US,en;q=0.9';
  if (typeof st.did !== 'string' || !/^[0-9a-f-]{36}$/.test(st.did)) st.did = crypto.randomUUID();
  if (!st.ck || typeof st.ck !== 'object' || Array.isArray(st.ck)) st.ck = {};
  return st;
}
export const locOf = lang => { const m = /^([a-z]{2,3})(?:-([A-Za-z]{2}))?/.exec(String(lang || '')); return m ? m[1] + '_' + (m[2] || (m[1] === 'en' ? 'US' : m[1])).toUpperCase() : 'en_US'; };
/* заголовки, которые браузер ставит сам у fetch со страницы сайта: Origin — только у POST, Referer — страница */
export function browserHeaders(st, { method = 'GET', base, ref = '/' } = {}) {
  return { Accept: '*/*', 'Accept-Language': st.lang, ...(method !== 'GET' ? { Origin: base } : {}), 'User-Agent': st.ua, ...hintsOf(st.ua),
    'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', priority: 'u=1, i', Referer: base + (ref || '/') };
}

/* ---------- cookies сайта ----------
   Как у браузера: всё, что сайт выдал через Set-Cookie (своему домену), уходит обратно; истёкшее выбрасываем.
   Сессионные (без срока) живут сутки — браузер столько обычно и не закрывают */
const CK_MAX = 60, CK_SESSION = 864e5;
export const ckOk = (dom, host) => !dom || host === dom || host.endsWith('.' + dom);
export function takeCookies(st, lines, host) {
  let n = 0;
  for (const line of lines || []) {
    const [nv, ...attrs] = String(line).split(';'), i = nv.indexOf('=');
    if (i <= 0) continue;
    const name = nv.slice(0, i).trim(), value = nv.slice(i + 1).trim();
    if (!/^[!#$%&'*+\-.^\w`|~]{1,128}$/.test(name) || value.length > 4096) continue;
    let exp = 0, age = null, dom = '', dated = false;
    for (const a of attrs) {
      const k = a.indexOf('='), key = (k < 0 ? a : a.slice(0, k)).trim().toLowerCase(), v = k < 0 ? '' : a.slice(k + 1).trim();
      if (key === 'max-age' && /^-?\d+$/.test(v)) age = +v;
      else if (key === 'expires') { const t = Date.parse(v); if (Number.isFinite(t)) { exp = t; dated = true; } }
      else if (key === 'domain') dom = v.replace(/^\./, '').toLowerCase();
    }
    if (!ckOk(dom, host)) continue;
    /* Max-Age главнее Expires; срок в прошлом (или Max-Age=0) — сайт удаляет cookie */
    if (age !== null) { exp = Date.now() + age * 1000; dated = true; }
    if (dated && exp <= Date.now()) delete st.ck[name];
    else st.ck[name] = { v: value, e: exp || 0, t: Date.now(), ...(dom ? { d: dom } : {}) };
    n++;
  }
  const ks = Object.keys(st.ck); if (ks.length > CK_MAX) for (const k of ks.slice(0, ks.length - CK_MAX)) delete st.ck[k];
  return n;
}
const live = c => c && typeof c.v === 'string' && (c.e ? c.e > Date.now() : Date.now() - (c.t || 0) < CK_SESSION);
/* skip — свои cookies, которые клиент ставит сам (у Qwen — token) */
export const cookieHeader = (st, skip) => Object.entries(st?.ck || {}).filter(([k, c]) => live(c) && !(skip && skip.has(k))).map(([k, c]) => k + '=' + c.v).join('; ');
/* cookies браузера (CDP Network.getCookies) → сюда и обратно (Network.setCookies) */
export function absorbCookies(st, list, host) {
  ident(st);
  for (const c of list || []) {
    if (!c?.name || typeof c.value !== 'string' || !ckOk(String(c.domain || '').replace(/^\./, '').toLowerCase(), host)) continue;
    const e = c.expires > 0 ? Math.round(c.expires * 1000) : 0;
    if (e && e <= Date.now()) { delete st.ck[c.name]; continue; }
    st.ck[c.name] = { v: c.value, e, t: Date.now(), ...(/^\./.test(c.domain || '') ? { d: String(c.domain).slice(1) } : {}) };
  }
  return st;
}
export const cookieList = (st, base) => Object.entries(st?.ck || {}).filter(([, c]) => live(c))
  .map(([name, c]) => ({ name, value: c.v, ...(c.d ? { domain: '.' + c.d } : { url: base }), path: '/', secure: /^https:/.test(base), ...(c.e ? { expires: c.e / 1000 } : {}) }));

/* ---------- бережный темп ----------
   Не чаще rpm запросов в минуту и с паузой [gap, 2·gap] от конца прошлого; после проверки «я не робот» (calm) —
   пауза втрое длиннее, в минуту — вдвое меньше. Запросы одного ключа идут строго по очереди */
export const calm = st => !!st && +st.calm > Date.now();
export const sleep = (ms, signal) => new Promise(ok => { if (ms <= 0) return ok(); const t = setTimeout(ok, ms); signal?.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true }); });
export function pacer() {
  const gates = new Map();
  return function gated(key, signal, fn, { st, gap = 0, rpm = 0 } = {}) {
    let g = gates.get(key);
    if (!g) { g = { p: Promise.resolve(), last: 0, hits: [] }; gates.set(key, g); if (gates.size > 50) gates.delete(gates.keys().next().value); }
    const run = g.p.then(async () => {
      const c = calm(st), gp = gap * (c ? 3 : 1), lim = rpm > 0 ? Math.max(1, Math.round(rpm / (c ? 2 : 1))) : 0;
      await sleep(g.last + gp + Math.random() * gp - Date.now(), signal);
      if (lim) { g.hits = g.hits.filter(t => Date.now() - t < 60e3); if (g.hits.length >= lim) await sleep(g.hits[0] + 60e3 - Date.now() + Math.random() * gp, signal); }
      if (signal?.aborted) throw signal.reason;
      g.hits.push(Date.now());
      try { return await fn(); } finally { g.last = Date.now(); }
    });
    g.p = run.catch(() => {});
    return run;
  };
}
