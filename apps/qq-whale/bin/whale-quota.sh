#!/usr/bin/env bash
# =============================================================================
# whale-quota.sh —— 小鲸鱼磁盘配额守护（对应"机器人不应无限保存图片"）
# =============================================================================
# 默认行为：**只检查、只告警，绝不删除任何东西**。
#
#   bash whale-quota.sh                     # 检查并输出单行摘要（timer 友好）
#   bash whale-quota.sh --prune-candidates  # 额外列出"可清理的候选文件"供人工确认（仍不删）
#   bash whale-quota.sh --reclaim           # 显式确认后才删除（白名单目录 + 超龄双重限制）
#   bash whale-quota.sh --help
#
# 删除策略（只有 --reclaim 才会走到这里，且限制极严）：
#   1) 只允许删除「表情包待整理区」目录下的文件，该目录在启动时解析成**规范化绝对路径**；
#      每个候选文件删除前都要重新校验"规范化后的绝对路径确实位于该目录之下"，
#      否则拒绝删除（防路径穿越 / 防变量被改坏后误删，这是防误删的关键保护）。
#   2) 只删除 mtime 早于 WHALE_STICKER_MAX_AGE_DAYS（默认 30）天的**普通文件**；
#      符号链接一律跳过（不跟随、不删除）。
#   3) 每删一个都打印完整路径。
#   4) 不删除目录本身、不删除索引文件（index.json 在待整理区之外）。
#
# 退出码：0 = 在限额内；1 = 超出限额（或 --reclaim 时该清但清不掉）；2 = 用法/环境错误；
#         3 = --reclaim 过程中有文件删除失败。
#
# 可覆盖的环境变量：
#   WHALE_HOME=/home/qqwhale        WHALE_ROOT=$WHALE_HOME/whale
#   WHALE_DATA_DIR=$WHALE_ROOT/data           被统计的数据根
#   WHALE_DATA_MAX_MB=0                     数据根体积告警阈值（MB）；0 不设阈值
#   WHALE_STICKER_MAX_AGE_DAYS=30             待整理区可清理的年龄阈值（天）
#   WHALE_STICKER_PENDING_DIR=<绝对路径>      显式指定"待整理区"目录（覆盖自动探测）
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
DATA_DIR="${WHALE_DATA_DIR:-${WHALE_ROOT}/data}"
MAX_MB="${WHALE_DATA_MAX_MB:-0}"
MAX_AGE_DAYS="${WHALE_STICKER_MAX_AGE_DAYS:-30}"
PENDING_OVERRIDE="${WHALE_STICKER_PENDING_DIR:-}"

MODE="check"          # check | prune-candidates | reclaim
PENDING_DIR=""        # 解析后的待整理区（绝对路径）
PENDING_CANON=""      # 规范化后的待整理区（用于删除前的路径校验）
STAT_FLAVOR="bsd"
DONE=0

# ---------------------------------------------------------------------------
# 输出 helper（中文）
# ---------------------------------------------------------------------------
info() { printf '[信息] %s\n' "$*"; }
warn() { printf '[警告] %s\n' "$*" >&2; }
die()  { printf '[错误] %s\n' "$1" >&2; exit "${2:-1}"; }

usage() {
  cat <<'EOF'
whale-quota.sh —— 小鲸鱼磁盘配额守护

用法:
  bash whale-quota.sh                     检查数据目录体积，超出则告警（不删除）
  bash whale-quota.sh --prune-candidates  列出可清理的候选文件（只列不删）
  bash whale-quota.sh --reclaim           显式删除超龄的待整理图片（打印每个路径）
  bash whale-quota.sh --help

环境变量:
  WHALE_DATA_DIR=$WHALE_ROOT/data               被统计的数据根
  WHALE_DATA_MAX_MB=0                         体积上限（MB）
  WHALE_STICKER_MAX_AGE_DAYS=30                 可清理年龄阈值（天）
  WHALE_STICKER_PENDING_DIR=<绝对路径>          显式指定"待整理区"目录

退出码: 0 在限额内；1 超出限额；2 用法/环境错误；3 删除过程中有失败。
安全: 默认只告警不删除；--reclaim 也只删"待整理区"下、超过阈值的普通文件，
      删除前逐个校验规范化绝对路径必须位于该目录之下（防路径穿越/防误删）。
EOF
}

# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
_detect_stat() {
  if stat -c '%s' / >"$NULL_DEV" 2>&1; then STAT_FLAVOR=gnu; else STAT_FLAVOR=bsd; fi
}
_st_mtime() {
  if [ "$STAT_FLAVOR" = gnu ]; then stat -c '%Y' "$1"; else stat -f '%m' "$1"; fi
}
_st_size() {
  if [ "$STAT_FLAVOR" = gnu ]; then stat -c '%s' "$1"; else stat -f '%z' "$1"; fi
}
_now() { date '+%s'; }
_human_kb() {
  awk -v k="${1:-0}" 'BEGIN{ b=k*1024; split("B KB MB GB TB", u, " "); i=1; while (b >= 1024 && i < 5) { b/=1024; i++ } printf "%.1f%s", b, u[i] }'
}
_fmt_date() {   # epoch → YYYY-MM-DD
  if date -r "$1" '+%Y-%m-%d' >"$NULL_DEV" 2>&1; then date -r "$1" '+%Y-%m-%d'
  else date -d "@$1" '+%Y-%m-%d'; fi
}

# ---------------------------------------------------------------------------
# 参数解析
# ---------------------------------------------------------------------------
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --prune-candidates) MODE="prune-candidates" ;;
      --reclaim)          MODE="reclaim" ;;
      -h|--help)          usage; exit 0 ;;
      *) printf '[错误] 未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
    shift
  done
}

# ---------------------------------------------------------------------------
# 解析"待整理区"目录
#   优先级：显式环境变量 > $DATA_DIR/表情包/待整理（需求契约路径）
#           > $DATA_DIR/表情包/lib/candidate（插件真实布局，见 sticker-store.ts 的 LAYER_DIRS）
#   只认一个目录，绝不接受多个候选 —— 删除白名单越窄越安全。
# ---------------------------------------------------------------------------
resolve_pending_dir() {
  if [ -n "$PENDING_OVERRIDE" ]; then
    if [ ! -d "$PENDING_OVERRIDE" ]; then
      die "WHALE_STICKER_PENDING_DIR 不是已存在的目录：$PENDING_OVERRIDE" 2
    fi
    PENDING_DIR="$PENDING_OVERRIDE"
    info "待整理区（来自 WHALE_STICKER_PENDING_DIR）：$PENDING_DIR"
  elif [ -d "${DATA_DIR}/表情包/待整理" ]; then
    PENDING_DIR="${DATA_DIR}/表情包/待整理"
    info "待整理区（契约路径）：$PENDING_DIR"
  elif [ -d "${DATA_DIR}/表情包/lib/candidate" ]; then
    # 插件把候选区（界面上的"待整理"）落在 表情包/lib/candidate，见 LAYER_DIRS:
    #   candidate: 'lib/candidate' / library: 'lib/library' / negative / trash
    PENDING_DIR="${DATA_DIR}/表情包/lib/candidate"
    info "待整理区（插件真实布局 lib/candidate）：$PENDING_DIR"
  else
    PENDING_DIR=""
    warn "未找到待整理区目录（既没有 表情包/待整理，也没有 表情包/lib/candidate）"
    warn "  → 只能统计体积并告警，无法提供可清理候选；可用 WHALE_STICKER_PENDING_DIR 显式指定"
    return 0
  fi
  PENDING_CANON=$(cd "$PENDING_DIR" && pwd -P) || die "无法规范化待整理区路径：$PENDING_DIR" 2
}

# ---------------------------------------------------------------------------
# 收集候选文件：待整理区下、mtime 超过阈值天数的普通文件（跳过符号链接）
# 输出每行 "mtime<TAB>size<TAB>绝对路径"，按 mtime 升序（最旧在前）
# ---------------------------------------------------------------------------
collect_candidates() {
  local f mt sz cutoff
  cutoff=$(( $(_now) - MAX_AGE_DAYS * 86400 ))
  [ -n "$PENDING_DIR" ] || return 0
  while IFS= read -r -d '' f; do
    # 防误删关键保护（1/3）：符号链接一律不看、不删
    if [ -L "$f" ]; then continue; fi
    if [ ! -f "$f" ]; then continue; fi
    mt=$(_st_mtime "$f" 2>"$NULL_DEV" || printf 0)
    if [ "${mt:-0}" -ge "$cutoff" ]; then continue; fi   # 未超龄
    sz=$(_st_size "$f" 2>"$NULL_DEV" || printf 0)
    printf '%s\t%s\t%s\n' "$mt" "$sz" "$f"
  done < <(find "$PENDING_DIR" -type f -print0 2>"$NULL_DEV") | LC_ALL=C sort -n -k1,1
}

