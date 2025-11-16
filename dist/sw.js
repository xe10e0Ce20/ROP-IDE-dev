// ----------------------------------------------------------------------
// 【重要】请确保每次修改后更新此版本号
// ----------------------------------------------------------------------
const VERSION = 'v2.8.0'; // 已更新版本号，触发SW更新
const CACHE_NAME = `pwa-offline-cache-${VERSION}`;

// 【关键优化1：最小化预缓存（仅2个文件，秒级安装）】
const MINIMAL_CACHE_ASSETS = [
    '/', // 网站根目录
    '/index.html' // 入口页面
];

// 【关键优化2：延迟缓存的资源（激活后后台异步缓存）】
const DELAYED_CACHE_ASSETS = [
    // 本地应用资源
    '/compiler.py', 
    '/assets/index.js',
    '/vendor/pyscript/dist/core.css',
    '/vendor/pyscript/dist/core.js',
    '/vendor/marked/marked.min.js',
    '/README.md',
    
    // 初始库文件
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

// 【重定向规则数组】
const REDIRECT_RULES = [
    ["cdn.jsdelivr.net/npm/@webreflection/toml-j0.4/toml.js", "/vendor/toml/toml.js"],
    ["cdn.jsdelivr.net/npm/@webreflection/toml-j0.4/toml.js.map", "/vendor/toml/toml.js.map"],
    ["lark-1.3.1-py3-none-any.whl", "/vendor/pypi/lark-1.3.1-py3-none-any.whl"],
    ["pypi.org/pypi/lark/json", "/vendor/pypi/lark/json.json"],
    ["cdn.jsdelivr.net/pyodide/v0.23.4/full/", "/vendor/pyodide/pyodide/"]
];

// -----------------------------------------------------------------
// 1. INSTALL: 仅缓存最小化资源，秒级完成安装
// -----------------------------------------------------------------
self.addEventListener('install', (event) => {
    console.log(`[SW] Version ${VERSION} installing (最小化预缓存)...`);
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                return cache.addAll(MINIMAL_CACHE_ASSETS); // 仅缓存2个文件
            })
            .then(() => {
                console.log(`[SW] 最小化缓存完成，立即激活！`);
                self.skipWaiting(); // 跳过等待，秒级激活
            })
            .catch(error => {
                console.error('[SW] 最小化缓存失败:', error);
            })
    );
});

// -----------------------------------------------------------------
// 2. ACTIVATE: 清理旧缓存 + 后台异步缓存剩余资源
// -----------------------------------------------------------------
self.addEventListener('activate', (event) => {
    console.log(`[SW] Version ${VERSION} activating...`);
    event.waitUntil(
        // 第一步：清理旧缓存
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log(`[SW] 删除旧缓存: ${cacheName}`);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
        .then(() => {
            console.log(`[SW] 成功接管所有页面，开始后台缓存剩余资源...`);
            self.clients.claim(); // 立即接管所有页面
            
            // 第二步：后台异步缓存剩余资源（不阻塞激活流程）
            caches.open(CACHE_NAME).then(cache => {
                cache.addAll(DELAYED_CACHE_ASSETS)
                    .then(() => {
                        console.log(`[SW] 所有资源后台缓存完成！`);
                    })
                    .catch(error => {
                        console.error(`[SW] 后台缓存部分资源失败:`, error);
                    });
            });
        })
    );
});

// -----------------------------------------------------------------
// 3. MESSAGE: 监听强制激活指令
// -----------------------------------------------------------------
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        console.log('[SW-SKIP] 强制激活新SW');
        self.skipWaiting();
    }
});

// -----------------------------------------------------------------
// 4. FETCH: 路径修复 + 重定向 + 缓存优先
// -----------------------------------------------------------------
self.addEventListener('fetch', (event) => {
    const requestUrl = event.request.url;
    let redirectedUrl = null;
    const siteOrigin = self.location.origin; // 自动获取网站域名

     if (requestUrl.includes(`${siteOrigin}/version`)) {
         console.log(`[SW-FETCH] 🚫 跳过 /version 缓存，直接请求网络`);
         return event.respondWith(fetch(event.request));
     }

    // 重定向逻辑
    for (const [matchSegment, localPathPrefix] of REDIRECT_RULES) {
        if (requestUrl.includes(matchSegment)) {
            const pathSuffix = requestUrl.substring(requestUrl.indexOf(matchSegment) + matchSegment.length);
            redirectedUrl = `${siteOrigin}${localPathPrefix}${pathSuffix}`;
            break;
        }
    }

    // 日志输出
    if (redirectedUrl) {
        console.log(`[SW-FETCH] 🔄 已重定向: ${requestUrl} → ${redirectedUrl}`);
    } else {
        console.log(`[SW-FETCH] 🟢 未重定向: ${requestUrl}`);
    }

    // 缓存键与请求处理
    const cacheKey = redirectedUrl ? redirectedUrl : event.request;
    event.respondWith(
        caches.match(cacheKey).then(cachedResponse => {
            if (cachedResponse) {
                console.debug(`[SW-CACHE] 📥 命中缓存: ${cacheKey}`);
                return cachedResponse;
            }

            const fetchTarget = redirectedUrl ? redirectedUrl : event.request;
            const fetchOptions = redirectedUrl ? { mode: 'cors' } : {};

            return fetch(fetchTarget, fetchOptions).then(networkResponse => {
                if (event.request.method === 'GET' && networkResponse.ok) {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(cacheKey, responseToCache);
                    }).catch(err => {
                        console.error(`[SW-CACHE] ❌ 回写缓存失败: ${cacheKey}`, err);
                    });
                }
                return networkResponse;
            }).catch(error => {
                console.error(`[SW-OFFLINE] ❌ 网络请求失败: ${requestUrl}`, error);
                return new Response("应用离线，且该资源未被缓存。", { status: 503, statusText: "Offline" });
            });
        })
    );
});
