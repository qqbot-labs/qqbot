#!/usr/bin/env python3
"""Read-only validation before restore touches its targets, including existing symlinks."""
import hashlib
from pathlib import Path, PurePosixPath
import sys
import tarfile

archive, dsh, whale = sys.argv[1:4]
roots = {'dsh': Path(dsh).absolute(), 'whale': Path(whale).absolute()}
allowed = {
    'dsh': {'profiles', 'sessions', 'storages', 'qqbot-settings', '.dsh-qqbot', '.credentials.yaml', 'settings.yaml'},
    'whale': {'data', 'workspace', 'etc'},
}

def no_links(path):
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise ValueError(f'existing symlink target rejected: {part}')

for path in roots.values():
    no_links(path)
    if path == Path('/'):
        raise ValueError('root restore target rejected')

with tarfile.open(archive, 'r:gz') as tf:
    members = tf.getmembers()
    if len(members) > 100000 or sum(m.size for m in members) > 2 * 1024**3:
        raise ValueError('archive exceeds restore limits')
    seen = set()
    for m in members:
        p = PurePosixPath(m.name)
        parts = p.parts
        if p.is_absolute() or '..' in parts or not parts or any(ord(c) < 32 for c in m.name):
            raise ValueError('unsafe archive path')
        if not (m.isfile() or m.isdir()) or m.name in seen or m.mode & 0o7000:
            raise ValueError('unsupported or duplicate archive member')
        seen.add(m.name)
        if parts[0] == '_meta':
            continue
        if parts[0] not in roots or (len(parts) > 1 and parts[1] not in allowed[parts[0]]):
            raise ValueError('archive writes outside data allowlist')
        no_links(roots[parts[0]].joinpath(*parts[1:]))
    meta = tf.extractfile('_meta/files.sha256')
    if meta is None:
        raise ValueError('missing file integrity manifest')
    expected = {}
    for line in meta.read().decode().splitlines():
        digest, name = line.split('  ', 1)
        if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest) or name in expected:
            raise ValueError('invalid integrity manifest')
        expected[name] = digest
    files = {m.name: m for m in members if m.isfile() and not m.name.startswith('_meta/')}
    if files.keys() != expected.keys():
        raise ValueError('file manifest does not cover archive exactly')
    for name, m in files.items():
        h = hashlib.sha256()
        with tf.extractfile(m) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(chunk)
        if h.hexdigest() != expected[name]:
            raise ValueError(f'content integrity mismatch before restore: {name}')
print(f'Pre-write validation passed: {len(files)} files; no links or out-of-scope writes')
