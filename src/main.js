// src/main.js

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


// ----------------------------------------------------------------------
// 【重点函数】解析源代码和库文件，构建 CodeMirror 自动完成词库
// ----------------------------------------------------------------------
function buildCompletionWords(sourceCode, libraryFiles = {}) {
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

    const sources = [
        { name: "Current Code", content: sourceCode || "", isLibrary: false },
        ...Object.keys(libraryFiles).map(name => ({ name: name, content: libraryFiles[name], isLibrary: true }))
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
const debouncedBuildCompletionWords = debounce((sourceCode, libraryFiles) => {
    buildCompletionWords(sourceCode, libraryFiles);
}, 300); 

// ----------------------------------------------------------------------
// 步骤 2: 自定义高亮 (保持不变，因为高亮和自动提示类型是分开的)
// ----------------------------------------------------------------------
const myCustomHighlight = StreamLanguage.define({
    token: (stream) => {
        if (stream.match(/import/) || stream.match(/def/)) { return "keyword" }
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
    let word = context.matchBefore(/[$!@*#a-zA-Z0-9_][^ \t\n;]*/);

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
    
    // --- 2. 十六进制长度检测 (保持修复) ---
    const hexRegex = /(?<![a-zA-Z_$*!#@])\b[0-9a-fA-F]+\b/g; 
    let hexMatch;
    while ((hexMatch = hexRegex.exec(code)) !== null) {
        const hexString = hexMatch[0];
        const startPos = hexMatch.index;
        if (hexString.length > 1 && hexString.length % 2 !== 0) { // 只检查长度大于1的
            diagnostics.push({
                from: startPos, to: startPos + hexString.length,
                severity: 'warning', 
                message: `十六进制数据长度 ${hexString.length} 必须是偶数。`
            });
        }
    }

    // --- 行级检测 ---
    lines.forEach((line, i) => {
        const lineStartPos = view.state.doc.line(i + 1).from;
        
        // **关键：先移除行尾注释再检查结构**
        const lineWithoutComment = line.replace(/;.*/, '').trim(); 
        
        if (!lineWithoutComment) return; // 忽略空行或只有注释的行

        // --- 3. * 函数检测 (后面必须紧跟 '(' ) ---
        // 匹配以 * 开头，后面跟着词，但 *之后* 直到行尾（或注释前）都没有 '('
        const funcMatch = lineWithoutComment.match(/^\*([^\s(]+)/); // 匹配 *word
        if (funcMatch) {
            // 检查从 *word 之后到行尾，是否缺少 '('
            const restOfLine = lineWithoutComment.substring(funcMatch[0].length);
            if (!restOfLine.trim().startsWith('(')) {
                const starPos = line.indexOf('*'); // 在原始行中找位置
                 diagnostics.push({
                    from: lineStartPos + starPos, 
                    to: lineStartPos + line.length, // 高亮整行或只高亮 *word
                    severity: 'error', 
                    message: `* 开头的字段 '${funcMatch[0]}' 后面必须紧跟 '('。`
                });
            }
        }

        // --- 4. ! 控制结构检测 (后面必须是 '(...){') ---
        // 匹配以 ! 开头，后面跟着词
        const ifMatch = lineWithoutComment.match(/^!([^\s({]+)/); // 匹配 !word
        if (ifMatch) {
            // 检查从 !word 之后到行尾，是否匹配 '(...){' 结构 (允许空格)
            // 正则：匹配任意字符的 ()，然后是 {，直到行尾
            const structureRegex = /^\s*\([^\)]*\)\s*\{.*$/; 
            const restOfLine = lineWithoutComment.substring(ifMatch[0].length);
            
            if (!restOfLine.match(structureRegex)) {
                 const bangPos = line.indexOf('!'); // 在原始行中找位置
                 diagnostics.push({
                    from: lineStartPos + bangPos, 
                    to: lineStartPos + line.length,
                    severity: 'error', 
                    message: `! 开头的字段 '${ifMatch[0]}' 后面必须是 '(...){' 结构。`
                });
            }
        }
        
        // --- 保留你原来的 Linter 逻辑 (可选) ---
        let adrMatch = line.match(/@adr\s+([a-zA-Z0-9_]+)/);
        if (adrMatch && adrMatch[1].length < 2) {
             diagnostics.push({
                from: lineStartPos + adrMatch.index, 
                to: lineStartPos + adrMatch.index + adrMatch[0].length,
                severity: 'info', 
                message: '@adr 标签名建议至少2字符。'
            });
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
        debouncedBuildCompletionWords(currentCode, window.libraryFiles);
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
buildCompletionWords(editorView.state.doc.toString(), window.libraryFiles);

// ----------------------------------------------------------------------
// 步骤 6: 连接所有 UI 按钮和事件
// ----------------------------------------------------------------------

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
    const blocks = window.bytecodeBlocks;
    const selector = document.getElementById('bytecode-selector');
    const contentDisplay = document.getElementById('bytecode-content-display'); // 这个保持不变
    
    if (!selector) { console.warn("Bytecode selector not found."); return; }
    
    selector.innerHTML = ''; 
    if (Object.keys(blocks).length === 0) { /* ... 处理空列表 ... */ return; }
    
    for (const blockName in blocks) { /* ... 填充下拉框 ... */ }
    
    if (selector.options.length > 0) { 
        selector.selectedIndex = 0; 
        selector.dispatchEvent(new Event('change')); 
    } else { 
        if (contentDisplay) contentDisplay.textContent = '编译结果为空。'; 
    }
}

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
if (compileBtn) {
    compileBtn.onclick = async () => {
        // ... (获取 sourceCode, addr1, addr2 不变) ...
        const sourceCode = editorView.state.doc.toString();
        const addr1Input = document.getElementById('addr1'); const addr2Input = document.getElementById('addr2');
        const addr1 = addr1Input ? addr1Input.value : 'D700'; // 默认地址
        const addr2 = addr2Input ? addr2Input.value : 'E9E0'; // 默认地址

        // 更新 UI 提示
        if(bytecodeSelector) bytecodeSelector.innerHTML = '<option>编译中...</option>';
        if(bytecodeContentDisplay) bytecodeContentDisplay.textContent = '编译中...';
        if(tabBytecodeBtn) tabBytecodeBtn.click(); 

        buildCompletionWords(sourceCode, window.libraryFiles); 
        
        try {
            if (typeof window.pyProcessCode === 'function') {
                const resultProxy = await window.pyProcessCode(sourceCode, window.libraryFiles); // 假设 Python 只返回字典
                
                // 【修复】确保 toJs 正确转换 Map/Dict
                const resultObject = resultProxy.toJs({ dict_converter: Object.fromEntries }); 
                console.log("DEBUG: Python 返回的字节码字典:", resultObject); // 调试输出

                window.bytecodeBlocks = resultObject; 
                updateBytecodeViewer(); // 更新下拉框，这将触发 onchange 来显示内容

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
            downloadFile(`${blockName}.bin`, byteArray, 'application/octet-stream');
        } else if (format && format.toLowerCase() === 'txt') {
            // 导出文本
            downloadFile(`${blockName}.txt`, hexString, 'text/plain');
        } else if (format !== null) {
            alert('无效的格式，请输入 "txt" 或 "bin"。');
        }
        // 如果用户取消 prompt，则什么都不做
    }; 
}

// 【新增】面板拖动逻辑
const resizer = document.getElementById('dragMe');
const leftSide = document.getElementById('editor-container');
const rightSide = document.querySelector('.output-container'); // 使用类选择器更健壮

let x = 0;
let leftWidth = 0;

const mouseDownHandler = function (e) {
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
    const newLeftWidth = ((leftWidth + dx) * 100) / resizer.parentNode.getBoundingClientRect().width;
    
    // 设置左右面板的 flex-basis
    // 添加边界检查，防止面板过小或过大 (例如，最小 10%)
    const minWidthPercent = 10;
    const maxWidthPercent = 90;
    
    if (newLeftWidth > minWidthPercent && newLeftWidth < maxWidthPercent) {
        leftSide.style.flexBasis = `${newLeftWidth}%`;
        // 右侧宽度自动调整 (flex: 1) 或手动设置
        rightSide.style.flexBasis = `${100 - newLeftWidth}%`; 
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
if (resizer) {
    resizer.addEventListener('mousedown', mouseDownHandler);
}

console.log("DEBUG: main.js 最终版本执行完毕。");