/**
 * whale-memory-core.mjs —— 小鲸鱼/大鲸鱼的长期记忆底座（只被本项目两个扩展引用）。
 *
 * 为什么需要自己建库：
 *   插件本身**不保存全量消息原文**（只有 120/200 字的截断副本与若干台账），
 *   完整原文只存在于 DSH 会话日志里；一旦上下文压缩、换模型、/new 或会话迁移，
 *   模型就再也"想不起来"之前聊过什么。这里把每条真实消息独立归档到 SQLite，
 *   与模型上下文完全解耦：压缩、重启、换会话都不影响它。
 *
 * 关键设计：
 *   · 幂等：dedupe_key UNIQUE，同一条消息重复投递只入库一次；
 *   · 中文检索：FTS5 + trigram 分词（实测可命中"大白饭"这类中文子串）；
 *   · 短查询降级：trigram 要求 ≥3 字符，1~2 字符查询走 LIKE；
 *   · 只读安全性：全部参数化 SQL，不接受拼接；不接受外部传入路径；
 *   · 软删除：forget 只置 deleted=1，物理数据保留以便审计与误删恢复。
 *
 * 数据库位置：<WHALE_ROOT>/data/qqwhale/memory.db（0600，qqwhale 所有）。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;

/** 打开（并初始化）记忆库。失败抛异常，由调用方决定降级。 */
export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  // WAL：写入不被长查询阻塞，崩溃后也能自恢复。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 3000');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS msg (
      id          INTEGER PRIMARY KEY,
      dedupe_key  TEXT NOT NULL UNIQUE,
      ts          INTEGER NOT NULL,
      scope       TEXT NOT NULL,
      peer        TEXT NOT NULL,
      sender      TEXT NOT NULL,
      sender_name TEXT,
      text        TEXT NOT NULL,
      flags       TEXT,
      deleted     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_msg_peer_ts ON msg(peer, ts);
    CREATE INDEX IF NOT EXISTS idx_msg_ts ON msg(ts);
    CREATE TABLE IF NOT EXISTS memory (
      id        INTEGER PRIMARY KEY,
      ts        INTEGER NOT NULL,
      scope     TEXT,
      peer      TEXT,
      subject   TEXT,
      kind      TEXT NOT NULL DEFAULT 'fact',
      text      TEXT NOT NULL,
      source    TEXT,
      confidence TEXT NOT NULL DEFAULT 'user_stated',
      deleted   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mem_peer_ts ON memory(peer, ts);
  `);

  // FTS5 用外部内容表 + 触发器同步，避免双写不一致。
  const hasMsgFts = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='msg_fts'`)
    .get();
  if (!hasMsgFts) {
    db.exec(`CREATE VIRTUAL TABLE msg_fts USING fts5(
      text, content='msg', content_rowid='id', tokenize='trigram'
    )`);
    db.exec(`CREATE TRIGGER msg_ai AFTER INSERT ON msg BEGIN
      INSERT INTO msg_fts(rowid, text) VALUES (new.id, new.text);
    END`);
    db.exec(`CREATE TRIGGER msg_ad AFTER DELETE ON msg BEGIN
      INSERT INTO msg_fts(msg_fts, rowid, text) VALUES('delete', old.id, old.text);
    END`);
    db.exec(`CREATE TRIGGER msg_au AFTER UPDATE OF text ON msg BEGIN
      INSERT INTO msg_fts(msg_fts, rowid, text) VALUES('delete', old.id, old.text);
      INSERT INTO msg_fts(rowid, text) VALUES (new.id, new.text);
    END`);
    db.exec(`INSERT INTO msg_fts(msg_fts) VALUES('rebuild')`);
  }

  const hasMemFts = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='memory_fts'`)
    .get();
  if (!hasMemFts) {
    db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(
      text, content='memory', content_rowid='id', tokenize='trigram'
    )`);
    db.exec(`CREATE TRIGGER mem_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
    END`);
    db.exec(`CREATE TRIGGER mem_ad AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.id, old.text);
    END`);
    db.exec(`INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`);
  }

  db.prepare(`INSERT INTO meta(k, v) VALUES('schema', ?)
              ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(String(SCHEMA_VERSION));
}

/** 稳定去重键：有平台消息 id 就用它；否则用 分钟+发送者+内容哈希（可接受的近似）。 */
export function dedupeKey({ msgKey, scope, peer, sender, text, ts }) {
  if (msgKey) return `${scope}:${peer}:${sender}:id:${msgKey}`;
  const minute = Math.floor(ts / 60000);
  let h = 0;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${scope}:${peer}:${sender}:t${minute}:h${h}`;
}

