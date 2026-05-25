// src/main.js

import { EditorView, lineNumbers, highlightActiveLineGutter, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { StreamLanguage, LanguageSupport, bracketMatching, indentOnInput } from '@codemirror/language';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { linter, lintGutter } from '@codemirror/lint';
import { defaultKeymap } from '@codemirror/commands';
import { history, historyKeymap } from '@codemirror/history';
import { oneDark } from '@codemirror/theme-one-dark';

// ============================ 常量 ============================
const STORAGE_KEY = 'ropIdeSourceCode';
const LIBRARY_BASE_PATH = '/vendor/libraries/';
const INITIAL_LIBRARIES = ['basic-991cnx-verc.ggt', 'basic-common.macro'];             // 与 sw.js 同步
const VERSION_CHECK_URL = '/version';

// ============================ 工具函数 ============================
function debounce(func, delay) {
    let timeoutId;
    return function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
    };
}

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
    return patternIndex === patternLower.length ? score - (word.length - pattern.length) : null;
}

function compareVersions(v1, v2) {
    if (!v1 || !v2) return 0;
    const v1Parts = v1.replace(/^v/i, '').split('.').map(Number);
    const v2Parts = v2.replace(/^v/i, '').split('.').map(Number);
    for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
        const p1 = v1Parts[i] || 0;
        const p2 = v2Parts[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }
    return 0;
}

function downloadFile(filename, content, type = 'text/plain') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function hexStringToUint8Array(hexString) {
    if (hexString.length % 2 !== 0) hexString = hexString.slice(0, -1);
    const byteArray = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < byteArray.length; i++) {
        byteArray[i] = parseInt(hexString.substring(i * 2, i * 2 + 2), 16);
    }
    return byteArray;
}

function formatHexView(hexString, addr1Hex, addr2Hex, bytesPerLine = 16) {
    // 如果字符串明显不是有效的十六进制，则原样返回（避免格式化错误信息）
    if (!hexString || !/^[0-9a-fA-FxX]*$/.test(hexString.replace(/\s/g, ''))) {
        return hexString;
    }
    const addr1Start = parseInt(addr1Hex, 16);
    const addr2Start = parseInt(addr2Hex, 16);
    if (isNaN(addr1Start) || isNaN(addr2Start)) return hexString;

    const cleanedHex = hexString.replace(/\s/g, '');
    const bytes = [];
    for (let i = 0; i < cleanedHex.length; i += 2) {
        bytes.push(cleanedHex.substring(i, i + 2));
    }

    let output = '';
    for (let i = 0; i < bytes.length; i += bytesPerLine) {
        const addr1 = (addr1Start + i).toString(16).toUpperCase().padStart(4, '0');
        const addr2 = (addr2Start + i).toString(16).toUpperCase().padStart(4, '0');
        const lineBytes = bytes.slice(i, i + bytesPerLine);
        output += `${addr1} ${addr2}  ${lineBytes.join(' ').padEnd(bytesPerLine * 3 - 1)}\n`;
    }
    return output;
}

function extractImports(sourceCode) {
    const lines = sourceCode.split('\n');
    const importedFiles = [];
    const importRegex = /^\s*import\s+([\w\d._-]+)\s*/i;
    const blockStartRegex = /^\s*@block\./i;
    for (const line of lines) {
        if (blockStartRegex.test(line.trim())) break;
        const match = line.trim().match(importRegex);
        if (match && match[1]) importedFiles.push(match[1].trim());
    }
    return importedFiles;
}

