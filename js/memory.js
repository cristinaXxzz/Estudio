/**
 * 学习记忆宫殿 —— 核心逻辑移植自 SULLYOS 的 utils/memoryPalace：
 *   复习结束 → AI 提炼记忆条目 → Embedding 向量化 → 下次复习时
 *   "向量相似度 + 关键词 + 新近度 + 重要度" 混合检索 → 注入提示词。
 *
 * 房间分类从社交向改成学习向（用户要求）。
 * 没配 Embedding 接口时自动退化为纯关键词检索，功能不缺。
 */

import * as db from './db.js';
import { chatForJudge, extractJson } from './api.js';

// ---------- 房间（学习版） ----------

export const ROOMS = {
    weak: { label: '错题本', emoji: '📕', desc: '答错的、卡壳的、明显薄弱的点' },
    confusion: { label: '迷雾区', emoji: '🌫️', desc: '易混淆的概念对、似懂非懂的地方' },
    strength: { label: '高光墙', emoji: '✨', desc: '掌握得扎实、答得漂亮的点' },
    method: { label: '方法柜', emoji: '🔧', desc: '对这个用户管用的讲法、例子、记法' },
    habit: { label: '习惯档案', emoji: '📋', desc: '用户的学习习惯、偏好、背景信息' },
    plan: { label: '待办窗台', emoji: '🪟', desc: '约好下次复习的、用户自己立的目标' },
};

const MAX_MEMORIES_PER_SUBJECT = 200;

// ---------- Embedding（移植自 memoryPalace/embedding.ts，精简版） ----------

export function isEmbedConfigured(cfg) {
    return !!(cfg && cfg.baseUrl && cfg.apiKey && cfg.model);
}

export async function getEmbeddings(texts, cfg) {
    if (!texts.length) return [];
    const baseUrl = cfg.baseUrl.trim().replace(/\/+$/, '').replace(/\/v\d+$/, '') ;
    const url = `${baseUrl}/v1/embeddings`.replace('/v1/v1/', '/v1/');
    const BATCH = 20;
    const out = [];
    for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH).map(t => String(t || '').trim()).filter(Boolean);
        if (!batch.length) continue;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({ model: cfg.model, input: batch, encoding_format: 'float' }),
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`Embedding 接口 ${res.status}: ${t.slice(0, 150)}`);
        }
        const data = await res.json();
        if (!data.data || !Array.isArray(data.data)) throw new Error('Embedding 接口返回格式异常');
        const sorted = [...data.data].sort((a, b) => a.index - b.index);
        out.push(...sorted.map(item => item.embedding));
    }
    return out;
}

export function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const den = Math.sqrt(na) * Math.sqrt(nb);
    return den === 0 ? 0 : dot / den;
}

// ---------- 关键词检索（memoryPalace/bm25.ts 的轻量版） ----------

/** 中英混合分词：中文切 2-gram，英文/数字按词 */
export function tokenize(text) {
    const tokens = [];
    const lower = String(text || '').toLowerCase();
    for (const m of lower.matchAll(/[a-z0-9áéíóúüñ]+/g)) tokens.push(m[0]);
    const cjk = lower.replace(/[^一-鿿]/g, '');
    for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk.slice(i, i + 2));
    if (cjk.length === 1) tokens.push(cjk);
    return tokens;
}

function keywordScore(queryTokens, text) {
    if (!queryTokens.length) return 0;
    const set = new Set(tokenize(text));
    let hit = 0;
    for (const t of queryTokens) if (set.has(t)) hit++;
    return hit / queryTokens.length;
}

// ---------- 提炼（memoryPalace/extraction.ts 思路，学习版提示词） ----------

function buildExtractionPrompt(subjectName, transcript, existing) {
    const roomDesc = Object.entries(ROOMS)
        .map(([key, r]) => `- ${key}（${r.label}）：${r.desc}`).join('\n');
    const existingNote = existing.length
        ? `\n已有的记忆（避免重复记，有变化的可以记新版本）：\n${existing.map(m => `- [${m.room}] ${m.content}`).join('\n')}\n`
        : '';
    return `你是学习记忆整理器。下面是用户复习「${subjectName}」的一段对话记录。请提炼出值得长期记住的"学习记忆"，供 AI 学伴下次复习时参考。

房间分类：
${roomDesc}

要求：
- 每条记忆一句话，具体、可执行（"用户分不清 ser 和 estar 在形容词前的区别" 好；"用户语法不太行" 太空）
- importance 1~5：下次复习时有多需要想起这条（5=必须想起）
- 只记对话里真实发生的，不要脑补
- 一般提炼 2~6 条，没什么可记就输出空数组
- 只输出 JSON：[{"room":"weak","content":"...","importance":4}]
${existingNote}
对话记录：
${transcript}`;
}

/**
 * 复习结束后调用：从对话里提炼记忆并入库（含向量化、容量整理）。
 * 失败不抛错（记忆是增强功能，不能影响主流程）。返回新记的条数。
 */
