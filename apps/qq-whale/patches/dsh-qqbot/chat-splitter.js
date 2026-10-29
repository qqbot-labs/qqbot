/**
 * 聊天消息语义分段器（QQ Whale 本地增强 v3）
 *
 * 目标：把“较长、包含多个完整句子/自然段/明显停顿”的普通聊天回复拆成
 * 2~5 条独立 QQ 消息；短回复、代码块、表格、列表、引用、标题保持一条。
 *
 * - 优先保留模型用空行分出的短消息，不再合回长段落；
 * - 自动分条只在完整句子/换行处分，不把逗号连接的长句从中间拆开；
 * - 分段基于原文索引切片，保留内容、标点和顺序；
 * - 链接、行内代码、括号、中文引号和 @ 标签内部不切。
 */

const SHORT_LIMIT = 40; // 一句说清的短回复保持一条
const TARGET_CHARS = 28; // 自动分条的目标长度；完整句子可以超出
const MAX_MESSAGES = 4;
const MAX_MESSAGES_VERY_LONG = 5; // QQ 被动回复额度内兜底，不截掉剩余正文
const MIN_MESSAGE_CHARS = 8;

const STRUCTURED = [
  /```/,
  /^\s*~~~/m,
  /^\s*\|.*\|\s*$/m,
  /^\s*#{1,6}\s+/m,
  /^\s*>\s+/m,
  /^\s*(?:[-*+]|\d+[.)])\s+/m,
  /^\s*<table\b/im,
];

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '…', '；', ';']);
const CLOSERS = new Set(['”', '’', '」', '』', '）', ')', '】', '》', '"', "'", '］', ']']);

/**
 * @param {string} input 原始回复文本
 * @returns {string[]} 按顺序排列的消息文本；无需拆分时返回单元素数组
 */
export function splitChatMessages(input) {
  const text = stripAssistantMeta(String(input ?? '').replace(/\r\n?/g, '\n').trim());
  if (!text) return [];
  // 结构化内容保持原样，由原有 4500 字上限切分器兜底。
  if (STRUCTURED.some((re) => re.test(text))) return [text];

  const units = tokenize(text);
  if (units.length < 2) return [text];

  const total = text.length;
  const cap = total >= 300 ? MAX_MESSAGES_VERY_LONG : MAX_MESSAGES;
  // 只认未受保护的空行：引号、括号或链接内的换行不会成为边界。
  const paragraphs = [];
  for (const unit of units) {
    const previous = paragraphs.at(-1);
    if (!previous || /\n[ \t]*\n/.test(text.slice(previous.at(-1).end, unit.start))) {
      paragraphs.push([unit]);
    } else previous.push(unit);
  }
  if (paragraphs.length >= 2 && paragraphs.length <= cap
      && paragraphs.every((group) => group.at(-1).end - group[0].start <= SHORT_LIMIT)) {
    return paragraphs.map((group) => text.slice(group[0].start, group.at(-1).end));
  }
  if (total < SHORT_LIMIT) return [text];

  const wanted = Math.min(
    cap,
    Math.max(2, Math.round(total / TARGET_CHARS)),
    units.length,
  );
  let groups = partition(units, wanted);
  groups = mergeShort(groups, MIN_MESSAGE_CHARS);
  if (groups.length < 2) return [text];

  const parts = groups
    .map((group) => text.slice(group[0].start, group[group.length - 1].end).trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts : [text];
}


/**
 * 去掉模型偶发夹带在正文前面的“元思考/计划”段落。
 *
 * 2026-10-24 实机样本：
 *   用户说周六要上课。回复应简短，关心一下。……短回复一条就行。
 *
 *   （空行）
 *   周六还上课，这安排也太狠了吧……
 *
 * 这段文字不是 reasoning 块，而是模型把推演写进了 text 块；如果直接发送，
 * QQ 会把“用户说……回复应……”当正文泄漏出去。只在前导段落有足够多元话术
 * 特征、且后面还有正文时删除，避免误伤普通用户内容。
 */
export function stripAssistantMeta(input) {
  const text = String(input ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  let out = text;
  const paras = text.split(/\n{2,}/);
  if (paras.length >= 2) {
    let cut = 0;
    while (cut < paras.length - 1 && looksLikeMeta(paras[cut])) cut += 1;
    if (cut > 0) out = paras.slice(cut).join('\n\n').trim();
  }
  const inline = stripInlineMeta(out);
  if (inline !== out) return inline;
  return looksLikeMeta(out) ? '' : out;
}


/** 处理没有空行、但把推演和正文写在同一段的情况。 */
function stripInlineMeta(text) {
  const sentences = text.split(/(?<=[。！？!?])\s*/).filter(Boolean);
  if (sentences.length < 2) return text;
  let cut = 0;
  for (let i = 0; i < sentences.length; i += 1) {
    const prefix = sentences.slice(0, i + 1).join('');
    if (!looksLikeMeta(prefix)) {
      if (cut > 0) break;
      continue;
    }
    cut = i + 1;
    const next = sentences[i + 1];
    if (next && !looksLikeMeta(next) && /(本鱼|主人|喵)/.test(next)) break;
  }
  if (cut === 0) return text;
  const rest = sentences.slice(cut).join('').trim();
  // 只有剩余部分确实像人格正文时才切；纯推演会交给外层整体丢弃。
  if (rest && /(本鱼|主人|喵)/.test(rest)) return rest;
  return text;
}

function looksLikeMeta(paragraph) {
  const s = String(paragraph || '').trim();
  if (!s || s.length > 180) return false;
  let score = 0;
  if (/用户(说|问|要|想|希望|刚|在|发了)/.test(s)) score += 2;
  if (/(回复|回答|这条|本次).{0,14}(应|要|可以|需要|应该|简短|分条|一条|两条|口吻|语气|关心)/.test(s)) score += 2;
  if (/(分条|短回复|一条或两条|一条即可|1~3句|2~4条|字数|不要太多|不用太多)/.test(s)) score += 1;
  if (/(意图拆解|记忆核对|台词编排|反讨好|二次校验|内部思考|思考过程|分析|计划)/.test(s)) score += 2;
  // 已经是面向用户的正文（含本鱼/主人/喵），不要误判
  if (/(本鱼|主人|喵)/.test(s) && !/用户/.test(s)) score -= 2;
  return score >= 3;
}

/**
 * 按完整句子和换行切分；跳过链接、行内代码、Markdown 链接、括号、
 * 中文引号和 <...> 标签内部。
 */
function tokenize(text) {
  const units = [];
  let start = 0;
  let i = 0;

  while (i < text.length) {
    const skip = protectedEnd(text, i);
    if (skip > i) {
      i = skip;
      continue;
    }
    const ch = text[i];
    if (ch === '\n') {
      pushUnit(units, text, start, i);
      start = i + 1;
      while (start < text.length && /[ \t]/.test(text[start])) start += 1;
      i = start;
      continue;
    }
    if (SENTENCE_END.has(ch)) {
      let end = i + 1;
      while (end < text.length && (SENTENCE_END.has(text[end]) || CLOSERS.has(text[end]))) end += 1;
      pushUnit(units, text, start, end);
      start = end;
      while (start < text.length && /\s/.test(text[start])) start += 1;
      i = start;
      continue;
    }
    i += 1;
  }
  pushUnit(units, text, start, text.length);
  return units;
}

function pushUnit(units, text, from, to) {
  const raw = text.slice(from, to);
  if (!raw.trim()) return;
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  units.push({
    start: from + leading,
    end: to - trailing,
    text: raw.trim(),
  });
}

function protectedEnd(text, i) {
  const ch = text[i];
  if (ch === '`') {
    const end = text.indexOf('`', i + 1);
    return end === -1 ? text.length : end + 1;
  }
  if ((ch === '!' && text[i + 1] === '[') || ch === '[') {
    const open = ch === '[' ? i : i + 1;
    const end = markdownLinkEnd(text, open);
    if (end > i) return end;
  }
  if (ch === '<') {
    const end = text.indexOf('>', i + 1);
    if (end !== -1) return end + 1;
  }
  if (ch === '(' || ch === '（') {
    const end = balancedEnd(text, i, ch, ch === '(' ? ')' : '）');
    if (end > i) return end;
  }
  if (ch === '“' || ch === '「' || ch === '『' || ch === '‘') {
    const close = { '“': '”', '「': '」', '『': '』', '‘': '’' }[ch];
    const end = text.indexOf(close, i + 1);
    if (end !== -1) return end + 1;
  }
  if ((ch === 'h' || ch === 'H') && /^https?:\/\//i.test(text.slice(i, i + 8))) {
    let end = i;
    while (end < text.length && !/\s/.test(text[end])) end += 1;
    return end;
  }
  return -1;
}

