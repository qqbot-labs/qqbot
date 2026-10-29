#!/usr/bin/env node
/**
 * whale-memory-backfill.mjs —— 把既有会话日志回填进长期记忆库（一次性、幂等）。
 *
 * 为什么需要：记忆扩展只会归档"从部署那一刻起"的新消息；而此前已经聊过的内容
 * 只存在于 DSH 会话日志里。若不回填，机器人对"部署之前"的对话就是失忆的。
 *
 * 技术要点（实测踩到的坑）：DSH 的会话文件是**追加多帧**的 zstd
 * （session.v4.jsonl.zstd，单次 zstdDecompressSync 只能解出第一帧 =
 * 200 字节的 session 头）。这里按 zstd 帧魔数 28 B5 2F FD 切分后逐帧解压。
 *
 * 幂等：dedupe_key 用 `backfill:<sessionId>:<序号>`，重复执行不会产生重复行。
 * 安全：只读会话文件；只写本项目记忆库；不联网；不打印消息正文。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

const WHALE_ROOT = resolve(arg('whale-root', process.env.WHALE_ROOT || '.'));
const DSH_HOME = resolve(arg('dsh-home', process.env.DSH_HOME || join(process.env.HOME || '.', '.dsh')));
const PEER = arg('peer', '');
const DRY = process.argv.includes('--dry-run');

const CORE = join(WHALE_ROOT, 'bin', 'whale-memory-core.mjs');
const DB_PATH = join(WHALE_ROOT, 'data', 'qqwhale', 'memory.db');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 按 zstd 帧切分并逐帧解压；返回完整 JSONL 文本。 */
function decompressFrames(buf) {
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    starts.push(i);
    i += 4;
  }
  if (starts.length === 0) {
    try {
      return zstdDecompressSync(buf).toString('utf8');
    } catch {
      return '';
    }
  }
  const parts = [];
  for (let k = 0; k < starts.length; k += 1) {
    const seg = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length);
    try {
      parts.push(zstdDecompressSync(seg));
    } catch {
      /* 单帧损坏就跳过，不阻断整体回填 */
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

function walkSessions(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith('session') && e.name.includes('.jsonl')) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

/** 从事件里取纯文本（多段 content 拼起来，忽略非 text 段）。 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

/** 过滤掉注入内容、系统指令与过短噪声。 */
function keep(text) {
  const t = String(text || '').trim();
  if (t.length < 2) return false;
  if (t.startsWith('【记忆')) return false;          // 本项目的自动召回注入
  if (t.startsWith('<compacted-summary>')) return false;
  if (t.includes('[whale-check]')) return false;
  if (/^\s*#\s/.test(t) && t.includes('身份与边界')) return false; // AGENTS.md 注入
  return true;
}

const core = await import(CORE);
const db = core.openDb(DB_PATH);
const sessions = existsSync(join(DSH_HOME, 'sessions')) ? walkSessions(join(DSH_HOME, 'sessions')) : [];
let inserted = 0;
let scanned = 0;
let skipped = 0;
let perSession = [];

for (const file of sessions) {
  const sessionId = file.split('/').slice(-2, -1)[0] || 'unknown';
  let text;
  try {
    text = decompressFrames(readFileSync(file));
  } catch {
    continue;
  }
  if (!text) continue;
  const lines = text.split('\n').filter(Boolean);
  let seq = 0;
  let n = 0;
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue;
    seq += 1;
    scanned += 1;

    // 真实结构（实测）：
    //   user/message      → { type, seq, time, data: { content, source, role, id }, surfaceOp }
    //   assistant/message → { type, seq, time, data: { turn, step, message: { content }, usage, stream } }
    // 时间戳字段是 time（毫秒），不是 at/timestamp。
    const data = ev.data ?? {};
    const content = ev.type === 'user/message' ? data.content : data.message?.content;
    // 只归档"真人说的话"：注入的规则/上下文 source.kind 形如 'qqbot:group-rules'
    const srcKind = data.source?.kind;
    if (ev.type === 'user/message' && srcKind && srcKind !== 'user') {
      skipped += 1;
      continue;
    }
    const body = textOf(content);
    if (!keep(body)) {
      skipped += 1;
      continue;
    }
    const ts = Number(ev.time ?? ev.at ?? 0) || Date.now();
    const rec = {
      msgKey: `backfill:${sessionId}:${seq}`,
      ts,
      scope: 'c2c',
      peer: PEER || 'unknown',
      sender: ev.type === 'user/message' ? (PEER || 'user') : 'assistant',
      senderName: ev.type === 'user/message' ? '主人' : '小鲸鱼',
      text: body.slice(0, 4000),
      flags: 'backfill',
    };
    if (DRY) {
      n += 1;
      continue;
    }
    if (core.archiveMessage(db, rec)) {
      inserted += 1;
      n += 1;
    } else {
      skipped += 1;
    }
  }
  if (n > 0) perSession.push(`${sessionId.slice(0, 12)}… ${n} 条`);
}

const s = core.stats(db);
console.log(`回填完成${DRY ? '（试运行，未写入）' : ''}：扫描事件 ${scanned}，新入库 ${inserted}，跳过 ${skipped}`);
console.log(`会话分布：${perSession.join('；') || '无'}`);
console.log(`记忆库现有：${s.messages} 条消息 / ${s.peers} 个对象 / 时间跨度 ${core.fmtTime(s.firstTs)} ~ ${core.fmtTime(s.lastTs)}`);
try { db.close(); } catch { /* 忽略 */ }
