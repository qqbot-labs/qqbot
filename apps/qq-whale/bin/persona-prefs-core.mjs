/**
 * persona-prefs-core.mjs — durable user persona preferences.
 *
 * The file is deliberately small and human-readable. It is shared by:
 *   - the private-chat tool persona_remember/persona_forget (qqwhale);
 *   - the inbound memory extension (injects the block every turn);
 *   - the admin console (review/add/delete).
 *
 * All writes use the same lock directory so a chat write and an admin edit
 * cannot lose each other's update.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_PREFS_FILE = '/home/qqwhale/whale/data/qqwhale/persona-preferences.json';
export const MAX_ITEMS = 0;
export const MAX_CHARS = 0;

export function normalizePreference(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function lockPath(file) {
    return file + '.lock';
}

async function acquire(file) {
    const lock = lockPath(file);
    for (let i = 0; i < 100; i += 1) {
        try {
            mkdirSync(lock, { mode: 0o700 });
            return () => {
                try { rmSync(lock, { recursive: true, force: true }); } catch { /* ignore */ }
            };
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            try {
                const st = statSync(lock);
                if (Date.now() - st.mtimeMs > 10000) {
                    rmSync(lock, { recursive: true, force: true });
                    continue;
                }
            } catch { /* lock disappeared */ }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
    throw new Error('人格偏好文件正在更新，请稍后重试');
}

function cleanItems(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const text = normalizePreference(item.text);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            id: /^p-[0-9]+-[a-z0-9]+$/.test(String(item.id)) ? String(item.id) : `p-${Number(item.ts) || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            ts: Number(item.ts) || Date.now(),
            text,
            source: ['chat', 'chat-auto', 'admin'].includes(item.source) ? item.source : 'chat',
            kind: ['preference','fact','setting','relationship'].includes(item.kind) ? item.kind : 'preference',
            key: normalizePreference(item.key),
            history: Array.isArray(item.history) ? item.history.filter(h => h && typeof h.text === 'string' && Number.isFinite(h.ts)) : [],
        });
    }
    return out;
}

function read(file) {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        return cleanItems(parsed?.items);
    } catch {
        return [];
    }
}

export function loadRevoked(file = DEFAULT_PREFS_FILE) {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        return Array.isArray(parsed.revoked) ? parsed.revoked.filter(x => x && typeof x.key === 'string' && x.key) : [];
    } catch { return []; }
}

function write(file, items, revoked = loadRevoked(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({ version: 1, items: cleanItems(items), revoked }, null, 2) + '\n';
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, payload, { mode: 0o600 });
    try {
        const fd = openSync(tmp, 'r');
        fsyncSync(fd);
        closeSync(fd);
    } catch { /* fsync is best-effort */ }
    renameSync(tmp, file);
}

export function load(file = DEFAULT_PREFS_FILE) {
    return read(file);
}

export async function add(file, text, source = 'chat', options = {}) {
    const value = normalizePreference(text);
    if (!value) throw new Error('偏好内容不能为空');
    if (value.includes('\0')) throw new Error('偏好内容包含非法字符');
    const release = await acquire(file);
    try {
        const items = read(file);
        const key = normalizePreference(options.key);
        const previous = options.replaceId ? items.find(item => item.id === options.replaceId)
            : key ? items.find(item => item.key === key) : undefined;
        if (options.replaceId && !previous) throw new Error('要更正的长期设定不存在，请先核对编号');
        const duplicate = items.find((item) => item.text.toLowerCase() === value.toLowerCase());
        if (duplicate) return { item: duplicate, duplicate: true };
        const item = {
            id: previous?.id || `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            ts: Date.now(),
            text: value,
            source: ['chat', 'chat-auto', 'admin'].includes(source) ? source : 'chat',
            kind: ['preference','fact','setting','relationship'].includes(options.kind) ? options.kind : previous?.kind || 'preference',
            key: key || previous?.key || '',
            history: previous ? [...(previous.history || []), {ts:previous.ts,text:previous.text}] : [],
        };
        if (previous) items.splice(items.indexOf(previous), 1);
        items.push(item);
        write(file, items, loadRevoked(file).filter(x => !key || x.key !== key));
        return { item, duplicate: false, updated: !!previous };
    } finally {
        release();
    }
}

export async function remove(file, { id, text } = {}) {
    const release = await acquire(file);
    try {
        const items = read(file);
        const wantedText = normalizePreference(text).toLowerCase();
        const index = items.findIndex((item) => (id && item.id === id) || (!id && wantedText && item.text.toLowerCase() === wantedText));
        if (index < 0) return { removed: false };
        const [item] = items.splice(index, 1);
        const revoked = loadRevoked(file).filter(x => !item.key || x.key !== item.key);
        if (item.key) revoked.push({key:item.key,kind:item.kind,ts:Date.now()});
        write(file, items, revoked);
        return { removed: true, item };
    } finally {
        release();
    }
}

export function exists(file = DEFAULT_PREFS_FILE) {
    return existsSync(file);
}
