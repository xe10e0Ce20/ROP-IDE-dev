// sw.js - Service Worker (改进版)

// 与 main.js 中的 LOCAL_VERSION 保持同步（此处为 SW 自身版本）
const SW_VERSION = 'v2.9.0';
const CACHE_NAME = `pwa-offline-cache-${SW_VERSION}`;

// 最小化预缓存（安装阶段立即缓存，保证秒级完成）
const PRECACHE_ASSETS = [
    '/',
    '/index.html'
];

// 延迟缓存（激活后后台异步缓存，不阻塞首次使用）
const DELAYED_CACHE_ASSETS = [
    // === 应用核心 ===
    '/compiler.py',
    '/assets/index-PWwk7m33.js',
    '/vendor/pyscript/dist/core.css',
    '/vendor/pyscript/dist/core.js',
    '/vendor/marked/marked.min.js',
    '/README.md',
    '/favicon.ico',
    '/icon-192x192.png',
    '/icon-512x512.png',

    // === 初始库文件 ===
    '/vendor/libraries/basic-991cnx-verc.ggt',
    '/vendor/libraries/basic-common.macro',

    // === Pyodide 运行时 ===
    '/vendor/pyodide/pyodide/pyodide.js',
    '/vendor/pyodide/pyodide/pyodide.asm.wasm',
    '/vendor/pyodide/pyodide/pyodide.asm.js',
    '/vendor/pyodide/pyodide/repodata.json',
    '/vendor/pyodide/pyodide/python_stdlib.zip',
    '/vendor/pyodide/pyodide/micropip-0.3.0-py3-none-any.whl',
    '/vendor/pyodide/pyodide/packaging-23.0-py3-none-any.whl',
    '/vendor/pyodide/pyodide/pyodide.mjs',

    // === 依赖资源 ===
    '/vendor/toml/toml.js',
    '/vendor/toml/toml.js.map',
    '/vendor/pypi/lark-1.3.1-py3-none-any.whl',
    '/vendor/pypi/lark/json.json',
    '/vendor/pyscript/dist/error-e4fe78fd.js',
];

// CDN 重定向规则，将外部资源重定向到本地副本
const REDIRECT_RULES = [
    ['cdn.jsdelivr.net/npm/@webreflection/toml-j0.4/toml.js', '/vendor/toml/toml.js'],
    ['cdn.jsdelivr.net/npm/@webreflection/toml-j0.4/toml.js.map', '/vendor/toml/toml.js.map'],
    ['lark-1.3.1-py3-none-any.whl', '/vendor/pypi/lark-1.3.1-py3-none-any.whl'],
    ['pypi.org/pypi/lark/json', '/vendor/pypi/lark/json.json'],
    ['cdn.jsdelivr.net/pyodide/v0.23.4/full/', '/vendor/pyodide/pyodide/']
];

// -----------------------------------------------------------------
// INSTALL: 仅缓存必要资源，立即激活
// -----------------------------------------------------------------
self.addEventListener('install', event => {
    console.log(`[SW] ${SW_VERSION} 安装中...`);
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(PRECACHE_ASSETS))
            .then(() => {
                console.log('[SW] 核心缓存完成，立即激活');
                self.skipWaiting();
            })
            .catch(err => console.error('[SW] 安装失败:', err))
    );
});

// -----------------------------------------------------------------
// ACTIVATE: 清理旧缓存 + 后台下载剩余资源
// -----------------------------------------------------------------
self.addEventListener('activate', event => {
    console.log(`[SW] ${SW_VERSION} 激活`);
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => {
                    console.log('[SW] 删除旧缓存:', k);
                    return caches.delete(k);
                })
            ))
            .then(() => {
                self.clients.claim();
                // 后台异步缓存剩余资源
                caches.open(CACHE_NAME).then(cache => {
                    cache.addAll(DELAYED_CACHE_ASSETS)
                        .then(() => console.log('[SW] 所有资源后台缓存完成'))
                        .catch(err => console.warn('[SW] 后台缓存部分失败:', err));
                });
            })
    );
});

// -----------------------------------------------------------------
// MESSAGE: 强制激活
// -----------------------------------------------------------------
self.addEventListener('message', event => {
    if (event.data?.type === 'SKIP_WAITING') {
        console.log('[SW] 收到 SKIP_WAITING 指令，立即激活');
        self.skipWaiting();
    }
});

// -----------------------------------------------------------------
// FETCH: 请求重定向 + 缓存优先
// -----------------------------------------------------------------
self.addEventListener('fetch', event => {
    const url = event.request.url;
    const siteOrigin = self.location.origin;

    // 对 /version 请求强制走网络（不缓存）
    if (url.startsWith(`${siteOrigin}/version`)) {
        return event.respondWith(fetch(event.request));
    }

    // 重定向匹配
    let redirectedUrl = null;
    for (const [pattern, localPath] of REDIRECT_RULES) {
        if (url.includes(pattern)) {
            const suffix = url.substring(url.indexOf(pattern) + pattern.length);
            redirectedUrl = `${siteOrigin}${localPath}${suffix}`;
            break;
        }
    }

    const cacheKey = redirectedUrl || event.request;
    event.respondWith(
        caches.match(cacheKey).then(cached => {
            if (cached) return cached;
            const fetchTarget = redirectedUrl || event.request;
            return fetch(fetchTarget, { mode: redirectedUrl ? 'cors' : undefined })
                .then(response => {
                    if (event.request.method === 'GET' && response.ok) {
                        const cloned = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, cloned));
                    }
                    return response;
                })
                .catch(() => new Response('应用离线，且该资源未被缓存。', { status: 503, statusText: 'Offline' }));
        })
    );
});