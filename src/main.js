// src/main.js


// main.js (必须在所有 PyScript 逻辑之前执行)
if ('serviceWorker' in navigator) {
    // 使用 load 事件确保在页面完全加载前尝试注册
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' })
            .then(registration => {
                console.log('Service Worker 注册成功，作用域: ', registration.scope);
            })
            .catch(error => {
                console.error('Service Worker 注册失败: ', error);
            });
    });
}

// ----------------------------------------------------------------------
// 步骤 1: 导入所有 CodeMirror 模块
// ----------------------------------------------------------------------

// 核心
import { EditorView, lineNumbers, highlightActiveLineGutter, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';

// 语言与高亮
import { StreamLanguage, LanguageSupport, bracketMatching, indentOnInput } from '@codemirror/language';

// 自动完成
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';

// 纠错提示
import { linter, lintGutter } from '@codemirror/lint';

// 基础功能
import { defaultKeymap } from '@codemirror/commands';
import { history, historyKeymap } from '@codemirror/history';

// 主题
import { oneDark } from '@codemirror/theme-one-dark';

// ----------------------------------------------------------------------
// 全局状态变量
// ----------------------------------------------------------------------
window.libraryFiles = window.libraryFiles || {};
window.completionWords = window.completionWords || {};
let lastBytecode = "";

const loadingStatusElement = document.getElementById('loading-status');
const INITIAL_LIBRARIES = [
'basic-991cnx-verc.ggt',
'basic-common.macro'
];

function updateLoadingStatus(message, isReady = false) {
    if (loadingStatusElement) {
        loadingStatusElement.textContent = message;
        if (isReady) {
            loadingStatusElement.style.color = 'green';
            loadingStatusElement.style.fontWeight = 'bold';
            loadingStatusElement.style.animation = 'fadeout 3s forwards'; // 可选：添加动画或淡出效果
        } else {
            loadingStatusElement.style.color = 'orange';
            loadingStatusElement.style.fontWeight = 'normal';
        }
    }
}

// ----------------------------------------------------------------------
// 【新增函数】预加载初始库文件
// ----------------------------------------------------------------------

const LIBRARY_BASE_PATH = '/vendor/libraries/'; // 基础路径
async function loadInitialLibraries() {
    console.log("DEBUG: loadInitialLibraries 开始执行...");
    
    // 使用 Promise.all 来并行加载文件
    const fetchPromises = INITIAL_LIBRARIES.map(fileName => {
        // 【核心修改】根据文件名构造路径
        const filePath = LIBRARY_BASE_PATH + fileName; 

        return fetch(filePath)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`无法加载库文件 ${fileName} (${response.status})`);
                }
                return response.text();
            })
            .then(content => {
                window.libraryFiles[fileName] = content; // 文件名即为键名
                console.log(`DEBUG: 成功预加载库文件: ${fileName}`);
            })
            .catch(error => {
                console.error(error.message);
                // 即使失败，也继续处理其他文件
            });
    });

    // 等待所有文件加载完毕
    await Promise.all(fetchPromises);
    
    console.log("DEBUG: loadInitialLibraries 完成。");

    // 加载完成后，刷新库文件查看器和词库
    updateLibraryViewer();

    const initialCode = editorView.state.doc.toString();
    const initialImports = extractImports(initialCode);
    buildCompletionWords(initialCode, window.libraryFiles, initialImports);
}

