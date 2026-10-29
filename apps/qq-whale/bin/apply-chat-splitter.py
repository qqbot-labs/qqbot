#!/usr/bin/env python3
"""Install the chat splitter into a reviewed, unmodified dsh-qqbot 1.10.9."""
import argparse
import hashlib
import json
from pathlib import Path


DIGEST = '59c90dbf47c12a6ba41da5408166786718f77c0d4da9734f8887abb82cdaa318'
MARKER = "// QQ Whale chat splitter v3\n"


def apply(root, check=False):
    package = json.loads((root / 'package.json').read_text())
    if package.get('name') != '@zaofan/dsh-qqbot' or package.get('version') != '1.10.9':
        raise ValueError('Only reviewed @zaofan/dsh-qqbot 1.10.9 is supported')
    target = root / 'dist/transport/outbound-buffer.js'
    backup = target.with_suffix('.js.chat-original')
    current = target.read_bytes()
    original = backup.read_bytes() if backup.exists() else current
    if hashlib.sha256(original).hexdigest() != DIGEST:
        raise ValueError('Upstream or local patch changed; no files modified. Review before installing.')
    text = original.decode('utf-8')
    replacements = [
        ('refLookup) {\n    // 引用消息',
         'refLookup, normalizeChat = true) {\n    // 引用消息'),
        ('const chunks = chunkMarkdownText(clean, limit)',
         'const chunks = (normalizeChat ? splitChatMessages(clean) : [clean])'
         '.flatMap((part) => chunkMarkdownText(part, limit))'),
    ]
    for old, new in replacements:
        if text.count(old) != 1:
            raise ValueError('Unexpected outbound integration point; no files modified')
        text = text.replace(old, new)
    patched = (MARKER + "import { splitChatMessages } from './chat-splitter.js';\n" + text).encode()
    if current not in (original, patched):
        raise ValueError('Local outbound changes conflict; no files modified')
    source = Path(__file__).resolve().parents[1] / 'patches/dsh-qqbot/chat-splitter.js'
    splitter = target.with_name('chat-splitter.js')
    if check:
        if current != patched or not splitter.exists() or splitter.read_bytes() != source.read_bytes():
            raise ValueError('Chat splitter is missing or differs from reviewed source')
        print('QQ Whale chat splitter v3 verified')
        return
    if not backup.exists():
        backup.write_bytes(original)
    splitter.write_bytes(source.read_bytes())
    target.write_bytes(patched)
    print('QQ Whale chat splitter v3 installed; no services restarted')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('plugin_root', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        apply(args.plugin_root.resolve(), args.check)
    except (OSError, ValueError) as error:
        parser.exit(1, f'{error}\n')
