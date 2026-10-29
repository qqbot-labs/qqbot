// QQ Whale policy v1. This module runs inside the pinned plugin, before SDK I/O.
import { lstatSync, realpathSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

export const allowedTools = new Set([
  'send_media', 'recall_message', 'text_break', 'list_stickers',
  'sticker_stats', 'sticker_untagged',
  // 收藏/打标：这是"保存照片与表情包"的唯一入口（插件没有独立 save 工具，
  // 自动采集只把图放进候选区，打标才会升入正式库）。它的 sticker 参数原本
  // 接受任意 URL 与任意绝对路径 —— URL 会变成服务端任意请求（SSRF），
  // 路径会变成任意文件读取（可把 /etc 下的文件当图导入）。因此放行的同时
  // 必须由 safeTagSource 限死为"图库内已存在的图"。
  'sticker_tag',
  'people_memo',
]);

// Capture sender IDs for five minutes while access remains disabled. No content or replies.
export function captureBinding(ctx, root) {
  try {
    const until = Number(readFileSync(resolve(root, '.bind-until'), 'utf8'));
    const m = ctx.message;
    if (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + 300000 || !['c2c', 'dm'].includes(m?.kind) ||
        !/^[a-f0-9]{32}$/i.test(m.senderId)) return;
    appendFileSync(resolve(root, '.bind-openids'), m.senderId + '\n', { mode: 0o600 });
  } catch { /* access remains denied even if capture fails */ }
}

export function safeMedia(kind, source, library) {
  if (kind !== 'image' || source?.url || typeof source?.localPath !== 'string') {
    throw new Error('whale policy: only local library images may be sent');
  }
  const root = realpathSync(library);
  const path = resolve(source.localPath);
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..' + sep) || rel === '..' || resolve(root, rel) !== path) {
    throw new Error('whale policy: path is outside image library');
  }
  let current = root;
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('whale policy: symlink rejected');
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 10 * 1024 * 1024 ||
      !/\.(png|jpe?g|gif|webp)$/i.test(path) || realpathSync(path) !== path) {
    throw new Error('whale policy: invalid image file');
  }
  return { localPath: path };
}

// ── 收藏入口的输入约束 ─────────────────────────────────────────────────────
// 插件 StickerStore.capture(url) 会由服务端主动 fetch 任意 URL（SSRF），
// importLocalFile(path) 会读任意绝对路径（任意文件读取）。这里的策略是：
//   · 拒绝一切 http(s) URL —— 入站图片由自动采集（collectEnabled）先行落盘，
//     模型只需用 list_stickers/sticker_untagged 返回的**库内路径**来打标；
//   · 只接受图库根目录之内的真实文件，逐段拒绝符号链接。
// 这样既恢复了"收藏照片/表情包"的能力，又没有把任意读写暴露给 QQ 消息侧。
export function safeTagSource(source, library) {
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error('whale policy: 空的收藏来源');
  }
  const s = source.trim();
  if (/^https?:\/\//i.test(s)) {
    throw new Error('whale policy: 不允许用 URL 收藏（防 SSRF）；请用 list_stickers 给出的库内路径');
  }
  // 纯 id（库内主键）直接放行：lookupId 会解析成库内文件
  if (/^[A-Za-z0-9_-]{6,64}$/.test(s) && !s.includes('/')) return;
  const root = realpathSync(library);
  const path = resolve(s);
  // 用 realpath 做包含性判定：任何指向库外的符号链接（含父目录是符号链接的情况，
  // 例如 macOS 的 /tmp → /private/tmp）都会在 realpath 时被解析到真实位置，
  // 从而被下面的前缀检查拒绝；指向库内的链接则无害。
  // 早期写成"逐段 lstat 拒绝符号链接 + 字符串前缀"，会把 /tmp 这类合法路径误拒。
  let real;
  try {
    real = realpathSync(path);
  } catch {
    throw new Error('whale policy: 图库里没有这个文件');
  }
  const rel = relative(root, real);
  if (!rel || rel === '..' || rel.startsWith('..' + sep)) {
    throw new Error('whale policy: 只能收藏图库内的图片');
  }
  if (!lstatSync(real).isFile()) throw new Error('whale policy: 不是普通文件');
}
