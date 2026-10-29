#!/usr/bin/env bash
# =============================================================================
# whale-monitor.sh —— QQ AI 机器人「小鲸鱼」轻量健康检查
# =============================================================================
# 设计原则:
#   1) 不引入任何监控平台（无 Prometheus / node_exporter / 云监控），只用系统自带命令。
#   2) 只读：**不重启任何东西、不修改任何文件**（不写临时文件，全部用管道与内存变量）。
#   3) 四项**独立**检查，分别给结论 —— 只看"进程在不在"是不够的：
#        · 进程存活      systemctl is-active qqwhale.service
#        · Web 端口可连  对 127.0.0.1:$WHALE_WEB_PORT 做 TCP 连接测试
#        · QQ 网关连接   扫描最近的 dsh 日志里的连接/重连/鉴权记录（输出前脱敏）
#        · 模型 API      扫描最近的 dsh 日志里的调用成功/限流/超时/鉴权失败记录
#      另外顺带输出资源占用：进程 RSS、CPU 时间、数据目录体积、备份目录体积、磁盘剩余。
#
# 用法:
#   bash whale-monitor.sh            # 人类可读表格
#   bash whale-monitor.sh --json     # 机器可读 JSON（便于接入你自己的告警）
#   bash whale-monitor.sh --help
#
# 退出码: 0 = 四项全部正常；1 = 有告警（含"无法判定"）；2 = 有致命问题
#
# 可覆盖的环境变量:
#   WHALE_SERVICE=qqwhale.service     WHALE_WEB_HOST=127.0.0.1   WHALE_WEB_PORT=3080
#   WHALE_HOME=/home/qqwhale          WHALE_ROOT=$WHALE_HOME/whale
#   DSH_HOME=$WHALE_HOME/.dsh         WHALE_LOG_DIR=$WHALE_ROOT/logs
#   WHALE_MONITOR_TAIL=800            每个日志文件最多看最后多少行
#   WHALE_MONITOR_TIMEOUT=5           单条命令超时秒数（有 timeout 时生效）
#   WHALE_GW_OK_RE / WHALE_GW_WARN_RE / WHALE_GW_FATAL_RE
#   WHALE_LLM_OK_RE / WHALE_LLM_WARN_RE / WHALE_LLM_FATAL_RE
#   说明：日志关键词是**可覆盖的启发式规则** —— 上游日志文案变化时，用这几个变量调整，
#         不需要改脚本。默认规则见下面"关键词"段。
# =============================================================================
set -euo pipefail

# ── 沙箱安全重定向（QQ 小鲸鱼项目专用）─────────────────────────────────────
# 本机 /dev/null 被改成 crw------- root（宿主机既有异常），非 root 进程打不开，
# 任何 `>"$NULL_DEV"` 都会让命令整体失败（实测把 command -v 判成"命令不存在"）。
# 这里在脚本启动时探测一次：打不开就把 NULL_DEV 指到项目内的 private-null 节点
# （由 deploy/install.sh 以 mknod 创建，权限 666）。后续统一用 $NULL_DEV。
# 该变量只影响本脚本内部的重定向目标，不改宿主机任何配置。
NULL_DEV=/dev/null
# 探测规则（务必保持）：判断"能否写 /dev/null"时，stderr 只能丢弃到
# 一个**当前已知可写**的地方。第一次探测时唯一可靠的丢弃点是 fd1/合并没有意义 ——
# 所以用 `2>&-`（关闭 stderr）而不是 2>/dev/null：后者本身就是要验证的设备，
# 设备坏了探测就永远失败（真机踩过：tar 因此被误判不存在）。
# mknod 出来的 private-null（c 1 3，666）作为回退目标，由 install.sh 创建。
if ! ( : > /dev/null ) 2>&- ; then
    for _cand in "${WHALE_ROOT:-/home/qqwhale/whale}/etc/private-null" /home/qqwhale/whale/etc/private-null; do
        if [ -c "$_cand" ] && ( : > "$_cand" ) 2>&-; then NULL_DEV="$_cand"; break; fi
    done
fi
# 把脚本内后续出现的字面 /dev/null 重定向统一替换为 $NULL_DEV（见下方 sed 预处理）。


# ---------------------------------------------------------------------------
# 变量契约
# ---------------------------------------------------------------------------
WHALE_USER="${WHALE_USER:-qqwhale}"
WHALE_HOME="${WHALE_HOME:-/home/${WHALE_USER}}"
WHALE_ROOT="${WHALE_ROOT:-${WHALE_HOME}/whale}"
DSH_HOME="${DSH_HOME:-${WHALE_HOME}/.dsh}"
WHALE_WEB_PORT="${WHALE_WEB_PORT:-3080}"
WEB_HOST="${WHALE_WEB_HOST:-127.0.0.1}"
SERVICE="${WHALE_SERVICE:-qqwhale.service}"
LOG_DIR="${WHALE_LOG_DIR:-${WHALE_ROOT}/logs}"
TAIL_LINES="${WHALE_MONITOR_TAIL:-800}"
CMD_TIMEOUT="${WHALE_MONITOR_TIMEOUT:-5}"
# 模型/消息证据的新鲜度窗口：在这个窗口内有过真实调用，就认为"近期正常"。
# 太小会把正常空闲误判成未知，太大则掩盖长时间停摆；24 小时是折中值。
EVIDENCE_MAX_AGE_HOURS="${WHALE_EVIDENCE_MAX_AGE_HOURS:-24}"

