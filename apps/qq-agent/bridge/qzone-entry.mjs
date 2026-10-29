// deploy/qzone-entry.ts
import fs6 from "node:fs";

// vendor/onebot-qzone/src/qzone/client.ts
import fs3 from "node:fs";
import path2 from "node:path";
import { URL as URL2 } from "node:url";
import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import pLimit from "p-limit";
import { CookieJar } from "tough-cookie";

// vendor/onebot-qzone/src/qzone/utils.ts
function calcGtk(val) {
  let hsh = 5381;
  for (let i = 0; i < val.length; i++) {
    hsh += (hsh << 5) + val.charCodeAt(i);
  }
  return hsh & 2147483647;
}
function parseJsonp(text, _callback) {
  const s = text.trim();
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      return JSON.parse(s);
    } catch {
    }
  }
  const fcbIdx = s.indexOf("frameElement.callback(");
  if (fcbIdx !== -1) {
    const start = fcbIdx + "frameElement.callback(".length;
    const inner = extractBracketContent(s, start - 1);
    if (inner !== null) {
      try {
        return JSON.parse(inner);
      } catch {
      }
    }
  }
  const open = s.indexOf("(");
  if (open !== -1) {
    const inner = extractBracketContent(s, open);
    if (inner !== null) {
      try {
        return JSON.parse(inner);
      } catch {
      }
    }
  }
  try {
    return JSON.parse(s);
  } catch {
    return { _empty: true, raw: s.slice(0, 500) };
  }
}
function extractBracketContent(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return s.slice(openIdx + 1, i);
    }
  }
  return null;
}
function safeDecodeJsonResponse(body, jsonpCallback) {
  let text;
  if (Buffer.isBuffer(body)) {
    text = body.toString("utf8");
    if (text.includes("\u53C2\u6570\u9519\u8BEF") || text.includes("\uFFFD")) {
      const latin = body.toString("latin1");
      if (!latin.includes("\uFFFD")) text = latin;
    }
  } else {
    text = body;
  }
  if (!text.trim()) {
    return { _empty: true, http_status: 200 };
  }
  const parsed = parseJsonp(text, jsonpCallback);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
  return { _empty: true, raw: text.slice(0, 200) };
}
function log(level, msg) {
  const ts = (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] [${level}] ${msg}`);
}
function htmlUnescape(s) {
  return s.replace(/&nbsp;/gi, " ").replace(/\u00a0/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10))).replace(
    /&#x([0-9a-fA-F]+);/g,
    (_, h) => String.fromCharCode(parseInt(h, 16))
  );
}

// vendor/onebot-qzone/src/qzone/cookieStore.ts
import fs from "node:fs";
import path from "node:path";
var COOKIE_REFRESH_MS = 14 * 24 * 60 * 60 * 1e3;
function saveCookies(cookiePath, cookies) {
  try {
    const dir = path.dirname(cookiePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data2 = {
      last_used: Date.now() / 1e3,
      cookies
    };
    fs.writeFileSync(cookiePath, JSON.stringify(data2, null, 2), "utf8");
  } catch (e) {
    log("WARNING", `saveCookies \u5931\u8D25: ${e}`);
  }
}
function loadCookies(cookiePath) {
  if (!fs.existsSync(cookiePath)) return null;
  try {
    const raw = fs.readFileSync(cookiePath, "utf8");
    const data2 = JSON.parse(raw);
    const lastUsedMs = data2.last_used * 1e3;
    if (Date.now() - lastUsedMs > COOKIE_REFRESH_MS) {
      log("INFO", "Cookie \u6587\u4EF6\u5DF2\u8D85\u8FC7 14 \u5929\uFF0C\u5C06\u5220\u9664");
      fs.unlinkSync(cookiePath);
      return null;
    }
    return {
      cookies: data2.cookies ?? {},
      lastUsed: new Date(lastUsedMs)
    };
  } catch {
    try {
      fs.unlinkSync(cookiePath);
    } catch {
    }
    return null;
  }
}
function deleteCookies(cookiePath) {
  try {
    if (fs.existsSync(cookiePath)) fs.unlinkSync(cookiePath);
  } catch {
  }
}

// vendor/onebot-qzone/src/qzone/validate.ts
import "zod";

// vendor/onebot-qzone/src/qzone/schemas.ts
import { z } from "zod";
var QzoneResponseEnvelope = z.object({
  code: z.number().optional(),
  message: z.string().optional(),
  msg: z.string().optional()
}).passthrough();
var QzoneSuccessEnvelope = QzoneResponseEnvelope.refine(
  (d) => d.code === 0 || d.code === void 0,
  { message: "\u4E1A\u52A1\u7801\u975E 0\uFF0C\u63A5\u53E3\u53EF\u80FD\u88AB\u9650\u6D41\u6216\u9274\u6743\u5931\u8D25" }
);
var EmotionPicSchema = z.object({
  url1: z.string().optional(),
  url2: z.string().optional(),
  url3: z.string().optional(),
  url: z.string().optional(),
  smallurl: z.string().optional()
}).passthrough();
var EmotionItemSchema = z.object({
  tid: z.coerce.string().min(1, "\u8BF4\u8BF4 tid \u4E0D\u80FD\u4E3A\u7A7A"),
  uin: z.coerce.string(),
  content: z.string().default(""),
  nickname: z.string().default(""),
  created_time: z.coerce.number().default(0),
  cmtnum: z.coerce.number().default(0),
  likenum: z.coerce.number().default(0),
  fwdnum: z.coerce.number().default(0),
  pic: z.array(EmotionPicSchema).optional().default([])
}).passthrough();
var EmotionListResponseSchema = z.object({
  code: z.number(),
  msglist: z.array(EmotionItemSchema).nullable().optional()
}).passthrough();
var CommentItemSchema = z.object({
  content: z.string().default(""),
  create_time: z.coerce.number().default(0)
}).passthrough();
var CommentListResponseSchema = z.object({
  code: z.number(),
  commentlist: z.array(CommentItemSchema).nullable().optional()
}).passthrough();
var UserInfoResponseSchema = z.object({
  code: z.number().optional()
}).passthrough();
var FriendItemSchema = z.object({
  uin: z.coerce.string().min(1),
  nickname: z.string().default("")
}).passthrough();
var FriendListResponseSchema = z.object({
  code: z.number(),
  data: z.object({
    items: z.array(FriendItemSchema).optional(),
    total: z.coerce.number().optional()
  }).passthrough().optional()
}).passthrough();
var AlbumListResponseSchema = z.object({
  code: z.number().optional()
}).passthrough();
var VisitorResponseSchema = z.object({
  code: z.number().optional()
}).passthrough();
var PublishResponseSchema = z.object({
  code: z.number().optional()
}).passthrough();
var SocialActionResponseSchema = z.object({
  code: z.number().optional(),
  ret: z.number().optional()
}).passthrough();
var ShuoshuoDetailResponseSchema = z.object({
  code: z.number().optional()
}).passthrough();
var TrafficDataResponseSchema = z.object({
  code: z.number().optional(),
  data: z.array(z.object({
    current: z.object({
      newdata: z.record(z.string(), z.unknown()).optional()
    }).passthrough().optional()
  }).passthrough()).optional()
}).passthrough();
var SCHEMA_REGISTRY = {
  emotion_list: EmotionListResponseSchema,
  comment_list: CommentListResponseSchema,
  user_info: UserInfoResponseSchema,
  friend_list: FriendListResponseSchema,
  album_list: AlbumListResponseSchema,
  visitor: VisitorResponseSchema,
  publish: PublishResponseSchema,
  social_action: SocialActionResponseSchema,
  shuoshuo_detail: ShuoshuoDetailResponseSchema,
  traffic_data: TrafficDataResponseSchema
};

// deploy/qzone-no-raw-log.ts
function dumpRawResponse(..._args) {
}

// vendor/onebot-qzone/src/qzone/validate.ts
function validateApiResponse(schemaName, payload, rawText) {
  const schema = SCHEMA_REGISTRY[schemaName];
  if (!schema) {
    log("WARNING", `\u672A\u6CE8\u518C\u7684 schema: ${schemaName}\uFF0C\u8DF3\u8FC7\u6821\u9A8C`);
    return { ok: true, data: payload, issues: [], raw: payload };
  }
  const result = schema.safeParse(payload);
  if (result.success) {
    return { ok: true, data: result.data, issues: [], raw: payload };
  }
  const issues = result.error.issues.map(
    (i) => `${i.path.join(".")}: ${i.message}`
  );
  log("WARNING", `[validate:${schemaName}] \u6821\u9A8C\u5931\u8D25: ${issues.join("; ")}`);
  if (rawText) {
    dumpRawResponse(schemaName, rawText, issues);
  }
  return { ok: false, data: null, issues, raw: payload };
}

// vendor/onebot-qzone/src/qzone/config/constants.ts
var CACHE_TTL = {
  /** qzonetoken 缓存有效期 */
  qzonetoken: 300,
  // 5 min
  /** qzonetoken 获取失败后的冷却期 */
  qzonetokenFail: 600,
  // 10 min
  /** Playwright 启动失败后的冷却期 */
  playwrightFail: 1800,
  // 30 min
  /** 详情接口全部变体失败后的冷却期 */
  detailAllFail: 300,
  // 5 min
  /** feeds3 页面缓存有效期 */
  feeds3: 30
  // 30 s
};
var ANTI_CRAWL_PATTERNS = [
  /系统繁忙/,
  /访问过于频繁/,
  /安全验证/,
  /请输入验证码/,
  /tcaptcha/i,
  /需要登录/,
  /请先登录/,
  /g_isSurvey/,
  /<title>QQ空间<\/title>[\s\S]{0,500}<script/
];
var AUTH_FAILURE_CODES = /* @__PURE__ */ new Set([
  -3,
  -100,
  -3e3,
  -10001,
  -10006
]);
var RATE_LIMIT_CODES = /* @__PURE__ */ new Set([
  -1e4,
  -2
]);
var USER_AGENTS = {
  desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  mobile: "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/95.0.4638.74 Mobile Safari/537.36",
  secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"'
};
var USER_AGENT_POOL = [
  // Chrome Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  // Chrome macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  // Edge Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"
];
var ACCEPT_LANGUAGE_POOL = [
  "zh-CN,zh;q=0.9,en;q=0.8",
  "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "zh-CN,zh-TW;q=0.9,zh;q=0.8,en;q=0.7",
  "zh;q=0.9,en;q=0.8",
  "en-US,en;q=0.9,zh-CN;q=0.8"
];
function getRandomUserAgent() {
  return USER_AGENT_POOL[Math.floor(Math.random() * USER_AGENT_POOL.length)];
}
function getRandomAcceptLanguage() {
  return ACCEPT_LANGUAGE_POOL[Math.floor(Math.random() * ACCEPT_LANGUAGE_POOL.length)];
}
var LIMITS = {
  /** 单次拉取说说条数上限 */
  defaultFeedCount: 20,
  /** 单次拉取评论条数上限 */
  defaultCommentCount: 20,
  /** 响应落盘最大文件大小 */
  rawLogMaxFileSize: 5 * 1024 * 1024,
  /** 响应落盘最大文件数 */
  rawLogMaxFiles: 500
};

// vendor/onebot-qzone/src/qzone/requestLayer.ts
function parseRawResponse(httpStatus, rawText, opts) {
  const label = opts?.apiLabel ?? "unknown";
  if (httpStatus >= 400) {
    log("WARNING", `[${label}] HTTP ${httpStatus}`);
    dumpRawResponse(label, rawText, [`HTTP ${httpStatus}`]);
    return {
      httpStatus,
      payload: { code: -httpStatus, _empty: true, http_status: httpStatus },
      rawText,
      isAntiCrawl: false,
      isAuthFailure: httpStatus === 401 || httpStatus === 403,
      isRateLimited: httpStatus === 429,
      bizCode: void 0
    };
  }
  const isAntiCrawl = ANTI_CRAWL_PATTERNS.some((re) => re.test(rawText));
  if (isAntiCrawl) {
    log("WARNING", `[${label}] \u68C0\u6D4B\u5230\u53CD\u722C\u7279\u5F81`);
    dumpRawResponse(label, rawText, ["anti-crawl-detected"]);
  }
  let payload;
  try {
    const parsed = parseJsonp(rawText, opts?.jsonpCallback);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed;
    } else {
      payload = { _empty: true, raw: rawText.slice(0, 200) };
    }
  } catch (e) {
    log("WARNING", `[${label}] JSONP \u89E3\u6790\u5931\u8D25: ${e}`);
    dumpRawResponse(label, rawText, [`parse-error: ${e}`]);
    payload = { _empty: true, raw: rawText.slice(0, 200) };
  }
  const bizCode = typeof payload.code === "number" ? payload.code : typeof payload.ret === "number" ? payload.ret : void 0;
  const isAuthFailure = bizCode !== void 0 && AUTH_FAILURE_CODES.has(bizCode);
  const isRateLimited = bizCode !== void 0 && RATE_LIMIT_CODES.has(bizCode);
  let validation;
  if (opts?.schemaName) {
    validation = validateApiResponse(opts.schemaName, payload, rawText);
  }
  return {
    httpStatus,
    payload,
    rawText,
    isAntiCrawl,
    isAuthFailure,
    isRateLimited,
    bizCode,
    validation
  };
}

// vendor/onebot-qzone/src/qzone/config/env.ts
function str(key, fallback = "") {
  return (process.env[key] ?? fallback).trim();
}
function bool(key, fallback = false) {
  const v = str(key);
  if (!v) return fallback;
  return ["1", "true", "yes"].includes(v.toLowerCase());
}
function int(key, fallback) {
  const v = parseInt(str(key), 10);
  return Number.isNaN(v) ? fallback : v;
}
var env = {
  // ── Playwright ────────────────────────────
  get playwrightExecutable() {
    return str("QZONE_PLAYWRIGHT_EXECUTABLE");
  },
  get playwrightChannel() {
    return str("QZONE_PLAYWRIGHT_CHANNEL", "chrome");
  },
  get playwrightTimeoutMs() {
    return int("QZONE_PLAYWRIGHT_TIMEOUT_MS", 15e3);
  },
  /** 强制 headless 模式（'1'/'true'=强制 headless，'0'/'false'=强制 headed，空=自动检测 DISPLAY） */
  get playwrightHeadless() {
    const v = str("QZONE_PLAYWRIGHT_HEADLESS");
    if (!v) return null;
    if (["1", "true", "yes"].includes(v.toLowerCase())) return true;
    if (["0", "false", "no"].includes(v.toLowerCase())) return false;
    return null;
  },
  // ── Cookie ────────────────────────────────
  /** QZONE_COOKIE_STRING 或 QZONE_COOKIE（兼容两种写法） */
  get cookieString() {
    return str("QZONE_COOKIE_STRING") || str("QZONE_COOKIE");
  },
  // ── 调试 / 特性开关 ──────────────────────
  get debugDump() {
    return bool("QZONE_DEBUG_DUMP");
  },
  get friendPlaywright() {
    return bool("QZONE_FRIEND_PLAYWRIGHT");
  },
  get instantLikePlaywright() {
    return bool("QZONE_INSTANT_LIKE_PLAYWRIGHT", true);
  },
  get instantLikeSourceStrategy() {
    return str("QZONE_INSTANT_LIKE_SOURCE", "playwright_first");
  },
  get proxyUrl() {
    return str("QZONE_PROXY_URL");
  },
  get proxyPool() {
    return str("QZONE_PROXY_POOL");
  },
  get imageProxyUrl() {
    return str("QZONE_IMAGE_PROXY");
  },
  /** 探针失败时跳过静默续期，仍用已缓存 Cookie 启动（无头环境 Chrome 不可用时使用） */
  get skipRefreshOnStart() {
    return bool("QZONE_SKIP_REFRESH_ON_START");
  },
  // ── 路径 ──────────────────────────────────
  get cachePath() {
    return str("QZONE_CACHE_PATH", "./test_cache");
  }
};

// vendor/onebot-qzone/src/qzone/feeds3/preprocess.ts
function preprocessHtml(text) {
  const startTime = Date.now();
  const originalLength = text.length;
  let replacements = 0;
  let processed = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  processed = processed.replace(/&nbsp;/gi, " ").replace(/\u00a0/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  replacements += (text.match(/&amp;|&lt;|&gt;|&nbsp;|\u00a0/gi) || []).length;
  processed = processed.replace(/>\s+</g, "><");
  processed = processed.replace(new RegExp("\\\\\\\\/", "g"), "/").replace(new RegExp("\\\\x27", "g"), "'");
  const duration = Date.now() - startTime;
  log("DEBUG", `preprocessHtml: ${originalLength} -> ${processed.length} chars, ${replacements} replacements, ${duration}ms`);
  return {
    text: processed,
    stats: { originalLength, processedLength: processed.length, replacements }
  };
}

// vendor/onebot-qzone/src/qzone/emoji.ts
var EMOJI_NAME_MAP = {
  // 基础表情 (e100-e149)
  "e100": "[\u5FAE\u7B11]",
  "e101": "[\u6487\u5634]",
  "e102": "[\u8272]",
  "e103": "[\u53D1\u5446]",
  "e104": "[\u5F97\u610F]",
  "e105": "[\u6D41\u6CEA]",
  "e106": "[\u5BB3\u7F9E]",
  "e107": "[\u95ED\u5634]",
  "e108": "[\u7761]",
  "e109": "[\u5927\u54ED]",
  "e110": "[\u5C34\u5C2C]",
  "e111": "[\u53D1\u6012]",
  "e112": "[\u8C03\u76AE]",
  "e113": "[\u5472\u7259]",
  "e114": "[\u60CA\u8BB6]",
  "e115": "[\u96BE\u8FC7]",
  "e116": "[\u9177]",
  "e117": "[\u51B7\u6C57]",
  "e118": "[\u6293\u72C2]",
  "e119": "[\u5410]",
  "e120": "[\u5077\u7B11]",
  "e121": "[\u53EF\u7231]",
  "e122": "[\u767D\u773C]",
  "e123": "[\u50B2\u6162]",
  "e124": "[\u9965\u997F]",
  "e125": "[\u56F0]",
  "e126": "[\u60CA\u6050]",
  "e127": "[\u6D41\u6C57]",
  "e128": "[\u61A8\u7B11]",
  "e129": "[\u5927\u5175]",
  "e130": "[\u594B\u6597]",
  "e131": "[\u5492\u9A82]",
  "e132": "[\u7591\u95EE]",
  "e133": "[\u5618]",
  "e134": "[\u6655]",
  "e135": "[\u6298\u78E8]",
  "e136": "[\u8870]",
  "e137": "[\u9AB7\u9AC5]",
  "e138": "[\u6572\u6253]",
  "e139": "[\u518D\u89C1]",
  "e140": "[\u64E6\u6C57]",
  "e141": "[\u62A0\u9F3B]",
  "e142": "[\u9F13\u638C]",
  "e143": "[\u7CD7\u5927\u4E86]",
  "e144": "[\u574F\u7B11]",
  "e145": "[\u5DE6\u54FC\u54FC]",
  "e146": "[\u53F3\u54FC\u54FC]",
  "e147": "[\u54C8\u6B20]",
  "e148": "[\u9119\u89C6]",
  "e149": "[\u59D4\u5C48]",
  // 更多表情 (e150-e199)
  "e150": "[\u5FEB\u54ED\u4E86]",
  "e151": "[\u9634\u9669]",
  "e152": "[\u4EB2\u4EB2]",
  "e153": "[\u5413]",
  "e154": "[\u53EF\u601C]",
  "e155": "[\u83DC\u5200]",
  "e156": "[\u897F\u74DC]",
  "e157": "[\u5564\u9152]",
  "e158": "[\u7BEE\u7403]",
  "e159": "[\u4E52\u4E53]",
  "e160": "[\u5496\u5561]",
  "e161": "[\u996D]",
  "e162": "[\u732A\u5934]",
  "e163": "[\u73AB\u7470]",
  "e164": "[\u51CB\u8C22]",
  "e165": "[\u793A\u7231]",
  "e166": "[\u7231\u5FC3]",
  "e167": "[\u5FC3\u788E]",
  "e168": "[\u86CB\u7CD5]",
  "e169": "[\u95EA\u7535]",
  "e170": "[\u70B8\u5F39]",
  "e171": "[\u5200]",
  "e172": "[\u8DB3\u7403]",
  "e173": "[\u74E2\u866B]",
  "e174": "[\u4FBF\u4FBF]",
  "e175": "[\u6708\u4EAE]",
  "e176": "[\u592A\u9633]",
  "e177": "[\u793C\u7269]",
  "e178": "[\u62E5\u62B1]",
  "e179": "[\u5F3A]",
  "e180": "[\u5F31]",
  "e181": "[\u63E1\u624B]",
  "e182": "[\u80DC\u5229]",
  "e183": "[\u62B1\u62F3]",
  "e184": "[\u52FE\u5F15]",
  "e185": "[\u62F3\u5934]",
  "e186": "[\u5DEE\u52B2]",
  "e187": "[\u7231\u4F60]",
  "e188": "[NO]",
  "e189": "[OK]",
  // 新版表情 (e190-e204)
  "e190": "[\u7231\u60C5]",
  "e191": "[\u98DE\u543B]",
  "e192": "[\u8DF3\u8DF3]",
  "e193": "[\u53D1\u6296]",
  "e194": "[\u6004\u706B]",
  "e195": "[\u8F6C\u5708]",
  "e196": "[\u78D5\u5934]",
  "e197": "[\u56DE\u5934]",
  "e198": "[\u8DF3\u7EF3]",
  "e199": "[\u6325\u624B]",
  "e200": "[\u6FC0\u52A8]",
  "e201": "[\u8857\u821E]",
  "e202": "[\u732E\u543B]",
  "e203": "[\u5DE6\u592A\u6781]",
  "e204": "[\u53F3\u592A\u6781]",
  // 新表情 (e243, e247, e249, e257, e282, e302)
  "e243": "[\u6CEA\u5954]",
  "e247": "[\u55B7\u8840]",
  "e249": "[doge]",
  "e257": "[\u{1F47B}]",
  "e282": "[\u6258\u816E]",
  "e302": "[\u{1F64F}]",
  // 超长编号表情 (e400000+ 系列)
  "e400343": "[\u53D8\u5F62]",
  "e400820": "[\u55C5\u55C5]",
  "e400827": "[\u54DF\u543C]",
  "e400840": "[\u575A\u5F3A]",
  "e400841": "[\u6325\u624B\u544A\u522B]",
  "e400843": "[\u6478\u5934]",
  "e400844": "[\u98DE\u543B2]",
  "e400845": "[\u4EB2\u4EB22]",
  "e400846": "[\u62B1\u6028]",
  "e400847": "[\u9707\u60CA]",
  "e400848": "[\u6655\u5012]",
  "e400849": "[\u671F\u5F85]",
  "e400850": "[\u60CA\u8BB62]",
  "e400851": "[\u5BB3\u6015]",
  "e400852": "[\u5927\u7B11]",
  "e400853": "[\u5F00\u5FC3]",
  "e400854": "[\u65E0\u804A2]",
  "e400855": "[\u54CE\u5440]",
  "e400856": "[\u594B\u65972]",
  "e400857": "[\u59D4\u5C482]",
  "e400858": "[\u6124\u6012]",
  "e400859": "[\u54ED\u6CE3]",
  "e400860": "[\u559C\u6B22]",
  "e400861": "[\u7231\u4F602]",
  // 特殊大表情 (e10000+)
  "e10261": "[\u5FD9\u5230\u98DE\u8D77]",
  "e10262": "[\u8111\u9614\u75BC]",
  "e10263": "[\u6CA7\u6851]",
  "e10264": "[\u6342\u8138]",
  "e10265": "[\u8FA3\u773C\u775B]",
  "e10266": "[\u54E6\u5466]",
  "e10267": "[\u5934\u79C3]",
  "e10268": "[\u95EE\u53F7\u8138]",
  "e10269": "[\u6697\u4E2D\u89C2\u5BDF]",
  "e10270": "[emm]",
  "e10271": "[\u5403\u74DC]",
  "e10272": "[\u5475\u5475\u54D2]",
  "e10273": "[\u6211\u9178\u4E86]",
  "e10274": "[\u592A\u5357\u4E86]",
  "e10277": "[\u6C6A\u6C6A]",
  "e10289": "[\u7741\u773C]",
  "e10318": "[\u5D07\u62DC]",
  "e10319": "[\u6BD4\u5FC3]"
};
var EMOJI_BASE_URL = "https://qzonestyle.gtimg.cn/qzone/em/";
var EMOJI_ALIASES = {
  // 英文别名
  "doge": "e249",
  // QzEmoji 中的 doge
  "emm": "e10270",
  // QzEmoji 中的 emm (e10270)
  // 中文别名
  "doge\u72D7\u5934": "e249",
  "\u6258\u816E": "e282",
  "\u7948\u7977": "e302",
  "\u6BD4\u5FC3": "e187",
  // 爱你
  "\u98DE\u543B": "e191",
  // e191 不是 e201
  "\u62B1\u62B1": "e178",
  // 拥抱
  "\u63E1\u624B": "e181",
  "\u9F13\u638C": "e142",
  "\u80DC\u5229": "e182",
  "OK": "e189",
  "\u594B\u6597": "e130",
  "\u56F0": "e125",
  "\u997F": "e124",
  // 饥饿
  "\u7D2F": "e135",
  // 折磨
  "\u5FC3\u788E": "e167",
  "\u7231\u5FC3": "e166",
  "\u73AB\u7470": "e163",
  "\u793C\u7269": "e177",
  "\u86CB\u7CD5": "e168",
  "\u5496\u5561": "e160",
  "\u5564\u9152": "e157",
  "\u996D": "e161",
  "\u897F\u74DC": "e156",
  "\u6708\u4EAE": "e175",
  "\u592A\u9633": "e176",
  "\u54ED": "e105",
  // 流泪
  "\u7B11": "e100",
  // 微笑
  "\u5F00\u5FC3": "e128",
  // 憨笑
  "\u751F\u6C14": "e111",
  // 发怒
  "\u60CA\u8BB6": "e114",
  "\u96BE\u8FC7": "e115",
  "\u5BB3\u7F9E": "e106",
  "\u8C03\u76AE": "e112",
  "\u53EF\u7231": "e121"
};
var UNICODE_EMOJI_MAP = {
  "e7000": "\u{1F60A}",
  "e7001": "\u{1F603}",
  "e7002": "\u{1F60A}",
  "e7003": "\u{1F609}",
  "e7004": "\u{1F60D}",
  "e7005": "\u{1F618}",
  "e7006": "\u{1F61A}",
  "e7007": "\u{1F633}",
  "e7008": "\u{1F60C}",
  "e7009": "\u{1F601}",
  "e7010": "\u{1F61C}",
  "e7011": "\u{1F61D}",
  "e7012": "\u{1F612}",
  "e7013": "\u{1F60F}",
  "e7014": "\u{1F613}",
  "e7015": "\u{1F614}",
  "e7016": "\u{1F61E}",
  "e7017": "\u{1F616}",
  "e7018": "\u{1F625}",
  "e7019": "\u{1F630}",
  "e7020": "\u{1F628}",
  "e7021": "\u{1F623}",
  "e7022": "\u{1F622}",
  "e7023": "\u{1F62D}",
  "e7024": "\u{1F602}",
  "e7025": "\u{1F635}",
  "e7026": "\u{1F631}",
  "e7027": "\u{1F620}",
  "e7028": "\u{1F621}",
  "e7029": "\u{1F62A}",
  "e7030": "\u{1F637}",
  "e7031": "\u{1F47F}",
  "e7032": "\u{1F47D}",
  "e7033": "\u{1F49B}",
  "e7034": "\u{1F499}",
  "e7035": "\u{1F49C}",
  "e7036": "\u7C89\u5FC3",
  "e7037": "\u{1F49A}",
  "e7038": "\u2764",
  "e7039": "\u{1F494}",
  "e7040": "\u{1F496}",
  "e7041": "\u{1F498}",
  "e7042": "\u2728",
  "e7043": "\u2B50",
  "e7044": "\u{1F4A2}",
  "e7045": "\u2757",
  "e7046": "\u2753",
  "e7047": "\u{1F4A4}",
  "e7048": "\u{1F4A8}",
  "e7049": "\u{1F4A6}",
  "e7050": "\u{1F3B6}",
  "e7051": "\u{1F3B5}",
  "e7052": "\u{1F525}",
  "e7053": "\u{1F4A9}",
  "e7054": "\u{1F44D}",
  "e7055": "\u{1F44E}",
  "e7056": "\u{1F44C}",
  "e7057": "\u{1F44A}",
  "e7058": "\u270A",
  "e7059": "\u270C",
  "e7060": "\u{1F590}",
  "e7061": "\u270B",
  "e7062": "\u{1F450}",
  "e7063": "\u{1F446}",
  "e7064": "\u{1F447}",
  "e7065": "\u{1F449}",
  "e7066": "\u{1F448}",
  "e7067": "\u{1F64C}",
  "e7068": "\u{1F64F}",
  "e7069": "\u261D",
  "e7070": "\u{1F44F}",
  "e7071": "\u{1F4AA}",
  "e7072": "\u{1F6B6}",
  "e7073": "\u{1F3C3}",
  "e7074": "\u{1F46B}",
  "e7075": "\u{1F483}",
  "e7076": "\u{1F46F}",
  "e7077": "\u{1F646}",
  "e7078": "\u{1F645}",
  "e7079": "\u{1F481}",
  "e7080": "\u{1F647}",
  "e7081": "\u{1F48F}",
  "e7082": "\u{1F491}",
  "e7083": "\u{1F486}",
  "e7084": "\u{1F487}",
  "e7085": "\u{1F485}",
  "e7086": "\u{1F466}",
  "e7087": "\u{1F467}",
  "e7088": "\u{1F469}",
  "e7089": "\u{1F468}",
  "e7090": "\u{1F475}",
  "e7091": "\u{1F474}",
  "e7092": "\u{1F9D1}",
  "e7093": "\u{1F472}",
  "e7094": "\u{1F473}",
  "e7095": "\u5DE5\u4EBA",
  "e7096": "\u{1F46E}",
  "e7097": "\u{1F47C}",
  "e7098": "\u{1F478}",
  "e7099": "\u{1F482}",
  "e7100": "\u{1F480}",
  "e7101": "\u{1F463}",
  "e7102": "\u{1F48B}",
  "e7103": "\u{1F444}",
  "e7104": "\u{1F442}",
  "e7105": "\u{1F440}",
  "e7106": "\u{1F443}",
  "e7107": "\u2600",
  "e7108": "\u{1F327}",
  "e7109": "\u26C5",
  "e7110": "\u26C4",
  "e7111": "\u{1F319}",
  "e7112": "\u26A1",
  "e7113": "\u{1F300}",
  "e7114": "\u{1F30A}",
  "e7115": "\u{1F431}",
  "e7116": "\u{1F436}",
  "e7117": "\u{1F42D}",
  "e7118": "\u{1F439}",
  "e7119": "\u{1F430}",
  "e7120": "\u{1F43A}",
  "e7121": "\u{1F438}",
  "e7122": "\u{1F42F}",
  "e7123": "\u{1F428}",
  "e7124": "\u{1F43B}",
  "e7125": "\u{1F437}",
  "e7126": "\u{1F42E}",
  "e7127": "\u{1F417}",
  "e7128": "\u{1F412}",
  "e7129": "\u{1F434}",
  "e7130": "\u{1F40E}",
  "e7131": "\u{1F42B}",
  "e7132": "\u{1F40F}",
  "e7133": "\u{1F418}",
  "e7134": "\u{1F40D}",
  "e7135": "\u{1F426}",
  "e7136": "\u{1F424}",
  "e7137": "\u{1F414}",
  "e7138": "\u{1F426}",
  "e7139": "\u{1F41B}",
  "e7140": "\u{1F419}",
  "e7141": "\u{1F435}",
  "e7142": "\u{1F420}",
  "e7143": "\u{1F41F}",
  "e7144": "\u{1F40B}",
  "e7145": "\u{1F42C}",
  "e7146": "\u{1F490}",
  "e7147": "\u{1F338}",
  "e7148": "\u{1F337}",
  "e7149": "\u{1F340}",
  "e7150": "\u{1F339}",
  "e7151": "\u{1F33B}",
  "e7152": "\u{1F33A}",
  "e7153": "\u{1F341}",
  "e7154": "\u{1F343}",
  "e7155": "\u{1F342}",
  "e7156": "\u{1F334}",
  "e7157": "\u{1F335}",
  "e7158": "\u{1F33E}",
  "e7159": "\u{1F41A}",
  "e7160": "\u{1FAB4}",
  "e7161": "\u{1F49D}",
  "e7162": "\u{1F38E}",
  "e7163": "\u{1F392}",
  "e7164": "\u{1F9E5}",
  "e7165": "\u{1F38F}",
  "e7166": "\u{1F386}",
  "e7167": "\u{1F387}",
  "e7168": "\u{1F390}",
  "e7169": "\u{1F391}",
  "e7170": "\u{1F383}",
  "e7171": "\u{1F47B}",
  "e7172": "\u{1F385}",
  "e7173": "\u{1F384}",
  "e7174": "\u{1F381}",
  "e7175": "\u{1F514}",
  "e7176": "\u{1F389}",
  "e7177": "\u{1F388}",
  "e7178": "\u{1F4BF}",
  "e7179": "\u{1F4C0}",
  "e7180": "\u{1F4F9}",
  "e7181": "\u{1F4BB}",
  "e7182": "\u{1F4FA}",
  "e7183": "\u{1F4F1}",
  "e7184": "\u{1F4E0}",
  "e7185": "\u260E",
  "e7186": "\u{1F4BD}",
  "e7187": "\u{1F4FC}",
  "e7188": "\u{1F508}",
  "e7189": "\u{1F50A}",
  "e7190": "\u{1F509}",
  "e7191": "\u{1F4FB}",
  "e7192": "\u{1F4E1}",
  "e7193": "\u{1F453}",
  "e7194": "\u{1F50D}",
  "e7195": "\u{1F513}",
  "e7196": "\u{1F512}",
  "e7197": "\u{1F511}",
  "e7198": "\u2702",
  "e7199": "\u{1F528}",
  "e7200": "\u{1F4A1}",
  "e7201": "\u{1F4F2}",
  "e7202": "\u{1F4E9}",
  "e7203": "\u{1F4EC}",
  "e7204": "\u{1F4EE}",
  "e7205": "\u{1F6C1}",
  "e7206": "\u{1F6BD}",
  "e7207": "\u{1F4BA}",
  "e7208": "\u{1F4B0}",
  "e7209": "\u91D1\u51A0",
  "e7210": "\u{1F6AC}",
  "e7211": "\u{1F4A3}",
  "e7212": "\u{1F52B}",
  "e7213": "\u{1F48A}",
  "e7214": "\u{1F489}",
  "e7215": "\u{1F3C8}",
  "e7216": "\u{1F3C0}",
  "e7217": "\u26BD",
  "e7218": "\u26BE",
  "e7219": "\u{1F3BE}",
  "e7220": "\u9AD8\u5C14\u592B",
  "e7221": "\u{1F3B1}",
  "e7222": "\u{1F3CA}",
  "e7223": "\u{1F3C4}",
  "e7224": "\u{1F3C2}",
  "e7225": "\u2660",
  "e7226": "\u2665",
  "e7227": "\u2663",
  "e7228": "\u2666",
  "e7229": "\u{1F3C6}",
  "e7230": "\u{1F47E}",
  "e7231": "\u{1F3AF}",
  "e7232": "\u{1F004}",
  "e7233": "\u{1F3AC}",
  "e7234": "\u{1F4DD}",
  "e7235": "\u{1F4D6}",
  "e7236": "\u{1F3A8}",
  "e7237": "\u{1F3A4}",
  "e7238": "\u{1F3A7}",
  "e7239": "\u{1F3BA}",
  "e7240": "\u{1F3B7}",
  "e7241": "\u{1F3B8}",
  "e7242": "\u303D",
  "e7243": "\u{1F45E}",
  "e7244": "\u{1F97F}",
  "e7245": "\u{1F460}",
  "e7246": "\u{1F462}",
  "e7247": "\u{1F455}",
  "e7248": "\u{1F454}",
  "e7249": "\u{1F457}",
  "e7250": "\u{1F458}",
  "e7251": "\u{1F459}",
  "e7252": "\u{1F380}",
  "e7253": "\u{1F3A9}",
  "e7254": "\u{1F451}",
  "e7255": "\u{1F452}",
  "e7256": "\u{1F302}",
  "e7257": "\u{1F4BC}",
  "e7258": "\u{1F45C}",
  "e7259": "\u{1F484}",
  "e7260": "\u{1F48D}",
  "e7261": "\u{1F48E}",
  "e7262": "\u2615",
  "e7263": "\u{1F375}",
  "e7264": "\u{1F37A}",
  "e7265": "\u{1F37B}",
  "e7266": "\u{1F378}",
  "e7267": "\u{1F376}",
  "e7268": "\u{1F374}",
  "e7269": "\u{1F354}",
  "e7270": "\u{1F35D}",
  "e7271": "\u{1F35B}",
  "e7272": "\u{1F371}",
  "e7273": "\u{1F363}",
  "e7274": "\u{1F359}",
  "e7275": "\u{1F358}",
  "e7276": "\u{1F35A}",
  "e7277": "\u{1F35C}",
  "e7278": "\u{1F372}",
  "e7279": "\u{1F35E}",
  "e7280": "\u{1F95A}",
  "e7281": "\u{1F362}",
  "e7282": "\u{1F361}",
  "e7283": "\u{1F366}",
  "e7284": "\u{1F367}",
  "e7285": "\u{1F382}",
  "e7286": "\u{1F370}",
  "e7287": "\u{1F34E}",
  "e7288": "\u{1F34A}",
  "e7289": "\u{1F349}",
  "e7290": "\u{1F353}",
  "e7291": "\u{1F346}",
  "e7292": "\u{1F345}",
  "e7293": "\u{1F3E0}",
  "e7294": "\u{1F3EB}",
  "e7295": "\u{1F3E2}",
  "e7296": "\u{1F3E3}",
  "e7297": "\u{1F3E5}",
  "e7298": "\u{1F3E6}",
  "e7299": "\u{1F3EA}",
  "e7300": "\u{1F3E9}",
  "e7301": "\u{1F3E8}",
  "e7302": "\u{1F492}",
  "e7303": "\u26EA",
  "e7304": "\u{1F3EC}",
  "e7305": "\u{1F307}",
  "e7306": "\u{1F306}",
  "e7307": "\u6CB9\u7F50",
  "e7308": "\u{1F3EF}",
  "e7309": "\u{1F3F0}",
  "e7310": "\u26FA",
  "e7311": "\u{1F3ED}",
  "e7312": "\u{1F5FC}",
  "e7313": "\u{1F5FB}",
  "e7314": "\u{1F304}",
  "e7315": "\u{1F305}",
  "e7316": "\u{1F320}",
  "e7317": "\u{1F5FD}",
  "e7318": "\u{1F308}",
  "e7319": "\u{1F3A1}",
  "e7320": "\u26F2",
  "e7321": "\u{1F3A2}",
  "e7322": "\u{1F6A2}",
  "e7323": "\u{1F6E5}",
  "e7324": "\u26F5",
  "e7325": "\u2708",
  "e7326": "\u{1F680}",
  "e7327": "\u{1F6B2}",
  "e7328": "\u{1F699}",
  "e7329": "\u{1F697}",
  "e7330": "\u{1F695}",
  "e7331": "\u{1F68C}",
  "e7332": "\u{1F693}",
  "e7333": "\u{1F692}",
  "e7334": "\u{1F691}",
  "e7335": "\u{1F69A}",
  "e7336": "\u{1F68E}",
  "e7337": "\u{1F689}",
  "e7338": "\u{1F685}",
  "e7339": "\u{1F686}",
  "e7340": "\u949E\u7968",
  "e7341": "\u26FD",
  "e7342": "\u{1F6A6}",
  "e7343": "\u26A0",
  "e7344": "\u{1F6A7}",
  "e7345": "\u{1F530}",
  "e7346": "\u{1F3E7}",
  "e7347": "\u{1F3B0}",
  "e7348": "\u8DEF\u724C",
  "e7349": "\u{1F488}",
  "e7350": "\u2668",
  "e7351": "\u{1F3C1}",
  "e7352": "\u{1F38C}",
  "e7353": "\u{1F1EF}\u{1F1F5}",
  "e7354": "\u{1F1F0}\u{1F1F7}",
  "e7355": "\u{1F1E8}\u{1F1F3}",
  "e7356": "\u{1F1FA}\u{1F1F8}",
  "e7357": "\u{1F1EB}\u{1F1F7}",
  "e7358": "\u{1F1EA}\u{1F1F8}",
  "e7359": "\u{1F1EE}\u{1F1F9}",
  "e7360": "\u{1F1EC}\u{1F1E7}",
  "e7361": "\u{1F1E9}\u{1F1EA}",
  "e7362": "1\uFE0F\u20E3",
  "e7363": "2\uFE0F\u20E3",
  "e7364": "3\uFE0F\u20E3",
  "e7365": "4\uFE0F\u20E3",
  "e7366": "5\uFE0F\u20E3",
  "e7367": "6\uFE0F\u20E3",
  "e7368": "7\uFE0F\u20E3",
  "e7369": "8\uFE0F\u20E3",
  "e7370": "9\uFE0F\u20E3",
  "e7371": "0\uFE0F\u20E3",
  "e7372": "#\uFE0F\u20E3",
  "e7373": "\u2B06",
  "e7374": "\u2B07",
  "e7375": "\u2B05",
  "e7376": "\u27A1",
  "e7377": "\u2197",
  "e7378": "\u2199",
  "e7379": "\u2198",
  "e7380": "\u2199",
  "e7381": "\u25C0",
  "e7382": "\u25B6",
  "e7383": "\u23EA",
  "e7384": "\u23E9",
  "e7385": "\u{1F197}",
  "e7386": "\u{1F195}",
  "e7387": "\u{1F51D}",
  "e7388": "\u{1F199}",
  "e7389": "\u{1F192}",
  "e7390": "\u{1F3A6}",
  "e7391": "\u{1F201}",
  "e7392": "\u{1F4F6}",
  "e7393": "\u{1F235}",
  "e7394": "\u{1F233}",
  "e7395": "\u{1F250}",
  "e7396": "\u{1F239}",
  "e7397": "\u{1F22F}",
  "e7398": "\u{1F23A}",
  "e7399": "\u{1F236}",
  "e7400": "\u{1F21A}",
  "e7401": "\u{1F237}",
  "e7402": "\u{1F238}",
  "e7403": "\u{1F202}",
  "e7404": "\u{1F6BB}",
  "e7405": "\u{1F6B9}",
  "e7406": "\u{1F6BA}",
  "e7407": "\u{1F6BC}",
  "e7408": "\u{1F6AD}",
  "e7409": "\u{1F17F}",
  "e7410": "\u267F",
  "e7411": "\u5217\u8F66",
  "e7412": "\u{1F6BE}",
  "e7413": "\u3299",
  "e7414": "\u3297",
  "e7415": "\u{1F51E}",
  "e7416": "\u{1F194}",
  "e7417": "\u2733",
  "e7418": "\u6807\u8BB0",
  "e7419": "\u{1F49F}",
  "e7420": "\u{1F19A}",
  "e7421": "\u624B\u673A",
  "e7422": "\u{1F4F4}",
  "e7423": "\u{1F4B9}",
  "e7424": "\u{1F4B1}",
  "e7425": "\u2648",
  "e7426": "\u2649",
  "e7427": "\u264A",
  "e7428": "\u264B",
  "e7429": "\u264C",
  "e7430": "\u264D",
  "e7431": "\u264E",
  "e7432": "\u264F",
  "e7433": "\u2650",
  "e7434": "\u2651",
  "e7435": "\u2652",
  "e7436": "\u2653",
  "e7437": "\u26CE",
  "e7438": "\u{1F52F}",
  "e7439": "\u{1F170}"
};
var PNG_EMOJIS = /* @__PURE__ */ new Set([
  "e400343",
  "e400820",
  "e400827",
  "e400840",
  "e400841",
  "e400843",
  "e400844",
  "e400845",
  "e400846",
  "e400847",
  "e400848",
  "e400849",
  "e400850",
  "e400851",
  "e400852",
  "e400853",
  "e400854",
  "e400855",
  "e400856",
  "e400857",
  "e400858",
  "e400859",
  "e400860",
  "e400861"
]);
function getEmojiUrl(code) {
  const ext = PNG_EMOJIS.has(code) || code.length > 5 ? "png" : "gif";
  return `${EMOJI_BASE_URL}${code}.${ext}`;
}
function getEmojiName(code) {
  return EMOJI_NAME_MAP[code] ?? getGenericEmojiName(code);
}
function getGenericEmojiName(code) {
  const num = parseInt(code.replace("e", ""), 10);
  if (Number.isNaN(num)) return `[\u8868\u60C5${code}]`;
  if (num >= 7e3 && num <= 7439) {
    return UNICODE_EMOJI_MAP[code] ?? `[\u8868\u60C5${code}]`;
  }
  if (num >= 100 && num < 200) return "[\u5C0F\u9EC4\u8138]";
  if (num >= 200 && num < 300) return "[\u52A8\u6001\u8868\u60C5]";
  if (num >= 300 && num < 400) return "[\u65B0\u7248\u8868\u60C5]";
  if (num >= 400 && num < 500) return "[\u5927\u8868\u60C5]";
  if (num >= 500 && num < 600) return "[\u8D85\u840C\u8868\u60C5]";
  if (num >= 4e5 && num < 5e5) return "[\u8D85\u6E05\u8868\u60C5]";
  if (num >= 1e4) return "[\u8282\u65E5\u8868\u60C5]";
  return `[\u8868\u60C5${code}]`;
}
function convertEmojisToNames(content) {
  return content.replace(/\[em\](e\d+)\[\/em\]/g, (_, code) => {
    return getEmojiName(code);
  });
}
var NAME_TO_CODE_MAP = null;
function getNameToCodeMap() {
  if (!NAME_TO_CODE_MAP) {
    NAME_TO_CODE_MAP = /* @__PURE__ */ new Map();
    for (const [code, name] of Object.entries(EMOJI_NAME_MAP)) {
      NAME_TO_CODE_MAP.set(name, code);
      NAME_TO_CODE_MAP.set(name.replace(/[\[\]]/g, ""), code);
    }
    for (const [alias, code] of Object.entries(EMOJI_ALIASES)) {
      NAME_TO_CODE_MAP.set(`[${alias}]`, code);
      NAME_TO_CODE_MAP.set(alias, code);
    }
  }
  return NAME_TO_CODE_MAP;
}
function convertNamesToEmojis(content) {
  const nameMap = getNameToCodeMap();
  return content.replace(/\[([^\]]+)\]|\/([a-zA-Z0-9\u4e00-\u9fa5]+)/g, (match, bracketName, slashName) => {
    const name = bracketName || slashName;
    if (!name) return match;
    const code = nameMap.get(name) || nameMap.get(`[${name}]`);
    if (code) {
      return `[em]${code}[/em]`;
    }
    return match;
  });
}
function convertEmojisToImages(content) {
  return content.replace(/\[em\](e\d+)\[\/em\]/g, (_, code) => {
    const url = getEmojiUrl(code);
    const name = getEmojiName(code).replace(/[\[\]]/g, "");
    return `<img src="${url}" alt="${name}" class="qzone-emoji" data-code="${code}" />`;
  });
}
function stripEmojis(content) {
  return content.replace(/\[em\]e\d+\[\/em\]/g, "");
}
function processEmojis(content, options = { mode: "name" }) {
  switch (options.mode) {
    case "name":
      return convertEmojisToNames(content);
    case "image":
      return convertEmojisToImages(content);
    case "remove":
      return stripEmojis(content);
    case "keep":
    default:
      return content;
  }
}

// vendor/onebot-qzone/src/qzone/feeds3/content.ts
function extractEmojisFromHtml(html) {
  return html.replace(/<img[^>]+src=["'][^"']*\/qzone\/em\/(e\d+)\.[^"']*["'][^>]*>/gi, (_, code) => {
    return `[em]${code}[/em]`;
  });
}
function stripHtmlTags(html) {
  const withEmojis = extractEmojisFromHtml(html);
  return withEmojis.replace(/<[^>]+>/g, "");
}
function extractFeedContentFromHtml(html) {
  const withEmoji = extractEmojisFromHtml(html);
  const noTags = withEmoji.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/\\[trn]/g, "").replace(/[\t\r\n]+/g, " ").trim();
  return processEmojis(noTags, { mode: "name" });
}

// vendor/onebot-qzone/src/qzone/feeds3/items.ts
function validateFeedItem(item, source) {
  const errors = [];
  if (!item["tid"] || typeof item["tid"] !== "string" || item["tid"].length === 0) {
    errors.push(`missing or invalid tid`);
  }
  if (!item["uin"] || typeof item["uin"] !== "string" || item["uin"].length === 0) {
    errors.push(`missing or invalid uin`);
  }
  if (typeof item["content"] !== "string") {
    errors.push(`missing or invalid content type`);
  }
  if (typeof item["created_time"] !== "number" || item["created_time"] <= 0) {
    errors.push(`missing or invalid created_time`);
  }
  if (errors.length > 0) {
    log("DEBUG", `validateFeedItem [${source}]: tid=${item["tid"]}, errors=[${errors.join(", ")}]`);
  }
  return { valid: errors.length === 0, errors };
}
function formatTimestampToReadable(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const ms = ts < 1e12 ? ts * 1e3 : ts;
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
function parseFeeds3FeedAuthorFromBefore(searchBefore) {
  const blocks = [...searchBefore.matchAll(/<div\b[^>]*\bf-nick\b[^>]*>([\s\S]*?)<\/div>/gi)];
  if (blocks.length === 0) return null;
  const inner = blocks[blocks.length - 1][1];
  const cardM = inner.match(/\blink\s*=\s*["']nameCard_(\d+)/i);
  if (!cardM?.[1]) return null;
  const nickM = inner.match(/<a\b[^>]*\bf-name\b[^>]*>([\s\S]*?)<\/a>/i);
  const nickname = nickM ? nickM[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim() : "";
  return { uin: cardM[1], nickname };
}
function parseAuthorFromTxtBoxNameCard(searchAfter) {
  const idx = searchAfter.search(/class="[^"]*txt-box-title[^"]*"/i);
  const head = idx >= 0 ? searchAfter.slice(idx, idx + 2800) : searchAfter.slice(0, Math.min(3200, searchAfter.length));
  const uinM = head.match(/\blink\s*=\s*["']nameCard_(\d+)/i);
  if (!uinM?.[1]) return null;
  const nickM = head.match(/<a[^>]*class="[^"]*nickname[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
  const nickname = nickM ? nickM[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim() : "";
  return { uin: uinM[1], nickname };
}
function sliceSearchAfterCurrentFeedOnly(searchAfter) {
  const tagEnd = searchAfter.indexOf(">");
  if (tagEnd < 0) return searchAfter;
  const nextFd = searchAfter.indexOf('name="feed_data"', tagEnd + 1);
  return nextFd < 0 ? searchAfter : searchAfter.slice(0, nextFd);
}
function parseFeeds3Items(text, filterUin, filterAppid, maxItems = 50, skipFeedData = false) {
  const startTime = Date.now();
  log("DEBUG", `parseFeeds3Items: text length=${text.length}, filterUin=${filterUin}, filterAppid=${filterAppid ?? "(any)"}, maxItems=${maxItems}, skipFeedData=${skipFeedData}`);
  const { text: processedText } = preprocessHtml(text);
  const msglist = [];
  const seenTids = /* @__PURE__ */ new Set();
  const stats = {
    strategy: "feed_data",
    totalFound: 0,
    validItems: 0,
    invalidItems: 0,
    errors: [],
    durationMs: 0
  };
  const feedDataPat = /name="feed_data"\s*([^>]*)>/g;
  const dataAttr = (attrs, name) => {
    const m = attrs.match(new RegExp(`data-${name}="([^"]*)"`));
    return m?.[1] ?? "";
  };
  const feedIdPat = /id="feed_(\d+)_(\d+)_(\d+)_(\d+)_\d+_\d+"[^>]*?>([\s\S]*?)(?=<div class="qz_summary|<li class="f-single|$)/g;
  const feedBlocks = [];
  let fb;
  while ((fb = feedIdPat.exec(processedText)) !== null) {
    feedBlocks.push({
      opuin: fb[1],
      appid: fb[2],
      typeid: fb[3],
      timestamp: parseInt(fb[4], 10),
      block: fb[5]
    });
  }
  const contentPat = /class="txt-box(?:-title)?[^"]*"[^>]*>([\s\S]*?)(?:<\/p>|<\/div>)/;
  const contentPatAlt = /class="txt-box\s[^"]*"[^>]*>([\s\S]*?)(?:<div\s+class="f-single-foot|<div\s+class="f-ct-b|<\/li>)/;
  const nicknamePat = /class="f-name[^"]*"[^>]*>([\s\S]*?)<\/a>/;
  const cmtnumPat = /class="f-ct[^"]*"[^>]*>(\d+)/;
  const cmtnumFromBlockPat = /cmtnum["']?\s*[=:]\s*["']?(\d+)/i;
  const cmtNumFromDataAttrPat = /data-cmtnum="(\d+)"/i;
  let fdm;
  while ((fdm = feedDataPat.exec(processedText)) !== null) {
    let isUserUploadedImage2 = function(url) {
      return !EXCLUDED_IMAGE_PATTERNS.some((pat) => pat.test(url));
    };
    var isUserUploadedImage = isUserUploadedImage2;
    const attrs = fdm[1];
    let tid = dataAttr(attrs, "tid");
    if (!tid) tid = dataAttr(attrs, "origtid");
    const dataUin = dataAttr(attrs, "uin");
    const origTid = dataAttr(attrs, "origtid");
    const origUin = dataAttr(attrs, "origuin");
    const abstime = parseInt(dataAttr(attrs, "abstime") || "0", 10);
    if (tid === "advertisement_app" || dataUin === "0" || !tid) continue;
    if (filterUin && dataUin !== filterUin) continue;
    if (seenTids.has(tid)) continue;
    seenTids.add(tid);
    const fdPos = fdm.index;
    let matchedBlock;
    let closestDist = Infinity;
    for (const blk of feedBlocks) {
      const blkStart = processedText.indexOf(`id="feed_${blk.opuin}_${blk.appid}_${blk.typeid}_${blk.timestamp}_`);
      if (blkStart >= 0 && blkStart < fdPos) {
        const dist = fdPos - blkStart;
        if (dist < closestDist) {
          closestDist = dist;
          matchedBlock = blk;
        }
      }
    }
    if (filterAppid && matchedBlock && matchedBlock.appid !== filterAppid) continue;
    const nextFdPos = processedText.indexOf('name="feed_data"', fdPos + 1);
    const prevFdPos = fdPos > 0 ? processedText.lastIndexOf('name="feed_data"', fdPos - 1) : -1;
    const afterEnd = nextFdPos >= 0 ? Math.min(nextFdPos, fdPos + 8e3) : Math.min(fdPos + 5e3, processedText.length);
    const beforeStart = prevFdPos >= 0 ? Math.max(prevFdPos, fdPos - 8e3) : Math.max(0, fdPos - 5e3);
    const searchAfter = processedText.substring(fdPos, afterEnd);
    const searchBefore = processedText.substring(beforeStart, fdPos);
    const nickBlockAuthor = parseFeeds3FeedAuthorFromBefore(searchBefore);
    let posterUin = nickBlockAuthor?.uin && /^\d+$/.test(nickBlockAuthor.uin) ? nickBlockAuthor.uin : dataUin;
    let content = "";
    let nickname = "";
    let cmtnum = 0;
    const images = [];
    const picsMeta = [];
    const blockTypeid = matchedBlock?.typeid ?? "";
    const isForward = blockTypeid === "5" || !!(origTid && origTid !== tid && origUin && origUin !== dataUin);
    let rt_tid = "";
    let rt_uin = "";
    let rt_uinname = "";
    let rt_con = "";
    const cmAfter = searchAfter.match(contentPat);
    const fInfoPat = /<div class="f-info">([\s\S]*?)<\/div>/g;
    const allFInfo = [...searchBefore.matchAll(fInfoPat)];
    const cmFInfo = allFInfo.length > 0 ? allFInfo[allFInfo.length - 1] : null;
    const cmTxtBoxAfter = searchAfter.match(contentPatAlt);
    if (cmAfter) {
      const rawHtml = cmAfter[1];
      const trimmedHtml = rawHtml.trim();
      if ((!trimmedHtml || trimmedHtml === "" || /^\s*$/.test(trimmedHtml)) && cmFInfo) {
        content = extractFeedContentFromHtml(cmFInfo[1]);
        if (isForward) {
          rt_tid = origTid || tid;
          rt_uin = origUin || dataUin;
          if (cmTxtBoxAfter) {
            const origHtml = cmTxtBoxAfter[1];
            const origNickMatch = origHtml.match(/<a[^>]*class="nickname[^"]*"[^>]*>([^<]+)<\/a>/);
            rt_uinname = origNickMatch ? origNickMatch[1].trim() : "";
            const origText = extractFeedContentFromHtml(origHtml);
            const origColonIdx = origText.indexOf("\uFF1A");
            rt_con = origColonIdx >= 0 ? origText.substring(origColonIdx + 1).trim() : origText;
          }
        }
      } else if (isForward || rawHtml.includes(">\u8F6C\u53D1")) {
        const sections = rawHtml.split(/<a\s+class="nickname/);
        if (sections.length >= 3) {
          const fwdSection = sections[1];
          const fwdNickMatch = fwdSection.match(/>([^<]+)<\/a>/);
          nickname = fwdNickMatch ? fwdNickMatch[1].trim() : "";
          const fwdTextClean = extractFeedContentFromHtml(fwdSection);
          const fwdColonIdx = fwdTextClean.indexOf("\uFF1A");
          const fwdContent = fwdColonIdx >= 0 ? fwdTextClean.substring(fwdColonIdx + 1).trim() : fwdTextClean;
          const origSection = sections[2];
          const origNickMatch = origSection.match(/>([^<]+)<\/a>/);
          rt_uinname = origNickMatch ? origNickMatch[1].trim() : "";
          const origTextClean = extractFeedContentFromHtml(origSection);
          const origColonIdx = origTextClean.indexOf("\uFF1A");
          rt_con = origColonIdx >= 0 ? origTextClean.substring(origColonIdx + 1).trim() : origTextClean;
          rt_tid = origTid || tid;
          rt_uin = origUin || dataUin;
          content = fwdContent;
        } else if (sections.length === 2) {
          const origSection = sections[1];
          const origNickMatch = origSection.match(/>([^<]+)<\/a>/);
          rt_uinname = origNickMatch ? origNickMatch[1].trim() : "";
          const origTextClean = extractFeedContentFromHtml(origSection);
          const origColonIdx = origTextClean.indexOf("\uFF1A");
          rt_con = origColonIdx >= 0 ? origTextClean.substring(origColonIdx + 1).trim() : origTextClean;
          rt_tid = origTid || "";
          rt_uin = origUin || "";
          content = "";
        }
      } else {
        const rawText = extractFeedContentFromHtml(rawHtml);
        const colonIdx = rawText.indexOf("\uFF1A");
        if (colonIdx >= 0) {
          content = rawText.substring(colonIdx + 1).trim();
          if (!nickname) nickname = rawText.substring(0, colonIdx).trim();
        } else {
          content = rawText;
        }
      }
    } else if (cmFInfo) {
      content = extractFeedContentFromHtml(cmFInfo[1]);
      if (isForward) {
        rt_tid = origTid || tid;
        rt_uin = origUin || dataUin;
        if (cmTxtBoxAfter) {
          const origHtml = cmTxtBoxAfter[1];
          const origNickMatch = origHtml.match(/<a[^>]*class="nickname[^"]*"[^>]*>([^<]+)<\/a>/);
          rt_uinname = origNickMatch ? origNickMatch[1].trim() : "";
          const origText = origHtml.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/\\[trn]/g, "").replace(/[\t\r\n]+/g, " ").trim();
          const origColonIdx = origText.indexOf("\uFF1A");
          rt_con = origColonIdx >= 0 ? origText.substring(origColonIdx + 1).trim() : origText;
        }
      }
    }
    if (isForward && !rt_con) {
      if (cmTxtBoxAfter) {
        const origHtml = cmTxtBoxAfter[1];
        const origText = extractFeedContentFromHtml(origHtml);
        if (origText.length > 0) {
          const idx = origText.indexOf("\uFF1A");
          rt_con = idx >= 0 ? origText.substring(idx + 1).trim() : origText;
        }
      }
      if (!rt_con && matchedBlock?.block) {
        const block = matchedBlock.block;
        const origPat = /(?:txt-box|f-info|ellipsis|content-box)[^>]*>([\s\S]*?)(?:<\/p>|<\/div>|<\/span>)/gi;
        let om;
        while ((om = origPat.exec(block)) !== null) {
          const raw = extractFeedContentFromHtml(om[1]);
          if (raw.length > 0 && !/^[\d\s·]+$/.test(raw)) {
            rt_con = raw.includes("\uFF1A") ? raw.substring(raw.indexOf("\uFF1A") + 1).trim() : raw;
            if (rt_con.length > 0) break;
          }
        }
      }
    }
    if (!nickname) {
      const searchRegion = searchAfter + searchBefore;
      const nm = searchRegion.match(nicknamePat);
      if (nm) nickname = nm[1].replace(/<[^>]+>/g, "").trim();
    }
    if (nickBlockAuthor?.nickname) {
      nickname = nickBlockAuthor.nickname;
    }
    const txtBoxNameCardAuthor = parseAuthorFromTxtBoxNameCard(searchAfter);
    if (txtBoxNameCardAuthor && /^\d+$/.test(dataUin) && txtBoxNameCardAuthor.uin === dataUin) {
      posterUin = dataUin;
      if (txtBoxNameCardAuthor.nickname) nickname = txtBoxNameCardAuthor.nickname;
    }
    if (!content && matchedBlock?.block) {
      const block = matchedBlock.block;
      const looseContentPat = /(?:txt-box-title|txt-box|f-info|ellipsis|content-box)[^>]*>([\s\S]*?)(?:<\/p>|<\/div>|<\/span>)/gi;
      let looseMatch;
      while ((looseMatch = looseContentPat.exec(block)) !== null) {
        const raw = extractFeedContentFromHtml(looseMatch[1]);
        if (raw.length > 0 && !/^[\d\s·]+$/.test(raw) && !/^https?:\/\//.test(raw)) {
          const afterColon = raw.includes("\uFF1A") ? raw.substring(raw.indexOf("\uFF1A") + 1).trim() : raw;
          if (afterColon.length > 0) {
            content = afterColon;
            break;
          }
        }
      }
    }
    if (isForward && !content && rt_con) {
      content = rt_con;
    }
    if (matchedBlock?.block) {
      const cmtFromBlock = matchedBlock.block.match(cmtnumFromBlockPat);
      if (cmtFromBlock) cmtnum = parseInt(cmtFromBlock[1], 10);
    }
    if (cmtnum === 0) {
      const cmtFromAttr = searchAfter.match(cmtNumFromDataAttrPat);
      if (cmtFromAttr) cmtnum = parseInt(cmtFromAttr[1], 10);
    }
    if (cmtnum === 0) {
      const cm2 = searchAfter.match(cmtnumPat);
      if (cm2) cmtnum = parseInt(cm2[1], 10);
    }
    if (cmtnum === 0 && matchedBlock?.block) {
      const cmtFromJson = matchedBlock.block.match(/"cmtnum":\s*(\d+)/) || matchedBlock.block.match(/'cmtnum':\s*(\d+)/) || matchedBlock.block.match(/cmtnum\s*:\s*(\d+)/);
      if (cmtFromJson) cmtnum = parseInt(cmtFromJson[1], 10);
    }
    if (cmtnum === 0 && matchedBlock?.block) {
      const block = matchedBlock.block;
      const commentItems = block.match(/<li\s+class="comments-item/gi);
      if (commentItems) cmtnum = commentItems.length;
    }
    if (cmtnum === 0) {
      const cmtRegion = sliceSearchAfterCurrentFeedOnly(searchAfter);
      const commentItemsInAfter = cmtRegion.match(/<li\s+class="comments-item/gi);
      if (commentItemsInAfter) cmtnum = commentItemsInAfter.length;
    }
    let likenum = 0;
    if (matchedBlock?.block) {
      const likeFromBlock = matchedBlock.block.match(/"likenum":\s*(\d+)/i) || matchedBlock.block.match(/'likenum':\s*(\d+)/i) || matchedBlock.block.match(/likenum["']?\s*[=:]\s*["']?(\d+)/i) || matchedBlock.block.match(/"like_count":\s*(\d+)/) || matchedBlock.block.match(/likecount[=:]\s*(\d+)/i);
      if (likeFromBlock) likenum = parseInt(likeFromBlock[1], 10);
    }
    if (likenum === 0) {
      const likeMatch = searchAfter.match(/class="f-like-cnt"[^>]*>(\d+)</i) || searchAfter.match(/data-likecount="(\d+)"/i) || searchAfter.match(/data-likecnt="(\d+)"/i) || searchAfter.match(/like_num["']?\s*[=:]\s*["']?(\d+)/i) || searchAfter.match(/"like_num":\s*(\d+)/) || searchAfter.match(/\\x3Cspan class=\\x22f-like-cnt\\x22[^>]*>(\d+)\\x3C/i) || searchAfter.match(/\\x3C[^>]*f-like-cnt[^>]*>(\d+)\\x3C/i);
      if (likeMatch) likenum = parseInt(likeMatch[1], 10);
    }
    if (likenum === 0) {
      const likeFromStats = searchAfter.match(/<a[^>]*class="[^"]*f-like[^"]*"[^>]*>[\s\S]*?<\/a>/gi);
      if (likeFromStats) {
        for (const likeElem of likeFromStats) {
          const numMatch = likeElem.match(/>(\d+)</);
          if (numMatch) {
            likenum = parseInt(numMatch[1], 10);
            break;
          }
        }
      }
    }
    const fullRegion = searchBefore + searchAfter;
    const regionDecoded = htmlUnescape(fullRegion);
    const searchAfterCurrentOnly = sliceSearchAfterCurrentFeedOnly(searchAfter);
    const regionCurrentFeedOnly = searchBefore + searchAfterCurrentOnly;
    const regionCurrentDecoded = htmlUnescape(regionCurrentFeedOnly);
    const picKeyPat = /<a[^>]+class="img-item[^"]*"[^>]*data-pickey="([^,]+),([^"]+)"[^>]*>/gi;
    const validTidLike = (s) => /^[a-zA-Z0-9_-]{6,64}$/.test(s);
    let picKeyMatch;
    while ((picKeyMatch = picKeyPat.exec(regionDecoded)) !== null) {
      const pickeyTid = picKeyMatch[1];
      const originalUrl = picKeyMatch[2];
      if (!validTidLike(pickeyTid)) {
        continue;
      }
      if (pickeyTid !== tid) {
        continue;
      }
      if (!images.includes(originalUrl)) {
        images.push(originalUrl);
        const imgItemTag = picKeyMatch[0];
        const widthM = imgItemTag.match(/data-width="(\d+)"/);
        const heightM = imgItemTag.match(/data-height="(\d+)"/);
        picsMeta.push({
          url: originalUrl,
          originalUrl,
          width: widthM ? parseInt(widthM[1], 10) : void 0,
          height: heightM ? parseInt(heightM[1], 10) : void 0
        });
      }
    }
    const EXCLUDED_IMAGE_PATTERNS = [
      /qzonestyle\.gtimg\.cn\/qzone\/em\//,
      /qzonestyle\.gtimg\.cn\/qzone\/space\//,
      /\/ac\/b\.gif$/,
      /qlogo\.cn/,
      /qzapp\.qlogo\.cn/,
      /qzonestyle\.gtimg\.cn\/act/
    ];
    for (const im of regionCurrentDecoded.matchAll(/<img[^>]+src="([^"]+)"/gi)) {
      const src = im[1];
      if ((src.includes("qpic.cn") || src.includes("photo.store.qq.com") || /\.(jpg|jpeg|png|gif|webp)$/i.test(src)) && !src.includes("qlogo") && !images.includes(src) && isUserUploadedImage2(src)) {
        images.push(src);
        picsMeta.push({ url: src });
      }
    }
    for (const tag of regionCurrentDecoded.matchAll(/<img[^>]+>/gi)) {
      const tagStr = tag[0];
      const dataSrc = tagStr.match(/data-src=["']([^"']+)["']/i)?.[1];
      const dataOriginal = tagStr.match(/data-original=["']([^"']+)["']/i)?.[1];
      for (const url of [dataSrc, dataOriginal]) {
        if (!url || images.includes(url)) continue;
        if ((url.includes("qpic.cn") || url.includes("photo.store.qq.com") || /\.(jpg|jpeg|png|gif|webp)$/i.test(url)) && !url.includes("qlogo") && isUserUploadedImage2(url)) {
          images.push(url);
          picsMeta.push({ url });
        }
      }
    }
    let videos = [];
    const videoCoverUrls = [];
    const videoPat = /data-vid="(\d+)"|<video[^>]*data-src="([^"]+)"|<div[^>]*class="[^"]*video[^"]*"[^>]*data-vid="(\d+)"/gi;
    const videoMatches = [...regionDecoded.matchAll(videoPat)];
    for (const vm of videoMatches) {
      const vid = vm[1] || vm[3];
      const videoUrl = vm[2];
      if (vid && !videos.some((v) => v.videoId === vid)) {
        const coverMatch = regionDecoded.match(new RegExp(`data-vid="${vid}"[^>]*data-pic="([^"]+)"`, "i")) || regionDecoded.match(new RegExp(`data-pic="([^"]+)"[^>]*data-vid="${vid}"`, "i"));
        const coverUrl = coverMatch?.[1] || "";
        if (coverUrl) videoCoverUrls.push(coverUrl);
        videos.push({
          videoId: vid,
          coverUrl,
          videoUrl: videoUrl || void 0
        });
      }
    }
    const videoTagPat = /<video[^>]*src="([^"]+)"[^>]*>/gi;
    for (const vtm of regionDecoded.matchAll(videoTagPat)) {
      const src = vtm[1];
      if (!videos.some((v) => v.videoUrl === src)) {
        const posterMatch = vtm[0].match(/poster="([^"]+)"/);
        const coverUrl = posterMatch?.[1] || "";
        if (coverUrl) videoCoverUrls.push(coverUrl);
        videos.push({
          videoId: `video_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          coverUrl,
          videoUrl: src
        });
      }
    }
    const qqVideoPat = /qqvideo\.qq\.com|v\.qq\.com|data-src="[^"]*video/gi;
    if (qqVideoPat.test(regionDecoded) && videos.length === 0) {
      const qvideoPat = /class="[^"]*(?:qvideo|video-box|video-container)[^"]*"/gi;
      const qvideoMatch = regionDecoded.match(qvideoPat);
      if (qvideoMatch) {
        for (const container of qvideoMatch) {
          const containerMatch = regionDecoded.match(new RegExp(`${container.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?<img[^>]+src="([^"]+)"`, "i"));
          if (containerMatch && !videoCoverUrls.includes(containerMatch[1])) {
            videoCoverUrls.push(containerMatch[1]);
            videos.push({
              videoId: `video_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              coverUrl: containerMatch[1]
            });
          }
        }
      }
    }
    const appid = matchedBlock?.appid ?? "";
    const typeid = matchedBlock?.typeid ?? "";
    let appName = "";
    let appShareTitle = "";
    let likeUnikey = "";
    let likeCurkey = "";
    let musicShare;
    if (appid && appid !== "311") {
      const searchAll = searchBefore + searchAfter;
      const isBilibili = /bilibili\.com|b23\.tv/i.test(searchAll);
      const appNameM = searchAll.match(/data-appname="([^"]+)"/i) ?? searchAll.match(/<[^>]+class="[^"]*(?:app-name|f-app-name)[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/i);
      if (appNameM) appName = appNameM[1].replace(/<[^>]+>/g, "").trim();
      if ((appid === "202" || appid === "2100") && !isBilibili) {
        const songNameM = searchAll.match(/<h4[^>]+class="[^"]*txt-box-title[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
        const artistNameM = searchAll.match(/<a[^>]+class="[^"]*f-name[^"]*info[^"]*"[^>]*>([^<]+)<\/a>/i);
        const artistStr = artistNameM?.[1]?.trim() ?? "";
        const looksLikeVideoStats = /\d+播放|点赞|弹幕/.test(artistStr);
        if (!looksLikeVideoStats) {
          const coverM = searchAll.match(/<img[^>]+trueSrc=["']([^"']+)["']/i) ?? searchAll.match(/trueSrc:['"]([^'"]+)['"]/i);
          const playUrlM = searchAll.match(/<div[^>]+class="[^"]*img-box[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/i);
          if (songNameM) {
            musicShare = {
              songName: songNameM[1].trim(),
              artistName: artistStr || void 0,
              coverUrl: coverM?.[1],
              playUrl: playUrlM?.[1]
            };
            appShareTitle = musicShare.songName + (musicShare.artistName ? ` - ${musicShare.artistName}` : "");
            log("DEBUG", `parseFeeds3Items: music share detected, song=${musicShare.songName}, artist=${musicShare.artistName ?? "(unknown)"}`);
          }
        } else if (songNameM) {
          appShareTitle = (songNameM[1].trim() + " " + artistStr).trim();
        }
      }
      if (!musicShare) {
        const titleM = searchAll.match(/<p[^>]*class="[^"]*ell[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ?? searchAll.match(/<[^>]+class="[^"]*(?:f-ct-title|app-title|app-content-title)[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/i);
        if (titleM) appShareTitle = titleM[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim();
      }
      const looksLikeVideoTitle = (s) => typeof s === "string" && s.length > 0 && /\d+播放|点赞|弹幕/.test(s);
      if (!musicShare && (isBilibili || looksLikeVideoTitle(content))) {
        if (looksLikeVideoTitle(content)) {
          if (!appShareTitle) appShareTitle = content.trim();
          content = "";
        }
        let userText = "";
        if (cmFInfo) {
          const raw = extractFeedContentFromHtml(cmFInfo[1]);
          if (raw && !looksLikeVideoTitle(raw)) userText = raw;
        }
        if (!userText && matchedBlock?.block) {
          const block = matchedBlock.block;
          const pat = /(?:txt-box|f-info|ellipsis|content-box)[^>]*>([\s\S]*?)(?:<\/p>|<\/div>|<\/span>)/gi;
          let m;
          while ((m = pat.exec(block)) !== null) {
            const raw = extractFeedContentFromHtml(m[1]);
            if (raw.length > 0 && raw.length < 300 && !looksLikeVideoTitle(raw) && !/^[\d\s·]+$/.test(raw)) {
              userText = raw;
              break;
            }
          }
        }
        if (!userText) {
          for (const region of [searchAfter, searchBefore]) {
            const pat2 = /(?:txt-box|f-info|f-ct)[^>]*>([\s\S]*?)(?:<\/p>|<\/div>|<\/span>|<\/a>)/gi;
            let m2;
            while ((m2 = pat2.exec(region)) !== null) {
              const raw = extractFeedContentFromHtml(m2[1]);
              if (raw.length > 0 && raw.length < 100 && !looksLikeVideoTitle(raw) && !/^[\d\s·]+$/.test(raw)) {
                userText = raw;
                break;
              }
            }
            if (userText) break;
          }
        }
        if (userText) content = userText;
      }
      const unM = searchAll.match(/data-unikey="([^"]+)"/i) ?? searchAll.match(/unikey\s*[:=]\s*['"]([^'"]+)['"]/i);
      if (unM) likeUnikey = unM[1];
      if (!likeUnikey) {
        const hrefM = searchAll.match(/href="(https?:\/\/(?:y\.music\.163\.com|music\.163\.com|www\.bilibili\.com|b23\.tv)[^"]+)"/i);
        if (hrefM) likeUnikey = hrefM[1];
      }
      const ckM = searchAll.match(/data-curkey="([^"]+)"/i) ?? searchAll.match(/curkey\s*[:=]\s*['"]([^'"]+)['"]/i);
      if (ckM) likeCurkey = ckM[1];
      if (!likeCurkey && posterUin && abstime) {
        const ts = abstime || (matchedBlock?.timestamp ?? 0);
        if (ts) {
          likeCurkey = "00" + posterUin.padStart(10, "0") + "00" + String(ts).padStart(10, "0");
          log("DEBUG", `parseFeeds3Items: curkey calculated from formula: ${likeCurkey}`);
        }
      }
      if (isBilibili && videos.length === 0 && likeUnikey) {
        videos.push({
          videoId: "bilibili_link",
          coverUrl: "",
          videoUrl: likeUnikey
        });
      }
    }
    const timestamp = abstime || (matchedBlock?.timestamp ?? 0);
    let filteredImages = images.filter(
      (url) => url.startsWith("http") && !videoCoverUrls.some((cover) => url.includes(cover) || cover.includes(url))
    );
    if (filteredImages.some((u) => u.includes("a1.qpic.cn"))) {
      filteredImages = filteredImages.filter((u) => u.includes("a1.qpic.cn"));
    }
    let filteredPicsMeta = picsMeta.filter(
      (p) => p.url?.startsWith("http") && !videoCoverUrls.some((cover) => p.url.includes(cover) || cover.includes(p.url))
    );
    if (filteredImages.some((u) => u.includes("a1.qpic.cn"))) {
      filteredPicsMeta = filteredPicsMeta.filter((p) => p.url?.includes("a1.qpic.cn"));
    }
    let canonicalTid = tid;
    if (/^\d+$/.test(tid)) {
      const fkey = dataAttr(attrs, "fkey");
      if (fkey) {
        canonicalTid = fkey;
        seenTids.add(canonicalTid);
        log("DEBUG", `parseFeeds3Items: tid ${tid} (abstime) -> fkey ${canonicalTid}`);
      } else {
        const combined = `${searchBefore} ${attrs} ${searchAfter.slice(0, 4e3)}`;
        let keyMatch = combined.match(/data-key="([a-z0-9]{6,})"/i);
        if (!keyMatch) keyMatch = combined.match(/key:\s*['"]([a-z0-9]{6,})['"]/i);
        if (keyMatch) {
          canonicalTid = keyMatch[1];
          seenTids.add(canonicalTid);
          log("DEBUG", `parseFeeds3Items: tid ${tid} (abstime) -> key ${canonicalTid}`);
        }
      }
    }
    const topicId = dataAttr(attrs, "topicid");
    const detailUrl = searchAfter.match(/data-detailurl="([^"]+)"/i)?.[1] ?? "";
    const detailTid = detailUrl.match(/\/mood\/([a-z0-9]+)\.1/i)?.[1] ?? topicId.match(/^\d+_([a-z0-9]+)__\d+$/i)?.[1] ?? "";
    const isLiked = /data-islike="1"/.test(searchAfter) || /qz_like_btn[^"]*item-on|item-on[^"]*qz_like_btn/.test(searchAfter);
    const item = {
      tid: canonicalTid,
      uin: posterUin,
      opuin: posterUin,
      nickname,
      content,
      created_time: timestamp,
      createTime: formatTimestampToReadable(timestamp),
      createTime2: formatTimestampToReadable(timestamp),
      cmtnum,
      likenum,
      fwdnum: isForward ? 1 : 0,
      pic: filteredImages.map((u) => ({ url: u })),
      picsMeta: filteredPicsMeta.length > 0 ? filteredPicsMeta : void 0,
      video: videos.length > 0 ? videos : void 0,
      appid,
      typeid,
      appName,
      appShareTitle,
      likeUnikey,
      likeCurkey,
      topicId: topicId || void 0,
      detailTid: detailTid || void 0,
      detailUrl: detailUrl || void 0,
      sourceFkey: dataAttr(attrs, "fkey") || void 0,
      musicShare,
      isLiked,
      _source: "feeds3"
    };
    if (isForward || rt_tid) {
      item["rt_tid"] = rt_tid;
      item["rt_uin"] = rt_uin;
      item["rt_uinname"] = rt_uinname;
      item["rt_con"] = rt_con;
    }
    msglist.push(item);
    if (msglist.length >= maxItems) break;
  }
  msglist.sort((a, b) => {
    const ta = a["created_time"] || 0;
    const tb = b["created_time"] || 0;
    return tb - ta;
  });
  log("DEBUG", `parseFeeds3Items: feed_data strategy found ${msglist.length} items`);
  if (msglist.length === 0 || skipFeedData) {
    if (skipFeedData) {
      msglist.length = 0;
      seenTids.clear();
    }
    log("DEBUG", "parseFeeds3Items: feed_data strategy found 0, trying JS data array");
    const jsItemPat = /\{[^{}]*?appid:'(\d+)'[^{}]*?key:'([^']*)'[^{}]*?abstime:'(\d+)'[^{}]*?uin:'(\d+)'[^{}]*?nickname:'([^']*)'/g;
    let jsm;
    while ((jsm = jsItemPat.exec(text)) !== null) {
      const appid = jsm[1];
      const tid = jsm[2];
      const jsAbstime = parseInt(jsm[3], 10);
      const feedUin = jsm[4];
      const jsNickname = jsm[5];
      if (filterAppid && appid !== filterAppid) continue;
      if (feedUin === "0") continue;
      if (filterUin && feedUin !== filterUin) continue;
      if (seenTids.has(tid)) continue;
      seenTids.add(tid);
      let jsContent = "";
      let jsRtTid = "";
      let jsRtUin = "";
      let jsRtUinname = "";
      let jsRtCon = "";
      let jsIsForward = false;
      const afterItem = text.substring(jsm.index, Math.min(jsm.index + 2e4, text.length));
      const htmlFieldMatch = afterItem.match(/html:'((?:[^'\\]|\\.)*)'/);
      if (htmlFieldMatch) {
        const decoded = htmlFieldMatch[1].replace(
          /\\x([0-9a-fA-F]{2})/g,
          (_, h) => String.fromCharCode(parseInt(h, 16))
        );
        const titleMatch = decoded.match(/class="txt-box-title[^"]*"[^>]*>([\s\S]*?)<\/p>/);
        if (titleMatch) {
          const rawHtml = titleMatch[1];
          if (rawHtml.includes(">\u8F6C\u53D1")) {
            jsIsForward = true;
            const sections = rawHtml.split(/<a\s+class="nickname/);
            if (sections.length >= 3) {
              const fwdText = sections[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/\\[trn]/g, "").replace(/[\t\r\n]+/g, " ").trim();
              const fwdColonIdx = fwdText.indexOf("\uFF1A");
              jsContent = fwdColonIdx >= 0 ? fwdText.substring(fwdColonIdx + 1).trim() : fwdText;
              const origText = sections[2].replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/\\[trn]/g, "").replace(/[\t\r\n]+/g, " ").trim();
              const origNickMatch = sections[2].match(/>([^<]+)<\/a>/);
              jsRtUinname = origNickMatch ? origNickMatch[1].trim() : "";
              const origColonIdx = origText.indexOf("\uFF1A");
              jsRtCon = origColonIdx >= 0 ? origText.substring(origColonIdx + 1).trim() : origText;
              jsRtTid = tid;
              jsRtUin = feedUin;
            }
          } else {
            const rawText = rawHtml.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/\\[trn]/g, "").replace(/[\t\r\n]+/g, " ").trim();
            const colonIdx = rawText.indexOf("\uFF1A");
            jsContent = colonIdx >= 0 ? rawText.substring(colonIdx + 1).trim() : rawText;
          }
        }
      }
      const jsItem = {
        tid,
        uin: feedUin,
        nickname: jsNickname,
        content: jsContent,
        created_time: jsAbstime,
        createTime: formatTimestampToReadable(jsAbstime),
        createTime2: formatTimestampToReadable(jsAbstime),
        cmtnum: 0,
        likenum: 0,
        fwdnum: jsIsForward ? 1 : 0,
        pic: [],
        appid,
        _source: "feeds3"
      };
      if (jsIsForward) {
        jsItem["rt_tid"] = jsRtTid;
        jsItem["rt_uin"] = jsRtUin;
        jsItem["rt_uinname"] = jsRtUinname;
        jsItem["rt_con"] = jsRtCon;
      }
      msglist.push(jsItem);
      if (msglist.length >= maxItems) break;
    }
    msglist.sort((a, b) => {
      const ta = a["created_time"] || 0;
      const tb = b["created_time"] || 0;
      return tb - ta;
    });
    log("DEBUG", `parseFeeds3Items: JS fallback found ${msglist.length} items`);
    stats.strategy = "js_fallback";
  }
  stats.durationMs = Date.now() - startTime;
  for (const item of msglist) {
    const validation = validateFeedItem(item, stats.strategy);
    if (validation.valid) {
      stats.validItems++;
    } else {
      stats.invalidItems++;
      if (stats.errors.length < 5) {
        stats.errors.push(`tid=${item["tid"]}: ${validation.errors.join(", ")}`);
      }
    }
  }
  stats.totalFound = msglist.length;
  log("INFO", `parseFeeds3Items: strategy=${stats.strategy}, total=${stats.totalFound}, valid=${stats.validItems}, invalid=${stats.invalidItems}, duration=${stats.durationMs}ms`);
  if (stats.errors.length > 0) {
    log("DEBUG", `parseFeeds3Items validation errors: ${stats.errors.join("; ")}`);
  }
  if (stats.totalFound > 0 && stats.validItems / stats.totalFound < 0.5) {
    log("WARNING", `parseFeeds3Items: low validation rate ${stats.validItems}/${stats.totalFound} (${Math.round(stats.validItems / stats.totalFound * 100)}%)`);
  }
  return msglist;
}

// vendor/onebot-qzone/src/qzone/feeds3/feedDataCanonical.ts
function dataAttrFromFeedData(attrs, name) {
  const m = attrs.match(new RegExp(`data-${name}="([^"]*)"`));
  return m?.[1] ?? "";
}
function canonicalPostTidFromFeedAttrs(attrs, searchBefore, searchAfterHead) {
  let tid = dataAttrFromFeedData(attrs, "tid") || dataAttrFromFeedData(attrs, "origtid");
  if (!tid || tid === "advertisement_app") return "";
  if (/^\d+$/.test(tid)) {
    const fkey = dataAttrFromFeedData(attrs, "fkey");
    if (fkey) return fkey;
    const combined = `${searchBefore} ${attrs} ${searchAfterHead}`;
    let keyMatch = combined.match(/data-key="([a-z0-9]{6,})"/i);
    if (!keyMatch) keyMatch = combined.match(/key:\s*['"]([a-z0-9]{6,})['"]/i);
    if (keyMatch) return keyMatch[1];
  }
  return tid;
}

// vendor/onebot-qzone/src/qzone/feeds3/tidParams.ts
var T1_TID_CAPTURE = /t1_tid=([^&"'<>\s]+)/i;
function collectT1TidRefs(text) {
  const out = [];
  const re = /t1_tid=([^&"'<>\s]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = m[1].trim();
    if (v) out.push({ index: m.index, postTid: v });
  }
  return out;
}
function firstT1TidIn(snippet) {
  const m = snippet.match(T1_TID_CAPTURE);
  return m?.[1]?.trim() ?? "";
}

// vendor/onebot-qzone/src/qzone/feeds3/comments.ts
function t1TidsInSnippet(snippet) {
  const out = [];
  const re = /t1_tid=([^&"'<>\s]+)/gi;
  let m;
  while ((m = re.exec(snippet)) !== null) {
    const v = m[1].trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
function commentBlockMatchesPost(fullBlock, fixedPostTid) {
  const t1s = t1TidsInSnippet(fullBlock);
  if (t1s.length === 0) return true;
  const anchorLooksReal = (t) => /^[a-f0-9]{16,}$/i.test(t) || /^d\d+_\d+_/i.test(t);
  const relevant = t1s.filter(anchorLooksReal);
  if (relevant.length === 0) return true;
  const uniq = [...new Set(relevant)];
  const hits = uniq.filter((t) => t === fixedPostTid);
  if (hits.length === 0) return false;
  if (uniq.length > 1 && uniq.some((t) => t !== fixedPostTid)) return false;
  return true;
}
function validateComment(comment, source) {
  const errors = [];
  if (!comment["commentid"] || typeof comment["commentid"] !== "string" || comment["commentid"].length === 0) {
    errors.push("missing or invalid commentid");
  }
  if (!comment["uin"] || typeof comment["uin"] !== "string" || comment["uin"].length === 0) {
    errors.push("missing or invalid uin");
  }
  if (!comment["name"] || typeof comment["name"] !== "string" || comment["name"].length === 0) {
    errors.push("missing or invalid name");
  }
  if (typeof comment["content"] !== "string") {
    errors.push("missing or invalid content type");
  }
  const ct = comment["createtime"];
  const fseq = comment["_feeds3_seq"];
  if (typeof ct !== "number" || ct <= 0 && typeof fseq !== "number") {
    errors.push("missing or invalid createtime");
  }
  if (errors.length > 0 && source === "root") {
    log("DEBUG", `validateComment [${source}]: commentid=${comment["commentid"]}, errors=[${errors.join(", ")}]`);
  }
  return { valid: errors.length === 0, errors };
}
function extractReplyToNickname(body) {
  const htmlPattern = /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>(?:&nbsp;|\s)*回复(?:&nbsp;|\s)*<a[^>]*class="[^"]*nickname[^"]*"[^>]*>([^<]+)<\/a>/i;
  const htmlMatch = body.match(htmlPattern);
  if (htmlMatch) {
    return htmlUnescape(htmlMatch[1].trim());
  }
  const textPattern = /回复\s*[@＠]([^:：\s]+)/i;
  const textMatch = body.match(textPattern);
  if (textMatch) {
    return htmlUnescape(textMatch[1].trim());
  }
  return null;
}
var COMMENT_IMG_EXCLUDED = [
  /qzonestyle\.gtimg\.cn\/qzone\/em\//,
  /qzonestyle\.gtimg\.cn\/qzone\/space\//,
  /\/ac\/b\.gif$/,
  /qlogo\.cn/,
  /qzapp\.qlogo\.cn/,
  /qzonestyle\.gtimg\.cn\/act/
];
function extractImagesFromCommentHtml(html) {
  const urls = [];
  const isUserPic = (u) => u.startsWith("http") && !COMMENT_IMG_EXCLUDED.some((p) => p.test(u));
  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    const dataSrc = tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1];
    const dataOrig = tag.match(/\bdata-original=["']([^"']+)["']/i)?.[1];
    const lzSrc = tag.match(/\b(?:lz-src|lazy-src)=["']([^"']+)["']/i)?.[1];
    for (const url of [src, dataSrc, dataOrig, lzSrc]) {
      if (!url || urls.includes(url)) continue;
      if ((url.includes("qpic.cn") || url.includes("photo.store.qq.com")) && isUserPic(url)) urls.push(url);
    }
  }
  return urls;
}
function extractPicUrlsFromDataPickey(html) {
  const urls = [];
  const isUserPic = (u) => u.startsWith("http") && !COMMENT_IMG_EXCLUDED.some((p) => p.test(u));
  const re = /data-pickey="([^,]+),([^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[2].trim();
    if (!url.startsWith("http")) continue;
    if (!isUserPic(url)) continue;
    if ((url.includes("qpic.cn") || url.includes("photo.store.qq.com")) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}
function extractPicUrlsFromImageAnchors(html) {
  const urls = [];
  const isUserPic = (u) => u.startsWith("http") && !COMMENT_IMG_EXCLUDED.some((p) => p.test(u));
  const re = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (!isUserPic(url)) continue;
    if ((url.includes("qpic.cn") || url.includes("photo.store.qq.com")) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}
function extractQpicUrlsFromText(html, isUserPic) {
  const urls = [];
  const pattern = /https?:\/\/[^"'\s<>]*qpic\.cn\/[^"'\s<>]+|https?:\/\/[^"'\s<>]*photo\.store\.qq\.com\/[^"'\s<>]+/gi;
  let m;
  while ((m = pattern.exec(html)) !== null) {
    const url = m[0];
    if (isUserPic(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}
function extractPicUrlsFromBackgroundImage(html) {
  const urls = [];
  const isUserPic = (u) => u.startsWith("http") && !COMMENT_IMG_EXCLUDED.some((p) => p.test(u));
  const re = /url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1].trim();
    if (!isUserPic(url)) continue;
    if ((url.includes("qpic.cn") || url.includes("photo.store.qq.com")) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}
function extractImagesFromCommentThumbnails(body) {
  const startIdx = body.search(/<div[^>]*class="[^"]*comments-thumbnails[^"]*"/i);
  if (startIdx < 0) return [];
  const afterOpen = body.indexOf(">", startIdx) + 1;
  const endIdx = body.indexOf("<div", afterOpen);
  const thumbBlock = endIdx > afterOpen ? body.slice(afterOpen, endIdx) : body.slice(afterOpen, afterOpen + 3e3);
  const urls = [];
  const isUserPic = (u) => u.startsWith("http") && !COMMENT_IMG_EXCLUDED.some((p) => p.test(u));
  for (const m of thumbBlock.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    const dataSrc = tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1];
    const dataOrig = tag.match(/\bdata-original=["']([^"']+)["']/i)?.[1];
    const lzSrc = tag.match(/\b(?:lz-src|lazy-src)=["']([^"']+)["']/i)?.[1];
    for (const url of [src, dataSrc, dataOrig, lzSrc]) {
      if (!url || urls.includes(url)) continue;
      if (isUserPic(url) && (url.includes("qpic.cn") || url.includes("photo.store.qq.com") || /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url))) urls.push(url);
    }
  }
  if (urls.length === 0) {
    const fromText = extractQpicUrlsFromText(thumbBlock, isUserPic);
    for (const u of fromText) if (!urls.includes(u)) urls.push(u);
  }
  return urls;
}
function getCommentContentFragment(body, isReply) {
  function truncateAtCommentsOp(html) {
    const opMatch = html.match(/<div\s+class="[^"]*comments-op[^"]*"/i);
    if (opMatch) {
      let truncated = html.slice(0, opMatch.index);
      const lastLt = truncated.lastIndexOf("<");
      if (lastLt >= 0) {
        const afterLt = truncated.slice(lastLt);
        const looksLikeTag = /^<[a-zA-Z\/]/.test(afterLt);
        const hasClose = afterLt.includes(">");
        if (looksLikeTag && !hasClose) truncated = truncated.slice(0, lastLt);
      }
      return truncated;
    }
    return html;
  }
  if (isReply) {
    const replyPattern = /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>(?:&nbsp;|\s)*回复(?:\s*<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>)(?:&nbsp;|\s)*[:：](?:&nbsp;|\s)*([\s\S]*?)(?:<div\s+class="comments-op|<div\s+class="mod-comments-sub|$)/i;
    const replyMatch = body.match(replyPattern);
    if (replyMatch) return truncateAtCommentsOp(replyMatch[1]);
  }
  const rootPattern = /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>(?:&nbsp;|\s)*[:：](?:&nbsp;|\s)*([\s\S]*?)(?:<div\s+class="comments-op|<div\s+class="mod-comments-sub|<\/div>\s*<div|$)/i;
  const rootMatch = body.match(rootPattern);
  if (rootMatch) return truncateAtCommentsOp(rootMatch[1]);
  const loosePattern = /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>\s*[:：]\s*([^<]+)/i;
  const looseMatch = body.match(loosePattern);
  if (looseMatch) return looseMatch[1].trim();
  const contentPattern = /<div[^>]*class="[^"]*comments-content[^"]*"[^>]*>[\s\S]*?<\/a>\s*[:：]\s*([^<]+(?:<[^>]+>[^<]*)*)/i;
  const contentMatch = body.match(contentPattern);
  if (contentMatch) return truncateAtCommentsOp(contentMatch[1]);
  return null;
}
function extractCommentContentAndImages(body, isReply) {
  const fragment = getCommentContentFragment(body, isReply);
  const content = fragment ? htmlUnescape(stripHtmlTags(fragment)).trim() : "";
  const fromFragment = fragment ? extractImagesFromCommentHtml(fragment) : [];
  const fromBody = extractImagesFromCommentHtml(body);
  const fromThumbnails = extractImagesFromCommentThumbnails(body);
  const fromPickey = extractPicUrlsFromDataPickey(body);
  const fromAnchors = extractPicUrlsFromImageAnchors(body);
  const pic = [...fromFragment];
  for (const url of [...fromBody, ...fromThumbnails, ...fromPickey, ...fromAnchors]) {
    if (!pic.includes(url)) pic.push(url);
  }
  if (pic.length === 0 && /comments-thumbnails/i.test(body)) {
    const isUserPic = (u) => u.startsWith("http") && !COMMENT_IMG_EXCLUDED.some((p) => p.test(u));
    for (const u of extractQpicUrlsFromText(body, isUserPic)) {
      if (!pic.includes(u)) pic.push(u);
    }
  }
  if (pic.length === 0) {
    const isUserPic = (u) => u.startsWith("http") && !COMMENT_IMG_EXCLUDED.some((p) => p.test(u));
    for (const u of extractQpicUrlsFromText(body, isUserPic)) {
      if (!pic.includes(u)) pic.push(u);
    }
    for (const u of extractPicUrlsFromBackgroundImage(body)) {
      if (!pic.includes(u)) pic.push(u);
    }
  }
  return { content, pic };
}
function parseCommentTime(body, widerContext = "") {
  const hay = `${body}
${widerContext}`;
  const unixM = hay.match(/(?:^|[?&])(?:abstime|createtime|ctime|pubtime|oper_time)=(\d{9,13})\b/i);
  if (unixM) {
    let n = parseInt(unixM[1], 10);
    if (n > 1e12) n = Math.floor(n / 1e3);
    if (n > 1e8 && n < 2e10) return n;
  }
  const dataM = hay.match(/data-(?:time|ct|ts|opertime|seconds)="(\d{9,13})"/i);
  if (dataM) {
    let n = parseInt(dataM[1], 10);
    if (n > 1e12) n = Math.floor(n / 1e3);
    if (n > 1e8 && n < 2e10) return n;
  }
  const timeMatch = body.match(/class="[^"]*\bstate\b[^"]*"[^>]*>\s*([^<]+)/);
  if (!timeMatch) return 0;
  const ts = timeMatch[1].trim();
  const d = /* @__PURE__ */ new Date();
  const hm = ts.match(/(\d{1,2}):(\d{2})/);
  if (hm) {
    if (ts.includes("\u6628\u5929")) d.setDate(d.getDate() - 1);
    else if (ts.includes("\u524D\u5929")) d.setDate(d.getDate() - 2);
    d.setHours(parseInt(hm[1], 10), parseInt(hm[2], 10), 0, 0);
    return Math.floor(d.getTime() / 1e3);
  }
  const md = ts.match(/(\d{1,2})[-月](\d{1,2})/);
  if (md) {
    d.setMonth(parseInt(md[1], 10) - 1, parseInt(md[2], 10));
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1e3);
  }
  const ymd = ts.match(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})/);
  if (ymd) {
    d.setFullYear(parseInt(ymd[1], 10), parseInt(ymd[2], 10) - 1, parseInt(ymd[3], 10));
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1e3);
  }
  return 0;
}
function findMatchingClosingCommentsItemLi(text, start) {
  const liCommentsOpen = /<li\s+class="comments-item/g;
  let depth = 1;
  let pos = start;
  while (depth > 0 && pos < text.length) {
    const nextClose = text.indexOf("</li>", pos);
    if (nextClose < 0) return -1;
    liCommentsOpen.lastIndex = pos;
    const openMatch = liCommentsOpen.exec(text);
    const nextOpen = openMatch !== null && openMatch.index < nextClose ? openMatch.index : -1;
    if (nextOpen >= 0) {
      depth++;
      pos = nextOpen + 1;
    } else {
      depth--;
      if (depth === 0) return nextClose + 6;
      pos = nextClose + 1;
    }
  }
  return -1;
}
function parseFeeds3CommentsInRegion(region, fixedPostTid, feeds3Seq) {
  const bucket = [];
  const rootCommentPat = /<li\s+class="comments-item[^"]*"[^>]*data-type="commentroot"[^>]*>/gi;
  let rootMatch;
  while ((rootMatch = rootCommentPat.exec(region)) !== null) {
    const openTag = rootMatch[0];
    const openEnd = rootMatch.index + openTag.length;
    const closeEnd = findMatchingClosingCommentsItemLi(region, openEnd);
    if (closeEnd < 0) continue;
    const fullBlock = region.slice(rootMatch.index, closeEnd);
    const body = region.slice(openEnd, closeEnd - 6);
    if (!commentBlockMatchesPost(fullBlock, fixedPostTid)) {
      log(
        "DEBUG",
        `parseFeeds3CommentsInRegion: skip root comment block (t1 mismatch). want=${fixedPostTid.slice(-14)} t1s=${t1TidsInSnippet(fullBlock).map((x) => x.slice(-14)).join("|")}`
      );
      continue;
    }
    const rootTid = openTag.match(/data-tid="([^"]*)"/)?.[1] ?? "";
    const rootUin = openTag.match(/data-uin="([^"]*)"/)?.[1] ?? "";
    const rootNick = openTag.match(/data-nick="([^"]*)"/)?.[1] ?? "";
    if (!rootTid) continue;
    const { content: rootContent, pic: rootPic } = extractCommentContentAndImages(body, false);
    const rootTime = parseCommentTime(body, fullBlock);
    const rootComment = {
      commentid: rootTid,
      uin: rootUin,
      name: rootNick,
      content: rootContent,
      createtime: rootTime,
      is_reply: false,
      _source: "feeds3_html",
      _feeds3_seq: feeds3Seq.value++
    };
    if (rootPic.length > 0) rootComment["pic"] = rootPic;
    bucket.push(rootComment);
    const subCommentsPat = /<div[^>]*class="[^"]*mod-comments-sub[^"]*"[^>]*>[\s\S]*?<ul>([\s\S]*?)<\/ul>[\s\S]*?<\/div>/gi;
    subCommentsPat.lastIndex = 0;
    let subBlockMatch;
    while ((subBlockMatch = subCommentsPat.exec(fullBlock)) !== null) {
      const subUl = subBlockMatch[1];
      const replyPat = /<li\s+class="comments-item[^"]*"[^>]*data-type="replyroot"[^>]*>/gi;
      replyPat.lastIndex = 0;
      let replyMatch;
      while ((replyMatch = replyPat.exec(subUl)) !== null) {
        const replyOpenTag = replyMatch[0];
        const replyOpenEnd = replyMatch.index + replyOpenTag.length;
        const replyCloseEnd = findMatchingClosingCommentsItemLi(subUl, replyOpenEnd);
        if (replyCloseEnd < 0) continue;
        const replyBody = subUl.slice(replyOpenEnd, replyCloseEnd - 6);
        const replyTid = replyOpenTag.match(/data-tid="([^"]*)"/)?.[1] ?? "";
        const replyUin = replyOpenTag.match(/data-uin="([^"]*)"/)?.[1] ?? "";
        const replyNick = replyOpenTag.match(/data-nick="([^"]*)"/)?.[1] ?? "";
        if (!replyTid) continue;
        const t2Uin = replyBody.match(/t2_uin=(\d+)/i)?.[1] ?? "";
        const t2Tid = replyBody.match(/t2_tid=([^&"\s]+)/i)?.[1] ?? "";
        const replyToNickname = extractReplyToNickname(replyBody);
        const { content: replyContent, pic: replyPic } = extractCommentContentAndImages(replyBody, true);
        const replyTime = parseCommentTime(replyBody, fullBlock);
        const finalReplyId = t2Tid ? `${rootTid}_r_${replyTid}_${replyUin}` : `${rootTid}_${replyTid}_${replyUin}`;
        const replyComment = {
          commentid: finalReplyId,
          uin: replyUin,
          name: replyNick,
          content: replyContent,
          createtime: replyTime,
          is_reply: true,
          parent_comment_id: rootTid,
          _source: "feeds3_html",
          _feeds3_seq: feeds3Seq.value++
        };
        if (t2Uin) replyComment["reply_to_uin"] = t2Uin;
        if (replyToNickname) replyComment["reply_to_nickname"] = replyToNickname;
        if (t2Tid) replyComment["reply_to_comment_id"] = t2Tid;
        if (replyPic.length > 0) replyComment["pic"] = replyPic;
        bucket.push(replyComment);
      }
    }
  }
  const legacyCommentPat = /<li\s+class="comments-item[^"]*"([^>]*)>/g;
  let legacyMatch;
  const seenCommentIds = /* @__PURE__ */ new Set();
  for (const c of bucket) {
    seenCommentIds.add(c["commentid"]);
  }
  while ((legacyMatch = legacyCommentPat.exec(region)) !== null) {
    const attrs = legacyMatch[1];
    if (attrs.includes('data-type="commentroot"') || attrs.includes('data-type="replyroot"')) continue;
    const openEnd = legacyMatch.index + legacyMatch[0].length;
    const closeEnd = findMatchingClosingCommentsItemLi(region, openEnd);
    if (closeEnd < 0) continue;
    const legacyFull = region.slice(legacyMatch.index, closeEnd);
    if (!commentBlockMatchesPost(legacyFull, fixedPostTid)) continue;
    const body = region.slice(openEnd, closeEnd - 6);
    const commentId = attrs.match(/data-tid="([^"]*)"/)?.[1] ?? "";
    const uin = attrs.match(/data-uin="([^"]*)"/)?.[1] ?? "";
    const nick = attrs.match(/data-nick="([^"]*)"/)?.[1] ?? "";
    if (!commentId || seenCommentIds.has(commentId)) continue;
    seenCommentIds.add(commentId);
    const isReply = body.includes("\u56DE\u590D");
    const { content, pic: legacyPic } = extractCommentContentAndImages(body, isReply);
    const createdTime = parseCommentTime(
      body,
      region.slice(Math.max(0, legacyMatch.index - 2e3), Math.min(region.length, closeEnd + 500))
    );
    const t2Uin = body.match(/t2_uin=(\d+)/i)?.[1] ?? "";
    const t2Tid = body.match(/t2_tid=([^&"\s]+)/i)?.[1] ?? "";
    const replyToNickname = isReply ? extractReplyToNickname(body) : null;
    const comment = {
      commentid: commentId,
      uin,
      name: nick,
      content,
      createtime: createdTime,
      is_reply: isReply,
      _source: "feeds3_html",
      _feeds3_seq: feeds3Seq.value++
    };
    if (legacyPic.length > 0) comment["pic"] = legacyPic;
    if (isReply) {
      if (t2Uin) comment["reply_to_uin"] = t2Uin;
      if (replyToNickname) comment["reply_to_nickname"] = replyToNickname;
      if (t2Tid) comment["reply_to_comment_id"] = t2Tid;
    }
    bucket.push(comment);
  }
  return bucket;
}
function parseFeeds3CommentsScoped(processedText) {
  const result = /* @__PURE__ */ new Map();
  const feedDataPat = /name="feed_data"\s*([^>]*)>/g;
  const matches = [];
  let fm;
  while ((fm = feedDataPat.exec(processedText)) !== null) {
    matches.push({ index: fm.index, attrs: fm[1] });
  }
  if (matches.length === 0) return result;
  const feeds3Seq = { value: 0 };
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : processedText.length;
    const region = processedText.slice(start, end);
    const prevFdPos = i > 0 ? matches[i - 1].index : -1;
    const beforeStart = prevFdPos >= 0 ? Math.max(prevFdPos, start - 8e3) : Math.max(0, start - 8e3);
    const searchBefore = processedText.slice(beforeStart, start);
    const searchAfterHead = region.slice(0, 4e3);
    const canonical = canonicalPostTidFromFeedAttrs(matches[i].attrs, searchBefore, searchAfterHead);
    if (!canonical) continue;
    const list = parseFeeds3CommentsInRegion(region, canonical, feeds3Seq);
    if (list.length === 0) continue;
    if (!result.has(canonical)) result.set(canonical, []);
    const dest = result.get(canonical);
    const seen = new Set(dest.map((c) => String(c["commentid"])));
    for (const c of list) {
      const id = String(c["commentid"]);
      if (!seen.has(id)) {
        seen.add(id);
        dest.push(c);
      }
    }
  }
  return result;
}
function finalizeParseFeeds3CommentsResult(result, startTime) {
  const stats = {
    rootComments: 0,
    replyComments: 0,
    validComments: 0,
    invalidComments: 0,
    errors: [],
    durationMs: 0
  };
  for (const comments of result.values()) {
    for (const comment of comments) {
      if (comment["is_reply"]) stats.replyComments++;
      else stats.rootComments++;
    }
  }
  stats.durationMs = Date.now() - startTime;
  for (const comments of result.values()) {
    for (const comment of comments) {
      const validation = validateComment(comment, "root");
      if (validation.valid) {
        stats.validComments++;
      } else {
        stats.invalidComments++;
        if (stats.errors.length < 10) {
          stats.errors.push(`cid=${comment["commentid"]}: ${validation.errors.join(", ")}`);
        }
      }
    }
  }
  log(
    "INFO",
    `parseFeeds3Comments: posts=${result.size}, root=${stats.rootComments}, replies=${stats.replyComments}, valid=${stats.validComments}, invalid=${stats.invalidComments}, duration=${stats.durationMs}ms`
  );
  if (stats.errors.length > 0) {
    log(
      "DEBUG",
      `parseFeeds3Comments validation errors: ${stats.errors.slice(0, 5).join("; ")}${stats.errors.length > 5 ? "..." : ""}`
    );
  }
  return result;
}
function parseFeeds3CommentsLegacyInferTid(processedText, startTime) {
  const result = /* @__PURE__ */ new Map();
  const tidRefs = collectT1TidRefs(processedText);
  let feeds3Seq = 0;
  const rootCommentPat = /<li\s+class="comments-item[^"]*"[^>]*data-type="commentroot"[^>]*>/gi;
  let rootMatch;
  while ((rootMatch = rootCommentPat.exec(processedText)) !== null) {
    const openTag = rootMatch[0];
    const openEnd = rootMatch.index + openTag.length;
    const closeEnd = findMatchingClosingCommentsItemLi(processedText, openEnd);
    if (closeEnd < 0) continue;
    const fullBlock = processedText.slice(rootMatch.index, closeEnd);
    const body = processedText.slice(openEnd, closeEnd - 6);
    const rootTid = openTag.match(/data-tid="([^"]*)"/)?.[1] ?? "";
    const rootUin = openTag.match(/data-uin="([^"]*)"/)?.[1] ?? "";
    const rootNick = openTag.match(/data-nick="([^"]*)"/)?.[1] ?? "";
    if (!rootTid) continue;
    let postTid = firstT1TidIn(fullBlock);
    if (!postTid && tidRefs.length) {
      const prevTids = tidRefs.filter((r) => r.index < rootMatch.index);
      if (prevTids.length > 0) postTid = prevTids[prevTids.length - 1].postTid;
    }
    if (!postTid) continue;
    if (!commentBlockMatchesPost(fullBlock, postTid)) continue;
    const { content: rootContent, pic: rootPic } = extractCommentContentAndImages(body, false);
    const rootTime = parseCommentTime(body, fullBlock);
    const rootComment = {
      commentid: rootTid,
      uin: rootUin,
      name: rootNick,
      content: rootContent,
      createtime: rootTime,
      is_reply: false,
      _source: "feeds3_html",
      _feeds3_seq: feeds3Seq++
    };
    if (rootPic.length > 0) rootComment["pic"] = rootPic;
    if (!result.has(postTid)) result.set(postTid, []);
    result.get(postTid).push(rootComment);
    const subCommentsPat = /<div[^>]*class="[^"]*mod-comments-sub[^"]*"[^>]*>[\s\S]*?<ul>([\s\S]*?)<\/ul>[\s\S]*?<\/div>/gi;
    subCommentsPat.lastIndex = 0;
    let subBlockMatch;
    while ((subBlockMatch = subCommentsPat.exec(fullBlock)) !== null) {
      const subUl = subBlockMatch[1];
      const replyPat = /<li\s+class="comments-item[^"]*"[^>]*data-type="replyroot"[^>]*>/gi;
      replyPat.lastIndex = 0;
      let replyMatch;
      while ((replyMatch = replyPat.exec(subUl)) !== null) {
        const replyOpenTag = replyMatch[0];
        const replyOpenEnd = replyMatch.index + replyOpenTag.length;
        const replyCloseEnd = findMatchingClosingCommentsItemLi(subUl, replyOpenEnd);
        if (replyCloseEnd < 0) continue;
        const replyBody = subUl.slice(replyOpenEnd, replyCloseEnd - 6);
        const replyTid = replyOpenTag.match(/data-tid="([^"]*)"/)?.[1] ?? "";
        const replyUin = replyOpenTag.match(/data-uin="([^"]*)"/)?.[1] ?? "";
        const replyNick = replyOpenTag.match(/data-nick="([^"]*)"/)?.[1] ?? "";
        if (!replyTid) continue;
        const t2Uin = replyBody.match(/t2_uin=(\d+)/i)?.[1] ?? "";
        const t2Tid = replyBody.match(/t2_tid=([^&"\s]+)/i)?.[1] ?? "";
        const replyToNickname = extractReplyToNickname(replyBody);
        const { content: replyContent, pic: replyPic } = extractCommentContentAndImages(replyBody, true);
        const replyTime = parseCommentTime(replyBody, fullBlock);
        const finalReplyId = t2Tid ? `${rootTid}_r_${replyTid}_${replyUin}` : `${rootTid}_${replyTid}_${replyUin}`;
        const replyComment = {
          commentid: finalReplyId,
          uin: replyUin,
          name: replyNick,
          content: replyContent,
          createtime: replyTime,
          is_reply: true,
          parent_comment_id: rootTid,
          _source: "feeds3_html",
          _feeds3_seq: feeds3Seq++
        };
        if (t2Uin) replyComment["reply_to_uin"] = t2Uin;
        if (replyToNickname) replyComment["reply_to_nickname"] = replyToNickname;
        if (t2Tid) replyComment["reply_to_comment_id"] = t2Tid;
        if (replyPic.length > 0) replyComment["pic"] = replyPic;
        result.get(postTid).push(replyComment);
      }
    }
  }
  const legacyCommentPat = /<li\s+class="comments-item[^"]*"([^>]*)>/g;
  let legacyMatch;
  const seenCommentIds = /* @__PURE__ */ new Set();
  for (const comments of result.values()) {
    for (const c of comments) {
      seenCommentIds.add(c["commentid"]);
    }
  }
  while ((legacyMatch = legacyCommentPat.exec(processedText)) !== null) {
    const attrs = legacyMatch[1];
    if (attrs.includes('data-type="commentroot"') || attrs.includes('data-type="replyroot"')) {
      continue;
    }
    const openEnd = legacyMatch.index + legacyMatch[0].length;
    const closeEnd = findMatchingClosingCommentsItemLi(processedText, openEnd);
    if (closeEnd < 0) continue;
    const body = processedText.slice(openEnd, closeEnd - 6);
    const commentId = attrs.match(/data-tid="([^"]*)"/)?.[1] ?? "";
    const uin = attrs.match(/data-uin="([^"]*)"/)?.[1] ?? "";
    const nick = attrs.match(/data-nick="([^"]*)"/)?.[1] ?? "";
    if (!commentId || seenCommentIds.has(commentId)) continue;
    seenCommentIds.add(commentId);
    let postTid = firstT1TidIn(body);
    if (!postTid && tidRefs.length) {
      const next = tidRefs.find((r) => r.index >= closeEnd);
      if (next) postTid = next.postTid;
      else postTid = tidRefs[tidRefs.length - 1].postTid;
    }
    if (!postTid) continue;
    const isReply = body.includes("\u56DE\u590D");
    const { content, pic: legacyPic } = extractCommentContentAndImages(body, isReply);
    const createdTime = parseCommentTime(body, processedText.slice(Math.max(0, legacyMatch.index - 2e3), Math.min(processedText.length, closeEnd + 500)));
    const t2Uin = body.match(/t2_uin=(\d+)/i)?.[1] ?? "";
    const t2Tid = body.match(/t2_tid=([^&"\s]+)/i)?.[1] ?? "";
    const replyToNickname = isReply ? extractReplyToNickname(body) : null;
    const comment = {
      commentid: commentId,
      uin,
      name: nick,
      content,
      createtime: createdTime,
      is_reply: isReply,
      _source: "feeds3_html",
      _feeds3_seq: feeds3Seq++
    };
    if (legacyPic.length > 0) comment["pic"] = legacyPic;
    if (isReply) {
      if (t2Uin) comment["reply_to_uin"] = t2Uin;
      if (replyToNickname) comment["reply_to_nickname"] = replyToNickname;
      if (t2Tid) comment["reply_to_comment_id"] = t2Tid;
    }
    if (!result.has(postTid)) result.set(postTid, []);
    result.get(postTid).push(comment);
  }
  return finalizeParseFeeds3CommentsResult(result, startTime);
}
function parseFeeds3Comments(text) {
  const startTime = Date.now();
  const { text: processedText } = preprocessHtml(text);
  const scoped = parseFeeds3CommentsScoped(processedText);
  if (scoped.size > 0) {
    return finalizeParseFeeds3CommentsResult(scoped, startTime);
  }
  return parseFeeds3CommentsLegacyInferTid(processedText, startTime);
}

// vendor/onebot-qzone/src/qzone/feeds3/likes.ts
function parseSinglePostLikes(html, tid, ownerUin) {
  const likes = [];
  const userListMatch = html.match(/class="user-list"[^>]*>([\s\S]*?)<\/div>/i);
  if (!userListMatch) return likes;
  const userListHtml = userListMatch[1];
  const linkPattern = /<a[^>]*href="http:\/\/user\.qzone\.qq\.com\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkPattern.exec(userListHtml)) !== null) {
    const uin = m[1];
    const innerHtml = m[2];
    const nickname = htmlUnescape(innerHtml.replace(/<[^>]+>/g, "").replace(/、/g, "").trim());
    if (uin && nickname) {
      likes.push({
        uin,
        nickname,
        tid,
        ownerUin,
        abstime: 0,
        customItemId: "",
        _source: "feeds3_html"
      });
    }
  }
  return likes;
}
function parseFeeds3Likes(text, processedText) {
  const result = /* @__PURE__ */ new Map();
  const html = processedText ?? preprocessHtml(text).text;
  const tidPositions = collectT1TidRefs(html);
  for (let i = 0; i < tidPositions.length; i++) {
    const { postTid: tid } = tidPositions[i];
    const startIdx = tidPositions[i].index;
    const endIdx = i < tidPositions.length - 1 ? tidPositions[i + 1].index : html.length;
    const block = html.slice(startIdx, endIdx);
    if (block.includes("user-list")) {
      const ownerMatch = block.match(/t1_uin=(\d+)/);
      const ownerUin = ownerMatch?.[1] ?? "";
      const likes = parseSinglePostLikes(block, tid, ownerUin);
      if (likes.length > 0) result.set(tid, likes);
    }
  }
  const feedItemPat = /<div\s+class="f-item[^"]*f-item-passive"\s+id="feed_(\d+)_(\d+)_(\d+)_(\d+)_\d+_\d+"[\s\S]*?name="feed_data"\s*([^>]*)>[\s\S]*?(?=<div\s+class="f-item|<\/ul>|$)/g;
  const dataAttr = (attrs, name) => {
    const m = attrs.match(new RegExp(`data-${name}="([^"]*)"`));
    return m?.[1] ?? "";
  };
  let fm;
  while ((fm = feedItemPat.exec(html)) !== null) {
    const feedDataAttrs = fm[5];
    const feedstype = dataAttr(feedDataAttrs, "feedstype");
    if (feedstype !== "101") continue;
    const likerUin = fm[1];
    const tidRaw = dataAttr(feedDataAttrs, "tid");
    const ownerUin = dataAttr(feedDataAttrs, "uin");
    const abstime = parseInt(dataAttr(feedDataAttrs, "abstime") || "0", 10);
    if (!tidRaw || !likerUin || likerUin === "0") continue;
    const searchBeforeWide = html.substring(Math.max(0, fm.index - 8e3), fm.index);
    const searchAfterHead = fm[0].slice(0, 4e3);
    const tid = canonicalPostTidFromFeedAttrs(feedDataAttrs, searchBeforeWide, searchAfterHead) || tidRaw;
    const blockStart = Math.max(0, fm.index - 600);
    const preceding = html.substring(blockStart, fm.index);
    let nickname = "";
    const nickMatch = preceding.match(/link="nameCard_\d+"[^>]*>([^<]+)<\/a>/);
    if (nickMatch) nickname = htmlUnescape(nickMatch[1].trim());
    const blockContent = fm[0];
    const customMatch = blockContent.match(/data-custom_itemid="(\d+)"/);
    const customItemId = customMatch?.[1] ?? "";
    const like = {
      uin: likerUin,
      nickname,
      tid,
      ownerUin,
      abstime,
      customItemId,
      _source: "feeds3_html"
    };
    if (!result.has(tid)) result.set(tid, []);
    const existing = result.get(tid).find((l) => l.uin === likerUin);
    if (!existing) result.get(tid).push(like);
  }
  for (const [tid, likes] of result) {
    const byUin = /* @__PURE__ */ new Map();
    for (const like of likes) {
      const existing = byUin.get(like.uin);
      if (!existing || like.abstime > existing.abstime) byUin.set(like.uin, like);
    }
    result.set(tid, [...byUin.values()]);
  }
  const total = [...result.values()].reduce((s, a) => s + a.length, 0);
  log("DEBUG", `parseFeeds3Likes: found ${total} likes for ${result.size} posts`);
  return result;
}

// vendor/onebot-qzone/src/qzone/feeds3/helpers.ts
function extractFriendsFromFeeds3FromText(text, selfUin) {
  const byUin = /* @__PURE__ */ new Map();
  const opuinRe = /\bopuin:'(\d+)'/g;
  let m;
  while ((m = opuinRe.exec(text)) !== null) {
    const opuin = m[1];
    if (opuin === "0") continue;
    const start = m.index;
    const nextOpuin = text.indexOf("opuin:'", start + 1);
    const end = nextOpuin >= 0 ? nextOpuin : text.length;
    const block = text.slice(start, end);
    const uinM = block.match(/\buin:'(\d+)'/);
    const uin = uinM ? uinM[1] : opuin;
    const nickM = block.match(/\bnickname:'((?:[^'\\]|\\.)*)'/);
    const nickname = nickM ? nickM[1].replace(/\\'/g, "'") : "";
    const logM = block.match(/\blogimg:'((?:[^'\\]|\\.)*)'/);
    const avatar = logM ? logM[1].replace(/\\'/g, "'") : "";
    if (!byUin.has(uin)) {
      byUin.set(uin, { uin, nickname, avatar });
    } else {
      const cur = byUin.get(uin);
      if (nickname) cur.nickname = nickname;
      if (avatar) cur.avatar = avatar;
    }
  }
  const fNickRe = /<div\s+class="f-nick"[^>]*>[\s\S]*?<a[^>]+href="[^"]*\/(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = fNickRe.exec(text)) !== null) {
    const uin = m[1];
    let nickname = (m[2] ?? "").replace(/<[^>]+>/g, "").trim();
    nickname = htmlUnescape(nickname);
    if (!uin || uin === "0") continue;
    if (!byUin.has(uin)) {
      byUin.set(uin, { uin, nickname, avatar: "" });
    } else {
      const cur = byUin.get(uin);
      if (nickname && !cur.nickname) cur.nickname = nickname;
    }
  }
  const list = Array.from(byUin.values()).filter((f) => f.uin !== selfUin);
  log("DEBUG", `extractFriendsFromFeeds3FromText: ${list.length} friends (excluded self ${selfUin})`);
  return list;
}
function extractExternparam(text) {
  try {
    const o = text.trim().startsWith("{") ? JSON.parse(text) : parseJsonp(text);
    const data2 = o?.data;
    const main = data2?.main;
    const v = main?.externparam ?? data2?.externparam ?? o?.externparam;
    if (typeof v === "string" && v.length > 0) return v;
  } catch {
  }
  const m = text.match(/externparam:'([^']+)'/);
  if (m) return m[1];
  const m2 = text.match(/"externparam"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m2) return m2[1].replace(/\\"/g, '"');
  return "";
}

// vendor/onebot-qzone/src/qzone/client.ts
import https from "node:https";

// vendor/onebot-qzone/src/qzone/playwrightHelper.ts
import fs2 from "node:fs";
var SYSTEM_CHROME_PATHS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium"
];
function findSystemChrome() {
  for (const p of SYSTEM_CHROME_PATHS) {
    try {
      if (fs2.existsSync(p)) return p;
    } catch {
    }
  }
  return void 0;
}
async function launchPlaywright(opts) {
  const { headless = true, throwOnMissing = false } = opts ?? {};
  let chromium;
  try {
    const pw = await import(
      /* webpackIgnore: true */
      "playwright"
    );
    chromium = pw.chromium;
  } catch {
    if (throwOnMissing) {
      throw new Error("Playwright \u672A\u5B89\u88C5\uFF0C\u8BF7\u8FD0\u884C: npm install playwright");
    }
    return null;
  }
  const executable = env.playwrightExecutable;
  const channel = env.playwrightChannel;
  const launchOpts = {
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  };
  if (executable) {
    launchOpts.executablePath = executable;
  } else if (channel) {
    launchOpts.channel = channel;
  }
  try {
    const browser = await chromium.launch(launchOpts);
    return { browser, chromium };
  } catch (firstErr) {
    if (!executable) {
      const systemChrome = findSystemChrome();
      if (systemChrome) {
        try {
          delete launchOpts.channel;
          launchOpts.executablePath = systemChrome;
          const browser = await chromium.launch(launchOpts);
          return { browser, chromium };
        } catch {
        }
      }
    }
    throw firstErr;
  }
}

// vendor/onebot-qzone/src/qzone/client.ts
var PUBLISH_IMAGE_UPLOAD_CONCURRENCY = 3;
var UPLOAD_IMAGE_RETRY_COUNT = 2;
var Feeds3BusinessError = class extends Error {
  payload;
  constructor(payload) {
    super(String(payload.message ?? payload.msg ?? "feeds3 business failure"));
    this.name = "Feeds3BusinessError";
    this.payload = payload;
  }
};
var IMAGE_HTTPS_AGENT = new https.Agent({
  keepAlive: false,
  maxSockets: 8,
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.3",
  ciphers: [
    "TLS_AES_128_GCM_SHA256",
    "TLS_AES_256_GCM_SHA384",
    "TLS_CHACHA20_POLY1305_SHA256",
    "ECDHE-ECDSA-AES128-GCM-SHA256",
    "ECDHE-RSA-AES128-GCM-SHA256",
    "ECDHE-ECDSA-AES256-GCM-SHA384",
    "ECDHE-RSA-AES256-GCM-SHA384"
  ].join(":"),
  ALPNProtocols: ["http/1.1"],
  rejectUnauthorized: true
});
var PROXY_HEADERS_DROP = /* @__PURE__ */ new Set([
  "proxy-connection",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "forwarded",
  "via",
  "x-real-ip",
  "client-ip",
  "x-cluster-client-ip",
  "true-client-ip",
  "cf-connecting-ip"
]);
function stripProxyHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!PROXY_HEADERS_DROP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}
function buildProxyFromUrl(proxyUrl) {
  const u = new URL2(proxyUrl);
  if (!["http:", "https:"].includes(u.protocol)) {
    throw new Error(`unsupported proxy protocol: ${u.protocol}`);
  }
  const result = {
    protocol: u.protocol.replace(":", ""),
    host: u.hostname,
    port: Number(u.port || (u.protocol === "https:" ? 443 : 80))
  };
  if (u.username) {
    result.auth = {
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password)
    };
  }
  return result;
}
function isRetryableNetworkError(err) {
  const rec = err;
  const code = rec?.code;
  const msg = String(rec?.message ?? "");
  const status = rec?.response && typeof rec.response?.status === "number" ? rec.response.status : void 0;
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ECONNABORTED", "EPIPE", "EPROTO", "UND_ERR_SOCKET"].includes(code ?? "")) return true;
  if (status === 502 || /502/i.test(msg)) return true;
  if (/Client network socket disconnected before secure TLS connection was established/i.test(msg)) return true;
  if (/socket hang up/i.test(msg)) return true;
  if (/TLS/i.test(msg) && /disconnect/i.test(msg)) return true;
  return false;
}
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function defaultConfig(cfg) {
  return {
    cachePath: env.cachePath,
    proxyUrl: env.proxyUrl || void 0,
    proxyPool: env.proxyPool.split(/[,\r\n]+/).map((s) => s.trim()).filter(Boolean),
    imageProxyUrl: env.imageProxyUrl || void 0,
    ...cfg
  };
}
var QzoneClient = class _QzoneClient {
  config;
  cookies = {};
  cookiesLastUsed = null;
  qqNumber = null;
  jar;
  http;
  proxyCursor = 0;
  // caches
  qzonetokenCache = null;
  qzonetokenCacheTime = 0;
  qzonetokenTtl = CACHE_TTL.qzonetoken;
  qzonetokenFailTime = 0;
  qzonetokenFailTtl = CACHE_TTL.qzonetokenFail;
  playwrightFailTime = 0;
  playwrightCooldown = CACHE_TTL.playwrightFail;
  detailWinningVariant = null;
  detailAllFailTime = 0;
  detailAllFailTtl = CACHE_TTL.detailAllFail;
  feeds3Cache = /* @__PURE__ */ new Map();
  feeds3CacheTime = /* @__PURE__ */ new Map();
  feeds3CacheTtl = CACHE_TTL.feeds3;
  lastFeeds3BusinessFailure = null;
  /** feeds3 HTML 中解析出的评论：postTid → comment records（每次 getEmotionListViaFeeds3 刷新） */
  feeds3Comments = /* @__PURE__ */ new Map();
  feeds3CommentsFetchedAt = /* @__PURE__ */ new Map();
  /** feeds3 HTML 中解析出的点赞：postTid → Feeds3Like[]（每次 getEmotionListViaFeeds3 刷新） */
  feeds3Likes = /* @__PURE__ */ new Map();
  feeds3LikesFetchedAt = /* @__PURE__ */ new Map();
  /**
   * 帖子元数据缓存：tid → { uin, appid, typeid, likeUnikey, likeCurkey, abstime }
   * 由 getFriendFeeds / getEmotionListViaFeeds3 / poller 填充，
   * likeEmotion / commentEmotion 在缺失参数时自动查询。
   */
  postMetaCache = /* @__PURE__ */ new Map();
  static POST_META_CAPACITY = 1e3;
  cachePostMeta(tid, meta) {
    if (!tid) return;
    this.postMetaCache.set(tid, meta);
    if (this.postMetaCache.size > _QzoneClient.POST_META_CAPACITY) {
      const oldest = this.postMetaCache.keys().next().value;
      if (oldest) this.postMetaCache.delete(oldest);
    }
  }
  getPostMeta(tid) {
    return this.postMetaCache.get(tid);
  }
  mergeFeeds3Comments(commentsByTid, fetchedAt = Math.floor(Date.now() / 1e3)) {
    for (const [postTid, cmts] of commentsByTid) {
      const existing = this.feeds3Comments.get(postTid);
      if (existing) {
        const seenIds = new Set(existing.map((c) => String(c["commentid"])));
        for (const c of cmts) {
          const commentId = String(c["commentid"]);
          if (!seenIds.has(commentId)) {
            existing.push(c);
            seenIds.add(commentId);
          }
        }
      } else {
        this.feeds3Comments.set(postTid, [...cmts]);
      }
      this.feeds3CommentsFetchedAt.set(postTid, fetchedAt);
    }
  }
  normalizeFeeds3LikesForTool(likes) {
    return likes.map((l) => ({
      uin: l.uin,
      name: l.nickname,
      time: l.abstime,
      customItemId: l.customItemId,
      _source: "feeds3_html"
    }));
  }
  mergeFeeds3Likes(likesByTid, fetchedAt = Math.floor(Date.now() / 1e3)) {
    for (const [postTid, likes] of likesByTid) {
      const existing = this.feeds3Likes.get(postTid);
      if (existing) {
        const byUin = new Map(existing.map((l) => [l.uin, l]));
        for (const like of likes) {
          const cur = byUin.get(like.uin);
          if (!cur || like.abstime >= cur.abstime) byUin.set(like.uin, like);
        }
        const merged = [...byUin.values()];
        this.feeds3Likes.set(postTid, merged);
        this.feeds3LikesCache.set(postTid, this.normalizeFeeds3LikesForTool(merged));
      } else {
        this.feeds3Likes.set(postTid, [...likes]);
        this.feeds3LikesCache.set(postTid, this.normalizeFeeds3LikesForTool(likes));
      }
      this.feeds3LikesFetchedAt.set(postTid, fetchedAt);
    }
  }
  mergeFeeds3AncillaryFromHtml(htmlText, fetchedAt = Math.floor(Date.now() / 1e3), source = "feeds3") {
    try {
      this.mergeFeeds3Comments(parseFeeds3Comments(htmlText), fetchedAt);
    } catch (e) {
      log("WARN", `${source}: parseFeeds3Comments failed: ${e}`);
    }
    try {
      this.mergeFeeds3Likes(parseFeeds3Likes(htmlText), fetchedAt);
    } catch (e) {
      log("WARN", `${source}: parseFeeds3Likes failed: ${e}`);
    }
  }
  commentCacheAgeSeconds(tid) {
    const fetchedAt = this.feeds3CommentsFetchedAt.get(tid);
    if (fetchedAt == null) return null;
    return Math.max(0, Math.floor(Date.now() / 1e3) - fetchedAt);
  }
  extractDetailTidFromTopicId(topicId) {
    const match = String(topicId ?? "").match(/^\d+_([a-z0-9]+)__\d+$/i);
    return match?.[1] ?? "";
  }
  collectPostEntityKeys(canonicalTid) {
    const keys = /* @__PURE__ */ new Set();
    if (canonicalTid) keys.add(canonicalTid);
    const meta = this.postMetaCache.get(canonicalTid);
    if (!meta) return [...keys];
    if (meta.detailTid) keys.add(meta.detailTid);
    if (meta.topicId) {
      keys.add(meta.topicId);
      const topicDetailTid = this.extractDetailTidFromTopicId(meta.topicId);
      if (topicDetailTid) keys.add(topicDetailTid);
    }
    if (meta.sourceFkey) keys.add(meta.sourceFkey);
    if (meta.abstime > 0) {
      keys.add(String(meta.abstime));
      if (meta.uin) keys.add(`d${meta.uin}_${meta.abstime}_`);
    }
    if (meta.detailUrl) keys.add(meta.detailUrl);
    if (meta.likeUnikey) keys.add(meta.likeUnikey);
    if (meta.likeCurkey) keys.add(meta.likeCurkey);
    return [...keys];
  }
  selectFeeds3AliasSourceKey(canonicalTid, buckets, label) {
    if (!canonicalTid || buckets.has(canonicalTid)) return null;
    const meta = this.postMetaCache.get(canonicalTid);
    const authorUin = meta?.uin?.trim() ?? "";
    const detailTid = meta?.detailTid?.trim() ?? "";
    const topicDetailTid = this.extractDetailTidFromTopicId(meta?.topicId ?? "");
    const sourceFkey = meta?.sourceFkey?.trim() ?? "";
    const detailUrl = meta?.detailUrl?.trim() ?? "";
    const abstime = meta?.abstime;
    const asStr = abstime != null && abstime > 0 ? String(abstime) : "";
    const embedded = asStr ? `_${asStr}_` : "";
    const preferredPrefix = authorUin && asStr ? `d${authorUin}_${asStr}_` : "";
    const candidates = [];
    for (const [key, list] of buckets) {
      if (!list?.length || key === canonicalTid) continue;
      const keyTrimmed = key.trim();
      const matchesAbstime = Boolean(asStr) && (keyTrimmed === asStr || keyTrimmed.includes(embedded));
      const matchesDetailTid = Boolean(detailTid) && keyTrimmed === detailTid;
      const matchesTopicTid = Boolean(topicDetailTid) && keyTrimmed === topicDetailTid;
      const matchesSourceFkey = Boolean(sourceFkey) && keyTrimmed === sourceFkey;
      const matchesDetailUrl = Boolean(detailUrl) && keyTrimmed === detailUrl;
      if (!(matchesAbstime || matchesDetailTid || matchesTopicTid || matchesSourceFkey || matchesDetailUrl)) continue;
      if (authorUin && keyTrimmed.startsWith("d") && !keyTrimmed.startsWith(`d${authorUin}_`)) continue;
      let score = 0;
      if (matchesDetailTid) score += 8;
      if (matchesTopicTid) score += 7;
      if (matchesSourceFkey) score += 6;
      if (matchesDetailUrl) score += 5;
      if (preferredPrefix && keyTrimmed.startsWith(preferredPrefix)) score += 4;
      else if (authorUin && keyTrimmed.startsWith(`d${authorUin}_`)) score += 2;
      if (matchesAbstime && keyTrimmed === asStr) score += 3;
      else if (matchesAbstime) score += 1;
      candidates.push({ key, score });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    const best = candidates[0];
    if (candidates.length > 1 && candidates[1].score === best.score) {
      log("WARNING", `${label}: skip ${canonicalTid}, matched multiple candidate buckets with same score`);
      return null;
    }
    return best.key;
  }
  /**
   * parseFeeds3Comments 按回复链里的 t1_tid 分桶（常为 d{uin}_{abstime}_…），说说列表 tid 常为 fkey。
   * 在 postMetaCache 已有该 fkey 的 abstime 时，把评论数组挂到 fkey 下，供 getCommentsBestEffort(tid) 命中。
   *
   * 注意：同一 uin 在同一秒可能有多条动态，多个内部桶会同时包含 `_${abstime}_`。
   * 旧逻辑取「评论数最多」的桶，易把**相邻帖/转发帖**的评论挂到错误 hex tid（假串帖）。
   * 现逻辑：先按作者 uin 收窄 `d{uin}_` 前缀桶；若仍有多候选则**放弃别名**（宁缺勿滥）。
   */
  aliasFeeds3CommentsToCanonicalTid(canonicalTid) {
    const bestKey = this.selectFeeds3AliasSourceKey(
      canonicalTid,
      this.feeds3Comments,
      "aliasFeeds3CommentsToCanonicalTid"
    );
    if (!bestKey) return;
    const cmts = this.feeds3Comments.get(bestKey);
    this.feeds3Comments.set(canonicalTid, cmts);
    const ft = this.feeds3CommentsFetchedAt.get(bestKey);
    if (ft != null) this.feeds3CommentsFetchedAt.set(canonicalTid, ft);
    log(
      "DEBUG",
      `aliasFeeds3CommentsToCanonicalTid: ${canonicalTid} <- ${bestKey.length > 56 ? `${bestKey.slice(0, 56)}\u2026` : bestKey}`
    );
  }
  /**
   * 若传入的 tid 实为 abstime（纯数字），用 postMetaCache 反查对应的 key（hex tid），
   * 评论接口 PC/mobile 需要 key 格式，用 abstime 会返回空或 -3。
   */
  aliasFeeds3LikesToCanonicalTid(canonicalTid) {
    const bestKey = this.selectFeeds3AliasSourceKey(canonicalTid, this.feeds3Likes, "aliasFeeds3LikesToCanonicalTid");
    if (!bestKey) return;
    const likes = this.feeds3Likes.get(bestKey);
    this.feeds3Likes.set(canonicalTid, likes);
    this.feeds3LikesCache.set(canonicalTid, this.feeds3LikesCache.get(bestKey) ?? this.normalizeFeeds3LikesForTool(likes));
    const ft = this.feeds3LikesFetchedAt.get(bestKey);
    if (ft != null) this.feeds3LikesFetchedAt.set(canonicalTid, ft);
    log(
      "DEBUG",
      `aliasFeeds3LikesToCanonicalTid: ${canonicalTid} <- ${bestKey.length > 56 ? `${bestKey.slice(0, 56)}...` : bestKey}`
    );
  }
  resolveTidForComments(tid) {
    if (!tid || !/^\d+$/.test(tid)) return tid;
    const abstime = Number(tid);
    for (const [key, meta] of this.postMetaCache) {
      if (meta.abstime === abstime) {
        log("DEBUG", `resolveTidForComments: abstime ${tid} -> key ${key}`);
        return key;
      }
    }
    return tid;
  }
  /** 从 feeds3 解析结果（Record）中提取元数据并写入缓存 */
  cachePostMetaFromRaw(item) {
    const tid = String(item["tid"] ?? "");
    if (!tid) return;
    const uin = String(item["uin"] ?? "");
    const appid = String(item["appid"] ?? "311");
    const typeid = String(item["typeid"] ?? "0");
    const likeUnikey = String(item["likeUnikey"] ?? "");
    const likeCurkey = String(item["likeCurkey"] ?? "");
    const abstime = Number(item["created_time"] ?? item["createTime"] ?? 0);
    const topicId = String(item["topicId"] ?? "");
    const detailTid = String(item["detailTid"] ?? "");
    const detailUrl = String(item["detailUrl"] ?? "");
    const sourceFkey = String(item["sourceFkey"] ?? "");
    const cmtnum = Number(item["cmtnum"] ?? 0);
    const likenum = Number(item["likenum"] ?? 0);
    this.cachePostMeta(tid, {
      uin,
      appid,
      typeid,
      likeUnikey,
      likeCurkey,
      abstime,
      topicId: topicId || void 0,
      detailTid: detailTid || void 0,
      detailUrl: detailUrl || void 0,
      sourceFkey: sourceFkey || void 0,
      cmtnum: Number.isFinite(cmtnum) ? cmtnum : void 0,
      likenum: Number.isFinite(likenum) ? likenum : void 0
    });
  }
  /** msglist 条目的 tid / cellid 与目标 tid 匹配（避免 string/number 严格 === 漏匹配） */
  itemMatchesTid(item, tid) {
    const w = String(tid).trim();
    return String(item["tid"] ?? "").trim() === w || String(item["cellid"] ?? "").trim() === w;
  }
  /**
   * PC 详情全灭时：分页搜 feeds_html_act_all 的 msglist，命中则同 list 兜底展开到顶层。
   */
  async detailFromActAllMsglist(uin, tid) {
    let start = 0;
    const count = 30;
    for (let p = 0; p < 18; p++) {
      const act = await this.getFeedsHtmlActAll(uin, { hostUin: uin, start, count, scope: 0 });
      if (Number(act["code"] ?? 0) !== 0) break;
      const list = act["msglist"] ?? [];
      for (const msg of list) {
        if (!this.itemMatchesTid(msg, tid)) continue;
        return {
          ...msg,
          code: 0,
          data: msg,
          message: "success (from act_all list)",
          _detail_semantic: {
            source: "feeds_html_act_all_fallback",
            note: "getdetailv6/mobile \u4E0D\u53EF\u7528\uFF1B\u6B63\u6587\u6765\u81EA ic2 feeds_html_act_all \u5217\u8868\u9879\uFF0C\u5DF2\u5C55\u5F00\u5230\u9876\u5C42 content/conlist\u3002"
          }
        };
      }
      if (!act["has_more"]) break;
      const ns = act["next_start"];
      start = typeof ns === "number" && Number.isFinite(ns) ? ns : start + count;
    }
    return null;
  }
  /** 好友缓存：uin -> { uin, nickname, avatar, lastSeen }，持久化到 friends.json */
  friendCache = /* @__PURE__ */ new Map();
  playwrightFeedBrowser = null;
  playwrightFeedContext = null;
  playwrightFeedPage = null;
  playwrightFeedPosts = /* @__PURE__ */ new Map();
  playwrightFeedPendingParses = /* @__PURE__ */ new Set();
  playwrightFeedListenerAttached = false;
  playwrightFeedDomFallbackUsed = false;
  playwrightFeedNetworkIntercepted = false;
  playwrightFeedInterceptedResponseCount = 0;
  routes = {
    comments: "pc",
    detail: "pc",
    delete_comment: "pc",
    unlike: "mobile_like_active_1"
  };
  constructor(config2) {
    this.config = defaultConfig(config2);
    this.jar = new CookieJar();
    const baseInstance = axios.create({
      timeout: 2e4,
      maxRedirects: 5,
      validateStatus: () => true
      // 不抛出 HTTP 错误
    });
    baseInstance.interceptors.request.use((requestConfig) => {
      requestConfig.proxy = this.resolveAxiosProxy(requestConfig.proxy);
      return requestConfig;
    });
    this.http = wrapper(baseInstance);
    this.http.defaults.jar = this.jar;
    this.loadCookies();
    this.loadFriendCache();
  }
  get loggedIn() {
    return this.qqNumber !== null;
  }
  // ──────────────────────────────────────────────
  // Cookie helpers
  // ──────────────────────────────────────────────
  get cookiePath() {
    return path2.join(this.config.cachePath, "cookies.json");
  }
  get qrcodePath() {
    return path2.join(this.config.cachePath, "qrcode.png");
  }
  get friendCachePath() {
    return path2.join(this.config.cachePath, "friends.json");
  }
  loadCookies() {
    const result = loadCookies(this.cookiePath);
    if (!result) return;
    this.cookies = result.cookies;
    this.cookiesLastUsed = result.lastUsed;
    this._syncJarFromMap();
    const rawUin = this.cookies["uin"] ?? "";
    this.qqNumber = rawUin.replace(/^[oO]/, "") || null;
  }
  loadFriendCache() {
    try {
      const raw = fs3.readFileSync(this.friendCachePath, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        this.friendCache.clear();
        const now2 = Math.floor(Date.now() / 1e3);
        for (const o of arr) {
          if (o && o.uin) {
            this.friendCache.set(o.uin, {
              uin: o.uin,
              nickname: o.nickname ?? "",
              avatar: o.avatar ?? "",
              lastSeen: o.lastSeen ?? now2
            });
          }
        }
        log("DEBUG", `loadFriendCache: ${this.friendCache.size} friends`);
      }
    } catch {
    }
  }
  saveFriendCache() {
    try {
      const arr = Array.from(this.friendCache.values());
      fs3.writeFileSync(this.friendCachePath, JSON.stringify(arr, null, 2), "utf8");
      log("DEBUG", `saveFriendCache: ${arr.length} friends`);
    } catch (e) {
      log("WARNING", `saveFriendCache failed: ${e}`);
    }
  }
  /**
   * 将本次提取的好友列表合并进内存缓存并持久化。仅更新 lastSeen；昵称/头像以新数据覆盖旧。
   */
  mergeFriendCache(items) {
    if (!items.length) return;
    const now2 = Math.floor(Date.now() / 1e3);
    for (const it of items) {
      const existing = this.friendCache.get(it.uin);
      this.friendCache.set(it.uin, {
        uin: it.uin,
        nickname: (it.nickname || existing?.nickname) ?? "",
        avatar: (it.avatar || existing?.avatar) ?? "",
        lastSeen: now2
      });
    }
    this.saveFriendCache();
  }
  saveCookies() {
    this.cookiesLastUsed = /* @__PURE__ */ new Date();
    saveCookies(this.cookiePath, this.cookies);
  }
  /** 将当前 cookies 序列化为 Cookie 字符串（可直接写入 .env / 浏览器） */
  getCookieString() {
    return Object.entries(this.cookies).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
  }
  /**
   * 将最新 Cookie 自动写回 .env 文件的 QZONE_COOKIE 字段。
   * 这样即使进程重启，.env 里也是最新的 Cookie，无需手动更新。
   */
  syncCookieToEnvFile(envPath) {
    const target = envPath ?? path2.join(process.cwd(), ".env");
    try {
      if (!fs3.existsSync(target)) return;
      let content = fs3.readFileSync(target, "utf8");
      const newCookie = this.getCookieString();
      if (!newCookie) return;
      for (const key of ["QZONE_COOKIE_STRING", "QZONE_COOKIE"]) {
        const re = new RegExp(`^${key}=.*`, "m");
        if (re.test(content)) {
          content = content.replace(re, `${key}=${newCookie}`);
        }
      }
      if (!/^QZONE_COOKIE=/m.test(content)) {
        content += `
QZONE_COOKIE=${newCookie}
`;
      }
      fs3.writeFileSync(target, content, "utf8");
      log("INFO", ".env \u6587\u4EF6 QZONE_COOKIE / QZONE_COOKIE_STRING \u5DF2\u81EA\u52A8\u66F4\u65B0");
    } catch (e) {
      log("WARNING", `\u540C\u6B65 Cookie \u5230 .env \u5931\u8D25: ${e}`);
    }
  }
  deleteCookies() {
    this.cookies = {};
    this.jar = new CookieJar();
    this.http.defaults.jar = this.jar;
    deleteCookies(this.cookiePath);
  }
  /** 把 cookies map 注入 tough-cookie jar（.qq.com 域 + ptlogin2 域） */
  _syncJarFromMap() {
    for (const [name, value] of Object.entries(this.cookies)) {
      for (const domain of [".qq.com", ".qzone.qq.com", ".ptlogin2.qq.com"]) {
        this.jar.setCookieSync(`${name}=${value}; Domain=${domain}; Path=/`, `https://${domain.replace(/^\./, "")}/`);
      }
    }
  }
  /** 从 jar 里同步回 cookies map（.qq.com + ptlogin2 子域） */
  _syncMapFromJar() {
    const urls = [
      "https://qq.com/",
      "https://ptlogin2.qq.com/",
      "https://ssl.ptlogin2.qq.com/",
      "https://xui.ptlogin2.qq.com/",
      "https://qzone.qq.com/"
    ];
    for (const u of urls) {
      const allCookies = this.jar.getCookiesSync(u, { allPaths: true });
      for (const c of allCookies) {
        this.cookies[c.key] = c.value;
      }
    }
  }
  // ──────────────────────────────────────────────
  // HTTP 封装
  // ──────────────────────────────────────────────
  getProxyCandidates() {
    if (Array.isArray(this.config.proxyPool) && this.config.proxyPool.length > 0) {
      return this.config.proxyPool.filter(Boolean);
    }
    return this.config.proxyUrl ? [this.config.proxyUrl] : [];
  }
  nextProxyUrl() {
    const proxies = this.getProxyCandidates();
    if (proxies.length === 0) return null;
    const index = this.proxyCursor % proxies.length;
    this.proxyCursor = (this.proxyCursor + 1) % proxies.length;
    return proxies[index] ?? null;
  }
  resolveAxiosProxy(currentProxy) {
    if (currentProxy === false || currentProxy) return currentProxy;
    const proxyUrl = this.nextProxyUrl();
    return proxyUrl ? buildProxyFromUrl(proxyUrl) : false;
  }
  async request(method, url, options = {}) {
    if (this.cookies && Object.keys(this.cookies).length > 0) {
      const cookieStr = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
      if (cookieStr) {
        options.headers = { ...options.headers, Cookie: cookieStr };
      }
    }
    options.responseType = "arraybuffer";
    const resp = await this.http.request({ method, url, ...options });
    this._syncMapFromJar();
    const data2 = Buffer.from(resp.data);
    const text = data2.toString("utf8");
    if (data2.length === 0 && resp.status === 200) {
      log("DEBUG", `[empty-200] ${method} ${url.slice(0, 120)}`);
    } else if (resp.status >= 400) {
      log("WARNING", `[http-${resp.status}] ${method} ${url.slice(0, 120)}`);
    }
    return { status: resp.status, data: data2, text };
  }
  async get(url, options = {}) {
    return this.request("GET", url, options);
  }
  /**
   * 使用当前 Cookie + Referer 拉取图片（用于 QZone CDN 需鉴权的 URL）。
   * 仅应在白名单 URL 上调用，避免 SSRF。
   * 使用固定 TLS/ALPN 的独立 https.Agent；若配置了 imageProxyUrl 则走 Axios 内置 proxy，
   * 否则关闭环境变量代理（proxy: false），确保代理路径单一。
   */
  async fetchImageWithAuth(url) {
    const requestUrl = url.includes("photo.store.qq.com") && url.startsWith("http://") ? url.replace(/^http:\/\//i, "https://") : url;
    const headers = {
      "Referer": "https://user.qzone.qq.com/",
      "User-Agent": this.getRandomizedUserAgent(),
      "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "Accept-Language": this.getRandomizedAcceptLanguage(),
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "cross-site",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache"
    };
    if (this.cookies && Object.keys(this.cookies).length > 0) {
      const cookieStr = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
      if (cookieStr) headers["Cookie"] = cookieStr;
    }
    const requestHeaders = stripProxyHeaders(headers);
    const debugTls = process.env["QZONE_IMAGE_DEBUG_TLS"] === "1";
    const httpsAgent = debugTls ? new https.Agent({
      keepAlive: false,
      maxSockets: 8,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.3",
      ciphers: IMAGE_HTTPS_AGENT.options.ciphers,
      ALPNProtocols: ["http/1.1"],
      rejectUnauthorized: true,
      enableTrace: true
    }) : IMAGE_HTTPS_AGENT;
    const requestConfig = {
      headers: requestHeaders,
      responseType: "arraybuffer",
      httpsAgent,
      timeout: 15e3,
      validateStatus: (status) => status >= 200 && status < 400,
      maxRedirects: 0
    };
    if (this.config.imageProxyUrl) {
      requestConfig.proxy = buildProxyFromUrl(this.config.imageProxyUrl);
    } else {
      requestConfig.proxy = this.resolveAxiosProxy(void 0);
    }
    const httpClient = axios.create({
      timeout: 15e3,
      validateStatus: (s) => s >= 200 && s < 400,
      transitional: { clarifyTimeoutError: true }
    });
    const retries = 3;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const resp = await httpClient.get(requestUrl, requestConfig);
        const data2 = Buffer.from(resp.data);
        if (data2.length === 0) {
          throw new Error(`fetchImageWithAuth: ${resp.status} or empty body`);
        }
        const contentType = resp.headers && resp.headers["content-type"] ? String(resp.headers["content-type"]).split(";")[0].trim() : "image/jpeg";
        return { data: data2, contentType };
      } catch (err) {
        lastErr = err;
        const retryable = isRetryableNetworkError(err);
        const finalAttempt = attempt >= retries;
        if (!retryable || finalAttempt) {
          throw err;
        }
        const backoff = 250 * Math.pow(2, attempt) + Math.floor(Math.random() * 120);
        await sleepMs(backoff);
      }
    }
    throw lastErr;
  }
  /**
   * 增强型请求：自动 JSONP 解壳 + 反爬检测 + 可选 Zod 校验
   */
  async requestParsed(method, url, options = {}, opts) {
    const resp = await this.request(method, url, options);
    return parseRawResponse(resp.status, resp.text, opts);
  }
  /** 便捷 GET → ParsedApiResult */
  async getParsed(url, options = {}, opts) {
    return this.requestParsed("GET", url, options, opts);
  }
  /** 便捷 POST → ParsedApiResult */
  async postParsed(url, options = {}, opts) {
    return this.requestParsed("POST", url, options, opts);
  }
  async post(url, options = {}) {
    const headers = options.headers ?? {};
    if (!headers["Origin"]) {
      if (url.includes("user.qzone.qq.com") || url.includes("taotao.qzone.qq.com") || url.includes("sns.qzone.qq.com")) {
        headers["Origin"] = "https://user.qzone.qq.com";
      } else if (url.includes("up.qzone.qq.com")) {
        headers["Origin"] = "https://up.qzone.qq.com";
      } else if (url.includes("mobile.qzone.qq.com") || url.includes("h5.qzone.qq.com")) {
        headers["Origin"] = "https://mobile.qzone.qq.com";
      } else {
        headers["Origin"] = "https://qzs.qzone.qq.com";
      }
    }
    options.headers = headers;
    return this.request("POST", url, options);
  }
  // ──────────────────────────────────────────────
  // Header 工厂
  // ──────────────────────────────────────────────
  static UA = USER_AGENTS.desktop;
  static SEC_CH_UA = USER_AGENTS.secChUa;
  /** 请求指纹随机化：随机选择 User-Agent */
  getRandomizedUserAgent() {
    return getRandomUserAgent();
  }
  /** 请求指纹随机化：随机选择 Accept-Language */
  getRandomizedAcceptLanguage() {
    return getRandomAcceptLanguage();
  }
  pcHeaders(referrer, origin) {
    const h = {
      "User-Agent": this.getRandomizedUserAgent(),
      "Referer": referrer ?? "https://qzs.qzone.qq.com/",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": this.getRandomizedAcceptLanguage(),
      "Accept-Encoding": "gzip, deflate, br",
      "Sec-Ch-Ua": _QzoneClient.SEC_CH_UA,
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-site",
      "Cache-Control": "max-age=0"
    };
    if (origin) h["Origin"] = origin;
    return h;
  }
  mobileHeaders(origin) {
    const h = {
      "User-Agent": USER_AGENTS.mobile,
      "Referer": "https://mobile.qzone.qq.com",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": this.getRandomizedAcceptLanguage(),
      "Accept-Encoding": "gzip, deflate, br",
      "X-Requested-With": "XMLHttpRequest"
    };
    if (origin) h["Origin"] = origin;
    return h;
  }
  // ──────────────────────────────────────────────
  // CSRF / Auth
  // ──────────────────────────────────────────────
  getGtk() {
    const pSkey = this.cookies["p_skey"] ?? "";
    if (pSkey) return calcGtk(pSkey);
    const skey = this.cookies["skey"] ?? "";
    if (skey) return calcGtk(skey);
    log("WARNING", "p_skey \u548C skey \u5747\u4E3A\u7A7A\uFF0Cg_tk \u5C06\u4E3A 5381");
    return calcGtk("");
  }
  getQzreferrer() {
    return `https://user.qzone.qq.com/${this.qqNumber}/main`;
  }
  isAuthFailure(payload) {
    const code = payload.code;
    const subcode = Number(payload.subcode ?? 0);
    const message = this.describeApiFailure(payload).toLowerCase();
    if (code !== void 0 && AUTH_FAILURE_CODES.has(code)) return true;
    if (subcode === -4001) return true;
    return /need\s+login|请先登录|需要登录|未登录|登录后/i.test(message);
  }
  describeApiFailure(payload) {
    const parts = [
      typeof payload.message === "string" ? payload.message.trim() : "",
      typeof payload.msg === "string" ? payload.msg.trim() : "",
      typeof payload["tips"] === "string" ? String(payload["tips"]).trim() : ""
    ].filter(Boolean);
    return parts.join(" | ");
  }
  getApiFailureKind(payload) {
    if (this.isAuthFailure(payload)) return "auth";
    if (RATE_LIMIT_CODES.has(Number(payload.code ?? 0))) return "rate_limit";
    return "upstream_changed";
  }
  extractFeeds3BusinessFailure(respText) {
    try {
      const parsed = parseJsonp(respText);
      if (!parsed || typeof parsed !== "object") return null;
      const code = Number(parsed.code);
      const hasBusinessCode = Number.isFinite(code) && code !== 0;
      const needsLogin = this.isAuthFailure(parsed);
      if (!hasBusinessCode && !needsLogin) return null;
      return {
        ...parsed,
        message: String((parsed.message ?? parsed.msg ?? this.describeApiFailure(parsed)) || "feeds3 business failure")
      };
    } catch {
      return null;
    }
  }
  extractFeeds3BusinessError(error) {
    if (error instanceof Feeds3BusinessError) return error.payload;
    if (error instanceof Error && "payload" in error) {
      const payload = error.payload;
      if (payload && typeof payload === "object") return payload;
    }
    return null;
  }
  requireLogin() {
    if (!this.loggedIn) throw new Error("\u672A\u767B\u5F55");
  }
  dumpDebugPayload(name, content) {
    if (!env.debugDump) return;
    const dir = path2.join(this.config.cachePath, "debug");
    if (!fs3.existsSync(dir)) fs3.mkdirSync(dir, { recursive: true });
    const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.TZ]/g, "").slice(0, 15);
    fs3.writeFileSync(path2.join(dir, `${name}_${ts}.txt`), content, "utf8");
  }
  ensureDiagnosticDir(category) {
    const dir = path2.join(this.config.cachePath, "diagnostics", category);
    fs3.mkdirSync(dir, { recursive: true });
    return dir;
  }
  createDiagnosticRef(category, payload, preferredId) {
    const createdAt = (/* @__PURE__ */ new Date()).toISOString();
    const suffix = Math.random().toString(36).slice(2, 8);
    const diagnosticId = preferredId ?? `${category}-${Date.now()}-${suffix}`;
    const dir = this.ensureDiagnosticDir(category);
    const filePath = path2.join(dir, `${diagnosticId}.json`);
    fs3.writeFileSync(filePath, JSON.stringify({ diagnostic_id: diagnosticId, created_at: createdAt, ...payload }, null, 2), "utf8");
    return {
      diagnostic_id: diagnosticId,
      category,
      path: filePath,
      created_at: createdAt
    };
  }
  sdkSuccess(data2, source, reliability, warnings = [], diagnostic) {
    return { ok: true, data: data2, source, reliability, warnings, diagnostic };
  }
  sdkFailure(kind, retryable, reliability, details, source, warnings = [], diagnostic) {
    return { ok: false, kind, retryable, reliability, details, source, warnings, diagnostic };
  }
  inferSdkSource(raw, fallback) {
    const source = String(raw ?? "").trim();
    if (source === "feeds3" || source === "feeds3_html" || source === "feeds3_html_more") return "feeds3_html";
    if (source === "feeds_html_act_all") return "act_all_html";
    if (source === "cache") return "cache";
    if (source === "derived") return "derived";
    return fallback;
  }
  classifySdkFailure(error, endpoint, uin, tid) {
    const payload = this.extractFeeds3BusinessError(error);
    if (payload) {
      const kind2 = this.getApiFailureKind(payload);
      return this.sdkFailure(
        kind2,
        kind2 === "rate_limit",
        endpoint.includes("Strict") ? "strict" : "best_effort",
        {
          endpoint,
          uin,
          tid,
          message: this.describeApiFailure(payload) || "feeds3 request failed"
        },
        "feeds3_html"
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    let kind = "network";
    let retryable = true;
    if (/login|auth|skey|p_skey|未登录/i.test(message)) {
      kind = "auth";
      retryable = false;
    } else if (/rate|频|too many|限流/i.test(message)) {
      kind = "rate_limit";
    } else if (/not support|unsupported|暂不支持/i.test(message)) {
      kind = "not_supported";
      retryable = false;
    } else if (/parse|bucket|html/i.test(message)) {
      kind = "parse_miss";
    }
    return this.sdkFailure(kind, retryable, endpoint.includes("Strict") ? "strict" : "best_effort", {
      endpoint,
      uin,
      tid,
      message
    });
  }
  buildPostIdentity(tid, fallbackUin = "") {
    const meta = this.postMetaCache.get(tid);
    return {
      canonicalTid: tid,
      uin: meta?.uin ?? fallbackUin,
      abstime: meta?.abstime,
      sourceFkey: meta?.sourceFkey,
      topicId: meta?.topicId,
      detailTid: meta?.detailTid,
      detailUrl: meta?.detailUrl,
      likeUnikey: meta?.likeUnikey,
      likeCurkey: meta?.likeCurkey
    };
  }
  // ──────────────────────────────────────────────
  // Login helpers
  // ──────────────────────────────────────────────
  async loginWithCookieString(cookieStr) {
    const parsed = {};
    for (const part of cookieStr.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      parsed[k] = v;
    }
    const required = ["uin", "p_skey", "skey", "p_uin"];
    if (!required.some((k) => k in parsed)) {
      throw new Error("Cookie \u5B57\u7B26\u4E32\u7F3A\u5C11\u5173\u952E\u5B57\u6BB5\uFF08uin/p_skey/skey/p_uin\uFF09");
    }
    this.jar = new CookieJar();
    this.http.defaults.jar = this.jar;
    this.cookies = {};
    for (const [k, v] of Object.entries(parsed)) {
      this.cookies[k] = v;
    }
    this._syncJarFromMap();
    let uin = parsed["uin"] ?? parsed["p_uin"] ?? "";
    if (/^[oO]/.test(uin)) uin = uin.slice(1);
    this.qqNumber = uin || null;
    if (!this.qqNumber) throw new Error("\u65E0\u6CD5\u4ECE Cookie \u4E2D\u89E3\u6790 QQ \u53F7");
    try {
      const resp = await this.get(`https://user.qzone.qq.com/${this.qqNumber}`);
      if (resp.status >= 400 && resp.status !== 501) {
        throw new Error(`Cookie \u767B\u5F55\u6821\u9A8C\u5931\u8D25\uFF0CHTTP ${resp.status}`);
      }
      if (resp.text.includes("ptlogin2.qq.com") && resp.text.toLowerCase().includes("login") && !resp.text.includes(this.qqNumber)) {
        log("WARNING", "Cookie \u53EF\u80FD\u5DF2\u8FC7\u671F\uFF0C\u4F46\u4ECD\u5C1D\u8BD5\u7EE7\u7EED");
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Cookie \u767B\u5F55\u6821\u9A8C\u5931\u8D25")) throw e;
      log("WARNING", `Cookie \u767B\u5F55\u6821\u9A8C\u8BF7\u6C42\u5931\u8D25: ${e}\uFF0C\u8DF3\u8FC7\u6821\u9A8C\u7EE7\u7EED`);
    }
    this.saveCookies();
    log("INFO", `Cookie \u767B\u5F55\u6210\u529F\uFF0CQQ\u53F7: ${this.qqNumber}`);
  }
  // 
  // Playwright QR login（真实浏览器扫码）
  // 
  async loginWithPlaywright(timeoutSeconds = 300, headless = false) {
    if (this.loggedIn) return;
    log("INFO", "Playwright QR \u767B\u5F55\uFF1A\u542F\u52A8\u6D4F\u89C8\u5668...");
    const pw = await launchPlaywright({ headless, throwOnMissing: true });
    const browser = pw.browser;
    try {
      const ctx = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        viewport: { width: 400, height: 320 }
      });
      const page = await ctx.newPage();
      const xloginUrl = "https://xui.ptlogin2.qq.com/cgi-bin/xlogin?appid=549000912&daid=5&style=40&target=self&s_url=https%3A%2F%2Fqzs.qzone.qq.com%2Fqzone%2Fv5%2Floginsucc.html%3Fpara%3Dizone&pt_3rd_aid=0&hide_title_bar=1&hide_border=1";
      await page.goto(xloginUrl, { waitUntil: "domcontentloaded", timeout: 3e4 });
      await page.waitForTimeout(3e3);
      const cacheDir = this.config.cachePath;
      if (!fs3.existsSync(cacheDir)) fs3.mkdirSync(cacheDir, { recursive: true });
      const absQrPath = path2.resolve(this.qrcodePath);
      await this._saveQrCode(page, absQrPath);
      if (headless) {
        log("INFO", `\u8BF7\u7528\u624B\u673A QQ \u626B\u63CF\u4E8C\u7EF4\u7801\u6587\u4EF6: ${absQrPath}`);
        log("INFO", "\u626B\u7801\u540E\u8BF7\u5728\u624B\u673A\u4E0A\u786E\u8BA4\u767B\u5F55\uFF0C\u7B49\u5F85\u81EA\u52A8\u8DF3\u8F6C");
      } else {
        log("INFO", `\u6D4F\u89C8\u5668\u5DF2\u6253\u5F00\uFF0C\u8BF7\u7528\u624B\u673A QQ \u626B\u63CF\u5C4F\u5E55\u4E0A\u7684\u4E8C\u7EF4\u7801\uFF08\u6587\u4EF6: ${absQrPath}\uFF09`);
      }
      const deadline = Date.now() + timeoutSeconds * 1e3;
      let loggedIn = false;
      while (Date.now() < deadline) {
        const currentUrl = page.url();
        let parsedHost = "";
        let parsedPath = "";
        try {
          const u = new URL2(currentUrl);
          parsedHost = u.hostname;
          parsedPath = u.pathname;
        } catch {
        }
        log("DEBUG", `Playwright \u5F53\u524D: ${parsedHost}${parsedPath}`);
        if (parsedPath.includes("loginsucc")) {
          log("INFO", "\u68C0\u6D4B\u5230 loginsucc \u9875\u9762\uFF0C\u7B49\u5F85 Cookie \u5B8C\u5168\u79CD\u5165...");
          await page.waitForTimeout(3e3);
          try {
            await page.goto("https://user.qzone.qq.com/", {
              waitUntil: "domcontentloaded",
              timeout: 15e3
            });
          } catch {
          }
          await page.waitForTimeout(2e3);
          loggedIn = true;
          break;
        }
        if (parsedHost.includes("user.qzone.qq.com") && !parsedHost.includes("ptlogin2")) {
          log("INFO", "\u5DF2\u5230\u8FBE QZone \u4E3B\u9875");
          await page.waitForTimeout(3e3);
          loggedIn = true;
          break;
        }
        await page.waitForTimeout(2e3);
      }
      if (!loggedIn) {
        throw new Error(`Playwright \u626B\u7801\u767B\u5F55\u8D85\u65F6\uFF08${timeoutSeconds} \u79D2\uFF09`);
      }
      log("INFO", "\u626B\u7801\u6210\u529F\uFF0C\u6B63\u5728\u63D0\u53D6 Cookie...");
      const browserCookies = await ctx.cookies([
        "https://qq.com",
        "https://qzone.qq.com",
        "https://user.qzone.qq.com",
        "https://qzs.qzone.qq.com",
        "https://ptlogin2.qq.com",
        "https://ssl.ptlogin2.qq.com"
      ]);
      log("DEBUG", `\u63D0\u53D6\u5230 ${browserCookies.length} \u4E2A Cookie: ${browserCookies.map((c) => c.name).join(", ")}`);
      this.jar = new CookieJar();
      this.http.defaults.jar = this.jar;
      this.cookies = {};
      for (const c of browserCookies) {
        this.cookies[c.name] = c.value;
      }
      this._syncJarFromMap();
      const rawUin = this.cookies["uin"] ?? "";
      this.qqNumber = rawUin.replace(/^[oO]/, "") || null;
      if (!this.qqNumber) {
        const pUin = this.cookies["p_uin"] ?? "";
        this.qqNumber = pUin.replace(/^[oO]/, "") || null;
      }
      if (!this.qqNumber) throw new Error("\u767B\u5F55\u6210\u529F\u4F46\u672A\u83B7\u53D6\u5230 QQ \u53F7");
      this.saveCookies();
      try {
        fs3.unlinkSync(absQrPath);
      } catch {
      }
      log("INFO", `Playwright QR \u767B\u5F55\u6210\u529F\uFF0CQQ\u53F7: ${this.qqNumber}`);
      await ctx.close();
    } finally {
      await browser.close();
    }
  }
  logout() {
    this.qqNumber = null;
    void this.closePlaywrightFeedSession();
    this.deleteCookies();
  }
  /**
   * 保存 QR 码到文件。优先提取 img.src 直接下载（绕过截图字体渲染问题），
   * 失败则尝试元素截图，最后回退到整页截图。
   */
  async _saveQrCode(page, absQrPath) {
    const selectors = '#qrlogin_img, img[src*="ptqrshow"]';
    try {
      const qrImg = page.locator(selectors).first();
      await qrImg.waitFor({ state: "visible", timeout: 15e3 });
      const src = await qrImg.getAttribute("src", { timeout: 5e3 });
      if (src && (src.startsWith("http") || src.startsWith("//"))) {
        const imgUrl = src.startsWith("//") ? `https:${src}` : src;
        const resp = await fetch(imgUrl, { signal: AbortSignal.timeout(1e4) });
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          fs3.writeFileSync(absQrPath, buf);
          log("INFO", `QR \u7801\u5DF2\u4FDD\u5B58\u5230: ${absQrPath}\uFF08\u76F4\u63A5\u4E0B\u8F7D\uFF09`);
          return;
        }
      }
    } catch {
    }
    try {
      const qrImg = page.locator(selectors).first();
      const isVisible = await qrImg.isVisible().catch(() => false);
      if (isVisible) {
        await qrImg.screenshot({ path: absQrPath, timeout: 1e4 });
        log("INFO", `QR \u7801\u5DF2\u4FDD\u5B58\u5230: ${absQrPath}\uFF08\u5143\u7D20\u622A\u56FE\uFF09`);
        return;
      }
    } catch {
    }
    try {
      await page.screenshot({ path: absQrPath, timeout: 15e3 });
      log("INFO", `QR \u7801\u622A\u56FE\u5DF2\u4FDD\u5B58\u5230: ${absQrPath}\uFF08\u6574\u9875\u622A\u56FE\uFF09`);
    } catch {
      log("WARNING", `QR \u7801\u622A\u56FE\u5168\u90E8\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u8BBF\u95EE\u7F13\u5B58\u76EE\u5F55: ${path2.dirname(absQrPath)}`);
    }
  }
  // ──────────────────────────────────────────────
  // 静默会话续期（Playwright headless，无需扫码）
  // ──────────────────────────────────────────────
  lastRefreshTime = 0;
  /**
   * 使用 headless Playwright 静默刷新 Cookie。
   * 注入当前 Cookie → 打开 QZone 页面 → 提取刷新后的 Cookie。
   * 不弹出登录窗口，不需要扫码。
   * @returns true=刷新成功 / false=刷新失败（Cookie 可能已过期）
   */
  async refreshSession() {
    if (!this.loggedIn || !this.qqNumber) return false;
    log("INFO", "\u9759\u9ED8\u5237\u65B0 Cookie\uFF08headless Playwright\uFF09...");
    const pw = await launchPlaywright();
    if (!pw) {
      log("WARNING", "refreshSession: Playwright \u672A\u5B89\u88C5\uFF0C\u8DF3\u8FC7\u9759\u9ED8\u7EED\u671F");
      return false;
    }
    let browser = pw.browser;
    try {
      const ctx = await browser.newContext({
        userAgent: _QzoneClient.UA,
        viewport: { width: 1280, height: 800 }
      });
      const cookieArray = [];
      for (const [name, value] of Object.entries(this.cookies)) {
        for (const domain of [".qq.com", ".qzone.qq.com", ".ptlogin2.qq.com"]) {
          cookieArray.push({ name, value, domain, path: "/" });
        }
      }
      await ctx.addCookies(cookieArray);
      const page = await ctx.newPage();
      await page.goto(`https://user.qzone.qq.com/${this.qqNumber}`, {
        waitUntil: "domcontentloaded",
        timeout: 2e4
      });
      await page.waitForTimeout(3e3);
      try {
        await page.goto(`https://user.qzone.qq.com/${this.qqNumber}/311`, {
          waitUntil: "domcontentloaded",
          timeout: 15e3
        });
        await page.waitForTimeout(2e3);
      } catch {
      }
      const currentUrl = page.url();
      if (currentUrl.includes("ptlogin2.qq.com") || currentUrl.includes("xui.ptlogin2")) {
        log("WARNING", "refreshSession: \u88AB\u91CD\u5B9A\u5411\u5230\u767B\u5F55\u9875\uFF0CCookie \u5DF2\u771F\u6B63\u8FC7\u671F");
        await ctx.close();
        await browser.close();
        return false;
      }
      const browserCookies = await ctx.cookies([
        "https://qq.com",
        "https://qzone.qq.com",
        "https://user.qzone.qq.com",
        "https://qzs.qzone.qq.com",
        "https://ptlogin2.qq.com",
        "https://ssl.ptlogin2.qq.com"
      ]);
      let updated = 0;
      for (const c of browserCookies) {
        if (c.value && c.value !== this.cookies[c.name]) {
          updated++;
        }
        if (c.value) this.cookies[c.name] = c.value;
      }
      await ctx.close();
      await browser.close();
      browser = null;
      this.jar = new CookieJar();
      this.http.defaults.jar = this.jar;
      this._syncJarFromMap();
      this.saveCookies();
      this.lastRefreshTime = Date.now();
      this.resetApiCaches();
      const hasPskey = !!this.cookies["p_skey"];
      const hasSkey = !!this.cookies["skey"];
      log("INFO", `\u9759\u9ED8\u7EED\u671F\u5B8C\u6210: ${updated} cookie(s) \u66F4\u65B0, p_skey=${hasPskey ? "\u2713" : "\u2717"}, skey=${hasSkey ? "\u2713" : "\u2717"}`);
      if (hasPskey && hasSkey) {
        this.syncCookieToEnvFile();
      } else {
        log("WARNING", "refreshSession: p_skey \u7F3A\u5931\uFF0C\u4E0D\u8986\u76D6 .env\uFF08\u907F\u514D\u4E22\u5931\u7528\u6237\u63D0\u4F9B\u7684 cookie\uFF09");
      }
      return hasPskey && hasSkey;
    } catch (exc) {
      log("WARNING", `refreshSession \u5931\u8D25: ${exc}`);
      if (browser) try {
        await browser.close();
      } catch {
      }
      return false;
    }
  }
  /** 距上次静默刷新的秒数 */
  get secondsSinceLastRefresh() {
    if (!this.lastRefreshTime) return Infinity;
    return (Date.now() - this.lastRefreshTime) / 1e3;
  }
  resetApiCaches() {
    this.qzonetokenCache = null;
    this.qzonetokenCacheTime = 0;
    this.qzonetokenFailTime = 0;
    this.playwrightFailTime = 0;
    this.detailWinningVariant = null;
    this.detailAllFailTime = 0;
    this.feeds3Cache.clear();
    this.feeds3CacheTime.clear();
    this.feeds3Comments.clear();
    this.feeds3CommentsFetchedAt.clear();
    this.feeds3Likes.clear();
    this.playwrightFeedPosts.clear();
    this.playwrightFeedDomFallbackUsed = false;
    this.playwrightFeedNetworkIntercepted = false;
    this.playwrightFeedInterceptedResponseCount = 0;
  }
  async closePlaywrightFeedSession() {
    this.playwrightFeedListenerAttached = false;
    this.playwrightFeedPendingParses.clear();
    this.playwrightFeedPosts.clear();
    const context = this.playwrightFeedContext;
    const browser = this.playwrightFeedBrowser;
    this.playwrightFeedPage = null;
    this.playwrightFeedContext = null;
    this.playwrightFeedBrowser = null;
    if (context) {
      try {
        await context.close();
      } catch {
      }
    } else if (browser) {
      try {
        await browser.close();
      } catch {
      }
    }
  }
  async closeTransientSessions() {
    await this.closePlaywrightFeedSession();
  }
  buildPlaywrightCookies() {
    const cookieArray = [];
    for (const [name, value] of Object.entries(this.cookies)) {
      for (const domain of [".qq.com", ".qzone.qq.com", ".ptlogin2.qq.com"]) {
        cookieArray.push({ name, value, domain, path: "/" });
      }
    }
    return cookieArray;
  }
  async syncCookiesFromPlaywrightContext() {
    if (!this.playwrightFeedContext) return;
    const browserCookies = await this.playwrightFeedContext.cookies([
      "https://qq.com",
      "https://qzone.qq.com",
      "https://user.qzone.qq.com",
      "https://qzs.qzone.qq.com",
      "https://ptlogin2.qq.com",
      "https://ssl.ptlogin2.qq.com"
    ]);
    let updated = false;
    for (const cookie of browserCookies) {
      if (!cookie.value) continue;
      if (this.cookies[cookie.name] !== cookie.value) updated = true;
      this.cookies[cookie.name] = cookie.value;
    }
    if (updated) {
      this.jar = new CookieJar();
      this.http.defaults.jar = this.jar;
      this._syncJarFromMap();
      this.saveCookies();
    }
  }
  isUsefulPlaywrightFeedItem(item) {
    const tid = String(item["tid"] ?? item["cellid"] ?? "").trim();
    const uin = String(item["uin"] ?? item["opuin"] ?? "").trim();
    if (!tid || !uin) return false;
    const appid = Number(item["appid"] ?? 0);
    return appid !== 217;
  }
  playwrightFeedCompleteness(item) {
    let score = 0;
    if (String(item["tid"] ?? item["cellid"] ?? "").trim()) score += 4;
    if (String(item["uin"] ?? item["opuin"] ?? "").trim()) score += 4;
    if (String(item["likeUnikey"] ?? "").trim()) score += 4;
    if (String(item["likeCurkey"] ?? "").trim()) score += 4;
    if (String(item["detailUrl"] ?? item["detailurl"] ?? "").trim()) score += 2;
    if (String(item["nickname"] ?? item["name"] ?? "").trim()) score += 1;
    if (Number(item["created_time"] ?? item["createTime"] ?? 0) > 0) score += 1;
    if (Boolean(item["_networkSource"])) score += 3;
    return score;
  }
  mergePlaywrightFeedItem(item) {
    if (!this.isUsefulPlaywrightFeedItem(item)) return;
    const tid = String(item["tid"] ?? item["cellid"] ?? "").trim();
    const uin = String(item["uin"] ?? item["opuin"] ?? "").trim();
    const key = `${uin}:${tid}`;
    const normalized = {
      ...item,
      uin,
      tid,
      _source: "playwright_feed"
    };
    if (!normalized["detailUrl"] && normalized["detailurl"]) normalized["detailUrl"] = normalized["detailurl"];
    if (!normalized["created_time"] && Number(normalized["abstime"] ?? 0) > 0) {
      normalized["created_time"] = Number(normalized["abstime"]);
    }
    const current = this.playwrightFeedPosts.get(key);
    if (!current || this.playwrightFeedCompleteness(normalized) >= this.playwrightFeedCompleteness(current)) {
      this.playwrightFeedPosts.set(key, normalized);
    }
    this.cachePostMetaFromRaw(normalized);
  }
  async attachPlaywrightFeedListeners(page) {
    if (this.playwrightFeedListenerAttached) return;
    this.playwrightFeedListenerAttached = true;
    page.on("response", (response) => {
      const work = (async () => {
        try {
          const url = String(response.url?.() ?? response.url ?? "");
          if (!/feeds3_html_more|feeds_html_act_all/i.test(url)) return;
          const text = await response.text();
          const items = this.parseFeeds3Items(text, void 0, void 0, 120, false);
          let usefulCount = 0;
          for (const item of items) {
            if (!this.isUsefulPlaywrightFeedItem(item)) continue;
            usefulCount += 1;
            this.mergePlaywrightFeedItem({ ...item, _networkSource: true });
          }
          if (usefulCount > 0) {
            this.playwrightFeedNetworkIntercepted = true;
            this.playwrightFeedInterceptedResponseCount += 1;
            this.mergeFeeds3AncillaryFromHtml(text, Math.floor(Date.now() / 1e3), "playwright_feed");
            const friends = this.extractFriendsFromFeeds3FromText(text);
            if (friends.length) this.mergeFriendCache(friends);
          }
        } catch {
        }
      })();
      this.playwrightFeedPendingParses.add(work);
      void work.finally(() => {
        this.playwrightFeedPendingParses.delete(work);
      });
    });
  }
  async ensurePlaywrightFeedSession() {
    if (!env.instantLikePlaywright || !this.qqNumber) return null;
    if (this.playwrightFeedPage && !this.playwrightFeedPage.isClosed?.()) return this.playwrightFeedPage;
    const headless = env.playwrightHeadless ?? true;
    const pw = await launchPlaywright({ headless, throwOnMissing: false });
    if (!pw) return null;
    this.playwrightFeedBrowser = pw.browser;
    this.playwrightFeedContext = await pw.browser.newContext({
      userAgent: _QzoneClient.UA,
      viewport: { width: 1280, height: 800 }
    });
    await this.playwrightFeedContext.addCookies(this.buildPlaywrightCookies());
    this.playwrightFeedPage = await this.playwrightFeedContext.newPage();
    await this.attachPlaywrightFeedListeners(this.playwrightFeedPage);
    return this.playwrightFeedPage;
  }
  async getPlaywrightFriendFeedSnapshot(limit = 20) {
    this.requireLogin();
    const page = await this.ensurePlaywrightFeedSession();
    if (!page || !this.qqNumber) {
      return {
        posts: [],
        networkIntercepted: false,
        domFallbackUsed: false,
        interceptedResponseCount: 0,
        pageUrl: ""
      };
    }
    this.playwrightFeedPosts.clear();
    this.playwrightFeedDomFallbackUsed = false;
    this.playwrightFeedNetworkIntercepted = false;
    this.playwrightFeedInterceptedResponseCount = 0;
    await page.goto(`https://user.qzone.qq.com/${this.qqNumber}`, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(15e3, env.playwrightTimeoutMs)
    });
    await page.waitForTimeout(3500);
    if (this.playwrightFeedPendingParses.size > 0) {
      await Promise.allSettled([...this.playwrightFeedPendingParses]);
    }
    if (this.playwrightFeedPosts.size === 0) {
      const domItems = await page.evaluate(() => {
        const out = [];
        const doc = globalThis.document;
        const buttons = Array.from(doc?.querySelectorAll?.("[data-islike]") ?? []);
        for (const rawButton of buttons) {
          const element = rawButton;
          let container = element;
          while (container && !container?.hasAttribute?.("data-tid")) {
            container = container.parentElement;
          }
          const likeUnikey = element.getAttribute("data-unikey") ?? "";
          const likeCurkey = element.getAttribute("data-curkey") ?? "";
          const detailUrl = element.getAttribute("data-detailurl") ?? "";
          const match = (likeUnikey || detailUrl).match(/user\.qzone\.qq\.com\/(\d+)\/mood\/([^/?#]+)/i);
          const moodUin = match?.[1] ?? "";
          const moodTid = match?.[2] ?? "";
          const tid = container?.getAttribute?.("data-tid") ?? moodTid;
          const uin = container?.getAttribute?.("data-uin") ?? container?.getAttribute?.("data-opuin") ?? moodUin;
          if (!tid || !uin) continue;
          const appid = container?.getAttribute?.("data-appid") ?? element.getAttribute("data-appid") ?? "";
          const typeid = container?.getAttribute?.("data-typeid") ?? element.getAttribute("data-typeid") ?? "";
          const created = container?.getAttribute?.("data-abstime") ?? container?.getAttribute?.("data-created") ?? "";
          const nickNode = container?.querySelector?.('.f-nick,[data-clicklog*="nick"],.ui-mr8,.f-name');
          out.push({
            tid,
            uin,
            appid,
            typeid,
            created_time: created ? Number(created) : 0,
            nickname: (nickNode?.textContent ?? "").trim(),
            isLiked: element.getAttribute("data-islike") === "1",
            likeUnikey,
            likeCurkey,
            detailUrl,
            _domSource: true
          });
        }
        return out;
      });
      if (domItems.length > 0) {
        this.playwrightFeedDomFallbackUsed = true;
        for (const item of domItems) this.mergePlaywrightFeedItem(item);
      }
    }
    await this.syncCookiesFromPlaywrightContext();
    const posts = [...this.playwrightFeedPosts.values()].sort((left, right) => Number(right["created_time"] ?? 0) - Number(left["created_time"] ?? 0)).slice(0, Math.max(1, limit));
    return {
      posts,
      networkIntercepted: this.playwrightFeedNetworkIntercepted,
      domFallbackUsed: this.playwrightFeedDomFallbackUsed,
      interceptedResponseCount: this.playwrightFeedInterceptedResponseCount,
      pageUrl: String(page.url?.() ?? "")
    };
  }
  async likeWithPlaywrightContext(item) {
    const page = this.playwrightFeedPage;
    if (!page || !this.qqNumber) return null;
    const tid = String(item["tid"] ?? item["cellid"] ?? "").trim();
    const uin = String(item["uin"] ?? item["opuin"] ?? "").trim();
    if (!tid || !uin) return null;
    const targetLikeUnikey = String(item["likeUnikey"] ?? "").trim();
    const targetLikeCurkey = String(item["likeCurkey"] ?? "").trim();
    const targetDetailUrl = String(item["detailUrl"] ?? item["detailurl"] ?? "").trim();
    const clickResult = await page.evaluate(({
      innerTid,
      innerLikeUnikey,
      innerLikeCurkey,
      innerDetailUrl
    }) => {
      const doc = globalThis.document;
      const buttons = Array.from(doc?.querySelectorAll?.("[data-islike]") ?? []);
      for (const rawButton of buttons) {
        const button = rawButton;
        const unikey2 = button.getAttribute("data-unikey") ?? "";
        const curkey2 = button.getAttribute("data-curkey") ?? "";
        const detailUrl = button.getAttribute("data-detailurl") ?? "";
        const containerTid = button.closest("[data-tid]")?.getAttribute("data-tid") ?? "";
        const matched = innerLikeUnikey && unikey2 === innerLikeUnikey || innerLikeCurkey && curkey2 === innerLikeCurkey || innerDetailUrl && detailUrl === innerDetailUrl || (unikey2.includes(`mood/${innerTid}`) || curkey2.includes(innerTid) || detailUrl.includes(innerTid) || containerTid === innerTid);
        if (!matched) continue;
        const before = button.getAttribute("data-islike") ?? "";
        if (before !== "0") {
          return { clicked: false, alreadyLiked: before === "1" };
        }
        button.click();
        return { clicked: true, alreadyLiked: false };
      }
      return { clicked: false, alreadyLiked: false };
    }, {
      innerTid: tid,
      innerLikeUnikey: targetLikeUnikey,
      innerLikeCurkey: targetLikeCurkey,
      innerDetailUrl: targetDetailUrl
    });
    if (clickResult.alreadyLiked) return { code: 0, message: "playwright already liked", _playwrightClick: true };
    if (clickResult.clicked) {
      try {
        await page.waitForFunction(({
          innerTid,
          innerLikeUnikey,
          innerLikeCurkey,
          innerDetailUrl
        }) => {
          const doc = globalThis.document;
          const buttons = Array.from(doc?.querySelectorAll?.("[data-islike]") ?? []);
          for (const rawButton of buttons) {
            const button = rawButton;
            const unikey2 = button.getAttribute("data-unikey") ?? "";
            const curkey2 = button.getAttribute("data-curkey") ?? "";
            const detailUrl = button.getAttribute("data-detailurl") ?? "";
            const containerTid = button.closest("[data-tid]")?.getAttribute("data-tid") ?? "";
            const matched = innerLikeUnikey && unikey2 === innerLikeUnikey || innerLikeCurkey && curkey2 === innerLikeCurkey || innerDetailUrl && detailUrl === innerDetailUrl || (unikey2.includes(`mood/${innerTid}`) || curkey2.includes(innerTid) || detailUrl.includes(innerTid) || containerTid === innerTid);
            if (matched) return button.getAttribute("data-islike") === "1";
          }
          return false;
        }, {
          innerTid: tid,
          innerLikeUnikey: targetLikeUnikey,
          innerLikeCurkey: targetLikeCurkey,
          innerDetailUrl: targetDetailUrl
        }, { timeout: 2500 });
        await this.syncCookiesFromPlaywrightContext();
        return { code: 0, message: "playwright click ok", _playwrightClick: true };
      } catch {
      }
    }
    const appid = Number(item["appid"] ?? 311);
    const typeid = Number(item["typeid"] ?? 0);
    const abstime = Number(item["created_time"] ?? item["createTime"] ?? Math.floor(Date.now() / 1e3));
    const unikey = String(item["likeUnikey"] ?? `http://user.qzone.qq.com/${uin}/mood/${tid}`);
    const curkey = String(item["likeCurkey"] ?? unikey);
    const gtk = this.getGtk();
    const payload = await page.evaluate(async ({
      selfUin,
      innerUin,
      innerTid,
      appid: innerAppid,
      typeid: innerTypeid,
      abstime: innerAbstime,
      unikey: innerUnikey,
      curkey: innerCurkey,
      gtk: innerGtk
    }) => {
      const qzreferrer = `https://user.qzone.qq.com/${selfUin}/main`;
      try {
        const firstResponse = await fetch(
          `https://user.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?g_tk=${innerGtk}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
            body: new URLSearchParams({
              qzreferrer,
              opuin: selfUin,
              unikey: innerUnikey,
              curkey: innerCurkey,
              appid: String(innerAppid),
              typeid: String(innerTypeid),
              fid: innerTid,
              from: "1",
              active: "0",
              fupdate: "1",
              abstime: String(innerAbstime),
              format: "json"
            }).toString(),
            credentials: "include"
          }
        );
        const first = await firstResponse.json();
        if (Number(first["code"] ?? first["ret"] ?? -1) === 0) return first;
        const secondResponse = await fetch(
          `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/like_cgi_likev6?g_tk=${innerGtk}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
            body: new URLSearchParams({
              opuin: selfUin,
              ouin: innerUin,
              fid: innerTid,
              abstime: String(innerAbstime),
              appid: String(innerAppid),
              typeid: String(innerTypeid),
              key: "",
              format: "json",
              qzreferrer
            }).toString(),
            credentials: "include"
          }
        );
        const second = await secondResponse.json();
        if (Number(second["code"] ?? second["ret"] ?? -1) === 0) return second;
        const thirdResponse = await fetch(
          `https://mobile.qzone.qq.com/like?g_tk=${innerGtk}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
            body: new URLSearchParams({
              unikey: innerUnikey,
              curkey: innerUnikey,
              appid: String(innerAppid),
              typeid: String(innerTypeid),
              active: "0",
              fupdate: "1"
            }).toString(),
            credentials: "include"
          }
        );
        const third = await thirdResponse.json();
        return third;
      } catch (error) {
        return {
          code: -1,
          message: error instanceof Error ? error.message : String(error)
        };
      }
    }, { selfUin: this.qqNumber, innerUin: uin, innerTid: tid, appid, typeid, abstime, unikey, curkey, gtk });
    if (Number(payload["code"] ?? payload["ret"] ?? -1) === 0) {
      await page.waitForTimeout(700).catch(() => {
      });
      await this.syncCookiesFromPlaywrightContext();
    }
    return payload;
  }
  async verifyLikeInPlaywrightContext(item) {
    const page = this.playwrightFeedPage;
    if (!page) return false;
    const tid = String(item["tid"] ?? item["cellid"] ?? "").trim();
    if (!tid) return false;
    const targetLikeUnikey = String(item["likeUnikey"] ?? "").trim();
    const targetLikeCurkey = String(item["likeCurkey"] ?? "").trim();
    const targetDetailUrl = String(item["detailUrl"] ?? item["detailurl"] ?? "").trim();
    try {
      return await page.evaluate(({
        innerTid,
        innerLikeUnikey,
        innerLikeCurkey,
        innerDetailUrl
      }) => {
        const doc = globalThis.document;
        const buttons = Array.from(doc?.querySelectorAll?.("[data-islike]") ?? []);
        for (const rawButton of buttons) {
          const button = rawButton;
          const unikey = button.getAttribute("data-unikey") ?? "";
          const curkey = button.getAttribute("data-curkey") ?? "";
          const detailUrl = button.getAttribute("data-detailurl") ?? "";
          const containerTid = button.closest("[data-tid]")?.getAttribute("data-tid") ?? "";
          const matched = innerLikeUnikey && unikey === innerLikeUnikey || innerLikeCurkey && curkey === innerLikeCurkey || innerDetailUrl && detailUrl === innerDetailUrl || (unikey.includes(`mood/${innerTid}`) || curkey.includes(innerTid) || detailUrl.includes(innerTid) || containerTid === innerTid);
          if (matched) {
            return button.getAttribute("data-islike") === "1";
          }
        }
        return false;
      }, {
        innerTid: tid,
        innerLikeUnikey: targetLikeUnikey,
        innerLikeCurkey: targetLikeCurkey,
        innerDetailUrl: targetDetailUrl
      });
    } catch {
      return false;
    }
  }
  // ──────────────────────────────────────────────
  // Session validation
  // ──────────────────────────────────────────────
  /**
   * 校验当前 Cookie 是否仍然有效。
   * 依次尝试多种轻量探针，任一成功即认为有效。
   * 逻辑：快速探针 → 中量探针 → 重量级探针，early-return。
   */
  async validateSession(force = false) {
    if (!this.qqNumber) return false;
    if (!force && this.cookiesLastUsed) {
      const ageMs = Date.now() - this.cookiesLastUsed.getTime();
      if (ageMs < 5 * 60 * 1e3) {
        log("DEBUG", `validateSession: cookies fresh (${Math.round(ageMs / 1e3)}s ago), skip probe`);
        return true;
      }
    }
    try {
      const feeds3Url = `https://user.qzone.qq.com/${this.qqNumber}/311`;
      const resp = await this.get(feeds3Url, { headers: this.pcHeaders() });
      if (resp.status === 200 && resp.text.length > 5e3 && !resp.text.includes("ptlogin2.qq.com") && resp.text.includes(this.qqNumber)) {
        log("DEBUG", "validateSession: feeds3 page OK");
        return true;
      }
    } catch {
    }
    try {
      const res = await this.getVisitorList(this.qqNumber);
      if (res && !res["_empty"] && res["code"] !== -3e3) {
        log("DEBUG", "validateSession: visitor list OK");
        return true;
      }
    } catch {
    }
    try {
      const token2 = await this.getQzonetoken();
      if (token2) {
        log("DEBUG", "validateSession: qzonetoken OK");
        return true;
      }
    } catch {
    }
    log("WARNING", "validateSession: all probes failed");
    return false;
  }
  // ──────────────────────────────────────────────
  // Playwright: 浏览器内获取说说列表（绕过 API 限流）
  // ──────────────────────────────────────────────
  /**
   * 使用 Playwright 打开用户说说页面，拦截 emotion_cgi_msglist_v6 的 XHR 响应。
   * 浏览器内请求不受 IP 级限流影响。
   */
  async getEmotionListViaPlaywright(targetUin, pos = 0, num = 20, timeout = 3e4) {
    const now2 = Date.now() / 1e3;
    if (now2 - this.playwrightFailTime < this.playwrightCooldown) return null;
    const pw = await launchPlaywright();
    if (!pw) return null;
    log("INFO", "Playwright fetching emotion list...");
    let browser = pw.browser;
    try {
      const ctx = await browser.newContext({
        userAgent: _QzoneClient.UA,
        viewport: { width: 1280, height: 800 }
      });
      const cookieArray = [];
      for (const [name, value] of Object.entries(this.cookies)) {
        for (const domain of [".qq.com", ".qzone.qq.com"]) {
          cookieArray.push({ name, value, domain, path: "/" });
        }
      }
      await ctx.addCookies(cookieArray);
      const page = await ctx.newPage();
      let apiResult = null;
      page.on("response", async (response) => {
        const url = response.url();
        if (url.includes("emotion_cgi_msglist_v6") && !apiResult) {
          try {
            const text = await response.text();
            const parsed = parseJsonp(text);
            if (parsed && typeof parsed === "object" && parsed.code === 0) {
              apiResult = parsed;
              log("INFO", `Playwright \u62E6\u622A\u5230 emotion_cgi_msglist_v6 \u6210\u529F\u54CD\u5E94`);
            } else {
              log("DEBUG", `Playwright emotion_cgi_msglist_v6 code=${parsed?.code}`);
            }
          } catch (e) {
            log("DEBUG", `Playwright response parse error: ${e}`);
          }
        }
      });
      const shuoshuoUrl = `https://user.qzone.qq.com/${targetUin}/311`;
      await page.goto(shuoshuoUrl, { waitUntil: "domcontentloaded", timeout });
      await page.waitForTimeout(3e3);
      const deadline = Date.now() + 1e4;
      while (!apiResult && Date.now() < deadline) {
        await page.waitForTimeout(500);
      }
      await ctx.close();
      await browser.close();
      browser = null;
      if (apiResult) {
        log("INFO", `Playwright \u6210\u529F\u83B7\u53D6\u8BF4\u8BF4\u5217\u8868`);
        return apiResult;
      } else {
        log("WARNING", "Playwright \u672A\u62E6\u622A\u5230\u6709\u6548 API \u54CD\u5E94");
        this.playwrightFailTime = Date.now() / 1e3;
        return null;
      }
    } catch (exc) {
      log("WARNING", `Playwright \u83B7\u53D6\u8BF4\u8BF4\u5931\u8D25: ${exc}`);
      this.playwrightFailTime = Date.now() / 1e3;
      if (browser) try {
        await browser.close();
      } catch {
      }
      return null;
    }
  }
  // ──────────────────────────────────────────────
  // qzonetoken
  // ──────────────────────────────────────────────
  async getQzonetoken() {
    this.requireLogin();
    const now2 = Date.now() / 1e3;
    if (this.qzonetokenCache && now2 - this.qzonetokenCacheTime < this.qzonetokenTtl) {
      return this.qzonetokenCache;
    }
    if (now2 - this.qzonetokenFailTime < this.qzonetokenFailTtl) {
      return null;
    }
    const appendParams = (url, params) => {
      const u = new URL2(url);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      return u.toString();
    };
    const urls = [
      "https://qzs.qzone.qq.com/qzone/v5/loginsucc.html?para=izone",
      "https://qzs.qzone.qq.com/qzone/v5/loginsucc.html",
      `https://user.qzone.qq.com/${this.qqNumber}`,
      `https://user.qzone.qq.com/${this.qqNumber}/main`
    ];
    const patterns = [
      /g_qzonetoken\s*=\s*\(function\(\)\{[\s\S]*?return\s*['"]([^'"]+)['"]/,
      /g_qzonetoken\s*=\s*['"]([^'"]+)['"]/,
      /"g_qzonetoken"\s*:\s*"([^"]+)"/,
      /qzonetoken"\s*:\s*"([^"]+)"/,
      /[?&]qzonetoken=([A-Za-z0-9]+)/
    ];
    const iframePattern = /id="QM_Feeds_Iframe"[^>]*?src="([^"]+)"/i;
    for (const url of urls) {
      try {
        const resp = await this.get(url, { headers: this.pcHeaders() });
        const html = resp.text;
        for (const pat of patterns) {
          const m = html.match(pat);
          if (m?.[1]) {
            const token2 = m[1].trim();
            if (token2) {
              this.qzonetokenCache = token2;
              this.qzonetokenCacheTime = Date.now() / 1e3;
              return token2;
            }
          }
        }
        const iframeMatch = html.match(iframePattern);
        if (iframeMatch) {
          let iframeSrc = htmlUnescape(iframeMatch[1]);
          if (iframeSrc.startsWith("//")) iframeSrc = "https:" + iframeSrc;
          iframeSrc = appendParams(iframeSrc, { g_tk: String(this.getGtk()) });
          try {
            const iResp = await this.get(iframeSrc, {
              headers: this.pcHeaders(`https://user.qzone.qq.com/${this.qqNumber}/main`)
            });
            for (const pat of patterns) {
              const m = iResp.text.match(pat);
              if (m?.[1]) {
                const token2 = m[1].trim();
                if (token2) {
                  this.qzonetokenCache = token2;
                  this.qzonetokenCacheTime = Date.now() / 1e3;
                  return token2;
                }
              }
            }
          } catch {
          }
        }
      } catch {
      }
    }
    this.qzonetokenFailTime = Date.now() / 1e3;
    log("DEBUG", `qzonetoken HTTP \u63D0\u53D6\u5931\u8D25\uFF0C${this.qzonetokenFailTtl}s \u5185\u4E0D\u518D\u91CD\u8BD5\uFF08\u4E0D\u89E6\u53D1\u6D4F\u89C8\u5668\uFF09`);
    return null;
  }
  async getQzonetokenPlaywright() {
    const { Worker } = await import("node:worker_threads");
    const timeoutMs = env.playwrightTimeoutMs;
    const channel = env.playwrightChannel;
    const executable = env.playwrightExecutable;
    const targetUrl = `https://user.qzone.qq.com/${this.qqNumber}/main`;
    const cookies = Object.entries(this.cookies).map(([name, value]) => ({
      name,
      value,
      domain: ".qq.com",
      path: "/"
    }));
    const workerCode = `
      const { workerData, parentPort } = require('worker_threads');
      const { execSync } = require('child_process');
      async function run() {
        try {
          const { chromium } = require('playwright');
          const launchOpts = { headless: true };
          if (workerData.executable) launchOpts.executablePath = workerData.executable;
          else if (workerData.channel) launchOpts.channel = workerData.channel;
          const browser = await chromium.launch(launchOpts);
          const ctx = await browser.newContext();
          await ctx.addCookies(workerData.cookies);
          const page = await ctx.newPage();
          await page.goto(workerData.targetUrl, { waitUntil: 'domcontentloaded', timeout: workerData.timeoutMs });
          await new Promise(r => setTimeout(r, 3000));
          const token = await page.evaluate(() => {
            try {
              if (window.g_qzonetoken) {
                const g = window.g_qzonetoken;
                if (typeof g === 'function') return g();
                if (typeof g === 'string') return g;
              }
              const html = document.documentElement.innerHTML;
              const m = html.match(/g_qzonetoken\\s*=\\s*(?:function\\(\\)\\s*{\\s*return\\s*)?['"]([^'"]+)['"]/);
              if (m) return m[1];
            } catch(e) {}
            return null;
          });
          await ctx.close();
          await browser.close();
          parentPort.postMessage({ token });
        } catch(e) {
          parentPort.postMessage({ error: String(e) });
        }
      }
      run();
    `;
    return new Promise((resolve) => {
      const w = new Worker(workerCode, {
        eval: true,
        workerData: { cookies, targetUrl, timeoutMs, channel, executable }
      });
      const timer = setTimeout(() => {
        w.terminate();
        resolve(null);
      }, 6e4);
      w.on("message", (msg) => {
        clearTimeout(timer);
        resolve(typeof msg.token === "string" ? msg.token.trim() || null : null);
      });
      w.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }
  // ──────────────────────────────────────────────
  // API 有效性判断
  // ──────────────────────────────────────────────
  isValidApiResponse(payload) {
    if (payload["_empty"]) return false;
    if (payload["http_status"] != null && payload["http_status"] >= 400) return false;
    const code = payload["code"];
    if (code !== void 0 && code !== 0) return false;
    return true;
  }
  // ──────────────────────────────────────────────
  // feeds3 / ic2 JSONP → 可解析文本（供 parseFeeds3Items、hasMoreFeeds 检测）
  // ──────────────────────────────────────────────
  /** 将 ic2 返回的 JSONP 解出 data.data[].html 并拼到原文后，结构与 fetchFeeds3Html 一致 */
  decodeJsonpFeedsHtmlPayload(respText) {
    try {
      const parsed = parseJsonp(respText);
      const dataArr = parsed?.data && typeof parsed.data === "object" && Array.isArray(parsed.data.data) ? parsed.data.data : null;
      if (dataArr) {
        const unescapeHtml = (s) => s.replace(/\\x22/g, '"').replace(/\\x3C/g, "<").replace(/\\\//g, "/");
        const htmlPart = dataArr.map((item) => unescapeHtml(String(item.html ?? ""))).join("");
        if (dataArr.length === 0) {
          log("DEBUG", "feeds3 jsonp: data.data is empty (server returned no feed items, may be \u98CE\u63A7 or scope)");
        } else {
          log("DEBUG", `feeds3 jsonp: extracted html from ${dataArr.length} data.data items, combined length=${htmlPart.length}`);
        }
        return respText + "\n<!--FEEDS_HTML-->\n" + htmlPart;
      }
    } catch {
    }
    return respText.replace(/\\x22/g, '"').replace(/\\x3C/g, "<").replace(/\\\//g, "/");
  }
  buildFeeds3FailureResponse(payload, extras) {
    return {
      ...payload,
      code: Number(payload.code ?? -1),
      message: this.describeApiFailure(payload) || String(payload.message ?? payload.msg ?? "feeds3 request failed"),
      _source: "feeds3",
      _failure_kind: this.getApiFailureKind(payload),
      ...extras
    };
  }
  // ──────────────────────────────────────────────
  // feeds3 缓存
  // ──────────────────────────────────────────────
  async fetchFeeds3Html(uin, forceRefresh = false, scope = 0, count = 0, externparam = "", uinlist, filter = "all", applist = "all") {
    const cacheKey = externparam ? `${uin}_${scope}_page_${externparam.substring(0, 30)}` : uinlist ? `${uin}_${scope}_${count}_ul_${uinlist}` : `${uin}_${scope}_${count}_f${filter}`;
    const now2 = Date.now() / 1e3;
    if (!forceRefresh && this.feeds3Cache.has(cacheKey)) {
      if (now2 - (this.feeds3CacheTime.get(cacheKey) ?? 0) < this.feeds3CacheTtl) {
        return this.feeds3Cache.get(cacheKey);
      }
    }
    const epBasetime = externparam ? new URLSearchParams(externparam).get("basetime") ?? "" : "";
    const epPagenum = externparam ? new URLSearchParams(externparam).get("pagenum") ?? "1" : "1";
    const params = new URLSearchParams({
      uin,
      scope: String(scope),
      view: "1",
      daylist: "",
      uinlist: uinlist ?? "",
      gid: "",
      flag: "1",
      filter,
      applist,
      refresh: externparam ? "0" : "1",
      // 首页 refresh=1，续页 refresh=0
      aisortEndTime: "0",
      aisortOffset: "0",
      getAisort: "0",
      aisortBeginTime: "0",
      pagenum: epPagenum,
      // 顶层 pagenum 与 externparam 里保持一致
      firstGetGroup: "0",
      icServerTime: "0",
      mixnocache: "0",
      scene: "0",
      begintime: epBasetime,
      // = externparam 里的 basetime
      dayspac: "5",
      // 往回查 5 天
      sidomain: "qzonestyle.gtimg.cn",
      useutf8: "1",
      outputhtmlfeed: "1",
      // 强制 HTML feed 格式，确保 feed_data 元素存在
      rd: String(Math.random()),
      usertime: String(Date.now()),
      windowId: String(Math.random()),
      // 与浏览器抓包一致
      g_tk: String(this.getGtk()),
      format: "json"
    });
    if (count > 0) params.set("count", String(count));
    if (externparam) params.set("externparam", externparam);
    const url = `https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?${params.toString()}`;
    const resp = await this.get(url, { headers: this.pcHeaders(this.getQzreferrer()) });
    log("DEBUG", `feeds3 raw response length=${resp.text.length}, status=${resp.status}`);
    const businessFailure = this.extractFeeds3BusinessFailure(resp.text);
    if (businessFailure) {
      this.lastFeeds3BusinessFailure = businessFailure;
      throw new Feeds3BusinessError(businessFailure);
    }
    this.lastFeeds3BusinessFailure = null;
    const text = this.decodeJsonpFeedsHtmlPayload(resp.text);
    log("DEBUG", `feeds3 decoded text length=${text.length}`);
    if (env.debugDump) {
      try {
        const debugDir = path2.join(this.config.cachePath, "debug");
        fs3.mkdirSync(debugDir, { recursive: true });
        const stablePath = path2.join(debugDir, `feeds3_${uin}_${scope}.html`);
        const snapshotPath = path2.join(debugDir, `feeds3_${uin}_${scope}_${Date.now()}.html`);
        fs3.writeFileSync(stablePath, text, "utf8");
        fs3.writeFileSync(snapshotPath, text, "utf8");
        log("DEBUG", `feeds3 dumped to ${stablePath} and ${snapshotPath}`);
      } catch {
      }
    }
    this.feeds3Cache.delete(cacheKey);
    this.feeds3Cache.set(cacheKey, text);
    this.feeds3CacheTime.delete(cacheKey);
    this.feeds3CacheTime.set(cacheKey, now2);
    while (this.feeds3Cache.size > 50) {
      const oldest = this.feeds3Cache.keys().next().value;
      this.feeds3Cache.delete(oldest);
      this.feeds3CacheTime.delete(oldest);
    }
    return text;
  }
  /**
   * ic2 `feeds_html_act_all`：浏览器「全部动态」类分页（start/count），与 feeds3_html_more / get_emotion_list 不同链路。
   *
   * **语义（与抓包一致）**：动态流归属由 **`hostuin`** 决定（服务端在 Cookie 权限允许时返回该号动态）；URL 里的 **`uin`** 多为 **页面/请求语境**（例如在谁的空间页里拉 ic2），**不**表示「条目作者 = uin」。
   * - `hostuin` **省略**时桥接默认用 `this.qqNumber`，即与当前登录号一致。
   * - `hostuin` **显式传他人**时（如好友），实机可返回 **该 hostuin 的说说**（与浏览器 `uin=空间页&hostuin=主人` 抓包一致），**不能**用「只看 uin」推断作者。
   * 若仅需稳定拉「某 QQ 本人主页说说时间线」，仍优先 `getEmotionList` / feeds3（与 `start/count` 分页语义不同）。
   *
   * @param targetUin 请求参数 `uin`（页面语境）
   * @param opts.hostUin 请求参数 `hostuin`；默认 `this.qqNumber`
   */
  async getFeedsHtmlActAll(targetUin, opts) {
    this.requireLogin();
    const uin = String(targetUin ?? "").trim();
    if (!uin) {
      return { code: -1, message: "\u7F3A\u5C11 uin", msglist: [], has_more: false, _page_info: { source: "feeds_html_act_all", error: true } };
    }
    const hostUin = String(opts?.hostUin ?? this.qqNumber ?? "").trim();
    if (!hostUin) {
      return { code: -1, message: "\u672A\u767B\u5F55\u6216\u7F3A\u5C11 hostuin", msglist: [], has_more: false, _page_info: { source: "feeds_html_act_all", error: true } };
    }
    const start = Math.max(0, Math.floor(opts?.start ?? 0));
    const count = Math.max(1, Math.min(50, Math.floor(opts?.count ?? 10)));
    const scope = opts?.scope != null ? Math.floor(opts.scope) : 0;
    const filter = opts?.filter ?? "all";
    const flag = opts?.flag ?? "1";
    const refresh = opts?.refresh ?? "0";
    const firstGetGroup = opts?.firstGetGroup ?? "0";
    const mixnocache = opts?.mixnocache ?? "0";
    const scene = opts?.scene ?? "0";
    const refer = opts?.refer ?? "2";
    const sidomain = opts?.sidomain ?? "qzonestyle.gtimg.cn";
    const useutf8 = opts?.useutf8 ?? "1";
    const outputhtmlfeed = opts?.outputhtmlfeed ?? "1";
    const params = new URLSearchParams();
    params.set("uin", uin);
    params.set("hostuin", hostUin);
    params.set("scope", String(scope));
    params.set("filter", filter);
    params.set("flag", flag);
    params.set("refresh", refresh);
    params.set("firstGetGroup", firstGetGroup);
    params.set("mixnocache", mixnocache);
    params.set("scene", scene);
    params.set("start", String(start));
    params.set("count", String(count));
    params.set("sidomain", sidomain);
    params.set("useutf8", useutf8);
    params.set("outputhtmlfeed", outputhtmlfeed);
    params.set("refer", refer);
    params.set("r", String(Math.random()));
    params.set("g_tk", String(this.getGtk()));
    const bt = opts?.begintime?.trim();
    if (bt && bt !== "undefined") params.set("begintime", bt);
    const icst = opts?.icServerTime?.trim();
    if (icst) params.set("icServerTime", icst);
    const url = `https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds_html_act_all?${params.toString()}`;
    try {
      const resp = await this.get(url, { headers: this.pcHeaders(this.getQzreferrer()) });
      log("DEBUG", `feeds_html_act_all raw len=${resp.text.length} status=${resp.status}`);
      if (resp.status >= 400) {
        return {
          code: -1,
          message: `HTTP ${resp.status}`,
          msglist: [],
          has_more: false,
          http_status: resp.status,
          _page_info: { source: "feeds_html_act_all", start, count, uin, hostuin: hostUin }
        };
      }
      const text = this.decodeJsonpFeedsHtmlPayload(resp.text);
      const excluded = /* @__PURE__ */ new Set(["217"]);
      const rawList = this.parseFeeds3Items(text, void 0, void 0, Math.max(count * 4, 80), false);
      const filtered = rawList.filter((m) => !excluded.has(String(m["appid"] ?? "")));
      const beforeCap = filtered.length;
      const msglist = filtered.slice(0, count);
      for (const item of msglist) this.cachePostMetaFromRaw(item);
      try {
        this.mergeFeeds3AncillaryFromHtml(text, Math.floor(Date.now() / 1e3), "feeds_html_act_all");
      } catch (e) {
        log("WARN", `feeds_html_act_all: parseFeeds3Comments failed: ${e}`);
      }
      const explicitNoMore = /hasMoreFeeds\s*:\s*false/.test(text);
      const explicitMore = /hasMoreFeeds\s*:\s*true/.test(text);
      const has_more = explicitNoMore ? false : explicitMore ? true : beforeCap >= count;
      const next_start = has_more ? start + count : start;
      const pageInfo = {
        source: "feeds_html_act_all",
        start,
        count,
        returned: msglist.length,
        parsed_before_cap: beforeCap,
        /** URL 参数：页面/语境 */
        request_uin: uin,
        /** 实际动态所属（与返回条目作者一致） */
        feed_owner_uin: hostUin,
        hostuin: hostUin,
        scope,
        pagination: "start_count"
      };
      if (uin !== hostUin) {
        pageInfo.note = "uin \u4E3A\u9875\u9762/\u8BF7\u6C42\u8BED\u5883\uFF0Chostuin \u4E3A\u52A8\u6001\u6D41\u4E3B\u4EBA\uFF08\u4E0E\u6D4F\u89C8\u5668\u6293\u5305\u4E00\u81F4\uFF09\u3002\u4E0E get_emotion_list \u7684 offset \u5206\u9875\u4E0D\u540C\uFF0C\u52FF\u6DF7\u7528\u7EED\u7FFB\u3002";
      }
      const out = {
        code: 0,
        message: "ok",
        msglist,
        has_more,
        next_start,
        _page_info: pageInfo
      };
      if (opts?.includeRawSnippet) {
        out._raw_snippet = resp.text.slice(0, 4e3);
      }
      return out;
    } catch (exc) {
      log("ERROR", `feeds_html_act_all failed: ${exc}`);
      return {
        code: -1,
        message: String(exc),
        msglist: [],
        has_more: false,
        _page_info: { source: "feeds_html_act_all", start, count, uin, hostuin: hostUin, error: true }
      };
    }
  }
  parseFeeds3Items(text, filterUin, filterAppid, maxItems = 50, skipFeedData = false) {
    return parseFeeds3Items(text, filterUin, filterAppid, maxItems, skipFeedData);
  }
  // ──────────────────────────────────────────────
  // Emotion list（仅 feeds3，PC/mobile 接口已移除）
  // ──────────────────────────────────────────────
  async getEmotionList(uin, pos = 0, num = 50, _ftype = 0, _sort = 0, _replynum = 10, maxPages = 15, cursor) {
    this.requireLogin();
    const targetUin = uin ?? this.qqNumber;
    return this.getEmotionListViaFeeds3(targetUin, num, pos, maxPages, cursor ?? "");
  }
  async getEmotionListViaFeeds3(uin, num = 50, pos = 0, maxPages = 15, initialCursor = "") {
    try {
      const excludedEmotionAppids = /* @__PURE__ */ new Set(["217"]);
      const dropEmotionNoise = (items) => items.filter((m) => !excludedEmotionAppids.has(String(m["appid"] ?? "")));
      const isOwn = uin === this.qqNumber;
      let text = "";
      let msglist = [];
      let usedScope = 1;
      let useUinlist = false;
      let useFilterFromStream = false;
      const ic = initialCursor.trim();
      let cursorWorked = false;
      if (ic) {
        if (isOwn) {
          log("DEBUG", `feeds3 continuation: cursor len=${ic.length} own uin=${uin}`);
          text = await this.fetchFeeds3Html(uin, true, 1, 50, ic);
          msglist = dropEmotionNoise(this.parseFeeds3Items(text, uin, void 0, pos + num));
        } else {
          log("DEBUG", `feeds3 continuation: cursor len=${ic.length} target uin=${uin}`);
          text = await this.fetchFeeds3Html(uin, true, 1, 50, ic);
          msglist = dropEmotionNoise(this.parseFeeds3Items(text, uin, void 0, pos + num));
          if (msglist.length === 0) {
            text = await this.fetchFeeds3Html(this.qqNumber, false, 0, 20, ic, void 0, "all", "all");
            const friends0 = this.extractFriendsFromFeeds3FromText(text);
            if (friends0.length) this.mergeFriendCache(friends0);
            msglist = dropEmotionNoise(this.parseFeeds3Items(text, uin, void 0, pos + num, false));
            if (msglist.length > 0) {
              usedScope = 0;
              useFilterFromStream = true;
            }
          }
          if (msglist.length === 0) {
            text = await this.fetchFeeds3Html(this.qqNumber, true, 0, 50, ic, uin);
            const friends1 = this.extractFriendsFromFeeds3FromText(text);
            if (friends1.length) this.mergeFriendCache(friends1);
            msglist = dropEmotionNoise(this.parseFeeds3Items(text, uin, void 0, pos + num));
            if (msglist.length > 0) {
              usedScope = 0;
              useUinlist = true;
            }
          }
          if (msglist.length === 0) {
            text = await this.fetchFeeds3Html(uin, true, 0, 50, ic);
            const friends2 = this.extractFriendsFromFeeds3FromText(text);
            if (friends2.length) this.mergeFriendCache(friends2);
            msglist = dropEmotionNoise(this.parseFeeds3Items(text, uin, void 0, pos + num));
            usedScope = 0;
          }
        }
        cursorWorked = msglist.length > 0;
        if (!cursorWorked) {
          log("WARN", "feeds3 continuation: cursor \u672A\u89E3\u6790\u5230\u8BF4\u8BF4\uFF0C\u56DE\u9000\u5230\u9996\u9875\u7B56\u7565");
        }
      }
      if (!cursorWorked && !isOwn) {
        log("DEBUG", `feeds3 fallback: for friend uin=${uin}, trying scope=0 stream then filter by opuin`);
        text = await this.fetchFeeds3Html(this.qqNumber, false, 0, 20, "", void 0, "all", "all");
        const friends = this.extractFriendsFromFeeds3FromText(text);
        if (friends.length) this.mergeFriendCache(friends);
        msglist = dropEmotionNoise(this.parseFeeds3Items(text, uin, void 0, pos + num, false));
        if (msglist.length > 0) {
          usedScope = 0;
          useFilterFromStream = true;
        }
      } else if (!cursorWorked) {
        msglist = [];
      }
      if (!cursorWorked && msglist.length === 0) {
        log("DEBUG", `feeds3 fallback: trying scope=1 for uin=${uin}`);
        text = await this.fetchFeeds3Html(uin, true, 1, 50);
        const scope1 = dropEmotionNoise(this.parseFeeds3Items(text, uin, void 0, pos + num));
        if (scope1.length > 0) {
          msglist = scope1;
          usedScope = 1;
        }
      }
      if (!cursorWorked && msglist.length === 0 && !isOwn) {
        log("DEBUG", `feeds3 fallback: scope=1 empty for friend, trying scope=0 with uinlist=${uin}`);
        text = await this.fetchFeeds3Html(this.qqNumber, true, 0, 50, "", uin);
        const friends = this.extractFriendsFromFeeds3FromText(text);
        if (friends.length) this.mergeFriendCache(friends);
        msglist = dropEmotionNoise(this.parseFeeds3Items(text, uin, void 0, pos + num));
        if (msglist.length > 0) {
          usedScope = 0;
          useUinlist = true;
        }
      }
      if (!cursorWorked && msglist.length === 0) {
        log("DEBUG", "feeds3 fallback: trying scope=0 without uinlist");
        text = await this.fetchFeeds3Html(uin, true, 0, 50);
        const friends = this.extractFriendsFromFeeds3FromText(text);
        if (friends.length) this.mergeFriendCache(friends);
        msglist = dropEmotionNoise(this.parseFeeds3Items(text, uin, void 0, pos + num));
        usedScope = 0;
      }
      const allHtmlTexts = [text];
      const seenTids = new Set(msglist.map((m) => m["tid"]));
      const cappedPages = Math.max(1, Math.min(30, maxPages));
      let remainingPages = cappedPages;
      if (cappedPages > 3) log("DEBUG", `feeds3 pagination: max_pages=${cappedPages}`);
      let currentText = text;
      let lastListPageText = text;
      let emptySkipStreak = 0;
      const MAX_EMPTY_SKIPS = 10;
      while (msglist.length < pos + num && remainingPages > 0) {
        const externparam = this.extractExternparam(currentText);
        if (!externparam) {
          log("DEBUG", "feeds3 pagination: no externparam found, stopping");
          break;
        }
        log("DEBUG", `feeds3 pagination: got ${msglist.length}, need ${pos + num}, scope=${usedScope}`);
        remainingPages--;
        currentText = useFilterFromStream ? await this.fetchFeeds3Html(this.qqNumber, true, 0, 20, externparam, void 0, "all", "all") : useUinlist ? await this.fetchFeeds3Html(this.qqNumber, true, 0, 50, externparam, uin) : await this.fetchFeeds3Html(uin, true, usedScope, 50, externparam);
        allHtmlTexts.push(currentText);
        lastListPageText = currentText;
        const page = dropEmotionNoise(this.parseFeeds3Items(currentText, uin, void 0, 50));
        let added = 0;
        for (const item of page) {
          const tid = item["tid"];
          if (!seenTids.has(tid)) {
            seenTids.add(tid);
            msglist.push(item);
            added++;
          }
        }
        log("DEBUG", `feeds3 pagination: page returned ${page.length} items, ${added} new after dedup`);
        if (added === 0) {
          emptySkipStreak++;
          if (emptySkipStreak >= MAX_EMPTY_SKIPS) {
            log("DEBUG", `feeds3 pagination: stopping after ${MAX_EMPTY_SKIPS} pages with no new tids`);
            break;
          }
        } else {
          emptySkipStreak = 0;
        }
      }
      for (const htmlText of allHtmlTexts) {
        this.mergeFeeds3AncillaryFromHtml(htmlText, Math.floor(Date.now() / 1e3), "getEmotionListViaFeeds3");
      }
      msglist.sort((a, b) => {
        const ta = a["created_time"] || 0;
        const tb = b["created_time"] || 0;
        return tb - ta;
      });
      const fullLen = msglist.length;
      const pages_fetched = 1 + (cappedPages - remainingPages);
      const hasMoreFeedsOnLastPage = !/hasMoreFeeds\s*:\s*false/.test(lastListPageText);
      const next_cursor = hasMoreFeedsOnLastPage ? this.extractExternparam(lastListPageText) : "";
      const truncated_by_max_pages = remainingPages === 0 && Boolean(next_cursor) && hasMoreFeedsOnLastPage;
      if (pos > 0) msglist = msglist.slice(pos);
      if (msglist.length > num) msglist = msglist.slice(0, num);
      const returnedLen = msglist.length;
      const next_pos = pos + returnedLen;
      const buffer_has_more = next_pos < fullLen;
      const next_page_uses_cursor = Boolean(next_cursor && hasMoreFeedsOnLastPage && next_pos >= fullLen);
      const has_more = buffer_has_more || Boolean(next_cursor) && hasMoreFeedsOnLastPage;
      for (const item of msglist) this.cachePostMetaFromRaw(item);
      const scopeLabel = useFilterFromStream ? "scope=0+filter" : useUinlist ? "scope=0+uinlist" : `scope=${usedScope}`;
      log("INFO", `feeds3 fallback (${scopeLabel}) \u83B7\u53D6\u5230 ${msglist.length} \u6761\u8BF4\u8BF4`);
      const _page_info = {
        count: returnedLen,
        source: "feeds3",
        strategy: scopeLabel,
        host_uin: uin,
        pos,
        num,
        max_pages: cappedPages,
        pages_fetched,
        full_fetched_len: fullLen,
        truncated_by_max_pages,
        pagination: "offset",
        next_page_uses_cursor,
        hint: next_page_uses_cursor ? "\u672C\u7F13\u51B2\u5DF2\u7528\u5C3D offset\uFF1A\u4E0B\u4E00\u9875\u8BF7\u4F20 cursor=\u672C\u54CD\u5E94 next_cursor\uFF08\u4E0E OpenClaw qzone_get_posts \u7684 cursor \u540C\u4E49\uFF09\uFF0Cpos/offset \u7528 0" : "\u4E0B\u4E00\u9875\u8BF7\u8C03\u7528 get_emotion_list \u5E76\u4F20 pos=next_pos\uFF08\u4E0E OpenClaw \u5DE5\u5177 offset \u540C\u4E49\uFF09\uFF1B\u82E5 _page_info.next_page_uses_cursor \u4E3A true \u5219\u987B\u7528 cursor \u7EED\u7FFB"
      };
      log(
        "DEBUG",
        `getEmotionListViaFeeds3: has_more=${has_more} next_pos=${next_pos} next_cursor_len=${next_cursor.length} truncated_by_max_pages=${truncated_by_max_pages}`
      );
      return {
        code: 0,
        message: `ok (feeds3 fallback, ${scopeLabel})`,
        msglist,
        _source: "feeds3",
        has_more,
        next_pos,
        next_cursor,
        _page_info
      };
    } catch (exc) {
      log("ERROR", `feeds3 fallback \u5931\u8D25: ${exc}`);
      const feeds3Failure = this.extractFeeds3BusinessError(exc);
      return feeds3Failure ? this.buildFeeds3FailureResponse(feeds3Failure, {
        msglist: [],
        has_more: false,
        next_pos: pos,
        next_cursor: "",
        _page_info: {
          count: 0,
          source: "feeds3",
          strategy: "",
          host_uin: uin,
          pos,
          num,
          max_pages: maxPages,
          pages_fetched: 0,
          full_fetched_len: 0,
          truncated_by_max_pages: false,
          pagination: "offset",
          error: true
        }
      }) : {
        code: -1e4,
        message: String(exc),
        msglist: [],
        has_more: false,
        next_pos: pos,
        next_cursor: "",
        _page_info: {
          count: 0,
          source: "feeds3",
          strategy: "",
          host_uin: uin,
          pos,
          num,
          max_pages: maxPages,
          pages_fetched: 0,
          full_fetched_len: 0,
          truncated_by_max_pages: false,
          pagination: "offset",
          error: true
        }
      };
    }
  }
  /** Extract externparam from feeds3 JSON response for pagination */
  extractExternparam(text) {
    return extractExternparam(text);
  }
  /**
   * 获取好友说说动态（scope=0 filter=all）。
   * - `fastMode=true`（HTTP 默认由 actions 开启）：**单次** fetchFeeds3Html + 单页解析，快速返回（与 slow 一致保留 HTML 中出现的本人动态；不再排除 loginUin）。
   * - `fastMode=false`（poller 默认）：多轮翻页直至凑满 num（后台完整性）。
   */
  async getFriendFeeds(cursor = "", num = 50, opts) {
    this.requireLogin();
    const fastMode = opts?.fastMode === true;
    const EXCLUDED_APPIDS = /* @__PURE__ */ new Set(["217"]);
    const want = Math.max(1, Math.min(200, num));
    const seenTids = /* @__PURE__ */ new Set();
    const merged = [];
    let nextCursor = cursor;
    const maxRounds = 20;
    const ingestSlowItem = (item) => {
      if (EXCLUDED_APPIDS.has(String(item["appid"] ?? ""))) return;
      const tid = String(item["tid"] ?? item["cellid"] ?? "");
      if (tid && seenTids.has(tid)) return;
      if (tid) seenTids.add(tid);
      merged.push(item);
      this.cachePostMetaFromRaw(item);
    };
    try {
      if (fastMode) {
        const text = await this.fetchFeeds3Html(
          this.qqNumber,
          true,
          0,
          20,
          cursor,
          void 0,
          "all",
          "all"
        );
        const friends = this.extractFriendsFromFeeds3FromText(text);
        if (friends.length) this.mergeFriendCache(friends);
        this.mergeFeeds3AncillaryFromHtml(text, Math.floor(Date.now() / 1e3), "getFriendFeeds.fast");
        const hasMoreFeeds = !/hasMoreFeeds\s*:\s*false/.test(text);
        const pageCursor = hasMoreFeeds ? extractExternparam(text) : "";
        const parseCap = Math.min(200, Math.max(80, want * 4));
        const all = this.parseFeeds3Items(text, void 0, void 0, parseCap, false);
        for (const item of all) ingestSlowItem(item);
        const msglist2 = merged.slice(0, want);
        const has_more2 = Boolean(pageCursor && hasMoreFeeds);
        log("DEBUG", `[feeds3][fast] mode=fast fetch_count=1 items=${msglist2.length}`);
        log(
          "DEBUG",
          `[feeds3][fast] has_more=${has_more2} next_cursor=${pageCursor ? `${pageCursor.slice(0, 120)}${pageCursor.length > 120 ? "\u2026" : ""}` : "(empty)"}`
        );
        log("DEBUG", `getFriendFeeds: fast scope=0 merged ${msglist2.length} posts (incl. self if in HTML), next_cursor=${pageCursor || "(end)"}`);
        return {
          code: 0,
          message: "ok",
          msglist: msglist2,
          next_cursor: pageCursor,
          has_more: has_more2,
          _page_info: { count: msglist2.length, source: "feeds3", fast_mode: true }
        };
      }
      for (let round = 0; round < maxRounds && merged.length < want; round++) {
        const text = await this.fetchFeeds3Html(
          this.qqNumber,
          true,
          0,
          20,
          nextCursor,
          void 0,
          "all",
          "all"
        );
        const friends = this.extractFriendsFromFeeds3FromText(text);
        if (friends.length) this.mergeFriendCache(friends);
        this.mergeFeeds3AncillaryFromHtml(text, Math.floor(Date.now() / 1e3), `getFriendFeeds.page${round + 1}`);
        const hasMore = !/hasMoreFeeds\s*:\s*false/.test(text);
        const pageCursor = hasMore ? extractExternparam(text) : "";
        if (nextCursor && pageCursor === nextCursor) {
          log("DEBUG", "getFriendFeeds: cursor unchanged, end of feed");
          break;
        }
        nextCursor = pageCursor;
        const all = this.parseFeeds3Items(text, void 0, void 0, want - merged.length, false);
        for (const item of all) ingestSlowItem(item);
        log("DEBUG", `getFriendFeeds: round ${round + 1} got ${all.length} raw \u2192 ${merged.length} merged, hasMore=${hasMore}`);
        if (!hasMore || merged.length >= want) break;
      }
      const msglist = merged.slice(0, want);
      const has_more = Boolean(nextCursor);
      log("DEBUG", `getFriendFeeds: scope=0 total ${msglist.length} posts (excl. activity), next_cursor=${nextCursor || "(end)"}`);
      return {
        code: 0,
        message: "ok",
        msglist,
        next_cursor: nextCursor,
        has_more,
        _page_info: { count: msglist.length, source: "feeds3", fast_mode: false }
      };
    } catch (exc) {
      log("ERROR", `friend feeds \u83B7\u53D6\u5931\u8D25: ${exc}`);
      const feeds3Failure = this.extractFeeds3BusinessError(exc);
      return feeds3Failure ? this.buildFeeds3FailureResponse(feeds3Failure, {
        msglist: [],
        next_cursor: "",
        has_more: false,
        _page_info: { count: 0, source: "feeds3", fast_mode: fastMode, error: true }
      }) : {
        code: -1,
        message: String(exc),
        msglist: [],
        next_cursor: "",
        has_more: false,
        _page_info: { count: 0, source: "feeds3", fast_mode: fastMode }
      };
    }
  }
  /**
   * 从 feeds3 原始文本中提取好友四元组（opuin/uin/nickname/logimg）及 f-nick HTML 昵称，去重合并，不排除任何人。
   * 排除自身 UIN 由调用方在 getFriendList 等处处理。
   */
  extractFriendsFromFeeds3FromText(text) {
    return extractFriendsFromFeeds3FromText(text, this.qqNumber ?? "");
  }
  /**
   * 请求 feeds3 scope=0（好友动态流），提取好友并可选翻页以获取更多历史中的好友。
   * 不写入缓存，由调用方 mergeFriendCache。
   */
  async extractFriendsFromFeeds3(maxPages = 3) {
    this.requireLogin();
    const uin = this.qqNumber;
    const all = /* @__PURE__ */ new Map();
    let text = await this.fetchFeeds3Html(uin, true, 0, 50);
    let pageCount = 0;
    while (pageCount < maxPages) {
      const batch = this.extractFriendsFromFeeds3FromText(text);
      for (const f of batch) {
        if (!all.has(f.uin)) all.set(f.uin, { ...f });
        else {
          const cur = all.get(f.uin);
          if (f.nickname) cur.nickname = f.nickname;
          if (f.avatar) cur.avatar = f.avatar;
        }
      }
      pageCount++;
      const externparam = this.extractExternparam(text);
      if (!externparam || pageCount >= maxPages) break;
      text = await this.fetchFeeds3Html(uin, true, 0, 50, externparam);
    }
    return Array.from(all.values());
  }
  async getFeedImages(uin, tid) {
    this.requireLogin();
    try {
      const text = await this.fetchFeeds3Html(uin);
      const pattern = new RegExp(`data-key="${tid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"([\\s\\S]*?)(?=data-key="|$)`);
      const m = text.match(pattern);
      if (!m) return [];
      const block = htmlUnescape(m[1]);
      const urls = [];
      for (const im of block.matchAll(/<img[^>]+src="([^"]+)"/gi)) {
        const src = im[1];
        if (src.includes("qpic.cn") || src.includes("qlogo.cn") || /\.(jpg|jpeg|png|gif|webp)$/.test(src)) {
          if (!urls.includes(src)) urls.push(src);
        }
      }
      return urls;
    } catch (exc) {
      log("ERROR", `feeds3 \u56FE\u7247\u63D0\u53D6\u5931\u8D25: ${exc}`);
      return [];
    }
  }
  // ──────────────────────────────────────────────
  // Shuoshuo detail
  // ──────────────────────────────────────────────
  async getShuoshuoDetail(uin, tid) {
    this.requireLogin();
    if (this.routes["detail"] === "mobile") {
      const url = `https://mobile.qzone.qq.com/detail?g_tk=${this.getGtk()}&uin=${uin}&cellid=${tid}&format=json`;
      const resp = await this.get(url, { headers: this.mobileHeaders() });
      this.dumpDebugPayload("detail_mobile", resp.text);
      return safeDecodeJsonResponse(resp.data);
    }
    const now2 = Date.now() / 1e3;
    const skipPc = this.detailAllFailTime > 0 && now2 - this.detailAllFailTime < this.detailAllFailTtl;
    let lastPayload = {};
    if (!skipPc) {
      const postUrl = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_getdetailv6?g_tk=${this.getGtk()}`;
      try {
        const resp = await this.post(postUrl, {
          data: new URLSearchParams({ uin, tid, format: "json", hostuin: this.qqNumber, qzreferrer: this.getQzreferrer() }),
          headers: this.pcHeaders(this.getQzreferrer())
        });
        this.dumpDebugPayload("detail_pc_post", resp.text);
        const payload = safeDecodeJsonResponse(resp.data);
        if (this.isValidApiResponse(payload)) {
          this.detailWinningVariant = -1;
          return payload;
        }
        lastPayload = payload;
      } catch (exc) {
        log("DEBUG", `Detail POST failed: ${exc}`);
      }
      const base = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_getdetailv6?g_tk=${this.getGtk()}&uin=${uin}&tid=${tid}&format=json`;
      const qzonetoken = await this.getQzonetoken() ?? String(this.getGtk());
      const variants = [
        `qzonetoken=${qzonetoken}&hostuin=${this.qqNumber}&qzreferrer=${this.getQzreferrer()}`,
        // 完整参数
        `qzonetoken=${qzonetoken}`
        // 仅 qzonetoken
      ];
      for (let index = 0; index < variants.length; index++) {
        const suffix = variants[index];
        const url = base + "&" + suffix;
        try {
          const resp = await this.get(url, { headers: this.pcHeaders(this.getQzreferrer()) });
          this.dumpDebugPayload(`detail_pc_${index}`, resp.text);
          const payload = safeDecodeJsonResponse(resp.data);
          if (this.isValidApiResponse(payload)) {
            this.detailWinningVariant = index;
            return payload;
          }
          if (!payload["_empty"]) lastPayload = payload;
        } catch (exc) {
          log("DEBUG", `Detail GET variant ${index} failed: ${exc}`);
        }
      }
      this.detailAllFailTime = Date.now() / 1e3;
    }
    try {
      const url = `https://mobile.qzone.qq.com/detail?g_tk=${this.getGtk()}&uin=${uin}&cellid=${tid}&format=json`;
      const resp = await this.get(url, { headers: this.mobileHeaders() });
      this.dumpDebugPayload("detail_mobile", resp.text);
      const p = safeDecodeJsonResponse(resp.data);
      if (this.isValidApiResponse(p)) return p;
    } catch (exc) {
      log("DEBUG", `Detail mobile fallback failed: ${exc}`);
    }
    try {
      const elist = await this.getEmotionList(uin, 0, 80, void 0, void 0, void 0, 15);
      const msglist = Array.isArray(elist["msglist"]) ? elist["msglist"] : [];
      for (const msg of msglist) {
        if (!this.itemMatchesTid(msg, tid)) continue;
        return {
          ...msg,
          code: 0,
          data: msg,
          message: "success (from list)",
          _detail_semantic: {
            source: "emotion_list_fallback",
            note: "PC getdetailv6 \u4E0D\u53EF\u7528\uFF0C\u6B63\u6587\u6765\u81EA feeds3 \u5217\u8868\u9879\uFF1B\u5DF2\u955C\u50CF\u5230\u9876\u5C42 content/conlist \u7B49\u5B57\u6BB5\u3002"
          }
        };
      }
    } catch {
    }
    const actDetail = await this.detailFromActAllMsglist(uin, tid);
    if (actDetail) return actDetail;
    return lastPayload;
  }
  // ──────────────────────────────────────────────
  // Comments
  // ──────────────────────────────────────────────
  /** 从评论 API 响应中取评论条数（用于调试日志） */
  commentCount(p) {
    if (!p || p["_empty"]) return -1;
    for (const key of ["commentlist", "comment_list", "comments", "data"]) {
      const v = p[key];
      if (Array.isArray(v)) return v.length;
      if (v && typeof v === "object" && Array.isArray(v["list"])) return v["list"].length;
    }
    return -1;
  }
  collectCommentListFromResult(res) {
    for (const key of ["commentlist", "comment_list", "comments", "data"]) {
      const value = res[key];
      if (Array.isArray(value)) return value;
    }
    return [];
  }
  async probeCapabilities() {
    const checkedAt = (/* @__PURE__ */ new Date()).toISOString();
    const capabilities = [];
    try {
      const sessionOk = await this.validateSession(true);
      capabilities.push({
        name: "session",
        available: sessionOk,
        reliability: "strict",
        source: "official_api",
        warnings: sessionOk ? [] : ["session validation failed"],
        reason: sessionOk ? void 0 : "cookie invalid or expired"
      });
    } catch (error) {
      capabilities.push({
        name: "session",
        available: false,
        reliability: "strict",
        source: "official_api",
        warnings: [String(error)],
        reason: "session validation threw"
      });
    }
    const strictPosts = await this.getPostsStrict(this.qqNumber ?? void 0, { maxPages: 1 });
    capabilities.push({
      name: "posts.read",
      available: strictPosts.ok,
      reliability: "strict",
      source: strictPosts.ok ? strictPosts.source : strictPosts.source,
      warnings: strictPosts.warnings,
      reason: strictPosts.ok ? void 0 : strictPosts.kind
    });
    try {
      const friendFeeds = await this.getFriendFeeds("", 10, { fastMode: true });
      capabilities.push({
        name: "friend_feeds.read",
        available: Number(friendFeeds.code ?? -1) === 0,
        reliability: "best_effort",
        source: this.inferSdkSource(friendFeeds._source ?? friendFeeds._page_info?.source, "feeds3_html"),
        warnings: Number(friendFeeds.code ?? -1) === 0 ? [] : [String(friendFeeds.message ?? "friend feeds unavailable")],
        reason: Number(friendFeeds.code ?? -1) === 0 ? void 0 : String(friendFeeds.message ?? "unavailable")
      });
    } catch (error) {
      capabilities.push({
        name: "friend_feeds.read",
        available: false,
        reliability: "best_effort",
        source: "feeds3_html",
        warnings: [String(error)],
        reason: "friend feeds threw"
      });
    }
    try {
      const playwrightFeed = await this.getPlaywrightFriendFeedSnapshot(10);
      capabilities.push({
        name: "playwright_feed.read",
        available: playwrightFeed.posts.length > 0,
        reliability: "best_effort",
        source: "playwright_feed",
        warnings: playwrightFeed.posts.length > 0 ? [] : ["playwright feed returned no posts"],
        reason: playwrightFeed.posts.length > 0 ? void 0 : `network=${playwrightFeed.networkIntercepted ? "1" : "0"} dom=${playwrightFeed.domFallbackUsed ? "1" : "0"}`
      });
    } catch (error) {
      capabilities.push({
        name: "playwright_feed.read",
        available: false,
        reliability: "best_effort",
        source: "playwright_feed",
        warnings: [String(error)],
        reason: "playwright feed threw"
      });
    }
    const diagnostic = this.createDiagnosticRef("capability_trace", { checked_at: checkedAt, capabilities });
    return {
      ok: capabilities.every((item) => item.available || item.reliability === "best_effort"),
      checkedAt,
      capabilities,
      diagnostic
    };
  }
  async getPostsStrict(uin, options) {
    const targetUin = uin ?? this.qqNumber ?? "";
    try {
      const res = await this.getEmotionList(
        targetUin,
        options?.pos ?? 0,
        options?.num ?? 50,
        void 0,
        void 0,
        void 0,
        options?.maxPages ?? 15,
        options?.cursor
      );
      if (Number(res.code ?? -1) !== 0) {
        const kind = this.getApiFailureKind(res);
        return this.sdkFailure(
          kind,
          kind === "rate_limit",
          "strict",
          { endpoint: "getPostsStrict", uin: targetUin, message: String(res.message ?? "read failed") },
          this.inferSdkSource(res._source, "official_api")
        );
      }
      const posts = Array.isArray(res.msglist) ? res.msglist : [];
      return this.sdkSuccess(
        {
          posts,
          nextCursor: typeof res.next_cursor === "string" ? res.next_cursor : void 0,
          hasMore: Boolean(res.hasMoreFeeds ?? res.has_more ?? res.next_cursor)
        },
        this.inferSdkSource(res._source ?? res._page_info?.source, "official_api"),
        "strict"
      );
    } catch (error) {
      return this.classifySdkFailure(error, "getPostsStrict", targetUin);
    }
  }
  async getProfileStrict(uin) {
    try {
      const res = await this.getUserInfo(uin);
      if (Number(res.code ?? 0) !== 0) {
        return this.sdkFailure(
          this.isAuthFailure(res) ? "auth" : "upstream_changed",
          false,
          "strict",
          { endpoint: "getProfileStrict", uin, message: String(res.message ?? "profile read failed") },
          "official_api"
        );
      }
      return this.sdkSuccess(res, "official_api", "strict");
    } catch (error) {
      return this.classifySdkFailure(error, "getProfileStrict", uin);
    }
  }
  async publishPostStrict(content, images, whoCanSee) {
    try {
      const [tid, picIds] = await this.publish(content, images, whoCanSee);
      return this.sdkSuccess({ tid, picIds }, "official_api", "strict");
    } catch (error) {
      return this.classifySdkFailure(error, "publishPostStrict", this.qqNumber ?? void 0);
    }
  }
  async deletePostStrict(tid, topicId = "") {
    try {
      const res = await this.deleteEmotion(tid, topicId);
      if (Number(res.code ?? -1) !== 0) {
        return this.sdkFailure(
          this.isAuthFailure(res) ? "auth" : "upstream_changed",
          false,
          "strict",
          { endpoint: "deletePostStrict", tid, message: String(res.message ?? "delete failed") },
          "official_api"
        );
      }
      return this.sdkSuccess({ tid }, "official_api", "strict");
    } catch (error) {
      return this.classifySdkFailure(error, "deletePostStrict", void 0, tid);
    }
  }
  async getPostDetailBestEffort(uin, tid) {
    const diagnostic = this.createDiagnosticRef("parse_trace", {
      endpoint: "getPostDetailBestEffort",
      tid,
      uin,
      candidate_keys: this.collectPostEntityKeys(tid)
    });
    try {
      const res = await this.getShuoshuoDetail(uin, tid);
      if (Number(res.code ?? -1) !== 0) {
        return this.sdkFailure(
          "parse_miss",
          false,
          "best_effort",
          { endpoint: "getPostDetailBestEffort", tid, uin, message: String(res.message ?? "detail unavailable") },
          this.inferSdkSource(res._source, "feeds3_html"),
          [],
          diagnostic
        );
      }
      const warnings = [];
      if (String(res["_message"] ?? "").trim()) warnings.push(String(res["_message"]));
      return this.sdkSuccess(
        { post: res, identity: this.buildPostIdentity(tid, uin) },
        this.inferSdkSource(res._source, "feeds3_html"),
        "best_effort",
        warnings,
        diagnostic
      );
    } catch (error) {
      const failure = this.classifySdkFailure(error, "getPostDetailBestEffort", uin, tid);
      failure.diagnostic = diagnostic;
      return failure;
    }
  }
  async getCommentsBestEffort(uin, tid, num = 20, pos = 0, options) {
    if (typeof uin === "object" && uin !== null) {
      return this.getCommentsBestEffortSdk(uin);
    }
    return this.getCommentsBestEffortLegacy(uin, tid ?? "", num, pos, options);
  }
  async getCommentsBestEffortSdk(input) {
    const diagnostic = this.createDiagnosticRef("parse_trace", {
      endpoint: "getCommentsBestEffort",
      tid: input.tid,
      uin: input.uin,
      candidate_keys: this.collectPostEntityKeys(input.tid)
    });
    try {
      const res = await this.getCommentsBestEffortLegacy(input.uin, input.tid, input.num ?? 20, input.pos ?? 0, input.options);
      const comments = this.collectCommentListFromResult(res);
      const meta = this.getPostMeta(input.tid);
      const embeddedTotal = Number(res._feeds3_total ?? comments.length);
      const expected = Number(meta?.cmtnum ?? embeddedTotal ?? 0);
      const warnings = [];
      let availability = "available_full";
      if (Number(res.code ?? -1) !== 0) {
        const kind = this.getApiFailureKind(res);
        if (kind === "auth" || kind === "rate_limit") {
          return this.sdkFailure(
            kind,
            kind === "rate_limit",
            "best_effort",
            {
              endpoint: "getCommentsBestEffort",
              tid: input.tid,
              uin: input.uin,
              candidateKeys: this.collectPostEntityKeys(input.tid),
              message: String(res.message ?? "comment read failed")
            },
            this.inferSdkSource(res._source, "feeds3_html"),
            warnings,
            diagnostic
          );
        }
      }
      if (comments.length === 0 && expected > 0) {
        availability = "not_embedded";
        warnings.push("post counts indicate comments exist but html did not embed comment detail");
      } else if (expected > comments.length) {
        availability = "available_partial";
        warnings.push("embedded comments are partial relative to counted comments");
      }
      if (Number(res.code ?? -1) !== 0 && comments.length === 0 && availability !== "not_embedded") {
        return this.sdkFailure(
          "parse_miss",
          false,
          "best_effort",
          {
            endpoint: "getCommentsBestEffort",
            tid: input.tid,
            uin: input.uin,
            candidateKeys: this.collectPostEntityKeys(input.tid),
            message: String(res.message ?? "comment parse miss")
          },
          this.inferSdkSource(res._source, "feeds3_html"),
          warnings,
          diagnostic
        );
      }
      return this.sdkSuccess(
        { comments, identity: this.buildPostIdentity(input.tid, input.uin), availability },
        this.inferSdkSource(res._source, comments.length > 0 ? "feeds3_html" : "derived"),
        "best_effort",
        warnings,
        diagnostic
      );
    } catch (error) {
      const failure = this.classifySdkFailure(error, "getCommentsBestEffort", input.uin, input.tid);
      failure.diagnostic = diagnostic;
      return failure;
    }
  }
  async getCommentsBestEffortLegacy(uin, tid, num = 20, pos = 0, options) {
    const fastMode = options?.fastMode === true;
    log("DEBUG", `getCommentsBestEffort: uin=${uin} tid=${tid} num=${num} pos=${pos} fastMode=${fastMode}`);
    this.lastFeeds3BusinessFailure = null;
    const forceRefresh = options?.forceRefresh ?? false;
    const maxCacheAgeSec = options?.maxCacheAgeSec ?? 90;
    let feeds3List = this.feeds3Comments.get(tid);
    this.aliasFeeds3CommentsToCanonicalTid(tid);
    feeds3List = this.feeds3Comments.get(tid);
    const cacheAgeSec = this.commentCacheAgeSeconds(tid);
    const candidateKeys = this.collectPostEntityKeys(tid);
    const wrapCommentPage = (base, sliceLen, total, source, fastLogFetches) => {
      const has_more = pos + sliceLen < total;
      const nc = has_more ? String(pos + sliceLen) : "";
      if (fastMode && fastLogFetches !== void 0) {
        log("DEBUG", `[feeds3][fast] mode=fast fetch_count=${fastLogFetches} items=${sliceLen}`);
        log("DEBUG", `[feeds3][fast] has_more=${has_more} next_cursor=${nc || "(empty)"}`);
      }
      return {
        ...base,
        has_more,
        next_cursor: nc,
        _page_info: { count: sliceLen, source, fast_mode: fastMode }
      };
    };
    let commentHttpFetches = 0;
    if (feeds3List && feeds3List.length > 0 && !forceRefresh && cacheAgeSec != null && cacheAgeSec <= maxCacheAgeSec) {
      const slice = feeds3List.slice(pos, pos + num);
      return wrapCommentPage(
        {
          code: 0,
          commentlist: slice,
          _source: "feeds3_cache",
          _feeds3_total: feeds3List.length
        },
        slice.length,
        feeds3List.length,
        "feeds3_cache",
        fastMode ? 0 : void 0
      );
    }
    if (!feeds3List || feeds3List.length === 0) {
      log("INFO", `getCommentsBestEffort: feeds3Comments \u7F13\u5B58\u672A\u547D\u4E2D\uFF0C\u62C9\u53D6 HTML \u89E3\u6790 uin=${uin} tid=${tid}`);
      try {
        commentHttpFetches = 0;
        if (this.qqNumber) {
          const htmlFriend = await this.fetchFeeds3Html(this.qqNumber, false, 0, 50, "", void 0, "all", "all");
          commentHttpFetches += 1;
          this.mergeFeeds3AncillaryFromHtml(htmlFriend, Math.floor(Date.now() / 1e3), "getCommentsBestEffort.friend");
          this.aliasFeeds3CommentsToCanonicalTid(tid);
          feeds3List = this.feeds3Comments.get(tid);
          log(
            "DEBUG",
            `getCommentsBestEffort: \u597D\u53CB\u6D41\u89E3\u6790\u540E tid=${tid} \u6761\u6570=${feeds3List?.length ?? 0}`
          );
        }
        if (!feeds3List || feeds3List.length === 0) {
          const htmlAuthor = await this.fetchFeeds3Html(uin, true, 1, 50);
          commentHttpFetches += 1;
          this.mergeFeeds3AncillaryFromHtml(htmlAuthor, Math.floor(Date.now() / 1e3), "getCommentsBestEffort.author");
          this.aliasFeeds3CommentsToCanonicalTid(tid);
          feeds3List = this.feeds3Comments.get(tid);
          log(
            "DEBUG",
            `getCommentsBestEffort: \u4F5C\u8005\u7A7A\u95F4\u89E3\u6790\u540E tid=${tid} \u6761\u6570=${feeds3List?.length ?? 0}`
          );
        }
        if ((!feeds3List || feeds3List.length === 0) && uin) {
          let actStart = 0;
          const actCount = 20;
          const maxActPages = 25;
          for (let ap = 0; ap < maxActPages && (!feeds3List || feeds3List.length === 0); ap++) {
            const act = await this.getFeedsHtmlActAll(uin, { hostUin: uin, start: actStart, count: actCount, scope: 0 });
            commentHttpFetches += 1;
            this.aliasFeeds3CommentsToCanonicalTid(tid);
            feeds3List = this.feeds3Comments.get(tid);
            if (feeds3List?.length) {
              log("INFO", `getCommentsBestEffort: feeds_html_act_all \u7B2C ${ap + 1} \u9875\u547D\u4E2D tid=${tid} \u8BC4\u8BBA ${feeds3List.length} \u6761`);
              break;
            }
            if (act["code"] !== 0 && act["code"] != null) break;
            if (!act["has_more"]) break;
            const ns = act["next_start"];
            actStart = typeof ns === "number" && Number.isFinite(ns) ? ns : actStart + actCount;
          }
        }
      } catch (e) {
        log("WARNING", `getCommentsBestEffort: \u4E3B\u52A8\u62C9\u53D6 feeds3 \u5931\u8D25: ${e}`);
      }
    }
    if (feeds3List && feeds3List.length > 0) {
      const slice = feeds3List.slice(pos, pos + num);
      log("INFO", `getCommentsBestEffort: \u4F7F\u7528 feeds3 \u8BC4\u8BBA\u6570=${slice.length}/${feeds3List.length}`);
      return wrapCommentPage(
        {
          code: 0,
          commentlist: slice,
          _source: "feeds3",
          _feeds3_total: feeds3List.length
        },
        slice.length,
        feeds3List.length,
        "feeds3",
        fastMode ? commentHttpFetches : void 0
      );
    }
    log("WARNING", `getCommentsBestEffort: \u672A\u5728 feeds3 \u597D\u53CB\u6D41+\u4F5C\u8005\u7A7A\u95F4\u9996\u9875\u89E3\u6790\u5230\u8BE5 tid \u7684\u8BC4\u8BBA`);
    if (this.lastFeeds3BusinessFailure) {
      return wrapCommentPage(
        this.buildFeeds3FailureResponse(this.lastFeeds3BusinessFailure, {
          commentlist: [],
          _feeds3_total: 0
        }),
        0,
        0,
        "feeds3",
        fastMode ? commentHttpFetches : void 0
      );
    }
    if (candidateKeys.length > 0) {
      const meta = this.postMetaCache.get(tid);
      const commentHint = meta?.cmtnum != null && meta.cmtnum > 0 ? "post_counts_present_but_not_embedded" : "html_no_matching_comment_bucket";
      log("WARNING", `getCommentsBestEffort: ${commentHint} tid=${tid} candidate_keys=${candidateKeys.join("|")}`);
    }
    const empty = {
      code: -1,
      message: "comments_not_found_in_feeds3: \u5DF2\u5C1D\u8BD5\u597D\u53CB\u6D41\u3001\u4F5C\u8005 feeds3(scope=1)\u3001feeds_html_act_all \u5206\u9875\uFF1B\u4ECD\u65E0\u6876\u5219\u5E16\u65E0\u5C55\u5F00\u8BC4\u8BBA\u3001tid \u4E0D\u4E00\u81F4\u6216 HTML \u7ED3\u6784\u53D8\u5316",
      commentlist: [],
      has_more: false,
      next_cursor: "",
      _page_info: { count: 0, source: "feeds3", fast_mode: fastMode }
    };
    if (fastMode) {
      log("DEBUG", `[feeds3][fast] mode=fast fetch_count=${commentHttpFetches} items=0`);
      log("DEBUG", `[feeds3][fast] has_more=false next_cursor=(empty)`);
    }
    return empty;
  }
  // ──────────────────────────────────────────────
  // Like list (仅 feeds3，PC/mobile detail 已移除)
  // ──────────────────────────────────────────────
  feeds3LikesCache = /* @__PURE__ */ new Map();
  lastFeeds3FailureByTid = /* @__PURE__ */ new Map();
  /**
   * 获取点赞列表（仅 feeds3）。
   */
  async getLikeListBestEffort(uin, tid) {
    log("DEBUG", `getLikeListBestEffort: uin=${uin} tid=${tid}`);
    this.lastFeeds3BusinessFailure = null;
    this.lastFeeds3FailureByTid.delete(tid);
    this.aliasFeeds3LikesToCanonicalTid(tid);
    const cached = this.feeds3LikesCache.get(tid);
    if (cached) {
      log("INFO", `getLikeListBestEffort: \u4F7F\u7528 feeds3 \u7F13\u5B58 ${cached.length} \u4E2A\u70B9\u8D5E`);
      return cached;
    }
    try {
      log("INFO", `getLikeListBestEffort: feeds3 \u7F13\u5B58\u672A\u547D\u4E2D\uFF0C\u4E3B\u52A8\u62C9\u53D6 uin=${uin} tid=${tid}`);
      const htmlText = await this.fetchFeeds3Html(uin, true, 1, 50);
      this.mergeFeeds3AncillaryFromHtml(htmlText, Math.floor(Date.now() / 1e3), "getLikeListBestEffort.author");
      this.aliasFeeds3LikesToCanonicalTid(tid);
      let likes = this.feeds3Likes.get(tid) ?? [];
      if (likes.length === 0 && uin !== this.qqNumber) {
        log("DEBUG", `getLikeListBestEffort: scope=1 \u672A\u627E\u5230\uFF0C\u5C1D\u8BD5 scope=0`);
        const htmlText2 = await this.fetchFeeds3Html(this.qqNumber, false, 0, 50, "", void 0, "all", "all");
        this.mergeFeeds3AncillaryFromHtml(htmlText2, Math.floor(Date.now() / 1e3), "getLikeListBestEffort.friend");
        this.aliasFeeds3LikesToCanonicalTid(tid);
        const likes2 = this.feeds3Likes.get(tid) ?? [];
        if (likes2.length > 0) {
          likes = likes2;
        }
      }
      if (likes.length > 0) {
        log("INFO", `getLikeListBestEffort: feeds3 \u89E3\u6790\u6210\u529F ${likes.length} \u4E2A\u70B9\u8D5E`);
        return this.feeds3LikesCache.get(tid) ?? [];
      }
      log("DEBUG", `getLikeListBestEffort: feeds3 \u65E0\u70B9\u8D5E\u6570\u636E`);
    } catch (e) {
      log("WARNING", `getLikeListBestEffort: feeds3 \u89E3\u6790\u5931\u8D25: ${e}`);
    }
    const candidateKeys = this.collectPostEntityKeys(tid);
    if (this.lastFeeds3BusinessFailure) {
      this.lastFeeds3FailureByTid.set(tid, this.lastFeeds3BusinessFailure);
      return [];
    }
    if (candidateKeys.length > 0) {
      const meta = this.postMetaCache.get(tid);
      const likeHint = meta?.likenum != null && meta.likenum > 0 ? "post_counts_present_but_not_embedded" : "html_no_matching_like_bucket";
      log("WARNING", `getLikeListBestEffort: ${likeHint} tid=${tid} candidate_keys=${candidateKeys.join("|")}`);
    }
    log("WARNING", `getLikeListBestEffort: \u5168\u90E8\u5931\u8D25\uFF0C\u8FD4\u56DE\u7A7A\u6570\u7EC4`);
    return [];
  }
  // ──────────────────────────────────────────────
  // Image upload
  // ──────────────────────────────────────────────
  async getLikesBestEffort(uin, tid) {
    const diagnostic = this.createDiagnosticRef("parse_trace", {
      endpoint: "getLikesBestEffort",
      tid,
      uin,
      candidate_keys: this.collectPostEntityKeys(tid)
    });
    try {
      const likes = await this.getLikeListBestEffort(uin, tid);
      const feeds3Failure = this.lastFeeds3FailureByTid.get(tid);
      if (feeds3Failure) {
        const kind = this.getApiFailureKind(feeds3Failure);
        return this.sdkFailure(
          kind,
          kind === "rate_limit",
          "best_effort",
          {
            endpoint: "getLikesBestEffort",
            tid,
            uin,
            candidateKeys: this.collectPostEntityKeys(tid),
            message: this.describeApiFailure(feeds3Failure) || "like read failed"
          },
          "feeds3_html",
          [],
          diagnostic
        );
      }
      const meta = this.getPostMeta(tid);
      const expected = Number(meta?.likenum ?? likes.length);
      const warnings = [];
      let availability = "available_full";
      if (likes.length === 0 && expected > 0) {
        availability = "not_embedded";
        warnings.push("post counts indicate likes exist but html did not embed like detail");
      } else if (expected > likes.length) {
        availability = "available_partial";
        warnings.push("embedded likes are partial relative to counted likes");
      }
      return this.sdkSuccess(
        { likes, identity: this.buildPostIdentity(tid, uin), availability },
        likes.length > 0 ? "feeds3_html" : "derived",
        "best_effort",
        warnings,
        diagnostic
      );
    } catch (error) {
      const failure = this.classifySdkFailure(error, "getLikesBestEffort", uin, tid);
      failure.diagnostic = diagnostic;
      return failure;
    }
  }
  async getFriendFeedsBestEffort(cursor = "", num = 50, options) {
    const diagnostic = this.createDiagnosticRef("parse_trace", {
      endpoint: "getFriendFeedsBestEffort",
      cursor,
      num
    });
    try {
      const res = await this.getFriendFeeds(cursor, num, { fastMode: options?.fastMode });
      if (Number(res.code ?? -1) !== 0) {
        const kind = this.getApiFailureKind(res);
        return this.sdkFailure(
          kind === "auth" || kind === "rate_limit" ? kind : "parse_miss",
          kind === "rate_limit",
          "best_effort",
          { endpoint: "getFriendFeedsBestEffort", message: String(res.message ?? "friend feeds unavailable") },
          this.inferSdkSource(res._source ?? res._page_info?.source, "feeds3_html"),
          [],
          diagnostic
        );
      }
      return this.sdkSuccess(
        {
          posts: Array.isArray(res.msglist) ? res.msglist : [],
          nextCursor: typeof res.next_cursor === "string" ? res.next_cursor : void 0,
          hasMore: Boolean(res.has_more ?? res.next_cursor)
        },
        this.inferSdkSource(res._source ?? res._page_info?.source, "feeds3_html"),
        "best_effort",
        [],
        diagnostic
      );
    } catch (error) {
      const failure = this.classifySdkFailure(error, "getFriendFeedsBestEffort");
      failure.diagnostic = diagnostic;
      return failure;
    }
  }
  async uploadImage(imageBase64, albumId) {
    this.requireLogin();
    const albumtype = albumId ? 0 : 7;
    const refer = albumId ? "album" : "shuoshuo";
    let lastError;
    for (let attempt = 0; attempt <= UPLOAD_IMAGE_RETRY_COUNT; attempt++) {
      try {
        const params = new URLSearchParams({
          qzreferrer: this.getQzreferrer(),
          filename: "filename",
          zzpanelkey: "",
          qzonetoken: "",
          uploadtype: "1",
          albumtype: String(albumtype),
          exttype: "0",
          refer,
          output_type: "jsonhtml",
          charset: "utf-8",
          output_charset: "utf-8",
          upload_hd: "1",
          hd_width: "2048",
          hd_height: "10000",
          hd_quality: "96",
          backUrls: "http://upbak.photo.qzone.qq.com/cgi-bin/upload/cgi_upload_image",
          url: `https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=${this.getGtk()}`,
          base64: "1",
          skey: this.cookies["skey"] ?? "",
          zzpaneluin: this.qqNumber,
          uin: this.qqNumber,
          p_skey: this.cookies["p_skey"] ?? "",
          jsonhtml_callback: "callback",
          p_uin: this.qqNumber,
          picfile: imageBase64
        });
        if (albumId) params.set("albumid", albumId);
        const url = `https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=${this.getGtk()}`;
        const resp = await this.post(url, { data: params });
        if (resp.status >= 400) throw new Error(`\u56FE\u7247\u4E0A\u4F20 HTTP ${resp.status}`);
        const html = resp.text;
        try {
          const parsed = parseJsonp(html, "callback");
          if (parsed && typeof parsed === "object") {
            const dataObj = parsed["data"];
            if (dataObj && typeof dataObj === "object" && ("lloc" in dataObj || "albumid" in dataObj)) {
              return dataObj;
            }
            if ("lloc" in parsed || "albumid" in parsed) return parsed;
          }
        } catch {
        }
        const jsonMatch = html.match(/\{[^{}]*"albumid"[^{}]*\}/s);
        if (jsonMatch) {
          try {
            const c = JSON.parse(jsonMatch[0]);
            if (c.lloc || c.albumid) return c;
          } catch {
          }
        }
        try {
          const si = html.indexOf('"data"') + 7;
          const ei = html.indexOf('"ret"') - 1;
          if (si >= 7 && ei > si) {
            const s = html.slice(si, ei).replace(/,\s*$/, "").trim();
            return JSON.parse(s);
          }
        } catch {
        }
        throw new Error(`\u56FE\u7247\u4E0A\u4F20\u89E3\u6790\u5931\u8D25\uFF0C\u54CD\u5E94\u5185\u5BB9: ${html.slice(0, 300)}`);
      } catch (error) {
        lastError = error;
        if (attempt >= UPLOAD_IMAGE_RETRY_COUNT) break;
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  // ──────────────────────────────────────────────
  // Publish
  // ──────────────────────────────────────────────
  async publish(content = "", images, whoCanSee) {
    this.requireLogin();
    content = convertNamesToEmojis(content);
    const picId = [];
    let data2;
    if (!images || images.length === 0) {
      data2 = {
        syn_tweet_version: 1,
        paramstr: 1,
        pic_template: "",
        richtype: "",
        richval: "",
        special_url: "",
        subrichtype: "",
        con: content,
        feedversion: 1,
        ver: 1,
        ugc_right: 1,
        to_sign: 0,
        hostuin: this.qqNumber,
        code_version: 1,
        format: "fs",
        qzreferrer: this.getQzreferrer()
      };
    } else {
      const uploadLimit = pLimit(PUBLISH_IMAGE_UPLOAD_CONCURRENCY);
      const uploaded = await Promise.all(images.map((image, index) => uploadLimit(async () => {
        try {
          const ret = await this.uploadImage(image);
          return { index, ret };
        } catch (exc) {
          throw new Error(`\u7B2C ${index + 1}/${images.length} \u5F20\u56FE\u7247\u4E0A\u4F20\u5931\u8D25: ${exc}`);
        }
      })));
      const richval = [];
      const picBo = [];
      for (const { ret } of uploaded) {
        const albumid = ret.albumid ?? "";
        const lloc = ret.lloc ?? "";
        const sloc = ret.sloc ?? lloc;
        const picType = ret.type ?? "0";
        const height = ret.height ?? 0;
        const width = ret.width ?? 0;
        richval.push(`,${albumid},${lloc},${sloc},${picType},${height},${width},,${height},${width}`);
        const preUrl = ret.pre ?? "";
        const boIdx = preUrl.indexOf("bo=");
        if (boIdx !== -1) {
          const boStart = boIdx + 3;
          const boEnd = preUrl.indexOf("&", boStart);
          picBo.push(boEnd !== -1 ? preUrl.slice(boStart, boEnd) : preUrl.slice(boStart));
        }
        picId.push(lloc);
      }
      data2 = {
        syn_tweet_version: 1,
        paramstr: 1,
        pic_template: `tpl-${images.length}-1`,
        richtype: 1,
        richval: richval.join("	"),
        special_url: "",
        subrichtype: 1,
        con: content,
        feedversion: 1,
        ver: 1,
        ugc_right: 1,
        to_sign: 0,
        hostuin: this.qqNumber,
        code_version: 1,
        format: "fs",
        qzreferrer: this.getQzreferrer(),
        pic_bo: picBo.length > 0 ? `{0}	{0}`.replace("{0}", picBo.join(",")) : ""
      };
    }
    if (whoCanSee !== void 0) {
      data2["who_can_see"] = whoCanSee;
      if (whoCanSee === 2) data2["secret"] = 1;
    }
    const url = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${this.getGtk()}`;
    const resp = await this.post(url, { data: new URLSearchParams(data2) });
    const result = safeDecodeJsonResponse(resp.data);
    const dataObj = typeof result["data"] === "object" && result["data"] ? result["data"] : {};
    const tid = result["t1_tid"] ?? result["tid"] ?? dataObj["tid"];
    if (!tid) {
      throw new Error(`\u53D1\u5E03\u8BF4\u8BF4\u672A\u8FD4\u56DE tid: code=${result["code"]}, message=${String(result["message"]).slice(0, 200)}`);
    }
    return [String(tid), picId];
  }
  // ──────────────────────────────────────────────
  // Social actions
  // ──────────────────────────────────────────────
  async deleteEmotion(tid, topicId = "") {
    this.requireLogin();
    const url = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delete_v6?g_tk=${this.getGtk()}`;
    const resp = await this.post(url, {
      data: new URLSearchParams({ hostuin: this.qqNumber, tid, topicId, code_version: "1", format: "json", qzreferrer: this.getQzreferrer() })
    });
    const result = parseJsonp(resp.text);
    validateApiResponse("social_action", result, resp.text);
    return result;
  }
  /** appid=311 用 /mood/ 路径；其他 app 分享传入实际 unikey（从 feeds3 HTML 提取）才准确 */
  buildUnikey(ouin, tid, appid) {
    return appid === 311 ? `http://user.qzone.qq.com/${ouin}/mood/${tid}` : `http://user.qzone.qq.com/${ouin}/app/${tid}`;
  }
  /**
   * 给帖子点赞。缺失参数时自动从 postMetaCache 补全。
   */
  async likeEmotion(ouin, tid, abstime, appid = 0, typeid = 0, unikeyOverride, curkeyOverride) {
    this.requireLogin();
    const meta = this.getPostMeta(tid);
    if (meta) {
      if (!ouin && meta.uin) ouin = meta.uin;
      if (!appid && meta.appid) appid = Number(meta.appid) || 311;
      if (!typeid && meta.typeid) typeid = Number(meta.typeid) || 0;
      if (!abstime && meta.abstime) abstime = meta.abstime;
      if (!unikeyOverride && meta.likeUnikey) unikeyOverride = meta.likeUnikey;
      if (!curkeyOverride && meta.likeCurkey) curkeyOverride = meta.likeCurkey;
    }
    if (!appid) appid = 311;
    const unikey = unikeyOverride || this.buildUnikey(ouin, tid, appid);
    const curkey = curkeyOverride || unikey;
    try {
      const url1 = `https://user.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?g_tk=${this.getGtk()}`;
      const resp1 = await this.post(url1, {
        data: new URLSearchParams({
          qzreferrer: this.getQzreferrer(),
          opuin: this.qqNumber,
          unikey,
          curkey,
          appid: String(appid),
          typeid: String(typeid),
          fid: tid,
          from: "1",
          active: "0",
          fupdate: "1",
          abstime: String(abstime),
          format: "json"
        }),
        headers: this.pcHeaders(this.getQzreferrer())
      });
      const p1 = safeDecodeJsonResponse(resp1.data);
      if (p1["ret"] === 0 || p1["code"] === 0 && (p1["http_status"] ?? 0) < 400) return p1;
    } catch {
    }
    try {
      const url2 = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/like_cgi_likev6?g_tk=${this.getGtk()}`;
      const resp2 = await this.post(url2, {
        data: new URLSearchParams({ opuin: this.qqNumber, ouin, fid: tid, abstime: String(abstime), appid: String(appid), typeid: String(typeid), key: "", format: "json", qzreferrer: this.getQzreferrer() })
      });
      const p2 = parseJsonp(resp2.text, "_Callback");
      if (p2["code"] === 0 || p2["ret"] === 0) return p2;
    } catch {
    }
    return this.likeMobileFeed(ouin, tid, appid, typeid, 0);
  }
  async unlikeEmotion(ouin, tid, abstime, appid = 0, typeid = 0, unikeyOverride, curkeyOverride) {
    this.requireLogin();
    const meta = this.getPostMeta(tid);
    if (meta) {
      if (!ouin && meta.uin) ouin = meta.uin;
      if (!appid && meta.appid) appid = Number(meta.appid) || 311;
      if (!typeid && meta.typeid) typeid = Number(meta.typeid) || 0;
      if (!abstime && meta.abstime) abstime = meta.abstime;
      if (!unikeyOverride && meta.likeUnikey) unikeyOverride = meta.likeUnikey;
      if (!curkeyOverride && meta.likeCurkey) curkeyOverride = meta.likeCurkey;
    }
    if (!appid) appid = 311;
    const unikey = unikeyOverride || this.buildUnikey(ouin, tid, appid);
    const curkey = curkeyOverride || unikey;
    const url1 = `https://user.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?g_tk=${this.getGtk()}`;
    const resp1 = await this.post(url1, {
      data: new URLSearchParams({ qzreferrer: this.getQzreferrer(), opuin: this.qqNumber, unikey, curkey, appid: String(appid), typeid: String(typeid), fid: tid, from: "1", active: "0", fupdate: "1", format: "json" }),
      headers: this.pcHeaders(this.getQzreferrer())
    });
    const p1 = safeDecodeJsonResponse(resp1.data);
    if (p1["ret"] === 0 || p1["code"] === 0 && (p1["http_status"] ?? 0) < 400) return p1;
    const url2 = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/like_cgi_likev6?g_tk=${this.getGtk()}`;
    const resp2 = await this.post(url2, {
      data: new URLSearchParams({ opuin: this.qqNumber, ouin, fid: tid, abstime: String(abstime), appid: String(appid), typeid: String(typeid), optype: "1", format: "json", qzreferrer: this.getQzreferrer() })
    });
    const p2 = safeDecodeJsonResponse(resp2.data);
    if (p2["code"] === 0) return p2;
    return this.likeMobileFeed(ouin, tid, appid, typeid, 1);
  }
  async likeMobileFeed(friendUin, cellid, appid = 311, typeid = 0, active = 0) {
    this.requireLogin();
    const unikey = `http://user.qzone.qq.com/${friendUin}/mood/${cellid}`;
    const url = `https://mobile.qzone.qq.com/like?g_tk=${this.getGtk()}`;
    const resp = await this.post(url, {
      data: new URLSearchParams({ unikey, curkey: unikey, appid: String(appid), typeid: String(typeid), active: String(active), fupdate: "1" }),
      headers: this.mobileHeaders()
    });
    return safeDecodeJsonResponse(resp.data);
  }
  async commentEmotion(ouin, tid, content, replyCommentId, replyUin, appid = 0, abstime = 0) {
    this.requireLogin();
    content = convertNamesToEmojis(content);
    const meta = this.getPostMeta(tid);
    if (meta) {
      if (!ouin && meta.uin) ouin = meta.uin;
      if (!appid && meta.appid) appid = Number(meta.appid) || 311;
      if (!abstime && meta.abstime) abstime = meta.abstime;
    }
    if (!appid) appid = 311;
    let finalContent = content;
    if (replyCommentId && replyUin) {
      let nick;
      if (replyUin === this.qqNumber) {
        nick = this.getNicknameFromCookie() || replyUin;
      } else {
        const friendInfo = this.friendCache.get(replyUin);
        nick = friendInfo?.nickname || replyUin;
      }
      if (!content.startsWith("@{")) {
        finalContent = `@{uin:${replyUin},nick:${nick},auto:1} ${content}`;
      }
    }
    const qzRef = this.getQzreferrer();
    const headers = this.pcHeaders(qzRef);
    const userReFeeds = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${this.getGtk()}`;
    const userParams = {
      hostUin: ouin,
      topicId: `${ouin}_${tid}`,
      content: finalContent,
      format: "json",
      qzreferrer: qzRef
    };
    if (replyCommentId && replyUin) {
      userParams["commentId"] = replyCommentId;
      userParams["replyUin"] = replyUin;
      userParams["commentUin"] = replyUin;
    }
    log("DEBUG", `commentEmotion: try user re_feeds topicId=${userParams.topicId} reply=${replyCommentId ? "yes" : "no"} content=${finalContent.substring(0, 40)}...`);
    const respUser = await this.post(userReFeeds, {
      data: new URLSearchParams(userParams),
      headers
    });
    const pUser = safeDecodeJsonResponse(respUser.data);
    const okUser = pUser["code"] === 0 || pUser["ret"] === 0;
    if (okUser) return pUser;
    const h5Url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${this.getGtk()}`;
    const data2 = {
      topicId: `${ouin}_${tid}__1`,
      feedsType: "100",
      inCharset: "utf-8",
      outCharset: "utf-8",
      plat: "qzone",
      source: "ic",
      hostUin: ouin,
      isSignIn: "",
      platformid: "50",
      uin: this.qqNumber,
      format: "fs",
      ref: "feeds",
      content: finalContent,
      richval: "",
      richtype: "",
      private: "0",
      paramstr: replyCommentId && replyUin ? "2" : "1",
      qzreferrer: qzRef
    };
    if (replyCommentId && replyUin) {
      data2["commentId"] = replyCommentId;
      data2["commentUin"] = replyUin;
      data2["t1_uin"] = ouin;
      data2["t1_tid"] = tid;
      data2["t2_uin"] = replyUin;
      data2["t2_tid"] = replyCommentId;
    }
    log("DEBUG", `commentEmotion: fallback h5 topicId=${data2.topicId} paramstr=${data2.paramstr}`);
    const resp = await this.post(h5Url, {
      data: new URLSearchParams(data2),
      headers
    });
    return safeDecodeJsonResponse(resp.data);
  }
  async deleteComment(uin, tid, commentId, commentUin) {
    this.requireLogin();
    if (this.routes["delete_comment"] === "mobile") {
      const url2 = `https://mobile.qzone.qq.com/del_comment?g_tk=${this.getGtk()}`;
      const resp2 = await this.post(url2, {
        data: new URLSearchParams({ cellid: tid, comment_id: commentId, format: "json" }),
        headers: this.mobileHeaders()
      });
      return safeDecodeJsonResponse(resp2.data);
    }
    const topicId = `${uin}_${tid}`;
    const snsData = {
      inCharset: "utf-8",
      outCharset: "utf-8",
      plat: "qzone",
      source: "ic",
      hostUin: uin,
      uin,
      topicId,
      feedsType: "100",
      commentId,
      commentUin: commentUin ?? uin,
      format: "fs",
      ref: "feeds",
      paramstr: "2",
      qzreferrer: this.getQzreferrer()
    };
    try {
      const snsUrl = `https://sns.qzone.qq.com/cgi-bin/qzshare/cgi_qzsharedeletecomment?&g_tk=${this.getGtk()}`;
      const snsResp = await this.post(snsUrl, {
        data: new URLSearchParams(snsData),
        headers: this.pcHeaders(this.getQzreferrer())
      });
      const snsResult = parseJsonp(snsResp.text);
      const ret = snsResult["ret"] ?? snsResult["code"];
      if (ret === 0) return { code: 0, message: snsResult["msg"] ?? "ok", ...snsResult };
    } catch {
    }
    const url = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delcomment_ugc?g_tk=${this.getGtk()}`;
    const resp = await this.post(url, {
      data: new URLSearchParams({ hostuin: this.qqNumber, uin, tid, comment_id: commentId, format: "json", qzreferrer: this.getQzreferrer() })
    });
    return parseJsonp(resp.text);
  }
  async forwardEmotion(ouin, tid, content = "") {
    this.requireLogin();
    const topicId = `${ouin}_${tid}`;
    const url = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_forward_v6?g_tk=${this.getGtk()}`;
    const resp = await this.post(url, {
      data: new URLSearchParams({ tid, ouin, opuin: this.qqNumber, hostUin: ouin, topicId, con: content || "\u8F6C\u53D1", feedversion: "1", ver: "1", code_version: "1", appid: "311", format: "json", qzreferrer: this.getQzreferrer() })
    });
    const p = safeDecodeJsonResponse(resp.data);
    if (p["code"] === 0) return p;
    const resp2 = await this.post(
      `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${this.getGtk()}`,
      { data: new URLSearchParams({ hostUin: ouin, topicId, content: content || "\u8F6C\u53D1", forward: "1", format: "json", qzreferrer: this.getQzreferrer() }) }
    );
    return safeDecodeJsonResponse(resp2.data);
  }
  // ──────────────────────────────────────────────
  // User / Social info
  // ──────────────────────────────────────────────
  async getUserInfo(uin) {
    this.requireLogin();
    const url = `https://user.qzone.qq.com/proxy/domain/r.qzone.qq.com/cgi-bin/user/cgi_personal_card?uin=${uin}&g_tk=${this.getGtk()}`;
    const resp = await this.get(url);
    const result = safeDecodeJsonResponse(resp.data, "_Callback");
    validateApiResponse("user_info", result, resp.text);
    return result;
  }
  async getFriendList(start = 0, num = 50) {
    this.requireLogin();
    const selfUin = this.qqNumber;
    try {
      const url = `https://user.qzone.qq.com/proxy/domain/r.qzone.qq.com/cgi-bin/qzone/cgi_get_friend_list?g_tk=${this.getGtk()}&uin=${selfUin}&start=${start}&num=${num}&format=json`;
      const resp = await this.get(url);
      log("DEBUG", `getFriendList raw (${resp.text.length} bytes): ${resp.text.substring(0, 300)}`);
      const parsed = parseJsonp(resp.text, "_Callback");
      if (parsed && parsed.code === 0) {
        const data2 = parsed.data;
        const items2 = data2?.items ?? parsed.items;
        if (Array.isArray(items2) && items2.length > 0) {
          const list = items2.map((f) => ({
            uin: String(f["uin"] ?? f["fuin"] ?? ""),
            nickname: String(f["nickname"] ?? f["name"] ?? f["remark"] ?? ""),
            avatar: String(f["figureurl"] ?? f["logimg"] ?? f["avatar"] ?? "")
          })).filter((f) => f.uin && f.uin !== selfUin);
          if (list.length) {
            this.mergeFriendCache(list);
            return {
              code: 0,
              message: "ok",
              data: { items: list, total: list.length, source: "api" }
            };
          }
        }
      }
    } catch (e) {
      log("DEBUG", `getFriendList API failed: ${e}`);
    }
    try {
      const extracted = await this.extractFriendsFromFeeds3(3);
      if (extracted.length) this.mergeFriendCache(extracted);
      const fromCache2 = Array.from(this.friendCache.values()).filter((f) => f.uin !== selfUin);
      const items2 = fromCache2.sort((a, b) => b.lastSeen - a.lastSeen).slice(start, start + num).map((f) => ({ uin: f.uin, nickname: f.nickname, avatar: f.avatar }));
      if (items2.length || fromCache2.length) {
        return {
          code: 0,
          message: "ok",
          data: { items: items2, total: fromCache2.length, source: "feeds3" }
        };
      }
    } catch (e) {
      log("WARNING", `getFriendList feeds3 failed: ${e}`);
    }
    const usePlaywright = env.friendPlaywright;
    if (usePlaywright) {
      try {
        const pwList = await this.getFriendListViaPlaywright();
        if (pwList && pwList.length) {
          this.mergeFriendCache(pwList);
          const fromCache2 = Array.from(this.friendCache.values()).filter((f) => f.uin !== selfUin);
          const items2 = fromCache2.sort((a, b) => b.lastSeen - a.lastSeen).slice(start, start + num).map((f) => ({ uin: f.uin, nickname: f.nickname, avatar: f.avatar }));
          return {
            code: 0,
            message: "ok",
            data: { items: items2, total: fromCache2.length, source: "playwright" }
          };
        }
      } catch (e) {
        log("WARNING", `getFriendList Playwright failed: ${e}`);
      }
    }
    const fromCache = Array.from(this.friendCache.values()).filter((f) => f.uin !== selfUin);
    const items = fromCache.sort((a, b) => b.lastSeen - a.lastSeen).slice(start, start + num).map((f) => ({ uin: f.uin, nickname: f.nickname, avatar: f.avatar }));
    return {
      code: 0,
      message: fromCache.length ? "ok (cache only)" : "no friends",
      data: { items, total: fromCache.length, source: "feeds3" }
    };
  }
  /**
   * 可选：Playwright 打开好友管理页提取完整好友列表。受 cooldown 限制。
   */
  async getFriendListViaPlaywright() {
    const now2 = Date.now() / 1e3;
    if (now2 - this.playwrightFailTime < this.playwrightCooldown) return null;
    this.requireLogin();
    const uin = this.qqNumber;
    const pw = await launchPlaywright();
    if (!pw) return null;
    log("INFO", "Playwright fetching friend list...");
    let browser = pw.browser;
    try {
      const ctx = await browser.newContext({
        userAgent: _QzoneClient.UA,
        viewport: { width: 1280, height: 800 }
      });
      const cookieArray = [];
      for (const [name, value] of Object.entries(this.cookies)) {
        for (const domain of [".qq.com", ".qzone.qq.com"]) {
          cookieArray.push({ name, value, domain, path: "/" });
        }
      }
      await ctx.addCookies(cookieArray);
      const page = await ctx.newPage();
      const url = `https://user.qzone.qq.com/${uin}/friends/manage`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 3e4 });
      await page.waitForTimeout(5e3);
      const list = await page.$$eval(
        '[class*="friend"] a[href*="qzone.qq.com"]',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (links) => {
          const seen = /* @__PURE__ */ new Set();
          const result = [];
          for (const a of links) {
            const href = a.href || "";
            const match = href.match(/qzone\.qq\.com\/(\d+)/);
            if (!match) continue;
            const uin2 = match[1];
            if (uin2 === "0" || seen.has(uin2)) continue;
            seen.add(uin2);
            const nickname = (a.textContent || "").trim();
            const img = a.querySelector("img");
            const avatar = img ? img.src || "" : "";
            result.push({ uin: uin2, nickname, avatar });
          }
          return result;
        }
      );
      await ctx.close();
      if (browser) await browser.close();
      browser = null;
      if (list.length) {
        log("INFO", `Playwright friend list: ${list.length} friends`);
        return list;
      }
      this.playwrightFailTime = Date.now() / 1e3;
      return null;
    } catch (exc) {
      log("WARNING", `Playwright friend list failed: ${exc}`);
      this.playwrightFailTime = Date.now() / 1e3;
      if (browser) try {
        await browser.close();
      } catch {
      }
      return null;
    }
  }
  async getVisitorList(uin) {
    this.requireLogin();
    const targetUin = uin ?? this.qqNumber;
    const url = `https://user.qzone.qq.com/proxy/domain/g.qzone.qq.com/cgi-bin/cgi_right_get_visitor_more?g_tk=${this.getGtk()}&uin=${targetUin}&mask=7&format=json`;
    const resp = await this.get(url);
    const result = parseJsonp(resp.text, "_Callback");
    validateApiResponse("visitor", result, resp.text);
    return result;
  }
  async getLikeList(uin, tid) {
    return this.getLikeListBestEffort(uin, tid);
  }
  // ──────────────────────────────────────────────
  // Traffic data (qz_opcnt2) — 参考 OpenCamwall
  // ──────────────────────────────────────────────
  /**
   * 获取说说的流量统计数据（点赞/浏览/评论/转发次数）。
   * API: r.qzone.qq.com/cgi-bin/user/qz_opcnt2
   */
  async getTrafficData(uin, tid) {
    const stp = Date.now();
    const unikey = `http://user.qzone.qq.com/${uin}/mood/${tid}`;
    const url = `https://user.qzone.qq.com/proxy/domain/r.qzone.qq.com/cgi-bin/user/qz_opcnt2?_stp=${stp}&unikey=${encodeURIComponent(unikey)}&face=0&fupdate=1&g_tk=${this.getGtk()}`;
    const resp = await this.get(url, { headers: this.pcHeaders(this.getQzreferrer()) });
    const parsed = parseJsonp(resp.text, "_Callback");
    validateApiResponse("traffic_data", parsed, resp.text);
    const dataArr = parsed["data"];
    if (!dataArr || !dataArr.length) return { like: -1, read: -1, comment: -1, forward: -1 };
    const current = dataArr[0]?.["current"];
    const newdata = current?.["newdata"];
    if (!newdata || !("LIKE" in newdata)) return { like: -1, read: -1, comment: -1, forward: -1 };
    return {
      like: Number(newdata["LIKE"] ?? -1),
      read: Number(newdata["PRD"] ?? -1),
      comment: Number(newdata["CS"] ?? -1),
      forward: Number(newdata["ZS"] ?? -1)
    };
  }
  // ──────────────────────────────────────────────
  // Privacy (emotion_cgi_update) — 参考 OpenCamwall
  // ──────────────────────────────────────────────
  /**
   * 设置说说的隐私权限（公开/私密）。
   * ugc_right: 1=公开，64=私密
   */
  async setEmotionPrivacy(tid, privacy) {
    this.requireLogin();
    const detail = await this.getShuoshuoDetail(this.qqNumber, tid);
    const content = String(detail["content"] ?? detail["con"] ?? "");
    const body = {
      syn_tweet_verson: "1",
      tid,
      paramstr: "1",
      pic_template: "",
      richtype: "",
      richval: "",
      special_url: "",
      subrichtype: "",
      con: content,
      feedversion: "1",
      ver: "1",
      ugc_right: privacy === "private" ? "64" : "1",
      to_sign: "0",
      ugcright_id: tid,
      hostuin: this.qqNumber,
      code_version: "1",
      format: "fs",
      qzreferrer: this.getQzreferrer()
    };
    const pics = detail["pic"];
    if (pics && pics.length > 0) {
      const richvals = [];
      const picBos = [];
      for (const pic of pics) {
        const picId = String(pic["pic_id"] ?? "").split(",");
        if (picId.length >= 3) {
          richvals.push(`,${picId[1]},${picId[2]},${picId[2]},${pic["pictype"] ?? 0},${pic["height"] ?? 0},${pic["width"] ?? 0},,0,0`);
        }
        const smallurl = String(pic["smallurl"] ?? pic["url1"] ?? "");
        const boMatch = smallurl.match(/bo=([^&]+)/);
        if (boMatch) picBos.push(boMatch[1]);
      }
      if (richvals.length) {
        body["richtype"] = "1";
        body["subrichtype"] = "1";
        body["richval"] = richvals.join("	");
        body["pic_bo"] = picBos.join("	");
      }
    }
    const url = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_update?g_tk=${this.getGtk()}`;
    const resp = await this.post(url, {
      data: new URLSearchParams(body),
      headers: this.pcHeaders(this.getQzreferrer())
    });
    return safeDecodeJsonResponse(resp.data);
  }
  // ──────────────────────────────────────────────
  // Portrait / Nickname — 参考 OpenCamwall
  // ──────────────────────────────────────────────
  /**
   * 通过 cgi_get_portrait.fcg 获取用户头像和昵称。
   * 响应编码为 GBK，JSONP 回调为 portraitCallBack。
   */
  async getPortrait(uin) {
    const url = `https://r.qzone.qq.com/fcg-bin/cgi_get_portrait.fcg?uins=${uin}`;
    const resp = await this.get(url);
    let text;
    if (resp.data instanceof Buffer || resp.data instanceof Uint8Array) {
      const decoder = new TextDecoder("gbk");
      text = decoder.decode(resp.data);
    } else {
      text = resp.text;
    }
    const jsonStr = text.replace(/^portraitCallBack\(/, "").replace(/\)\s*$/, "");
    try {
      const data2 = JSON.parse(jsonStr);
      const arr = data2[String(uin)];
      if (Array.isArray(arr)) {
        return {
          nickname: String(arr[6] ?? ""),
          avatarUrl: String(arr[0] ?? "")
        };
      }
    } catch (e) {
      log("WARNING", `getPortrait parse failed: ${e}`);
    }
    return { nickname: "", avatarUrl: "" };
  }
  /**
   * 从 Cookie 中提取昵称（ptnick_qq 字段，值为 hex 编码的 UTF-8 或 URL 编码）。
   * 仅粘贴 p_skey 等、未带 ptnick 时多为空。
   */
  getNicknameFromCookieForUin(uin) {
    if (!uin) return "";
    const raw = this.cookies[`ptnick_${uin}`];
    if (!raw) return "";
    try {
      if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
        const bytes = Buffer.from(raw, "hex");
        return bytes.toString("utf8");
      }
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  getNicknameFromCookie() {
    return this.qqNumber ? this.getNicknameFromCookieForUin(this.qqNumber) : "";
  }
  /**
   * 从 cgi_personal_card（getUserInfo）JSON 中抽取展示昵称；字段随腾讯改版可能变化，做多键兜底。
   */
  extractNicknameFromPersonalCard(p) {
    const tryObj = (obj, keys) => {
      if (!obj) return "";
      for (const k of keys) {
        const v = obj[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return "";
    };
    if (!p || typeof p !== "object") return "";
    const o = p;
    let s = tryObj(o, ["nickname", "nick", "user_name", "username", "userName"]);
    if (s) return s;
    const data2 = o["data"];
    if (data2 && typeof data2 === "object" && !Array.isArray(data2)) {
      const d = data2;
      s = tryObj(d, ["nickname", "nick", "user_name", "username", "userName"]);
      if (s) return s;
      const user = d["user"];
      if (user && typeof user === "object" && !Array.isArray(user)) {
        s = tryObj(user, ["nickname", "nick"]);
        if (s) return s;
      }
    }
    return "";
  }
  /**
   * 供 get_login_info 等使用：与 NapCat 的 QQ 资料**无关**，仅走空间侧 Cookie / 接口。
   * 顺序：ptnick → cgi_get_portrait → cgi_personal_card。
   */
  async resolveLoginNickname(uin) {
    const fromCookie = this.getNicknameFromCookieForUin(uin).trim();
    if (fromCookie) return fromCookie;
    try {
      const portrait = await this.getPortrait(uin);
      if (portrait.nickname.trim()) return portrait.nickname.trim();
    } catch {
    }
    try {
      const card = await this.getUserInfo(uin);
      const n = this.extractNicknameFromPersonalCard(card).trim();
      if (n) return n;
    } catch {
    }
    return "";
  }
  // ──────────────────────────────────────────────
  // Albums / Photos
  // ──────────────────────────────────────────────
  async getAlbumList(uin) {
    this.requireLogin();
    const targetUin = uin ?? this.qqNumber;
    const url = `https://user.qzone.qq.com/proxy/domain/photo.qzone.qq.com/cgi-bin/cgi_list_album?g_tk=${this.getGtk()}&uin=${targetUin}&hostUin=${targetUin}&inCharset=utf-8&outCharset=utf-8&format=json`;
    const resp = await this.get(url, { headers: this.pcHeaders(this.getQzreferrer()) });
    const p = safeDecodeJsonResponse(resp.data, "_Callback");
    if (!p["_empty"] && (p["http_status"] ?? 0) < 400) {
      validateApiResponse("album_list", p, resp.text);
      return p;
    }
    const url2 = `https://user.qzone.qq.com/proxy/domain/photo.qzone.qq.com/cgi-bin/cgi_list_photo?g_tk=${this.getGtk()}&uin=${targetUin}&hostUin=${targetUin}&inCharset=utf-8&outCharset=utf-8&format=json`;
    const resp2 = await this.get(url2, { headers: this.pcHeaders(this.getQzreferrer()) });
    const albumResult = safeDecodeJsonResponse(resp2.data, "_Callback");
    validateApiResponse("album_list", albumResult, resp2.text);
    return albumResult;
  }
  async getPhotoList(uin, topicId = "", num = 30) {
    this.requireLogin();
    const targetUin = uin ?? this.qqNumber;
    const url = `https://user.qzone.qq.com/proxy/domain/photo.qzone.qq.com/cgi-bin/cgi_floatview_photo_list_v2?g_tk=${this.getGtk()}&uin=${targetUin}&topicId=${topicId}&picKey=&fupdate=1&num=${num}&pageStart=0&inCharset=utf-8&outCharset=utf-8&format=json`;
    const resp = await this.get(url, { headers: this.pcHeaders(this.getQzreferrer()) });
    return safeDecodeJsonResponse(resp.data, "_Callback");
  }
  async createAlbum(name, desc = "", priv = 1) {
    this.requireLogin();
    const url = `https://user.qzone.qq.com/proxy/domain/photo.qzone.qq.com/cgi-bin/cgi_create_album?g_tk=${this.getGtk()}`;
    const resp = await this.post(url, { data: new URLSearchParams({ hostUin: this.qqNumber, albumname: name, albumdesc: desc, priv: String(priv), format: "json", qzreferrer: this.getQzreferrer() }) });
    return safeDecodeJsonResponse(resp.data, "_Callback");
  }
  async deleteAlbum(albumId) {
    this.requireLogin();
    const url = `https://user.qzone.qq.com/proxy/domain/photo.qzone.qq.com/cgi-bin/cgi_del_album?g_tk=${this.getGtk()}`;
    const resp = await this.post(url, { data: new URLSearchParams({ hostUin: this.qqNumber, topicId: albumId, format: "json", qzreferrer: this.getQzreferrer() }) });
    return safeDecodeJsonResponse(resp.data, "_Callback");
  }
  async deletePhoto(uin, albumId = "", photoId = "") {
    this.requireLogin();
    const targetUin = uin ?? this.qqNumber;
    const url = `https://user.qzone.qq.com/proxy/domain/photo.qzone.qq.com/cgi-bin/cgi_del_photo?g_tk=${this.getGtk()}`;
    const resp = await this.post(url, { data: new URLSearchParams({ hostUin: targetUin, topicId: albumId, lloc: photoId, format: "json", qzreferrer: this.getQzreferrer() }) });
    return safeDecodeJsonResponse(resp.data, "_Callback");
  }
  // ──────────────────────────────────────────────
  // API route probe
  // ──────────────────────────────────────────────
  async probeApiRoutes(uin, tid) {
    this.requireLogin();
    const gtk = this.getGtk();
    let detailPcOk = false;
    try {
      const r = parseJsonp((await this.get(`https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_getdetailv6?g_tk=${gtk}&uin=${uin}&tid=${tid}&format=json`)).text);
      detailPcOk = r != null && ("code" in r || "msg" in r);
    } catch {
    }
    let detailMobileOk = false;
    try {
      const r = JSON.parse((await this.get(`https://mobile.qzone.qq.com/detail?g_tk=${gtk}&uin=${uin}&cellid=${tid}&format=json`, { headers: this.mobileHeaders() })).text);
      detailMobileOk = r != null && ("code" in r || "msg" in r);
    } catch {
    }
    let commentsPcOk = false;
    try {
      const r = parseJsonp((await this.get(`https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_getcmtreply_v6?g_tk=${gtk}&uin=${uin}&tid=${tid}&num=5&pos=0&format=json`)).text);
      commentsPcOk = r != null && ("code" in r || "msg" in r);
    } catch {
    }
    let commentsMobileOk = false;
    try {
      const r = JSON.parse((await this.get(`https://mobile.qzone.qq.com/get_comment_list?g_tk=${gtk}&uin=${uin}&cellid=${tid}&num=5&pos=0&format=json`, { headers: this.mobileHeaders() })).text);
      commentsMobileOk = r != null && ("code" in r || "msg" in r);
    } catch {
    }
    const discovered = {
      ...this.routes,
      detail: detailPcOk ? "pc" : detailMobileOk ? "mobile" : this.routes["detail"],
      comments: commentsPcOk ? "pc" : commentsMobileOk ? "mobile" : this.routes["comments"]
    };
    Object.assign(this.routes, discovered);
    return discovered;
  }
};

// vendor/onebot-qzone/src/bridge/actions.ts
import http from "node:http";
import https2 from "node:https";
import path3 from "node:path";
import fs4 from "node:fs";
import pLimit2 from "p-limit";

// vendor/onebot-qzone/src/bridge/utils.ts
function safeInt(val, defaultVal = 0) {
  if (val == null || val === "") return defaultVal;
  const n = Number(val);
  if (!Number.isFinite(n)) return defaultVal;
  return Math.trunc(n);
}

// vendor/onebot-qzone/src/bridge/actions.ts
var PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/,
  /^fc/,
  /^fd/,
  /^fe80/,
  /^0\.0\.0\.0$/,
  /^localhost$/i
];
function isSafeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    const host = u.hostname;
    return !PRIVATE_RANGES.some((r) => r.test(host));
  } catch {
    return false;
  }
}
var QZONE_IMAGE_HOST_SUFFIXES = [
  "qpic.cn",
  "photo.store.qq.com",
  "qlogo1.store.qq.com",
  "qlogo2.store.qq.com",
  "qzonestyle.gtimg.cn"
];
function isQzoneImageUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    return QZONE_IMAGE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith("." + suffix));
  } catch {
    return false;
  }
}
function parseMessageSegments(message) {
  if (typeof message === "string") {
    return parseCqCode(message);
  }
  if (!Array.isArray(message)) return [];
  return message.map((seg) => {
    if (typeof seg === "string") return { type: "text", data: { text: seg } };
    const s = seg;
    return {
      type: String(s["type"] ?? "text"),
      data: Object.fromEntries(
        Object.entries(s["data"] ?? {}).map(([k, v]) => [k, String(v ?? "")])
      )
    };
  });
}
function parseCqCode(raw) {
  const segs = [];
  let last = 0;
  const cqRe = /\[CQ:(\w+)((?:,[^\]]*)*)\]/g;
  let m;
  while ((m = cqRe.exec(raw)) !== null) {
    if (m.index > last) segs.push({ type: "text", data: { text: raw.slice(last, m.index) } });
    const type = m[1];
    const params = {};
    for (const kv of (m[2] ?? "").split(",").filter(Boolean)) {
      const eq = kv.indexOf("=");
      if (eq !== -1) params[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
    }
    segs.push({ type, data: params });
    last = m.index + m[0].length;
  }
  if (last < raw.length) segs.push({ type: "text", data: { text: raw.slice(last) } });
  return segs;
}
function ok(data2 = null, echo) {
  return { status: "ok", retcode: 0, data: data2, echo };
}
function normalizeCommentTreeForTool(it) {
  if (!it || typeof it !== "object") return it;
  const o = { ...it };
  if (!Array.isArray(o.pic)) o.pic = [];
  if (typeof o._source === "string" && o.parser_cell_source === void 0) {
    o.parser_cell_source = o._source;
  }
  if (Array.isArray(o.replies)) {
    o.replies = o.replies.map(normalizeCommentTreeForTool);
  }
  return o;
}
function enrichGetCommentListPayload(res) {
  const out = { ...res };
  if (typeof out._source === "string" && out.comment_data_source === void 0) {
    out.comment_data_source = out._source;
  }
  const t = out._feeds3_total;
  if (typeof t === "number" && out.feeds3_comment_total === void 0) {
    out.feeds3_comment_total = t;
  } else if (typeof t === "string" && t !== "" && out.feeds3_comment_total === void 0) {
    const n = Number(t);
    if (Number.isFinite(n)) out.feeds3_comment_total = n;
  }
  if (typeof out.comment_data_source === "string") {
    out.commentListSource = out.comment_data_source;
  }
  if (typeof out.feeds3_comment_total === "number") {
    out.commentListTotal = out.feeds3_comment_total;
  }
  for (const key of ["commentlist", "comment_list", "comments"]) {
    const arr = out[key];
    if (Array.isArray(arr)) {
      out[key] = arr.map((x) => normalizeCommentTreeForTool(x));
    }
  }
  const data2 = out.data;
  if (data2 && typeof data2 === "object") {
    const d = { ...data2 };
    let touched = false;
    for (const key of ["commentlist", "comment_list", "comments", "list"]) {
      const arr = d[key];
      if (Array.isArray(arr)) {
        d[key] = arr.map((x) => normalizeCommentTreeForTool(x));
        touched = true;
      }
    }
    if (touched) out.data = d;
  }
  return out;
}
function fail(retcode, msg, echo) {
  return { status: "failed", retcode, data: null, message: msg, echo };
}
function sdkFailureRetcode(kind) {
  switch (kind) {
    case "auth":
      return 1401;
    case "rate_limit":
      return 1429;
    case "not_supported":
      return 1404;
    case "parse_miss":
      return 1502;
    case "upstream_changed":
      return 1503;
    default:
      return 1500;
  }
}
function withSdkMeta(base, result) {
  const out = { ...base };
  if (typeof result["source"] === "string") out.source = result["source"];
  if (typeof result["reliability"] === "string") out.reliability = result["reliability"];
  if (Array.isArray(result["warnings"])) out.warnings = result["warnings"];
  const diagnostic = result["diagnostic"];
  if (diagnostic && typeof diagnostic === "object" && typeof diagnostic["diagnostic_id"] === "string") {
    out.diagnostic_id = diagnostic["diagnostic_id"];
  }
  return out;
}
function formatTimestampToReadable2(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const ms = ts < 1e12 ? ts * 1e3 : ts;
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").slice(0, 16);
}
var MAX_IMAGE_DATA_PER_POST = 5;
var MAX_IMAGE_DATA_PER_RESPONSE = 20;
var SEND_IMAGE_FETCH_CONCURRENCY = 3;
var SEND_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
var SEND_IMAGE_FETCH_RETRIES = 2;
function isSupportedImageBuffer(buffer) {
  if (buffer.length < 12) return false;
  if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return true;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return true;
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return true;
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return true;
  if (buffer.subarray(0, 2).toString("ascii") === "BM") return true;
  return false;
}
function ensureReadableTimeOnMsglist(res) {
  const msglist = res["msglist"] ?? res["data"]?.msglist;
  if (!Array.isArray(msglist)) return;
  for (const item of msglist) {
    const ts = Number(item["created_time"] ?? item["createdTime"] ?? 0);
    if (!ts || !Number.isFinite(ts)) continue;
    if (!item["createTime2"]) item["createTime2"] = formatTimestampToReadable2(ts);
    if (!item["createTime"] || String(item["createTime"]).match(/^\d+$/)) item["createTime"] = formatTimestampToReadable2(ts);
  }
}
function getPicUrl(entry) {
  if (typeof entry === "string" && entry.startsWith("http")) return entry;
  if (entry && typeof entry === "object" && typeof entry["url"] === "string") {
    return entry["url"];
  }
  return null;
}
var ActionHandler = class {
  constructor(client2, hub2, poller2, config2) {
    this.client = client2;
    this.hub = hub2;
    this.poller = poller2;
    this.config = config2;
  }
  async handle(action, params, echo) {
    const method = `action_${action.replace(/\./g, "_")}`;
    try {
      if (typeof this[method] === "function") {
        return await this[method](params, echo);
      }
      return fail(1404, `\u4E0D\u652F\u6301\u7684 action: ${action}`, echo);
    } catch (err) {
      return fail(1500, err instanceof Error ? err.message : String(err), echo);
    }
  }
  // ── meta ────────────────────────────────────
  async action_get_login_info(_p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const uin = this.client.qqNumber;
    const nickname = await this.client.resolveLoginNickname(uin) || "QZone\u7528\u6237";
    return ok({ user_id: safeInt(uin), nickname }, echo);
  }
  async action_get_status(_p, echo) {
    const pollerStatus = this.poller.getStatus();
    return ok({
      online: this.client.loggedIn && (pollerStatus["online"] ?? false),
      good: this.client.loggedIn,
      ...pollerStatus
    }, echo);
  }
  /** 检查当前 Cookie 是否过期：执行网络探针校验，返回是否有效及 Cookie 年龄等信息 */
  async action_check_cookie(p, echo) {
    if (!this.client.loggedIn) {
      return ok({
        valid: false,
        expired: true,
        message: "\u672A\u767B\u5F55\uFF0C\u65E0 Cookie",
        cookie_age_seconds: null,
        has_p_skey: false,
        has_skey: false
      }, echo);
    }
    const now2 = Date.now();
    const cookieAgeSeconds = this.client.cookiesLastUsed ? Math.round((now2 - this.client.cookiesLastUsed.getTime()) / 1e3) : null;
    const hasPskey = !!this.client.cookies["p_skey"];
    const hasSkey = !!this.client.cookies["skey"];
    const probe = p["probe"] !== false && p["probe"] !== "0";
    let valid = false;
    if (probe) {
      valid = await this.client.validateSession();
    } else {
      valid = hasPskey && hasSkey;
    }
    return ok({
      valid,
      expired: !valid,
      message: valid ? "Cookie \u6709\u6548" : probe ? "Cookie \u5DF2\u8FC7\u671F\u6216\u63A2\u9488\u5931\u8D25\uFF0C\u5EFA\u8BAE\u91CD\u65B0\u767B\u5F55" : "\u672A\u63A2\u9488\uFF0C\u4EC5\u6839\u636E p_skey/skey \u5B58\u5728\u5224\u65AD",
      cookie_age_seconds: cookieAgeSeconds,
      has_p_skey: hasPskey,
      has_skey: hasSkey,
      qq: this.client.qqNumber ?? null
    }, echo);
  }
  async action_get_version_info(_p, echo) {
    return ok({ app_name: "qzone-bridge", app_version: "2.0.0", protocol_version: "v11" }, echo);
  }
  // ── send_msg ─────────────────────────────────
  async action_send_msg(p, echo) {
    return this.action_send_private_msg(p, echo);
  }
  async action_send_private_msg(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const segs = parseMessageSegments(p["message"]);
    let text = "";
    const imageTasks = [];
    const fetchLimit = pLimit2(SEND_IMAGE_FETCH_CONCURRENCY);
    for (const seg of segs) {
      if (seg.type === "text") text += seg.data["text"] ?? "";
      else if (seg.type === "image") {
        const source = seg.data["url"] ?? seg.data["file"] ?? "";
        imageTasks.push(fetchLimit(() => this.resolveImageBase64(source)));
      }
    }
    const images = (await Promise.all(imageTasks)).filter((image) => !!image);
    const whoCanSee = p["who_can_see"] !== void 0 ? safeInt(p["who_can_see"]) : void 0;
    const result = await this.client.publishPostStrict(text, images.length ? images : void 0, whoCanSee);
    if (!result.ok) return fail(sdkFailureRetcode(result.kind), result.details.message ?? result.kind, echo);
    return ok(withSdkMeta({
      message_id: safeInt(result.data.tid),
      tid: result.data.tid,
      pic_ids: result.data.picIds
    }, result), echo);
  }
  async action_send_group_msg(p, echo) {
    return this.action_send_private_msg(p, echo);
  }
  // ── recall / delete ───────────────────────────
  async action_delete_msg(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const tid = String(p["message_id"] ?? p["tid"] ?? "");
    if (!tid) return fail(1400, "\u7F3A\u5C11 message_id", echo);
    const result = await this.client.deletePostStrict(tid);
    if (!result.ok) return fail(sdkFailureRetcode(result.kind), result.details.message ?? result.kind, echo);
    return ok(withSdkMeta({ tid: result.data.tid }, result), echo);
  }
  // ── like ──────────────────────────────────────
  async action_send_like(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const tid = String(p["tid"] ?? "");
    if (!tid) return fail(1400, "\u7F3A\u5C11 tid", echo);
    const ouin = String(p["user_id"] ?? "");
    const abstime = safeInt(p["abstime"] ?? 0);
    const appid = safeInt(p["appid"] ?? 0);
    const typeid = safeInt(p["typeid"] ?? 0);
    const unikey = p["unikey"] ? String(p["unikey"]) : void 0;
    const curkey = p["curkey"] ? String(p["curkey"]) : void 0;
    const res = await this.client.likeEmotion(ouin, tid, abstime, appid, typeid, unikey, curkey);
    return res["code"] != null && res["code"] !== 0 ? fail(1500, String(res["message"] ?? ""), echo) : ok(null, echo);
  }
  async action_unlike(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const tid = String(p["tid"] ?? "");
    if (!tid) return fail(1400, "\u7F3A\u5C11 tid", echo);
    const ouin = String(p["user_id"] ?? "");
    const abstime = safeInt(p["abstime"] ?? 0);
    const appid = safeInt(p["appid"] ?? 0);
    const typeid = safeInt(p["typeid"] ?? 0);
    const unikey = p["unikey"] ? String(p["unikey"]) : void 0;
    const curkey = p["curkey"] ? String(p["curkey"]) : void 0;
    const res = await this.client.unlikeEmotion(ouin, tid, abstime, appid, typeid, unikey, curkey);
    return res["code"] === 0 || res["ret"] === 0 ? ok(null, echo) : fail(1500, String(res["message"] ?? ""), echo);
  }
  // ── comment ───────────────────────────────────
  async action_send_comment(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const tidRaw = String(p["target_tid"] ?? p["tid"] ?? "");
    const content = String(p["content"] ?? "");
    if (!tidRaw || !content) return fail(1400, "\u7F3A\u5C11 tid / content", echo);
    const tid = this.client.resolveTidForComments(tidRaw);
    const ouin = String(p["target_uin"] ?? p["user_id"] ?? "");
    const replyId = p["reply_comment_id"] ? String(p["reply_comment_id"]) : void 0;
    const replyUin = p["reply_uin"] ? String(p["reply_uin"]) : void 0;
    const appid = safeInt(p["appid"] ?? 0);
    const abstime = safeInt(p["abstime"] ?? 0);
    const res = await this.client.commentEmotion(ouin, tid, content, replyId, replyUin, appid, abstime);
    const r = res;
    const okComment = r["code"] === 0 || r["ret"] === 0;
    if (!okComment) {
      const hint = String(r["message"] ?? r["msg"] ?? r["submsg"] ?? "").trim() || `code=${String(r["code"])} ret=${String(r["ret"])}`;
      return fail(1500, hint || "\u8BC4\u8BBA\u5931\u8D25", echo);
    }
    let commentId;
    const feeds = String(res?.data?.feeds ?? "");
    const m = feeds.match(/data-type="commentroot"\s+data-tid="(\d+)"/g);
    if (m?.length) {
      const last = m[m.length - 1].match(/data-tid="(\d+)"/);
      if (last) commentId = last[1];
    }
    return ok(commentId ? { comment_id: commentId } : null, echo);
  }
  async action_delete_comment(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const tidRaw = String(p["tid"] ?? "");
    const commentId = String(p["comment_id"] ?? "");
    if (!tidRaw || !commentId) return fail(1400, "\u7F3A\u5C11 tid / comment_id", echo);
    const tid = this.client.resolveTidForComments(tidRaw);
    let uin = String(p["uin"] ?? p["user_id"] ?? "");
    if (!uin) {
      const meta = this.client.getPostMeta(tid);
      if (meta) uin = meta.uin;
    }
    if (!uin) return fail(1400, "\u7F3A\u5C11 uin/user_id \u4E14\u65E0\u6CD5\u4ECE\u7F13\u5B58\u8865\u5168", echo);
    const commentUin = p["comment_uin"] !== void 0 ? String(p["comment_uin"]) : void 0;
    const res = await this.client.deleteComment(uin, tid, commentId, commentUin);
    const code = res["code"];
    const ret = res["ret"];
    const okCode = code === 0 || ret === 0;
    return okCode ? ok(null, echo) : fail(1500, String(res["message"] ?? res["msg"] ?? ""), echo);
  }
  // ── forward ───────────────────────────────────
  async action_forward_msg(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const ouin = String(p["user_id"] ?? "");
    const tid = String(p["tid"] ?? "");
    const content = String(p["content"] ?? "");
    if (!ouin || !tid) return fail(1400, "\u7F3A\u5C11 user_id \u6216 tid", echo);
    const res = await this.client.forwardEmotion(ouin, tid, content);
    return res["code"] === 0 ? ok(null, echo) : fail(1500, String(res["message"] ?? ""), echo);
  }
  // ── get_msg / fetch ───────────────────────────
  async action_get_msg(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const uin = String(p["user_id"] ?? this.client.qqNumber);
    const tid = String(p["message_id"] ?? p["tid"] ?? "");
    if (!tid) return fail(1400, "\u7F3A\u5C11 message_id", echo);
    const result = await this.client.getPostDetailBestEffort(uin, tid);
    if (!result.ok) return fail(sdkFailureRetcode(result.kind), result.details.message ?? result.kind, echo);
    return ok(withSdkMeta({
      ...result.data.post,
      identity: result.data.identity
    }, result), echo);
  }
  async action_get_feed_images(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const uin = String(p["user_id"] ?? this.client.qqNumber);
    const tid = String(p["tid"] ?? p["message_id"] ?? "");
    if (!tid) return fail(1400, "\u7F3A\u5C11 tid", echo);
    const urls = await this.client.getFeedImages(uin, tid);
    return ok({ urls }, echo);
  }
  async action_get_emotion_list(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const uin = p["user_id"] ? String(p["user_id"]) : this.client.qqNumber;
    const pos = safeInt(p["pos"] ?? 0);
    const num = Math.max(1, Math.min(200, safeInt(p["num"] ?? 50)));
    const maxPages = Math.max(1, Math.min(30, safeInt(p["max_pages"] ?? p["pages"] ?? 15)));
    const cursorRaw = p["cursor"] ?? p["next_cursor"];
    const cursor = cursorRaw != null && String(cursorRaw).trim() !== "" ? String(cursorRaw).trim() : void 0;
    const result = await this.client.getPostsStrict(uin, { maxPages, cursor, pos, num });
    if (!result.ok) return fail(sdkFailureRetcode(result.kind), result.details.message ?? result.kind, echo);
    const res = withSdkMeta({
      code: 0,
      message: "ok",
      msglist: result.data.posts,
      has_more: result.data.hasMore,
      next_cursor: result.data.nextCursor
    }, result);
    if (res && typeof res === "object") {
      ensureReadableTimeOnMsglist(res);
      const includeImageData = p["include_image_data"] !== false && p["include_image_data"] !== "0";
      if (includeImageData) {
        await this.enrichMsglistWithImageData(res, MAX_IMAGE_DATA_PER_POST, MAX_IMAGE_DATA_PER_RESPONSE);
      }
    }
    return ok(res, echo);
  }
  /** ic2 feeds_html_act_all；可选 feed_owner=单 QQ 封装（=hostuin，且 uin 默认同号，模拟「在该人空间页」） */
  async action_get_feeds_html_act_all(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const login = String(this.client.qqNumber ?? "").trim();
    if (!login) return fail(1401, "\u672A\u767B\u5F55", echo);
    const feedOwnerRaw = p["feed_owner"] ?? p["owner_qq"] ?? p["owner_uin"] ?? p["space_uin"] ?? p["qq"];
    const feedOwner = feedOwnerRaw != null && String(feedOwnerRaw).trim() !== "" ? String(feedOwnerRaw).trim() : "";
    let urlUin;
    let hostUin;
    if (feedOwner) {
      hostUin = feedOwner;
      const pageUin = String(p["user_id"] ?? p["uin"] ?? p["page_uin"] ?? "").trim();
      urlUin = pageUin || feedOwner;
    } else {
      urlUin = String(p["user_id"] ?? p["uin"] ?? "").trim() || login;
      const hostUinRaw = p["host_uin"] ?? p["hostuin"];
      hostUin = hostUinRaw != null && String(hostUinRaw).trim() !== "" ? String(hostUinRaw).trim() : login;
    }
    const start0 = Math.max(0, safeInt(p["start"] ?? 0));
    const count = Math.max(1, Math.min(50, safeInt(p["count"] ?? p["num"] ?? 10)));
    const scope = p["scope"] != null && p["scope"] !== "" ? safeInt(p["scope"]) : void 0;
    const includeImageData = p["include_image_data"] === true || p["include_image_data"] === "1" || p["include_image_data"] === "true";
    const includeRawSnippet = p["include_raw_snippet"] === true || p["include_raw_snippet"] === "1";
    const allPages = p["all_pages"] === true || p["all_pages"] === "1" || p["all_pages"] === "true" || p["fetch_all"] === true || p["fetch_all"] === "1";
    const maxRounds = Math.max(1, Math.min(80, safeInt(p["max_rounds"] ?? p["max_pages"] ?? 30)));
    const clientOpts = {
      hostUin,
      count,
      scope,
      filter: p["filter"] != null ? String(p["filter"]) : void 0,
      flag: p["flag"] != null ? String(p["flag"]) : void 0,
      refresh: p["refresh"] != null ? String(p["refresh"]) : void 0,
      refer: p["refer"] != null ? String(p["refer"]) : void 0,
      includeRawSnippet
    };
    if (!allPages) {
      const res2 = await this.client.getFeedsHtmlActAll(urlUin, { ...clientOpts, start: start0 });
      if (res2 && typeof res2 === "object") {
        ensureReadableTimeOnMsglist(res2);
        if (includeImageData) {
          await this.enrichMsglistWithImageData(res2, MAX_IMAGE_DATA_PER_POST, MAX_IMAGE_DATA_PER_RESPONSE);
        }
      }
      return ok(res2, echo);
    }
    const merged = [];
    const seenTid = /* @__PURE__ */ new Set();
    let start = start0;
    let prevStart = -1;
    let lastHasMore = false;
    let truncated = false;
    let lastNextStart = start0;
    let rounds = 0;
    for (; rounds < maxRounds; rounds++) {
      if (start === prevStart) break;
      prevStart = start;
      const page = await this.client.getFeedsHtmlActAll(urlUin, { ...clientOpts, start });
      if (page["code"] != null && Number(page["code"]) !== 0) {
        return ok(page, echo);
      }
      const list = page["msglist"] ?? [];
      lastHasMore = Boolean(page["has_more"]);
      const ns = page["next_start"];
      lastNextStart = typeof ns === "number" && Number.isFinite(ns) ? ns : start + count;
      for (const m of list) {
        const tid = String(m["tid"] ?? m["cellid"] ?? "").trim();
        if (tid) {
          if (seenTid.has(tid)) continue;
          seenTid.add(tid);
        }
        merged.push(m);
      }
      if (!lastHasMore) break;
      if (list.length === 0) break;
      const nextS = typeof page["next_start"] === "number" && Number.isFinite(page["next_start"]) ? page["next_start"] : start + count;
      if (nextS <= start) break;
      start = nextS;
    }
    if (lastHasMore && rounds >= maxRounds) truncated = true;
    const res = {
      code: 0,
      message: "ok",
      msglist: merged,
      has_more: truncated ? true : lastHasMore,
      next_start: truncated ? lastNextStart : void 0,
      _page_info: {
        source: "feeds_html_act_all",
        all_pages: true,
        rounds,
        per_page_count: count,
        start_initial: start0,
        unique_items: merged.length,
        truncated_by_max_rounds: truncated,
        max_rounds: maxRounds,
        request_uin: urlUin,
        feed_owner_uin: hostUin,
        hostuin: hostUin,
        note: "\u5408\u5E76\u591A\u9875 ic2 \u52A8\u6001\uFF08\u542B\u8BF4\u8BF4\u3001\u97F3\u4E50\u5206\u4EAB\u7B49\uFF09\uFF0C\u4E0D\u6309 appid \u8FC7\u6EE4\uFF1B\u53D7 max_rounds \u4E0E\u63A5\u53E3\u9650\u5236\uFF0C\u672A\u5FC5\u662F\u5386\u53F2\u5168\u90E8"
      }
    };
    ensureReadableTimeOnMsglist(res);
    if (includeImageData && merged.length > 0) {
      await this.enrichMsglistWithImageData(res, MAX_IMAGE_DATA_PER_POST, MAX_IMAGE_DATA_PER_RESPONSE);
    }
    return ok(res, echo);
  }
  async action_get_comment_list(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const tidRaw = String(p["tid"] ?? "");
    if (!tidRaw) return fail(1400, "\u7F3A\u5C11 tid", echo);
    const tid = this.client.resolveTidForComments(tidRaw);
    let uin = p["user_id"] !== void 0 && p["user_id"] !== "" ? String(p["user_id"]) : "";
    if (!uin) {
      const meta = this.client.getPostMeta(tid);
      if (meta) uin = meta.uin;
    }
    if (!uin) uin = this.client.qqNumber;
    const num = safeInt(p["num"] ?? 20);
    const pos = safeInt(p["pos"] ?? 0);
    const fastMode = !["0", "false", "no"].includes(String(p["fast_mode"] ?? "1").toLowerCase());
    log("INFO", `get_comment_list: tidRaw=${tidRaw} -> tid=${tid} uin=${uin}`);
    const result = await this.client.getCommentsBestEffort({ uin, tid, num, pos, options: { fastMode } });
    if (!result.ok) return fail(sdkFailureRetcode(result.kind), result.details.message ?? result.kind, echo);
    const res = withSdkMeta({
      code: 0,
      message: result.data.availability === "not_embedded" ? "comment detail not embedded in html" : "ok",
      commentlist: result.data.comments,
      comment_list: result.data.comments,
      comments: result.data.comments,
      data: result.data.comments,
      availability: result.data.availability,
      identity: result.data.identity
    }, result);
    log("INFO", `get_comment_list: comments=${result.data.comments.length} availability=${result.data.availability}`);
    return ok(enrichGetCommentListPayload(res), echo);
  }
  async action_get_like_list(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const tidRaw = String(p["tid"] ?? "");
    if (!tidRaw) return fail(1400, "\u7F3A\u5C11 tid", echo);
    const tid = this.client.resolveTidForComments(tidRaw);
    let uin = p["user_id"] !== void 0 && p["user_id"] !== "" ? String(p["user_id"]) : "";
    if (!uin) {
      const meta = this.client.getPostMeta(tid);
      if (meta) uin = meta.uin;
    }
    if (!uin) uin = this.client.qqNumber;
    const result = await this.client.getLikesBestEffort(uin, tid);
    if (!result.ok) return fail(sdkFailureRetcode(result.kind), result.details.message ?? result.kind, echo);
    return ok(withSdkMeta({
      list: result.data.likes,
      likes: result.data.likes,
      availability: result.data.availability,
      identity: result.data.identity
    }, result), echo);
  }
  // ── user / social ──────────────────────────────
  async action_get_stranger_info(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const uin = String(p["user_id"] ?? "");
    if (!uin) return fail(1400, "\u7F3A\u5C11 user_id", echo);
    const res = await this.client.getUserInfo(uin);
    return ok(res, echo);
  }
  async action_get_friend_list(_p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const res = await this.client.getFriendList();
    const rawItems = res.data?.items ?? [];
    const items = rawItems.map((f) => ({
      user_id: f.uin ?? "",
      nickname: f.nickname ?? "",
      remark: "",
      avatar: f.avatar ?? "",
      _source: res.data?.source
    }));
    return ok({
      items,
      total: res.data?.total ?? 0,
      _source: res.data?.source ?? ""
    }, echo);
  }
  async action_get_visitor_list(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const uin = p["user_id"] ? String(p["user_id"]) : void 0;
    const res = await this.client.getVisitorList(uin);
    const sourceMap = { 1: "\u8BF4\u8BF4", 2: "\u65E5\u5FD7", 3: "\u76F8\u518C", 4: "\u7559\u8A00\u677F", 5: "\u4E2A\u4EBA\u4E2D\u5FC3", 6: "\u5206\u4EAB" };
    const dataObj = res["data"] ?? res;
    const items = dataObj["items"] ?? dataObj["list"] ?? [];
    if (Array.isArray(items)) {
      for (const it of items) {
        const src = Number(it["source"] ?? it["type"] ?? 0);
        it["_source_name"] = sourceMap[src] ?? "\u672A\u77E5";
      }
    }
    return ok(res, echo);
  }
  // ── traffic / privacy / portrait ──────────────
  async action_get_traffic_data(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const uin = String(p["user_id"] ?? p["uin"] ?? this.client.qqNumber);
    const tid = String(p["tid"] ?? "");
    if (!tid) return fail(1400, "\u7F3A\u5C11 tid", echo);
    const data2 = await this.client.getTrafficData(uin, tid);
    return ok(data2, echo);
  }
  async action_set_emotion_privacy(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const tid = String(p["tid"] ?? "");
    const privacy = String(p["privacy"] ?? "private");
    if (!tid) return fail(1400, "\u7F3A\u5C11 tid", echo);
    const res = await this.client.setEmotionPrivacy(tid, privacy);
    return ok(res, echo);
  }
  async action_get_portrait(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const uin = String(p["user_id"] ?? p["uin"] ?? "");
    if (!uin) return fail(1400, "\u7F3A\u5C11 user_id", echo);
    const data2 = await this.client.getPortrait(uin);
    if (data2.nickname || data2.avatarUrl) return ok(data2, echo);
    try {
      const card = await this.client.getUserInfo(uin);
      const nickname = this.client.extractNicknameFromPersonalCard(card) || data2.nickname;
      const avatarUrl = typeof card["avatarUrl"] === "string" && card["avatarUrl"].trim() ? String(card["avatarUrl"]) : typeof card["figureurl"] === "string" && card["figureurl"].trim() ? String(card["figureurl"]) : data2.avatarUrl;
      return ok({ nickname, avatarUrl }, echo);
    } catch {
      return ok(data2, echo);
    }
  }
  // ── albums ─────────────────────────────────────
  async action_get_album_list(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const uin = p["user_id"] ? String(p["user_id"]) : void 0;
    const res = await this.client.getAlbumList(uin);
    return ok(res, echo);
  }
  async action_get_photo_list(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const uin = p["user_id"] ? String(p["user_id"]) : void 0;
    const albumId = String(p["album_id"] ?? p["topicId"] ?? "");
    const num = safeInt(p["num"] ?? 30);
    const res = await this.client.getPhotoList(uin, albumId, num);
    return ok(res, echo);
  }
  async action_create_album(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const name = String(p["name"] ?? "");
    const desc = String(p["desc"] ?? "");
    const priv = safeInt(p["priv"] ?? 1);
    if (!name) return fail(1400, "\u7F3A\u5C11 name", echo);
    const res = await this.client.createAlbum(name, desc, priv);
    return ok(res, echo);
  }
  async action_delete_album(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const albumId = String(p["album_id"] ?? "");
    if (!albumId) return fail(1400, "\u7F3A\u5C11 album_id", echo);
    return ok(await this.client.deleteAlbum(albumId), echo);
  }
  async action_delete_photo(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const uin = p["user_id"] ? String(p["user_id"]) : void 0;
    const albumId = String(p["album_id"] ?? "");
    const photoId = String(p["photo_id"] ?? p["lloc"] ?? "");
    return ok(await this.client.deletePhoto(uin, albumId, photoId), echo);
  }
  // ── upload ──────────────────────────────────────
  async action_upload_image(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    let b64 = String(p["base64"] ?? p["file"] ?? "");
    if (!b64 && p["url"]) {
      if (!isSafeUrl(String(p["url"]))) return fail(1403, "URL \u4E0D\u5B89\u5168", echo);
      b64 = await this.fetchImageBase64(String(p["url"]));
    }
    if (!b64) return fail(1400, "\u7F3A\u5C11 base64 \u6216 url", echo);
    b64 = this.normalizeAndValidateImageBase64(b64, String(p["url"] ?? p["file"] ?? "upload_image"));
    const albumId = p["album_id"] ? String(p["album_id"]) : void 0;
    const res = await this.client.uploadImage(b64, albumId);
    return ok(res, echo);
  }
  // ── login ───────────────────────────────────────
  async action_login_qr(_p, echo) {
    this.client.logout();
    try {
      await this.client.loginWithPlaywright();
    } catch (e) {
      return fail(1500, `QR \u767B\u5F55\u5931\u8D25: ${e}`, echo);
    }
    if (!this.client.loggedIn) return fail(1500, "QR \u767B\u5F55\u672A\u5B8C\u6210", echo);
    const uin = this.client.qqNumber;
    const nickname = await this.client.resolveLoginNickname(uin) || "QZone\u7528\u6237";
    return ok({ user_id: safeInt(uin), nickname }, echo);
  }
  async action_login_cookie(p, echo) {
    const cookieStr = String(p["cookie"] ?? p["cookie_string"] ?? "");
    if (!cookieStr) return fail(1400, "\u7F3A\u5C11 cookie", echo);
    await this.client.loginWithCookieString(cookieStr);
    const uin = this.client.qqNumber;
    const nickname = await this.client.resolveLoginNickname(uin) || "QZone\u7528\u6237";
    return ok({ user_id: safeInt(uin), nickname }, echo);
  }
  /** 更新 Cookie：传入与 login_cookie 相同格式的 cookie 字符串，覆盖当前会话并写回缓存/.env */
  async action_update_cookie(p, echo) {
    const cookieStr = String(p["cookie"] ?? p["cookie_string"] ?? "").trim();
    if (!cookieStr) return fail(1400, "\u7F3A\u5C11 cookie\uFF08\u8BF7\u4F20\u5165 cookie \u6216 cookie_string\uFF09", echo);
    try {
      await this.client.loginWithCookieString(cookieStr);
      this.client.syncCookieToEnvFile();
      const uin = this.client.qqNumber;
      const nickname = await this.client.resolveLoginNickname(uin) || "QZone\u7528\u6237";
      return ok({
        message: "Cookie \u5DF2\u66F4\u65B0",
        user_id: safeInt(uin),
        nickname
      }, echo);
    } catch (e) {
      return fail(1500, e instanceof Error ? e.message : String(e), echo);
    }
  }
  async action_logout(_p, echo) {
    this.client.logout();
    return ok(null, echo);
  }
  async action_reset_api_caches(_p, echo) {
    this.client.resetApiCaches();
    return ok(null, echo);
  }
  async action_probe_api_routes(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const uin = String(p["uin"] ?? this.client.qqNumber);
    const tid = String(p["tid"] ?? "");
    if (!tid) return fail(1400, "\u7F3A\u5C11 tid", echo);
    const routes = await this.client.probeApiRoutes(uin, tid);
    return ok(routes, echo);
  }
  async action_probe_capabilities(_p, echo) {
    if (!this.client.loggedIn) return fail(1401, "not logged in", echo);
    const report = await this.client.probeCapabilities();
    return ok(report, echo);
  }
  async action_get_friend_feeds(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const rawInc = p["include_image_data"];
    const includeImageData = rawInc !== false && rawInc !== "0";
    const cursor = typeof p["cursor"] === "string" ? p["cursor"] : "";
    const num = Math.max(1, Math.min(200, safeInt(p["num"] ?? p["count"] ?? 50)));
    const fastMode = !["0", "false", "no"].includes(String(p["fast_mode"] ?? "1").toLowerCase());
    const result = await this.client.getFriendFeedsBestEffort(cursor, num, { fastMode });
    if (!result.ok) return fail(sdkFailureRetcode(result.kind), result.details.message ?? result.kind, echo);
    const res = withSdkMeta({
      code: 0,
      message: "ok",
      msglist: result.data.posts,
      has_more: result.data.hasMore,
      next_cursor: result.data.nextCursor
    }, result);
    if (includeImageData) {
      await this.enrichMsglistWithImageData(res, MAX_IMAGE_DATA_PER_POST, MAX_IMAGE_DATA_PER_RESPONSE);
    }
    return ok(res, echo);
  }
  async action_fetch_image(p, echo) {
    if (!this.client.loggedIn) return fail(1401, "\u672A\u767B\u5F55", echo);
    const url = typeof p["url"] === "string" ? p["url"] : void 0;
    const urls = Array.isArray(p["urls"]) ? p["urls"].filter((u) => typeof u === "string") : void 0;
    const list = url ? [url] : urls;
    if (!list || list.length === 0) return fail(1400, "\u7F3A\u5C11 url \u6216 urls", echo);
    for (const u of list) {
      if (!isQzoneImageUrl(u)) return fail(1403, "\u4EC5\u5141\u8BB8 QZone CDN \u767D\u540D\u5355 URL\uFF08qpic.cn\u3001photo.store.qq.com\u3001qlogo*.store.qq.com\u3001qzonestyle.gtimg.cn\uFF09", echo);
    }
    if (list.length === 1) {
      try {
        const { data: data2, contentType } = await this.client.fetchImageWithAuth(list[0]);
        return ok({ base64: data2.toString("base64"), content_type: contentType }, echo);
      } catch (e) {
        return fail(1500, e instanceof Error ? e.message : String(e), echo);
      }
    }
    const images = [];
    for (const u of list) {
      try {
        const { data: data2, contentType } = await this.client.fetchImageWithAuth(u);
        images.push({ url: u, base64: data2.toString("base64"), content_type: contentType });
      } catch {
        images.push({ url: u });
      }
    }
    return ok({ images }, echo);
  }
  /** 为 msglist 中每条说说的 pic 附带 base64（仅白名单 URL），单条最多 maxPerPost 张，总 maxTotal 张 */
  async enrichMsglistWithImageData(res, maxPerPost, maxTotal) {
    const msglist = res["msglist"];
    if (!Array.isArray(msglist)) return;
    let totalFetched = 0;
    for (const item of msglist) {
      if (totalFetched >= maxTotal) break;
      const pic = item["pic"];
      const picArr = Array.isArray(pic) ? pic : [];
      if (picArr.length === 0) continue;
      let perPost = 0;
      for (let i = 0; i < picArr.length && perPost < maxPerPost && totalFetched < maxTotal; i++) {
        const entry = picArr[i];
        const url = getPicUrl(entry);
        if (!url || !isQzoneImageUrl(url)) continue;
        try {
          const { data: data2, contentType } = await this.client.fetchImageWithAuth(url);
          const obj = typeof entry === "object" && entry ? entry : { url };
          const b64 = data2.toString("base64");
          obj["base64"] = b64;
          obj["content_type"] = contentType;
          perPost++;
          totalFetched++;
        } catch {
        }
      }
    }
  }
  // ── util ─────────────────────────────────────────
  fetchImageBase64(url) {
    return this.fetchImageBuffer(url).then((buffer) => buffer.toString("base64"));
  }
  async resolveImageBase64(source) {
    if (!source) return null;
    if (source.startsWith("base64://") || source.startsWith("data:")) {
      return this.normalizeAndValidateImageBase64(source, source.slice(0, 64));
    }
    if (isSafeUrl(source)) {
      return this.fetchImageBase64(source);
    }
    const localPath = this.resolveLocalImagePath(source);
    if (!localPath) return null;
    return this.normalizeAndValidateImageBuffer(fs4.readFileSync(localPath), localPath).toString("base64");
  }
  resolveLocalImagePath(source) {
    let localSource = source;
    if (localSource.startsWith("file://")) {
      try {
        localSource = decodeURIComponent(new URL(localSource).pathname);
      } catch {
        return null;
      }
      if (/^\/[A-Za-z]:\//.test(localSource)) localSource = localSource.slice(1);
    }
    const candidates = [
      path3.resolve(localSource),
      path3.resolve(this.config.cachePath, localSource),
      path3.resolve(this.config.cachePath, path3.basename(localSource))
    ];
    for (const candidate of candidates) {
      if (fs4.existsSync(candidate) && fs4.statSync(candidate).isFile()) return candidate;
    }
    return null;
  }
  async fetchImageBuffer(url) {
    let lastError;
    for (let attempt = 0; attempt <= SEND_IMAGE_FETCH_RETRIES; attempt++) {
      try {
        const buffer = await new Promise((resolve, reject) => {
          const mod = url.startsWith("https") ? https2 : http;
          const req = mod.get(url, { timeout: 15e3 }, (res) => {
            if ((res.statusCode ?? 0) >= 400) {
              reject(new Error(`HTTP ${res.statusCode}`));
              res.resume();
              return;
            }
            const contentLength = Number(res.headers["content-length"] ?? 0);
            if (contentLength > SEND_IMAGE_MAX_BYTES) {
              reject(new Error(`image too large: ${contentLength} bytes`));
              res.resume();
              return;
            }
            const chunks = [];
            let total = 0;
            res.on("data", (chunk) => {
              total += chunk.length;
              if (total > SEND_IMAGE_MAX_BYTES) {
                req.destroy(new Error(`image too large: ${total} bytes`));
                return;
              }
              chunks.push(chunk);
            });
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
          });
          req.on("timeout", () => req.destroy(new Error("image fetch timeout")));
          req.on("error", reject);
        });
        return this.normalizeAndValidateImageBuffer(buffer, url, false);
      } catch (error) {
        lastError = error;
        if (attempt >= SEND_IMAGE_FETCH_RETRIES) break;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  normalizeAndValidateImageBase64(rawBase64, sourceLabel) {
    const normalized = rawBase64.replace(/^base64:\/\//, "").replace(/^data:[^,]+,/, "");
    const buffer = Buffer.from(normalized, "base64");
    return this.normalizeAndValidateImageBuffer(buffer, sourceLabel).toString("base64");
  }
  normalizeAndValidateImageBuffer(buffer, sourceLabel, cloneBuffer = true) {
    const normalized = cloneBuffer ? Buffer.from(buffer) : buffer;
    if (!normalized.length) throw new Error(`\u56FE\u7247\u4E3A\u7A7A: ${sourceLabel}`);
    if (normalized.length > SEND_IMAGE_MAX_BYTES) {
      throw new Error(`\u56FE\u7247\u8FC7\u5927(${normalized.length} bytes): ${sourceLabel}`);
    }
    if (!isSupportedImageBuffer(normalized)) {
      throw new Error(`\u4E0D\u652F\u6301\u7684\u56FE\u7247\u683C\u5F0F: ${sourceLabel}`);
    }
    return normalized;
  }
};

// vendor/onebot-qzone/src/bridge/hub.ts
var MAX_SEED_TIDS = 20;
var EVENT_DEDUP_TTL_MS = 3e5;
var EVENT_DEDUP_MAX = 1e3;
function readSenderUserId(record) {
  const sender = record["sender"];
  if (sender && typeof sender === "object" && !Array.isArray(sender)) {
    const uid = sender["user_id"];
    if (uid != null && String(uid).trim() !== "") return String(uid).trim();
  }
  return "";
}
function getMessageEventFingerprint(record) {
  const selfId = String(record["self_id"] ?? "");
  let author = "";
  let tid = "";
  const stable = String(record["_stable_post_key"] ?? "").trim();
  if (stable) {
    const colon = stable.indexOf(":");
    if (colon > 0) {
      author = stable.slice(0, colon).trim();
      tid = stable.slice(colon + 1).trim();
    }
  }
  if (!tid) tid = String(record["_tid"] ?? "").trim();
  if (!author) {
    author = String(record["_author_uin"] ?? record["_uin"] ?? "").trim();
  }
  if (!author) author = readSenderUserId(record);
  if (author && tid) {
    return `message:${selfId}:${author}:${tid}`;
  }
  const tidOnly = tid || String(record["_tid"] ?? record["message_id"] ?? "").trim();
  if (!tidOnly) return null;
  return `message:${selfId}:${tidOnly}`;
}
function getEventFingerprint(event) {
  const record = event;
  const postType = String(record["post_type"] ?? "");
  if (postType === "message") {
    return getMessageEventFingerprint(record);
  }
  if (postType !== "notice") return null;
  const noticeType = String(record["notice_type"] ?? "");
  if (noticeType === "qzone_comment") {
    const postTid = String(record["post_tid"] ?? "").trim();
    const commentId = String(record["comment_id"] ?? "").trim();
    if (!postTid || !commentId) return null;
    const sid = String(record["self_id"] ?? "").trim();
    return `comment:${sid}:${postTid}:${commentId}`;
  }
  if (noticeType === "qzone_like") {
    const postTid = String(record["post_tid"] ?? "").trim();
    const userId = String(record["user_id"] ?? "").trim();
    if (!postTid || !userId) return null;
    const sid = String(record["self_id"] ?? "").trim();
    return `like:${sid}:${postTid}:${userId}`;
  }
  return null;
}
var EventHub = class {
  subscribers = /* @__PURE__ */ new Set();
  seedTids = [];
  recentEventFingerprints = /* @__PURE__ */ new Map();
  eventDebug;
  constructor(opts) {
    this.eventDebug = Boolean(opts?.eventDebug);
  }
  subscribe(cb) {
    this.subscribers.add(cb);
  }
  unsubscribe(cb) {
    this.subscribers.delete(cb);
  }
  /** @returns 是否实际下发（false 表示短期内重复已去重） */
  async publish(event) {
    const fp = getEventFingerprint(event);
    if (this.isDuplicateEvent(event)) {
      if (this.eventDebug && fp) log("INFO", `[push][dedupe] ${fp}`);
      return false;
    }
    if (this.eventDebug && fp) log("INFO", `[push][publish] ${fp}`);
    for (const cb of this.subscribers) {
      try {
        await cb(event);
      } catch (err) {
        console.error("[EventHub] callback error:", err);
      }
    }
    return true;
  }
  addSeedTid(tid) {
    if (!this.seedTids.includes(tid)) {
      this.seedTids.push(tid);
      if (this.seedTids.length > MAX_SEED_TIDS) {
        this.seedTids.shift();
      }
    }
  }
  getSeedTids() {
    return [...this.seedTids];
  }
  subscriberCount() {
    return this.subscribers.size;
  }
  isDuplicateEvent(event) {
    const fingerprint = getEventFingerprint(event);
    if (!fingerprint) return false;
    const nowMs = Date.now();
    this.pruneRecentEventFingerprints(nowMs);
    const lastSeenAt = this.recentEventFingerprints.get(fingerprint);
    if (lastSeenAt != null && nowMs - lastSeenAt < EVENT_DEDUP_TTL_MS) {
      return true;
    }
    this.recentEventFingerprints.set(fingerprint, nowMs);
    return false;
  }
  pruneRecentEventFingerprints(nowMs) {
    for (const [fingerprint, seenAt] of this.recentEventFingerprints) {
      if (nowMs - seenAt >= EVENT_DEDUP_TTL_MS) {
        this.recentEventFingerprints.delete(fingerprint);
      }
    }
    while (this.recentEventFingerprints.size > EVENT_DEDUP_MAX) {
      const oldestKey = this.recentEventFingerprints.keys().next().value;
      if (!oldestKey) break;
      this.recentEventFingerprints.delete(oldestKey);
    }
  }
};

// vendor/onebot-qzone/src/bridge/stablePostKey.ts
function stableTidFromRaw(raw) {
  return String(raw["tid"] ?? raw["cellid"] ?? "").trim();
}
function authorUinFromRaw(raw) {
  return String(raw["opuin"] ?? raw["uin"] ?? raw["frienduin"] ?? "").trim();
}
function buildStablePostKey(raw) {
  const author = authorUinFromRaw(raw);
  const tid = stableTidFromRaw(raw);
  if (!author || !tid) return "";
  return `${author}:${tid}`;
}
function buildStablePostKeyFromItem(item) {
  const u = String(item.uin ?? "").trim();
  const t = String(item.tid ?? "").trim();
  if (!u || !t) return "";
  return `${u}:${t}`;
}
function seenLookupKeysForPost(item, raw) {
  const cellid = String(raw["cellid"] ?? "").trim() || void 0;
  const iu = String(item.uin ?? "").trim();
  const it = String(item.tid ?? "").trim();
  const merged = /* @__PURE__ */ new Set();
  for (const k of collectSeenLookupKeys(iu, it, cellid)) {
    merged.add(k);
  }
  const ra = authorUinFromRaw(raw);
  const rt = stableTidFromRaw(raw);
  if (ra || rt) {
    for (const k of collectSeenLookupKeys(ra || iu, rt || it, cellid)) {
      merged.add(k);
    }
  }
  return [...merged].filter(Boolean);
}
function collectSeenLookupKeys(authorUin, stableTid, cellid) {
  const keys = /* @__PURE__ */ new Set();
  if (!stableTid) return [];
  const canon = authorUin ? `${authorUin}:${stableTid}` : "";
  if (canon) keys.add(canon);
  if (authorUin) keys.add(`${authorUin}_${stableTid}`);
  keys.add(stableTid);
  const cid = (cellid ?? "").trim();
  if (cid && cid !== stableTid) {
    if (authorUin) keys.add(`${authorUin}:${cid}`);
    if (authorUin) keys.add(`${authorUin}_${cid}`);
    keys.add(cid);
  }
  return [...keys].filter(Boolean);
}

// vendor/onebot-qzone/src/bridge/commentDedup.ts
import { createHash } from "node:crypto";
function feeds3CommentIdIsAmbiguous(commentId) {
  const s = commentId.trim();
  if (!s) return true;
  if (/^\d+$/.test(s)) return s.length <= 6;
  return false;
}
function buildFeedCommentDedupKey(tid, c) {
  const raw = c.commentId.trim();
  if (raw && !feeds3CommentIdIsAmbiguous(raw)) {
    return `id:${tid}:${raw}`;
  }
  const content = (c.content ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const basisParts = [
    tid,
    c.uin,
    String(c.createdTime),
    content,
    c.parentCommentId ?? "",
    c.replyToCommentId ?? "",
    c.replyToUin ?? "",
    c.isReply ? "1" : "0"
  ];
  if (c.createdTime <= 0 && c.feeds3ParseSeq != null) {
    basisParts.push(String(c.feeds3ParseSeq));
  }
  const basis = basisParts.join("");
  return `h:${tid}:${createHash("sha256").update(basis, "utf8").digest("hex").slice(0, 32)}`;
}
function commentDedupSeen(seen, tid, c) {
  if (!c.commentId) return true;
  if (seen.has(c.commentId)) return true;
  return seen.has(buildFeedCommentDedupKey(tid, c));
}
function commentDedupMark(seen, tid, c) {
  seen.add(buildFeedCommentDedupKey(tid, c));
  if (c.commentId) seen.add(c.commentId);
}

// vendor/onebot-qzone/src/bridge/firstRunBaseline.ts
function uniqueTids(tids) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const tid of tids) {
    if (!tid || seen.has(tid)) continue;
    seen.add(tid);
    out.push(tid);
  }
  return out;
}
function createBaselineState(init) {
  return {
    v: 1,
    postsDone: init.postsSeen,
    friendFeedsDone: init.postsSeen,
    interactiveInitialized: init.interactiveSeen,
    pendingComments: [],
    pendingLikes: []
  };
}
function normalizeBaselineState(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const stringArray = (value) => Array.isArray(value) ? uniqueTids(value.filter((v) => typeof v === "string")) : [];
  return {
    v: 1,
    postsDone: o["postsDone"] === true,
    friendFeedsDone: o["friendFeedsDone"] === true,
    interactiveInitialized: o["interactiveInitialized"] === true,
    pendingComments: stringArray(o["pendingComments"]),
    pendingLikes: stringArray(o["pendingLikes"])
  };
}
function initializeInteractiveBaseline(state, tids) {
  if (state.interactiveInitialized) return false;
  const snapshot = uniqueTids(tids);
  state.pendingComments = [...snapshot];
  state.pendingLikes = [...snapshot];
  state.interactiveInitialized = true;
  return true;
}
function isCommentBaselinePending(state, tid) {
  return state.pendingComments.includes(tid);
}
function isLikeBaselinePending(state, tid) {
  return state.pendingLikes.includes(tid);
}
function completeCommentBaseline(state, tid) {
  state.pendingComments = state.pendingComments.filter((t) => t !== tid);
}
function completeLikeBaseline(state, tid) {
  state.pendingLikes = state.pendingLikes.filter((t) => t !== tid);
}
function pruneBaselinePending(state, keepTids) {
  const before = state.pendingComments.length + state.pendingLikes.length;
  state.pendingComments = state.pendingComments.filter((t) => keepTids.has(t));
  state.pendingLikes = state.pendingLikes.filter((t) => keepTids.has(t));
  return state.pendingComments.length + state.pendingLikes.length !== before;
}

// vendor/onebot-qzone/src/qzone/infra/errors.ts
var QzoneError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "QzoneError";
  }
};
var AuthError = class extends QzoneError {
  bizCode;
  constructor(message, bizCode, options) {
    super(message, options);
    this.name = "AuthError";
    this.bizCode = bizCode;
  }
};
function isQzoneError(err) {
  return err instanceof QzoneError;
}

// vendor/onebot-qzone/src/bridge/poller.ts
import pLimit3 from "p-limit";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "fs";
import { join } from "path";
function now() {
  return Math.floor(Date.now() / 1e3);
}
async function safePoll(label, fn) {
  try {
    await fn();
    return true;
  } catch (err) {
    if (err instanceof AuthError) {
      console.error(`[Poller] ${label}: \u8BA4\u8BC1\u5931\u8D25 \u2014 ${err.message}`);
    } else if (isQzoneError(err)) {
      console.error(`[Poller] ${label}: ${err.name} \u2014 ${err.message}`);
    } else {
      console.error(`[Poller] ${label}: ${err}`);
    }
    return false;
  }
}
function makeLocalId() {
  return String(Date.now());
}
function stripHtml(s) {
  return htmlUnescape(s.replace(/<[^>]+>/g, ""));
}
var QZONE_IMAGE_HOST_SUFFIXES2 = [
  "qpic.cn",
  "photo.store.qq.com",
  "qlogo1.store.qq.com",
  "qlogo2.store.qq.com",
  "qzonestyle.gtimg.cn"
];
function isQzoneImageUrl2(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    return QZONE_IMAGE_HOST_SUFFIXES2.some((suffix) => host === suffix || host.endsWith("." + suffix));
  } catch {
    return false;
  }
}
function extractImages(pics) {
  if (!Array.isArray(pics)) return [];
  const urls = [];
  for (const p of pics) {
    if (typeof p === "object" && p) {
      const obj = p;
      let found = false;
      for (const key of ["url2", "url3", "url1", "smallurl", "url"]) {
        const v = obj[key];
        if (typeof v === "string" && v.startsWith("http")) {
          urls.push(v);
          found = true;
          break;
        }
      }
      if (!found) {
        for (const v of Object.values(obj)) {
          if (typeof v === "string" && v.startsWith("http")) {
            urls.push(v);
            break;
          }
        }
      }
    } else if (typeof p === "string" && p.startsWith("http")) {
      urls.push(p);
    }
  }
  return urls;
}
function extractVideos2(raw) {
  const videoUrls = [];
  const videoCoverUrls = [];
  const videos = raw["video"];
  if (!Array.isArray(videos)) return { videoUrls, videoCoverUrls };
  for (const v of videos) {
    const playUrl = String(
      v["url3"] ?? v["video_url"] ?? v["url"] ?? v["videoUrl"] ?? ""
    );
    if (playUrl) videoUrls.push(playUrl);
    const coverUrl = String(
      v["url1"] ?? v["pic_url"] ?? v["cover"] ?? v["coverUrl"] ?? ""
    );
    if (coverUrl) videoCoverUrls.push(coverUrl);
  }
  return { videoUrls, videoCoverUrls };
}
function rebuildContentFromConlist(conlist, emojiMode = "name") {
  const parts = [];
  for (const item of conlist) {
    const type = Number(item["type"] ?? -1);
    if (type === 0) {
      const nick = String(item["nick"] ?? item["name"] ?? "");
      parts.push(nick ? `@${nick}` : "@");
    } else if (type === 2) {
      const con = String(item["con"] ?? item["content"] ?? "");
      if (con) parts.push(processEmojis(con, { mode: emojiMode }));
    } else {
      const con = String(item["con"] ?? item["content"] ?? "");
      if (con) parts.push(con);
    }
  }
  return stripHtml(parts.join(""));
}
function processContent(content) {
  if (!content) return "";
  let processed = processEmojis(content, { mode: "name" });
  processed = stripHtml(processed);
  return processed;
}
function normalizeEmotion(raw, selfUin) {
  const tid = String(raw["tid"] ?? raw["cellid"] ?? "");
  const uin = String(raw["opuin"] ?? raw["uin"] ?? raw["frienduin"] ?? selfUin);
  const nickname = stripHtml(String(raw["nickname"] ?? raw["name"] ?? ""));
  let content;
  const conlist = raw["conlist"];
  if (Array.isArray(conlist) && conlist.length > 0) {
    content = rebuildContentFromConlist(conlist, "name");
  } else {
    content = processContent(String(
      raw["content"] ?? raw["con"] ?? raw["cellcontent"] ?? ""
    ));
  }
  const createdTime = safeInt(raw["created_time"] ?? raw["createTime"] ?? raw["ctime"] ?? raw["pubtime"] ?? 0);
  const cmtnum = safeInt(raw["cmtnum"] ?? raw["commentcnt"] ?? 0);
  const fwdnum = safeInt(raw["fwdnum"] ?? raw["forwardcnt"] ?? 0);
  let pics = extractImages(raw["pic"] ?? raw["media"] ?? []);
  pics = pics.filter((url) => !/qzone\/em\/|gtimg\.cn.*\/em\//i.test(url));
  const { videoUrls, videoCoverUrls } = extractVideos2(raw);
  for (const cover of videoCoverUrls) {
    if (!pics.includes(cover)) pics.push(cover);
  }
  let forwardContent;
  let forwardUin;
  let forwardTid;
  let forwardNickname;
  const rtTid = raw["rt_tid"];
  const rtUin = raw["rt_uin"];
  const rtCon = raw["rt_con"];
  if (typeof rtTid === "string" && rtTid) {
    forwardTid = rtTid;
    forwardUin = String(rtUin ?? "");
    forwardNickname = String(raw["rt_uinname"] ?? "");
    if (typeof rtCon === "string") {
      forwardContent = stripHtml(rtCon);
    } else if (typeof rtCon === "object" && rtCon) {
      const rc = rtCon;
      forwardContent = stripHtml(String(rc["content"] ?? rc["con"] ?? ""));
    }
  } else if (typeof rtCon === "object" && rtCon) {
    const rc = rtCon;
    forwardContent = stripHtml(String(rc["content"] ?? rc["con"] ?? ""));
    forwardUin = String(rc["uin"] ?? "");
    forwardTid = String(rc["tid"] ?? "");
  }
  const appid = String(raw["appid"] ?? "");
  const typeid = String(raw["typeid"] ?? "");
  const appName = String(raw["appName"] ?? "");
  const appShareTitle = String(raw["appShareTitle"] ?? "");
  let likeUnikey = String(raw["likeUnikey"] ?? "");
  let likeCurkey = String(raw["likeCurkey"] ?? "");
  if (!likeUnikey) {
    if (typeid === "5" && forwardUin && forwardTid) {
      likeUnikey = `http://user.qzone.qq.com/${forwardUin}/mood/${forwardTid}`;
      likeCurkey = `http://user.qzone.qq.com/${uin}/mood/${tid}`;
    } else if (appid === "311" || appid === "") {
      likeUnikey = `http://user.qzone.qq.com/${uin}/mood/${tid}`;
      likeCurkey = likeUnikey;
    }
  }
  return {
    tid,
    uin,
    nickname,
    content,
    createdTime,
    cmtnum,
    fwdnum,
    pics,
    videos: videoUrls,
    forwardContent,
    forwardUin,
    forwardTid,
    forwardNickname,
    appid,
    typeid,
    appName,
    appShareTitle,
    likeUnikey,
    likeCurkey
  };
}
function normalizeComment(raw) {
  const commentId = String(raw["commentid"] ?? raw["comment_id"] ?? raw["id"] ?? "");
  const uin = String(raw["uin"] ?? raw["commentuin"] ?? "");
  const nickname = stripHtml(String(raw["name"] ?? raw["nick"] ?? ""));
  let content;
  const rawContent = raw["content"] ?? raw["con"] ?? "";
  if (typeof rawContent === "string" && rawContent) {
    content = processContent(rawContent);
  } else if (Array.isArray(raw["conlist"])) {
    content = rebuildContentFromConlist(raw["conlist"], "name");
  } else {
    content = "";
  }
  const createdTime = safeInt(raw["createtime"] ?? raw["create_time"] ?? raw["time"] ?? 0);
  const isReply = !!(raw["is_reply"] ?? raw["isReply"]);
  const replyToUin = raw["reply_to_uin"] != null ? String(raw["reply_to_uin"]) : raw["replyToUin"] != null ? String(raw["replyToUin"]) : void 0;
  const replyToNickname = raw["reply_to_nickname"] != null ? stripHtml(String(raw["reply_to_nickname"])) : raw["replyToNickname"] != null ? stripHtml(String(raw["replyToNickname"])) : void 0;
  const replyToCommentId = raw["reply_to_comment_id"] != null ? String(raw["reply_to_comment_id"]) : raw["replyToCommentId"] != null ? String(raw["replyToCommentId"]) : void 0;
  const parentCommentId = raw["parent_comment_id"] != null ? String(raw["parent_comment_id"]) : raw["parentCommentId"] != null ? String(raw["parentCommentId"]) : void 0;
  const pic = Array.isArray(raw["pic"]) ? raw["pic"] : void 0;
  const seqRaw = raw["_feeds3_seq"];
  const feeds3ParseSeq = typeof seqRaw === "number" && Number.isFinite(seqRaw) ? seqRaw : void 0;
  return {
    commentId,
    uin,
    nickname,
    content,
    createdTime,
    ...isReply && { isReply: true },
    ...replyToUin && { replyToUin },
    ...replyToNickname && { replyToNickname },
    ...replyToCommentId && { replyToCommentId },
    ...parentCommentId && { parentCommentId },
    ...pic && pic.length > 0 && { pic },
    ...feeds3ParseSeq != null && { feeds3ParseSeq }
  };
}
function normalizeLike(raw) {
  const uin = String(raw["uin"] ?? raw["fuin"] ?? "");
  const nickname = stripHtml(String(raw["name"] ?? raw["nick"] ?? ""));
  const createdTime = safeInt(raw["time"] ?? raw["likeTime"] ?? 0);
  return { uin, nickname, createdTime };
}
var APPID_LABELS = {
  "311": "\u8BF4\u8BF4",
  "2": "\u76F8\u518C",
  "4": "\u8F6C\u53D1",
  "202": "\u7F51\u6613\u4E91\u97F3\u4E50",
  "217": "\u70B9\u8D5E\u8BB0\u5F55",
  "2160": "QQ\u97F3\u4E50",
  "268": "QQ\u97F3\u4E50",
  "3168": "\u54D4\u54E9\u54D4\u54E9"
};
var MAX_IMAGE_DATA_PER_EVENT = 3;
async function buildPostEvent(item, selfId, opts, meta) {
  const segments = [];
  const appLabel = item.appid && item.appid !== "311" ? APPID_LABELS[item.appid] ?? item.appName ?? `App(${item.appid})` : "";
  if (appLabel) segments.push({ type: "text", data: { text: `[${appLabel}] ` } });
  if (item.content) segments.push({ type: "text", data: { text: item.content } });
  if (item.appShareTitle && item.appShareTitle !== item.content) {
    segments.push({ type: "text", data: { text: item.content ? `
${item.appShareTitle}` : item.appShareTitle } });
  }
  if (item.forwardContent) {
    const fwdPrefix = item.forwardNickname ? `[\u8F6C\u53D1\u81EA ${item.forwardNickname}] ` : "[\u8F6C\u53D1] ";
    segments.push({ type: "text", data: { text: `
${fwdPrefix}${item.forwardContent}` } });
  }
  if (opts?.attachImageData && opts?.client && item.pics.length > 0) {
    let attached = 0;
    for (const url of item.pics) {
      if (attached >= opts.maxPics) break;
      if (!isQzoneImageUrl2(url)) {
        segments.push({ type: "image", data: { url } });
        continue;
      }
      try {
        const { data: data2 } = await opts.client.fetchImageWithAuth(url);
        segments.push({ type: "image", data: { url, file: "base64://" + data2.toString("base64") } });
        attached++;
      } catch {
        segments.push({ type: "image", data: { url } });
      }
    }
  } else {
    for (const url of item.pics) segments.push({ type: "image", data: { url } });
  }
  if (item.videos) {
    for (const url of item.videos) segments.push({ type: "video", data: { url } });
  }
  const ev = {
    time: item.createdTime || now(),
    self_id: safeInt(selfId),
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: safeInt(item.tid) || safeInt(makeLocalId()),
    user_id: safeInt(item.uin),
    message: segments,
    raw_message: item.content,
    font: 0,
    sender: { user_id: safeInt(item.uin), nickname: item.nickname },
    // extra
    _tid: item.tid,
    _uin: item.uin,
    _abstime: item.createdTime,
    _cmtnum: item.cmtnum,
    _fwdnum: item.fwdnum,
    _pics: item.pics,
    _videos: item.videos ?? [],
    _forward_content: item.forwardContent,
    _forward_uin: item.forwardUin,
    _forward_tid: item.forwardTid,
    _forward_nickname: item.forwardNickname,
    _appid: item.appid ?? "",
    _typeid: item.typeid ?? "",
    _app_name: item.appName ?? "",
    _app_share_title: item.appShareTitle ?? "",
    _like_unikey: item.likeUnikey ?? "",
    _like_curkey: item.likeCurkey ?? ""
  };
  const rec = ev;
  if (meta?.stablePostKey) rec["_stable_post_key"] = meta.stablePostKey;
  if (meta?.authorUin) rec["_author_uin"] = meta.authorUin;
  if (meta?.cellid) rec["_cellid"] = meta.cellid;
  return ev;
}
function buildCommentEvent(comment, postUin, postTid, selfId) {
  const ev = {
    time: comment.createdTime || now(),
    self_id: safeInt(selfId),
    post_type: "notice",
    notice_type: "qzone_comment",
    user_id: safeInt(comment.uin),
    sender_name: comment.nickname,
    comment_id: comment.commentId,
    comment_content: comment.content,
    post_uin: safeInt(postUin),
    post_tid: postTid
  };
  if (comment.isReply) ev._is_reply = true;
  if (comment.replyToUin) ev._reply_to_uin = comment.replyToUin;
  if (comment.replyToNickname) ev._reply_to_nickname = comment.replyToNickname;
  if (comment.replyToCommentId) ev._reply_to_comment_id = comment.replyToCommentId;
  if (comment.parentCommentId) ev._parent_comment_id = comment.parentCommentId;
  if (comment.pic?.length) ev._comment_pic = comment.pic;
  return ev;
}
function buildLikeEvent(like, postUin, postTid, selfId) {
  return {
    time: like.createdTime || now(),
    self_id: safeInt(selfId),
    post_type: "notice",
    notice_type: "qzone_like",
    user_id: safeInt(like.uin),
    sender_name: like.nickname,
    post_uin: safeInt(postUin),
    post_tid: postTid
  };
}
function buildHeartbeatEvent(selfId, status) {
  return {
    time: now(),
    self_id: safeInt(selfId),
    post_type: "meta_event",
    meta_event_type: "heartbeat",
    status,
    interval: 3e4
  };
}
var EventPoller = class _EventPoller {
  constructor(client2, hub2, config2) {
    this.client = client2;
    this.hub = hub2;
    this.config = config2;
  }
  static COMMENT_FETCH_LIMIT_INITIAL = 50;
  static COMMENT_FETCH_LIMIT_STEADY = 20;
  static COMMENT_CACHE_MAX_AGE_SEC = 75;
  running = false;
  mainTimer = null;
  commentTimer = null;
  likeTimer = null;
  friendFeedTimer = null;
  keepaliveTimer = null;
  heartbeatTimer = null;
  seenPostTids = /* @__PURE__ */ new Set();
  seenCommentIds = /* @__PURE__ */ new Map();
  // tid → commentIds
  seenLikeUins = /* @__PURE__ */ new Map();
  // tid → uins
  pendingLikeUsers = /* @__PURE__ */ new Map();
  // tid → 待匹配用户列表
  commentWarmTids = /* @__PURE__ */ new Set();
  trackTids = /* @__PURE__ */ new Set();
  knownCounts = /* @__PURE__ */ new Map();
  // tid → counts from qz_opcnt2
  /** 首次启动基线状态；关闭 ONEBOT_BASELINE_ON_FIRST_RUN 时为 null */
  baseline = null;
  lastError = 0;
  backoff = 0;
  statusOk = false;
  /** 防抖写入 seen_interactive_state.json，避免每帖一次写盘 */
  interactiveSaveTimer = null;
  logEventDebug(msg) {
    if (this.config.eventDebug) log("DEBUG", msg);
  }
  get seenTidsFile() {
    return join(this.config.cachePath, "seen_post_tids.json");
  }
  loadSeenTids() {
    try {
      mkdirSync(this.config.cachePath, { recursive: true });
      const raw = readFileSync(this.seenTidsFile, "utf-8");
      const arr = JSON.parse(raw);
      for (const t of arr) this.seenPostTids.add(t);
    } catch {
    }
  }
  saveSeenTids() {
    try {
      const arr = [...this.seenPostTids].slice(-2e3);
      writeFileSync(this.seenTidsFile, JSON.stringify(arr), "utf-8");
    } catch {
    }
  }
  /** 合并 canonical + 历史兼容键，供 seen 查询与持久化 */
  markSeenPostItem(item, raw) {
    if (!item.tid || !item.uin) return;
    for (const k of seenLookupKeysForPost(item, raw)) {
      this.seenPostTids.add(k);
    }
  }
  flushSeenTidsImmediate() {
    this.saveSeenTids();
  }
  get interactiveStateFile() {
    return join(this.config.cachePath, "seen_interactive_state.json");
  }
  get baselineStateFile() {
    return join(this.config.cachePath, "baseline_state.json");
  }
  /**
   * 首启基线：只记录当前已在列表中的帖子/评论/点赞，不推送。
   * 已有旧版 seen 文件时视为已建立基线，避免升级后重复静默。
   */
  loadBaselineState() {
    if (!this.config.baselineOnFirstRun) {
      this.baseline = null;
      return;
    }
    const postsSeen = existsSync(this.seenTidsFile);
    const interactiveSeen = existsSync(this.interactiveStateFile);
    let state = null;
    let loaded = false;
    if (existsSync(this.baselineStateFile)) {
      try {
        state = normalizeBaselineState(JSON.parse(readFileSync(this.baselineStateFile, "utf-8")));
        loaded = true;
      } catch {
        state = null;
      }
    }
    if (!state) state = createBaselineState({ postsSeen, interactiveSeen });
    if (!loaded) {
      state.postsDone = postsSeen;
      state.friendFeedsDone = postsSeen;
      state.interactiveInitialized = interactiveSeen;
      state.pendingComments = [];
      state.pendingLikes = [];
    }
    this.baseline = state;
    this.saveBaselineState();
    if (!state.postsDone || !state.interactiveInitialized || state.pendingComments.length > 0 || state.pendingLikes.length > 0) {
      log("INFO", `[Poller] \u9996\u6B21\u542F\u52A8\u57FA\u7EBF: postsDone=${state.postsDone} interactive=${state.interactiveInitialized} pendingComments=${state.pendingComments.length} pendingLikes=${state.pendingLikes.length}\uFF08\u53EF\u7528 ONEBOT_BASELINE_ON_FIRST_RUN=0 \u56DE\u653E\u5386\u53F2\uFF09`);
    }
  }
  saveBaselineState() {
    if (!this.baseline) return;
    try {
      mkdirSync(this.config.cachePath, { recursive: true });
      const tmp = `${this.baselineStateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.baseline, null, 2), "utf-8");
      renameSync(tmp, this.baselineStateFile);
    } catch (e) {
      console.error("[Poller] saveBaselineState failed:", e);
    }
  }
  /** 重启后恢复已见评论/点赞与计数，避免把历史当成新事件重复推送 */
  loadInteractiveState() {
    try {
      const raw = readFileSync(this.interactiveStateFile, "utf-8");
      const o = JSON.parse(raw);
      if (o.comments) {
        for (const [tid, ids] of Object.entries(o.comments)) {
          if (!ids?.length) continue;
          if (!this.seenCommentIds.has(tid)) this.seenCommentIds.set(tid, /* @__PURE__ */ new Set());
          for (const id of ids) this.seenCommentIds.get(tid).add(id);
        }
      }
      if (o.likes) {
        for (const [tid, uins] of Object.entries(o.likes)) {
          if (!uins?.length) continue;
          if (!this.seenLikeUins.has(tid)) this.seenLikeUins.set(tid, /* @__PURE__ */ new Set());
          for (const u of uins) this.seenLikeUins.get(tid).add(u);
        }
      }
      if (o.counts) {
        for (const [tid, c] of Object.entries(o.counts)) {
          const comment = Math.max(0, Number(c?.comment) || 0);
          const like = Math.max(0, Number(c?.like) || 0);
          this.knownCounts.set(tid, { comment, like });
        }
      }
    } catch {
    }
  }
  flushInteractiveStateToDisk() {
    try {
      mkdirSync(this.config.cachePath, { recursive: true });
      const comments = {};
      for (const [tid, set] of this.seenCommentIds) {
        if (set.size > 0) comments[tid] = [...set];
      }
      const likes = {};
      for (const [tid, set] of this.seenLikeUins) {
        if (set.size > 0) likes[tid] = [...set];
      }
      const counts = {};
      for (const [tid, c] of this.knownCounts) {
        counts[tid] = { comment: c.comment, like: c.like };
      }
      const payload = { v: 1, comments, likes, counts };
      const tmp = `${this.interactiveStateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), "utf-8");
      renameSync(tmp, this.interactiveStateFile);
    } catch (e) {
      console.error("[Poller] flushInteractiveStateToDisk failed:", e);
    }
  }
  requestInteractiveStateSave() {
    if (this.interactiveSaveTimer) clearTimeout(this.interactiveSaveTimer);
    this.interactiveSaveTimer = setTimeout(() => {
      this.interactiveSaveTimer = null;
      this.flushInteractiveStateToDisk();
    }, 1500);
  }
  isPostSeenItem(item, raw) {
    if (!item.tid || !item.uin) return true;
    return seenLookupKeysForPost(item, raw).some((k) => this.seenPostTids.has(k));
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.loadSeenTids();
    this.loadInteractiveState();
    this.loadBaselineState();
    for (const tid of this.hub.getSeedTids()) this.trackTids.add(tid);
    this.scheduleMain(0);
    this.scheduleComments(this.config.commentPollInterval * 1e3);
    this.scheduleLikes(this.config.likePollInterval * 1e3);
    this.scheduleFriendFeeds(this.config.friendFeedPollInterval * 1e3);
    this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), 3e4);
    this.keepaliveTimer = setInterval(() => this.keepaliveCookie(), 6e5);
  }
  stop() {
    this.running = false;
    if (this.mainTimer) {
      clearTimeout(this.mainTimer);
      this.mainTimer = null;
    }
    if (this.commentTimer) {
      clearTimeout(this.commentTimer);
      this.commentTimer = null;
    }
    if (this.likeTimer) {
      clearTimeout(this.likeTimer);
      this.likeTimer = null;
    }
    if (this.friendFeedTimer) {
      clearTimeout(this.friendFeedTimer);
      this.friendFeedTimer = null;
    }
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.interactiveSaveTimer) {
      clearTimeout(this.interactiveSaveTimer);
      this.interactiveSaveTimer = null;
    }
    this.flushInteractiveStateToDisk();
    this.saveBaselineState();
  }
  // ── 独立定时器调度 ──────────────────────────────
  /** 添加随机抖动：±20% 的随机偏移 */
  addJitter(delayMs) {
    const jitterFactor = 0.8 + Math.random() * 0.4;
    return Math.round(delayMs * jitterFactor);
  }
  scheduleMain(delayMs) {
    if (!this.running) return;
    this.mainTimer = setTimeout(async () => {
      const ok2 = await safePoll("main", () => this.pollMyPosts());
      if (ok2) {
        this.statusOk = true;
        this.backoff = 0;
      } else {
        this.statusOk = false;
        this.lastError = now();
        this.backoff = Math.min((this.backoff || 30) * 2, 300);
      }
      const nextDelay = this.backoff > 0 ? this.backoff * 1e3 : this.config.pollInterval * 1e3;
      this.scheduleMain(this.addJitter(nextDelay));
    }, delayMs);
  }
  scheduleComments(delayMs) {
    if (!this.running || !this.config.emitCommentEvents) return;
    this.commentTimer = setTimeout(async () => {
      if (this.client.loggedIn) {
        const selfId = this.client.qqNumber;
        const limit = pLimit3(3);
        await Promise.all([...this.trackTids].map(
          (tid) => limit(() => safePoll(`comments/${tid.slice(0, 8)}`, () => this.pollComments(selfId, tid)))
        ));
        this.requestInteractiveStateSave();
      }
      this.scheduleComments(this.addJitter(this.config.commentPollInterval * 1e3));
    }, delayMs);
  }
  scheduleLikes(delayMs) {
    if (!this.running || !this.config.emitLikeEvents) return;
    this.likeTimer = setTimeout(async () => {
      if (this.client.loggedIn) {
        const selfId = this.client.qqNumber;
        const limit = pLimit3(3);
        await Promise.all([...this.trackTids].map(
          (tid) => limit(() => safePoll(`likes/${tid.slice(0, 8)}`, () => this.pollLikes(selfId, tid)))
        ));
        this.requestInteractiveStateSave();
      }
      this.scheduleLikes(this.addJitter(this.config.likePollInterval * 1e3));
    }, delayMs);
  }
  scheduleFriendFeeds(delayMs) {
    if (!this.running || !this.config.emitFriendFeedEvents) return;
    this.friendFeedTimer = setTimeout(async () => {
      if (this.client.loggedIn) {
        await safePoll("friendFeeds", () => this.pollFriendFeeds());
      }
      this.scheduleFriendFeeds(this.addJitter(this.config.friendFeedPollInterval * 1e3));
    }, delayMs);
  }
  // ── Cookie 保活 & 自动重登 ──────────────────────────────
  reloginLock = false;
  keepaliveFailCount = 0;
  static KEEPALIVE_FAIL_THRESHOLD = 3;
  /** 静默续期间隔（秒），默认 4h */
  static REFRESH_INTERVAL = 4 * 3600;
  async keepaliveCookie() {
    if (!this.running || !this.client.loggedIn) return;
    const secSinceRefresh = this.client.secondsSinceLastRefresh;
    if (secSinceRefresh >= _EventPoller.REFRESH_INTERVAL) {
      console.error(`[Poller] \u8DDD\u4E0A\u6B21\u7EED\u671F ${Math.round(secSinceRefresh)}s\uFF0C\u89E6\u53D1\u9759\u9ED8\u7EED\u671F...`);
      try {
        const ok2 = await this.client.refreshSession();
        if (ok2) {
          console.error(`[Poller] \u2713 \u9759\u9ED8\u7EED\u671F\u6210\u529F \u2014 Cookie \u5DF2\u5237\u65B0\uFF0C.env \u5DF2\u540C\u6B65\uFF0C\u4E0B\u6B21\u7EED\u671F ${_EventPoller.REFRESH_INTERVAL}s \u540E`);
          this.keepaliveFailCount = 0;
          return;
        }
        console.error("[Poller] \u2717 \u9759\u9ED8\u7EED\u671F\u5931\u8D25\uFF08Cookie \u53EF\u80FD\u5DF2\u8FC7\u671F\uFF09\uFF0C\u5C06\u8D70\u63A2\u9488\u6821\u9A8C");
      } catch (err) {
        console.error("[Poller] \u2717 \u9759\u9ED8\u7EED\u671F\u5F02\u5E38:", err);
      }
    }
    try {
      const valid = await this.client.validateSession();
      if (valid) {
        this.keepaliveFailCount = 0;
        return;
      }
      this.keepaliveFailCount++;
      console.error(
        `[Poller] Cookie keepalive: probe failed (${this.keepaliveFailCount}/${_EventPoller.KEEPALIVE_FAIL_THRESHOLD})`
      );
      if (this.keepaliveFailCount >= _EventPoller.KEEPALIVE_FAIL_THRESHOLD) {
        console.error("[Poller] Consecutive failures hit threshold, attempting re-login...");
        this.statusOk = false;
        this.keepaliveFailCount = 0;
        await this.attemptRelogin();
      }
    } catch (err) {
      console.error("[Poller] Cookie keepalive error:", err);
    }
  }
  /**
   * 自动重登录。优先级：
   * 1. 静默续期（headless Playwright，无需扫码）
   * 2. 环境变量 Cookie
   * 3. Playwright QR 扫码
   * 4. ptlogin 协议 QR 扫码
   */
  async attemptRelogin() {
    if (this.reloginLock) {
      console.error("[Poller] re-login already in progress, skipping");
      return false;
    }
    this.reloginLock = true;
    try {
      console.error("[Poller] \u5C1D\u8BD5\u9759\u9ED8\u7EED\u671F\uFF08\u4E0D\u5F39\u7A97\uFF09...");
      try {
        const refreshOk = await this.client.refreshSession();
        if (refreshOk) {
          const valid = await this.client.validateSession();
          if (valid) {
            console.error(`[Poller] \u9759\u9ED8\u7EED\u671F\u6210\u529F\uFF0CQQ\u53F7: ${this.client.qqNumber}`);
            this.statusOk = true;
            return true;
          }
        }
      } catch (e) {
        console.error("[Poller] \u9759\u9ED8\u7EED\u671F\u5931\u8D25:", e);
      }
      const cookieStr = env.cookieString;
      if (cookieStr) {
        console.error("[Poller] \u5C1D\u8BD5\u4F7F\u7528\u73AF\u5883\u53D8\u91CF Cookie \u91CD\u65B0\u767B\u5F55...");
        try {
          this.client.logout();
          await this.client.loginWithCookieString(cookieStr);
          if (this.client.loggedIn) {
            const valid = await this.client.validateSession(true);
            if (valid) {
              console.error(`[Poller] \u73AF\u5883\u53D8\u91CF Cookie \u91CD\u767B\u6210\u529F\uFF0CQQ\u53F7: ${this.client.qqNumber}`);
              this.statusOk = true;
              return true;
            }
          }
        } catch (e) {
          console.error("[Poller] \u73AF\u5883\u53D8\u91CF Cookie \u91CD\u767B\u5931\u8D25:", e);
        }
      }
      this.client.logout();
      console.error("[Poller] \u542F\u52A8 Playwright \u6D4F\u89C8\u5668\u91CD\u65B0\u767B\u5F55...");
      await this.client.loginWithPlaywright();
      if (this.client.loggedIn) {
        console.error(`[Poller] \u91CD\u65B0\u767B\u5F55\u6210\u529F\uFF0CQQ\u53F7: ${this.client.qqNumber}`);
        this.statusOk = true;
        return true;
      }
      console.error("[Poller] \u91CD\u65B0\u767B\u5F55\u5931\u8D25");
      return false;
    } catch (err) {
      console.error("[Poller] re-login error:", err);
      return false;
    } finally {
      this.reloginLock = false;
    }
  }
  // ── 各轮询任务 ──────────────────────────────
  async pollMyPosts() {
    if (!this.client.loggedIn) return;
    const selfId = this.client.qqNumber;
    if (!this.config.emitMessageEvents) return;
    const items = [];
    let rawList = [];
    let fetchOk = false;
    try {
      const res = await this.client.getEmotionList(selfId, 0, 20);
      rawList = Array.isArray(res["msglist"]) ? res["msglist"] : [];
      for (const r of rawList) items.push(normalizeEmotion(r, selfId));
      fetchOk = true;
    } catch {
    }
    if (fetchOk && this.baseline && !this.baseline.postsDone) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const r = rawList[i];
        if (!item.tid || !r) continue;
        this.cacheNormalizedItem(item);
        this.trackTids.add(item.tid);
        this.markSeenPostItem(item, r);
      }
      this.flushSeenTidsImmediate();
      this.baseline.postsDone = true;
      this.saveBaselineState();
      log("INFO", `[Poller] \u9996\u542F\u57FA\u7EBF\uFF1A\u5DF2\u8BB0\u5F55 ${items.length} \u6761\u5386\u53F2\u8BF4\u8BF4\uFF0C\u4E0D\u63A8\u9001`);
    }
    if (fetchOk && this.baseline && !this.baseline.interactiveInitialized) {
      initializeInteractiveBaseline(this.baseline, this.trackTids);
      this.saveBaselineState();
    }
    this.logEventDebug(`[Poller:DEBUG] pollMyPosts got ${items.length} items, seenTids=${this.seenPostTids.size}, trackTids=${this.trackTids.size}`);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const r = rawList[i];
      if (!item.tid || !r) continue;
      this.cacheNormalizedItem(item);
      this.trackTids.add(item.tid);
      const isNew = !this.isPostSeenItem(item, r);
      this.logEventDebug(`[Poller:DEBUG] item tid=${item.tid?.slice(0, 16)}, isNew=${isNew}`);
      if (isNew) {
        const sk = buildStablePostKeyFromItem(item) || buildStablePostKey(r);
        const event = await buildPostEvent(item, selfId, {
          client: this.client,
          attachImageData: this.config.attachImageDataInEvents,
          maxPics: MAX_IMAGE_DATA_PER_EVENT
        }, sk ? {
          stablePostKey: sk,
          authorUin: item.uin ?? selfId,
          cellid: String(r["cellid"] ?? "")
        } : void 0);
        this.logEventDebug(`[Poller:DEBUG] publishing event type=${event.post_type}`);
        await this.hub.publish(event);
        this.markSeenPostItem(item, r);
        this.flushSeenTidsImmediate();
        this.logEventDebug(`[Poller:DEBUG] publish done, subscribers=${this.hub.subscriberCount()}`);
        if (this.config.eventDebug) {
          log("INFO", `[push][seen] myPosts keys=${seenLookupKeysForPost(item, r).join(",")}`);
        }
      }
    }
    this._pruneTrackingDicts(items.map((i) => i.tid).filter((t) => t !== null));
    this.requestInteractiveStateSave();
  }
  async pollFriendFeeds() {
    if (!this.client.loggedIn) return;
    const selfId = this.client.qqNumber;
    try {
      const res = await this.client.getFriendFeeds("", 20);
      const raw = Array.isArray(res["msglist"]) ? res["msglist"] : [];
      if (this.baseline && !this.baseline.friendFeedsDone) {
        for (const r of raw) {
          const item = normalizeEmotion(r, selfId);
          if (!item.tid || !item.uin) continue;
          this.cacheNormalizedItem(item);
          this.markSeenPostItem(item, r);
        }
        this.flushSeenTidsImmediate();
        this.baseline.friendFeedsDone = true;
        this.saveBaselineState();
        log("INFO", `[Poller] \u9996\u542F\u57FA\u7EBF\uFF1A\u5DF2\u8BB0\u5F55 ${raw.length} \u6761\u597D\u53CB\u52A8\u6001\uFF0C\u4E0D\u63A8\u9001`);
      }
      for (const r of raw) {
        const item = normalizeEmotion(r, selfId);
        if (!item.tid || !item.uin) continue;
        this.cacheNormalizedItem(item);
        if (this.config.emitMessageEvents && item.uin === selfId) {
          this.logEventDebug(
            `[Poller:DEBUG] friendFeeds skip own uin=tid ${item.tid?.slice(0, 20)} (pollMyPosts \u5DF2\u7BA1)`
          );
          continue;
        }
        if (this.isPostSeenItem(item, r)) continue;
        const sk = buildStablePostKeyFromItem(item) || buildStablePostKey(r);
        const event = await buildPostEvent(item, selfId, {
          client: this.client,
          attachImageData: this.config.attachImageDataInEvents,
          maxPics: MAX_IMAGE_DATA_PER_EVENT
        }, sk ? {
          stablePostKey: sk,
          authorUin: item.uin,
          cellid: String(r["cellid"] ?? "")
        } : void 0);
        event["_from_friend"] = true;
        await this.hub.publish(event);
        this.markSeenPostItem(item, r);
        this.flushSeenTidsImmediate();
        if (this.config.eventDebug) {
          log("INFO", `[push][seen] friendFeeds keys=${seenLookupKeysForPost(item, r).join(",")}`);
        }
      }
    } catch {
    }
    this.requestInteractiveStateSave();
  }
  cacheNormalizedItem(item) {
    if (!item.tid) return;
    this.client.cachePostMeta(item.tid, {
      uin: item.uin ?? "",
      appid: item.appid ?? "311",
      typeid: item.typeid ?? "0",
      likeUnikey: item.likeUnikey ?? "",
      likeCurkey: item.likeCurkey ?? "",
      abstime: item.createdTime
    });
    this.seedKnownCommentCount(item.tid, item.cmtnum);
  }
  seedKnownCommentCount(tid, count) {
    const safeCount = Math.max(0, count || 0);
    const existing = this.knownCounts.get(tid);
    if (existing) {
      existing.comment = Math.max(existing.comment, safeCount);
      return;
    }
    this.knownCounts.set(tid, { comment: safeCount, like: 0 });
  }
  seedKnownLikeCount(tid, count) {
    const safeCount = Math.max(0, count || 0);
    const existing = this.knownCounts.get(tid);
    if (existing) {
      existing.like = Math.max(existing.like, safeCount);
      return;
    }
    this.knownCounts.set(tid, { comment: 0, like: safeCount });
  }
  async pollComments(selfUin, tid) {
    const seenForTid = this.seenCommentIds.get(tid);
    const isWarm = this.commentWarmTids.has(tid) || !!(seenForTid && seenForTid.size > 0);
    const fetchLimit = isWarm ? _EventPoller.COMMENT_FETCH_LIMIT_STEADY : _EventPoller.COMMENT_FETCH_LIMIT_INITIAL;
    const res = await this.client.getCommentsBestEffort(selfUin, tid, fetchLimit, 0, {
      forceRefresh: !isWarm,
      maxCacheAgeSec: _EventPoller.COMMENT_CACHE_MAX_AGE_SEC
    });
    const rawComments = [];
    for (const key of ["commentlist", "comment_list", "data", "comments"]) {
      const v = res[key];
      if (Array.isArray(v)) {
        rawComments.push(...v);
        break;
      }
    }
    this.logEventDebug(`[Poller:DEBUG] pollComments tid=${tid.slice(0, 8)} got ${rawComments.length} comments`);
    if (this.baseline && isCommentBaselinePending(this.baseline, tid)) {
      this.commentWarmTids.add(tid);
      this.seedKnownCommentCount(tid, rawComments.length);
      try {
        const traffic = await this.client.getTrafficData(selfUin, tid);
        this.seedKnownCommentCount(tid, traffic.comment);
        this.seedKnownLikeCount(tid, traffic.like);
      } catch {
      }
      if (!this.seenCommentIds.has(tid)) this.seenCommentIds.set(tid, /* @__PURE__ */ new Set());
      const seenSet = this.seenCommentIds.get(tid);
      for (const raw of rawComments) {
        const comment = normalizeComment(raw);
        if (!comment.commentId) continue;
        commentDedupMark(seenSet, tid, comment);
      }
      completeCommentBaseline(this.baseline, tid);
      this.saveBaselineState();
      this.requestInteractiveStateSave();
      log("INFO", `[Poller] \u9996\u542F\u57FA\u7EBF\uFF1A\u5DF2\u8BB0\u5F55 tid=${tid.slice(0, 8)} \u7684 ${rawComments.length} \u6761\u5386\u53F2\u8BC4\u8BBA\uFF0C\u4E0D\u63A8\u9001`);
      return;
    }
    if (rawComments.length > 0) {
      this.commentWarmTids.add(tid);
      this.seedKnownCommentCount(tid, rawComments.length);
      for (const raw of rawComments) {
        const comment = normalizeComment(raw);
        if (!comment.commentId) continue;
        if (!this.seenCommentIds.has(tid)) this.seenCommentIds.set(tid, /* @__PURE__ */ new Set());
        const seenSet = this.seenCommentIds.get(tid);
        const isNew = !commentDedupSeen(seenSet, tid, comment);
        this.logEventDebug(`[Poller:DEBUG] comment id=${comment.commentId.slice(0, 16)}, isNew=${isNew}`);
        if (isNew) {
          commentDedupMark(seenSet, tid, comment);
          if (String(comment.uin) === String(selfUin)) {
            this.logEventDebug(`[Poller:DEBUG] skip publish own comment id=${comment.commentId.slice(0, 16)}`);
            continue;
          }
          const event = buildCommentEvent(comment, selfUin, tid, selfUin);
          this.logEventDebug(`[Poller:DEBUG] publishing comment event`);
          await this.hub.publish(event);
        }
      }
    } else {
      await this.pollCountsDelta(selfUin, tid, "comment");
    }
  }
  async pollLikes(selfUin, tid) {
    const rawLikes = await this.client.getLikeListBestEffort(selfUin, tid);
    if (this.baseline && isLikeBaselinePending(this.baseline, tid)) {
      if (!this.seenLikeUins.has(tid)) this.seenLikeUins.set(tid, /* @__PURE__ */ new Set());
      const seenSet = this.seenLikeUins.get(tid);
      for (const raw of rawLikes) {
        const like = normalizeLike(raw);
        if (like.uin) seenSet.add(like.uin);
      }
      this.pendingLikeUsers.set(tid, rawLikes.map((r) => ({
        uin: String(r["uin"] ?? r["fuin"] ?? ""),
        nickname: String(r["name"] ?? r["nick"] ?? r["nickname"] ?? "")
      })).filter((u) => u.uin));
      this.seedKnownLikeCount(tid, rawLikes.length);
      try {
        const traffic = await this.client.getTrafficData(selfUin, tid);
        this.seedKnownCommentCount(tid, traffic.comment);
        this.seedKnownLikeCount(tid, traffic.like);
      } catch {
      }
      completeLikeBaseline(this.baseline, tid);
      this.saveBaselineState();
      this.requestInteractiveStateSave();
      log("INFO", `[Poller] \u9996\u542F\u57FA\u7EBF\uFF1A\u5DF2\u8BB0\u5F55 tid=${tid.slice(0, 8)} \u7684 ${rawLikes.length} \u4E2A\u5386\u53F2\u70B9\u8D5E\uFF0C\u4E0D\u63A8\u9001`);
      return;
    }
    if (rawLikes.length > 0) {
      for (const raw of rawLikes) {
        const like = normalizeLike(raw);
        if (!like.uin) continue;
        if (!this.seenLikeUins.has(tid)) this.seenLikeUins.set(tid, /* @__PURE__ */ new Set());
        if (!this.seenLikeUins.get(tid).has(like.uin)) {
          this.seenLikeUins.get(tid).add(like.uin);
          if (String(like.uin) !== String(selfUin)) {
            const event = buildLikeEvent(like, selfUin, tid, selfUin);
            await this.hub.publish(event);
          }
        }
      }
      this.pendingLikeUsers.set(tid, rawLikes.map((r) => ({
        uin: String(r["uin"] ?? r["fuin"] ?? ""),
        nickname: String(r["name"] ?? r["nick"] ?? r["nickname"] ?? "")
      })).filter((u) => u.uin));
    } else {
      await this.pollCountsDelta(selfUin, tid, "like");
    }
  }
  async pollCountsDelta(selfUin, tid, type) {
    try {
      const traffic = await this.client.getTrafficData(selfUin, tid);
      const count = type === "comment" ? traffic.comment : traffic.like;
      if (count < 0) return;
      const prev = this.knownCounts.get(tid);
      if (!prev) {
        this.knownCounts.set(tid, { comment: traffic.comment, like: traffic.like });
        return;
      }
      const prevCount = type === "comment" ? prev.comment : prev.like;
      const delta = count - prevCount;
      if (delta > 0) {
        if (type === "comment") {
          prev.comment = count;
          this.logEventDebug(`[Poller:DEBUG] comment count increased tid=${tid.slice(0, 8)} delta=${delta}, skip synthetic comment event`);
        } else {
          prev.like = count;
          const pendingUsers = this.pendingLikeUsers.get(tid) ?? [];
          const seenUins = this.seenLikeUins.get(tid) ?? /* @__PURE__ */ new Set();
          for (let i = 0; i < delta; i++) {
            const user = pendingUsers.find((u) => u.uin && !seenUins.has(u.uin));
            if (user) {
              seenUins.add(user.uin);
              if (String(user.uin) !== String(selfUin)) {
                const event = buildLikeEvent(
                  { uin: user.uin, nickname: user.nickname, createdTime: now() },
                  selfUin,
                  tid,
                  selfUin
                );
                await this.hub.publish(event);
              }
            } else {
              const event = buildLikeEvent(
                { uin: "", nickname: "", createdTime: now() },
                selfUin,
                tid,
                selfUin
              );
              await this.hub.publish(event);
            }
          }
          this.pendingLikeUsers.set(tid, pendingUsers.filter((u) => u.uin && !seenUins.has(u.uin)));
        }
      } else {
        if (type === "comment") prev.comment = count;
        else prev.like = count;
      }
    } catch {
    }
  }
  /**
   * 仅收缩「仍在轮询评论/点赞」的 tid 集合；**不得**删除 seenCommentIds / seenLikeUins。
   * 否则旧帖暂时掉出最近 N 条后再进入列表时，会丢失已见评论/点赞，他人评论也会被当成全新 → 重复推送。
   */
  _pruneTrackingDicts(recentTids, max = 100) {
    if (this.trackTids.size <= max) return;
    const toKeep = /* @__PURE__ */ new Set([...recentTids]);
    for (const tid of [...this.trackTids].reverse()) {
      if (toKeep.size >= max) break;
      toKeep.add(tid);
    }
    for (const tid of [...this.trackTids]) {
      if (!toKeep.has(tid)) {
        this.trackTids.delete(tid);
        this.commentWarmTids.delete(tid);
        this.pendingLikeUsers.delete(tid);
        this.knownCounts.delete(tid);
      }
    }
    if (this.baseline && pruneBaselinePending(this.baseline, this.trackTids)) {
      this.saveBaselineState();
    }
  }
  emitHeartbeat() {
    if (!this.running || !this.config.emitHeartbeatEvents) return;
    const selfId = this.client.loggedIn ? safeInt(this.client.qqNumber) : 0;
    const event = buildHeartbeatEvent(String(selfId), { online: this.statusOk, good: this.statusOk });
    this.hub.publish(event).catch(() => {
    });
  }
  getStatus() {
    return { online: this.statusOk, good: this.statusOk, last_error: this.lastError };
  }
};

// vendor/onebot-qzone/src/bridge/config.ts
import "dotenv/config";
function parseUrls(raw) {
  return raw.split(/[,\r\n]+/).map((s) => s.trim()).filter(Boolean);
}
function intEnv(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}
function boolEnv(name, fallback) {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}
function fromEnv() {
  const e = process.env;
  return {
    host: e["ONEBOT_HOST"] ?? "0.0.0.0",
    port: intEnv("ONEBOT_PORT", 8080, 1, 65535),
    accessToken: e["ONEBOT_ACCESS_TOKEN"] ?? "",
    httpPostUrls: parseUrls(e["ONEBOT_HTTP_POST_URLS"] ?? ""),
    wsReverseUrls: parseUrls(e["ONEBOT_WS_REVERSE_URLS"] ?? ""),
    wsReverseApiUrls: parseUrls(e["ONEBOT_WS_REVERSE_API_URLS"] ?? ""),
    wsReverseEventUrls: parseUrls(e["ONEBOT_WS_REVERSE_EVENT_URLS"] ?? ""),
    wsReverseReconnectInterval: intEnv("ONEBOT_WS_REVERSE_RECONNECT_INTERVAL", 5, 1),
    pollInterval: intEnv("ONEBOT_POLL_INTERVAL", 60, 1),
    commentPollInterval: intEnv("ONEBOT_COMMENT_POLL_INTERVAL", 120, 1),
    likePollInterval: intEnv("ONEBOT_LIKE_POLL_INTERVAL", 180, 1),
    friendFeedPollInterval: intEnv("ONEBOT_FRIEND_FEED_POLL_INTERVAL", 120, 1),
    maxRequestBodyBytes: intEnv("ONEBOT_MAX_REQUEST_BODY_BYTES", 64 * 1024 * 1024, 1024),
    baselineOnFirstRun: boolEnv("ONEBOT_BASELINE_ON_FIRST_RUN", true),
    enableQr: boolEnv("QZONE_ENABLE_QR", false),
    emitMessageEvents: boolEnv("ONEBOT_EMIT_MESSAGE_EVENTS", true),
    emitCommentEvents: boolEnv("ONEBOT_EMIT_COMMENT_EVENTS", true),
    emitLikeEvents: boolEnv("ONEBOT_EMIT_LIKE_EVENTS", true),
    emitFriendFeedEvents: boolEnv("ONEBOT_EMIT_FRIEND_FEED_EVENTS", false),
    emitHeartbeatEvents: boolEnv("ONEBOT_EMIT_HEARTBEAT_EVENTS", true),
    eventDebug: boolEnv("ONEBOT_EVENT_DEBUG", false),
    eventPollSource: ["pc", "mobile", "auto"].includes(e["ONEBOT_EVENT_POLL_SOURCE"] ?? "") ? e["ONEBOT_EVENT_POLL_SOURCE"] : "auto",
    attachImageDataInEvents: boolEnv("ONEBOT_ATTACH_IMAGE_DATA", true),
    cachePath: e["QZONE_CACHE_PATH"] ?? "./test_cache",
    proxyUrl: e["QZONE_PROXY_URL"] ?? void 0,
    proxyPool: parseUrls(e["QZONE_PROXY_POOL"] ?? ""),
    imageProxyUrl: e["QZONE_IMAGE_PROXY"] ?? void 0
  };
}

// deploy/qzone-http.ts
import http2 from "node:http";
import fs5 from "node:fs";
import path4 from "node:path";
import crypto from "node:crypto";
function createBridge({ client: client2, handler: handler2, token: token2, data: data2, now: now2 = Date.now, ttl = 3e5 }) {
  const qrPath = path4.join(data2, "qrcode.png");
  let verifiedAt = null, qrStartedAt = null, qrRunning = false, error = "not_checked";
  const reads = /* @__PURE__ */ new Set(["get_login_info", "get_status", "check_cookie", "get_friend_feeds", "get_emotion_list", "get_comment_list"]);
  const writes = /* @__PURE__ */ new Set(["send_private_msg", "send_comment", "send_like"]);
  const clearQR = () => {
    try {
      fs5.unlinkSync(qrPath);
    } catch {
    }
  };
  const online = () => verifiedAt !== null && client2.loggedIn === true && now2() - verifiedAt >= 0 && now2() - verifiedAt <= ttl;
  const failure = (code) => ({ status: "failed", retcode: 1500, data: null, reason: code });
  const invalidate = () => {
    verifiedAt = null;
    error = "authentication_unverified";
  };
  async function verify() {
    invalidate();
    const response = await handler2.handle("check_cookie", { probe: true });
    if (response?.status !== "ok" || response?.retcode !== 0 || response?.data?.valid !== true) {
      client2.qqNumber = null;
      throw Error("authentication_failed");
    }
    verifiedAt = now2();
    error = "";
  }
  const server = http2.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (code, value) => {
      res.writeHead(code);
      res.end(JSON.stringify(value));
    };
    const auth = Buffer.from(req.headers.authorization || ""), expected = Buffer.from("Bearer " + token2);
    if (auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) return send(401, { reason: "unauthorized" });
    const action = (req.url || "/").split("?")[0].slice(1);
    if (req.method === "GET" && action === "health") return send(200, { ok: online(), qq: online() ? client2.qqNumber : null, verified_at: verifiedAt === null ? null : verifiedAt / 1e3, qr_running: qrRunning, reason: error || (!online() ? "check_expired" : "") });
    if (req.method === "GET" && action === "qr") {
      if (!qrRunning || qrStartedAt === null || now2() - qrStartedAt > 18e4) {
        clearQR();
        return send(404, { reason: "qr_unavailable" });
      }
      try {
        const stat = fs5.lstatSync(qrPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs < qrStartedAt - 1e3 || stat.size > 1e6) throw Error();
        const image = fs5.readFileSync(qrPath);
        if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw Error();
        return send(200, { image: "data:image/png;base64," + image.toString("base64"), expires_at: (qrStartedAt + 18e4) / 1e3, note: "\u4EC5\u4F9B\u4E3B\u4EBA\u626B\u7801\uFF0C\u767B\u5F55\u4E0D\u4F1A\u542F\u7528\u81EA\u52A8\u793E\u4EA4" });
      } catch {
        return send(404, { reason: "qr_not_ready" });
      }
    }
    if (req.method !== "POST") return send(405, { reason: "method_not_allowed" });
    try {
      const buffers = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) return send(413, { reason: "too_large" });
        buffers.push(chunk);
      }
      const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString("utf8")) : {};
      if (!body || Array.isArray(body) || typeof body !== "object") return send(400, { reason: "invalid_body" });
      if (action === "logout") {
        if (qrRunning) return send(409, { reason: "login_in_progress" });
        invalidate();
        client2.qqNumber = null;
        client2.cookies = {};
        clearQR();
        try {
          fs5.unlinkSync(path4.join(data2, "cookies.json"));
        } catch {
        }
        return send(200, { logged_out: true });
      }
      if (action === "auth-cookie") {
        if (qrRunning) return send(409, { reason: "login_in_progress" });
        if (typeof body.cookie !== "string" || !body.cookie || body.cookie.length > 2e4) return send(400, { reason: "invalid_cookie" });
        invalidate();
        clearQR();
        await client2.loginWithCookieString(body.cookie);
        await verify();
        return send(200, { configured: true, online: online() });
      }
      if (action === "login-qr") {
        if (online()) return send(200, { note: "\u7A7A\u95F4\u5DF2\u767B\u5F55\uFF0C\u672A\u6539\u53D8\u793E\u4EA4\u5F00\u5173" });
        if (!qrRunning) {
          invalidate();
          client2.qqNumber = null;
          clearQR();
          qrRunning = true;
          qrStartedAt = now2();
          Promise.resolve().then(() => client2.loginWithPlaywright(180, true)).then(verify).catch(() => {
            invalidate();
            client2.qqNumber = null;
            error = "qr_login_failed";
          }).finally(() => {
            qrRunning = false;
            clearQR();
          });
        }
        return send(200, { note: "\u5DF2\u542F\u52A8\u65E0\u5934\u626B\u7801\uFF1B\u7A0D\u540E\u518D\u6B21\u83B7\u53D6\u4E8C\u7EF4\u7801", expires_at: (qrStartedAt + 18e4) / 1e3 });
      }
      if (!reads.has(action) && !writes.has(action)) return send(404, { reason: "action_not_allowed" });
      if (action === "check_cookie") {
        await verify();
        return send(200, { status: "ok", retcode: 0, data: { valid: true } });
      }
      if (!online()) await verify();
      const result = await handler2.handle(action, body);
      if (result?.retcode !== 0 || result?.status !== "ok") {
        if (result?.retcode === 1401) invalidate();
        if (writes.has(action)) return send(502, failure("write_result_unconfirmed"));
        return send(200, { status: "failed", retcode: 1500, data: null, reason: "upstream_rejected" });
      }
      verifiedAt = now2();
      return send(200, { status: "ok", retcode: 0, data: result.data ?? null });
    } catch {
      invalidate();
      clearQR();
      return send(502, failure("bridge_operation_failed"));
    }
  });
  return { server, close: () => {
    clearQR();
    server.closeAllConnections();
    server.close();
  } };
}

// deploy/qzone-entry.ts
console.log = () => {
};
console.warn = () => {
};
console.error = () => {
};
var token = fs6.readFileSync(process.env.QQAGENT_BRIDGE_TOKEN_FILE, "utf8").trim();
if (token.length < 32) process.exit(1);
var data = process.env.QQAGENT_QZONE_DATA || "/var/lib/qq-agent-qzone";
var config = fromEnv();
config.host = "127.0.0.1";
config.port = 13702;
config.accessToken = token;
var client = new QzoneClient({ cachePath: data });
var hub = new EventHub({ eventDebug: false });
var poller = new EventPoller(client, hub, config);
var handler = new ActionHandler(client, hub, poller, config);
var bridge = createBridge({ client, handler, token, data });
bridge.server.listen(13702, "127.0.0.1");
process.on("SIGTERM", () => {
  bridge.close();
  process.exit(0);
});
process.on("uncaughtException", () => {
  bridge.close();
  process.exit(1);
});
process.on("unhandledRejection", () => {
  bridge.close();
  process.exit(1);
});
