// Notas — service worker: guarda a "casca" do app para abrir rápido.
// As fotos e vídeos NÃO passam por aqui (vêm do MEGA, criptografados).
const VERSAO = 'nt-v1';
const CASCA = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png'];
const LIB = 'https://unpkg.com/megajs@1.3.10/dist/main.browser-es.mjs';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll([...CASCA, LIB])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (e.request.method !== 'GET') return;
  // biblioteca fixa: cache primeiro
  if (url === LIB) {
    e.respondWith(caches.match(url).then(r => r || fetch(e.request).then(res => {
      const cp = res.clone(); caches.open(VERSAO).then(c => c.put(url, cp)); return res;
    })));
    return;
  }
  // arquivos do próprio app: rede primeiro (pega atualizações), cache se offline
  if (new URL(url).origin === self.location.origin) {
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(VERSAO).then(c => c.put(e.request, cp)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
  }
});