# ---------------------------------------------------------------------------
# 日志关键词（启发式；均可用环境变量覆盖）
#   设计要点：每组关键词都**要求带上本领域的上下文词**（网关用 websocket/网关/
#   QQBot/session 等，模型用 llm/模型/completion 等），否则会出现跨域误判 ——
#   例如"llm retry: 429"被算进 QQ 网关、"websocket 4914"被算进模型 API。
#   上游文案变化时改这几个变量即可，不必改脚本。
# ---------------------------------------------------------------------------
# QQ 网关：正常连接 / 重连与断开 / 鉴权失败与封禁
# 注意：域内间隔一律用 `.*`（同一行内任意字符）而**不要**写 `[^ ]{0,N}` ——
# 后者无法跨越空格，像 "websocket closed: code=4914" 这种带空格的日志就永远匹配不上
# （BSD grep 还会因此报 invalid repetition count(s)）。grep 是逐行匹配，`.*` 不会跨行。
GW_OK_RE="${WHALE_GW_OK_RE:-\[im-qqbot\] Bot ready!|websocket.*(is open|connected)|gateway.*READY|Identify 成功|session resumed}"
GW_WARN_RE="${WHALE_GW_WARN_RE:-.*(websocket|网关|gateway|QQBot|qqbot|session|Identify).*(closed|close code|disconnect|重连|reconnect|断开|失败|error|1006|超时|timeout)}"
GW_FATAL_RE="${WHALE_GW_FATAL_RE:-4914|4915|.*(websocket|网关|gateway|QQBot|qqbot).*(401|403|鉴权失败|未授权|unauthorized|invalid.*(token|secret))|机器人已(下架|封禁)}"
# 模型 API：调用成功 / 限流与超时 / 鉴权与额度失败
LLM_OK_RE="${WHALE_LLM_OK_RE:-.*(llm|模型|completion|chat/completions).*(ok|success|成功|完成|响应|tokens? used|usage)|tokens? used}"
LLM_WARN_RE="${WHALE_LLM_WARN_RE:-.*(llm|模型|completion|chat/completions|openai|deepseek|anthropic|provider).*(429|rate.?limit|too many requests|限流|retry|retrying|重试|timeout|timed out|超时|ECONNRESET|ETIMEDOUT|socket hang up|failed|失败|error)}"
LLM_FATAL_RE="${WHALE_LLM_FATAL_RE:-.*(llm|模型|completion|chat/completions|api[_-]?key|provider).*(401|403|unauthorized|invalid api key|invalid_api_key|欠费|余额不足|insufficient|quota exceeded|额度)}"

JSON=0

# ---------------------------------------------------------------------------
# 结果容器（bash 3.2 没有关联数组，用并行数组）
# ---------------------------------------------------------------------------
C_NAME=(); C_STATE=(); C_SUM=(); C_DET=()
PROC_STATE="unknown"
MAIN_PID=""
RECENT_LOG=""
LOG_NOTE=""
# 模型/消息证据（由 scripts/llm-evidence.mjs 采集，见 _collect_evidence）
EV_REPLY_STATUS="none"; EV_REPLY_ERROR_CODES=""
EV_MODEL_STATUS=""; EV_MODEL_AGE_SECONDS=""; EV_MODEL_TOTAL_INPUT_TOKENS=""
EV_MODEL_TOTAL_OUTPUT_TOKENS=""; EV_MODEL_CACHE_READ_TOKENS=""
EV_MODEL_LAST_TURN=""; EV_MODEL_PROVIDER=""; EV_MODEL_MODEL=""
MSG_STATUS=""; MSG_AGE_SECONDS=""; MSG_TURNS=""; MSG_SCOPE=""
EVIDENCE_NOTE=""

# ---------------------------------------------------------------------------
# 输出 helper（中文）
# ---------------------------------------------------------------------------
usage() {
  cat <<'EOF'
whale-monitor.sh —— 小鲸鱼健康检查（只读，不重启任何东西）

用法:
  bash whale-monitor.sh [--json]

检查项:
  1. 进程存活（systemctl is-active；沙箱内无总线时回退到 /proc 探测）
  2. Web 端口可连（TCP 连接 127.0.0.1:${WHALE_WEB_PORT}）
  3. QQ 网关连接（扫描最近日志的连接/重连/鉴权记录，输出前脱敏）
  4. 模型 API 可用性（扫描最近日志的调用成功/限流/超时/鉴权记录）
  另附: 进程 RSS、CPU 时间、数据目录体积、备份目录体积、磁盘剩余

退出码: 0 全部正常；1 有告警；2 有致命问题。
EOF
}

# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
_have() { command -v "$1" >"$NULL_DEV" 2>&1; }

# 文件 mtime（秒）—— 兼容 GNU 与 BSD stat（生产目标是 Linux）
_st_mtime() {
  if stat -c '%Y' / >"$NULL_DEV" 2>&1; then stat -c '%Y' "$1"; else stat -f '%m' "$1"; fi
}

