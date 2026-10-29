#!/usr/bin/env python3
"""Apply reviewed restrictions to exactly @zaofan/dsh-qqbot 1.10.9. Fail closed on drift."""
import hashlib
import json
from pathlib import Path
import shutil
import sys

check_only = '--check' in sys.argv[1:]
args = [a for a in sys.argv[1:] if a != '--check']
root = Path(args[0]).resolve()
if json.loads((root / 'package.json').read_text())['version'] != '1.10.9':
    sys.exit('Only reviewed version 1.10.9 is supported; audit another version before deploying.')
policy = Path(__file__).with_name('whale-policy.mjs').read_bytes()
specs = {
    'gateway/bootstrap.js': ('a99574ce4d28e81a1c5e0090f980edd00ffd50b8483f80f63c6202df84a4296b', [
        ('sendMedia: async (target, kind, source) => {',
         'sendMedia: async (target, kind, source) => {\n            source = safeMedia(kind, source, stickerDataDir);'),
    ], "import { safeMedia } from '../whale-policy.mjs';\n"),
    'gateway/middleware-setup.js': ('595af13d983a5f9e50c213966d5f9e1d31858e585344faa286ce89db31631e9a', [
        ("config.access.c2cAllow.length > 0 ? config.access.c2cAllow : ['*']", 'config.access.c2cAllow'),
        ("config.access.groupAllow.length > 0 ? config.access.groupAllow : ['*']", 'config.access.groupAllow'),
        ('onBlock: (_mCtx, reason) => {', "guild: { mode: 'disabled' },\n        onBlock: (_mCtx, reason) => {\n            captureBinding(_mCtx, dataRootOf(config));"),
        ('const all = [...buildCommandList({ manager, config }), ...ext];',
         "const all = buildCommandList({ manager, config }).filter(c => (Array.isArray(c.name) ? c.name : [c.name]).every(n => ['bot-help', 'bot-status', 'bot-reset', 'bot-clear', 'bot-new', 'new', 'bot-stop', 'bot-ping', 'bot-version', '答', 'ans'].includes(n)));"),
    ], "import { captureBinding } from '../whale-policy.mjs';\n"),
    'channel-tools.js': ('9cbe8459bc21f28712b30c5d4dd23b388b44fc2d8c2a1fd15f7eb26906dfeab0', [
        # 收藏入口约束：sticker_tag 的 sticker 参数只允许"图库内已存在的图"。
        # 必须在 lookupId/捕获分支之前拦，否则它会先落盘/先发请求。
        ("                if (!sticker)\n                    return { ok: false, msg: 'sticker 不能为空' };",
         "                if (!sticker)\n                    return { ok: false, msg: 'sticker 不能为空' };\n                safeTagSource(sticker, store.dataDir);"),
        ("description: '群友昵称或 openid'", "description: '仅当前私聊用户，固定传 self；不支持查看他人记忆'"),
        ("deleteMemo(dataRoot, key)", "deleteMemo(join(dataRoot, 'qqwhale-private'), key)"),
        ("appendMemoLine(dataRoot, key, a.line", "appendMemoLine(join(dataRoot, 'qqwhale-private'), key, a.line"),
        ("readMemo(dataRoot, key)", "readMemo(join(dataRoot, 'qqwhale-private'), key)"),
        ('for (const t of toolDefs) {', 'for (const t of toolDefs.filter(t => allowedTools.has(t.name))) {'),
        ('for (const t of qunAdminRef()) {', 'for (const t of []) {'),
        ('for (const t of [...ctxToolsRef(), ...qunAdminRef()]) {', 'for (const t of ctxToolsRef()) {'),
        ("let key = String(a.who || '').trim();", "if (rec?.scope !== 'c2c' || !/^[A-Fa-f0-9]{32}$/.test(String(rec.peerId))) return { ok: false, msg: '私密记忆仅供当前私聊用户使用，群聊不可读取。' };\n                if (![rec.peerId, 'self', 'me', '我', '当前用户'].includes(String(a.who))) return { ok: false, msg: '只允许操作当前私聊用户自己的记忆，who 请传 self。' };\n                let key = rec.peerId;"),
        ("const all = listMemos(dataRoot);\n                return { ok: true, msg: '还没有 ' + a.who + ' 的小传。现有 ' + all.length + ' 份: ' + all.slice(0, 8).map((x) => x.key).join(', ') };", "return { ok: true, msg: '尚未记录当前私聊用户的记忆。' };"),
    ], "import { allowedTools, safeTagSource } from './whale-policy.mjs';\n"),
}
planned = []
for name, (digest, replacements, prefix) in specs.items():
    path = root / 'dist' / name
    raw = path.read_bytes()
    backup = path.with_suffix(path.suffix + '.whale-original')
    original = backup.read_bytes() if backup.exists() else raw
    if hashlib.sha256(original).hexdigest() != digest:
        sys.exit(f'Upstream bytes changed: {name}; no files modified')
    text = original.decode()
    for old, new in replacements:
        if text.count(old) != 1:
            sys.exit(f'Unexpected patch target count: {name}: {old}')
        text = text.replace(old, new)
    patched = ('// QQ Whale policy v1\n' + prefix + text).encode()
    # previous 允许从旧补丁产物平滑升级：v1.1 = 首次部署产物；v1.2 = 加 safeTagSource 前的线上版本
    previous = {'channel-tools.js': '26e80118b64dd59ea4125301f15d180965064cf0b27751fc8eacd904f4c2111c', 'gateway/middleware-setup.js': '13ae55962c812c1e530ace41d9f13ae708583da647c55b564af98fe0473c6b2a'}
    if raw not in (original, patched) and hashlib.sha256(raw).hexdigest() != previous.get(name):
        sys.exit(f'Local changes conflict: {name}; no files modified')
    planned.append((path, backup, original, patched))
if check_only:
    if any(path.read_bytes() != patched for path, _, _, patched in planned):
        sys.exit('Required QQ Whale policy missing; startup refused')
    if (root / 'dist' / 'whale-policy.mjs').read_bytes() != policy:
        sys.exit('QQ Whale policy module mismatch; startup refused')
    print('QQ Whale policy v1 runtime integrity verified')
    sys.exit(0)
for path, backup, original, patched in planned:
    if not backup.exists():
        shutil.copy2(path, backup)
    path.write_bytes(patched)
(root / 'dist' / 'whale-policy.mjs').write_bytes(policy)
print('QQ Whale policy v1 applied and verified (3 pinned modules)')
