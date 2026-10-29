/**
 * whale-memory.mjs —— 入站记忆扩展：把每条真实消息独立归档，并按需自动召回。
 *
 * 放在 `{数据根}/.qqbot-extensions/inbound/whale-memory.mjs`（root 所有、只读目录）。
 *
 * 为什么用**早挂点**（onInbound）：它在"记群历史"之前，能拿到最原始的消息对象；
 * 归档不依赖是否被 @、是否被冷却、最后是否回复——用户说过的话就该被记住。
 *
 * 自动召回用 `ctx.silentInto()`：内容进 AI 上下文但**不唤醒**，不会让机器人
 * 因为"想起了旧事"而主动插话。
 *
 * 设计约束（与安全策略一致）：
 *   · 全部参数化 SQL；不接受任何外部路径；不执行外部命令；不发网络请求；
 *   · 任何异常都被吞掉并只在本地计数——记忆出问题绝不能让聊天挂掉；
 *   · 召回有冷却与条数上限，避免把上下文塞满。
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 扩展位于 <whale>/data/.qqbot-extensions/inbound/，上溯三级即 <whale>
const HERE = dirname(fileURLToPath(import.meta.url));
const WHALE_ROOT = resolve(HERE, '..', '..', '..');
const CORE_PATH = join(WHALE_ROOT, 'bin', 'whale-memory-core.mjs');
const CONFIG_PATH = join(WHALE_ROOT, 'data', 'qqwhale', 'memory-config.json');
const DB_PATH = join(WHALE_ROOT, 'data', 'qqwhale', 'memory.db');
// 启动标记：证明扩展确实被插件加载、库确实打开成功（运维与验收都靠它，
// 因为插件在 diagLog=false 时不打印扩展装载日志）。只写一行，不会无限增长
// （每次启动覆盖写，保留最后一条）。
const BOOT_MARK = join(WHALE_ROOT, 'data', 'qqwhale', 'memory-boot.json');

const DEFAULT_CONFIG = {
  archiveEnabled: true,
  recallEnabled: true,
  recallMax: 3,
  recallCooldownSec: 0,
  minQueryChars: 4,
  maxTextChars: 0,
  excludeRecent: 8,
  minGapMs: 0,
};

let core = null;
let db = null;
let cfg = { ...DEFAULT_CONFIG };
const lastRecallAt = new Map(); // peer -> 上次召回时间
const prefsInjected = new Map(); // peer -> {rev, count}：避免每轮都 silentInto 触发扩展熔断
const PREFS_REFRESH_EVERY = 5;
const failures = { archive: 0, recall: 0 };

function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    cfg = { ...DEFAULT_CONFIG, ...raw };
  } catch {
    cfg = { ...DEFAULT_CONFIG };
  }
}

function ensureDb() {
  if (db) return db;
  // 动态 import：core 缺失/损坏时整个扩展静默停用，不影响聊天主链。
  return import(CORE_PATH).then((m) => {
    core = m;
    db = m.openDb(DB_PATH);
    return db;
  });
}

// 启动即尝试初始化（失败则退化为"不记忆"，聊天照常）
let ready = null;
function init() {
  loadConfig();
  ready = ensureDb().then((handle) => {
    try {
      appendFileSync(
        BOOT_MARK,
        JSON.stringify({ at: new Date().toISOString(), db: DB_PATH, ok: handle !== null }) + '\n',
        { mode: 0o600 },
      );
    } catch {
      /* 标记失败不影响记忆功能 */
    }
    return handle;
  }).catch((err) => {
    failures.archive += 1;
    // 只在首次失败时提示一次，避免刷日志
    if (failures.archive === 1) {
      console.error('[whale-memory] 记忆库初始化失败，已降级为不记忆:', err?.message ?? err);
    }
    return null;
  });
  return ready;
}