/**
 * 把自然语言查询转成 trigram FTS 可用的表达式。
 *
 * 为什么需要它：FTS5 的 trigram 分词把 MATCH 的参数当成**短语**，
 * 于是"布丁最近还好吗"只能匹配到含这整句的文档——现实中几乎不会命中。
 * 中文没有空格可切，所以这里用三字滑窗（trigram 的最小单位）做 OR 检索，
 * 再由 bm25 把"命中更多片段的文档"排在前面。
 */
export function buildFtsQuery(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  if (s.length < 3) return null;
  const grams = new Set();
  for (let i = 0; i + 3 <= s.length; i += 1) {
    grams.add(s.slice(i, i + 3));
    if (grams.size >= 16) break;
  }
  return [...grams].map((g) => `"${g.replace(/"/g, '""')}"`).join(' OR ');
}

// 中文里高频、几乎不携带检索价值的字；由它们组成的二字窗会在兜底查询里被丢弃，
// 否则"最近还好吗"会产生一堆无意义 LIKE，既慢又噪声大。
const STOP_CHARS = new Set('的了吗呢吧啊哦嗯我你他她它是在有和就不都一也很到说要去会着没看好这那什么怎还个们'.split(''));

/** 提取二字滑窗（去重、过滤纯停用字窗），最多 8 个。 */
export function bigrams(text) {
  const s = String(text ?? '').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
  if (s.length < 2) return [];
  const out = new Set();
  for (let i = 0; i + 2 <= s.length; i += 1) {
    const g = s.slice(i, i + 2);
    if ([...g].every((c) => STOP_CHARS.has(c))) continue;
    out.add(g);
    if (out.size >= 8) break;
  }
  return [...out];
}

/** 归档一条消息；返回 true 表示新入库，false 表示重复（幂等）。 */
export function archiveMessage(db, rec) {
  const key = dedupeKey(rec);
  const info = db
    .prepare(`INSERT OR IGNORE INTO msg
              (dedupe_key, ts, scope, peer, sender, sender_name, text, flags)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      key,
      rec.ts,
      rec.scope,
      rec.peer,
      rec.sender,
      rec.senderName ?? null,
      rec.text,
      rec.flags ?? null,
    );
  return info.changes > 0;
}

/**
 * 检索历史消息。
 * trigram 分词下 <3 字符的查询无法 MATCH，降级为 LIKE（仍参数化）。
 */
export function searchMessages(db, { q, peer, limit = 5, beforeTs, excludeRecent = 0 }) {
  const text = String(q ?? '').trim();
  if (!text) return [];
  const lim = Number.isSafeInteger(limit) && limit >= 0 ? (limit || -1) : 5;
  const cutoff = beforeTs ?? Number.MAX_SAFE_INTEGER;
  const params = [text, cutoff];
  let sql;

  const ftsQuery = buildFtsQuery(text);
  if (ftsQuery) {
    // bm25 越小越相关；相同分数时按时间新→旧，避免结果随机。
    params[0] = ftsQuery;
    sql = `SELECT m.id, m.ts, m.scope, m.sender_name, m.text
             FROM msg_fts f JOIN msg m ON m.id = f.rowid
            WHERE msg_fts MATCH ? AND m.deleted = 0 AND m.ts < ?`;
    if (peer) {
      sql += ' AND m.peer = ?';
      params.push(peer);
    }
    sql += ' ORDER BY bm25(msg_fts), m.ts DESC LIMIT ?';
    params.push(lim < 0 ? -1 : lim + excludeRecent);
  } else {
    sql = `SELECT id, ts, scope, sender_name, text
             FROM msg
            WHERE text LIKE ? AND deleted = 0 AND ts < ?`;
    params[0] = `%${text}%`;
    if (peer) {
      sql += ' AND peer = ?';
      params.push(peer);
    }
    sql += ' ORDER BY ts DESC LIMIT ?';
    params.push(lim < 0 ? -1 : lim + excludeRecent);
  }

  let rows = [];
  try {
    rows = db.prepare(sql).all(...params);
  } catch {
    // 查询语法不受支持时（例如极短查询命中 MATCH 限制）不要让扩展崩掉
    rows = [];
  }

  // 兜底：FTS 的 trigram 只能命中"同样的三字序列"，而口语提问与原文几乎不会共享
  // 连续三字（例：问"布丁最近还好吗"，原文只有"猫叫布丁"）。这里用二字滑窗 LIKE
  // OR 检索，保证"提到过就找得到"。代价是慢一些，但只在 FTS 空手时才走。
  if (rows.length === 0) {
    const grams = bigrams(text);
    if (grams.length > 0) {
      const conds = grams.map(() => 'text LIKE ?').join(' OR ');
      const p2 = [`%${grams[0]}%`];
      for (let i = 1; i < grams.length; i += 1) p2.push(`%${grams[i]}%`);
      p2.push(cutoff);
      let sql2 = `SELECT id, ts, scope, sender_name, text FROM msg
                   WHERE deleted = 0 AND (${conds}) AND ts < ?`;
      if (peer) {
        sql2 += ' AND peer = ?';
        p2.push(peer);
      }
      sql2 += ' ORDER BY ts DESC LIMIT ?';
      p2.push(lim < 0 ? -1 : lim + excludeRecent);
      try {
        rows = db.prepare(sql2).all(...p2);
      } catch {
        rows = [];
      }
    }
  }

  if (excludeRecent > 0 && lim > 0) rows = rows.slice(0, lim);
  return rows;
}

/** 最近消息（按时间倒序）。 */
export function recentMessages(db, { peer, limit = 10 }) {
  const lim = Number.isSafeInteger(limit) && limit >= 0 ? (limit || -1) : 10;
  const params = [];
  let sql = `SELECT id, ts, scope, sender_name, text FROM msg WHERE deleted = 0`;
  if (peer) {
    sql += ' AND peer = ?';
    params.push(peer);
  }
  sql += ' ORDER BY ts DESC LIMIT ?';
  params.push(lim);
  return db.prepare(sql).all(...params);
}

/** 写入一条"被提炼的记忆"（偏好/事实/事件）。 */
export function addMemory(db, rec) {
  const info = db
    .prepare(`INSERT INTO memory (ts, scope, peer, subject, kind, text, source, confidence)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      rec.ts ?? Date.now(),
      rec.scope ?? null,
      rec.peer ?? null,
      rec.subject ?? null,
      rec.kind ?? 'fact',
      rec.text,
      rec.source ?? null,
      rec.confidence ?? 'user_stated',
    );
  return Number(info.lastInsertRowid);
}

