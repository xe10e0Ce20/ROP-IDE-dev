// sw.js
const VERSION = 'v2.5.0'; // *** 版本号更新到 v2.0.1 修复离线加载和安装问题 ***
const CACHE_NAME = `pwa-offline-cache-${VERSION}`;

// 【核心缓存文件列表】: 补充所有本地依赖文件
const CORE_CACHE_ASSETS = [
    '/', 
    '/index.html', 
    '/assets/manifest-CksoMjeB.json', // 新增：PWA Manifest 文件
    
    // 【新增】本地应用资源 (从 index.html 发现)
    '/src/compiler.py', 
    '/assets/index-f2oZCQHj.js', // 修正路径以匹配 index.html
    '/vendor/pyscript/dist/core.css',
    '/vendor/pyscript/dist/core.js',
    
    // 【新增】main.js 中预加载的初始库文件
    '/vendor/libraries/basic-991cnx-verc.ggt', 
    '/vendor/libraries/basic-common.macro', 
    
    // --- Pyodide & 依赖文件 (REDIRECT_MAP 目标，保留不变) ---
    '/vendor/pyodide/pyodide/pyodide.js',
    '/vendor/pyodide/pyodide/pyodide.asm.wasm',
    '/vendor/pyodide/pyodide/pyodide.asm.js',
    '/vendor/pyodide/pyodide/repodata.json', 
    '/vendor/pyodide/pyodide/python_stdlib.zip',
    '/vendor/pyodide/pyodide/micropip-0.3.0-py3-none-any.whl',
    '/vendor/pyodide/pyodide/packaging-23.0-py3-none-any.whl',
    '/vendor/toml/toml.js',
    '/vendor/toml/toml.js.map',
    '/vendor/pypi/lark-1.3.1-py3-none-any.whl',
    '/vendor/pypi/lark/json.json',

    '/vendor/pyscript/dist/error-e4fe78fd.js',
    '/vendor/pyodide/pyodide/pyodide.mjs',
    '/favicon.ico',

    '/icon-192x192.png',
    '/icon-512x512.png',

    '/README.md',
    '/vendor/marked/marked.min.js'
];

const REDIRECT_MAP = {
    // 1. Pyodide 核心文件
    'cdn.jsdelivr.net/pyodide/v0.23.4/full/': '/vendor/pyodide/pyodide/',

    // 2. toml.js (来自 PyScript 内部的硬编码)
    'cdn.jsdelivr.net/npm/@webreflection/toml-j0.4/toml.js': '/vendor/toml/toml.js',
    'cdn.jsdelivr.net/npm/@webreflection/toml-j0.4/toml.js.map': '/vendor/toml/toml.js.map',

    // 3. Lark Wheel 文件 (来自 micropip 内部查找)
    'lark-1.3.1-py3-none-any.whl': '/vendor/pypi/lark-1.3.1-py3-none-any.whl',

    'pypi.org/pypi/lark/json' : '/vendor/pypi/lark/json.json'
};


// -----------------------------------------------------------------
// 1. INSTALL: 预缓存所有核心资源 (离线关键步骤)
// -----------------------------------------------------------------
self.addEventListener('install', (event) => {
    console.log(`[SW] Version ${VERSION} installing. Pre-caching assets.`);
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                // 将所有核心文件下载并存入缓存
                return cache.addAll(CORE_CACHE_ASSETS);
            })
            .then(() => {
                return self.skipWaiting(); 
            })
            .catch(error => {
                console.error('[SW] 核心文件预缓存失败，应用可能无法离线运行:', error);
            })
    );
});


// -----------------------------------------------------------------
// 2. ACTIVATE: 清理旧缓存 (确保只运行最新版本)
// -----------------------------------------------------------------
self.addEventListener('activate', (event) => {
    console.log(`[SW] Version ${VERSION} activating. Cleaning up old caches.`);
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    // 删除所有不匹配当前版本号的旧缓存
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});


// -----------------------------------------------------------------
// 3. FETCH: 缓存优先策略 + 重定向
// -----------------------------------------------------------------
self.addEventListener('fetch', (event) => {
    const requestUrl = event.request.url;
    let newUrl = null;
    let intercepted = false;
    let originalSegment = null; 

    // --- 1. 现有重定向逻辑（获取最终目标 URL） ---
    for (const [segment, path] of Object.entries(REDIRECT_MAP)) {
        if (requestUrl.includes(segment)) {
            intercepted = true;
            originalSegment = segment;
            
            if (segment.startsWith('http')) {
                newUrl = path;
            } else if (segment.includes('pypi.org')) {
                newUrl = new URL(path, self.location.origin).toString();
            } else {
                const pathSuffix = requestUrl.substring(requestUrl.indexOf(segment) + segment.length);
                newUrl = new URL(path + pathSuffix, self.location.origin).toString();
            }
            break;
        }
    }
    
    // --- 2. 离线缓存处理 ---
    
    // 如果请求被重定向（外部 CDN 请求），使用本地目标 URL 作为缓存键
    // 否则，使用原始请求作为缓存键
    const targetUrl = intercepted ? newUrl : event.request;
    
    event.respondWith(
        caches.match(targetUrl).then(cachedResponse => {
            
            // A. 命中缓存：优先返回缓存结果 (无论是预缓存的本地文件，还是重定向的目标文件)
            if (cachedResponse) {
                console.debug(`[SW-CACHE] 命中缓存: ${targetUrl}`);
                return cachedResponse;
            }

            // B. 缓存未命中：执行网络请求 (这是在离线状态下失败的原因)
            
            // 如果被拦截，使用 newUrl 和 CORS 模式发起网络请求
            if (intercepted) {
                console.debug(`[SW-NETWORK] 重定向并从网络获取: ${newUrl}`);
                return fetch(newUrl, { mode: 'cors' });
            } 
            
            // 如果是应用自身的请求（未被拦截），正常从网络获取
            return fetch(event.request).catch(error => {
                 console.error(`[SW-OFFLINE] 网络请求失败: ${requestUrl}`, error);
                 // 离线时，此处的 catch 会被触发，因为文件不在缓存中。
                 // 现在 CORE_CACHE_ASSETS 完整了，只有新加载的或缺失的才会到这里。
                 // 可以返回一个自定义的 404 响应，或者一个空白/离线提示页面。
                 return new Response("应用离线，且该资源未被缓存。", { status: 503, statusText: "Offline" });
            });
        })
    );
});