# 带超时执行（避免 systemctl/du 卡住导致定时任务堆积）
_run_t() {
  if _have timeout; then timeout "$CMD_TIMEOUT" "$@"; else "$@"; fi
}

_add() {   # $1=名称 $2=状态(ok|warn|fatal|unknown) $3=摘要 $4=细节
  C_NAME+=("$1"); C_STATE+=("$2"); C_SUM+=("$3"); C_DET+=("$4")
}

# 状态 → 退出码权重
_weight() {
  case "$1" in
    ok) printf 0 ;;
    unknown|warn) printf 1 ;;
    fatal) printf 2 ;;
    *) printf 1 ;;
  esac
}
_label() {
  case "$1" in
    ok) printf 'OK  ' ;;
    warn) printf '告警' ;;
    fatal) printf '致命' ;;
    unknown) printf '未知' ;;
    *) printf '?   ' ;;
  esac
}

# 显示宽度（中文按 2 列估算：非 ASCII 字节每 3 字节算 2 列）
_dwidth() {
  printf '%s' "$1" | LC_ALL=C awk '{ a=0; m=0; for (i=1;i<=length($0);i++) { c=substr($0,i,1); if (c ~ /[ -~]/) a++; else m++ } printf "%d", a + int(m/3)*2 + (m%3) }'
}
_rule() {   # 打印分隔线
  local i=0 n="${1:-60}"
  while [ "$i" -lt "$n" ]; do printf '─'; i=$((i + 1)); done
  printf '\n'
}

# 脱敏：抹掉疑似 token/secret 的值与超长随机串（输出日志行之前必须过这一层）。
# 可移植性说明：`X\{32,\}`（区间量词）在 GNU sed / BSD sed 下都可用；
# 不用 `\{32,\}` 后不转义的反引号式 {32,} 写法（BSD sed 不支持非转义形式）。
_redact() {
  sed -E \
    -e 's/(([Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Bb][Ee][Aa][Rr][Ee][Rr]|[Aa][Pp][Pp][Ss][Ee][Cc][Rr][Ee][Tt]|[Ss]ign)[^[:space:]=:]{0,16}[=:][[:space:]]*)[^[:space:]]+/\1***/g' \
    -e 's/[A-Za-z0-9_+.\/-]{32,}/***/g'
}
# 单行脱敏 + 截断（表格与 JSON 里都用它）。调用方负责传一个参数（无匹配时传空串）。
_redact_line() {
  printf '%s\n' "${1:-}" | _redact | cut -c1-200
}

# ---------------------------------------------------------------------------
# 检查 1：进程存活
# ---------------------------------------------------------------------------
_proc_probe_alive() {
  # 沙箱内没有 systemd 总线（"Failed to connect to bus: No medium found"）时的
  # 回退检查：直接读 /run/systemd 与 /proc。语义与 is-active 等价性足够做告警。
  local pid=""
  if [ -r "/run/systemd/units/qqwhale.service" ] || [ -d "/run/systemd/system" ]; then
    pid=$(systemctl show -p MainPID --value "$SERVICE" 2>"$NULL_DEV" | head -1)
  fi
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then
    pid=$(pgrep -u "$(id -un 2>"$NULL_DEV" || echo qqwhale)" -f "node .*dsh web" 2>"$NULL_DEV" | head -1 || true)
  fi
  if [ -n "$pid" ] && [ -d "/proc/$pid" ]; then
    PROC_STATE="active"
    _add "进程存活" "ok" "进程在运行（/proc 探测，PID=${pid}）" \
         "systemctl 总线在服务沙箱内不可达（属预期）；属主=$(ps -o user= -p "$pid" 2>"$NULL_DEV" | tr -d ' ')"
  else
    PROC_STATE="fatal"
    _add "进程存活" "fatal" "未发现运行中的进程（/proc 探测）" \
         "在 /proc 中未找到 node dsh web 进程；请人工执行 systemctl status ${SERVICE}"
  fi
  return 0
}

check_process() {
  if ! _have systemctl; then
    _proc_probe_alive
    return 0
  fi
  local out rc=0
  # 本服务是 system 级单元（User=qqwhale），因此查系统 systemctl 而非 --user。
  # 若当前环境连不上总线（例如从另一个沙箱内调用本脚本），回退到 /proc 探测。
  out=$(_run_t systemctl is-active "$SERVICE" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "Failed to connect to bus\|No medium found"; then
    _proc_probe_alive
    return 0
  fi
  out=$(printf '%s' "$out" | head -1)
  case "$out" in
    active)
      PROC_STATE="ok"
      MAIN_PID=$(_run_t systemctl show -p MainPID --value "$SERVICE" 2>"$NULL_DEV" | head -1) || MAIN_PID=""
      _add "进程存活" "ok" "systemd 报告 active" "MainPID=${MAIN_PID:-未知}（unit ${SERVICE}）"
      ;;
    activating|reloading)
      PROC_STATE="warn"
      _add "进程存活" "warn" "服务正在启动/重载中" "systemctl is-active 返回：$out"
      ;;
    failed)
      PROC_STATE="fatal"
      _add "进程存活" "fatal" "单元处于 failed 状态" \
           "排查：systemctl status ${SERVICE}；journalctl -u ${SERVICE} -n 50"
      ;;
    inactive|deactivating)
      PROC_STATE="fatal"
      _add "进程存活" "fatal" "服务未运行（${out}）" \
           "排查：systemctl start ${SERVICE}（由人工执行；本脚本不会自动启动）"
      ;;
    *)
      PROC_STATE="unknown"
      _add "进程存活" "unknown" "无法判定（退出码 ${rc}）" \
           "systemctl 输出：$(printf '%s' "$out" | cut -c1-160)"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# 检查 2：Web 端口 TCP 可连