export function searchMemories(db, { q, limit = 5 }) {
  const text = String(q ?? '').trim();
  if (!text) return [];
  const lim = Number.isSafeInteger(limit) && limit >= 0 ? (limit || -1) : 5;
  try {
    const ftsQuery = buildFtsQuery(text);
    if (ftsQuery) {
      return db
        .prepare(`SELECT m.id, m.ts, m.kind, m.text FROM memory_fts f
                    JOIN memory m ON m.id = f.rowid
                   WHERE memory_fts MATCH ? AND m.deleted = 0
                   ORDER BY bm25(memory_fts), m.ts DESC LIMIT ?`)
        .all(ftsQuery, lim);
    }
    return db
      .prepare(`SELECT id, ts, kind, text FROM memory
                 WHERE text LIKE ? AND deleted = 0 ORDER BY ts DESC LIMIT ?`)
      .all(`%${text}%`, lim);
  } catch {
    return [];
  }
}

/** 软删除：消息或记忆。只允许按主键，禁止任何拼接。 */
export function forget(db, { table, id }) {
  if (table !== 'msg' && table !== 'memory') throw new Error('unknown table');
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new Error('bad id');
  const info = db.prepare(`UPDATE ${table} SET deleted = 1 WHERE id = ?`).run(n);
  return info.changes > 0;
}

export function stats(db) {
  const one = (sql, ...p) => {
    try {
      return db.prepare(sql).get(...p);
    } catch {
      return {};
    }
  };
  return {
    messages: one('SELECT COUNT(*) AS n FROM msg WHERE deleted = 0').n ?? 0,
    messagesTotal: one('SELECT COUNT(*) AS n FROM msg').n ?? 0,
    memories: one('SELECT COUNT(*) AS n FROM memory WHERE deleted = 0').n ?? 0,
    peers: one('SELECT COUNT(DISTINCT peer) AS n FROM msg').n ?? 0,
    firstTs: one('SELECT MIN(ts) AS t FROM msg').t ?? null,
    lastTs: one('SELECT MAX(ts) AS t FROM msg').t ?? null,
  };
}

/** 把毫秒时间戳格式化成北京时间字符串（只用于给模型/人看的摘要）。 */
export function fmtTime(ts) {
  if (!ts) return '?';
  const d = new Date(Number(ts) + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 单行截断，避免注入上下文过长。 */
export function clip(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