// ============================ 主应用类 ============================
class RopIDE {
    constructor() {
        // 状态
        this.libraryFiles = {};
        this.completionWords = {};
        this.bytecodeBlocks = {};
        this.lastCompileError = null;   // 记录上次编译错误信息
        this.editorView = null;

        // DOM 引用（一次性获取）
        this.dom = {
            projectName: document.getElementById('project-name'),
            importBtn: document.getElementById('import-btn'),
            fileImporter: document.getElementById('file-importer'),
            compileBtn: document.getElementById('compile-btn'),
            exportSourceBtn: document.getElementById('export-source-btn'),
            exportBytecodeBtn: document.getElementById('export-bytecode-btn'),
            copyBytecodeBtn: document.getElementById('copy-bytecode-btn'),   // 新增
            tabBytecodeBtn: document.getElementById('tab-bytecode-btn'),
            tabLibraryBtn: document.getElementById('tab-library-btn'),
            bytecodeView: document.getElementById('bytecode-view'),
            libraryViewer: document.getElementById('library-viewer'),
            bytecodeSelector: document.getElementById('bytecode-selector'),
            bytecodeContentDisplay: document.getElementById('bytecode-content-display'),
            librarySelector: document.getElementById('library-selector'),
            libraryContentDisplay: document.getElementById('library-content-display'),
            addr1Input: document.getElementById('addr1'),
            addr2Input: document.getElementById('addr2'),
            resizer: document.getElementById('dragMe'),
            leftSide: document.getElementById('editor-container'),
            rightSide: document.querySelector('.output-container'),
            updateStatus: document.getElementById('update-status'),
            forceUpdateBtn: document.getElementById('force-update-btn'),
            tutorialModal: document.getElementById('tutorial-modal'),
            tutorialContent: document.getElementById('tutorial-content'),
            closeModalBtn: document.getElementById('close-modal-btn'),
            showTutorialBtn: document.getElementById('show-tutorial-btn'),
            loadingStatus: document.getElementById('loading-status'),
        };

        this.initEditor();
        this.initEventListeners();
        this.initPyodideReadyCheck();
        this.loadInitialLibraries();
        this.checkAppVersion();
    }