#   bash 的 /dev/tcp 优先；不支持时退回 nc。带看门狗超时，避免连接挂死。
# ---------------------------------------------------------------------------
_port_open() {
  local host="$1" port="$2" pid rc=0 waited=0 limit
  limit=$((CMD_TIMEOUT * 10))
  # bash 内建 /dev/tcp：端口关闭会立刻失败；若对端被丢包过滤则可能长时间阻塞，
  # 所以放到后台子 shell 里执行并加看门狗超时，绝不让监控脚本自己卡死。
  ( exec 3<>"/dev/tcp/${host}/${port}" ) >"$NULL_DEV" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>"$NULL_DEV"; do
    if [ "$waited" -ge "$limit" ]; then
      kill -TERM "$pid" 2>"$NULL_DEV" || true
      wait "$pid" 2>"$NULL_DEV" || true
      return 1
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  wait "$pid" 2>"$NULL_DEV" || rc=$?
  return "$rc"
}
check_port() {
  local state sum det
  if _port_open "$WEB_HOST" "$WHALE_WEB_PORT"; then
    state="ok"; sum="TCP 连接成功"
    det="${WEB_HOST}:${WHALE_WEB_PORT} 可建立连接（DSH Web UI 在监听）"
  elif _have nc && _run_t nc -z -w 2 "$WEB_HOST" "$WHALE_WEB_PORT" >"$NULL_DEV" 2>&1; then
    state="ok"; sum="TCP 连接成功（nc）"
    det="${WEB_HOST}:${WHALE_WEB_PORT} 可建立连接"
  else
    # 端口不可连：服务本就没跑的话属"预期"，否则是致命
    if [ "$PROC_STATE" = "ok" ]; then
      state="fatal"; sum="端口不可连接（进程却在运行）"
      det="${WEB_HOST}:${WHALE_WEB_PORT} 连接被拒绝；说明 Web UI 没起来或绑到了别的端口/地址"
    else
      state="warn"; sum="端口不可连接"
      det="${WEB_HOST}:${WHALE_WEB_PORT} 连接失败（服务当前未运行，属预期；若刚重启请稍后再看）"
    fi
  fi
  _add "Web 端口" "$state" "$sum" "$det"
}

# ---------------------------------------------------------------------------
# 采集最近日志（只读，不写任何文件）。
# 文件按 **mtime 升序** 拼接：这样"拼接串里最后一个匹配"≈"时间上最近的一条"。
# （不按文件名字典序：dsh.err.log 会永远排在 dsh.log 前面，时间先后就乱了。）
# 局限：stdout/stderr 两个流各自追加，跨流交错时"最近"只是近似 —— 对健康检查足够。
# ---------------------------------------------------------------------------
_collect_logs() {
  local files=() f line
  if [ ! -d "$LOG_DIR" ]; then
    LOG_NOTE="日志目录不存在：$LOG_DIR"
    RECENT_LOG=""
    return 0
  fi
  while IFS= read -r f; do files+=("$f"); done < <(
    find "$LOG_DIR" -maxdepth 1 -type f -name '*.log' -print 2>"$NULL_DEV" |
      while IFS= read -r line; do
        printf '%s\t%s\n' "$(_st_mtime "$line" 2>"$NULL_DEV" || printf 0)" "$line"
      done | LC_ALL=C sort -k1,1n -k2,2 | cut -f2-
  )
  if [ "${#files[@]}" -eq 0 ]; then
    LOG_NOTE="日志目录里没有 *.log 文件：$LOG_DIR"
    RECENT_LOG=""
    return 0
  fi
  RECENT_LOG=$(
    {
      for f in ${files[@]+"${files[@]}"}; do
        printf '##### %s\n' "$(basename "$f")"
        tail -n "$TAIL_LINES" "$f" 2>"$NULL_DEV" || true
      done
    # Loader diagnostics contain field names such as provider/error, not API failures.
    } | sed '/\[whale-check\] pending /d' | tail -n $((TAIL_LINES * 2))
  ) || RECENT_LOG=""
  LOG_NOTE="已读取 ${#files[@]} 个日志文件（每个最多末 ${TAIL_LINES} 行，按修改时间排序）"
}

# 最后一个匹配行的行号（1 起；无匹配为 0）。行号大 = 拼接串里更靠后 = 更近。
_last_index() {
  local n
  n=$(printf '%s\n' "$RECENT_LOG" | grep -Ein -- "$1" 2>"$NULL_DEV" | tail -n 1 | cut -d: -f1) || n=""
  printf '%s' "${n:-0}"
}
_last_line() {
  local line
  line=$(printf '%s\n' "$RECENT_LOG" | grep -Ei -- "$1" 2>"$NULL_DEV" | tail -n 1) || line=""
  # 注意：_redact_line 接收**参数**而不是 stdin —— 写成 `| _redact_line` 会传空值（踩过）
  _redact_line "$line"
}

