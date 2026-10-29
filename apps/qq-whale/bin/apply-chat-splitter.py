#!/usr/bin/env python3
"""Install/check the reviewed chat path in dsh-qqbot 1.10.9, including legacy VPS v3."""
import argparse
import hashlib
import json
from pathlib import Path

DIGEST = '59c90dbf47c12a6ba41da5408166786718f77c0d4da9734f8887abb82cdaa318'
LEGACY_V3 = '2fe95938dd6b93ea999faeda23f452f5fe218d82812ee7e302964b8b6edacdf9'
MARKER = '// QQ Whale chat splitter v4\n'


def patched(original):
    digest = hashlib.sha256(original).hexdigest()
    text = original.decode()
    if digest == DIGEST:
        replacements = [
            ('refLookup) {\n    // 引用消息', 'refLookup, normalizeChat = true) {\n    // 引用消息'),
            ("const chunks = chunkMarkdownText(clean, limit).map((c) => String(c || '')).filter((c) => c.trim());",
             "const messages = normalizeChat ? splitChatMessages(clean, readChatConfig()) : [clean];\n"
             "            const chunks = [];\n"
             "            for (const [mi, part] of messages.entries()) {\n"
             "                const parts = chunkMarkdownText(part, limit).map((c) => String(c || '')).filter((c) => c.trim());\n"
             "                for (const [ci, text] of parts.entries()) chunks.push({text, semanticGap: mi < messages.length - 1 && ci === parts.length - 1});\n"
             "            }"),
            ('const chunk = chunks[ci];', 'const {text: chunk, semanticGap} = chunks[ci];'),
            ('setTimeout(r, 500)', 'setTimeout(r, semanticGap ? messageDelay(chunk, readChatConfig()) : 500)'),
        ]
        imports = "import { splitChatMessages } from './chat-splitter.js';\n"
    elif digest == LEGACY_V3:
        # This deployed version had extra paragraph-to-comma normalization and pacing.
        replacements = [
            ("import { normalizeChatText } from './chat-format.js';\n", ''),
            ('splitChatMessages(clean)', 'splitChatMessages(clean, readChatConfig())'),
            ('const display = normalizeChat ? normalizeChatText(messages[mi]) : messages[mi];',
             'const display = messages[mi];'),
            ('Math.min(1200, 450 + chunk.length * 4)', 'messageDelay(chunk, readChatConfig())'),
        ]
        imports = ''
    else:
        raise ValueError('Upstream/local outbound bytes changed; review before installing')
    for old, new in replacements:
        if text.count(old) != 1:
            raise ValueError('Unexpected outbound integration point: ' + old)
        text = text.replace(old, new)
    return (MARKER + imports + "import { readChatConfig, messageDelay } from './chat-delivery.js';\n" + text).encode()


def apply(root, check=False):
    package = json.loads((root / 'package.json').read_text())
    if (package.get('name'), package.get('version')) != ('@zaofan/dsh-qqbot', '1.10.9'):
        raise ValueError('Only reviewed @zaofan/dsh-qqbot 1.10.9 is supported')
    target = root / 'dist/transport/outbound-buffer.js'
    backup = target.with_suffix('.js.chat-v4-original')
    current = target.read_bytes()
    original = backup.read_bytes() if backup.exists() else current
    # Upgrade the repo's stock-based v3, whose original backup predates v4.
    oldbackup = target.with_suffix('.js.chat-original')
    if not backup.exists() and oldbackup.exists():
        stock = oldbackup.read_bytes()
        if hashlib.sha256(stock).hexdigest() == DIGEST:
            v3 = stock.decode().replace('refLookup) {\n    // 引用消息',
                'refLookup, normalizeChat = true) {\n    // 引用消息').replace(
                'const chunks = chunkMarkdownText(clean, limit)',
                'const chunks = (normalizeChat ? splitChatMessages(clean) : [clean]).flatMap((part) => chunkMarkdownText(part, limit))')
            v3 = ("// QQ Whale chat splitter v3\nimport { splitChatMessages } from './chat-splitter.js';\n" + v3).encode()
            if current == v3: original = stock
    output = patched(original)
    if backup.exists() and current not in (original, output):
        raise ValueError('Local outbound changes conflict; no files modified')
    source = Path(__file__).resolve().parents[1] / 'patches/dsh-qqbot'
    planned = [(target, output)] + [(target.with_name(name), (source / name).read_bytes())
        for name in ('chat-splitter.js', 'chat-delivery.js')]
    if check:
        if any(not path.exists() or path.read_bytes() != data for path, data in planned):
            raise ValueError('Chat path missing or differs from reviewed source')
        print('QQ Whale chat splitter v4 verified')
        return
    if not backup.exists(): backup.write_bytes(original)
    for path, data in planned: path.write_bytes(data)
    print('QQ Whale chat splitter v4 installed; restart required')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('plugin_root', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try: apply(args.plugin_root.resolve(), args.check)
    except (OSError, ValueError) as error: parser.exit(1, f'{error}\n')
