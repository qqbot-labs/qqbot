import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  name: 'persona_forget',
  description:
    '删除一条长期人格偏好。用户明确说“忘掉这条要求/以后不用遵守这个/删掉这个偏好”时使用，' +
    '可传偏好 id 或与偏好原文一致的 text；用户明确要求忘掉时直接传confirm=true，无需重复询问。只删除长期偏好，不删除聊天记忆。',
  inputSchema: {
    id: { type: 'string', description: '长期偏好 id（管理台或写入结果中可见）' },
    text: { type: 'string', description: '偏好原文（与记录一致时按文本删除）' },
    confirm: { type: 'boolean', description: '必须为 true 才删除' },
  },
  async run(args, env) {
    try {
      if (args?.confirm !== true) return { ok: false, msg: '需要确认：请传 confirm=true 再删除长期偏好' };
      const { scope, peer } = who(env);
      const owner = ownerPeer();
      if (scope !== 'c2c' || !owner || peer !== owner) return { ok: false, msg: '长期偏好只允许主人本人的私聊管理' };
      const id = String(args?.id ?? '').trim();
      const text = String(args?.text ?? '').trim();
      if (!id && !text) return { ok: false, msg: '请提供要删除的 id 或原文' };
      const core = await import(CORE_PATH);
      const result = await core.remove(PREFS_PATH, { id: id || undefined, text: text || undefined });
      return result.removed
        ? { ok: true, msg: `已删除长期人格偏好：${result.item.text}` }
        : { ok: false, msg: '没有找到对应的长期偏好，可能已被删除' };
    } catch (error) {
      return { ok: false, msg: `删除长期偏好失败：${error?.message ?? error}` };
    }
  },
};
