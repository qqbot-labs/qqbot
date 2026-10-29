#!/usr/bin/env node
/**
 * llm-evidence.mjs —— 从 DSH 会话存储与插件轮次日志里提取「模型/消息真的跑过」的证据。
 *
 * 为什么需要它（真机实测结论）：
 *   DSH 的常规运行日志只打印启动横幅、面板地址、网关就绪等少量事件，**不输出**
 *   模型调用成功（completion）事件。因此只靠扫描日志判断模型健康，结论永远是
 *   "未知"——即使模型确实调用成功。审查阶段已确认这一限制并如实保留，但
 *   "永远未知"对无人值守告警没有价值。
 *
 *   而每次调用真的发生时，DSH 与插件都会留下**直接产物**：
 *     1) $DSH_HOME/storages/<proj>/sessions/*.json
 *        里的 record.rows.tokenUsage.val —— 累计与「最近一次」的 token 用量，
 *        含 turn/step。没有真实调用就不会有这个计数，也无法被伪造性地增长。
 *     2) $WHALE_ROOT/data/.qqbot/thinking-log.jsonl 与 four-source.jsonl ——
 *        插件按轮写入的助手思考/回复长度记录，带毫秒时间戳与轮次号。
 *
 *   两者结合即可回答两个问题：模型最近是否成功跑过？消息通道最近是否有往来？
 *
 * 安全与副作用：只读；不解析正文内容（只取字段名与数值）；不写任何文件；
 *   不发起网络请求；不输出用户消息文本。
 *
 * 用法：
 *   node llm-evidence.mjs --dsh-home <dir> --data-root <dir> [--max-age-hours 24] [--json]
 * 输出（默认 KEY=VALUE，便于 bash 直接解析）：
 *   MODEL_STATUS=ok|stale|none       模型调用证据状态
 *   MODEL_AGE_SECONDS=<n>            最近一次成功调用距今秒数（none 时为空）
 *   MODEL_TOTAL_OUTPUT_TOKENS=<n>    累计输出 token
 *   MODEL_TOTAL_INPUT_TOKENS=<n>     累计未缓存输入 token
 *   MODEL_CACHE_READ_TOKENS=<n>      累计缓存命中 token
 *   MODEL_LAST_TURN / MODEL_LAST_STEP
 *   MODEL_PROVIDER / MODEL_MODEL
 *   MSG_STATUS=ok|stale|none         消息往来证据状态
 *   MSG_AGE_SECONDS / MSG_TURNS / MSG_SCOPE
 *   EVIDENCE_NOTE=<中文说明>
 */

import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { scanProofs,replyProof } from './session-evidence.mjs';

// ── 参数解析 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const dshHome = opt('dsh-home', process.env.DSH_HOME || '');
const dataRoot = opt('data-root', process.env.WHALE_ROOT ? join(process.env.WHALE_ROOT, 'data') : '');
const maxAgeHours = Number(opt('max-age-hours', '24'));
const asJson = argv.includes('--json');
const proofs=scanProofs(dshHome);
const reply=replyProof(proofs,dataRoot);
const maxAgeMs = (Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : 24) * 3600 * 1000;

// ── 小工具 ──────────────────────────────────────────────────────────────────
function safeStat(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** 只读文件尾部若干字节：插件 jsonl 可能随运行时间增长，避免整读。 */
function tailText(file, bytes = 65536) {
  let fd;
  try {
    const st = safeStat(file);
    if (!st || !st.isFile()) return '';
    const size = st.size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* 忽略关闭失败 */
      }
    }
  }
}

/** 取 jsonl 里最后一条可解析的对象。 */
function lastJsonLine(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i].trim();
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {
      /* 跳过半行或损坏行 */
    }
  }
  return null;
}

/** 递归寻找 sessions 目录下的会话 JSON。限制深度与数量，避免异常目录树拖死监控。 */
function findSessionFiles(root) {
  const out = [];
  const limit = 400;
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.json') && /(^|\/)sessions(\/|$)/.test(dir)) {
        // 只要路径里出现 sessions 段就算会话目录：上游可能把文件直接放在
        // sessions/ 下，也可能再分一层（sessions/<proj>/）。用 endsWith('sessions')
        // 会漏掉后者（已在夹具回归里踩到）。
        out.push(p);
      }
    }
  };
  walk(join(root, 'storages'), 0);
  return out;
}