function markdownLinkEnd(text, open) {
  if (text[open] !== '[') return -1;
  const close = text.indexOf(']', open + 1);
  if (close === -1 || text[close + 1] !== '(') return -1;
  let depth = 1;
  for (let i = close + 2; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function balancedEnd(text, open, openChar, closeChar) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === openChar) depth += 1;
    else if (text[i] === closeChar) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 线性兜底分组：按累计长度切成接近均等的 wanted 组，用于极端长输入。 */
function greedyPartition(units, wanted) {
  const total = units.reduce((sum, unit) => sum + unit.text.length, 0);
  const target = total / wanted;
  const groups = [];
  let current = [];
  let currentLength = 0;
  for (let i = 0; i < units.length; i += 1) {
    current.push(units[i]);
    currentLength += units[i].text.length;
    const remainingGroups = wanted - groups.length - 1;
    const remainingUnits = units.length - i - 1;
    if (remainingGroups > 0 && remainingUnits >= remainingGroups && currentLength >= target) {
      groups.push(current);
      current = [];
      currentLength = 0;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * 按目标条数把有序单元分成若干组，尽量让每组长度接近。
 * 动态规划最小化“最长一组”的长度，避免前几条很长、最后一条只剩半句话。
 */
function partition(units, wanted) {
  const count = units.length;
  if (count > 500) return greedyPartition(units, wanted);

  const prefix = [0];
  for (const unit of units) prefix.push(prefix[prefix.length - 1] + unit.text.length);

  const infinity = Number.POSITIVE_INFINITY;
  const dp = Array.from({ length: wanted + 1 }, () => Array(count + 1).fill(infinity));
  const cut = Array.from({ length: wanted + 1 }, () => Array(count + 1).fill(-1));
  dp[0][0] = 0;

  for (let group = 1; group <= wanted; group += 1) {
    for (let end = group; end <= count; end += 1) {
      for (let start = group - 1; start < end; start += 1) {
        const candidate = Math.max(dp[group - 1][start], prefix[end] - prefix[start]);
        if (candidate < dp[group][end]) {
          dp[group][end] = candidate;
          cut[group][end] = start;
        }
      }
    }
  }

  const groups = [];
  let end = count;
  for (let group = wanted; group >= 1; group -= 1) {
    const start = cut[group][end];
    if (start < 0) return units.map((unit) => [unit]);
    groups.unshift(units.slice(start, end));
    end = start;
  }
  return groups;
}

/** 把过短的分组并入相邻消息，避免出现“嗯。”这种独立气泡。 */
function mergeShort(groups, minimum) {
  const merged = [];
  for (const group of groups) {
    const length = group.reduce((sum, unit) => sum + unit.text.length, 0);
    if (merged.length && length < minimum) merged[merged.length - 1].push(...group);
    else merged.push([...group]);
  }
  if (merged.length > 1) {
    const firstLength = merged[0].reduce((sum, unit) => sum + unit.text.length, 0);
    if (firstLength < minimum) {
      merged[1] = merged[0].concat(merged[1]);
      merged.shift();
    }
  }
  return merged;
}