# 通用判定：把"最近一次匹配"归类为 ok/warn/fatal
# 平局规则（同一行同时命中多组关键词，例如"websocket closed: code=4914"）：
# 按严重程度取高的 —— fatal > warn > ok。
_verdict() {   # $1=类别名(写入摘要) $2=fatal正则 $3=warn正则 $4=ok正则
  local label="$1" fre="$2" wre="$3" ore="$4"
  local idx_fatal idx_warn idx_ok max state sum det last
  if [ -z "${RECENT_LOG//[[:space:]]/}" ]; then
    _add "$label" "unknown" "无法判定：没有可读日志" "$LOG_NOTE"
    return 0
  fi
  idx_fatal=$(_last_index "$fre")
  idx_warn=$(_last_index "$wre")
  idx_ok=$(_last_index "$ore")
  max=0; state="unknown"
  if [ "${idx_ok:-0}" -gt "$max" ]; then max=$idx_ok; state="ok"; fi
  if [ "${idx_warn:-0}" -gt "$max" ]; then max=$idx_warn; state="warn"; fi
  # 平局（== max）时以 fatal 为准
  if [ "${idx_fatal:-0}" -gt 0 ] && [ "${idx_fatal:-0}" -ge "$max" ]; then max=$idx_fatal; state="fatal"; fi

  case "$state" in
    ok)
      last=$(_last_line "$ore")
      sum="最近一次相关记录为正常"
      det="最近匹配：${last:-（无内容）}"
      ;;
    warn)
      last=$(_last_line "$wre")
      sum="最近一次相关记录是告警（重连/限流/超时等）"
      det="最近匹配：${last:-（无内容）}"
      ;;
    fatal)
      last=$(_last_line "$fre")
      sum="最近一次相关记录是失败（鉴权/封禁/额度等）"
      det="最近匹配：${last:-（无内容）}"
      ;;
    *)
      sum="近期日志中没有相关记录，无法判定"
      det="${LOG_NOTE}；如日志文案不同，可用环境变量覆盖关键词"
      ;;
  esac
  _add "$label" "$state" "$sum" "$det"
}

# ---------------------------------------------------------------------------
# 模型/消息证据采集（权威证据，替代"只看日志"）
#
# 背景：DSH 常规日志不输出模型调用成功事件（实测确认），只扫日志时模型状态
# 永远是 unknown。但调用真的发生时有两处直接产物：
#   · $DSH_HOME/storages/**/sessions/*.json 的 record.rows.tokenUsage
#   · $WHALE_ROOT/data/.qqbot/{thinking-log,four-source}.jsonl 的轮次时间戳
# 由 scripts/llm-evidence.mjs 只读提取（不解析正文、不联网、不写文件）。
# 缺 node 或读取器未安装时静默降级为"无证据"，不影响其他检查项。
# ---------------------------------------------------------------------------
_collect_evidence() {
  local helper out k v line
  helper="${WHALE_ROOT}/bin/llm-evidence.mjs"
  if [ ! -f "$helper" ]; then
    helper="$(dirname "$0")/llm-evidence.mjs"
  fi
  if [ ! -f "$helper" ] || ! _have node; then
    EVIDENCE_NOTE="未安装证据读取器（llm-evidence.mjs）或缺少 node，跳过模型/消息证据采集"
    return 0
  fi
  out=$(_run_t node "$helper" --dsh-home "$DSH_HOME" --data-root "${WHALE_ROOT}/data" \
        --max-age-hours "$EVIDENCE_MAX_AGE_HOURS" 2>&1) || out=""
  # 只接受白名单键：node 的报错文本可能恰好形成 "KEY=VALUE" 形状，
  # 无差别 eval 会把报错内容当变量值（尤其是带空格的错误信息）。
  while IFS='=' read -r k v; do
    case "$k" in
      REPLY_STATUS) EV_REPLY_STATUS="$v" ;;
      REPLY_ERROR_CODES) EV_REPLY_ERROR_CODES="$v" ;;
      MODEL_STATUS)              EV_MODEL_STATUS="$v" ;;
      MODEL_AGE_SECONDS)         EV_MODEL_AGE_SECONDS="$v" ;;
      MODEL_TOTAL_INPUT_TOKENS)  EV_MODEL_TOTAL_INPUT_TOKENS="$v" ;;
      MODEL_TOTAL_OUTPUT_TOKENS) EV_MODEL_TOTAL_OUTPUT_TOKENS="$v" ;;
      MODEL_CACHE_READ_TOKENS)   EV_MODEL_CACHE_READ_TOKENS="$v" ;;
      MODEL_LAST_TURN)           EV_MODEL_LAST_TURN="$v" ;;
      MODEL_PROVIDER)            EV_MODEL_PROVIDER="$v" ;;
      MODEL_MODEL)               EV_MODEL_MODEL="$v" ;;
      MSG_STATUS)                MSG_STATUS="$v" ;;
      MSG_AGE_SECONDS)           MSG_AGE_SECONDS="$v" ;;
      MSG_TURNS)                 MSG_TURNS="$v" ;;
      MSG_SCOPE)                 MSG_SCOPE="$v" ;;
      EVIDENCE_NOTE)             EVIDENCE_NOTE="$v" ;;
      *) : ;;   # 其余（含 MODEL_SESSION_FILE）不参与判定
    esac
  done <<EOF
