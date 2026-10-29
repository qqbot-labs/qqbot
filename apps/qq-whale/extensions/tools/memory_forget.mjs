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
  name: 'memory_forget',
  description:
    '删除一条记忆（软删除，可审计恢复）。用户明确要求"忘掉这条/删掉这条记录"时用；' +
    'id 来自 memory_search / memory_recent 的方括号编号。只能删当前对方与自己相关的记录。',
  inputSchema: {
    id: { type: 'number', required: true, description: '要遗忘的消息 id（方括号里的数字）' },
    confirm: { type: 'boolean', description: '必须为 true 才执行删除' },
  },
  async run(args, env) {
    try {
      if (args?.confirm !== true) return { ok: false, msg: '需要确认：请传 confirm=true 再执行删除' };
      const id = Number(args?.id);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, msg: 'id 必须是正整数' };
      const { peer, scope } = who(env);
      if (scope !== 'c2c' || !/^[A-Fa-f0-9]{32}$/.test(peer)) return { ok: false, msg: '缺少可信私聊身份，无法访问记忆。' };
      if (scope === 'group') return { ok: false, msg: '群聊不支持删除个人记忆' };
      const { m, db } = await open();
      try {
        // 权限校验：只允许删属于当前对方的记录（防跨人删除）
        const row = db.prepare('SELECT peer FROM msg WHERE id = ?').get(id);
        if (!row) return { ok: false, msg: `没有 id=${id} 的记录` };
        if (row.peer !== peer) return { ok: false, msg: '只能删除与你自己的对话记录' };
        const ok = m.forget(db, { table: 'msg', id });
        return { ok: true, msg: ok ? `已遗忘 id=${id}（软删除，可从备份审计恢复）` : `id=${id} 已删除或不存在` };
      } finally {
        try { db.close(); } catch {}
      }
    } catch (e) {
      return { ok: false, msg: `删除失败：${e?.message ?? e}` };
    }
  },
};
