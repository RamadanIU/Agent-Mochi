/* Мочи: офлайн-кэш. Страница — «сначала сеть» (обновления приходят сразу),
   движок v86 и ядро Linux — «сначала кэш» (качаются один раз). Запросы к модели не трогаем.
   На сервере Мочи /api/, /term/ и /srv/ не кэшируются вовсе. */
const V = 'mochi-v2';
const CORE = ['./', './index.html', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-192.png', './icons/maskable-512.png'];
const HEAVY = [/^https:\/\/cdn\.jsdelivr\.net\/npm\/v86@/, /^https:\/\/i\.copy\.sh\//];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('mochi-') && k !== V).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const okToStore = (req, res) => res && res.status === 200 && !req.headers.has('range');

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  /* режим сервера: API, поток событий и терминал — всегда напрямую */
  if (url.origin === location.origin && /\/(api|term|srv)\//.test(url.pathname)) return;

  if (url.origin === location.origin) {
    const cached = () => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === 'navigate' ? caches.match('./') : undefined));
    e.respondWith(fetch(req).then(res => {
      if (okToStore(req, res)) { const cp = res.clone(); caches.open(V).then(c => c.put(req, cp)); }
      /* сервер Мочи перезапускается (обновление): Caddy отвечает 502 — вместо пустой страницы берём сохранённую,
         её экран загрузки дождётся сервера и обновит страницу сам */
      if (res.status >= 502 && res.status <= 504) return cached().then(r => r || res);
      return res;
    }).catch(() => cached().then(r => r || Response.error())));
    return;
  }

  if (HEAVY.some(r => r.test(req.url)) && !req.headers.has('range')) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (okToStore(req, res)) { const cp = res.clone(); caches.open(V).then(c => c.put(req, cp)); }
      return res;
    })));
  }
});
