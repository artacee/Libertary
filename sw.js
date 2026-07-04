const CACHE_NAME = 'pdf-reader-v1';
const ASSETS = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './annotations.js',
    './icon.svg',
    './manifest.json',
    'https://cdn.jsdelivr.net/npm/page-flip@2.0.7/dist/js/page-flip.browser.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf_viewer.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.mjs',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.mjs'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
});

self.addEventListener('fetch', (e) => {
    e.respondWith(
        caches.match(e.request).then((response) => {
            return response || fetch(e.request);
        })
    );
});
