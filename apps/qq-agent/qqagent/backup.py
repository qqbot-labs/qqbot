"""Schema-1 project backups: strict validation and atomic, conservative restore."""
import hashlib
import hmac
import json
import math
import time

from .config import Configuration
from .store import js, now

TABLES = {
    'personas': ('id', 'body', 'created'),
    'friends': ('id', 'name', 'permissions', 'optout', 'updated'),
    'memories': ('id', 'friend', 'kind', 'body', 'source', 'label', 'created'),
    'events': ('id', 'channel', 'friend', 'body', 'created', 'state'),
    'ledger': ('id', 'event', 'channel', 'friend', 'action', 'payload', 'status', 'detail', 'created', 'updated', 'proactive', 'test'),
    'tasks': ('name', 'next', 'last', 'failures', 'detail'),
}
META = ('config', 'revision', 'persona_active', 'pause_active', 'stop_all', 'social_running', 'qzone_baseline')
PERMISSIONS = {'reply', 'proactive', 'read', 'like', 'comment'}


def export(store):
    with store.db() as connection:
        connection.execute('BEGIN')
        meta = {}
        for key in META:
            row = connection.execute('SELECT v FROM meta WHERE k=?', (key,)).fetchone()
            meta[key] = json.loads(row[0]) if row else None
        data = {'format': 'qqagent-backup', 'schema': 1, 'created': now(), 'meta': meta,
                'tables': {table: [dict(row) for row in connection.execute('SELECT * FROM ' + table)] for table in TABLES}}
    return {'data': data, 'sha256': hashlib.sha256(js(data).encode()).hexdigest()}


def require(condition):
    if not condition:
        raise ValueError('备份结构或字段无效，未更改运行数据')


def number(value, nullable=False):
    require((nullable and value is None) or
            (type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 10**12))


def integer(value, minimum=0, nullable=False):
    require((nullable and value is None) or (type(value) is int and minimum <= value <= 2**63-1))


def text(value, maximum=100000, empty=True):
    require(isinstance(value, str) and len(value) <= maximum and (empty or bool(value)))


def qq(value, empty=False):
    require(isinstance(value, str) and ((empty and value == '') or
            (value.isascii() and value.isdecimal() and 5 <= len(value) <= 12)))


def json_field(raw, kind=dict):
    text(raw, 2*1024*1024)
    try:
        value = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError):
        raise ValueError('备份 JSON 字段无效') from None
    require(isinstance(value, kind))
    return value


def validate(backup):
    require(isinstance(backup, dict) and set(backup) == {'data', 'sha256'})
    data = backup['data']
    require(isinstance(data, dict) and set(data) == {'format', 'schema', 'created', 'meta', 'tables'})
    require(data['format'] == 'qqagent-backup' and type(data['schema']) is int and data['schema'] == 1)
    text(backup['sha256'], 64, empty=False)
    require(len(backup['sha256']) == 64)
    try:
        actual = hashlib.sha256(js(data).encode()).hexdigest()
        require(hmac.compare_digest(actual, backup['sha256']))
    except (TypeError, OverflowError, RecursionError):
        raise ValueError('备份校验失败') from None
    number(data['created'])
    meta, tables = data['meta'], data['tables']
    require(isinstance(meta, dict) and set(meta) == set(META))
    require(isinstance(tables, dict) and set(tables) == set(TABLES))
    try:
        Configuration.model_validate(meta['config'])
    except (ValueError, TypeError):
        raise ValueError('备份配置校验失败') from None
    integer(meta['revision'], 1)
    integer(meta['persona_active'], 1, nullable=True)
    number(meta['qzone_baseline'], nullable=True)
    for key in ('pause_active', 'stop_all', 'social_running'):
        require(type(meta[key]) is bool)
    for table, columns in TABLES.items():
        rows = tables[table]
        require(isinstance(rows, list) and len(rows) <= 100000)
        primary, seen, events = ('name' if table == 'tasks' else 'id'), set(), set()
        for row in rows:
            require(isinstance(row, dict) and set(row) == set(columns))
            if table in ('personas', 'memories'):
                integer(row[primary], 1)
            else:
                text(row[primary], 600, empty=False)
            require(row[primary] not in seen)
            seen.add(row[primary])
            if 'created' in row:
                number(row['created'])
            if 'updated' in row:
                number(row['updated'])
            if table == 'personas':
                text(row['body'])  # Blank drafts are valid; activating one is not.
            elif table == 'friends':
                qq(row['id'])
                text(row['name'], 1000)
                for field, allowed in (('permissions', PERMISSIONS), ('optout', PERMISSIONS | {'all'})):
                    flags = json_field(row[field])
                    require(set(flags) <= allowed and all(type(v) is bool for v in flags.values()))
            elif table == 'memories':
                require(row['kind'] in ('memory', 'growth') and row['label'] in ('fact', 'inference', 'unverified'))
                qq(row['friend'], empty=row['kind'] == 'growth')
                text(row['body'], 5000, empty=False)
                text(row['source'], 1000, empty=False)
            elif table == 'events':
                require(row['channel'] in ('qq', 'qzone'))
                qq(row['friend'])
                require(row['state'] in ('pending', 'processing', 'processed', 'baseline', 'expired', 'optout', 'skipped', 'failed'))
                json_field(row['body'])
            elif table == 'ledger':
                require(row['channel'] in ('qq', 'qzone'))
                require(row['action'] in ('reply', 'proactive', 'publish', 'like', 'comment', 'reply_comment'))
                require((row['channel'] == 'qq') == (row['action'] in ('reply', 'proactive')))
                qq(row['friend'], empty=row['action'] == 'publish')
                text(row['detail'], 1000)
                require(row['status'] in ('pending', 'sending', 'success', 'failed', 'unknown', 'blocked', 'cancelled'))
                for field in ('proactive', 'test'):
                    require(type(row[field]) is int and row[field] in (0, 1))
                require(row['proactive'] == int(row['action'] != 'reply'))
                json_field(row['payload'])
                if row['event'] is not None:
                    text(row['event'], 1000, empty=False)
                    require(row['event'] not in events)
                    events.add(row['event'])
            elif table == 'tasks':
                require(row['name'] in ('qzone_poll', 'decision', 'retention'))
                number(row['next'])
                number(row['last'], nullable=True)
                integer(row['failures'])
                text(row['detail'], 1000)
    if meta['persona_active'] is not None:
        selected = [p for p in tables['personas'] if p['id'] == meta['persona_active']]
        require(len(selected) == 1 and bool(selected[0]['body'].strip()))
    return data


