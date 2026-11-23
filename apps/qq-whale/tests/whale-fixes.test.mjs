import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, archiveMessage, searchMessages, addMemory, searchMemories } from '../bin/whale-memory-core.mjs';
import { replyProof } from '../bin/session-evidence.mjs';
import { publicIP, callSearch } from '../bin/whale-search.mjs';
import { preprocess } from '../extensions/inbound/whale-vision.mjs';

const BASE = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(BASE, 'bin');

test('P0-2: whale-ctl allow-admin and group-mode update block-list YAML without orphaned items', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-ctl-'));
  const dsh = join(dir, '.dsh');
  const whale = join(dir, 'whale');
  const fakeBin = join(dir, 'fakebin');
  const profileDir = join(dsh, 'profiles', 'web');
  const patch = join(profileDir, 'cordis.patch.yml');
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(join(whale, 'data'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  // Stub systemctl so whale-ctl restart succeeds offline
  writeFileSync(join(fakeBin, 'systemctl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

  const id1 = '1'.repeat(32);
  const id2 = '2'.repeat(32);
  const g1 = 'a'.repeat(32);
  const g2 = 'b'.repeat(32);
  const g3 = 'c'.repeat(32);

  // PyYAML block-list format (as written by whale-admin)
  writeFileSync(patch, [
    '- id: persona',
    '  config:',
    '    prefix: "你好世界"',
    '- id: im-qqbot',
    '  config:',
    '    access:',
    '      c2cMode: disabled',
    '      c2cAllow:',
    `      - '${id1}'`,
    '      groupMode: disabled',
    '      groupAllow:',
    `        - '${g1}'`,
    `        - '${g2}'`,
    '',
  ].join('\n'));

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    WHALE_USER: process.env.USER || 'root',
    WHALE_HOME: dir,
    WHALE_ROOT: whale,
    DSH_HOME: dsh,
  };

  try {
    execFileSync('bash', [join(BIN, 'whale-ctl'), 'allow-admin', id2], { env, encoding: 'utf8' });
    const afterAdmin = readFileSync(patch, 'utf8');
    assert.match(afterAdmin, /c2cMode:\s*allowlist/);
    assert.match(afterAdmin, new RegExp(`c2cAllow:\\s*\\['${id1}', '${id2}'\\]`));
    // Must not leave orphaned "- '1111...'" line below c2cAllow!
    assert.equal((afterAdmin.match(new RegExp(`-\\s*'${id1}'`)) || []).length, 0);

    execFileSync('bash', [join(BIN, 'whale-ctl'), 'group-mode', 'allowlist', g3], { env, encoding: 'utf8' });
    const afterGroup = readFileSync(patch, 'utf8');
    assert.match(afterGroup, /groupMode:\s*allowlist/);
    assert.match(afterGroup, new RegExp(`groupAllow:\\s*\\['${g3}'\\]`));
    assert.equal((afterGroup.match(new RegExp(`-\\s*'${g1}'`)) || []).length, 0);
    assert.equal((afterGroup.match(new RegExp(`-\\s*'${g2}'`)) || []).length, 0);

    const shown = execFileSync('bash', [join(BIN, 'whale-ctl'), 'group-mode', 'show'], { env, encoding: 'utf8' });
    assert.match(shown, new RegExp(g3));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-2: whale-ctl status handles single quotes in PROFILE_DIR safely', () => {
  const dir = mkdtempSync(join(tmpdir(), "whale-quote'dir-"));
  const dsh = join(dir, '.dsh');
  const whale = join(dir, 'whale');
  const pkgDir = join(dsh, 'profiles', 'web', 'node_modules', '@zaofan', 'dsh-qqbot');
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(whale, 'data'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@zaofan/dsh-qqbot', version: '1.10.9' }));

  const env = {
    ...process.env,
    WHALE_USER: process.env.USER || 'root',
    WHALE_HOME: dir,
    WHALE_ROOT: whale,
    DSH_HOME: dsh,
  };
  try {
    const out = execFileSync('bash', [join(BIN, 'whale-ctl'), 'status'], { env, encoding: 'utf8' });
    assert.match(out, /插件版本:\s+1\.10\.9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P0-5: whale-backup.sh backs up WAL read-only SQLite DB and single-quote paths using Python sqlite3.backup without sqlite3 CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), "whale-bk'test-"));
  const dsh = join(dir, '.dsh');
  const whale = join(dir, 'whale');
  const dataDir = join(whale, 'data', 'qqwhale');
  mkdirSync(join(dsh, 'profiles', 'web'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(whale, 'workspace'), { recursive: true });
  mkdirSync(join(whale, 'etc'), { recursive: true });

  writeFileSync(join(dsh, 'profiles', 'web', 'cordis.patch.yml'), 'persona: test\n');
  writeFileSync(join(whale, 'workspace', 'AGENTS.md'), 'rules\n');
  writeFileSync(join(whale, 'etc', 'qqbot.env'), 'QQBOT_APPID=100\n');

  // Create a WAL-mode SQLite DB and then make its directory + file read-only
  const dbPath = join(dataDir, 'memory.db');
  const db = openDb(dbPath);
  archiveMessage(db, { scope: 'c2c', peer: 'p1', sender: 'p1', ts: 1000, text: 'WAL backup test', msgKey: 'k1' });
  db.close();
  chmodSync(dbPath, 0o400);
  chmodSync(dataDir, 0o500);

  // Build a PATH shadow directory with a broken sqlite3 CLI to prove python3 sqlite3.backup is used
  const fakeBin = join(dir, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, 'sqlite3'), '#!/usr/bin/env bash\nexit 127\n', { mode: 0o755 });

  try {
    const res = spawnSync('bash', [join(BIN, 'whale-backup.sh')], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        WHALE_HOME: dir,
        WHALE_ROOT: whale,
        DSH_HOME: dsh,
      },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `backup failed: ${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /备份完成/);
  } finally {
    chmodSync(dataDir, 0o700);
    chmodSync(dbPath, 0o600);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1: session-evidence replyProof accepts dshHome without ReferenceError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-ev-'));
  const dataRoot = join(dir, 'whale', 'data');
  const dshHome = join(dir, '.dsh');
  mkdirSync(join(dataRoot, '.qqbot'), { recursive: true });
  mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true });
  const peer = 'a'.repeat(32);
  writeFileSync(join(dataRoot, '.qqbot', 'model-prefs.json'), JSON.stringify({
    sessionIds: { [`qqbot:123456:c2c:${peer}`]: 'sess-1' },
  }));
  const proofs = new Map([['sess-1', { lastModel: { ts: Date.now() }, ends: [{ ts: Date.now(), kind: 'completed', code: 'OK' }] }]]);
  try {
    const out = replyProof(proofs, dataRoot, dshHome);
    assert.equal(out.status, 'ok');
    assert.equal(out.codes, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1: whale-memory-core excludes recent messages in SQL and escapes LIKE wildcards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-mem-fix-'));
  const db = openDb(join(dir, 'memory.db'));
  try {
    archiveMessage(db, { scope: 'c2c', peer: 'p1', sender: 'p1', ts: 100, text: '我喜欢抹茶拿铁', msgKey: 'm1' });
    archiveMessage(db, { scope: 'c2c', peer: 'p1', sender: 'p1', ts: 200, text: '抹茶拿铁真好喝', msgKey: 'm2' });
    archiveMessage(db, { scope: 'c2c', peer: 'p1', sender: 'p1', ts: 300, text: '再来一杯抹茶拿铁', msgKey: 'm3' });
    archiveMessage(db, { scope: 'c2c', peer: 'p1', sender: 'p1', ts: 400, text: '普通消息不含百分号', msgKey: 'm4' });
    archiveMessage(db, { scope: 'c2c', peer: 'p1', sender: 'p1', ts: 500, text: '折扣是50%_特价', msgKey: 'm5' });

    // Exclude the 3 most recent messages (m5, m4, m3) -> FTS query for 抹茶拿铁 must NOT return m3
    const ftsRows = searchMessages(db, { q: '抹茶拿铁', peer: 'p1', limit: 5, excludeRecent: 3 });
    assert.deepEqual(ftsRows.map((r) => r.ts).sort(), [100, 200]);

    // Exclude the 2 most recent messages for short LIKE query
    const shortRows = searchMessages(db, { q: '抹茶', peer: 'p1', limit: 5, excludeRecent: 3 });
    assert.deepEqual(shortRows.map((r) => r.ts).sort(), [100, 200]);

    // LIKE wildcard escaping: searching '%' or '_' must ONLY match literal '%' or '_'
    const pctRows = searchMessages(db, { q: '%', peer: 'p1', limit: 10 });
    assert.equal(pctRows.length, 1);
    assert.equal(pctRows[0].ts, 500);

    const underRows = searchMessages(db, { q: '_', peer: 'p1', limit: 10 });
    assert.equal(underRows.length, 1);
    assert.equal(underRows[0].ts, 500);

    addMemory(db, { peer: 'p1', text: '普通记忆' });
    addMemory(db, { peer: 'p1', text: '100%确认' });
    const memRows = searchMemories(db, { q: '%', limit: 10 });
    assert.equal(memRows.length, 1);
    assert.equal(memRows[0].text, '100%确认');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1: whale-vision caps attachment wait time instead of stalling for full overallDeadline', async () => {
  const ctx = {
    message: {
      kind: 'c2c',
      senderId: 'a'.repeat(32),
      content: 'hi',
      attachments: [{ url: 'https://example.com/file.bin', content_type: 'application/octet-stream' }],
    },
  };
  let waits = 0;
  const start = Date.now();
  await preprocess(ctx, {
    config: { enabled: true, maxImages: 0, timeoutMs: 35000, collectWaitMs: 60 },
    lookup: () => null,
    analyze: async () => { throw Error('should not run'); },
    wait: async () => { waits += 1; await new Promise((r) => setTimeout(r, 15)); },
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `stalled too long: ${elapsed}ms`);
  assert.ok(waits >= 1 && waits <= 10);
  // Non-image content_type without localPath should be skipped cleanly without error note
  assert.equal(ctx.message.content, 'hi');
});

test('P1: whale-search blocks IPv6 SSRF leading-zero 2001:0db8::/32 and 3fff::/20 and caps response size', async () => {
  for (const blocked of [
    '2001:db8::1',
    '2001:0db8::1',
    '2001:0db8:0000:0000::1',
    '3fff::1',
    '3fff:0fff:ffff::1',
    '2002:7f00:0001::1',
    '2001:0000::1',
    '2001:0002::1',
    '2001:0010::1',
    '2001:0020::1',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fc00::1',
    '::1',
  ]) {
    assert.equal(publicIP(blocked), false, `expected blocked IPv6: ${blocked}`);
  }
  for (const allowed of ['2606:4700:4700::1111', '2400:3200::1', '3fff:1000::1', '1.1.1.1']) {
    assert.equal(publicIP(allowed), true, `expected public IP: ${allowed}`);
  }

  // Test boundedJSON enforces maxResponseBytes when configured via search-config.json
  const dir = mkdtempSync(join(tmpdir(), 'whale-search-cap-'));
  mkdirSync(join(dir, 'etc'), { recursive: true });
  mkdirSync(join(dir, 'data', 'qqwhale'), { recursive: true });
  writeFileSync(join(dir, 'etc', 'search-config.json'), JSON.stringify({ enabled: true, maxResponseBytes: 64 }));
  writeFileSync(join(dir, 'etc', 'qqbot.env'), 'WHALE_API_KEY=test-key\n');
  const script = `
    import { callSearch } from ${JSON.stringify(join(BIN, 'whale-search.mjs'))};
    const big = new TextEncoder().encode(JSON.stringify({ results: [{ title: 'A'.repeat(200), url: 'https://example.com', snippet: 'x' }] }));
    const stream = new ReadableStream({
      start(c) { c.enqueue(big.subarray(0, 40)); c.enqueue(big.subarray(40)); c.close(); }
    });
    try {
      await callSearch('web_search', { query: 'hello' }, {
        fetcher: async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      });
      process.exit(2);
    } catch (e) {
      if (!String(e.message).includes('超过大小限制')) process.exit(3);
      process.stdout.write('CAPPED_OK');
    }
  `;
  try {
    const out = execFileSync('node', ['--input-type=module', '-e', script], {
      env: { ...process.env, WHALE_ROOT: dir },
      encoding: 'utf8',
    });
    assert.equal(out, 'CAPPED_OK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1: admin-control.mjs guards socket data handler with handled flag', () => {
  const code = readFileSync(join(BASE, 'extensions', 'hooks', 'admin-control.mjs'), 'utf8');
  assert.match(code, /let\s+raw='',\s*handled=false/);
  assert.match(code, /if\(handled\)return/);
  assert.match(code, /handled=true;\s*conn\.pause\(\)/);
});