/** 从 ctx.message 里尽量拿到平台消息标识与时间戳（缺失就退化）。 */
function readMeta(ctx) {
  const m = ctx.message ?? {};
  const scope = m.kind === 'group' ? 'group' : 'c2c';
  const peer = scope === 'group' ? String(m.groupOpenid ?? m.senderId ?? '') : String(m.senderId ?? '');
  const sender = String(m.senderId ?? '');
  const msgKey = String(m.msgIdx ?? m.id ?? m.messageId ?? '') || undefined;
  const ts = Number(m.timestamp ?? m.time ?? 0) || Date.now();
  return { scope, peer, sender, msgKey, ts };
}

/** 提取可归档文本：正文 + 附件类型标记（不保存二进制）。 */
function readText(ctx, m) {
  let text = String(m.content ?? ctx.text ?? '').trim();
  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  if (atts.length) {
    const kinds = atts
      .map((a) => {
        const ct = String(a?.content_type ?? '');
        if (ct.startsWith('image')) return '图片';
        if (ct === 'voice' || ct.startsWith('audio')) return '语音';
        if (ct.startsWith('video')) return '视频';
        return '附件';
      })
;
    text = `${text}${text ? ' ' : ''}[${kinds.join('/')}]`.trim();
  }
  if (cfg.maxTextChars > 0 && text.length > cfg.maxTextChars) text = text.slice(0, cfg.maxTextChars);
  return text;
}

const PREFS_PATH = join(WHALE_ROOT, 'data', 'qqwhale', 'persona-preferences.json');
const PREFS_CORE = join(WHALE_ROOT, 'bin', 'persona-prefs-core.mjs');
const PROACTIVE_PATH = join(WHALE_ROOT, 'etc', 'proactive.json');

/** 读取长期人格偏好：注入全部有效偏好，不按条数或字数静默丢弃。 */
function readPersonaPrefs() {
  try {
    const parsed = JSON.parse(readFileSync(PREFS_PATH, 'utf8'));
    return (Array.isArray(parsed?.items) ? parsed.items : [])
      .filter((x) => x && typeof x.text === 'string' && x.text.trim())
      .map((x) => ({ ...x, text: x.text.replace(/\s+/g, ' ').trim() }));
  } catch {
    return [];
  }
}

/** 当前机器人绑定的主人私聊 peer（主动关心目标）；偏好只对这个身份生效。 */
function ownerPeer() {
  try {
    const p = JSON.parse(readFileSync(PROACTIVE_PATH, 'utf8'));
    return /^[A-Fa-f0-9]{32}$/.test(String(p?.peer ?? '')) ? String(p.peer) : '';
  } catch { return ''; }
}

/** 只自动捕获明确的长期要求；带问号/疑问语气的消息不猜。 */
function isDurableInstruction(text) {
  const t = String(text ?? '').trim();
  if (!t || /[吗么？?]\s*$/.test(t)) return false;
  return /(记住|记一下|记好|以后都|以后不|今后|每次|必须|不许|不要再用|别再用|叫我|称呼我|我的名字是|设定是|设定为|人设是|当成|我们以后|我是.{0,10}(?:老师|学生|程序员)|我(?:喜欢|讨厌|习惯))/.test(t);
}