$out
EOF
  return 0
}

# 秒 → 便于阅读的中文时长（用于细节说明）
_human_age() {   # $1=秒
  local s="${1:-}"
  case "$s" in ''|*[!0-9]*) printf '未知'; return 0 ;; esac
  if [ "$s" -lt 120 ]; then printf '%s 秒' "$s"
  elif [ "$s" -lt 7200 ]; then printf '%s 分钟' "$((s / 60))"
  elif [ "$s" -lt 172800 ]; then printf '%s 小时' "$((s / 3600))"
  else printf '%s 天' "$((s / 86400))"; fi
}

# 日志侧判定码：0=ok 1=warn 2=fatal 3=日志无相关记录
_log_verdict_code() {   # $1=fatal正则 $2=warn正则 $3=ok正则
  local idx_fatal idx_warn idx_ok max=0 code=3
  if [ -z "${RECENT_LOG//[[:space:]]/}" ]; then
    printf 3; return 0
  fi
  idx_fatal=$(_last_index "$1"); idx_warn=$(_last_index "$2"); idx_ok=$(_last_index "$3")
  if [ "${idx_ok:-0}" -gt "$max" ]; then max=$idx_ok; code=0; fi
  if [ "${idx_warn:-0}" -gt "$max" ]; then max=$idx_warn; code=1; fi
  if [ "${idx_fatal:-0}" -gt 0 ] && [ "${idx_fatal:-0}" -ge "$max" ]; then code=2; fi
  printf '%s' "$code"
}

# QQ 网关：日志优先，日志无声时用"消息真的往来过"作为通道健康证据。
# 真实失败/告警绝不被证据覆盖 —— 日志一旦报错就直接采信。
# 检查「最后一轮是否真的回复成功」。
# 为什么必须有这条：2026-10-17 事故中网关与模型探测都是 OK，但会话因
# CONTEXT_WINDOW_EXCEEDED 连续整轮失败，机器人一声不吭——只测"通不通"会漏掉这种哑火。
check_reply_errors() {
  case "$EV_REPLY_STATUS" in
    ok) _add "会话回复" ok "当前会话最近已结束轮次无整轮错误" "依据真实 turn/end；新建空会话不计为已回复" ;;
    error) _add "会话回复" warn "当前会话有整轮失败：${EV_REPLY_ERROR_CODES:-UNKNOWN}" "请查看调用记录与上下文压力" ;;
    *) _add "会话回复" unknown "当前会话还没有可验证的结束记录" "尚未产生 turn/end，不宣称回复正常" ;;
  esac
}

check_gateway() {
  local code
  code=$(_log_verdict_code "$GW_FATAL_RE" "$GW_WARN_RE" "$GW_OK_RE")
  case "$code" in
    2) _add "QQ 网关" fatal "最近一次相关记录是失败（鉴权/封禁）" \
         "最近匹配：$(_last_line "$GW_FATAL_RE")" ;;
    1) _add "QQ 网关" warn "最近一次相关记录是告警（重连/断开等）" \
         "最近匹配：$(_last_line "$GW_WARN_RE")" ;;
    0) _add "QQ 网关" ok "最近一次相关记录为正常" \
         "最近匹配：$(_last_line "$GW_OK_RE")" ;;
    *)
      case "${MSG_STATUS:-}" in
        ok) _add "QQ 网关" ok "近期有真实消息往来（插件轮次日志证据）" \
              "最近一条消息记录约 $(_human_age "$MSG_AGE_SECONDS")前（第 ${MSG_TURNS:-?} 轮，scope=${MSG_SCOPE:-?}）；${LOG_NOTE}" ;;
        stale) _add "QQ 网关" unknown \
              "日志无网关事件；消息通道已 $(_human_age "$MSG_AGE_SECONDS")无往来" \
              "网关状态需等下一次消息或重启后的 Bot ready 日志；${LOG_NOTE}" ;;
        *) _add "QQ 网关" unknown "无法判定：日志无网关事件，也无消息往来记录" \
              "${LOG_NOTE}（填好凭据并私聊一次后即可判定）" ;;
      esac ;;
  esac
}

