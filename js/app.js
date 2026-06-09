/**
 * Estudio 主程序：把数据层 / AI 层 / 调度器 / 界面串起来。
 */

import * as db from './db.js';
import { chatWithFallback, chatForJudge, testApi, extractJson, isApiConfigured } from './api.js';
import { ghBackup, ghRestore } from './github.js';
import { fileToText, extractPoints } from './extract.js';
import { pickSessionPoints, applyReview, subjectStats, isDue } from './scheduler.js';
import { buildSystemPrompt, buildJudgePrompt, OPENING_TRIGGER, CLOSING_TRIGGER } from './prompts.js';

const $ = (id) => document.getElementById(id);

const state = {
    subjects: [],
    currentSubjectId: null,
    settings: { api1: null, api2: null, github: null },
    session: null, // 进行中的复习：{id, subject, points, apiMessages, touched, startedAt, busy}
};

// ================= 小工具 =================

function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('toastBox').appendChild(el);
    setTimeout(() => el.remove(), type === 'err' ? 6000 : 3500);
}

function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ================= 设置 =================

async function loadSettings() {
    state.settings.api1 = await db.getSetting('api1');
    state.settings.api2 = await db.getSetting('api2');
    state.settings.github = await db.getSetting('github');
}

function fillSettingsForm() {
    const { api1, api2, github } = state.settings;
    $('api1BaseUrl').value = (api1 && api1.baseUrl) || '';
    $('api1Key').value = (api1 && api1.apiKey) || '';
    $('api1Model').value = (api1 && api1.model) || '';
    $('api2BaseUrl').value = (api2 && api2.baseUrl) || '';
    $('api2Key').value = (api2 && api2.apiKey) || '';
    $('api2Model').value = (api2 && api2.model) || '';
    $('ghToken').value = (github && github.token) || '';
    $('ghRepo').value = (github && github.repo) || '';
    $('ghUseProxy').checked = !github || github.useProxy !== false;
    $('ghAutoBackup').checked = !github || github.autoBackup !== false;
}

function readSettingsForm() {
    return {
        api1: {
            baseUrl: $('api1BaseUrl').value.trim(),
            apiKey: $('api1Key').value.trim(),
            model: $('api1Model').value.trim(),
        },
        api2: {
            baseUrl: $('api2BaseUrl').value.trim(),
            apiKey: $('api2Key').value.trim(),
            model: $('api2Model').value.trim(),
        },
        github: {
            token: $('ghToken').value.trim(),
            repo: $('ghRepo').value.trim() || 'estudio-backup',
            useProxy: $('ghUseProxy').checked,
            autoBackup: $('ghAutoBackup').checked,
        },
    };
}

async function saveSettings() {
    const s = readSettingsForm();
    await db.setSetting('api1', s.api1);
    await db.setSetting('api2', s.api2);
    await db.setSetting('github', s.github);
    state.settings = s;
    toast('设置已保存', 'ok');
    $('settingsModal').hidden = true;
    updateBackupStatus();
}

function updateBackupStatus() {
    const gh = state.settings.github;
    $('backupStatus').textContent = gh && gh.token ? '☁️ 备份已开启' : '☁️ 未配置备份';
}

// ================= 科目 =================

async function refreshSubjects() {
    state.subjects = (await db.getAll('subjects')).sort((a, b) => a.createdAt - b.createdAt);
    const allPoints = await db.getAll('points');
    const ul = $('subjectList');
    ul.innerHTML = '';
    for (const sub of state.subjects) {
        const due = allPoints.filter(p => p.subjectId === sub.id && isDue(p)).length;
        const li = document.createElement('li');
        li.className = sub.id === state.currentSubjectId ? 'active' : '';
        const wrap = document.createElement('div');
        wrap.className = 'subject-name-wrap';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = sub.name;
        wrap.appendChild(nameSpan);
        if (due > 0) {
            const badge = document.createElement('span');
            badge.className = 'due-badge';
            badge.textContent = due;
            badge.title = `${due} 个知识点到期待复习`;
            wrap.appendChild(badge);
        }
        const delBtn = document.createElement('button');
        delBtn.className = 'del-subject';
        delBtn.textContent = '✕';
        delBtn.title = '删除科目';
        delBtn.onclick = (e) => { e.stopPropagation(); deleteSubject(sub); };
        li.appendChild(wrap);
        li.appendChild(delBtn);
        li.onclick = () => selectSubject(sub.id);
        ul.appendChild(li);
    }
}

