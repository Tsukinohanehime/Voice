/* sw.js — เก็บตัวแอปไว้ในเครื่องเพื่อใช้ออฟไลน์ (แก้ไฟล์แล้วต้องเปลี่ยนเลข VERSION) */
const VERSION = 'tvl-shell-v3';
const MODEL_CACHE = 'tvl-model-v1';     // โมเดล AI 58 MB ถูกเก็บโดยหน้าเว็บ (ai.js) ไม่ถูกลบตอนอัปเดต
const SHELL = ['./', 'index.html', 'style.css', 'dsp.js', 'ai.js', 'app.js', 'worklet.js', 'manifest.webmanifest',
  'ort/ort.wasm.min.js', 'ort/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.wasm', 'models/vfp_mlp.bin',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== MODEL_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/models/final.onnx')) {            // ให้ดึงจากเครือข่ายเฉพาะตอนดาวน์โหลดครั้งแรก
    e.respondWith(caches.open(MODEL_CACHE).then(c => c.match(req.url)).then(r => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => {
    const net = fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return res; }).catch(() => hit);
    return hit || net.catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
  }));
});
