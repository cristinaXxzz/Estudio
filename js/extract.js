/**
 * 文件解析 + 知识点提取。
 *   - txt / md：直接读文本
 *   - pdf：用 pdf.js（CDN 按需加载）
 *   - docx：用 mammoth（CDN 按需加载）
 * 提取：把文本切片后丢给 AI 拆成知识点，两个 API 并行消化（见 api.js runTasksDualApi）。
 */

import { chatOnce, extractJson, runTasksDualApi } from './api.js';

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const MAMMOTH_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';

let _pdfjs = null;
async function loadPdfjs() {
    if (_pdfjs) return _pdfjs;
    const mod = await import(PDFJS_URL);
    mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    _pdfjs = mod;
    return mod;
}

let _mammothPromise = null;
function loadMammoth() {
    if (window.mammoth) return Promise.resolve(window.mammoth);
    if (!_mammothPromise) {
        _mammothPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = MAMMOTH_URL;
            s.onload = () => resolve(window.mammoth);
            s.onerror = () => reject(new Error('mammoth 加载失败（需要联网）'));
            document.head.appendChild(s);
        });
    }
    return _mammothPromise;
}

/** 把 File 对象读成纯文本 */
export async function fileToText(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.pdf')) {
        const pdfjs = await loadPdfjs();
        const buf = await file.arrayBuffer();
        const doc = await pdfjs.getDocument({ data: buf }).promise;
        const parts = [];
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const content = await page.getTextContent();
            parts.push(content.items.map(it => it.str).join(' '));
        }
        const text = parts.join('\n\n');
        if (!text.trim()) throw new Error('这个 PDF 里没有可提取的文字（可能是扫描件/图片版）');
        return text;
    }
    if (name.endsWith('.docx')) {
        const mammoth = await loadMammoth();
        const buf = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer: buf });
        if (!result.value.trim()) throw new Error('这个 Word 文件里没读到文字');
        return result.value;
    }
    if (name.endsWith('.doc')) {
        throw new Error('老版 .doc 格式不支持，请用 Word 另存为 .docx 再传');
    }
    // txt / md / 其他文本类
    return await file.text();
}

/** 文本切片：每片约 maxLen 字符，尽量在段落边界切 */
export function chunkText(text, maxLen = 4000) {
    const clean = text.replace(/\r\n/g, '\n').trim();
    if (clean.length <= maxLen) return [clean];
    const chunks = [];
    let rest = clean;
    while (rest.length > maxLen) {
        let cut = rest.lastIndexOf('\n\n', maxLen);
        if (cut < maxLen * 0.4) cut = rest.lastIndexOf('\n', maxLen);
        if (cut < maxLen * 0.4) cut = rest.lastIndexOf('。', maxLen);
        if (cut < maxLen * 0.4) cut = maxLen;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
}

const EXTRACT_PROMPT = `你是学习材料整理助手。把下面的学习材料拆成一条条"知识点"。

要求：
- 每条知识点是一个可以独立提问的概念、定义、公式、方法或事实
- title：知识点的简短名字（10字以内最好）
- content：知识点的完整内容，要自洽（脱离原文也能看懂），保留材料原语言的术语
- 跳过目录、页眉页脚、与学习无关的内容
- 不要太碎：一页材料一般拆 3~10 条；也不要太粗
- 只输出 JSON 数组，不要其他文字：
[{"title":"...","content":"..."}]

材料：
`;

/**
 * 把整篇文本拆成知识点。
 * 返回 { points: [{title, content}], failedChunks }
 */
export async function extractPoints(api1, api2, text, onProgress) {
    const chunks = chunkText(text);
    const tasks = chunks.map(chunk => async (cfg) => {
        const reply = await chatOnce(cfg, [
            { role: 'user', content: EXTRACT_PROMPT + chunk },
        ], { temperature: 0.3, maxTokens: 4000, timeoutMs: 120000 });
        const parsed = extractJson(reply);
        if (!Array.isArray(parsed)) throw new Error('AI 没有返回有效的知识点列表');
        return parsed.filter(p => p && p.content);
    });
    const { results, errors } = await runTasksDualApi(api1, api2, tasks, onProgress);
    const points = [];
    for (const arr of results) {
        if (Array.isArray(arr)) points.push(...arr);
    }
    return { points, failedChunks: errors.length };
}
