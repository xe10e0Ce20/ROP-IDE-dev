// sw.js
// ----------------------------------------------------------------------
// 【重要】请确保每次修改后更新此版本号
// ----------------------------------------------------------------------
const VERSION = 'v2.5.6'; 
const CACHE_NAME = `pwa-offline-cache-${VERSION}`;

// 【核心缓存文件列表】: 补充所有本地依赖文件 (与您提供的列表一致)
const CORE_CACHE_ASSETS = [
    '/', 
    '/index.html', 
    '/assets/manifest-CksoMjeB.json', 
    
    // 本地应用资源
    '/compiler.py', 
    '/assets/index-DDRaXYDt.js', // 假设这是您最新的 JS 文件的正确路径
    '/vendor/pyscript/dist/core.css',
    '/vendor/pyscript/dist/core.js',
    '/vendor/marked/marked.min.js',
    '/README.md',
    
    // main.js 中预加载的初始库文件
    '/vendor/libraries/basic-991cnx-verc.ggt', 
    '/vendor/libraries/basic-common.macro', 
    
    // Pyodide & 依赖文件
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
];

const REDIRECT_MAP = {
    // 1. Pyodide 核心文件
    'cdn.jsdelivr.net/pyodide/v0.23.4/full/': '/vendor/pyodide/pyodide/',

    // 2. toml.js 
    'cdn.jsdelivr.net/npm/@webreflection/toml-j0.4/toml.js': '/vendor/toml/toml.js',
    'cdn.jsdelivr.net/npm/@webreflection/toml-j0.4/toml.js.map': '/vendor/toml/toml.js.map',

    // 3. Lark Wheel 文件
    'lark-1.3.1-py3-none-any.whl': '/vendor/pypi/lark-1.3.1-py3-none-any.whl',
    'pypi.org/pypi/lark/json' : '/vendor/pypi/lark/json.json'
};


// -----------------------------------------------------------------
// 1. INSTALL: 预缓存所有核心资源
// -----------------------------------------------------------------
self.addEventListener('install', (event) => {
    console.log(`[SW] Version ${VERSION} installing. Pre-caching assets.`);
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                return cache.addAll(CORE_CACHE_ASSETS);
            })
            .then(() => {
                // 允许新的 Service Worker 跳过等待阶段，尽快接管控制权
                return self.skipWaiting(); 
            })
            .catch(error => {
                console.error('[SW] 核心文件预缓存失败:', error);
            })
    );
});


// -----------------------------------------------------------------
// 2. ACTIVATE: 清理旧缓存
// -----------------------------------------------------------------
self.addEventListener('activate', (event) => {
    console.log(`[SW] Version ${VERSION} activating. Cleaning up old caches.`);
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});


// -----------------------------------------------------------------
// 3. MESSAGE: 监听来自页面的强制激活指令
// -----------------------------------------------------------------
self.addEventListener('message', (event) => {
    // 允许主线程发送 'SKIP_WAITING' 消息，强制新 SW 激活
    if (event.data && event.data.type === 'SKIP_WAITING') {
        console.log('[SW-SKIP] 接收到 SKIP_WAITING 消息，强制激活。');
        self.skipWaiting();
    }
});


// -----------------------------------------------------------------
// 4. FETCH: 缓存优先策略 + 重定向 + 忽略查询参数
// -----------------------------------------------------------------
self.addEventListener('fetch', (event) => {
    const requestUrl = event.request.url;
    let newUrl = null;
    let intercepted = false;
    
    // --- 1. 现有重定向逻辑 ---
    for (const [originalSegment, targetPath] of Object.entries(REDIRECT_MAP)) {
        if (requestUrl.includes(originalSegment)) {
            intercepted = true;
            
            // 构建 newUrl 的逻辑 (保持不变)
            if (originalSegment.startsWith('http')) {
                newUrl = targetPath;
            } else if (originalSegment.includes('pypi.org')) {
                newUrl = new URL(targetPath, self.location.origin).toString();
            } else {
                const pathSuffix = requestUrl.substring(requestUrl.indexOf(originalSegment) + originalSegment.length);
                newUrl = new URL(targetPath + pathSuffix, self.location.origin).toString();
            }
            break;
        }
    }
    
    // --- 2. 离线缓存处理 (重点修改部分) ---
    
    let cacheKeyRequest = intercepted ? new Request(newUrl) : event.request;
    const url = new URL(cacheKeyRequest.url);
    
    // **【核心修复】**：针对根路径或首页请求，忽略所有查询参数
    if (url.pathname === '/' || url.pathname === '/index.html') {
        // 强制缓存键为无查询参数的 /index.html 或 /
        // 确保使用预缓存的键，即 '/'
        cacheKeyRequest = new Request('/'); 
    } 
    // 其他请求（如 main.js）如果带有 ?force_reload 参数，
    // 我们信任它们会失败然后使用网络，或者 Service Worker 缓存已经正确。
    
    event.respondWith(
        caches.match(cacheKeyRequest).then(cachedResponse => {
            
            // A. 命中缓存：优先返回缓存结果
            if (cachedResponse) {
                console.debug(`[SW-CACHE] 命中缓存: ${cacheKeyRequest.url}`);
                return cachedResponse;
            }

            // B. 缓存未命中：执行网络请求 (网络优先)
            
            // 如果被拦截，使用 newUrl 和 CORS 模式发起网络请求
            if (intercepted) {
                console.debug(`[SW-NETWORK] 重定向并从网络获取: ${newUrl}`);
                return fetch(newUrl, { mode: 'cors' });
            } 
            
            // 如果是应用自身的请求（未被拦截），正常从网络获取
            return fetch(event.request).catch(error => {
                 console.error(`[SW-OFFLINE] 网络请求失败: ${event.request.url} 无法从缓存或网络获取。`, error);
                 // 离线时，如果请求的资源未被缓存 (不在 CORE_CACHE_ASSETS 中)，则返回离线提示
                 return new Response("应用离线，且该资源未被缓存。", { status: 503, statusText: "Offline" });
            });
        })
    );
});