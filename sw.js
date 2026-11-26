// Notas — service worker.
// 1) Guarda a "casca" do app para abrir rápido (nenhuma foto ou vídeo é guardado).
// 2) Toca vídeos do MEGA enquanto baixam: busca só a faixa pedida pelo player,
//    decifra (AES-CTR) na hora e entrega. Nada é gravado no aparelho.
const VERSAO = 'nt-v2';
const CASCA = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png'];
const LIBS = [
  'https://unpkg.com/megajs@1.3.10/dist/main.browser-es.mjs',
  'https://unpkg.com/mediabunny@1.66.4/dist/bundles/mediabunny.min.mjs'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll([...CASCA, LIBS[0]])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

/* ---------- vídeos em streaming ---------- */
const VIDEOS = new Map();   // id -> { url, size, mime, chave(CryptoKey), nonce(Uint8Array 8) }

self.addEventListener('message', e => {
  const d = e.data || {};
  const responder = r => { if (e.ports && e.ports[0]) e.ports[0].postMessage(r); };
  if (d.tipo === 'video') {
    crypto.subtle.importKey('raw', new Uint8Array(d.aes), 'AES-CTR', false, ['decrypt']).then(chave => {
      VIDEOS.set(d.id, { url: d.url, size: d.size, mime: d.mime, chave, nonce: new Uint8Array(d.nonce) });
      responder({ ok: true });
    }, () => responder({ ok: false }));
  } else if (d.tipo === 'limpar') {
    VIDEOS.clear();
    responder({ ok: true });
  }
});

function contador(nonce, bloco) {
  const c = new Uint8Array(16);
  c.set(nonce, 0);
  new DataView(c.buffer).setBigUint64(8, BigInt(bloco));
  return c;
}

async function servirVideo(req, id) {
  const v = VIDEOS.get(id);
  if (!v) return new Response('', { status: 404 });
  const tam = v.size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  let ini = m && m[1] ? +m[1] : 0;
  let fim = m && m[2] ? +m[2] : tam - 1;
  if (m && !m[1] && m[2]) { ini = Math.max(0, tam - +m[2]); fim = tam - 1; }   // bytes=-N
  fim = Math.min(fim, tam - 1);
  if (ini > fim) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${tam}` } });

  const alinhado = ini - (ini % 16);
  const resp = await fetch(`${v.url}/${alinhado}-${fim}`);
  if (!resp.ok || !resp.body) return new Response('', { status: resp.status === 509 ? 509 : 502 });

  let bloco = alinhado / 16;        // posição do contador CTR
  let pular = ini - alinhado;       // bytes do começo do bloco que o player não pediu
  let sobra = new Uint8Array(0);
  const decifrar = async dados => {
    const out = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CTR', counter: contador(v.nonce, bloco), length: 64 }, v.chave, dados));
    bloco += Math.ceil(dados.length / 16);
    return out;
  };
  const corpo = resp.body.pipeThrough(new TransformStream({
    async transform(pedaco, ctl) {
      const tudo = new Uint8Array(sobra.length + pedaco.length);
      tudo.set(sobra); tudo.set(pedaco, sobra.length);
      const usar = tudo.length - (tudo.length % 16);
      sobra = tudo.slice(usar);
      if (!usar) return;
      let claro = await decifrar(tudo.subarray(0, usar));
      if (pular) { claro = claro.subarray(pular); pular = 0; }
      if (claro.length) ctl.enqueue(claro);
    },
    async flush(ctl) {
      if (!sobra.length) return;
      let claro = await decifrar(sobra);
      if (pular) { claro = claro.subarray(pular); pular = 0; }
      if (claro.length) ctl.enqueue(claro);
    }
  }));
  const parcial = !!m;
  return new Response(corpo, {
    status: parcial ? 206 : 200,
    headers: {
      'Content-Type': v.mime || 'video/mp4',
      'Content-Length': String(fim - ini + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ...(parcial ? { 'Content-Range': `bytes ${ini}-${fim}/${tam}` } : {})
    }
  });
}

/* ---------- roteamento ---------- */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin && url.pathname.includes('/__v/')) {
    e.respondWith(servirVideo(req, url.pathname.split('/__v/')[1]));
    return;
  }
  // bibliotecas fixas: cache primeiro
  if (LIBS.includes(req.url)) {
    e.respondWith(caches.match(req.url).then(r => r || fetch(req).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(VERSAO).then(c => c.put(req.url, cp)); }
      return res;
    })));
    return;
  }
  // arquivos do próprio app: rede primeiro (pega atualizações), cache se offline
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(VERSAO).then(c => c.put(req, cp)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('index.html'))));
  }
});