async function addSubject() {
    const name = prompt('新科目叫什么名字？');
    if (!name || !name.trim()) return;
    const sub = { id: db.uid(), name: name.trim(), createdAt: Date.now() };
    await db.put('subjects', sub);
    await refreshSubjects();
    selectSubject(sub.id);
}

async function deleteSubject(sub) {
    if (!confirm(`确定删除科目「${sub.name}」？\n它下面的资料、知识点、复习记录会一起删掉,删了就回不来了（除非云端有备份）。`)) return;
    await db.deleteSubjectCascade(sub.id);
    if (state.currentSubjectId === sub.id) {
        state.currentSubjectId = null;
        showView('viewEmpty');
    }
    await refreshSubjects();
    toast('科目已删除');
}

async function selectSubject(id) {
    state.currentSubjectId = id;
    await refreshSubjects();
    await renderSubjectView();
    showView('viewSubject');
}

function showView(id) {
    for (const v of ['viewEmpty', 'viewSubject', 'viewChat']) $(v).hidden = (v !== id);
}

// ================= 科目详情渲染 =================

async function renderSubjectView() {
    const sub = state.subjects.find(s => s.id === state.currentSubjectId);
    if (!sub) return;
    $('subjectTitle').textContent = sub.name;

    const [files, points, sessions] = await Promise.all([
        db.getByIndex('files', 'bySubject', sub.id),
        db.getByIndex('points', 'bySubject', sub.id),
        db.getByIndex('sessions', 'bySubject', sub.id),
    ]);

    const st = subjectStats(points);
    $('subjectStats').textContent = points.length
        ? `共 ${st.total} 个知识点 · ${st.due} 个待复习 · 平均掌握度 ${st.avgMastery.toFixed(1)}/5`
        : '还没有知识点，先上传点资料吧';
    $('btnStartReview').disabled = points.length === 0;

    // 资料列表
    const fl = $('fileList');
    fl.innerHTML = '';
    for (const f of files.sort((a, b) => b.createdAt - a.createdAt)) {
        const li = document.createElement('li');
        const left = document.createElement('span');
        left.textContent = '📄 ' + f.name;
        const meta = document.createElement('span');
        meta.className = 'file-meta';
        meta.textContent = `${fmtSize(f.size)} · ${f.pointCount} 个知识点`;
        left.appendChild(meta);
        const delBtn = document.createElement('button');
        delBtn.className = 'del-btn';
        delBtn.textContent = '✕';
        delBtn.title = '删除文件和它的知识点';
        delBtn.onclick = async () => {
            if (!confirm(`删除「${f.name}」和它拆出来的知识点？`)) return;
            await db.deleteFileCascade(f.id);
            await renderSubjectView();
            await refreshSubjects();
        };
        li.appendChild(left);
        li.appendChild(delBtn);
        fl.appendChild(li);
    }

    // 知识点列表
    const pl = $('pointList');
    pl.innerHTML = '';
    $('pointCount').textContent = points.length ? `${points.length} 条` : '';
    const sorted = [...points].sort((a, b) => {
        const da = isDue(a) ? 0 : 1, dbb = isDue(b) ? 0 : 1;
        return (da - dbb) || (a.mastery - b.mastery);
    });
    for (const p of sorted) {
        const li = document.createElement('li');
        const title = document.createElement('span');
        title.className = 'point-title';
        title.textContent = p.title || p.content.slice(0, 40);
        title.title = p.content;
        const dots = document.createElement('span');
        dots.className = 'mastery-dots';
        dots.title = p.reviews > 0 ? `掌握度 ${p.mastery}/5（复习过 ${p.reviews} 次）` : '还没复习过';
        for (let i = 1; i <= 5; i++) {
            const dot = document.createElement('i');
            if (p.reviews > 0 && i <= p.mastery) dot.className = 'on';
            dots.appendChild(dot);
        }
        const tag = document.createElement('span');
        if (p.reviews === 0) { tag.className = 'point-new'; tag.textContent = '新'; }
        else if (isDue(p)) { tag.className = 'point-due'; tag.textContent = '待复习'; }
        li.appendChild(title);
        li.appendChild(dots);
        li.appendChild(tag);
        pl.appendChild(li);
    }

    // 复习记录
    const sl = $('sessionList');
    sl.innerHTML = '';
    if (!sessions.length) {
        sl.innerHTML = '<li class="hint">还没复习过</li>';
    }
    for (const s of sessions.sort((a, b) => b.startedAt - a.startedAt).slice(0, 20)) {
        const li = document.createElement('li');
        const head = document.createElement('div');
        const touched = s.touched || [];
        head.innerHTML = `<strong>${fmtDate(s.startedAt)}</strong> <span class="session-meta">聊了 ${s.turns || 0} 轮 · 涉及 ${touched.length} 个知识点</span>`;
        li.appendChild(head);
        if (s.summary) {
            const sum = document.createElement('div');
            sum.className = 'session-summary';
            sum.textContent = s.summary;
            li.appendChild(sum);
        }
        sl.appendChild(li);
    }
}