/** 从会话 JSON 里取 tokenUsage；没有真实调用过的会话直接排除。 */
function readSession(file) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const val = doc?.record?.rows?.tokenUsage?.val;
  const totals = val?.totals;
  const last = val?.last;
  if (!totals || typeof totals.outputTokens !== 'number') return null;
  if (!(totals.outputTokens > 0)) return null; // 从未成功产出过 token
  const actual=proofs.get(basename(file,'.json'))?.lastModel;
  const mtime=actual?.ts||0;

  // provider/model：优先读 modelSelection，缺失时退化为全文首个匹配。
  let provider = '';
  let model = '';
  const sel = doc?.record?.rows?.modelSelection?.val;
  if (sel && typeof sel === 'object') {
    provider = sel.provider || sel.model?.provider || '';
    model = sel.model?.id || sel.model?.name || sel.modelId || '';
  }
  if (!provider || !model) {
    let text = '';
    try {
      text = JSON.stringify(sel ?? doc).slice(0, 200000);
    } catch {
      text = '';
    }
    if (!provider) provider = (text.match(/"provider"\s*:\s*"([^"]{1,80})"/) || [])[1] || '';
    if (!model) model = (text.match(/"model"\s*:\s*"([^"]{1,120})"/) || [])[1] || '';
  }
  if(actual?.provider)provider=actual.provider;
  if(actual?.model)model=actual.model;
  return {
    file,
    mtime,
    turn: last?.turn,
    step: last?.step,
    lastOutput: last?.buckets?.outputTokens ?? 0,
    totals: {
      input: totals.uncachedInputTokens ?? 0,
      output: totals.outputTokens ?? 0,
      cacheRead: totals.cacheReadTokens ?? 0,
    },
    provider,
    model,
  };
}

/** 插件轮次日志：thinking-log.jsonl 有 ts/turn/scope；four-source.jsonl 有 ts/replyChars。 */
function readPluginTurn(file) {
  const obj = lastJsonLine(tailText(file));
  if (!obj || typeof obj.ts !== 'number') return null;
  return {
    ts: obj.ts,
    turn: typeof obj.turn === 'number' ? obj.turn : undefined,
    scope: typeof obj.scope === 'string' ? obj.scope : undefined,
    replyChars: typeof obj.replyChars === 'number' ? obj.replyChars : undefined,
  };
}

// ── 采集 ────────────────────────────────────────────────────────────────────
const now = Date.now();
let session = null;
if (dshHome) {
  for (const f of findSessionFiles(dshHome)) {
    const s = readSession(f);
    if (!s) continue;
    if (!session || s.mtime > session.mtime) session = s;
  }
}

const thinking = dataRoot ? readPluginTurn(join(dataRoot, '.qqbot', 'thinking-log.jsonl')) : null;
const fourSource = dataRoot ? readPluginTurn(join(dataRoot, '.qqbot', 'four-source.jsonl')) : null;
const msgTurn = [thinking, fourSource].filter(Boolean).sort((a, b) => (b.ts || 0) - (a.ts || 0))[0] || null;

function classify(tsMs) {
  if (!tsMs) return 'none';
  return now - tsMs <= maxAgeMs ? 'ok' : 'stale';
}

const modelTs = session ? session.mtime : 0;
const modelStatus = classify(modelTs);
const msgStatus = classify(msgTurn?.ts ?? 0);

const hours = (ms) => Math.round((ms / 3600000) * 10) / 10;
const notes = [];
if (modelStatus === 'ok') {
  notes.push(`模型最近一次成功调用约 ${hours(now - modelTs)} 小时前（实际模型事件有输出 token）`);
} else if (modelStatus === 'stale') {
  notes.push(`已有 ${hours(now - modelTs)} 小时未见模型调用（历史调用成功过，当前可能是空闲）`);
} else {
  notes.push('尚无任何成功模型调用记录；若已有凭据，请发一条消息验证');
}
if (msgTurn?.ts) {
  notes.push(
    msgStatus === 'ok'
      ? `消息通道最近约 ${hours(now - msgTurn.ts)} 小时前有往来（第 ${msgTurn.turn ?? '?'} 轮）`
      : `消息通道已 ${hours(now - msgTurn.ts)} 小时无往来`,
  );
}

const result = {
  MODEL_STATUS: modelStatus,
  REPLY_STATUS: reply.status,
  REPLY_ERROR_CODES: reply.codes,
  MODEL_AGE_SECONDS: modelTs ? Math.round((now - modelTs) / 1000) : '',
  MODEL_TOTAL_OUTPUT_TOKENS: session ? session.totals.output : '',
  MODEL_TOTAL_INPUT_TOKENS: session ? session.totals.input : '',
  MODEL_CACHE_READ_TOKENS: session ? session.totals.cacheRead : '',
  MODEL_LAST_TURN: session?.turn ?? '',
  MODEL_LAST_STEP: session?.step ?? '',
  MODEL_LAST_OUTPUT_TOKENS: session?.lastOutput ?? '',
  MODEL_PROVIDER: session?.provider || '',
  MODEL_MODEL: session?.model || '',
  MODEL_SESSION_FILE: session ? basename(session.file) : '',
  MSG_STATUS: msgStatus,
  MSG_AGE_SECONDS: msgTurn?.ts ? Math.round((now - msgTurn.ts) / 1000) : '',
  MSG_TURNS: msgTurn?.turn ?? '',
  MSG_SCOPE: msgTurn?.scope || '',
  EVIDENCE_NOTE: notes.join('；'),
};

// ── 输出 ────────────────────────────────────────────────────────────────────
if (asJson) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  for (const [k, v] of Object.entries(result)) {
    // 值里若含换行会破坏 KEY=VALUE 解析，这里压成空格（说明字段本身不含敏感信息）
    process.stdout.write(`${k}=${String(v).replace(/\s+/g, ' ')}\n`);
  }
}
