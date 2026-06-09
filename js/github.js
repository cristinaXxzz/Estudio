/**
 * GitHub 云备份 —— 思路移植自 SULLYOS 的 utils/githubClient.ts。
 * 区别：复习数据是纯文本 JSON、体积小，所以不用 Releases 传压缩包，
 * 直接用 Contents API 把 backup.json 存进一个【私有】仓库（自动创建）。
 *
 * 国内连不上 github.com 时默认绕道 SULLYOS 已部署的 Cloudflare Worker
 * 中转站（/github 透传，白名单只放行 api.github.com）。
 */

const PROXY_WORKER_URL = 'https://sullyos-worker.cristinazhou0122.workers.dev';
const DEFAULT_REPO = 'estudio-backup';
const BACKUP_PATH = 'backup.json';

const proxify = (url) => `${PROXY_WORKER_URL}/github?url=${encodeURIComponent(url)}`;

/**
 * 统一请求入口。useProxy 默认开（和原仓库一致：国内用户大多直连不了 GitHub）。
 * 走代理时：POST 到 Worker，真实方法放在 X-GitHub-Method 头里。
 */
async function ghRequest(config, fullUrl, method, { headers = {}, body = null } = {}) {
    const auth = {
        'Authorization': `Bearer ${config.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...headers,
    };
    const useProxy = config.useProxy !== false;
    let res;
    if (useProxy) {
        res = await fetch(proxify(fullUrl), {
            method: 'POST',
            headers: { ...auth, 'X-GitHub-Method': method },
            body,
        });
    } else {
        res = await fetch(fullUrl, { method, headers: auth, body });
    }
    return res;
}

async function ghJson(config, fullUrl, method, opts = {}) {
    const res = await ghRequest(config, fullUrl, method, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { }
    if (!res.ok) {
        const msg = (data && data.message) || text.slice(0, 200) || `HTTP ${res.status}`;
        const err = new Error(`GitHub ${method} ${res.status}: ${msg}`);
        err.status = res.status;
        throw err;
    }
    return data;
}

/** UTF-8 安全的 base64 编码（btoa 直接编中文会炸） */
function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

/** 验证 token 并拿到用户名 */
export async function ghWhoami(config) {
    const user = await ghJson(config, 'https://api.github.com/user', 'GET');
    return user.login;
}

/** 确保备份仓库存在；不存在就创建一个【私有】的（备份里含 API 钥匙，绝不能公开） */
async function ensureRepo(config, owner) {
    const repo = config.repo || DEFAULT_REPO;
    try {
        const info = await ghJson(config, `https://api.github.com/repos/${owner}/${repo}`, 'GET');
        return { repo, isPrivate: !!info.private };
    } catch (e) {
        if (e.status !== 404) throw e;
    }
    await ghJson(config, 'https://api.github.com/user/repos', 'POST', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: repo,
            private: true,
            description: 'Estudio 复习系统自动备份（请保持私有）',
            auto_init: false,
        }),
    });
    return { repo, isPrivate: true };
}

/** 上传备份。data 是 exportAll() 出来的对象。返回 { repo, owner, size } */
export async function ghBackup(config, data) {
    if (!config || !config.token) throw new Error('还没填 GitHub Token，请先去设置里填写');
    const owner = await ghWhoami(config);
    const { repo, isPrivate } = await ensureRepo(config, owner);
    if (!isPrivate) {
        throw new Error(`仓库 ${owner}/${repo} 是公开的！备份里含 API 钥匙，请先把它改成私有，或换个仓库名`);
    }
    const json = JSON.stringify(data);
    const contentB64 = utf8ToBase64(json);
    const fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${BACKUP_PATH}`;

    // 已存在的文件更新时必须带上旧版本的 sha
    let sha;
    try {
        const existing = await ghJson(config, fileUrl, 'GET');
        sha = existing && existing.sha;
    } catch (e) {
        if (e.status !== 404) throw e;
    }

    await ghJson(config, fileUrl, 'PUT', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: `Estudio backup ${new Date().toISOString()}`,
            content: contentB64,
            ...(sha ? { sha } : {}),
        }),
    });
    return { repo, owner, size: json.length };
}

/** 从 GitHub 拉回最近一次备份，返回解析好的对象 */
export async function ghRestore(config) {
    if (!config || !config.token) throw new Error('还没填 GitHub Token，请先去设置里填写');
    const owner = await ghWhoami(config);
    const repo = config.repo || DEFAULT_REPO;
    const fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${BACKUP_PATH}`;
    // Accept raw：直接拿原始内容，绕开 Contents API 1MB 的 JSON 包装限制
    const res = await ghRequest(config, fileUrl, 'GET', {
        headers: { 'Accept': 'application/vnd.github.raw+json' },
    });
    if (!res.ok) {
        if (res.status === 404) throw new Error('云端还没有备份（或仓库名填错了）');
        throw new Error(`下载备份失败: HTTP ${res.status}`);
    }
    const text = await res.text();
    return JSON.parse(text);
}