def restore(store, backup):
    data = validate(backup)
    # Lock includes both snapshot and transaction. No independent Store connections can interleave.
    with store.lock:
        destination = store.root / 'backups'
        destination.mkdir(mode=0o700, exist_ok=True)
        destination.chmod(0o700)
        snapshot = destination / ('pre-restore-' + str(time.time_ns()) + '.sqlite3')
        store.snapshot(snapshot)
        with store.db() as connection:
            connection.execute('BEGIN IMMEDIATE')
            existing = {r['id']: dict(r) for r in connection.execute('SELECT * FROM friends') if any(json.loads(r['optout']).values())}
            revision = json.loads(connection.execute("SELECT v FROM meta WHERE k='revision'").fetchone()[0]) + 1
            for table, columns in TABLES.items():
                connection.execute('DELETE FROM ' + table)
                for row in data['tables'][table]:
                    connection.execute('INSERT INTO ' + table + '(' + ','.join(columns) + ') VALUES(' + ','.join('?' for _ in columns) + ')', tuple(row[col] for col in columns))
            # Restoring an older file cannot undo a friend's more recent opt-out.
            for friend, old in existing.items():
                row = connection.execute('SELECT optout FROM friends WHERE id=?', (friend,)).fetchone()
                flags = json.loads(row[0]) if row else {}
                flags.update({key: True for key, value in json.loads(old['optout']).items() if value is True})
                if row:
                    connection.execute('UPDATE friends SET optout=? WHERE id=?', (js(flags), friend))
                else:
                    connection.execute('INSERT INTO friends VALUES(?,?,?,?,?)', (friend, old['name'], '{}', js(flags), old['updated']))
            for key, value in data['meta'].items():
                connection.execute('INSERT OR REPLACE INTO meta VALUES(?,?)', (key, js(value)))
            for key, value in (('revision', revision), ('pause_active', True), ('stop_all', True), ('social_running', False), ('qzone_baseline', None)):
                connection.execute('UPDATE meta SET v=? WHERE k=?', (js(value), key))
            store.bump(connection, 'cancel_epoch')
            store.bump(connection, 'active_epoch')
            connection.execute("DELETE FROM meta WHERE k LIKE 'health_%'")
            connection.execute("UPDATE ledger SET status='cancelled',detail='备份恢复，不补发' WHERE status='pending'")
            connection.execute("UPDATE ledger SET status='unknown',detail='备份中发送结果未知，不重试' WHERE status='sending'")
            connection.execute("UPDATE events SET state='expired' WHERE state IN ('pending','processing')")
            connection.execute('DELETE FROM sessions')
    return {'restored': True, 'paused': True, 'snapshot': snapshot.name, 'secrets': '未导出/未覆盖；需要时重新配置'}