// ================= 上传文件 → 拆知识点 =================

async function handleFiles(fileList) {
    const sub = state.subjects.find(s => s.id === state.currentSubjectId);
    if (!sub) return;
    const { api1, api2 } = state.settings;
    if (!isApiConfigured(api1) && !isApiConfigured(api2)) {
        toast('先去 ⚙️ 设置里把 AI 接口填好，才能拆知识点', 'err');
        return;
    }

    for (const file of fileList) {
        const progRow = $('extractProgress');
        const fill = $('extractProgressFill');
        const txt = $('extractProgressText');
        progRow.hidden = false;
        fill.style.width = '0%';
        txt.textContent = `正在读取 ${file.name}…`;
        try {
            const text = await fileToText(file);
            txt.textContent = `AI 正在拆解 ${file.name}…`;
            const { points, failedChunks } = await extractPoints(api1, api2, text, (done, total) => {
                fill.style.width = Math.round(done / total * 100) + '%';
                txt.textContent = `AI 正在拆解 ${file.name}…（${done}/${total} 片）`;
            });
            if (!points.length) throw new Error('没拆出任何知识点（材料可能太短或 AI 返回异常）');

            const fileRec = {
                id: db.uid(), subjectId: sub.id, name: file.name,
                size: file.size, text, pointCount: points.length, createdAt: Date.now(),
            };
            await db.put('files', fileRec);
            for (const p of points) {
                await db.put('points', {
                    id: db.uid(), subjectId: sub.id, fileId: fileRec.id,
                    title: (p.title || '').slice(0, 60) || p.content.slice(0, 30),
                    content: String(p.content),
                    mastery: 0, reviews: 0, lastAt: null, dueAt: 0, history: [],
                });
            }
            toast(`「${file.name}」拆出 ${points.length} 个知识点` + (failedChunks ? `（${failedChunks} 片失败，可删掉重传）` : ''), 'ok');
        } catch (e) {
            console.error(e);
            toast(`处理 ${file.name} 失败：${e.message}`, 'err');
        } finally {
            progRow.hidden = true;
        }
    }
    await renderSubjectView();
    await refreshSubjects();
}

// ================= 复习对话 =================

function addMsg(role, content) {
    const box = $('chatMessages');
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.textContent = content;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
}

async function startReview() {
    const sub = state.subjects.find(s => s.id === state.currentSubjectId);
    if (!sub) return;
    const { api1, api2 } = state.settings;
    if (!isApiConfigured(api1) && !isApiConfigured(api2)) {
        toast('先去 ⚙️ 设置里把 AI 接口填好', 'err');
        return;
    }
    const allPoints = await db.getByIndex('points', 'bySubject', sub.id);
    if (!allPoints.length) { toast('这个科目还没有知识点', 'err'); return; }

    const picked = pickSessionPoints(allPoints, 8);
    const sessions = await db.getByIndex('sessions', 'bySubject', sub.id);
    const last = sessions.sort((a, b) => b.startedAt - a.startedAt)[0];

    state.session = {
        id: db.uid(),
        subject: sub,
        points: picked,
        apiMessages: [
            { role: 'system', content: buildSystemPrompt(sub, picked, last && last.summary) },
            { role: 'user', content: OPENING_TRIGGER },
        ],
        touched: {},        // pointId → { title, before, after }
        turns: 0,
        startedAt: Date.now(),
        busy: false,
    };

    $('chatSubjectName').textContent = sub.name;
    $('chatApiBadge').textContent = '';
    $('chatMessages').innerHTML = '';
    showView('viewChat');
    $('chatInput').value = '';

    const typing = addMsg('ai typing', '…');
    try {
        const { text, usedApi } = await chatWithFallback(api1, api2, state.session.apiMessages);
        typing.remove();
        state.session.apiMessages.push({ role: 'assistant', content: text });
        addMsg('ai', text);
        $('chatApiBadge').textContent = `接口${usedApi}`;
        $('chatInput').focus();
    } catch (e) {
        typing.remove();
        addMsg('sys', '开场失败：' + e.message + '（检查设置里的 API 配置后重试）');
    }
}