// ----------------------------------------------------------------------
// 工具函数：防抖
// ----------------------------------------------------------------------
function debounce(func, delay) {
    let timeoutId;
    return function(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

// ----------------------------------------------------------------------
// 工具函数：简易模糊匹配
// ----------------------------------------------------------------------
/**
 * 检查 'word' 是否与 'pattern' 模糊匹配 (简单子序列匹配)
 * @param {string} pattern - 用户输入的文本
 * @param {string} word - 词条的 label
 * @returns {number|null} 匹配度分数 (越高越好，0 表示精确匹配)，不匹配返回 null
 */
function fuzzyMatch(pattern, word) {
    if (!pattern) return 0;
    const patternLower = pattern.toLowerCase();
    const wordLower = word.toLowerCase();
    
    let patternIndex = 0;
    let score = 0;
    
    for (let i = 0; i < wordLower.length; i++) {
        if (patternIndex < patternLower.length && wordLower[i] === patternLower[patternIndex]) {
            patternIndex++;
            score += 1;
        } else {
            score -= 0.1; 
        }
    }
    
    if (patternIndex === patternLower.length) {
        return score - (word.length - pattern.length); 
    }
    
    return null;
}

// ----------------------------------------------------------------------
// 【新增函数】根据前缀分配 CodeMirror 类型
// ----------------------------------------------------------------------
/**
 * 根据指令的前缀分配CodeMirror的Completion Type
 * @param {string} prefix - 指令的前缀 ($!*@) 或 'def'
 * @returns {string} CodeMirror Completion Type
 */
function assignCompletionType(prefix) {
    switch (prefix) {
        case '$':
            return 'class';    // 原本是 function
        case '*':
            return 'function'; // 原本是 variable
        case '!':
            return 'method';   // 原本是 label
        case '@':
            return 'label';    // 原本是 meta
        case 'def':
            return 'keyword';  // 关键字本身
        case 'import':
            return 'keyword';
        default:
            return 'text'; // 默认值
    }
}


// src/main.js (在工具函数部分，例如 debounce 之后)

// ----------------------------------------------------------------------
// 工具函数：提取 Import 语句
// ----------------------------------------------------------------------
/**
 * 从代码顶部（直到第一个 @block. 或代码结束）提取所有 import 的库文件名。
 * @param {string} sourceCode - 当前编辑器的源代码
 * @returns {string[]} 提取到的库文件名列表
 */
function extractImports(sourceCode) {
    const lines = sourceCode.split('\n');
    const importedFiles = [];
    const importRegex = /^\s*import\s+([\w\d._-]+)\s*/i; // 匹配 import filename
    const blockStartRegex = /^\s*@block\./i; // 匹配 @block. 开头

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (blockStartRegex.test(trimmedLine)) {
            // 遇到 @block. 停止解析 import
            break; 
        }

        const match = trimmedLine.match(importRegex);
        if (match && match[1]) {
            // 将匹配到的文件名（去除 import 后的部分）加入列表
            importedFiles.push(match[1].trim());
        }
    }
    return importedFiles;
}


// ----------------------------------------------------------------------
// 【重点函数】解析源代码和库文件，构建 CodeMirror 自动完成词库
// ----------------------------------------------------------------------
function buildCompletionWords(sourceCode, libraryFiles = {}, importedFileNames = []) {
    console.log("DEBUG: buildCompletionWords 开始执行...");
    const newWords = {};
    
    // --- 静态词汇 (保持不变) ---
    const staticWords = {
        '@x=': { label: '@x=', detail: '定义x占位符', type: assignCompletionType('@') },
        '@adr.': { label: '@adr.', detail: '定义地址标签', type: assignCompletionType('@') },
        '@block.': { label: '@block.', detail: '开始一个代码块', type: assignCompletionType('@') },
        '@blockend': { label: '@blockend', detail: '结束代码块', type: assignCompletionType('@') },
        '@offset=': { label: '@offset=', detail: '定义内存偏移量', type: assignCompletionType('@') },
        '@overwrite': { label: '@overwrite', detail: '覆写', type: assignCompletionType('@') }
    };
    Object.assign(newWords, staticWords);

    const librarySources = importedFileNames
        .filter(name => libraryFiles[name]) // 只保留 window.libraryFiles 中实际存在的
        .map(name => ({ name: name, content: libraryFiles[name], isLibrary: true }));
        
    const sources = [
        { name: "Current Code", content: sourceCode || "", isLibrary: false },
        ...librarySources // 仅包含通过 import 语句导入的库
    ];
    
    const commentStart = '//'; 
    
    // 正则
    const strictInstructionRegex = new RegExp(`^([$!*])([^\\s\\({${commentStart}]+)(.*?)(?:\\s*\\${commentStart}(.*))?$`, 'm');
    const defRegex = new RegExp(`^\\s*(def)\\s+([$!*@]?)([\\w?]+)(.*?)(?:\\s*\\${commentStart}(.*))?$`, 'i');
    // 【新增】匹配 @adr.xxx ; comment
    const adrLabelRegex = new RegExp(`^\\s*@adr\\.([\\w?]+)(.*?)(?:\\s*\\${commentStart}(.*))?$`, 'i'); 
    
    sources.forEach(source => {
        const lines = source.content.split('\n');
        let inCodeBlock = true; 

        lines.forEach((line) => {
            const trimmedLine = line.trim();
            if (!trimmedLine) return; 
            
            let match;
            let prefix = '';
            let word = '';
            let comment = '';
            let type = '';

            // --- 1. 库文件 $!* 行 ---
            if (source.isLibrary) {
                match = line.match(strictInstructionRegex);
                if (match) {
                    // ... (逻辑保持不变) ...
                    prefix = match[1]; word = match[2]; comment = (match[4] || '').trim(); type = assignCompletionType(prefix);
                    const key = prefix + word; 
                    if (!newWords[key]) {
                        const rt = word.endsWith('?'); // 简化 rt 判断
                        newWords[key] = { label: key, detail: comment || '', type: type, rt: rt };
                    }
                }
            } 
            // --- 2. 代码文件 def 行 ---
            else if (!source.isLibrary) {
                 if (trimmedLine.match(/^@block/i)) { inCodeBlock = false; return; }
                 if (inCodeBlock) {
                     match = line.match(defRegex);
                     if (match) {
                        // ... (逻辑保持不变) ...
                         const defPrefix = match[2] || ''; word = match[3]; comment = (match[5] || '').trim();
                         let assignedType = defPrefix ? assignCompletionType(defPrefix) : 'function'; 
                         const key = defPrefix + word;
                         if (!newWords[key]) {
                             const rt = word.endsWith('?');
                             newWords[key] = { label: key, detail: comment || '', type: assignedType, rt: rt };
                         }
                    }
                     
                    // --- 【新增】代码文件 @adr.xxx 行 ---
                    match = line.match(adrLabelRegex);
                    if (match) {
                        const labelName = match[1]; // xxx
                        comment = (match[3] || '').trim();
                        
                        // 添加 #xxx
                        const key1 = '#' + labelName;
                        if (!newWords[key1]) {
                             newWords[key1] = { label: key1, detail: comment || '', type: 'label' }; // type 可以是 label 或 variableName
                        }
                        // 添加 ##xxx
                        const key2 = '##' + labelName;
                        if (!newWords[key2]) {
                             newWords[key2] = { label: key2, detail: comment || '', type: 'label' };
                        }
                    }
                }
            }
        });
    });

    // ... (添加 import, def 关键字保持不变) ...
    if (!newWords['import']) { newWords['import'] = { label: 'import', detail: '导入库文件', type: assignCompletionType('import') }; }
    if (!newWords['def']) { newWords['def'] = { label: 'def', detail: '定义新的gadgets/函数', type: assignCompletionType('def') }; }


    window.completionWords = newWords;
    console.log("DEBUG: buildCompletionWords 完成, 新词库大小:", Object.keys(newWords).length);
}

// 防抖版本的词库构建函数
const debouncedBuildCompletionWords = debounce((sourceCode, libraryFiles, importedFileNames) => {
    buildCompletionWords(sourceCode, libraryFiles, importedFileNames);
}, 300);

// ----------------------------------------------------------------------
// 步骤 2: 自定义高亮 (保持不变，因为高亮和自动提示类型是分开的)
// ----------------------------------------------------------------------
const myCustomHighlight = StreamLanguage.define({
    token: (stream) => {
        if (stream.match(/^\s*import\s+([\w\d._-]+)\s*/i) || stream.match(/import/) || stream.match(/def/)) { return "keyword" }
        if (stream.match(/\$[^ \t\r\n(]+/)) { return "keyword"; }
        if (stream.match(/\*[^ \t\r\n(]+/)) { return "operatorKeyword"; }
        if (stream.match(/![^ \t\r\n(]+/)) { return "color"; }
        if (stream.match(/#[^ \t\r\n(]+/)) { return "string"; }
        if (stream.match(/^([0-9a-fA-FXx]{2})+/)) { return "string"; }
        if (stream.match(/^@[a-zA-Z0-9_=.]+/)) { return "variableName"; }
        if (stream.match(/^\/\/.*/)) { return "comment"; }
        if (stream.eatSpace()) { return null; }

        stream.next();
        return null;
    }
});


// ----------------------------------------------------------------------
// 步骤 3: 自动提示
// ----------------------------------------------------------------------
const myCompletions = (context) => {
    if (!window.completionWords) return null;
    
    // 匹配 $!@* 开头，后面跟着字母数字、下划线、以及 ?, &, . 等符号，直到遇到空格或 ;
    let word = context.matchBefore(/[$!@*#|a-zA-Z0-9_][^ \t\n;]*/);

    if (!word || (word.from === word.to && !context.explicit)) {
        if (!context.explicit) return null;
        word = { from: context.pos, to: context.pos, text: "" };
    }

    const typedText = word.text;
    const allWords = window.completionWords;
    let options = [];

    for (const key in allWords) {
        // 模糊匹配
        const score = fuzzyMatch(typedText, key);
        if (score !== null) {
            const item = allWords[key];
            let enhancedDetail = item.detail || '';
            
            // RT 标记修改：[RT] -> *rt*
            if (item.rt) { enhancedDetail = `*rt* ${enhancedDetail}`; }
            
            options.push({ 
                label: item.label, 
                type: item.type, 
                detail: enhancedDetail,
                score: score 
            });
        }
    }
    
    // 显式触发且无输入时，显示所有
    if (context.explicit && typedText.length === 0 && options.length === 0) {
         for (const key in allWords) {
            const item = allWords[key];
            let enhancedDetail = item.detail || '';
            if (item.rt) { enhancedDetail = `*rt* ${enhancedDetail}`; }
            options.push({ label: item.label, type: item.type, detail: enhancedDetail, score: 0 });
        }
    }

    if (options.length === 0) return null;

    // 按模糊匹配分数排序 (分数越高越好)
    options.sort((a, b) => b.score - a.score);

    return {
        from: word.from,
        options: options
    };
};


// src/main.js - 步骤 4: 纠错提示 (Linter)

const myLinter = linter(view => {
    let diagnostics = [];
    const code = view.state.doc.toString();
    const lines = code.split('\n');

    // --- 状态和常量 ---
    let blockSeen = false; // 跟踪是否已经遇到了 @block. 字段
    const commentStart = ';'; // 根据您的 line.replace(/;.*/, '') 逻辑，假定注释符号为分号 ;
    
    // 匹配 @block. 开头（用于状态跟踪）
    const blockRegex = /@block\./i; 
    
    // 匹配十六进制字符串 (不以 $!*#@开头)
    // 使用全局匹配，以便在行内多次查找
    const hexRegex = /(?<![a-zA-Z_$*!#@])\b[0-9a-fA-F]+\b/g; 

    // --- 行级检测 ---
    lines.forEach((line, i) => {
        const lineStartPos = view.state.doc.line(i + 1).from;
        
        // 1. 识别并移除注释
        // 移除行尾注释（我们使用您的代码中定义的 ;. * 来作为注释）
        const commentIndex = line.indexOf(';');
        const nonCommentText = commentIndex === -1 ? line : line.substring(0, commentIndex);
        
        const lineWithoutComment = nonCommentText.trim();
        
        // 2. 更新 @block. 状态
        if (blockRegex.test(lineWithoutComment)) {
            blockSeen = true;
        }

        if (!lineWithoutComment) return; // 忽略空行或只有注释的行

        
        // --- 【新增/移动：条件十六进制长度检测】 ---
        // 仅在 blockSeen 为 true 时执行十六进制检查
        if (blockSeen) {
            let hexMatch;
            // 在非注释部分中查找所有十六进制字符串
            while ((hexMatch = hexRegex.exec(lineWithoutComment)) !== null) {
                const hexString = hexMatch[0];
                
                // 确保我们只处理偶数长度的十六进制字符串（代表字节）
                if (hexString.length > 1 && hexString.length % 2 !== 0) {
                    
                    // 计算在原始行中的起始位置
                    // 注意：这里的 match.index 是在 nonCommentText 中的索引
                    const startColumn = line.indexOf(hexString, hexMatch.index);
                    
                    diagnostics.push({
                        from: lineStartPos + startColumn,
                        to: lineStartPos + startColumn + hexString.length,
                        severity: "error", // 严重性可调
                        message: `十六进制字符串长度 (${hexString.length}) 必须是偶数`
                    });
                }
            }
        }
        // --- 【十六进制检测结束】 ---


        // --- 3. * 函数检测 (保持不变) ---
        // ...
        const funcMatch = lineWithoutComment.match(/^\*([^\s(]+)/); 
        if (funcMatch) {
            const restOfLine = lineWithoutComment.substring(funcMatch[0].length);
            if (!restOfLine.trim().startsWith('(')) {
                const starPos = line.indexOf('*'); 
                 diagnostics.push({
                     from: lineStartPos + starPos, 
                     to: lineStartPos + line.length, 
                     severity: 'error', 
                     message: `* 开头的字段 '${funcMatch[0]}' 后面必须紧跟 '('。`
                 });
            }
        }

        // --- 4. ! 控制结构检测 (保持不变) ---
        // ...
        const ifMatch = lineWithoutComment.match(/^!([^\s({]+)/); 
        if (ifMatch) {
            const structureRegex = /^\s*\([^\)]*\)\s*\{.*$/; 
            const restOfLine = lineWithoutComment.substring(ifMatch[0].length);
            
            if (!restOfLine.match(structureRegex)) {
                 const bangPos = line.indexOf('!'); 
                 diagnostics.push({
                     from: lineStartPos + bangPos, 
                     to: lineStartPos + line.length,
                     severity: 'error', 
                     message: `! 开头的字段 '${ifMatch[0]}' 后面必须是 '(...){' 结构。`
                 });
            }
        }
    });
    
    return diagnostics;
});


// ----------------------------------------------------------------------
// 步骤 5: 初始化 CodeMirror 编辑器
// ----------------------------------------------------------------------
/**
 * 将十六进制字符串格式化为带有双地址列的 Hex Editor 风格视图。
 * @param {string} hexString - 纯十六进制字符串 (例如 "0123ABCD...")
 * @param {string} addr1Hex - 起始地址 1 (十六进制字符串, 如 "D700")
 * @param {string} addr2Hex - 起始地址 2 (十六进制字符串, 如 "E9E0")
 * @param {number} bytesPerLine - 每行显示的字节数 (通常是 16)
 * @returns {string} 格式化后的字符串
 */

function formatHexView(hexString, addr1Hex, addr2Hex, bytesPerLine = 16) {
    if (hexString.startsWith("error:")) return hexString
    if (!hexString || typeof hexString !== 'string') return "无数据或格式错误";
    
    const addr1Start = parseInt(addr1Hex, 16);
    const addr2Start = parseInt(addr2Hex, 16);
    if (isNaN(addr1Start) || isNaN(addr2Start)) return "地址格式错误";

    let output = "";
    const cleanedHex = hexString.replace(/\s/g, ''); // 移除所有空白
    const bytes = [];
    for (let i = 0; i < cleanedHex.length; i += 2) {
        bytes.push(cleanedHex.substring(i, i + 2));
    }

    for (let i = 0; i < bytes.length; i += bytesPerLine) {
        const addr1Current = (addr1Start + i).toString(16).toUpperCase().padStart(4, '0');
        const addr2Current = (addr2Start + i).toString(16).toUpperCase().padStart(4, '0');
        
        const lineBytes = bytes.slice(i, i + bytesPerLine);
        const hexPart = lineBytes.join(' ');
        
        // 可选：添加 ASCII 表示
        // const asciiPart = lineBytes.map(byte => {
        //     const code = parseInt(byte, 16);
        //     return (code >= 32 && code <= 126) ? String.fromCharCode(code) : '.';
        // }).join('');
        
        output += `${addr1Current} ${addr2Current}  ${hexPart.padEnd(bytesPerLine * 3 - 1)}\n`; // 补齐空格
    }
    
    return output || "无字节码数据";
}

// ----------------------------------------------------------------------
// 【新增】十六进制字符串转 Uint8Array 函数 (用于二进制导出)
// ----------------------------------------------------------------------
/**
 * 将十六进制字符串转换为 Uint8Array。
 * @param {string} hexString - 纯十六进制字符串。
 * @returns {Uint8Array} 字节数组。
 */
function hexStringToUint8Array(hexString) {
    if (hexString.length % 2 !== 0) {
        console.warn("奇数长度的十六进制字符串，可能丢失最后一个半字节");
        hexString = hexString.slice(0, -1); // 截断
    }
    const byteArray = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < byteArray.length; i++) {
        byteArray[i] = parseInt(hexString.substring(i * 2, i * 2 + 2), 16);
    }
    return byteArray;
}

const liveUpdateExtension = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
        const currentCode = update.state.doc.toString();
        
        // 【新增/修改】提取 import 列表
        const importedFiles = extractImports(currentCode); 
        
        // 调用防抖函数，传入提取的列表
        debouncedBuildCompletionWords(currentCode, window.libraryFiles, importedFiles);
    }
});

// 组合所有扩展
const extensions = [
    lineNumbers(), 
    highlightActiveLineGutter(),
    history(), 
    indentOnInput(),
    bracketMatching(),
    closeBrackets({ 
       map: '()[]{}<>'
    }),
    oneDark, 
    keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap
    ]),
    new LanguageSupport(myCustomHighlight), 
    autocompletion({ override: [myCompletions] }),
    myLinter,
    lintGutter(),
    liveUpdateExtension
];

// 初始代码
const initialDoc = `//欢迎使用ROP-IDE
//别忘了先用import导入库文件
`;


// 创建编辑器实例
const editorView = new EditorView({
    state: EditorState.create({
        doc: initialDoc,
        extensions: extensions
    }),
    parent: document.getElementById("editor-container")
});

// 初始运行一次词库构建
const initialCode = editorView.state.doc.toString();
const initialImports = extractImports(initialCode); // 提取初始代码中的 import
buildCompletionWords(initialCode, window.libraryFiles, initialImports);

// ----------------------------------------------------------------------
// 步骤 6: 连接所有 UI 按钮和事件
// ----------------------------------------------------------------------

const projectNameInput = document.getElementById('project-name');
const projectName = projectNameInput ? projectNameInput.value.trim() : "source";
const importBtn = document.getElementById('import-btn');
const fileImporter = document.getElementById('file-importer');
const compileBtn = document.getElementById('compile-btn');
const exportSourceBtn = document.getElementById('export-source-btn');
const exportBytecodeBtn = document.getElementById('export-bytecode-btn');

const tabBytecodeBtn = document.getElementById('tab-bytecode-btn');
const tabLibraryBtn = document.getElementById('tab-library-btn');
const bytecodeView = document.getElementById('bytecode-view');        // 指向包含 select 和 pre 的 div
const libraryViewer = document.getElementById('library-viewer');      // 指向包含 select 和 pre 的 div

// 字节码视图元素
const bytecodeSelector = document.getElementById('bytecode-selector'); // <-- 新增
const bytecodeContentDisplay = document.getElementById('bytecode-content-display'); // <-- 新增

// 库文件视图元素
const librarySelector = document.getElementById('library-selector');
const libraryContentDisplay = document.getElementById('library-content-display');

// 更新库文件下拉框函数
function updateLibraryViewer() {
    const files = window.libraryFiles; 
    const selector = document.getElementById('library-selector');
    const contentDisplay = document.getElementById('library-content-display');
    
    if (!selector || !contentDisplay) {
        console.warn("DOM 元素 (library-selector 或 library-content-display) 未找到。");
        return; 
    }

    selector.innerHTML = ''; 
    
    if (Object.keys(files).length === 0) {
        const option = document.createElement('option');
        option.value = "";
        option.textContent = "-- 请先导入库文件 --";
        selector.appendChild(option);
        contentDisplay.textContent = '请导入库文件以在此处查看内容。'; 
        return;
    }
    
    for (const filename in files) {
        const option = document.createElement('option');
        option.value = filename;
        option.textContent = filename;
        selector.appendChild(option);
    }
    
    if (selector.options.length > 0) {
        selector.selectedIndex = 0;
        selector.dispatchEvent(new Event('change')); 
    } else {
         contentDisplay.textContent = '';
    }
}

// 更新字节码查看器函数 (逻辑不变, 确认 DOM 引用)
function updateBytecodeViewer() {
    const blocks = window.bytecodeBlocks || {}; // 确保初始化为空对象
    const selector = document.getElementById('bytecode-selector');
    const contentDisplay = document.getElementById('bytecode-content-display'); 
    
    // ... (DOM 检查) ...
    
    selector.innerHTML = ''; 
    
    if (Object.keys(blocks).length === 0) {
        // 当 blocks 确实为空时，才显示此信息并返回
        const option = document.createElement('option');
        option.value = "";
        option.textContent = "-- 编译结果为空 --";
        selector.appendChild(option);
        if (contentDisplay) contentDisplay.textContent = '编译结果为空。';
        return; // <-- 只有在空的时候才返回！
    } 
    
    // ------------------------------------------------------------------
    // 填充下拉框：如果走到这里，说明 blocks 不为空
    // ------------------------------------------------------------------
    for (const blockName in blocks) { 
        const option = document.createElement('option');
        option.value = blockName;
        option.textContent = blockName;
        selector.appendChild(option);
    }
    
    // ------------------------------------------------------------------
    // 显示第一个块的内容
    // ------------------------------------------------------------------
    if (selector.options.length > 0) { 
        selector.selectedIndex = 0; 
        // 强制触发 change 事件，让 onchange 监听器调用 formatHexView()
        selector.dispatchEvent(new Event('change')); 
    }
}

loadInitialLibraries();

// 1. 导入库文件
if (importBtn && fileImporter) {
    importBtn.onclick = () => { fileImporter.click(); };
    fileImporter.onchange = (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        let filesLoaded = 0;
        Array.from(files).forEach(file => {
            const reader = new FileReader();
            reader.onerror = (err) => { console.error(`ERROR: 读取文件 ${file.name} 失败`, err); };
            reader.onload = (event) => {
                window.libraryFiles[file.name] = event.target.result; 
                filesLoaded++;
                
                if (filesLoaded === files.length) {
                    alert(`成功导入 ${files.length} 个库文件。`);
                    
                    // 确保导入后立即调用词库构建
                    buildCompletionWords(editorView.state.doc.toString(), window.libraryFiles); 
                    
                    updateLibraryViewer(); 
                    if(tabLibraryBtn) tabLibraryBtn.click();
                }
            };
            reader.readAsText(file);
        });
        fileImporter.value = '';
    };
} 

// 2. 点击编译
// 2. 点击编译 (核心修改)
if (compileBtn) {
    compileBtn.onclick = async () => {
        // ... (获取 sourceCode, addr1, addr2 不变) ...
        const sourceCode = editorView.state.doc.toString();
        const addr1Input = document.getElementById('addr1'); const addr2Input = document.getElementById('addr2');

        // 更新 UI 提示
        if(bytecodeSelector) bytecodeSelector.innerHTML = '<option>编译中...</option>';
        if(bytecodeContentDisplay) bytecodeContentDisplay.textContent = '编译中...';
        if(tabBytecodeBtn) tabBytecodeBtn.click(); // 切换到字节码视图

        buildCompletionWords(sourceCode, window.libraryFiles); 
        
        try {
            if (typeof window.pyProcessCode === 'function') {
                
                // 【修复 1】确保传递所有参数 (addr1, addr2)
                const resultProxy = await window.pyProcessCode(sourceCode, window.libraryFiles);
                
                // 【修复 2】确保 toJs 正确转换 PyProxy
                // 使用 dict_converter 将 Python 字典 (或 JS Map 代理) 转为标准 JS 对象
                const resultObject = resultProxy.toJs({ dict_converter: Object.fromEntries }); 
                
                // 调试输出转换后的对象
                console.log("DEBUG: Python 返回的字节码字典 (已转换):", resultObject); 

                window.bytecodeBlocks = resultObject; 
                
                // 【重要】调用 updateBytecodeViewer() 来填充下拉框
                // 这应该会自动触发 onchange 事件 (通过 dispatchEvent) 来显示第一个块的内容
                updateBytecodeViewer(); 

            } else { throw new Error("PyScript 函数 'pyProcessCode' 未准备好。"); }
        } catch (error) {
            console.error("编译失败:", error);
            window.bytecodeBlocks = {}; 
            if(bytecodeSelector) bytecodeSelector.innerHTML = '<option value="">-- 编译失败 --</option>';
            if(bytecodeContentDisplay) bytecodeContentDisplay.textContent = `编译失败: ${error.toString()}`;
        }
    };
}

// 3. 切换标签页
if (tabBytecodeBtn && tabLibraryBtn && bytecodeView && libraryViewer) {
    tabBytecodeBtn.onclick = () => {
        bytecodeView.style.display = 'block';
        libraryViewer.style.display = 'none';
        tabBytecodeBtn.classList.add('active');
        tabLibraryBtn.classList.remove('active');
    };
    tabLibraryBtn.onclick = () => {
        bytecodeView.style.display = 'none';
        libraryViewer.style.display = 'block';
        tabBytecodeBtn.classList.remove('active');
        tabLibraryBtn.classList.add('active');
        updateLibraryViewer();
    };
} 

// 4. 字节码选择器事件 (修改为调用 formatHexView)
if(bytecodeSelector) {
    bytecodeSelector.onchange = () => {
        const selector = document.getElementById('bytecode-selector');
        const contentDisplay = document.getElementById('bytecode-content-display');
        const addr1Input = document.getElementById('addr1'); // 获取地址输入框
        const addr2Input = document.getElementById('addr2'); // 获取地址输入框
        
        if (!selector || !contentDisplay || !addr1Input || !addr2Input) return;

        const selectedBlock = selector.value;
        const addr1Hex = addr1Input.value || 'D700'; // 获取当前地址1
        const addr2Hex = addr2Input.value || 'E9E0'; // 获取当前地址2
        
        if (selectedBlock && window.bytecodeBlocks[selectedBlock]) {
            // 【修改】调用 Hex 格式化函数
            contentDisplay.textContent = formatHexView(window.bytecodeBlocks[selectedBlock], addr1Hex, addr2Hex);
        } else if (Object.keys(window.bytecodeBlocks).length > 0 && !selectedBlock) {
             const firstKey = Object.keys(window.bytecodeBlocks)[0];
             contentDisplay.textContent = formatHexView(window.bytecodeBlocks[firstKey], addr1Hex, addr2Hex);
        } else {
            contentDisplay.textContent = '请选择一个代码块查看字节码。';
        }
    };
}

// 5. 查看库文件内容
if(librarySelector) {
    librarySelector.onchange = () => {
        const selector = document.getElementById('library-selector');
        const contentDisplay = document.getElementById('library-content-display');
        
        if (!selector || !contentDisplay) return;

        const selectedFile = selector.value;
        if (selectedFile && window.libraryFiles[selectedFile]) {
            contentDisplay.textContent = window.libraryFiles[selectedFile];
        } else {
            contentDisplay.textContent = '';
        }
    };
}

function downloadFile(filename, content, type = 'text/plain') {
    const blob = new Blob([content], { type: type });
    const url = URL.createObjectURL(blob);
    const element = document.createElement('a');
    element.setAttribute('href', url);
    element.setAttribute('download', filename);
    element.style.display = 'none';
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
    URL.revokeObjectURL(url); // 释放 URL 对象
}

if(exportSourceBtn) {
    exportSourceBtn.onclick = () => {
        // 1. 从 CodeMirror 编辑器获取当前内容
        const sourceCode = editorView.state.doc.toString();
        
        // 2. 检查内容是否为空
        if (!sourceCode.trim()) {
            alert('编辑器中没有内容可以导出！');
            return;
        }

        // 3. 询问文件名 (可选，如果不需要询问，可以直接使用固定文件名)
        const filename = `${projectName}.rop`

        if (filename) {
            // 4. 调用下载函数
            downloadFile(filename, sourceCode, 'text/plain');
        }
    };
}

if(exportBytecodeBtn) { 
    exportBytecodeBtn.onclick = () => { 
        const selectedBlock = bytecodeSelector ? bytecodeSelector.value : null;
        if (!selectedBlock || !window.bytecodeBlocks[selectedBlock]) {
            alert('请先编译并选择一个要导出的字节码块！');
            return;
        }
        
        const blockName = selectedBlock;
        const hexString = window.bytecodeBlocks[blockName];
        
        // 弹出对话框让用户选择格式
        const format = prompt(`导出字节码块 "${blockName}"\n请输入导出格式: 'txt' (十六进制文本) 或 'bin' (二进制文件)`, 'txt');
        
        if (format && format.toLowerCase() === 'bin') {
            // 导出二进制
            const byteArray = hexStringToUint8Array(hexString);
            downloadFile(`${projectName}_${blockName}.bin`, byteArray, 'application/octet-stream');
        } else if (format && format.toLowerCase() === 'txt') {
            // 导出文本
            downloadFile(`${projectName}_${blockName}.txt`, hexString, 'text/plain');
        } else if (format !== null) {
            alert('无效的格式，请输入 "txt" 或 "bin"。');
        }
        // 如果用户取消 prompt，则什么都不做
    }; 
}

const resizer = document.getElementById('dragMe');
const leftSide = document.getElementById('editor-container');
const rightSide = document.querySelector('.output-container'); // 使用类选择器

if (resizer && leftSide && rightSide) {
    let x = 0;
    let leftWidth = 0;

    const mouseDownHandler = function (e) {
        // 阻止默认的 mousedown 行为 (例如文本选择)
        e.preventDefault();

        // 获取初始鼠标位置和左侧面板宽度
        x = e.clientX;
        leftWidth = leftSide.getBoundingClientRect().width;

        // 添加全局事件监听器
        document.addEventListener('mousemove', mouseMoveHandler);
        document.addEventListener('mouseup', mouseUpHandler);
        
        // 添加样式表示正在拖动 (可选)
        resizer.classList.add('resizing');
        document.body.style.cursor = 'col-resize'; // 更改鼠标样式
        document.body.style.userSelect = 'none'; // 禁止拖动时选中文本
    };

    const mouseMoveHandler = function (e) {
        // 计算鼠标移动距离
        const dx = e.clientX - x;

        // 计算新的左侧宽度
        const newLeftWidth = leftWidth + dx;
        
        // 获取父容器总宽度
        const containerWidth = resizer.parentNode.getBoundingClientRect().width;

        // 转换为百分比
        const newLeftWidthPercent = (newLeftWidth / containerWidth) * 100;
        
        // 设置左右面板的 flex-basis
        // 添加边界检查，防止面板过小或过大 (例如，最小 15%)
        const minWidthPercent = 15;
        const maxWidthPercent = 85;
        
        if (newLeftWidthPercent > minWidthPercent && newLeftWidthPercent < maxWidthPercent) {
            leftSide.style.flexBasis = `${newLeftWidthPercent}%`;
            // 右侧宽度自动调整 (flex: 1) 或手动设置
            rightSide.style.flexBasis = `${100 - newLeftWidthPercent}%`; 
        }
    };

    const mouseUpHandler = function () {
        // 移除全局事件监听器
        document.removeEventListener('mousemove', mouseMoveHandler);
        document.removeEventListener('mouseup', mouseUpHandler);
        
        // 移除拖动样式 (可选)
        resizer.classList.remove('resizing');
        document.body.style.cursor = 'default';
        document.body.style.removeProperty('user-select');
    };

    // 绑定 mousedown 事件到拖动条
    resizer.addEventListener('mousedown', mouseDownHandler);

} else {
    console.warn("拖动条 (#dragMe) 或侧边栏 (#editor-container / .output-container) 未找到。");
}

// main.js (文件末尾)
// ...

loadInitialLibraries();

// 周期性检查 pyProcessCode 是否准备好
const checkPyodideReady = setInterval(() => {
    if (typeof window.pyProcessCode === 'function') {
        clearInterval(checkPyodideReady);
        updateLoadingStatus('Python 环境就绪，编译器已加载。', true);
        
        // -------------------------------------------------------------
        // 【重点】如果您的 UI 元素在 Python 就绪前被禁用，请在此处启用
        // -------------------------------------------------------------
        const compileBtn = document.getElementById('compile-btn');
        if (compileBtn) {
            compileBtn.disabled = false;
            compileBtn.textContent = '编译 (就绪)';
        }
        
    } else {
        // 如果 1.C 步没有提供下载进度，这里可以提供一个通用忙碌状态
        updateLoadingStatus('Python 环境初始化中，等待编译器加载...');
        
        // 【可选】在此处禁用编译按钮，防止用户过早点击
        const compileBtn = document.getElementById('compile-btn');
        if (compileBtn) {
            compileBtn.disabled = true;
            compileBtn.textContent = '初始化中...';
        }
    }
}, 500); // 每 500 毫秒检查一次


// main.js (在现有逻辑的末尾或工具函数区域)

// 获取 DOM 元素
const showTutorialBtn = document.getElementById('show-tutorial-btn');
const tutorialModal = document.getElementById('tutorial-modal');
const tutorialContent = document.getElementById('tutorial-content');
const closeModalBtn = document.getElementById('close-modal-btn');

// 定义 Markdown 文件路径
const README_PATH = '/README.md';

/**
 * 从本地获取 README.md 并将其渲染为 HTML
 */
async function loadAndRenderReadme() {
    try {
        // 1. 发起请求获取 Markdown 文件内容
        const response = await fetch(README_PATH);
        if (!response.ok) {
            throw new Error(`无法加载 ${response.status} ${response.statusText}`);
        }
        
        const markdownText = await response.text();
        
        // 2. 使用 Marked.js 渲染 Markdown 为 HTML
        // 假设 marked.js 已经通过 <script> 标签加载，并在全局暴露 marked 对象
        // 如果您使用的是 ES Module，您需要 import 方式引入 marked.js
        if (typeof marked === 'undefined') {
             tutorialContent.innerHTML = "Markdown 渲染库未加载。";
             return;
        }
        
        // 使用 marked.js 将 Markdown 文本转换为 HTML
        const htmlContent = marked.parse(markdownText);

        // 3. 将渲染结果插入到容器中
        tutorialContent.innerHTML = htmlContent;

        // 4. 显示模态框
        tutorialModal.style.display = 'block';

    } catch (error) {
        console.error("加载和渲染教程失败:", error);
        tutorialContent.innerHTML = `加载教程失败：${error.message}`;
        tutorialModal.style.display = 'block';
    }
}

// 添加事件监听器
if (showTutorialBtn) {
    showTutorialBtn.addEventListener('click', loadAndRenderReadme);
}

if (closeModalBtn) {
    closeModalBtn.addEventListener('click', () => {
        tutorialModal.style.display = 'none';
    });
}