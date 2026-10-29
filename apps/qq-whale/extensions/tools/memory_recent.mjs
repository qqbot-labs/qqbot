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
  name: 'memory_recent',
  description:
    '按时间倒序列出与当前对方的最近 N 条历史对话（含本条之前的内容）。' +
    '用于快速接上话、确认"上次聊到哪"。',
  inputSchema: {
    limit: { type: 'number', description: '条数，默认 10，最多 50' },
  },
  async run(args, env) {
    try {
      const { peer, scope } = who(env);
      if (scope !== 'c2c' || !/^[A-Fa-f0-9]{32}$/.test(peer)) return { ok: false, msg: '缺少可信私聊身份，无法访问记忆。' };
      if (scope === 'group') return { ok: false, msg: '群聊不支持读取个人最近对话' };
      const { m, db } = await open();
      try {
        const rows = m.recentMessages(db, { peer, limit: Number(args?.limit) || 10 });
        if (!rows.length) return { ok: true, msg: '记忆库里还没有这个人的历史记录。' };
        const lines = rows.map(
          (r) => `- [${r.id}] ${m.fmtTime(r.ts)}${r.sender_name ? ` ${r.sender_name}:` : ''} ${m.clip(r.text, 140)}`,
        );
        return { ok: true, msg: `最近 ${rows.length} 条：\n${lines.join('\n')}` };
      } finally {
        try { db.close(); } catch {}
      }
    } catch (e) {
      return { ok: false, msg: `读取失败：${e?.message ?? e}` };
    }
  },
};