async function sendMessage() {
    const sess = state.session;
    if (!sess || sess.busy) return;
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autoGrow(input);

    sess.busy = true;
    sess.turns++;
    sess.apiMessages.push({ role: 'user', content: text });
    addMsg('me', text);

    // 评估打分在后台悄悄跑（API 2 优先），不挡住聊天
    judgeInBackground(sess);

    const typing = addMsg('ai typing', '…');
    try {
        const { api1, api2 } = state.settings;
        const { text: reply, usedApi } = await chatWithFallback(api1, api2, sess.apiMessages);
        typing.remove();
        sess.apiMessages.push({ role: 'assistant', content: reply });
        addMsg('ai', reply);
        $('chatApiBadge').textContent = `接口${usedApi}`;
    } catch (e) {
        typing.remove();
        sess.apiMessages.pop(); // 失败的话把这条用户消息退回去，避免上下文错位
        input.value = text;
        addMsg('sys', '发送失败：' + e.message);
    } finally {
        sess.busy = false;
        input.focus();
    }
}

/** 后台评估：判断最近几轮对话里用户对哪些知识点表现如何，更新掌握度 */
async function judgeInBackground(sess) {
    try {
        const { api1, api2 } = state.settings;
        // 取最近 6 条可见对话（跳过 system 和触发语）
        const recent = sess.apiMessages
            .filter(m => m.role !== 'system' && m.content !== OPENING_TRIGGER && m.content !== CLOSING_TRIGGER)
            .slice(-6);
        if (recent.length < 2 || recent[recent.length - 1].role !== 'user') return;

        const reply = await chatForJudge(api1, api2, [
            { role: 'user', content: buildJudgePrompt(sess.points, recent) },
        ], { timeoutMs: 60000 });
        const parsed = extractJson(reply);
        const updates = (parsed && parsed.updates) || [];
        for (const u of updates) {
            const point = sess.points.find(p => p.id === u.id);
            if (!point || typeof u.level !== 'number') continue;
            const before = point.reviews > 0 ? point.mastery : null;
            const updated = applyReview(point, u.level);
            Object.assign(point, updated);
            await db.put('points', updated);
            if (!sess.touched[point.id]) {
                sess.touched[point.id] = { title: point.title, before, after: updated.mastery };
            } else {
                sess.touched[point.id].after = updated.mastery;
            }
        }
    } catch (e) {
        // 评估失败不打扰用户，下一轮还有机会
        console.warn('[judge] 评估失败:', e.message);
    }
}

async function endSession(silent = false) {
    const sess = state.session;
    if (!sess) return;
    let summary = '';

    if (!silent && sess.turns > 0) {
        $('btnEndSession').disabled = true;
        const typing = addMsg('ai typing', '…');
        try {
            const { api1, api2 } = state.settings;
            sess.apiMessages.push({ role: 'user', content: CLOSING_TRIGGER });
            const { text } = await chatWithFallback(api1, api2, sess.apiMessages);
            typing.remove();
            addMsg('ai', text);
            summary = text;
        } catch (e) {
            typing.remove();
        }
        $('btnEndSession').disabled = false;
    }

    if (sess.turns > 0) {
        await db.put('sessions', {
            id: sess.id,
            subjectId: sess.subject.id,
            startedAt: sess.startedAt,
            endedAt: Date.now(),
            turns: sess.turns,
            summary: summary || (silent ? '（中途退出）' : ''),
            touched: Object.entries(sess.touched).map(([pointId, t]) => ({ pointId, ...t })),
        });
    }

    state.session = null;

    // 自动备份
    const gh = state.settings.github;
    if (sess.turns > 0 && gh && gh.token && gh.autoBackup !== false) {
        backupNow(true);
    }

    await selectSubject(sess.subject.id);
}

// ================= 备份 =================