export async function onInbound(ctx, next) {
  let dbh = null;
  try {
    dbh = await (ready ?? init());
  } catch {
    dbh = null;
  }

  if (dbh && cfg.archiveEnabled !== false) {
    try {
      const meta = readMeta(ctx);
      const text = readText(ctx, ctx.message ?? {});
      if (text && meta.peer) {
        core.archiveMessage(dbh, {
          ...meta,
          senderName: String(ctx.senderName ?? '') || null,
          text,
        });
      }
    } catch {
      failures.archive += 1;
    }
  }

  const meta = readMeta(ctx);
  const incoming = String(ctx.text ?? '').trim();
  const owner = ownerPeer();
  const isOwner = meta.scope === 'c2c' && owner !== '' && meta.peer === owner;
  // 原文已经独立归档。只提醒按主题持久化，避免把一整条复合消息再次
  // 作为活跃偏好注入，导致更正后旧称呼/旧设定仍与新值并存。
  const needsDurableSave = isOwner && isDurableInstruction(incoming);
  const parts = [];
  let recalled = false;
  // ── 自动召回 ──────────────────────────────────────────────────────────────
  if (dbh && cfg.recallEnabled !== false) {
    try {
      const q = incoming;
      const now = Date.now();
      const last = lastRecallAt.get(meta.peer) ?? 0;
      const cooling = now - last < cfg.recallCooldownSec * 1000;
      // 只对"像一句话"的输入召回：太短（"嗯""好"）没有检索价值
      if (!cooling && q.length >= cfg.minQueryChars && meta.peer) {
        const hits = core.searchMessages(dbh, {
          q,
          peer: meta.peer,
          limit: cfg.recallMax,
          beforeTs: now - cfg.minGapMs,
          excludeRecent: cfg.excludeRecent,
        });
        // 过滤掉"本来就是这句话"的重复命中
        const useful = hits.filter((h) => core.clip(h.text, 40) !== core.clip(q, 40));
        if (useful.length > 0) {
          const lines = useful.map(
            (h) => `- ${core.fmtTime(h.ts)} ${h.sender_name ? `${h.sender_name}: ` : ''}${core.clip(h.text, 100)}`,
          );
          parts.push(`【记忆·自动召回】与你刚才这句可能相关的旧对话（独立归档，供参考，可能不完整）：\n${lines.join('\n')}`);
          recalled = true;
          lastRecallAt.set(meta.peer, now);
        }
      }
    } catch {
      failures.recall += 1;
    }
  }

  const prefs = isOwner ? readPersonaPrefs() : [];
  let prefsRev = '';
  try { prefsRev = createHash('sha256').update(readFileSync(PREFS_PATH)).digest('hex'); } catch { prefsRev = ''; }
  const injected = prefsInjected.get(meta.peer);
  const refresh = !injected || injected.rev !== prefsRev || needsDurableSave || (injected.count || 0) + 1 >= PREFS_REFRESH_EVERY;
  prefsInjected.set(meta.peer, { rev: prefsRev, count: refresh ? 0 : (injected?.count || 0) + 1 });
  let revoked = [];
  if (isOwner) { try { revoked = JSON.parse(readFileSync(PREFS_PATH,'utf8')).revoked || []; } catch {} }
  if ((prefs.length || revoked.length) && refresh) {
    const lines = [];
    let used = 0;
    for (const item of prefs.slice().reverse()) {
      const line = `- [${item.id}] [${item.kind||'preference'}${item.key?' · '+item.key:''}] ${item.text}`;
      lines.unshift(line);
      used += line.length + 1;
    }
    if (revoked.length) lines.push('已撤销的主题（不要从旧聊天恢复，除非用户重新明确设定）：'+revoked.map(x=>x.key).join('、'));
    if (lines.length) {
      parts.push(`【长期熟悉档案｜用户原意，最新更正优先；setting是共同设定，不等同现实fact】\n${lines.join('\n')}`);
    }
  }
  if (needsDurableSave) {
    parts.push('【本轮需要保存长期信息】用户原话已独立归档。请在结束本轮回复前，使用 persona_remember 按主题保存稳定信息或更正已有key；撤销旧设定用persona_forget。不要把整条复合消息另存成一条含多个主题的重复偏好。自然回应，不复述本提示。');
  }
  if (parts.length > 0 && ctx.silentInto) {
    const ok = ctx.silentInto(parts.join('\n\n'));
    if (ok === false && recalled) lastRecallAt.delete(meta.peer);
  }

  return next();
}

export function dispose() {
  try {
    db?.close?.();
  } catch {
    /* 忽略关闭失败 */
  }
  db = null;
  ready = null;
}

// 首次导入即初始化，boot 期间就把库准备好
init();
