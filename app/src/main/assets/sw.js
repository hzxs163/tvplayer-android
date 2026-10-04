const CACHE_NAME = 'tvplayer-v3';
// 代码类文件走「网络优先」：改了 script.js 后用户下一次打开就是新版，
// 不必先看到旧版再刷新一次（大文件 hls.min.js 仍走缓存优先）
const NETWORK_FIRST = ['/index.html', '/script.js', '/style.css'];
const urlsToCache = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/hls.min.js',
  '/manifest.json',
  '/sources.json'
];

// 安装 Service Worker：预缓存静态资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// 激活 Service Worker：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName))
      );
    }).then(() => self.clients.claim())
  );
});

// 拦截请求
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // 只处理同源 GET 请求
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // ============ API 请求：永不缓存（代理/播放流） ============
  // 避免把视频流和代理响应写入 SW 缓存，导致占用空间与播放过期内容
  if (url.pathname.startsWith('/api/')) return;

  // ============ 页面导航：Network-First（保证更新可见） ============
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('/index.html')))
    );
    return;
  }

  // ============ 代码类文件：Network-First（改动立即生效） ============
  if (NETWORK_FIRST.indexOf(url.pathname) !== -1) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // ============ 静态资源：Cache-First + 后台更新（Stale-While-Revalidate） ============
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
