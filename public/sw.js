// sw.js
const VERSION = 'v2.0.0'; // *** 版本号更新到 v2.0.0 启用离线缓存 ***
const CACHE_NAME = `pwa-offline-cache-${VERSION}`;

// 【核心缓存文件列表】: 包含应用运行所需的所有本地文件
// 重要的：请务必检查并添加您的 index.html、所有 CSS、图片和自定义 JS 文件！
const CORE_CACHE_ASSETS = [
    '/', 
    '/index.html', 
    '/main.js', // 根据您的文件，确保此路径正确
    // 示例：'/styles/main.css', 
    
    // --- Pyodide & 依赖文件 (REDIRECT_MAP 目标) ---
    '/vendor/pyodide/pyodide/pyodide.js',
    '/vendor/pyodide/pyodide/pyodide.asm.wasm',
    '/vendor/pyodide/pyodide/repodata.json', 
    '/vendor/toml/toml.js',
    '/vendor/pypi/lark-1.3.1-py3-none-any.whl',
    '/vendor/pypi/lark/json.json'
];

const REDIRECT_MAP = {
    // 1. Pyodide 核心文件
    'cdn.jsdelivr.net/pyodide/v0.23.4/full/': '/vendor/pyodide/pyodide/',

    // 2. toml.js (来自 PyScript 内部的硬编码)
    'cdn.jsdelivr.net/npm/@webreflection/toml-j0.4/toml.js': '/vendor/toml/toml.js',

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
                return self.skipWaiting(); // 保持原有功能：立即激活
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
        }).then(() => self.clients.claim()) // 保持原有功能：接管客户端
    );
});


// -----------------------------------------------------------------
// 3. FETCH: 缓存优先策略 + 重定向
// -----------------------------------------------------------------
self.addEventListener('fetch', (event) => {
    const requestUrl = event.request.url;
    let newUrl = null;
    let intercepted = false;
    let originalSegment = null; // 用于存储匹配到的键

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
    const targetUrl = intercepted ? newUrl : event.request;
    
    event.respondWith(
        caches.match(targetUrl).then(cachedResponse => {
            
            // A. 命中缓存：优先返回缓存结果
            if (cachedResponse) {
                console.debug(`[SW-CACHE] 命中缓存: ${targetUrl}`);
                return cachedResponse;
            }

            // B. 缓存未命中：执行网络请求
            
            // 如果被拦截，使用 newUrl 和 CORS 模式发起网络请求
            if (intercepted) {
                console.debug(`[SW-NETWORK] 重定向并从网络获取: ${newUrl}`);
                return fetch(newUrl, { mode: 'cors' });
            } 
            
            // 如果是应用自身的请求（未被拦截），正常从网络获取
            return fetch(event.request).catch(error => {
                 console.error(`[SW-OFFLINE] 网络请求失败: ${requestUrl}`, error);
                 // 此时无法提供离线内容，因为它不在核心缓存列表中，或者预缓存失败。
                 // 如果您有离线页面，可以在此处返回。
            });
        })
    );
});


// 确保 Service Worker 立即激活 (已在 install 阶段实现)
// self.addEventListener('install', ...)
// self.addEventListener('activate', ...)