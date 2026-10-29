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
    '把用户明确说出的长期指令、称呼、偏好、禁忌或记忆要求写入人格偏好，后续每轮都会生效。' +
    '只在用户明确说“记住/以后都/每次/不要/必须/叫我/称呼我/我的名字是”等长期要求时调用；' +
    '不要保存一次性的情绪、临时任务、猜测或用户没有说过的内容。只保存原意，不得扩写。',
  inputSchema: {
    text: { type: 'string', required: true, description: '用户明确表达的长期要求，最多300字' },
    confirm: { type: 'boolean', description: '必须为 true 才写入' },
  },
  async run(args, env) {
    try {
      if (args?.confirm !== true) return { ok: false, msg: '需要确认：请传 confirm=true 再写入长期偏好' };
      const text = String(args?.text ?? '').trim();
      if (!text) return { ok: false, msg: 'text 不能为空' };
      if (text.length > 300) return { ok: false, msg: '长期偏好最多 300 字，请精简后再写入' };
      const { scope, peer } = who(env);
      const owner = ownerPeer();
      if (scope !== 'c2c' || !owner || peer !== owner) return { ok: false, msg: '长期偏好只允许主人本人的私聊使用' };
      const core = await import(CORE_PATH);
      const result = await core.add(PREFS_PATH, text, 'chat');
      return {
        ok: true,
        msg: result.duplicate
          ? `这条长期偏好已经存在，无需重复记录：${result.item.text}`
          : `已写入长期人格偏好，后续对话会遵守：${result.item.text}`,
        id: result.item.id,
      };
    } catch (error) {
      return { ok: false, msg: `写入长期偏好失败：${error?.message ?? error}` };
    }
  },
};