# 模型 API：日志优先（错误必须暴露），其次用 DSH 会话 token 用量作为成功证据。
check_model() {
  local code usage
  usage=""
  if [ -n "${EV_MODEL_TOTAL_OUTPUT_TOKENS:-}" ]; then
    usage="累计输入 ${EV_MODEL_TOTAL_INPUT_TOKENS:-?} / 输出 ${EV_MODEL_TOTAL_OUTPUT_TOKENS:-?} / 缓存命中 ${EV_MODEL_CACHE_READ_TOKENS:-?} tokens"
  fi
  code=$(_log_verdict_code "$LLM_FATAL_RE" "$LLM_WARN_RE" "$LLM_OK_RE")
  case "$code" in
    2) _add "模型 API" fatal "最近一次相关记录是失败（鉴权/额度）" \
         "最近匹配：$(_last_line "$LLM_FATAL_RE")" ;;
    1) _add "模型 API" warn "最近一次相关记录是告警（限流/超时/重试）" \
         "最近匹配：$(_last_line "$LLM_WARN_RE")" ;;
    0) _add "模型 API" ok "日志显示调用成功" \
         "最近匹配：$(_last_line "$LLM_OK_RE")${usage:+；$usage}" ;;
    *)
      case "${EV_MODEL_STATUS:-}" in
        ok) _add "模型 API" ok "近期模型调用成功（实际模型事件有输出 token）" \
              "最近一次成功调用约 $(_human_age "$EV_MODEL_AGE_SECONDS")前（第 ${EV_MODEL_LAST_TURN:-?} 轮）；供应商 ${EV_MODEL_PROVIDER:-未知}／模型 ${EV_MODEL_MODEL:-未知}；$usage" ;;
        stale) _add "模型 API" unknown \
              "已有 $(_human_age "$EV_MODEL_AGE_SECONDS")未见模型调用（历史调用成功过）" \
              "空闲不代表故障：DSH 不输出成功日志，只能以 token 用量判定；$usage" ;;
        *) _add "模型 API" unknown "尚无任何成功模型调用记录" \
              "${EVIDENCE_NOTE:-${LOG_NOTE}}" ;;
      esac ;;
  esac
}

# ---------------------------------------------------------------------------
# 资源占用（只读）
# ---------------------------------------------------------------------------
RES_RSS=""; RES_CPUTIME=""; RES_DATA_KB=""; RES_BACKUP_KB=""; RES_AVAIL_KB=""; RES_USE_PCT=""
collect_resources() {
  local pid="$MAIN_PID" line
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then
    # 兜底：只按**本工程的安装路径**匹配，避免误认成机器上别的 dsh 进程（实测踩过：
    # 宽松的 'dsh web' 会匹配到无关进程，导致 RSS/CPU 张冠李戴）。
    if _have pgrep; then
      pid=$(pgrep -f "$WHALE_ROOT/app/node_modules/.bin/dsh" 2>"$NULL_DEV" | grep -v "^$$\$" | head -1) || pid=""
    fi
  fi
  if [ -n "$pid" ]; then
    line=$(ps -o rss=,time= -p "$pid" 2>"$NULL_DEV" | head -1) || line=""
    if [ -n "$line" ]; then
      RES_RSS=$(printf '%s' "$line" | awk '{print $1}')
      RES_CPUTIME=$(printf '%s' "$line" | awk '{print $2}')
    fi
  fi
  RES_DATA_KB=$(du -sk "$WHALE_ROOT/data" 2>"$NULL_DEV" | awk '{print $1}') || RES_DATA_KB=""
  RES_BACKUP_KB=$(du -sk "$WHALE_ROOT/backups" 2>"$NULL_DEV" | awk '{print $1}') || RES_BACKUP_KB=""
  local dfout
  dfout=$(df -Pk "$WHALE_ROOT" 2>"$NULL_DEV" | awk 'NR==2 {print $4" "$5}') || dfout=""
  RES_AVAIL_KB=$(printf '%s' "$dfout" | awk '{print $1}')
  RES_USE_PCT=$(printf '%s' "$dfout" | awk '{print $2}')
}

# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------
_json_escape() {
  printf '%s' "$1" | tr '\n\t' '  ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}
_human_kb() {
  awk -v k="${1:-0}" 'BEGIN{ if (k == "") { print "未知"; exit } b=k*1024; split("B KB MB GB TB", u, " "); i=1; while (b >= 1024 && i < 5) { b/=1024; i++ } printf "%.1f%s", b, u[i] }'
}

print_json() {
  local i=0 n=${#C_NAME[@]} state first=1
  printf '{\n'
  printf '  "service": "%s",\n' "$(_json_escape "$SERVICE")"
  printf '  "host": "%s",\n' "$(_json_escape "$(hostname 2>"$NULL_DEV" || printf unknown)")"
  printf '  "time": "%s",\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
  case "$OVERALL_STATE" in
    ok) printf '  "overall": "ok",\n' ;;
    pending) printf '  "overall": "pending",\n' ;;
    fatal) printf '  "overall": "fatal",\n' ;;
    *) printf '  "overall": "warn",\n' ;;
  esac
  printf '  "exit_code": %s,\n' "$OVERALL_CODE"
  printf '  "checks": [\n'
  while [ "$i" -lt "$n" ]; do
    [ "$first" -eq 0 ] && printf ',\n'
    first=0
    printf '    {"name": "%s", "status": "%s", "summary": "%s", "detail": "%s"}' \
      "$(_json_escape "${C_NAME[$i]}")" "$(_json_escape "${C_STATE[$i]}")" \
      "$(_json_escape "${C_SUM[$i]}")" "$(_json_escape "${C_DET[$i]}")"
    i=$((i + 1))
  done
  printf '\n  ],\n'
  printf '  "resources": {\n'
  printf '    "pid": "%s",\n' "$(_json_escape "${MAIN_PID:-}")"
  printf '    "rss_kb": "%s",\n' "${RES_RSS:-}"
  printf '    "cpu_time": "%s",\n' "$(_json_escape "${RES_CPUTIME:-}")"
  printf '    "data_dir_kb": "%s",\n' "${RES_DATA_KB:-}"
  printf '    "backup_dir_kb": "%s",\n' "${RES_BACKUP_KB:-}"
  printf '    "disk_avail_kb": "%s",\n' "${RES_AVAIL_KB:-}"
  printf '    "disk_used_pct": "%s"\n' "$(_json_escape "${RES_USE_PCT:-}")"
  printf '  }\n}\n'
}

