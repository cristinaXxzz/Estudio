/**
 * AI 接口调用层 —— 从 SULLYOS 的 utils/safeApi.ts 移植。
 * 防 HTML 错误页、防伪流式响应、自动重试，外加本项目的"双 API"逻辑：
 *   - API 1 是主力（聊天用）
 *   - API 2 填了的话：评估打分走 API 2、拆知识点时两个接口并行干活，
 *     主力挂了还能自动切到 API 2 兜底
 */

// ---------- 安全解析（移植自 safeApi.ts） ----------

async function safeResponseJson(response) {
    const text = await response.text();
    const trimmed = text.trimStart();
    if (trimmed.startsWith('<')) {
        const titleMatch = trimmed.match(/<title>(.*?)<\/title>/i);
        const hint = titleMatch ? titleMatch[1] : trimmed.slice(0, 120);
        throw new Error(`API返回了HTML而非JSON (HTTP ${response.status}): ${hint}`);
    }
    if (!trimmed) throw new Error(`API返回了空响应 (HTTP ${response.status})`);
    // 有些代理无视 stream:false 强行返回 SSE 流，把增量拼回完整回复
    if (trimmed.startsWith('data:')) {
        const assembled = parseSseToCompletion(text);
        if (assembled) return assembled;
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`API返回了无效JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
}

function parseSseToCompletion(raw) {
    let assembled = '';
    let role = 'assistant';
    let finishReason = null;
    let firstChunk = null;
    let usage;
    let gotAnyChunk = false;
    for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        gotAnyChunk = true;
        if (!firstChunk) firstChunk = chunk;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        if (choice.delta) {
            if (typeof choice.delta.content === 'string') assembled += choice.delta.content;
            if (choice.delta.role) role = choice.delta.role;
        } else if (choice.message) {
            if (typeof choice.message.content === 'string') assembled += choice.message.content;
            if (choice.message.role) role = choice.message.role;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    if (!gotAnyChunk) return null;
    return {
        id: (firstChunk && firstChunk.id) || 'sse-assembled',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role, content: assembled }, finish_reason: finishReason }],
        usage: usage || (firstChunk && firstChunk.usage),
    };
}

export async function safeFetchJson(url, options, maxRetries = 2, timeoutMs = 0) {
    const retryableStatuses = new Set([429, 500, 502, 503, 504]);
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let attemptOptions = options;
        let timeoutHandle = null;
        if (timeoutMs > 0) {
            const ac = new AbortController();
            timeoutHandle = setTimeout(() => ac.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
            attemptOptions = { ...options, signal: ac.signal };
        }
        try {
            const response = await fetch(url, attemptOptions);
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (!response.ok) {
                if (retryableStatuses.has(response.status) && attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
                    continue;
                }
                const data = await safeResponseJson(response).catch(e => { throw e; });
                const errMsg = (data && data.error && (data.error.message || data.error)) || `HTTP ${response.status}`;
                throw new Error(`API Error ${response.status}: ${errMsg}`);
            }
            return await safeResponseJson(response);
        } catch (e) {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            lastError = e;
            const isAbort = (e && e.name === 'AbortError') || /aborted|timeout/i.test((e && e.message) || '');
            const isNetwork = e && e.name === 'TypeError';
            const isHtml = e && e.message && e.message.includes('API返回了HTML');
            if ((isNetwork || isAbort || isHtml) && attempt < maxRetries) {
                await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
                continue;
            }
            throw e;
        }
    }
    throw lastError || new Error('API请求失败');
}

export function extractContent(data) {
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    let text = (msg && msg.content) || '';
    if (!text.trim()) text = (msg && msg.reasoning_content) || '';
    text = text.replace(/<(think|thinking|thought)>[\s\S]*?<\/\1>/gi, '');
    text = text.replace(/<(?:think|thinking|thought)>[\s\S]*$/gi, '');
    return text.trim();
}

/** 从 AI 输出的文字里硬抠出 JSON（容忍代码块包裹、前后废话、尾逗号等）。移植自 safeApi.ts。 */
export function extractJson(raw) {
    if (!raw) return null;
    let text = raw
        .replace(/^```(?:json|JSON)?\s*\n?/gm, '')
        .replace(/\n?```\s*$/gm, '')
        .trim();
    try { return JSON.parse(text); } catch { }
    const objMatch = text.match(/(\{[\s\S]*\})/);
    const arrMatch = text.match(/(\[[\s\S]*\])/);
    let jsonStr = '';
    if (objMatch && arrMatch) {
        jsonStr = (text.indexOf(objMatch[1]) <= text.indexOf(arrMatch[1])) ? objMatch[1] : arrMatch[1];
    } else {
        jsonStr = (objMatch && objMatch[1]) || (arrMatch && arrMatch[1]) || '';
    }
    if (!jsonStr) return null;
    try { return JSON.parse(jsonStr); } catch { }
    const fixed = jsonStr
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
    try { return JSON.parse(fixed); } catch { }
    console.error('[extractJson] 解析失败. Raw:', raw.slice(0, 300));
    return null;
}

// ---------- 双 API ----------

function normalizeBaseUrl(baseUrl) {
    let u = (baseUrl || '').trim().replace(/\/+$/, '');
    // 用户可能填 https://xxx.com 或 https://xxx.com/v1，都兼容
    if (!/\/v\d+$/.test(u) && !/chat\/completions$/.test(u)) u += '/v1';
    return u;
}

export function isApiConfigured(cfg) {
    return !!(cfg && cfg.baseUrl && cfg.apiKey && cfg.model);
}

/** 对单个 API 配置发起一次 chat 调用，返回纯文本回复 */
export async function chatOnce(cfg, messages, { temperature = 0.85, maxTokens = 2048, timeoutMs = 90000 } = {}) {
    if (!isApiConfigured(cfg)) throw new Error('API 未配置（地址/钥匙/模型名有缺）');
    const url = `${normalizeBaseUrl(cfg.baseUrl)}/chat/completions`;
    const data = await safeFetchJson(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
            model: cfg.model,
            messages,
            temperature,
            max_tokens: maxTokens,
            stream: false,
        }),
    }, 2, timeoutMs);
    const content = extractContent(data);
    if (!content) throw new Error('API 返回了空回复');
    return content;
}

/**
 * 主聊天调用：优先 API 1，挂了自动切 API 2 兜底。
 * 返回 { text, usedApi }（usedApi 为 1 或 2）
 */
export async function chatWithFallback(api1, api2, messages, opts = {}) {
    const has1 = isApiConfigured(api1);
    const has2 = isApiConfigured(api2);
    if (!has1 && !has2) throw new Error('两个 API 都没配置，请先去设置里填写');
    if (has1) {
        try {
            return { text: await chatOnce(api1, messages, opts), usedApi: 1 };
        } catch (e) {
            if (!has2) throw e;
            console.warn('[API] 主力 API 失败，切换到 API 2 兜底:', e.message);
        }
    }
    return { text: await chatOnce(api2, messages, opts), usedApi: 2 };
}

/** 评估/打分调用：优先 API 2（让主力专心聊天），没配 API 2 就用 API 1 */
export async function chatForJudge(api1, api2, messages, opts = {}) {
    const cfg = isApiConfigured(api2) ? api2 : api1;
    return chatOnce(cfg, messages, { temperature: 0.2, maxTokens: 1500, ...opts });
}

/**
 * 双 API 并行跑任务（拆知识点用）：
 * tasks 是一组"给我一个 cfg 我就能干活"的函数，两个 API 各领一个队列同时消化。
 * onProgress(done, total) 用来画进度条。
 */
export async function runTasksDualApi(api1, api2, tasks, onProgress) {
    const workers = [];
    if (isApiConfigured(api1)) workers.push(api1);
    if (isApiConfigured(api2)) workers.push(api2);
    if (workers.length === 0) throw new Error('两个 API 都没配置，请先去设置里填写');

    const results = new Array(tasks.length);
    const errors = [];
    let next = 0;
    let done = 0;

    async function runWorker(cfg) {
        while (true) {
            const i = next++;
            if (i >= tasks.length) return;
            try {
                results[i] = await tasks[i](cfg);
            } catch (e) {
                // 这个分片失败了，换另一个 API 再试一次
                const other = workers.find(w => w !== cfg);
                if (other) {
                    try { results[i] = await tasks[i](other); }
                    catch (e2) { errors.push(e2); }
                } else {
                    errors.push(e);
                }
            }
            done++;
            if (onProgress) onProgress(done, tasks.length);
        }
    }

    await Promise.all(workers.map(runWorker));
    return { results, errors };
}

/** 拉取这个接口支持的模型列表（OpenAI 兼容的 GET /models） */
export async function fetchModels(cfg) {
    if (!cfg || !cfg.baseUrl || !cfg.apiKey) throw new Error('先把接口地址和 API Key 填好再拉取');
    const url = `${normalizeBaseUrl(cfg.baseUrl)}/models`;
    const data = await safeFetchJson(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${cfg.apiKey}` },
    }, 1, 20000);
    const list = Array.isArray(data) ? data : (data.data || data.models || []);
    const ids = list
        .map(m => (typeof m === 'string' ? m : (m.id || m.model || m.name)))
        .filter(Boolean);
    if (!ids.length) throw new Error('这个接口没返回模型列表（也可能不支持拉取，手动填模型名即可）');
    return [...new Set(ids)].sort();
}

/** 测试某个 API 配置能不能用 */
export async function testApi(cfg) {
    const text = await chatOnce(cfg, [
        { role: 'user', content: '请只回复两个字：正常' },
    ], { temperature: 0, maxTokens: 100, timeoutMs: 30000 });
    return text;
}
