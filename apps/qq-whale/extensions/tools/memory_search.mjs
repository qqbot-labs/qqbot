import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 扩展位于 <whale>/data/.qqbot-extensions/tools/，上溯三级即 <whale>
const WHALE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE_PATH = join(WHALE_ROOT, 'bin', 'whale-memory-core.mjs');
const DB_PATH = join(WHALE_ROOT, 'data', 'qqwhale', 'memory.db');

let mod = null;
async function core() {
  if (!mod) mod = await import(CORE_PATH);
  return mod;
}

function open() {
  return core().then((m) => ({ m, db: m.openDb(DB_PATH) }));
}

/** 当前会话身份：只有当前 peer 的私有记忆可读，群聊一律不给跨人检索。 */
function who(env) {
  const caps = env?.caps ?? {};
  const peer = caps?.peer?.peerId ?? caps?.peer?.openid ?? '';
  const scope = caps?.peer?.scope ?? '';
  return { peer: String(peer || ''), scope: String(scope || '') };
}

export default {
  name: 'memory_search',
  description:
    '检索长期记忆库里的历史对话原文（独立于当前上下文，压缩/重启后仍在）。' +
    '想知道"他以前说过什么""这件事之前聊过吗"时用。只检索当前私聊对象的历史，' +
    '返回带时间的原文片段。查不到就如实说没记录，不要编造。',
  inputSchema: {
    q: { type: 'string', required: true, description: '关键词或短语，中文可直接搜' },
    limit: { type: 'number', description: '返回条数，默认 5，最多 20' },
  },
  async run(args, env) {
    try {
      const q = String(args?.q ?? '').trim();
      if (!q) return { ok: false, msg: 'q 不能为空' };
      const { peer, scope } = who(env);
      if (scope !== 'c2c' || !/^[A-Fa-f0-9]{32}$/.test(peer)) return { ok: false, msg: '缺少可信私聊身份，无法访问记忆。' };
      if (scope === 'group') return { ok: false, msg: '群聊不支持跨人检索长期记忆' };
      const { m, db } = await open();
      try {
        const rows = m.searchMessages(db, { q, peer, limit: Number(args?.limit) || 5 });
        if (!rows.length) return { ok: true, msg: `没有找到与「${m.clip(q, 30)}」相关的历史记录。` };
        const lines = rows.map(
          (r) => `- [${r.id}] ${m.fmtTime(r.ts)}${r.sender_name ? ` ${r.sender_name}:` : ''} ${m.clip(r.text, 160)}`,
        );
        return { ok: true, msg: `找到 ${rows.length} 条：\n${lines.join('\n')}` };
      } finally {
        try { db.close(); } catch {}
      }
    } catch (e) {
      return { ok: false, msg: `检索失败：${e?.message ?? e}` };
    }
  },
};
