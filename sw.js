// Service worker mínimo: rede primeiro, cache como reserva (permite abrir a Ponte sem conexão).
// Só respostas 200 do próprio domínio entram no cache: uma falha momentânea do servidor
// (4xx/5xx) não pode virar a tela salva para uso offline.
const CACHE = 'ponte-v4';
const ASSETS = ['./', './index.html', './lenis.min.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const navigate = req.mode === 'navigate';
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          // Navegações vão sempre para a mesma entrada: endereços com ?utm_, ?fbclid etc.
          // não acumulam cópias da página no cache.
          e.waitUntil(caches.open(CACHE).then((c) => c.put(navigate ? './index.html' : req, copy)));
        }
        return res;
      })
      .catch(() =>
        caches.match(navigate ? './index.html' : req).then((r) => r || Response.error())
      )
  );
});