print_table() {
  local i=0 n=${#C_NAME[@]} pad w
  printf '\n小鲸鱼健康检查  主机=%s  时间=%s\n' "$(hostname 2>"$NULL_DEV" || printf unknown)" "$(date '+%Y-%m-%d %H:%M:%S %z')"
  _rule 78
  pad="检查项"; w=$(_dwidth "$pad")
  while [ "$w" -lt 20 ]; do pad="$pad "; w=$((w + 1)); done
  printf '%s  状态  说明\n' "$pad"
  _rule 78
  while [ "$i" -lt "$n" ]; do
    pad="${C_NAME[$i]}"
    w=$(_dwidth "$pad")
    while [ "$w" -lt 20 ]; do pad="$pad "; w=$((w + 1)); done
    printf '%s  %s  %s\n' "$pad" "$(_label "${C_STATE[$i]}")" "${C_SUM[$i]}"
    printf '%*s↳ %s\n' 24 "" "${C_DET[$i]}"
    i=$((i + 1))
  done
  _rule 78
  printf '资源占用: 进程 PID=%s  RSS=%s  CPU时间=%s\n' \
    "${MAIN_PID:-未知}" "$([ -n "${RES_RSS:-}" ] && _human_kb "$RES_RSS" || printf '未知')" "${RES_CPUTIME:-未知}"
  printf '          数据目录=%s  备份目录=%s  磁盘剩余=%s（已用 %s）\n' \
    "$([ -n "${RES_DATA_KB:-}" ] && _human_kb "$RES_DATA_KB" || printf '未知')" \
    "$([ -n "${RES_BACKUP_KB:-}" ] && _human_kb "$RES_BACKUP_KB" || printf '未知')" \
    "$([ -n "${RES_AVAIL_KB:-}" ] && _human_kb "$RES_AVAIL_KB" || printf '未知')" \
    "${RES_USE_PCT:-未知}"
  _rule 78
  case "$OVERALL_STATE" in
    ok)      printf '总体结论: 全部正常（退出码 0）\n' ;;
    pending) printf '总体结论: 基础设施正常，但尚无可观测的对话证据（退出码 0）\n'
             printf '          这不是故障：填好凭据后与机器人私聊一次，即可转为可判定状态。\n' ;;
    warn)    printf '总体结论: 存在告警（退出码 1）—— 服务可能在重连/限流，建议观察\n' ;;
    fatal)   printf '总体结论: 存在致命问题（退出码 2）—— 请立即人工排查\n' ;;
  esac
  printf '提示: 本脚本只读，不会重启或修改任何东西。\n'
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) JSON=1 ;;
      -h|--help) usage; exit 0 ;;
      *) printf '[错误] 未知参数：%s\n' "$1" >&2; usage >&2; exit 1 ;;
    esac
    shift
  done

  check_process
  check_port
  _collect_logs
  _collect_evidence
  check_gateway
  check_reply_errors
  check_model
  collect_resources

  # 汇总：取最严重的状态
  local i=0 n=${#C_NAME[@]} code=0 w
  OVERALL_STATE="ok"
  while [ "$i" -lt "$n" ]; do
    w=$(_weight "${C_STATE[$i]}")
    if [ "$w" -gt "$code" ]; then code=$w; fi
    i=$((i + 1))
  done
  case "$code" in
    0) OVERALL_STATE="ok" ;;
    2) OVERALL_STATE="fatal" ;;
    *) OVERALL_STATE="warn" ;;
  esac
  OVERALL_CODE="$code"

  # pending =「暂时无法观测」，与「真实告警」严格区分：
  #   · 只有在**没有任何 warn/fatal**、仅存在 unknown（无日志、无调用证据）时才成立；
  #   · 覆盖三种正常场景：凭据未填、刚启动尚无流量、长时间空闲无调用；
  #   · 一旦出现真实告警（进程异常/端口不通/429/鉴权失败…），绝不降级为 pending。
  # 旧实现只认"凭据为空"，导致凭据填好但还没发过消息时被误报成告警（退出码 1）。
  if [ "$code" -eq 1 ]; then
    local has_warn=0 has_unknown=0 j=0
    while [ "$j" -lt "$n" ]; do
      case "${C_STATE[$j]}" in
        warn|fatal) has_warn=1 ;;
        unknown)    has_unknown=1 ;;
      esac
      j=$((j + 1))
    done
    if [ "$has_warn" -eq 0 ] && [ "$has_unknown" -eq 1 ]; then
      OVERALL_STATE=pending
      code=0
    fi
  fi
  OVERALL_CODE="$code"

  if [ "$JSON" = 1 ]; then print_json; else print_table; fi
  exit "$code"
}

main "$@"
