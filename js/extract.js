/**
 * 文件解析 + 知识点提取。
 *   - txt / md / csv：直接读文本
 *   - pdf：pdf.js（CDN 按需加载）
 *   - docx：mammoth（CDN 按需加载）
 *   - pptx：JSZip 解包后抽幻灯片文字（CDN 按需加载）
 *   - xlsx：SheetJS 转成 CSV 文本（CDN 按需加载）
 *   - html：浏览器自带的解析器抽正文
 * （格式覆盖面向 microsoft/markitdown 看齐，但全部在浏览器里完成）
 * 提取：把文本切片后丢给 AI 拆成知识点，两个 API 并行消化（见 api.js runTasksDualApi）。
 */

import { chatOnce, extractJson, runTasksDualApi } from './api.js';

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const MAMMOTH_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';
const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
const SHEETJS_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

/** 按需加载一个挂到 window 上的 CDN 脚本 */
const _scriptPromises = {};
function loadScript(url, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (!_scriptPromises[url]) {
        _scriptPromises[url] = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = () => resolve(window[globalName]);
            s.onerror = () => reject(new Error(`${globalName} 加载失败（需要联网）`));
            document.head.appendChild(s);
        });
    }
    return _scriptPromises[url];
}

let _pdfjs = null;
async function loadPdfjs() {
    if (_pdfjs) return _pdfjs;
    const mod = await import(PDFJS_URL);
    mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    _pdfjs = mod;
    return mod;
}

/** pptx：解包 zip，按页码顺序抽 slide XML 里的 <a:t> 文字 */
async function pptxToText(file) {
    const JSZip = await loadScript(JSZIP_URL, 'JSZip');
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const slideNames = Object.keys(zip.files)
        .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
    if (!slideNames.length) throw new Error('这个 PPT 里没找到幻灯片');
    const parts = [];
    for (let i = 0; i < slideNames.length; i++) {
        const xml = await zip.file(slideNames[i]).async('string');
        const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
            .map(m => m[1]
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
        if (texts.join('').trim()) {
            parts.push(`【第${i + 1}页】\n` + texts.join(' '));
        }
    }
    const text = parts.join('\n\n');
    if (!text.trim()) throw new Error('这个 PPT 里没有可提取的文字（可能全是图片）');
    return text;
}

/** xlsx：每个工作表转 CSV 拼起来 */
async function xlsxToText(file) {
    const XLSX = await loadScript(SHEETJS_URL, 'XLSX');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const parts = [];
    for (const name of wb.SheetNames) {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]).trim();
        if (csv) parts.push(`【工作表：${name}】\n${csv}`);
    }
    const text = parts.join('\n\n');
    if (!text.trim()) throw new Error('这个表格里没读到内容');
    return text;
}

/** html：浏览器自带解析器，抽正文文字 */
async function htmlToText(file) {
    const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
    for (const tag of doc.querySelectorAll('script, style, noscript')) tag.remove();
    const text = (doc.body ? doc.body.innerText : doc.documentElement.innerText) || '';
    if (!text.trim()) throw new Error('这个网页文件里没读到正文');
    return text;
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
        const mammoth = await loadScript(MAMMOTH_URL, 'mammoth');
        const buf = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer: buf });
        if (!result.value.trim()) throw new Error('这个 Word 文件里没读到文字');
        return result.value;
    }
    if (name.endsWith('.pptx')) return pptxToText(file);
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) return xlsxToText(file);
    if (name.endsWith('.html') || name.endsWith('.htm')) return htmlToText(file);
    if (name.endsWith('.doc') || name.endsWith('.ppt')) {
        throw new Error('老版 .doc/.ppt 格式不支持，请用 Office 另存为 .docx/.pptx 再传');
    }
    // txt / md / csv / 其他文本类
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
