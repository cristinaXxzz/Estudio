/**
 * Estudio 主程序：把数据层 / AI 层 / 调度器 / 界面串起来。
 */

import * as db from './db.js';
import { chatWithFallback, chatForJudge, chatOnce, testApi, fetchModels, extractJson, isApiConfigured } from './api.js';
import { ghBackup, ghRestore } from './github.js';
import { fileToText, extractPoints } from './extract.js';
import { pickSessionPoints, applyReview, subjectStats, isDue } from './scheduler.js';
import {
    buildSystemPrompt, buildJudgePrompt, OPENING_TRIGGER, CLOSING_TRIGGER,
    buildGroupSystemPrompt, DEFAULT_CHARACTERS,
    GROUP_OPENING_FIRST, GROUP_OPENING_NEXT, GROUP_CLOSING,
} from './prompts.js';
import {
    ROOMS, digestSession, retrieveMemories, formatMemories, testEmbed, isEmbedConfigured,
} from './memory.js';
import {
    isNotionConfigured, createNotePage, testNotion, extractNotionDirectives,
} from './notion.js';

const $ = (id) => document.getElementById(id);

const state = {
    subjects: [],
    currentSubjectId: null,
    settings: { api1: null, api2: null, github: null, embed: null, notion: null },
    modelLists: { 1: [], 2: [] }, // 各接口拉取到的模型列表
    characters: [],               // 可拉进群聊的 AI 角色
    editingCharId: null,
    session: null, // 进行中的复习：{id, mode:'solo'|'group', subject, points, apiMessages|history, chars, touched, startedAt, busy}
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
    state.settings.embed = await db.getSetting('embed');
    state.settings.notion = await db.getSetting('notion');
    state.modelLists[1] = (await db.getSetting('modelList1')) || [];
    state.modelLists[2] = (await db.getSetting('modelList2')) || [];
}

/** 把拉取到的模型列表灌进下拉框 */
function populateModelSelect(which) {
    const sel = $(`api${which}ModelSelect`);
    const list = state.modelLists[which];
    sel.innerHTML = '';
    if (!list.length) { sel.hidden = true; return; }
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = `↓ 从拉取到的 ${list.length} 个模型里选`;
    sel.appendChild(ph);
    for (const id of list) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        sel.appendChild(opt);
    }
    const current = $(`api${which}Model`).value.trim();
    sel.value = list.includes(current) ? current : '';
    sel.hidden = false;
}

async function fetchModelsSlot(which) {
    const s = readSettingsForm();
    const cfg = which === 1 ? s.api1 : s.api2;
    const btn = $(`btnFetchModels${which}`);
    btn.disabled = true;
    btn.textContent = '拉取中…';
    try {
        const ids = await fetchModels(cfg);
        state.modelLists[which] = ids;
        await db.setSetting(`modelList${which}`, ids);
        populateModelSelect(which);
        toast(`接口 ${which} 拉到 ${ids.length} 个模型，从下拉框里选一个`, 'ok');
    } catch (e) {
        toast(`拉取模型失败：${e.message}`, 'err');
    } finally {
        btn.disabled = false;
        btn.textContent = '拉取模型';
    }
}