    // --------------- 编辑器初始化 ---------------
    initEditor() {
        // 语法高亮
        const customHighlight = StreamLanguage.define({
            token: (stream) => {
                if (stream.match(/^\s*import\s+([\w\d._-]+)\s*/i) || stream.match(/import/) || stream.match(/def/)) return 'keyword';
                if (stream.match(/\$[^ \t\r\n(]+/)) return 'keyword';
                if (stream.match(/\*[^ \t\r\n(]+/)) return 'operatorKeyword';
                if (stream.match(/![^ \t\r\n(]+/)) return 'color';
                if (stream.match(/#[a-zA-Z0-9_]+/)) return 'string';
                if (stream.match(/##[a-zA-Z0-9_]+/)) return 'string';
                if (stream.match(/^([0-9a-fA-FXx]{2})+/)) return 'string';
                if (stream.match(/^@[a-zA-Z0-9_=.]+/)) return 'variableName';
                if (stream.match(/^\/\/.*/)) return 'comment';
                if (stream.eatSpace()) return null;
                stream.next();
                return null;
            }
        });

        // 自动完成
        const myCompletions = (context) => {
            const word = context.matchBefore(/[$!@*#a-zA-Z0-9_][^ \t\n;]*/);
            const typedText = word ? word.text : '';
            const allWords = this.completionWords || {};

            let options = [];
            for (const key in allWords) {
                const score = fuzzyMatch(typedText, key);
                if (score !== null) {
                    const item = allWords[key];
                    let detail = item.detail || '';
                    if (item.rt) detail = `[RT] ${detail}`;
                    options.push({ label: item.label, type: item.type, detail, score });
                }
            }
            if (context.explicit && typedText.length === 0 && options.length === 0) {
                for (const key in allWords) {
                    const item = allWords[key];
                    let detail = item.detail || '';
                    if (item.rt) detail = `[RT] ${detail}`;
                    options.push({ label: item.label, type: item.type, detail, score: 0 });
                }
            }
            if (!options.length) return null;
            options.sort((a, b) => b.score - a.score);
            return { from: word ? word.from : context.pos, options };
        };

        // Linter
        const myLinter = linter(view => {
            const diagnostics = [];
            const code = view.state.doc.toString();
            const lines = code.split('\n');
            let blockSeen = false;
            const blockRegex = /@block\./i;
            const hexRegex = /(?<![a-zA-Z_$*!#@.=])\b[0-9a-fA-FXx]+\b/g;

            lines.forEach((line, i) => {
                const lineStartPos = view.state.doc.line(i + 1).from;
                const commentIndex = line.indexOf(';');
                const nonComment = commentIndex === -1 ? line : line.substring(0, commentIndex);
                const trimmed = nonComment.trim();
                if (!trimmed) return;

                if (blockRegex.test(trimmed)) blockSeen = true;

                if (blockSeen) {
                    let hexMatch;
                    while ((hexMatch = hexRegex.exec(trimmed)) !== null) {
                        const hexStr = hexMatch[0];
                        if (hexStr.length % 2 !== 0) {
                            const col = line.indexOf(hexStr, hexMatch.index);
                            diagnostics.push({
                                from: lineStartPos + col,
                                to: lineStartPos + col + hexStr.length,
                                severity: 'error',
                                message: `十六进制字符串长度 (${hexStr.length}) 必须是偶数`
                            });
                        }
                    }
                }

                const funcMatch = trimmed.match(/^\*([^\s(]+)/);
                if (funcMatch && !trimmed.substring(funcMatch[0].length).trim().startsWith('(')) {
                    const starPos = line.indexOf('*');
                    diagnostics.push({
                        from: lineStartPos + starPos,
                        to: lineStartPos + line.length,
                        severity: 'error',
                        message: `* 开头的字段 '${funcMatch[0]}' 后面必须紧跟 '('。`
                    });
                }

                const ifMatch = trimmed.match(/^!([^\s({]+)/);
                if (ifMatch) {
                    const rest = trimmed.substring(ifMatch[0].length);
                    if (!rest.match(/^\s*\([^\)]*\)\s*\{/)) {
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

        // 组装扩展
        const extensions = [
            lineNumbers(),
            highlightActiveLineGutter(),
            history(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets({ map: '()[]{}<>' }),
            oneDark,
            keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap]),
            new LanguageSupport(customHighlight),
            autocompletion({ override: [myCompletions] }),
            myLinter,
            lintGutter(),
            EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                    const code = update.state.doc.toString();
                    localStorage.setItem(STORAGE_KEY, code);
                    const imported = extractImports(code);
                    this.debouncedBuildCompletionWords(code, imported);
                }
            })
        ];

        const savedCode = localStorage.getItem(STORAGE_KEY);
        const initialDoc = savedCode || `//欢迎使用ROP-IDE\n//别忘了先用import导入库文件\n`;

        this.editorView = new EditorView({
            state: EditorState.create({ doc: initialDoc, extensions }),
            parent: this.dom.leftSide
        });

        // 初始构建词库
        const initCode = this.editorView.state.doc.toString();
        const initImports = extractImports(initCode);
        this.buildCompletionWords(initCode, initImports);
    }

    // --------------- 词库构建 ---------------
    buildCompletionWords(sourceCode, importedFileNames) {
        const newWords = {};

        // 静态词
        const staticWords = {
            '@x=': { label: '@x=', detail: '定义x占位符', type: 'label' },
            '@adr.': { label: '@adr.', detail: '定义地址标签', type: 'label' },
            '@block.': { label: '@block.', detail: '开始一个代码块', type: 'label' },
            '@blockend': { label: '@blockend', detail: '结束代码块', type: 'label' },
            '@end': { label: '@end', detail: '结束代码块，等效于@end', type: 'label' },
            '@rstoffst': { label: '@rstoffst', detail: '从此处开始地址从0000重新计算', type: 'label' },
            '@offset=': { label: '@offset=', detail: '定义地址偏移量', type: 'label' },
            '@overwrite': { label: '@overwrite', detail: '覆写', type: 'label' }
        };
        Object.assign(newWords, staticWords);

        const librarySources = importedFileNames
            .filter(name => this.libraryFiles[name])
            .map(name => ({ name, content: this.libraryFiles[name], isLibrary: true }));

        const sources = [
            { name: "Current Code", content: sourceCode || "", isLibrary: false },
            ...librarySources
        ];

        const strictRegex = /^([$!*])([^\s\\({;]+)(.*?)(?:\s*;(.*))?$/m;
        const defRegex = /^\s*(def)\s+([$!*@])([^\s\\({;]+)(.*?)(?:\s*;(.*))?$/i;
        const adrLabelRegex = /^\s*@adr\.([\w?]+)(.*?)(?:\s*;(.*))?$/i;

        sources.forEach(source => {
            const lines = source.content.split('\n');
            let inCodeBlock = false;

            lines.forEach(line => {
                const trimmed = line.trim();
                if (!trimmed) return;

                if (source.isLibrary) {
                    const match = line.match(strictRegex);
                    if (match) {
                        const prefix = match[1];
                        const word = match[2];
                        const comment = (match[4] || '').trim();
                        const key = prefix + word;
                        if (!newWords[key]) {
                            newWords[key] = {
                                label: key,
                                detail: comment,
                                type: this.assignCompletionType(prefix),
                                rt: word.endsWith('?')
                            };
                        }
                    }
                } else {
                    if (/^@block/i.test(trimmed)) { inCodeBlock = true; return; }
                    if (!inCodeBlock) {
                        const defMatch = line.match(defRegex);
                        if (defMatch) {
                            const defPrefix = defMatch[2] || '';
                            const word = defMatch[3];
                            const comment = (defMatch[5] || '').trim();
                            const key = defPrefix + word;
                            if (!newWords[key]) {
                                newWords[key] = {
                                    label: key,
                                    detail: comment,
                                    type: defPrefix ? this.assignCompletionType(defPrefix) : 'function',
                                    rt: word.endsWith('?')
                                };
                            }
                        }
                    }
                    // 地址标签
                    const adrMatch = line.match(adrLabelRegex);
                    if (adrMatch) {
                        const labelName = adrMatch[1];
                        const comment = (adrMatch[3] || '').trim();
                        const key1 = '#' + labelName;
                        const key2 = '##' + labelName;
                        if (!newWords[key1]) newWords[key1] = { label: key1, detail: comment, type: 'label' };
                        if (!newWords[key2]) newWords[key2] = { label: key2, detail: comment, type: 'label' };
                    }
                }
            });
        });

        if (!newWords['import']) newWords['import'] = { label: 'import', detail: '导入库文件', type: 'keyword' };
        if (!newWords['def']) newWords['def'] = { label: 'def', detail: '定义新的gadgets/函数', type: 'keyword' };

        this.completionWords = newWords;
    }

    debouncedBuildCompletionWords = debounce((code, imports) => {
        this.buildCompletionWords(code, imports);
    }, 300);

    assignCompletionType(prefix) {
        const map = { '$': 'class', '*': 'function', '!': 'method', '@': 'label', 'def': 'keyword', 'import': 'keyword' };
        return map[prefix] || 'text';
    }

    // --------------- 库文件加载 ---------------
    async loadInitialLibraries() {
        const fetchPromises = INITIAL_LIBRARIES.map(async (fileName) => {
            try {
                const response = await fetch(LIBRARY_BASE_PATH + fileName);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const content = await response.text();
                this.libraryFiles[fileName] = content;
                console.log(`预加载库文件: ${fileName}`);
            } catch (err) {
                console.error(`加载库文件失败 ${fileName}:`, err);
            }
        });
        await Promise.all(fetchPromises);
        this.updateLibraryViewer();

        // 刷新词库
        const code = this.editorView.state.doc.toString();
        const imports = extractImports(code);
        this.buildCompletionWords(code, imports);
    }

    // --------------- 编译 ---------------
    async compile() {
        const sourceCode = this.editorView.state.doc.toString();
        this.lastCompileError = null;  // 清除之前的错误
        this.dom.bytecodeSelector.innerHTML = '<option>编译中...</option>';
        this.dom.bytecodeContentDisplay.textContent = '编译中...';
        this.dom.tabBytecodeBtn.click();

        this.buildCompletionWords(sourceCode, extractImports(sourceCode));

        try {
            if (typeof window.pyProcessCode !== 'function') {
                throw new Error("Python 编译器未就绪");
            }
            const resultProxy = await window.pyProcessCode(sourceCode, this.libraryFiles);
            const resultObject = resultProxy.toJs({ dict_converter: Object.fromEntries });
            this.bytecodeBlocks = resultObject;
            this.updateBytecodeViewer();
        } catch (error) {
            console.error("编译失败:", error);
            this.lastCompileError = `编译失败: ${error.toString()}`;
            this.bytecodeBlocks = {};
            // 手动设置错误状态，不调用 updateBytecodeViewer 以免触发格式化
            this.dom.bytecodeSelector.innerHTML = '<option value="">-- 编译失败 --</option>';
            this.dom.bytecodeContentDisplay.textContent = this.lastCompileError;
        }
    }

    // --------------- 视图更新 ---------------
    updateLibraryViewer() {
        const { librarySelector, libraryContentDisplay } = this.dom;
        librarySelector.innerHTML = '';
        const files = this.libraryFiles;
        if (Object.keys(files).length === 0) {
            librarySelector.appendChild(new Option('-- 请先导入库文件 --', ''));
            libraryContentDisplay.textContent = '请导入库文件以在此处查看内容。';
            return;
        }
        for (const name in files) {
            librarySelector.appendChild(new Option(name, name));
        }
        librarySelector.selectedIndex = 0;
        librarySelector.dispatchEvent(new Event('change'));
    }

    updateBytecodeViewer() {
        const { bytecodeSelector, bytecodeContentDisplay } = this.dom;
        bytecodeSelector.innerHTML = '';
        const blocks = this.bytecodeBlocks;
        if (Object.keys(blocks).length === 0) {
            bytecodeSelector.appendChild(new Option('-- 编译结果为空 --', ''));
            bytecodeContentDisplay.textContent = '编译结果为空。';
            return;
        }
        for (const name in blocks) {
            bytecodeSelector.appendChild(new Option(name, name));
        }
        bytecodeSelector.selectedIndex = 0;
        this.showSelectedBytecode();
    }

    showSelectedBytecode() {
        const { bytecodeSelector, bytecodeContentDisplay, addr1Input, addr2Input } = this.dom;
        const blockName = bytecodeSelector.value;
        if (blockName && this.bytecodeBlocks[blockName]) {
            const raw = this.bytecodeBlocks[blockName];
            bytecodeContentDisplay.textContent = formatHexView(raw, addr1Input.value || 'D700', addr2Input.value || 'E9E0');
        } else if (this.lastCompileError) {
            // 如果有编译错误信息，优先显示
            bytecodeContentDisplay.textContent = this.lastCompileError;
        } else {
            bytecodeContentDisplay.textContent = '请选择一个代码块查看字节码。';
        }
    }

    // --------------- 复制字节码 ---------------
    copyBytecode() {
        const { bytecodeSelector } = this.dom;
        const blockName = bytecodeSelector.value;
        if (!blockName || !this.bytecodeBlocks[blockName]) {
            alert('没有可复制的字节码。请先编译并选择一个块。');
            return;
        }
        const rawHex = this.bytecodeBlocks[blockName]; // 原始十六进制字符串（未格式化）
        navigator.clipboard.writeText(rawHex).then(() => {
            alert('原始字节码已复制到剪贴板。');
        }).catch(err => {
            console.error('复制失败:', err);
            alert('复制失败，请手动选择并复制。');
        });
    }

    // --------------- 导入/导出 ---------------
    importFiles(files) {
        Array.from(files).forEach(file => {
            const reader = new FileReader();
            reader.onload = (e) => {
                this.libraryFiles[file.name] = e.target.result;
                this.buildCompletionWords(this.editorView.state.doc.toString(), extractImports(this.editorView.state.doc.toString()));
                this.updateLibraryViewer();
                this.dom.tabLibraryBtn.click();
            };
            reader.readAsText(file);
        });
    }

    exportSource() {
        const code = this.editorView.state.doc.toString();
        if (!code.trim()) return alert('编辑器中没有内容可以导出！');
        const name = (this.dom.projectName?.value || 'source') + '.rop';
        downloadFile(name, code);
    }

    exportBytecode() {
        const blockName = this.dom.bytecodeSelector.value;
        if (!blockName || !this.bytecodeBlocks[blockName]) {
            return alert('请先编译并选择一个要导出的字节码块！');
        }
        const hexString = this.bytecodeBlocks[blockName];
        const format = prompt(`导出字节码块 "${blockName}"\n请输入导出格式: 'txt' (十六进制文本) 或 'bin' (二进制文件)`, 'txt');
        if (!format) return;
        const projectName = this.dom.projectName?.value || 'ROP_Project';
        if (format.toLowerCase() === 'bin') {
            downloadFile(`${projectName}_${blockName}.bin`, hexStringToUint8Array(hexString), 'application/octet-stream');
        } else if (format.toLowerCase() === 'txt') {
            downloadFile(`${projectName}_${blockName}.txt`, hexString);
        } else {
            alert('无效的格式，请输入 "txt" 或 "bin"。');
        }
    }

    // --------------- 面板拖动 ---------------
    // 面板拖动 (支持鼠标 + 触摸)
initResizer() {
    const { resizer, leftSide, rightSide } = this.dom;
    if (!resizer || !leftSide || !rightSide) return;

    let startX = 0;
    let startLeftWidth = 0;

    const onStart = (e) => {
        // 阻止触摸时的默认行为（防止页面滚动）
        e.preventDefault();
        // 获取客户端X坐标，兼容鼠标和触摸
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        startX = clientX;
        startLeftWidth = leftSide.getBoundingClientRect().width;
        
        // 添加移动和结束事件
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
        
        resizer.classList.add('resizing');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    };

    const onMove = (e) => {
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const dx = clientX - startX;
        const containerWidth = resizer.parentNode.getBoundingClientRect().width;
        const newPercent = ((startLeftWidth + dx) / containerWidth) * 100;
        if (newPercent > 15 && newPercent < 85) {
            leftSide.style.flexBasis = `${newPercent}%`;
            rightSide.style.flexBasis = `${100 - newPercent}%`;
        }
    };

    const onEnd = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        resizer.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.removeProperty('user-select');
    };

    // 绑定鼠标和触摸开始事件
    resizer.addEventListener('mousedown', onStart);
    resizer.addEventListener('touchstart', onStart, { passive: false });
}

    // --------------- 版本检查与更新 ---------------
    async checkAppVersion() {
        const { updateStatus, forceUpdateBtn } = this.dom;
        if (!updateStatus) return;
        updateStatus.textContent = '正在检查更新……';
        forceUpdateBtn.disabled = true;

        try {
            const response = await fetch(VERSION_CHECK_URL, { cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const { version: serverVersion } = await response.json();
            const comp = compareVersions(serverVersion, LOCAL_VERSION);
            if (comp > 0) {
                updateStatus.textContent = `更新 ${LOCAL_VERSION}→${serverVersion}`;
                forceUpdateBtn.style.backgroundColor = '#36cc9fff';
            } else {
                updateStatus.textContent = `更新 (已是最新) ${serverVersion}`;
                forceUpdateBtn.style.backgroundColor = '#528bff';
            }
            forceUpdateBtn.disabled = false;
        } catch (err) {
            console.error('版本检查失败:', err);
            updateStatus.textContent = navigator.onLine ? '更新 (检查失败)' : `更新 (已离线) ${LOCAL_VERSION}`;
            forceUpdateBtn.disabled = true;
        }
    }

// main.js - RopIDE 类中

async forceUpdate() {
    const confirmed = confirm('发现新版本！此操作将清除所有应用缓存并强制刷新，确认？');
    if (!confirmed) return;

    // 第一步：通知可能存在的旧 SW 立即销毁
    if ('serviceWorker' in navigator) {
        try {
            // 向所有 SW 发送销毁指令（sw.js 已支持接收消息）
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (const reg of registrations) {
                if (reg.active) {
                    reg.active.postMessage({ type: 'DESTROY' });
                }
                // 直接注销
                await reg.unregister();
            }
            console.log('所有旧 Service Worker 已注销');
        } catch (e) {
            console.warn('注销 SW 时出错，继续更新流程', e);
        }
    }

    // 第二步：硬跳转，绕过浏览器缓存
    window.location.href = window.location.href.split('?')[0] + '?force_update=' + Date.now();
}

    // --------------- 教程模态 ---------------
    async showTutorial() {
        const modal = this.dom.tutorialModal;
        const content = this.dom.tutorialContent;
        try {
            const response = await fetch('/README.md');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            content.innerHTML = window.marked.parse(text);
            modal.style.display = 'flex';
        } catch (err) {
            content.innerHTML = `加载教程失败：${err.message}`;
            modal.style.display = 'flex';
        }
    }

    hideTutorial() {
        this.dom.tutorialModal.style.display = 'none';
    }

    // --------------- Pyodide 就绪检测 ---------------
    initPyodideReadyCheck() {
        const check = setInterval(() => {
            if (typeof window.pyProcessCode === 'function') {
                clearInterval(check);
                this.dom.compileBtn.textContent = '编译 (就绪)';
                this.dom.compileBtn.disabled = false;
                if (this.dom.loadingStatus) {
                    this.dom.loadingStatus.textContent = 'Python 环境就绪，编译器已加载。';
                    this.dom.loadingStatus.style.color = 'green';
                }
            } else {
                this.dom.compileBtn.textContent = '初始化中...';
                this.dom.compileBtn.disabled = true;
            }
        }, 500);
    }

    // --------------- 事件绑定 ---------------
    initEventListeners() {
        // 导入
        this.dom.importBtn.addEventListener('click', () => this.dom.fileImporter.click());
        this.dom.fileImporter.addEventListener('change', (e) => {
            this.importFiles(e.target.files);
            this.dom.fileImporter.value = '';
        });

        // 编译
        this.dom.compileBtn.addEventListener('click', () => this.compile());

        // 导出
        this.dom.exportSourceBtn.addEventListener('click', () => this.exportSource());
        this.dom.exportBytecodeBtn.addEventListener('click', () => this.exportBytecode());

        // 复制字节码（新增）
        this.dom.copyBytecodeBtn.addEventListener('click', () => this.copyBytecode());

        // 标签页
        this.dom.tabBytecodeBtn.addEventListener('click', () => {
            this.dom.bytecodeView.style.display = 'block';
            this.dom.libraryViewer.style.display = 'none';
            this.dom.tabBytecodeBtn.classList.add('active');
            this.dom.tabLibraryBtn.classList.remove('active');
        });
        this.dom.tabLibraryBtn.addEventListener('click', () => {
            this.dom.bytecodeView.style.display = 'none';
            this.dom.libraryViewer.style.display = 'block';
            this.dom.tabBytecodeBtn.classList.remove('active');
            this.dom.tabLibraryBtn.classList.add('active');
            this.updateLibraryViewer();
        });

        // 字节码选择
        this.dom.bytecodeSelector.addEventListener('change', () => this.showSelectedBytecode());

        // 库文件选择
        this.dom.librarySelector.addEventListener('change', () => {
            const file = this.dom.librarySelector.value;
            this.dom.libraryContentDisplay.textContent = file ? (this.libraryFiles[file] || '') : '';
        });

        // 面板拖动
        this.initResizer();

        // 版本更新
        this.dom.forceUpdateBtn.addEventListener('click', () => this.forceUpdate());

        // 教程
        this.dom.showTutorialBtn.addEventListener('click', () => this.showTutorial());
        this.dom.closeModalBtn.addEventListener('click', () => this.hideTutorial());
        this.dom.tutorialModal.addEventListener('click', (e) => {
            if (e.target === this.dom.tutorialModal) this.hideTutorial();
        });
    }
}

// ============================ 启动应用 ============================
document.addEventListener('DOMContentLoaded', () => {
    new RopIDE();
});