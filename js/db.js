/**
 * IndexedDB 数据层。所有数据都存在用户自己的浏览器里（本地优先），
 * 思路沿用 SULLYOS 的 db.ts，但只保留复习系统需要的六张表。
 */

const DB_NAME = 'estudio-db';
const DB_VERSION = 1;

let _db = null;

export function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('kv')) {
                db.createObjectStore('kv'); // 设置项：key → value
            }
            if (!db.objectStoreNames.contains('subjects')) {
                db.createObjectStore('subjects', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('files')) {
                const s = db.createObjectStore('files', { keyPath: 'id' });
                s.createIndex('bySubject', 'subjectId');
            }
            if (!db.objectStoreNames.contains('points')) {
                const s = db.createObjectStore('points', { keyPath: 'id' });
                s.createIndex('bySubject', 'subjectId');
                s.createIndex('byFile', 'fileId');
            }
            if (!db.objectStoreNames.contains('sessions')) {
                const s = db.createObjectStore('sessions', { keyPath: 'id' });
                s.createIndex('bySubject', 'subjectId');
            }
        };
        req.onsuccess = () => { _db = req.result; resolve(_db); };
        req.onerror = () => reject(req.error);
    });
}

function tx(storeName, mode, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        const out = fn(store);
        t.oncomplete = () => resolve(out && out.__result !== undefined ? out.__result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('transaction aborted'));
    }));
}

function reqToPromise(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- 通用 CRUD ----------

export async function put(storeName, obj) {
    await tx(storeName, 'readwrite', s => s.put(obj));
    return obj;
}

export async function get(storeName, key) {
    const db = await openDB();
    return reqToPromise(db.transaction(storeName).objectStore(storeName).get(key));
}

export async function getAll(storeName) {
    const db = await openDB();
    return reqToPromise(db.transaction(storeName).objectStore(storeName).getAll());
}

export async function getByIndex(storeName, indexName, value) {
    const db = await openDB();
    return reqToPromise(
        db.transaction(storeName).objectStore(storeName).index(indexName).getAll(value)
    );
}

export async function del(storeName, key) {
    await tx(storeName, 'readwrite', s => s.delete(key));
}

export async function clear(storeName) {
    await tx(storeName, 'readwrite', s => s.clear());
}

// ---------- 设置 ----------

export async function getSetting(key, fallback = null) {
    const db = await openDB();
    const v = await reqToPromise(db.transaction('kv').objectStore('kv').get(key));
    return v === undefined ? fallback : v;
}

export async function setSetting(key, value) {
    await tx('kv', 'readwrite', s => s.put(value, key));
}

// ---------- 级联删除：删科目时连带删文件/知识点/记录 ----------

export async function deleteSubjectCascade(subjectId) {
    const [files, points, sessions] = await Promise.all([
        getByIndex('files', 'bySubject', subjectId),
        getByIndex('points', 'bySubject', subjectId),
        getByIndex('sessions', 'bySubject', subjectId),
    ]);
    for (const f of files) await del('files', f.id);
    for (const p of points) await del('points', p.id);
    for (const s of sessions) await del('sessions', s.id);
    await del('subjects', subjectId);
}

export async function deleteFileCascade(fileId) {
    const points = await getByIndex('points', 'byFile', fileId);
    for (const p of points) await del('points', p.id);
    await del('files', fileId);
}

// ---------- 整库导出 / 导入（备份用）----------

export async function exportAll() {
    const [subjects, files, points, sessions] = await Promise.all([
        getAll('subjects'), getAll('files'), getAll('points'), getAll('sessions'),
    ]);
    const settings = {};
    for (const key of ['api1', 'api2', 'github']) {
        settings[key] = await getSetting(key);
    }
    return {
        app: 'estudio',
        version: 1,
        timestamp: Date.now(),
        settings, subjects, files, points, sessions,
    };
}

export async function importAll(data) {
    if (!data || data.app !== 'estudio') throw new Error('这不是 Estudio 的备份文件');
    await clear('subjects'); await clear('files');
    await clear('points'); await clear('sessions');
    for (const x of data.subjects || []) await put('subjects', x);
    for (const x of data.files || []) await put('files', x);
    for (const x of data.points || []) await put('points', x);
    for (const x of data.sessions || []) await put('sessions', x);
    if (data.settings) {
        for (const key of ['api1', 'api2', 'github']) {
            if (data.settings[key]) await setSetting(key, data.settings[key]);
        }
    }
}
