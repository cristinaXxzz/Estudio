/**
 * 简单间隔重复调度。不搞复杂算法：
 *   每个知识点有一个掌握度 0~5，复习完按掌握度决定下次出现的间隔——
 *   掌握越好，隔得越久；掌握差的明天就会再来。
 */

const DAY = 24 * 60 * 60 * 1000;

// 掌握度 0..5 对应的复习间隔（天）
const INTERVALS = [0.5, 1, 2, 4, 7, 15];

export function nextDueAt(mastery, now = Date.now()) {
    const level = Math.max(0, Math.min(5, mastery | 0));
    return now + INTERVALS[level] * DAY;
}

export function isDue(point, now = Date.now()) {
    if (point.reviews === 0 || point.lastAt == null) return true; // 从没复习过
    return (point.dueAt || 0) <= now;
}

/**
 * 给一次复习挑知识点：
 *   1. 到期的优先（逾期越久越靠前，掌握度越低越靠前）
 *   2. 掺 2 个从没复习过的新知识点
 *   3. 不够数就拿"还没到期但掌握度最低"的凑
 */
export function pickSessionPoints(points, count = 8, now = Date.now()) {
    if (points.length <= count) return shuffle([...points]);

    const fresh = points.filter(p => p.reviews === 0);
    const due = points.filter(p => p.reviews > 0 && (p.dueAt || 0) <= now)
        .sort((a, b) => (a.mastery - b.mastery) || ((a.dueAt || 0) - (b.dueAt || 0)));
    const rest = points.filter(p => p.reviews > 0 && (p.dueAt || 0) > now)
        .sort((a, b) => (a.mastery - b.mastery) || ((a.dueAt || 0) - (b.dueAt || 0)));

    const picked = [];
    const freshQuota = Math.min(2, fresh.length);
    shuffle(fresh);
    picked.push(...fresh.slice(0, freshQuota));
    for (const p of due) { if (picked.length >= count) break; picked.push(p); }
    // 名额还有剩：先用更多新知识点填，再用未到期的填
    for (const p of fresh.slice(freshQuota)) { if (picked.length >= count) break; picked.push(p); }
    for (const p of rest) { if (picked.length >= count) break; picked.push(p); }
    return shuffle(picked);
}

/** 复习后更新一个知识点的掌握度和下次到期时间（返回新对象） */
export function applyReview(point, level, now = Date.now()) {
    const mastery = Math.max(0, Math.min(5, level | 0));
    return {
        ...point,
        mastery,
        reviews: (point.reviews || 0) + 1,
        lastAt: now,
        dueAt: nextDueAt(mastery, now),
        history: [...(point.history || []), { at: now, level: mastery }].slice(-50),
    };
}

/** 科目统计：总数 / 到期数 / 平均掌握度 */
export function subjectStats(points, now = Date.now()) {
    const total = points.length;
    const due = points.filter(p => isDue(p, now)).length;
    const reviewed = points.filter(p => p.reviews > 0);
    const avg = reviewed.length
        ? reviewed.reduce((s, p) => s + p.mastery, 0) / reviewed.length
        : 0;
    return { total, due, avgMastery: avg, neverReviewed: total - reviewed.length };
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