# ---------------------------------------------------------------------------
# 防误删关键保护（2/3）：把待删路径规范化后，必须确实位于待整理区之下
# ---------------------------------------------------------------------------
_safe_path_in_pending() {
  local target="$1" dir base canon
  dir=$(cd "$(dirname "$target")" 2>"$NULL_DEV" && pwd -P) || return 1
  base=$(basename "$target")
  canon="$dir/$base"
  case "$canon" in
    "${PENDING_CANON}/"*) printf '%s' "$canon"; return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
main() {
  parse_args "$@"
  _detect_stat

  case "$DATA_DIR" in
    ""|"/") die "WHALE_DATA_DIR 取值非法（空或 /）：'$DATA_DIR'" 2 ;;
  esac
  case "$MAX_MB" in
    ''|*[!0-9]*) die "WHALE_DATA_MAX_MB 必须是整数（当前：'$MAX_MB'）" 2 ;;
  esac
  case "$MAX_AGE_DAYS" in
    ''|*[!0-9]*) die "WHALE_STICKER_MAX_AGE_DAYS 必须是整数（当前：'$MAX_AGE_DAYS'）" 2 ;;
  esac

  if [ ! -d "$DATA_DIR" ]; then
    warn "数据目录不存在：${DATA_DIR}（服务可能还没跑起来）"
    printf '[qqwhale-quota] data=0MB limit=%sMB used=0%% files=0 candidates=0 oldest=- status=missing\n' "$MAX_MB"
    DONE=1
    exit 0
  fi

  resolve_pending_dir

  # --- 体积统计 ---
  local used_kb files max_kb used_pct status
  used_kb=$(du -sk "$DATA_DIR" 2>"$NULL_DEV" | awk '{print $1}') || used_kb=0
  used_kb=${used_kb:-0}
  files=$(find "$DATA_DIR" -type f 2>"$NULL_DEV" | wc -l | tr -d ' ') || files=0

  # --- 候选（最旧的待整理文件） ---
  local cands oldest_epoch="-" cand_count=0 cand_kb=0 mt sz p
  cands=$(collect_candidates) || cands=""
  if [ -n "$cands" ]; then
    cand_count=$(printf '%s\n' "$cands" | wc -l | tr -d ' ')
    cand_kb=$(printf '%s\n' "$cands" | awk -F'\t' '{s+=$2} END {printf "%d", s/1024}')
    oldest_epoch=$(printf '%s\n' "$cands" | head -1 | cut -f1)
  fi

  max_kb=$((MAX_MB * 1024))
  used_pct=0
  if [ "$max_kb" -gt 0 ]; then used_pct=$((used_kb * 100 / max_kb)); fi
  if [ "$max_kb" -eq 0 ]; then status="unlimited"; elif [ "$used_kb" -gt "$max_kb" ]; then status="over"; else status="ok"; fi

  # --- 明细（人类可读）---
  info "数据目录：$DATA_DIR"
  info "体积：$(_human_kb "$used_kb") / 上限 $(_human_kb "$max_kb")（$used_pct%），文件数 $files"
  if [ -n "$PENDING_DIR" ]; then
    info "待整理区：$PENDING_DIR"
    info "超 ${MAX_AGE_DAYS} 天可清理候选：${cand_count} 个文件，约 $(_human_kb "$cand_kb")"
  fi
  if [ "$status" = "over" ]; then
    warn "数据目录已超出配额：$(_human_kb "$used_kb") > $(_human_kb "$max_kb")"
    warn "  默认不自动删除（机器人数据是用户资产，删除必须由人确认）。"
    warn "  建议：先 bash whale-quota.sh --prune-candidates 看清单，"
    warn "        确认无误会再执行 bash whale-quota.sh --reclaim（只删待整理区超龄文件）。"
  fi

  if [ "$MODE" = "prune-candidates" ]; then
    printf '\n===== 可清理候选（按最旧优先排序；本次只列出，不删除）=====\n'
    if [ "$cand_count" -eq 0 ]; then
      printf '  （没有超龄候选）\n'
    else
      local shown=0
      while IFS=$'\t' read -r mt sz p; do
        [ -n "${p:-}" ] || continue
        shown=$((shown + 1))
        if [ "$shown" -le 200 ]; then
          printf '  %s  %8s  %s\n' "$(_fmt_date "$mt")" "$(_human_kb "$((sz / 1024))")" "$p"
        elif [ "$shown" -eq 201 ]; then
          printf '  …（其余候选已省略，共 %s 个）\n' "$cand_count"
        fi
      done <<< "$cands"
      printf '  合计：%s 个文件，约 %s\n' "$cand_count" "$(_human_kb "$cand_kb")"
    fi
    printf '提示：确认后执行 bash whale-quota.sh --reclaim 才会真正删除。\n'
  fi

  if [ "$MODE" = "reclaim" ]; then
    printf '\n===== --reclaim：删除待整理区中超过 %s 天的文件 =====\n' "$MAX_AGE_DAYS"
    if [ "$cand_count" -eq 0 ]; then
      printf '  （没有超龄候选，未删除任何文件）\n'
    else
      local deleted=0 failed=0 freed_kb=0 canon
      while IFS=$'\t' read -r mt sz p; do
        [ -n "${p:-}" ] || continue
        # 防误删关键保护（3/3）：逐个文件再校验一次规范化绝对路径
        if ! canon=$(_safe_path_in_pending "$p"); then
          warn "拒绝删除（规范化后不在待整理区之下）：$p"
          failed=$((failed + 1))
          continue
        fi
        if [ -L "$canon" ] || [ ! -f "$canon" ]; then
          warn "拒绝删除（不是普通文件）：$canon"
          failed=$((failed + 1))
          continue
        fi
        if rm -f "$canon"; then
          printf '  已删除：%s（%s，%s）\n' "$canon" "$(_human_kb "$((sz / 1024))")" "$(_fmt_date "$mt")"
          deleted=$((deleted + 1))
          freed_kb=$((freed_kb + sz / 1024))
        else
          warn "删除失败：$canon"
          failed=$((failed + 1))
        fi
      done <<< "$cands"
      printf '  小计：删除 %s 个，释放约 %s，失败 %s 个\n' "$deleted" "$(_human_kb "$freed_kb")" "$failed"
      printf '  提醒：表情包索引 index.json 可能残留已删条目，插件下次 cleanupBroken 时会自动剔除；\n'
      printf '        如需立即整理，可重启服务（systemctl --user restart qqwhale.service）或执行 whale-ctl 的相关子命令。\n'
      # 重新统计体积与文件数（--reclaim 后的摘要必须反映删除后的真实状态）
      used_kb=$(du -sk "$DATA_DIR" 2>"$NULL_DEV" | awk '{print $1}') || used_kb=0
      used_kb=${used_kb:-0}
      files=$(find "$DATA_DIR" -type f 2>"$NULL_DEV" | wc -l | tr -d ' ') || files=0
      used_pct=0
      if [ "$max_kb" -gt 0 ]; then used_pct=$((used_kb * 100 / max_kb)); fi
      if [ "$max_kb" -eq 0 ]; then status="unlimited"; elif [ "$used_kb" -gt "$max_kb" ]; then status="over"; else status="ok"; fi
      if [ "$failed" -gt 0 ]; then
        printf '[qqwhale-quota] data=%s limit=%sMB used=%s%% files=%s candidates=%s oldest=%s status=%s failed=%s\n' \
          "$(_human_kb "$used_kb")" "$MAX_MB" "$((used_kb * 100 / (max_kb > 0 ? max_kb : 1)))" "$files" "$cand_count" \
          "$([ "$oldest_epoch" != "-" ] && _fmt_date "$oldest_epoch" || printf '-')" "$status" "$failed"
        DONE=1
        exit 3
      fi
    fi
  fi

  # --- systemd timer 友好的单行摘要（始终输出，且始终是最后一行）---
  printf '[qqwhale-quota] data=%s limit=%sMB used=%s%% files=%s candidates=%s oldest=%s status=%s\n' \
    "$(_human_kb "$used_kb")" "$MAX_MB" "$used_pct" "$files" "$cand_count" \
    "$([ "$oldest_epoch" != "-" ] && _fmt_date "$oldest_epoch" || printf '-')" "$status"

  DONE=1
  if [ "$status" = "over" ]; then exit 1; fi
  exit 0
}

# 退出码保真：bash 在个别致命错误下会把 rc=0 传给 EXIT trap，会把失败伪装成成功。
# shellcheck disable=SC2329  # 本函数由文件末尾的 trap on_exit EXIT 调用，静态分析看不到
on_exit() {
  local rc=$?
  if [ "$DONE" != 1 ] && [ "$rc" -eq 0 ]; then rc=1; fi
  exit "$rc"
}
trap on_exit EXIT

main "$@"
