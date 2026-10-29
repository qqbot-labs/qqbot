import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Extensions live under <whale>/data/.qqbot-extensions/tools/.
const WHALE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE_PATH = join(WHALE_ROOT, 'bin', 'persona-prefs-core.mjs');
const PREFS_PATH = join(WHALE_ROOT, 'data', 'qqwhale', 'persona-preferences.json');
const PROACTIVE_PATH = join(WHALE_ROOT, 'etc', 'proactive.json');

function ownerPeer() {
  try {
    const p = JSON.parse(readFileSync(PROACTIVE_PATH, 'utf8'));
    return /^[A-Fa-f0-9]{32}$/.test(String(p?.peer ?? '')) ? String(p.peer) : '';
  } catch { return ''; }
}

function who(env) {
  const caps = env?.caps ?? {};
  const peer = caps?.peer?.peerId ?? caps?.peer?.openid ?? '';
  const scope = caps?.peer?.scope ?? '';
  return { peer: String(peer || ''), scope: String(scope || '') };
}

export default {
  name: 'persona_remember',
  description:
    '持续保存主人明确表达的稳定偏好、个人事实、共同设定、称呼与关系约定，重启或换会话仍作为回复参考。' +
    '不必等用户每次说“记住”；出现新的长期信息就保存，普通闲聊、临时情绪和猜测不记成事实。' +
    '原意来自用户，不能把自己编的设定或对用户的猜测保存为真实事实。更正旧设定时用相同key或replace_id更新；扮演设定用setting，与现实fact分开。',
  inputSchema: {
    text: { type: 'string', required: true, description: '用户明确表达的长期要求，保留原意' },
    kind: { type: 'string', description: 'preference偏好 / fact用户事实 / setting共同扮演设定 / relationship关系约定' },
    key: { type: 'string', description: '稳定主题键，例如称呼、奶茶口味、工作作息；同一主题沿用原key以更正旧值，不另造一条冲突记录' },
    replace_id: { type: 'string', description: '更正已有记录时传注入上下文里的p-编号；可省略' },
    confirm: { type: 'boolean', description: '已授权的明确长期信息固定传true即可保存，无需再向用户确认' },
  },
  async run(args, env) {
    try {
      if (args?.confirm !== true) return { ok: false, msg: '需要确认：请传 confirm=true 再写入长期偏好' };
      const text = String(args?.text ?? '').trim();
      if (!text) return { ok: false, msg: 'text 不能为空' };
      const { scope, peer } = who(env);
      const owner = ownerPeer();
      if (scope !== 'c2c' || !owner || peer !== owner) return { ok: false, msg: '长期偏好只允许主人本人的私聊使用' };
      const core = await import(CORE_PATH);
      const result = await core.add(PREFS_PATH, text, 'chat', {kind:args.kind,key:args.key,replaceId:args.replace_id});
      return {
        ok: true,
        msg: result.duplicate
          ? `这条长期偏好已经存在，无需重复记录：${result.item.text}`
          : `${result.updated?'已更正':'已保存'}长期设定，后续对话会参考：${result.item.text}`,
        id: result.item.id,
      };
    } catch (error) {
      return { ok: false, msg: `写入长期偏好失败：${error?.message ?? error}` };
    }
  },
};
