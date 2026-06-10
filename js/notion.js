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
const DEFAULT_CATEGORIES = ['个人', '学习内容', '复盘', '其他计划', '归档'];

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
        const err = new Error(`Notion ${res.status}: ${msg}`);
        err.status = res.status;
        err.data = data;
        throw err;
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

function notionOptions(cfg) {
    const categories = String(cfg.categories || '')
        .split(/[,，、\n]/)
        .map(s => s.trim())
        .filter(Boolean);
    const categoryProperty = String(cfg.categoryProperty || '').trim() || '分类';
    const recapCategory = String(cfg.recapCategory || '').trim() || '复盘';
    return {
        categoryProperty,
        categories: categories.length ? categories : DEFAULT_CATEGORIES,
        recapCategory,
    };
}

function closestCategory(cfg, category) {
    const opts = notionOptions(cfg).categories;
    const wanted = String(category || '').trim();
    if (!wanted) return opts.includes('学习内容') ? '学习内容' : opts[0];
    return opts.find(c => c === wanted) || opts.find(c => wanted.includes(c) || c.includes(wanted)) || wanted;
}

function pickProp(properties, preferred, aliases, type) {
    const names = [preferred, ...aliases].filter(Boolean);
    for (const name of names) {
        if (properties[name] && (!type || properties[name].type === type)) return name;
    }
    return Object.entries(properties).find(([, prop]) => !type || prop.type === type)?.[0] || null;
}

function pickCategoryProp(properties, preferred) {
    const names = [preferred, '分类', 'Category', '类别'].filter(Boolean);
    for (const name of names) {
        const prop = properties[name];
        if (prop && ['select', 'multi_select'].includes(prop.type)) return name;
    }
    return null;
}

async function findChildDatabase(cfg, pageId) {
    try {
        const children = await notionFetch(cfg, `/blocks/${pageId}/children?page_size=100`, 'GET');
        const blocks = (children && children.results || []).filter(b => b.type === 'child_database');
        if (!blocks.length) return null;
        const preferred = blocks.find(b => /笔记|数据库|note|database/i.test(b.child_database && b.child_database.title || '')) || blocks[0];
        const database = await notionFetch(cfg, `/databases/${preferred.id}`, 'GET');
        return { type: 'database', id: preferred.id, database, via: 'child_database' };
    } catch {
        return null;
    }
}

async function resolveNotionTarget(cfg) {
    const parentId = parsePageId(cfg.parent);
    if (!parentId) throw new Error('Notion 父页面链接不对（里面找不到页面 ID）');
    try {
        const database = await notionFetch(cfg, `/databases/${parentId}`, 'GET');
        return { type: 'database', id: parentId, database };
    } catch (e) {
        if (![400, 404].includes(e.status)) throw e;
    }
    const page = await notionFetch(cfg, `/blocks/${parentId}`, 'GET');
    const childDatabase = await findChildDatabase(cfg, parentId);
    if (childDatabase) return childDatabase;
    return { type: 'page', id: parentId, page };
}

function databasePageProperties(cfg, database, title, meta) {
    const properties = database.properties || {};
    const titleProp = pickProp(properties, null, ['名称', '标题', 'Name', 'Title'], 'title');
    if (!titleProp) throw new Error('这个 Notion 数据库里找不到标题属性');

    const out = {
        [titleProp]: {
            title: [{ type: 'text', text: { content: String(title).slice(0, 200) } }],
        },
    };
    const opts = notionOptions(cfg);
    const categoryProp = pickCategoryProp(properties, opts.categoryProperty);
    if (categoryProp) {
        const prop = properties[categoryProp];
        const category = closestCategory(cfg, meta.category);
        if (prop.type === 'select') out[categoryProp] = { select: { name: category } };
        if (prop.type === 'multi_select') out[categoryProp] = { multi_select: [{ name: category }] };
    }
    const dateProp = pickProp(properties, null, ['日期', '日历', 'Date', 'Calendar'], 'date');
    if (dateProp) out[dateProp] = { date: { start: new Date().toISOString().slice(0, 10) } };
    const favProp = pickProp(properties, null, ['收藏', 'Favorite', 'Starred'], 'checkbox');
    if (favProp && meta.favorite === true) out[favProp] = { checkbox: true };
    return out;
}

/** 在 Notion 页面或数据库里创建一篇笔记，返回页面链接 */
export async function createNotePage(cfg, title, markdown, emoji = '📝', meta = {}) {
    const target = await resolveNotionTarget(cfg);
    if (target.type === 'database') {
        const data = await notionFetch(cfg, '/pages', 'POST', {
            parent: { database_id: target.id },
            icon: { type: 'emoji', emoji: meta.emoji || emoji },
            properties: databasePageProperties(cfg, target.database, title, meta),
            children: mdToBlocks(markdown),
        });
        return data && data.url;
    }
    const data = await notionFetch(cfg, '/pages', 'POST', {
        parent: { page_id: target.id },
        icon: { type: 'emoji', emoji: meta.emoji || emoji },
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
    const target = await resolveNotionTarget(cfg);
    return {
        type: target.type,
        title: target.database && target.database.title
            ? target.database.title.map(t => t.plain_text).join('')
            : '',
    };
}

// ---------- 聊天中的"写笔记"指令 ----------
// AI 在回复里输出 <notion title="..." category="...">markdown</notion> 即表示要写一篇笔记。

const NOTION_DIRECTIVE_RE = /<notion\b([^>]*)>([\s\S]*?)<\/notion>/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;

function parseAttrs(raw) {
    const attrs = {};
    String(raw || '').replace(ATTR_RE, (_, key, value) => {
        attrs[key] = value.trim();
        return '';
    });
    return attrs;
}

/** 从 AI 回复里摘出写笔记指令，返回 { clean: 去掉指令后的正文, jobs: [{title, md, category, emoji}] } */
export function extractNotionDirectives(text) {
    const jobs = [];
    const clean = String(text || '').replace(NOTION_DIRECTIVE_RE, (_, rawAttrs, md) => {
        const attrs = parseAttrs(rawAttrs);
        jobs.push({
            title: (attrs.title || '未命名笔记').slice(0, 200),
            category: attrs.category || '',
            emoji: attrs.emoji || '',
            md: md.trim(),
        });
        return '';
    }).trim();
    return { clean, jobs };
}
