// sw.js
const VERSION = 'v1.1.0'; // 每次修改后请更新版本号，以强制浏览器更新 Service Worker

const REDIRECT_MAP = {
    // 1. Pyodide 核心文件
    'cdn.jsdelivr.net/pyodide/v0.23.4/full/': '/vendor/pyodide/pyodide/',

    // 2. toml.js (来自 PyScript 内部的硬编码)
    'cdn.jsdelivr.net/npm/@webreflection/toml-j0.4/toml.js': '/vendor/toml/toml.js',

    // 3. Lark Wheel 文件 (来自 micropip 内部查找)
    // 注意：我们将只匹配文件名，因为 files.pythonhosted.org 的路径太复杂
    'lark-1.3.1-py3-none-any.whl': '/vendor/pypi/lark-1.3.1-py3-none-any.whl',

    'pypi.org/pypi/lark/json' : '/vendor/pypi/lark/json.json'
};

self.addEventListener('fetch', (event) => {
    const requestUrl = event.request.url;
    let newUrl = null;
    let intercepted = false;

    // 遍历 REDIRECT_MAP 进行匹配
    for (const [originalSegment, targetPath] of Object.entries(REDIRECT_MAP)) {
        if (requestUrl.includes(originalSegment)) {
            
            if (originalSegment.startsWith('http')) {
                // 如果原始片段是完整的 URL，直接替换
                newUrl = targetPath;
            } else if (originalSegment.includes('pypi.org')) {
                // 特殊处理 PyPI 查找（如果需要）
                newUrl = new URL(targetPath, self.location.origin).toString();
            } else {
                // 这是基于路径的匹配，进行替换
                // 示例：从 cdn.jsdelivr.net/pyodide/v0.23.4/full/repodata.json -> /vendor/pyodide-v0.23.4/full/repodata.json
                const pathSuffix = requestUrl.substring(requestUrl.indexOf(originalSegment) + originalSegment.length);
                newUrl = new URL(targetPath + pathSuffix, self.location.origin).toString();
            }
            
            intercepted = true;
            break;
        }
    }
    
    // 如果匹配到需要重定向的外部 CDN 资源
    if (intercepted) {
        console.warn(`[SW-CATCHALL] 🎯 重定向: ${requestUrl} -> ${newUrl}`);
        // 确保使用新的 URL 发起请求，且 CORS 模式通常为 same-origin（如果目标是本地）
        event.respondWith(fetch(newUrl, { mode: 'cors' }));
    } 
    // 对于所有其他请求（包括 Pages 自己的文件），正常放行
});


// 确保 Service Worker 立即激活
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});