function fillSettingsForm() {
    const { api1, api2, github } = state.settings;
    $('api1BaseUrl').value = (api1 && api1.baseUrl) || '';
    $('api1Key').value = (api1 && api1.apiKey) || '';
    $('api1Model').value = (api1 && api1.model) || '';
    $('api2BaseUrl').value = (api2 && api2.baseUrl) || '';
    $('api2Key').value = (api2 && api2.apiKey) || '';
    $('api2Model').value = (api2 && api2.model) || '';
    const embed = state.settings.embed;
    $('embedBaseUrl').value = (embed && embed.baseUrl) || '';
    $('embedKey').value = (embed && embed.apiKey) || '';
    $('embedModel').value = (embed && embed.model) || '';
    const notion = state.settings.notion;
    $('notionToken').value = (notion && notion.token) || '';
    $('notionParent').value = (notion && notion.parent) || '';
    $('notionAutoRecap').checked = !notion || notion.autoRecap !== false;
    $('ghToken').value = (github && github.token) || '';
    $('ghRepo').value = (github && github.repo) || '';
    $('ghUseProxy').checked = !github || github.useProxy !== false;
    $('ghAutoBackup').checked = !github || github.autoBackup !== false;
    populateModelSelect(1);
    populateModelSelect(2);
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
        embed: {
            baseUrl: $('embedBaseUrl').value.trim(),
            apiKey: $('embedKey').value.trim(),
            model: $('embedModel').value.trim(),
        },
        notion: {
            token: $('notionToken').value.trim(),
            parent: $('notionParent').value.trim(),
            autoRecap: $('notionAutoRecap').checked,
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
    await db.setSetting('embed', s.embed);
    await db.setSetting('notion', s.notion);
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

    const [files, points, sessions, memories] = await Promise.all([
        db.getByIndex('files', 'bySubject', sub.id),
        db.getByIndex('points', 'bySubject', sub.id),
        db.getByIndex('sessions', 'bySubject', sub.id),
        db.getByIndex('memories', 'bySubject', sub.id),
    ]);

    const st = subjectStats(points);
    $('subjectStats').textContent = points.length
        ? `共 ${st.total} 个知识点 · ${st.due} 个待复习 · 平均掌握度 ${st.avgMastery.toFixed(1)}/5`
        : '还没有知识点，先上传点资料吧';
    $('btnStartReview').disabled = points.length === 0;
    $('btnStartGroup').disabled = points.length === 0;

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

    // 学习记忆
    const ml = $('memoryList');
    ml.innerHTML = '';
    $('memoryCount').textContent = memories.length ? `${memories.length} 条` : '';
    if (!memories.length) {
        ml.innerHTML = '<li class="hint">还没有记忆，复习几次它就慢慢了解你了</li>';
    }
    for (const m of memories.sort((a, b) => b.createdAt - a.createdAt).slice(0, 30)) {
        const li = document.createElement('li');
        const room = ROOMS[m.room] || { emoji: '🗂️', label: m.room };
        const tag = document.createElement('span');
        tag.className = 'memory-room';
        tag.textContent = room.emoji + room.label;
        const content = document.createElement('span');
        content.className = 'memory-content';
        content.textContent = m.content;
        const vec = document.createElement('span');
        vec.className = 'memory-vec';
        vec.textContent = m.vec ? '🧬' : '';
        vec.title = m.vec ? '已向量化（按意思检索）' : '';
        const delBtn = document.createElement('button');
        delBtn.className = 'del-btn';
        delBtn.textContent = '✕';
        delBtn.title = '删掉这条记忆';
        delBtn.onclick = async () => { await db.del('memories', m.id); renderSubjectView(); };
        li.append(tag, content, vec, delBtn);
        ml.appendChild(li);
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
            const text = await fileToText(file, {
                api1, api2,
                onProgress: (phase, done, total) => {
                    fill.style.width = Math.round(done / total * 100) + '%';
                    txt.textContent = phase === 'render'
                        ? `正在把 ${file.name} 的页面变成图片…（${done}/${total}）`
                        : `AI 正在认字 ${file.name}…（${done}/${total} 页）`;
                },
            });
            fill.style.width = '0%';
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

function addMsg(role, content, name) {
    const box = $('chatMessages');
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.textContent = content;
    let outer = el;
    if (name) {
        outer = document.createElement('div');
        outer.className = 'msg-group';
        const label = document.createElement('div');
        label.className = 'msg-name';
        label.textContent = name;
        outer.appendChild(label);
        outer.appendChild(el);
    }
    box.appendChild(outer);
    box.scrollTop = box.scrollHeight;
    return outer;
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
    const memories = await retrieveMemories(sub, picked, state.settings);

    state.session = {
        id: db.uid(),
        mode: 'solo',
        subject: sub,
        points: picked,
        apiMessages: [
            { role: 'system', content: buildSystemPrompt(sub, picked, last && last.summary, formatMemories(memories), !!notionCfg()) },
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
        const { clean, jobs } = extractNotionDirectives(text);
        state.session.apiMessages.push({ role: 'assistant', content: clean || text });
        addMsg('ai', clean || text);
        runNotionJobs(jobs);
        $('chatApiBadge').textContent = `接口${usedApi}`;
        $('chatInput').focus();
    } catch (e) {
        typing.remove();
        addMsg('sys', '开场失败：' + e.message + '（检查设置里的 API 配置后重试）');
    }
}

// ================= Notion 笔记 =================

function notionCfg() {
    const n = state.settings.notion;
    return isNotionConfigured(n) ? n : null;
}

/** 执行 AI 回复里摘出的写笔记指令（不阻塞聊天） */
async function runNotionJobs(jobs) {
    const cfg = notionCfg();
    if (!cfg || !jobs.length) return;
    for (const job of jobs) {
        try {
            await createNotePage(cfg, job.title, job.md);
            addMsg('sys', `📝 已写进 Notion：${job.title}`);
        } catch (e) {
            console.error(e);
            addMsg('sys', `Notion 写入失败：${e.message}`);
        }
    }
}

const RECAP_PROMPT_HEAD = `把下面这次复习对话整理成一篇「今日复盘」笔记，markdown 格式，结构：
## 今天复习了什么
## 掌握得不错
## 还要再看
## 下次计划
要求：简洁具体，每节 1~4 条；保留材料原语言的术语；基于对话真实内容，不要脑补；只输出 markdown，不要其他文字。

对话记录：
`;

/** 复习结束后自动把"今日复盘"写到 Notion（失败只提示，不影响主流程） */
async function writeNotionRecap(sess, visible) {
    const cfg = notionCfg();
    if (!cfg || cfg.autoRecap === false) return;
    try {
        const transcript = visible
            .map(m => `${m.name || (m.role === 'user' ? '用户' : 'AI')}: ${m.content}`)
            .join('\n').slice(0, 12000);
        if (transcript.length < 50) return;
        const { api1, api2 } = state.settings;
        const md = await chatForJudge(api1, api2, [
            { role: 'user', content: RECAP_PROMPT_HEAD + transcript },
        ], { maxTokens: 2000, timeoutMs: 90000 });
        const d = new Date(sess.startedAt);
        const title = `${d.getMonth() + 1}月${d.getDate()}日 ${sess.subject.name} 复盘`;
        await createNotePage(cfg, title, md.replace(/^```(?:markdown)?\s*\n?|```\s*$/g, ''), '📅');
        toast(`「${title}」已写进 Notion 📅`, 'ok');
    } catch (e) {
        console.error(e);
        toast('Notion 复盘写入失败：' + e.message, 'err');
    }
}

// ================= AI 角色（可创建、可拉群） =================

async function loadCharacters() {
    state.characters = (await db.getAll('characters')).sort((a, b) => a.createdAt - b.createdAt);
    // 首次使用：把内置的小言/老杠种进角色库
    if (!state.characters.length) {
        for (const c of DEFAULT_CHARACTERS) {
            await db.put('characters', { id: db.uid(), ...c, createdAt: Date.now() });
        }
        state.characters = (await db.getAll('characters')).sort((a, b) => a.createdAt - b.createdAt);
    }
}

function renderCharList() {
    const ul = $('charList');
    ul.innerHTML = '';
    for (const c of state.characters) {
        const li = document.createElement('li');
        const emoji = document.createElement('span');
        emoji.className = 'char-emoji';
        emoji.textContent = c.emoji || '🙂';
        const info = document.createElement('div');
        info.className = 'char-info';
        const nm = document.createElement('strong');
        nm.textContent = c.name;
        const desc = document.createElement('span');
        desc.textContent = c.persona;
        desc.title = c.persona;
        info.appendChild(nm); info.appendChild(desc);
        const slot = document.createElement('span');
        slot.className = 'char-slot';
        slot.textContent = `接口${c.apiSlot}`;
        const editBtn = document.createElement('button');
        editBtn.className = 'mini-btn';
        editBtn.textContent = '编辑';
        editBtn.onclick = () => openCharEditor(c);
        const delBtn = document.createElement('button');
        delBtn.className = 'del-btn';
        delBtn.textContent = '✕';
        delBtn.title = '删除角色';
        delBtn.onclick = async () => {
            if (!confirm(`删除角色「${c.name}」？`)) return;
            await db.del('characters', c.id);
            await loadCharacters();
            renderCharList();
        };
        li.append(emoji, info, slot, editBtn, delBtn);
        ul.appendChild(li);
    }
}

function openCharEditor(c) {
    state.editingCharId = c ? c.id : null;
    $('charEditorTitle').textContent = c ? `编辑：${c.name}` : '新角色';
    $('charEmoji').value = c ? (c.emoji || '') : '';
    $('charName').value = c ? c.name : '';
    $('charPersona').value = c ? c.persona : '';
    $('charApiSlot').value = c ? String(c.apiSlot) : '1';
    $('charEditor').hidden = false;
}

async function saveCharacter() {
    const name = $('charName').value.trim();
    const persona = $('charPersona').value.trim();
    if (!name) { toast('角色得有个名字', 'err'); return; }
    if (!persona) { toast('人设不能空着——它怎么说话全靠这个', 'err'); return; }
    const existing = state.editingCharId
        ? state.characters.find(c => c.id === state.editingCharId)
        : null;
    await db.put('characters', {
        id: existing ? existing.id : db.uid(),
        name,
        emoji: $('charEmoji').value.trim() || '🙂',
        persona,
        apiSlot: parseInt($('charApiSlot').value, 10) === 2 ? 2 : 1,
        createdAt: existing ? existing.createdAt : Date.now(),
    });
    $('charEditor').hidden = true;
    state.editingCharId = null;
    await loadCharacters();
    renderCharList();
    toast('角色已保存', 'ok');
}

// ================= 群聊（自选角色 + 记忆） =================

const groupPick = new Set(); // 选人弹窗里勾选的角色 id

function openGroupPicker() {
    const sub = state.subjects.find(s => s.id === state.currentSubjectId);
    if (!sub) return;
    const { api1, api2 } = state.settings;
    if (!isApiConfigured(api1) && !isApiConfigured(api2)) {
        toast('先去 ⚙️ 设置里把 AI 接口填好', 'err');
        return;
    }
    groupPick.clear();
    const ul = $('groupPickList');
    ul.innerHTML = '';
    for (const c of state.characters) {
        const li = document.createElement('li');
        const mark = document.createElement('span');
        mark.className = 'pick-mark';
        mark.textContent = '○';
        const emoji = document.createElement('span');
        emoji.className = 'char-emoji';
        emoji.textContent = c.emoji || '🙂';
        const info = document.createElement('div');
        info.className = 'char-info';
        const nm = document.createElement('strong');
        nm.textContent = c.name;
        const desc = document.createElement('span');
        desc.textContent = c.persona;
        info.appendChild(nm); info.appendChild(desc);
        const slot = document.createElement('span');
        slot.className = 'char-slot';
        slot.textContent = `接口${c.apiSlot}`;
        li.append(mark, emoji, info, slot);
        li.onclick = () => {
            if (groupPick.has(c.id)) { groupPick.delete(c.id); li.classList.remove('picked'); mark.textContent = '○'; }
            else { groupPick.add(c.id); li.classList.add('picked'); mark.textContent = '●'; }
        };
        ul.appendChild(li);
    }
    $('groupPickModal').hidden = false;
}

/** 某个角色优先用自己的接口槽位，挂了换另一个兜底 */
function charApis(char) {
    const { api1, api2 } = state.settings;
    const pref = char.apiSlot === 2 ? api2 : api1;
    const alt = char.apiSlot === 2 ? api1 : api2;
    if (isApiConfigured(pref)) return [pref, alt];
    return [alt, pref]; // 自己的槽位没配，直接用另一个
}

/** 把群聊历史翻译成某个角色视角下的对话：自己的话是 assistant，其他人的话带名字拼成 user */
function groupMessagesFor(sess, char, extraTrigger) {
    const msgs = [{
        role: 'system',
        content: buildGroupSystemPrompt(sess.subject, sess.points, sess.lastSummary, char, sess.chars, sess.memoriesText, !!notionCfg()),
    }];
    let buf = [];
    for (const m of sess.history) {
        if (m.speaker === char.id) {
            if (buf.length) { msgs.push({ role: 'user', content: buf.join('\n') }); buf = []; }
            msgs.push({ role: 'assistant', content: m.content });
        } else {
            const label = m.speaker === 'user' ? '用户' : (sess.charsById[m.speaker] || {}).name || '同学';
            buf.push(label + ': ' + m.content);
        }
    }
    if (extraTrigger) buf.push(extraTrigger);
    if (buf.length) msgs.push({ role: 'user', content: buf.join('\n') });
    return msgs;
}

/** 让某个角色说一句。说"[跳过]"就不出声。 */
async function personaReply(sess, char, trigger) {
    const [pref, alt] = charApis(char);
    const messages = groupMessagesFor(sess, char, trigger);
    const styleClass = sess.chars.indexOf(char) % 2 === 1 ? 'ai b' : 'ai';
    const label = `${char.emoji || ''}${char.name}`;
    const typing = addMsg(styleClass + ' typing', '…', label);
    try {
        let text;
        try {
            text = await chatOnce(pref, messages);
        } catch (e) {
            if (!isApiConfigured(alt)) throw e;
            console.warn(`[群聊] ${char.name} 的接口失败，换另一个兜底:`, e.message);
            text = await chatOnce(alt, messages);
        }
        typing.remove();
        if (state.session !== sess) return null; // 用户已经退出了
        if (/^\s*[\[（(]?\s*跳过\s*[\]）)]?\s*$/.test(text)) return null;
        const { clean, jobs } = extractNotionDirectives(text);
        runNotionJobs(jobs);
        if (!clean) return null; // 整条消息都是写笔记指令
        sess.history.push({ speaker: char.id, content: clean });
        addMsg(styleClass, clean, label);
        return clean;
    } catch (e) {
        typing.remove();
        if (state.session === sess) addMsg('sys', `${char.name} 掉线了：${e.message}`);
        return null;
    }
}

async function startGroupReview(chars) {
    const sub = state.subjects.find(s => s.id === state.currentSubjectId);
    if (!sub) return;
    const allPoints = await db.getByIndex('points', 'bySubject', sub.id);
    if (!allPoints.length) { toast('这个科目还没有知识点', 'err'); return; }

    const picked = pickSessionPoints(allPoints, 8);
    const sessions = await db.getByIndex('sessions', 'bySubject', sub.id);
    const last = sessions.sort((a, b) => b.startedAt - a.startedAt)[0];

    // 记忆检索：找出最该想起的学习记忆（向量+关键词混合）
    const memories = await retrieveMemories(sub, picked, state.settings);

    state.session = {
        id: db.uid(),
        mode: 'group',
        subject: sub,
        points: picked,
        chars,
        charsById: Object.fromEntries(chars.map(c => [c.id, c])),
        history: [],            // [{speaker:'user'|charId, content}]
        lastSummary: last && last.summary,
        memoriesText: formatMemories(memories),
        touched: {},
        turns: 0,
        startedAt: Date.now(),
        busy: false,
    };

    $('chatSubjectName').textContent = sub.name + (chars.length > 1 ? ' · 群聊' : '');
    $('chatApiBadge').textContent = chars.map(c => `${c.name}=接口${c.apiSlot}`).join(' · ')
        + (memories.length ? ` · 带着${memories.length}条记忆` : '');
    $('chatMessages').innerHTML = '';
    showView('viewChat');
    $('chatInput').value = '';

    const sess = state.session;
    sess.busy = true;
    for (let i = 0; i < chars.length; i++) {
        if (state.session !== sess) break;
        await personaReply(sess, chars[i], i === 0 ? GROUP_OPENING_FIRST : GROUP_OPENING_NEXT);
    }
    sess.busy = false;
    $('chatInput').focus();
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

    if (sess.mode === 'group') {
        sess.history.push({ speaker: 'user', content: text });
        addMsg('me', text);
        judgeInBackground(sess);
        // 谁先接话轮流来，群聊更活
        const n = sess.chars.length;
        const offset = sess.turns % n;
        const order = [...sess.chars.slice(offset), ...sess.chars.slice(0, offset)];
        for (const char of order) {
            if (state.session !== sess) break;
            await personaReply(sess, char);
        }
        sess.busy = false;
        input.focus();
        return;
    }

    sess.apiMessages.push({ role: 'user', content: text });
    addMsg('me', text);

    // 评估打分在后台悄悄跑（API 2 优先），不挡住聊天
    judgeInBackground(sess);

    const typing = addMsg('ai typing', '…');
    try {
        const { api1, api2 } = state.settings;
        const { text: reply, usedApi } = await chatWithFallback(api1, api2, sess.apiMessages);
        typing.remove();
        const { clean, jobs } = extractNotionDirectives(reply);
        sess.apiMessages.push({ role: 'assistant', content: clean || reply });
        addMsg('ai', clean || reply);
        runNotionJobs(jobs);
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
        const recent = sess.mode === 'group'
            ? sess.history.slice(-6).map(m => ({
                role: m.speaker === 'user' ? 'user' : 'assistant',
                content: m.speaker === 'user' ? m.content : `${((sess.charsById[m.speaker] || {}).name) || '同学'}: ${m.content}`,
            }))
            : sess.apiMessages
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
        if (sess.mode === 'group') {
            summary = (await personaReply(sess, sess.chars[0], GROUP_CLOSING)) || '';
        } else {
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

    if (sess.turns > 0) {
        // 后台提炼学习记忆（记忆宫殿管线：提炼→向量化→入库）
        const visible = sess.mode === 'group'
            ? sess.history.map(m => ({
                role: m.speaker === 'user' ? 'user' : 'assistant',
                name: m.speaker === 'user' ? '用户' : ((sess.charsById[m.speaker] || {}).name || '同学'),
                content: m.content,
            }))
            : sess.apiMessages
                .filter(m => m.role !== 'system' && m.content !== OPENING_TRIGGER && m.content !== CLOSING_TRIGGER)
                .map(m => ({ role: m.role, content: m.content }));
        digestSession(sess.subject, visible, state.settings).then(n => {
            if (n > 0) {
                toast(`记下了 ${n} 条学习记忆 🧠`, 'ok');
                if (state.currentSubjectId === sess.subject.id) renderSubjectView();
            }
        });

        // 今日复盘写到 Notion（配置了才会动）
        writeNotionRecap(sess, visible);

        // 自动备份
        const gh = state.settings.github;
        if (gh && gh.token && gh.autoBackup !== false) {
            backupNow(true);
        }
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
    $('btnStartGroup').onclick = openGroupPicker;
    $('btnCloseGroupPick').onclick = () => { $('groupPickModal').hidden = true; };
    $('btnConfirmGroup').onclick = () => {
        const chars = state.characters.filter(c => groupPick.has(c.id));
        if (!chars.length) { toast('至少勾一个同学', 'err'); return; }
        if (chars.length > 4) { toast('最多 4 个，人太多你一句他们四句，遭不住', 'err'); return; }
        $('groupPickModal').hidden = true;
        startGroupReview(chars);
    };
    $('btnCharacters').onclick = () => { renderCharList(); $('charEditor').hidden = true; $('charModal').hidden = false; };
    $('btnCloseChars').onclick = () => { $('charModal').hidden = true; };
    $('btnAddChar').onclick = () => openCharEditor(null);
    $('btnSaveChar').onclick = saveCharacter;
    $('btnCancelChar').onclick = () => { $('charEditor').hidden = true; state.editingCharId = null; };
    $('btnTestEmbed').onclick = async () => {
        const s = readSettingsForm();
        if (!isEmbedConfigured(s.embed)) { toast('向量接口的地址 / 钥匙 / 模型名要填全', 'err'); return; }
        const btn = $('btnTestEmbed');
        btn.disabled = true; btn.textContent = '测试中…';
        try {
            const dim = await testEmbed(s.embed);
            toast(`向量接口正常 ✓（${dim} 维）`, 'ok');
        } catch (e) {
            toast('向量接口不通：' + e.message, 'err');
        } finally {
            btn.disabled = false; btn.textContent = '测试向量接口';
        }
    };
    $('btnTestNotion').onclick = async () => {
        const s = readSettingsForm();
        if (!isNotionConfigured(s.notion)) { toast('Token 和父页面链接都要填', 'err'); return; }
        const btn = $('btnTestNotion');
        btn.disabled = true; btn.textContent = '测试中…';
        try {
            await testNotion(s.notion);
            toast('Notion 连接正常 ✓', 'ok');
        } catch (e) {
            toast('Notion 不通：' + e.message + '（检查 Token，以及父页面是否已连接你的 integration）', 'err');
        } finally {
            btn.disabled = false; btn.textContent = '测试 Notion';
        }
    };
    $('btnFetchModels1').onclick = () => fetchModelsSlot(1);
    $('btnFetchModels2').onclick = () => fetchModelsSlot(2);
    $('api1ModelSelect').onchange = (e) => { if (e.target.value) $('api1Model').value = e.target.value; };
    $('api2ModelSelect').onchange = (e) => { if (e.target.value) $('api2Model').value = e.target.value; };
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
    for (const id of ['settingsModal', 'charModal', 'groupPickModal']) {
        $(id).addEventListener('click', (e) => {
            if (e.target === $(id)) $(id).hidden = true;
        });
    }
}

async function saveSettingsQuiet() {
    const s = readSettingsForm();
    await db.setSetting('api1', s.api1);
    await db.setSetting('api2', s.api2);
    await db.setSetting('embed', s.embed);
    await db.setSetting('notion', s.notion);
    await db.setSetting('github', s.github);
    state.settings = s;
}

async function main() {
    bindEvents();
    await loadSettings();
    await loadCharacters();
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