export async function digestSession(subject, visibleMessages, settings) {
    try {
        const transcript = visibleMessages
            .map(m => `${m.name || (m.role === 'user' ? '用户' : 'AI')}: ${m.content}`)
            .join('\n').slice(0, 12000);
        if (transcript.length < 50) return 0;

        const existing = await db.getByIndex('memories', 'bySubject', subject.id);
        const recentExisting = existing.sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);

        const reply = await chatForJudge(settings.api1, settings.api2, [
            { role: 'user', content: buildExtractionPrompt(subject.name, transcript, recentExisting) },
        ], { maxTokens: 2000, timeoutMs: 90000 });
        const parsed = extractJson(reply);
        if (!Array.isArray(parsed) || !parsed.length) return 0;

        const valid = parsed.filter(m => m && m.content && ROOMS[m.room]);
        if (!valid.length) return 0;

        // 向量化（配了 Embedding 才做，失败就存纯文本版）
        let vecs = [];
        if (isEmbedConfigured(settings.embed)) {
            try {
                vecs = await getEmbeddings(valid.map(m => m.content), settings.embed);
            } catch (e) {
                console.warn('[memory] 向量化失败，本批记忆走纯关键词检索:', e.message);
            }
        }

        const now = Date.now();
        for (let i = 0; i < valid.length; i++) {
            await db.put('memories', {
                id: db.uid(),
                subjectId: subject.id,
                room: valid[i].room,
                content: String(valid[i].content).slice(0, 300),
                importance: Math.max(1, Math.min(5, valid[i].importance | 0 || 3)),
                vec: vecs[i] || null,
                createdAt: now,
                recalls: 0,
            });
        }

        await consolidate(subject.id);
        return valid.length;
    } catch (e) {
        console.warn('[memory] 提炼记忆失败:', e.message);
        return 0;
    }
}

/** 容量整理（consolidation.ts 思路简化）：超容量时淘汰"重要度低且老旧"的 */
async function consolidate(subjectId) {
    const all = await db.getByIndex('memories', 'bySubject', subjectId);
    if (all.length <= MAX_MEMORIES_PER_SUBJECT) return;
    const now = Date.now();
    const scored = all.map(m => ({
        m,
        keep: m.importance * 2 + (m.recalls || 0) - (now - m.createdAt) / (30 * 24 * 3600 * 1000),
    })).sort((a, b) => a.keep - b.keep);
    const toDrop = scored.slice(0, all.length - MAX_MEMORIES_PER_SUBJECT);
    for (const { m } of toDrop) await db.del('memories', m.id);
}

// ---------- 检索（hybridSearch.ts 思路：向量 + 关键词 + 新近度 + 重要度） ----------

/**
 * 复习开始时调用：根据"科目 + 本次知识点"找出最该想起的记忆。
 * 返回排好序的记忆数组（最多 topK 条），并给召回的记忆 +1 recalls。
 */
export async function retrieveMemories(subject, points, settings, topK = 12) {
    const all = await db.getByIndex('memories', 'bySubject', subject.id);
    if (!all.length) return [];

    const queryText = subject.name + ' ' + points.map(p => p.title).join(' ');
    const queryTokens = tokenize(queryText);

    let queryVec = null;
    if (isEmbedConfigured(settings.embed) && all.some(m => m.vec)) {
        try {
            queryVec = (await getEmbeddings([queryText], settings.embed))[0] || null;
        } catch (e) {
            console.warn('[memory] 查询向量化失败，退化为关键词检索:', e.message);
        }
    }

    const now = Date.now();
    const scored = all.map(m => {
        const vecSim = (queryVec && m.vec) ? Math.max(0, cosineSimilarity(queryVec, m.vec)) : 0;
        const kw = keywordScore(queryTokens, m.content);
        const ageDays = (now - m.createdAt) / (24 * 3600 * 1000);
        const recency = Math.exp(-ageDays / 30); // 一个月衰减到 1/e
        const imp = m.importance / 5;
        const score = queryVec
            ? vecSim * 0.5 + kw * 0.15 + recency * 0.15 + imp * 0.2
            : kw * 0.4 + recency * 0.3 + imp * 0.3;
        return { m, score };
    }).sort((a, b) => b.score - a.score);

    const picked = scored.slice(0, topK).map(s => s.m);
    for (const m of picked) {
        m.recalls = (m.recalls || 0) + 1;
        await db.put('memories', m);
    }
    return picked;
}

/** 把检索到的记忆排版成提示词片段 */
export function formatMemories(memories) {
    if (!memories.length) return '';
    const byRoom = {};
    for (const m of memories) {
        (byRoom[m.room] = byRoom[m.room] || []).push(m.content);
    }
    const lines = [];
    for (const [room, items] of Object.entries(byRoom)) {
        const r = ROOMS[room];
        lines.push(`${r.emoji}${r.label}：`);
        for (const c of items) lines.push(`  - ${c}`);
    }
    return lines.join('\n');
}

/** 测试 Embedding 配置 */
export async function testEmbed(cfg) {
    const v = await getEmbeddings(['测试'], cfg);
    if (!v[0] || !v[0].length) throw new Error('返回了空向量');
    return v[0].length;
}
