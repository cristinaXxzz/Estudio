/**
 * Notion 笔记 —— 连接逻辑复用 SULLYOS：
 * Notion 官方接口不允许网页直连（CORS），所以走 SULLYOS 已部署的
 * Cloudflare Worker 的 /notion/* 透传（Token 放在 X-Notion-API-Key 头里）。
 *
 * 用到的端点（与 worker/index.js 对应）：
 *   POST  /notion/pages                    创建页面
 *   PATCH /notion/blocks/:id/children      往页面追加内容
 *   GET   /notion/blocks/:id               读取页面内容（测试连接用）
 */

const WORKER = 'https://sullyos-worker.cristinazhou0122.workers.dev';

export function isNotionConfigured(cfg) {
    return !!(cfg && cfg.token && cfg.parent);
}

/** 从 Notion 页面链接（或裸 ID）里抠出 32 位页面 ID，转成带连字符的标准格式 */
export function parsePageId(input) {
    const m = String(input || '').replace(/-/g, '').match(/[0-9a-f]{32}/i);
    if (!m) return null;
    const id = m[0].toLowerCase();
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

async function notionFetch(cfg, path, method, body) {
    const res = await fetch(`${WORKER}/notion${path}`, {
        method,
        headers: {
            'X-Notion-API-Key': cfg.token,
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { }
    if (!res.ok) {
        const msg = (data && data.message) || text.slice(0, 200) || `HTTP ${res.status}`;
        throw new Error(`Notion ${res.status}: ${msg}`);
    }
    return data;
}

/**
 * 简易 markdown → Notion 块。支持：# 标题、- / * 列表、1. 有序列表、
 * > 引用、--- 分割线、普通段落。Notion 单次最多 100 块。
 */
export function mdToBlocks(markdown) {
    const blocks = [];
    const rt = (text) => [{ type: 'text', text: { content: text.slice(0, 1900) } }];
    for (const rawLine of String(markdown || '').split('\n')) {
        if (blocks.length >= 95) break;
        const line = rawLine.trimEnd();
        const t = line.trim();
        if (!t) continue;
        let m;
        if ((m = t.match(/^(#{1,3})\s+(.*)/))) {
            const level = m[1].length;
            const type = level === 1 ? 'heading_1' : level === 2 ? 'heading_2' : 'heading_3';
            blocks.push({ object: 'block', type, [type]: { rich_text: rt(m[2]) } });
        } else if ((m = t.match(/^[-*•]\s+(.*)/))) {
            blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(m[1]) } });
        } else if ((m = t.match(/^\d+[.、]\s+(.*)/))) {
            blocks.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: rt(m[1]) } });
        } else if ((m = t.match(/^>\s?(.*)/))) {
            blocks.push({ object: 'block', type: 'quote', quote: { rich_text: rt(m[1]) } });
        } else if (/^(-{3,}|\*{3,})$/.test(t)) {
            blocks.push({ object: 'block', type: 'divider', divider: {} });
        } else {
            blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(t) } });
        }
    }
    return blocks;
}

/** 在父页面下创建一个新笔记页，返回页面链接 */
export async function createNotePage(cfg, title, markdown, emoji = '📝') {
    const parentId = parsePageId(cfg.parent);
    if (!parentId) throw new Error('Notion 父页面链接不对（里面找不到页面 ID）');
    const data = await notionFetch(cfg, '/pages', 'POST', {
        parent: { page_id: parentId },
        icon: { type: 'emoji', emoji },
        properties: {
            title: { title: [{ type: 'text', text: { content: String(title).slice(0, 200) } }] },
        },
        children: mdToBlocks(markdown),
    });
    return data && data.url;
}

/** 往已有页面末尾追加内容 */
export async function appendToPage(cfg, pageId, markdown) {
    const id = parsePageId(pageId);
    if (!id) throw new Error('页面 ID 不对');
    await notionFetch(cfg, `/blocks/${id}/children`, 'PATCH', { children: mdToBlocks(markdown) });
}

/** 测试连接：试着读父页面的内容 */
export async function testNotion(cfg) {
    const parentId = parsePageId(cfg.parent);
    if (!parentId) throw new Error('父页面链接里找不到页面 ID，把 Notion 页面的完整链接粘进来');
    await notionFetch(cfg, `/blocks/${parentId}`, 'GET');
    return true;
}

// ---------- 聊天中的"写笔记"指令 ----------
// AI 在回复里输出 <notion title="...">markdown</notion> 即表示要写一篇笔记。

const NOTION_DIRECTIVE_RE = /<notion\s+title="([^"]{1,200})"\s*>([\s\S]*?)<\/notion>/g;

/** 从 AI 回复里摘出写笔记指令，返回 { clean: 去掉指令后的正文, jobs: [{title, md}] } */
export function extractNotionDirectives(text) {
    const jobs = [];
    const clean = String(text || '').replace(NOTION_DIRECTIVE_RE, (_, title, md) => {
        jobs.push({ title: title.trim(), md: md.trim() });
        return '';
    }).trim();
    return { clean, jobs };
}