let backingUp = false;
async function backupNow(silentOk = false) {
    if (backingUp) return;
    const gh = state.settings.github;
    if (!gh || !gh.token) { toast('先在设置里填 GitHub Token', 'err'); return; }
    backingUp = true;
    $('backupStatus').textContent = '☁️ 备份中…';
    try {
        const data = await db.exportAll();
        const { owner, repo } = await ghBackup(gh, data);
        $('backupStatus').textContent = `☁️ 已备份 ${fmtDate(Date.now())}`;
        if (!silentOk) toast(`已备份到 ${owner}/${repo}（私有仓库）`, 'ok');
        else toast('已自动备份到云端 ☁️', 'ok');
    } catch (e) {
        console.error(e);
        $('backupStatus').textContent = '☁️ 备份失败';
        toast('备份失败：' + e.message, 'err');
    } finally {
        backingUp = false;
    }
}

async function restoreFromCloud() {
    const gh = readSettingsForm().github;
    if (!gh.token) { toast('先填 GitHub Token', 'err'); return; }
    if (!confirm('从云端恢复会【覆盖】这台电脑上的所有科目和记录，确定？')) return;
    try {
        toast('正在从云端下载备份…');
        const data = await ghRestore(gh);
        await db.importAll(data);
        await loadSettings();
        fillSettingsForm();
        await refreshSubjects();
        state.currentSubjectId = null;
        showView('viewEmpty');
        updateBackupStatus();
        toast(`恢复完成（备份时间 ${fmtDate(data.timestamp)}）`, 'ok');
    } catch (e) {
        console.error(e);
        toast('恢复失败：' + e.message, 'err');
    }
}

// ================= 输入框自适应高度 =================

function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

// ================= 事件绑定 & 启动 =================

async function testApiSlot(which) {
    const s = readSettingsForm();
    const cfg = which === 1 ? s.api1 : s.api2;
    const btn = which === 1 ? $('btnTestApi1') : $('btnTestApi2');
    if (!isApiConfigured(cfg)) { toast('地址 / 钥匙 / 模型名要填全才能测', 'err'); return; }
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
        await testApi(cfg);
        toast(`接口 ${which} 正常 ✓`, 'ok');
    } catch (e) {
        toast(`接口 ${which} 不通：${e.message}`, 'err');
    } finally {
        btn.disabled = false;
        btn.textContent = `测试接口 ${which}`;
    }
}

function bindEvents() {
    $('btnAddSubject').onclick = addSubject;
    $('btnSettings').onclick = () => { fillSettingsForm(); $('settingsModal').hidden = false; };
    $('btnCloseSettings').onclick = () => { $('settingsModal').hidden = true; };
    $('btnSaveSettings').onclick = saveSettings;
    $('btnTestApi1').onclick = () => testApiSlot(1);
    $('btnTestApi2').onclick = () => testApiSlot(2);
    $('btnBackupNow').onclick = async () => { await saveSettingsQuiet(); backupNow(); };
    $('btnRestore').onclick = restoreFromCloud;
    $('btnStartReview').onclick = startReview;
    $('btnSend').onclick = sendMessage;
    $('btnEndSession').onclick = () => endSession(false);
    $('btnChatBack').onclick = () => {
        if (state.session && state.session.turns > 0) {
            if (!confirm('直接退出？聊过的掌握度已经记下了，但 AI 不会做收尾总结。')) return;
            endSession(true);
        } else {
            state.session = null;
            selectSubject(state.currentSubjectId);
        }
    };
    $('fileInput').onchange = (e) => {
        if (e.target.files.length) handleFiles([...e.target.files]);
        e.target.value = '';
    };
    const input = $('chatInput');
    input.addEventListener('input', () => autoGrow(input));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            sendMessage();
        }
    });
    // 弹窗点遮罩关闭
    $('settingsModal').addEventListener('click', (e) => {
        if (e.target === $('settingsModal')) $('settingsModal').hidden = true;
    });
}

async function saveSettingsQuiet() {
    const s = readSettingsForm();
    await db.setSetting('api1', s.api1);
    await db.setSetting('api2', s.api2);
    await db.setSetting('github', s.github);
    state.settings = s;
}

async function main() {
    bindEvents();
    await loadSettings();
    updateBackupStatus();
    await refreshSubjects();
    // 第一次用：自动弹设置
    const { api1, api2 } = state.settings;
    if (!isApiConfigured(api1) && !isApiConfigured(api2)) {
        fillSettingsForm();
        $('settingsModal').hidden = false;
        toast('先把 AI 接口填好（地址 / 钥匙 / 模型名），然后就能开始了');
    }
}

main().catch(e => {
    console.error(e);
    toast('启动失败：' + e.message, 'err');
});
