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
  name: 'memory_stats',
  description: '查看长期记忆库规模（消息条数、人数、时间跨度）。想确认"到底记住了多少"时用。',
  inputSchema: {},
  async run(_args, env) {
    try {
      const { peer, scope } = who(env);
      if (scope !== 'c2c' || !/^[A-Fa-f0-9]{32}$/.test(peer)) return { ok: false, msg: '缺少可信私聊身份，无法访问记忆。' };
      const { m, db } = await open();
      try {
        const count = db.prepare('SELECT count(*) n,sum(deleted=0) active,min(ts) firstTs,max(ts) lastTs FROM msg WHERE peer=? AND scope=?').get(peer, 'c2c');
        const s = { messages: count.active || 0, messagesTotal: count.n, peers: count.n ? 1 : 0, memories: db.prepare('SELECT count(*) n FROM memory WHERE peer=? AND deleted=0').get(peer).n, firstTs: count.firstTs, lastTs: count.lastTs };
        return {
          ok: true,
          msg:
            `记忆库：${s.messages} 条消息（含软删除共 ${s.messagesTotal}）、${s.peers} 个对话对象、` +
            `${s.memories} 条提炼记忆；时间跨度 ${m.fmtTime(s.firstTs)} ~ ${m.fmtTime(s.lastTs)}。`,
        };
      } finally {
        try { db.close(); } catch {}
      }
    } catch (e) {
      return { ok: false, msg: `读取失败：${e?.message ?? e}` };
    }
  },
};
