// オフラインで使えるように、アプリの部品をすべて iPad の中に保存しておく。
// アプリを更新したら VERSION の数字を上げる（次に開いたときに新しい部品に入れ替わる）
const VERSION = 'pdf-editor-ipad-1';
const FILES = [
  './',
  'index.html',
  'manifest.json',
  'icon-512.png',
  'lib/pdf.min.js',
  'lib/pdf.worker.min.js',
  'lib/pdf-lib.min.js',
  'lib/cmaps.js',
  'lib/standard_fonts.js',
  'lib/pdfium-worker.js',
  'lib/pdfium/index.browser.js',
  'lib/pdfium/pdfium.wasm',
  'lib/fonts/ipag.ttf',
  'lib/fonts/ipam.ttf',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // 画面（index.html）：つながっていれば最新を使い、つながらなければ保存してあるものを使う
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put('index.html', copy)); }
      return res;
    }).catch(() => caches.match('index.html')));
    return;
  }
  // ライブラリ・フォント：保存してあるものを先に使う（なければネットから取って保存）
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  })));
});
