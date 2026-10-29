import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 扩展位于 <whale>/data/.qqbot-extensions/tools/，上溯三级即 <whale>
const WHALE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VISION_PATH = join(WHALE_ROOT, 'bin', 'whale-vision.mjs');

let mod = null;
async function vision() {
  if (!mod) mod = await import(VISION_PATH);
  return mod;
}
function openDb() {
  return import(join(WHALE_ROOT, 'bin', 'whale-memory-core.mjs')).then((m) => ({
    m,
    db: m.openDb(join(WHALE_ROOT, 'data', 'qqwhale', 'memory.db')),
  }));
}

export default {
  name: 'see_image',
  description:
    '看一张图并描述它（画面+情绪+适合场合）。参数传图片库里的**本地路径**或图片 id；' +
    '不知道路径时先用 list_stickers / sticker_untagged 查。看不到图就直说看不到，不要瞎猜。',
  inputSchema: {
    image: { type: 'string', required: true, description: '表情包库内的本地绝对路径，或 list_stickers 返回的 id' },
  },
  async run(args, env) {
    try {
      const raw = String(args?.image ?? '').trim();
      if (!raw) return { ok: false, msg: 'image 不能为空' };
      let target = raw;
      // 允许传 id：从库索引里换成真实路径（只读，不构造路径）
      if (!raw.includes('/')) {
        const libRoot = join(WHALE_ROOT, 'data', '表情包');
        const idxPath = join(libRoot, 'index.json');
        const { readFileSync } = await import('node:fs');
        try {
          const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
          const item = (idx.items ?? []).find((it) => it.id === raw);
          if (!item) return { ok: false, msg: `图库里没有 id=${raw} 的图片` };
          const dirs = { candidate: 'candidate', library: 'library', negative: 'negative', trash: 'trash' };
          target = join(libRoot, 'lib', dirs[item.layer] ?? 'candidate', `${item.id}.${item.ext}`);
        } catch {
          return { ok: false, msg: '读取图库索引失败' };
        }
      }
      const v = await vision();
      const out = await v.describeImage(target);
      return { ok: true, msg: (out.analysis || out.summary).replace(/\n/g, '；') };
    } catch (e) {
      return { ok: false, msg: `看图失败：${e?.message ?? e}` };
    }
  },
};
