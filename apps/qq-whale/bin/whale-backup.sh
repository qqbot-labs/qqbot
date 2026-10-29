#!/usr/bin/env bash
# =============================================================================
# whale-backup.sh —— QQ AI 机器人「小鲸鱼」一致性备份脚本
# =============================================================================
# 设计目标（P0：零干扰 + 可审计 + 可验证）
#
# 1) 只备份小鲸鱼自己的数据：$DSH_HOME 与 $WHALE_ROOT 下的 7 个目标。
#    绝不读取、绝不触碰同一台 VPS 上其他服务的文件。
#
# 2) 一致性策略（为什么不能简单 cp）：
#    · DSH 的会话存储是 JSONL **追加写**，插件元数据（index.json、schedule-state.json
#      等）是 JSON **覆盖写**。cp 不是原子快照：可能读到"写了一半"的内容，
#      也可能两个文件之间存在时间差（比如 index.json 已更新、图片还没落盘）。
#    本脚本按以下顺序降低风险，并把残余风险显式记录进清单：
#      a) 先请应用层静默刷盘：存在 $WHALE_ROOT/bin/whale-ctl 就执行 `whale-ctl flush`，
#         失败/超时不致命（继续备份，但会告警）。
#      b) 逐文件复制后做两遍 stat 比对（大小 + mtime）：读之前一次、复制之后再读一次，
#         两者一致且副本大小等于源大小，才认为这份副本是稳定的；不一致就重试
#         （默认 3 次，间隔 0.3s）。对小型元数据文件（.json/.jsonl/.yaml/.yml/.env/
#         .txt/.md/.log，且 < 8MiB）额外比对复制前后的 sha256 —— 覆盖写最容易在这类
#         文件上产生半写内容，而它们通常只有几 KB，多读两遍代价可忽略；贴图等大文件
#         只比 size+mtime，避免对几百 MB 的目录做两次全量哈希。
#         重试后仍不稳定 → 按最后一次读到的副本归档，并写入清单的"不稳定文件"段。
#      c) SQLite 文件（.db/.sqlite/.sqlite3，或魔数为 "SQLite format 3" 的文件）
#         **必须**用 `sqlite3 .backup` 做在线一致性快照；sqlite3 不可用或备份失败时
#         **跳过并告警**，绝不直接 cp 正在写入的数据库。
#    （说明：真正原子的快照需要 LVM/ZFS/btrfs 存储级快照，或在应用内加锁导出。
#      本脚本无权也不应改动宿主机的存储配置，因此采用"应用刷盘 + 复制后校验 + 重试
#      + 显式记录不稳定项"这套可审计的折中方案。）
#
# 3) 版本化输出：
#    归档   $WHALE_ROOT/backups/whale-YYYYmmdd-HHMMSS.tar.gz（--encrypt 时为 .tar.gz.age/.gpg）
#    清单   <归档名>.manifest.txt：时间/主机/DSH 版本/插件版本/各路径文件数/字节数/sha256
#    归档内还带 _meta/files.sha256（逐文件 sha256）与 _meta/manifest.txt，供恢复时核对。
#
# 4) 敏感数据：默认**不加密但严格限权**（目录 700、文件 600）。
#    --encrypt ：用 age 或 gpg 加密输出；两者都没有时**明确报错退出**，不静默降级为明文。
#    --no-secrets：排除 .credentials.yaml 与 etc/，并抹掉 profiles/、settings.yaml 里的
#                  凭据字段（可能过度脱敏），用于把备份放到较低信任的位置。
#
# 5) 磁盘上限：保留最近 WHALE_BACKUP_KEEP 份（默认 0，不限保留份数），超出删除最旧的。
#    删除前会打印待删列表，并且**只删本脚本自己生成的、位于 $WHALE_ROOT/backups 下、
#    名字匹配 whale-*.tar.gz* 的文件**（绝对路径前缀校验，见 _safe_rm）。
#
# 6) 空间预检：备份前检查目标分区剩余空间 ≥ 预估大小的 2 倍，不足直接拒绝执行。
#
# 用法：
#   bash whale-backup.sh                 # 常规备份（含敏感数据，600/700）
#   bash whale-backup.sh --encrypt       # 加密为 .tar.gz.age 或 .tar.gz.gpg
#   bash whale-backup.sh --no-secrets    # 脱敏备份
#   bash whale-backup.sh --help
#
# 退出码：0 成功；1 参数/用法错误；2 前置条件不满足（路径、依赖、磁盘空间、加密工具）；
#         3 打包或加密失败。
#
# 可覆盖的环境变量（全部集中在下面"变量契约"段）：
#   WHALE_USER WHALE_HOME WHALE_ROOT WHALE_WEB_PORT DSH_HOME WHALE_BACKUP_DIR
#   WHALE_BACKUP_KEEP WHALE_BACKUP_STABLE_RETRY WHALE_BACKUP_STABLE_WAIT
#   WHALE_CTL WHALE_ENCRYPT_TOOL WHALE_AGE_RECIPIENT WHALE_GPG_PASSPHRASE_FILE
#
# 兼容性：刻意使用 bash 3.2 也支持的语法（数组用 ${arr[@]+"${arr[@]}"} 展开、
#   不用关联数组/mapfile），因此本脚本在 macOS 上也能直接跑 --self-test 之外的演练；
#   生产目标是 Linux（GNU tar/stat + bash 5）。
# =============================================================================
set -euo pipefail
WHALE_BACKUP_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
# 变量契约（集中定义，全部可用环境变量覆盖）
# ---------------------------------------------------------------------------
WHALE_USER="${WHALE_USER:-qqwhale}"
WHALE_HOME="${WHALE_HOME:-/home/${WHALE_USER}}"
WHALE_ROOT="${WHALE_ROOT:-${WHALE_HOME}/whale}"
# 调用方可能从 /root 之类"非属主可读"的目录发起（例如 root 用 runuser 切到 qqwhale），
# 那样 find/du 会因为 cwd 不可读而失败，最终表现为"归档没生成"这种假故障。
# 统一把工作目录切到项目根，彻底消除这个环境依赖（实测踩过两次）。
WHALE_SAFE_CWD="${WHALE_ROOT}"
if ! cd "$WHALE_SAFE_CWD" 2>&-; then
  cd / || true
fi

WHALE_WEB_PORT="${WHALE_WEB_PORT:-3080}"
DSH_HOME="${DSH_HOME:-${WHALE_HOME}/.dsh}"

BACKUP_DIR="${WHALE_BACKUP_DIR:-${WHALE_ROOT}/backups}"   # 备份输出目录（700）
KEEP="${WHALE_BACKUP_KEEP:-0}"                            # 保留份数
STABLE_RETRY="${WHALE_BACKUP_STABLE_RETRY:-3}"            # 稳定性检查重试次数
STABLE_WAIT="${WHALE_BACKUP_STABLE_WAIT:-0.3}"            # 重试间隔（秒）
HASH_LIMIT="${WHALE_BACKUP_HASH_LIMIT:-8388608}"          # 8MiB：超过不做内容哈希
CTL_BIN="${WHALE_CTL:-}"                                  # whale-ctl 路径（留空=自动探测）
ENC_TOOL_REQ="${WHALE_ENCRYPT_TOOL:-auto}"                # auto|age|gpg
AGE_RECIPIENT="${WHALE_AGE_RECIPIENT:-}"                  # age 公钥（非交互加密必填）
GPG_PASSPHRASE_FILE="${WHALE_GPG_PASSPHRASE_FILE:-}"      # gpg 口令文件（非交互加密必填）

# ---------------------------------------------------------------------------
# 内部状态
# ---------------------------------------------------------------------------
ENCRYPT=0                 # --encrypt
NO_SECRETS=0              # --no-secrets
REDACT=0                  # 是否对文件内容做字段脱敏
ENC_TOOL=""               # 实际选用的加密工具 age|gpg
ENC_EXT=""                # 加密文件后缀 age|gpg
SQLITE_OK=0
STAT_FLAVOR="bsd"
SHA_FLAVOR="none"
BACKUP_DIR_CANON=""
STAGE=""
ARCHIVE_TMP=""
FINAL=""
MANIFEST=""
STAMP=""
SELECTED=()
MISSING=()
SKIPPED_SQLITE=()
SKIPPED_LINKS=()
UNSTABLE=()
SQLITE_COUNT=0
REDACTED_COUNT=0
DONE=0                    # 正常跑完的标志（供 EXIT trap 判断退出码保真）

# ---------------------------------------------------------------------------
# 输出 helper（中文）
# ---------------------------------------------------------------------------
info() { printf '[信息] %s\n' "$*"; }
warn() { printf '[警告] %s\n' "$*" >&2; }
die()  { printf '[错误] %s\n' "$1" >&2; exit "${2:-1}"; }

usage() {
  cat <<'EOF'
whale-backup.sh —— QQ AI 机器人「小鲸鱼」一致性备份脚本

用法:
  bash whale-backup.sh [选项]

选项:
  --encrypt      用 age 或 gpg 加密输出（.tar.gz.age / .tar.gz.gpg）。
                 两者都不存在时直接报错退出，不会静默降级为明文。
  --no-secrets   脱敏备份：排除 .credentials.yaml 与 etc/，并抹掉
                 profiles/、settings.yaml 中的凭据字段（可能过度脱敏）。
  -h, --help     显示本帮助。

环境变量（可选）:
  WHALE_HOME=/home/qqwhale      WHALE_ROOT=$WHALE_HOME/whale
  DSH_HOME=$WHALE_HOME/.dsh     WHALE_BACKUP_DIR=$WHALE_ROOT/backups
  WHALE_BACKUP_KEEP=0           保留份数，0 不自动删除；正数时超出删除最旧的（仅限本脚本生成的归档）
  WHALE_ENCRYPT_TOOL=auto       auto|age|gpg
  WHALE_AGE_RECIPIENT=age1...   age 公钥（非交互环境下加密必填）
  WHALE_GPG_PASSPHRASE_FILE=... gpg 口令文件（非交互环境下加密必填）

输出:
  $WHALE_ROOT/backups/whale-YYYYmmdd-HHMMSS.tar.gz
  $WHALE_ROOT/backups/whale-YYYYmmdd-HHMMSS.tar.gz.manifest.txt

退出码: 0 成功；1 参数错误；2 前置条件不满足；3 打包/加密失败。
EOF
}

# ---------------------------------------------------------------------------
# 平台兼容 helper
# ---------------------------------------------------------------------------
_have() { command -v "$1" >"$NULL_DEV" 2>&1; }

# 探测 stat 语法（GNU coreutils vs BSD/macOS）——仅为让脚本可在 macOS 上演练
_detect_platform() {
  if stat -c '%s' / >"$NULL_DEV" 2>&1; then STAT_FLAVOR=gnu; else STAT_FLAVOR=bsd; fi   # GNU stat 支持 -c
  if _have sha256sum; then SHA_FLAVOR=sha256sum
  elif _have shasum; then SHA_FLAVOR=shasum
  elif _have openssl; then SHA_FLAVOR=openssl
  else SHA_FLAVOR=none
  fi
  if _have sqlite3; then SQLITE_OK=1; else SQLITE_OK=0; fi
}

_st_size() {
  if [ "$STAT_FLAVOR" = gnu ]; then stat -c '%s' "$1"; else stat -f '%z' "$1"; fi
}
_st_mtime() {
  if [ "$STAT_FLAVOR" = gnu ]; then stat -c '%Y' "$1"; else stat -f '%m' "$1"; fi
}
# "大小 mtime" 一行，供两遍比对使用
_st_size_mtime() { printf '%s %s\n' "$(_st_size "$1")" "$(_st_mtime "$1")"; }

_sha256_file() {
  case "$SHA_FLAVOR" in
    sha256sum) sha256sum "$1" | awk '{print $1}' ;;
    shasum)    shasum -a 256 "$1" | awk '{print $1}' ;;
    openssl)   openssl dgst -sha256 "$1" | awk '{print $NF}' ;;
    *) return 1 ;;
  esac
}
_sha256_stdin() {
  case "$SHA_FLAVOR" in
    sha256sum) sha256sum | awk '{print $1}' ;;
    shasum)    shasum -a 256 | awk '{print $1}' ;;
    openssl)   openssl dgst -sha256 | awk '{print $NF}' ;;
    *) return 1 ;;
  esac
}

# 字节 → 人类可读
_human() {
  awk -v b="${1:-0}" 'BEGIN{ split("B KB MB GB TB", u, " "); i = 1; while (b >= 1024 && i < 5) { b /= 1024; i++ } printf "%.1f%s", b, u[i] }'
}

# ---------------------------------------------------------------------------
# 防误删关键保护（整个脚本所有删除操作都必须走这里）
#   1) 把目标解析成**规范化绝对路径**（父目录 pwd -P，破除 .. 与符号链接的影响）
#   2) 要求该绝对路径确实位于 $BACKUP_DIR 之下
#   3) 文件名只能匹配本脚本自己生成的三类名字
#   任一条不满足即拒绝删除并告警。
# ---------------------------------------------------------------------------
_safe_rm() {
  local target="$1" dir base canon
  [ -n "$target" ] || return 0
  dir=$(cd "$(dirname "$target")" 2>"$NULL_DEV" && pwd -P) || { warn "拒绝删除（父目录不可解析）: $target"; return 1; }
  base=$(basename "$target")
  canon="$dir/$base"
  case "$canon" in
    "$BACKUP_DIR_CANON"/whale-*.tar.gz \
    | "$BACKUP_DIR_CANON"/whale-*.tar.gz.age \
    | "$BACKUP_DIR_CANON"/whale-*.tar.gz.gpg \
    | "$BACKUP_DIR_CANON"/whale-*.manifest.txt \
    | "$BACKUP_DIR_CANON"/.whale-tmp.*) ;;
    *) warn "拒绝删除（不在允许的路径/文件名白名单内）: $canon"; return 1 ;;
  esac
  rm -f "$canon"
}

# 暂存目录清理（同样是路径白名单校验，绝不 rm -rf 未知路径）
_cleanup_stage() {
  [ -n "$STAGE" ] || return 0
  case "$STAGE" in
    "$BACKUP_DIR"/.whale-stage.*) rm -rf "$STAGE" ;;
    *) warn "拒绝清理暂存目录（路径不在备份目录下）: $STAGE" ;;
  esac
}

on_exit() {
  local rc=$?
  set +e
  _cleanup_stage
  if [ -n "$ARCHIVE_TMP" ]; then _safe_rm "$ARCHIVE_TMP"; fi
  # 退出码保真：bash 在个别致命错误下（例如 set -u 命中未定义变量）会把 rc=0 传给
  # EXIT trap，那会把"失败"伪装成"成功"。因此用 DONE 标记是否正常跑完：
  # 没跑完就强制非 0 退出；正常跑完时 rc 本来就是 0，不会误判。
  if [ "$DONE" != 1 ] && [ "$rc" -eq 0 ]; then rc=1; fi
  exit "$rc"
}
trap on_exit EXIT

# ---------------------------------------------------------------------------
# 参数解析
# ---------------------------------------------------------------------------
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --encrypt)    ENCRYPT=1 ;;
      --no-secrets) NO_SECRETS=1 ;;
      -h|--help)    usage; exit 0 ;;
      *) printf '[错误] 未知参数: %s\n' "$1" >&2; usage >&2; exit 1 ;;
    esac
    shift
  done
}

# ---------------------------------------------------------------------------
# 选中路径清单（--no-secrets 会剔除凭据类目标）
# ---------------------------------------------------------------------------
# 归档前把记忆库的 WAL 落盘（SQLite 热备若只 tar 主库+WAL，恢复后可能丢最后几条）。
# 失败不影响备份主流程：最坏情况是"少几条最近消息"，而不是整体备份失败。
checkpoint_memory_db() {
  local db="${WHALE_ROOT}/data/qqwhale/memory.db"
  [ -f "$db" ] || return 0
  if ! command -v node >"${NULL_DEV:-/dev/null}" 2>&1; then return 0; fi
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    try {
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    } catch { /* 库被占用或损坏都不阻断备份 */ }
  ' "$db" 2>"${NULL_DEV:-/dev/null}" || true
}

build_selection() {
  SELECTED=()
  SELECTED+=("${DSH_HOME}/profiles")          # profile 配置（含插件凭据字段）
  SELECTED+=("${DSH_HOME}/.credentials.yaml") # DSH 凭据（敏感）
  SELECTED+=("${DSH_HOME}/storages")
  SELECTED+=("${DSH_HOME}/qqbot-settings")
  SELECTED+=("${DSH_HOME}/.dsh-qqbot")
  SELECTED+=("${DSH_HOME}/sessions")          # 会话历史
  SELECTED+=("${DSH_HOME}/settings.yaml")     # 全局设置（若存在）
  SELECTED+=("${WHALE_ROOT}/data")            # 表情包 / 好感度台账 / 定时任务
  SELECTED+=("${WHALE_ROOT}/workspace")       # 人格与指令文件
  SELECTED+=("${WHALE_ROOT}/etc")             # 凭据 env 文件（敏感）

  if [ "$NO_SECRETS" = 1 ]; then
    local keep_list=() s
    for s in ${SELECTED[@]+"${SELECTED[@]}"}; do
      case "$s" in
        "${DSH_HOME}/.credentials.yaml"|"${WHALE_ROOT}/etc") continue ;;
      esac
      keep_list+=("$s")
    done
    if [ "${#keep_list[@]}" -gt 0 ]; then SELECTED=("${keep_list[@]}"); else SELECTED=(); fi
    REDACT=1
  fi
}

# ---------------------------------------------------------------------------
# 前置检查：平台/依赖/路径安全断言/加密工具/磁盘空间
# ---------------------------------------------------------------------------
prepare() {
  local v cur_val
  # 安全断言：任何一个关键路径为空或为 / 都直接拒绝（防"变量被改坏后误删/误建系统目录"）
  for v in WHALE_HOME WHALE_ROOT DSH_HOME BACKUP_DIR; do
    cur_val="${!v}"
    if [ -z "$cur_val" ] || [ "$cur_val" = "/" ]; then
      die "$v 取值非法（空或 /）：'$cur_val'。拒绝在根目录上执行备份。" 2
    fi
  done
  case "$WHALE_ROOT" in
    "$WHALE_HOME"/*) : ;;
    *) warn "WHALE_ROOT ($WHALE_ROOT) 不在 WHALE_HOME ($WHALE_HOME) 之下 —— 请确认这是有意为之。" ;;
  esac
  case "$DSH_HOME" in
    "$WHALE_HOME"/*) : ;;
    *) warn "DSH_HOME ($DSH_HOME) 不在 WHALE_HOME ($WHALE_HOME) 之下 —— 请确认这是有意为之。" ;;
  esac

  _have tar || die "缺少必需命令：tar" 2
  [ "$SHA_FLAVOR" != none ] || die "缺少 sha256 工具：需要 sha256sum / shasum / openssl 之一" 2

  # 明确回显"这次到底备份了哪里"：DSH_HOME 是可以被环境变量覆盖的，
  # 如果当前 shell 里恰好导出了别的 DSH_HOME，操作者能第一眼发现目标不对。
  info "生效路径：DSH_HOME=$DSH_HOME"
  info "          WHALE_ROOT=$WHALE_ROOT"
  info "          备份目录=${BACKUP_DIR}（保留最近 $KEEP 份）"

  if [ "$SQLITE_OK" != 1 ]; then
    warn "未找到 sqlite3：本次将跳过所有 SQLite 文件（绝不直接 cp 正在写入的数据库）。"
  fi

  if [ ! -d "$BACKUP_DIR" ]; then
    mkdir -p "$BACKUP_DIR" || die "无法创建备份目录：$BACKUP_DIR" 2
    chmod 700 "$BACKUP_DIR" 2>"$NULL_DEV" || warn "无法把备份目录权限设为 700，请人工检查：$BACKUP_DIR"
    info "已创建备份目录（0700）：$BACKUP_DIR"
  fi
  chmod 700 "$BACKUP_DIR" 2>"$NULL_DEV" || warn "无法将备份目录权限收紧为 700，请人工检查：$BACKUP_DIR"
  BACKUP_DIR_CANON=$(cd "$BACKUP_DIR" && pwd -P)

  if [ "$ENCRYPT" = 1 ]; then _pick_encrypt_tool; fi
}

# 选择加密工具：两者都缺 → 明确报错，绝不静默降级为明文
_pick_encrypt_tool() {
  case "$ENC_TOOL_REQ" in
    auto)
      if _have age; then ENC_TOOL=age
      elif _have gpg; then ENC_TOOL=gpg
      else
        die "要求 --encrypt，但系统里既没有 age 也没有 gpg。请先安装其中一个（apt install age / apt install gnupg），或去掉 --encrypt。不会静默降级为明文。" 2
      fi
      ;;
    age) _have age || die "WHALE_ENCRYPT_TOOL=age，但找不到 age 命令" 2; ENC_TOOL=age ;;
    gpg) _have gpg || die "WHALE_ENCRYPT_TOOL=gpg，但找不到 gpg 命令" 2; ENC_TOOL=gpg ;;
    *)   die "WHALE_ENCRYPT_TOOL 取值非法：'$ENC_TOOL_REQ'（可选 auto|age|gpg）" 2 ;;
  esac

  if [ "$ENC_TOOL" = age ]; then
    ENC_EXT="age"
    if [ -z "$AGE_RECIPIENT" ] && [ ! -t 0 ]; then
      die "非交互环境用 age 加密需要 WHALE_AGE_RECIPIENT=<age 公钥>；或在终端里手工执行以便输入口令。" 2
    fi
  else
    ENC_EXT="gpg"
    if [ -z "$GPG_PASSPHRASE_FILE" ] && [ ! -t 0 ]; then
      die "非交互环境用 gpg 加密需要 WHALE_GPG_PASSPHRASE_FILE=<口令文件>；或在终端里手工执行以便输入口令。" 2
    fi
  fi
  info "加密工具：${ENC_TOOL}（输出后缀 .tar.gz.${ENC_EXT}）"
}

# 空间预检：目标分区剩余空间必须 ≥ 预估大小的 2 倍
space_check() {
  local est_kb=0 kb src avail_kb need_kb
  for src in ${SELECTED[@]+"${SELECTED[@]}"}; do
    if [ -e "$src" ]; then
      kb=$(du -sk "$src" 2>"$NULL_DEV" | awk '{print $1}')
      est_kb=$((est_kb + ${kb:-0}))
    fi
  done
  avail_kb=$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')
  need_kb=$((est_kb * 2))
  info "空间预检：源数据约 $(_human $((est_kb * 1024)))（${est_kb} KB）"
  info "          备份分区剩余 $(_human $((avail_kb * 1024)))（${avail_kb} KB），需要 ≥ ${need_kb} KB"
  info "          （需要 2 倍：先在备份分区里复制一份暂存副本，再打包成归档）"
  if [ "${avail_kb:-0}" -lt "$need_kb" ]; then
    die "备份目录所在分区空间不足：剩余 ${avail_kb} KB < 需要 ${need_kb} KB（源数据 ${est_kb} KB 的 2 倍）。请先清理 ${BACKUP_DIR}，或用 WHALE_BACKUP_DIR 指向其他分区后重试。" 2
  fi
}

# ---------------------------------------------------------------------------
# 应用层刷盘（尽力而为，失败不致命）
# ---------------------------------------------------------------------------
maybe_flush() {
  local ctl=""
  if [ -n "$CTL_BIN" ]; then
    ctl="$CTL_BIN"
  elif [ -x "$WHALE_ROOT/bin/whale-ctl" ]; then
    ctl="$WHALE_ROOT/bin/whale-ctl"
  elif [ -x "$WHALE_ROOT/scripts/whale-ctl" ]; then
    ctl="$WHALE_ROOT/scripts/whale-ctl"
  fi
  if [ -z "$ctl" ]; then
    info "未找到 whale-ctl，跳过应用层刷盘（改由复制后校验 + sqlite3 .backup 兜底）"
    return 0
  fi
  if [ -z "$CTL_BIN" ] && ! "$ctl" help 2>"$NULL_DEV" | grep -qE '^[[:space:]]*flush([[:space:]]|$)'; then
    info "本版本无 flush 命令；使用复制稳定性校验与 SQLite 在线备份，不宣称跨文件原子快照"
    return 0
  fi
  info "请求应用层静默刷盘：$ctl flush"
  # 注意：当前仓库里的 whale-ctl 只有 status/sticker-collect/admin-presets 等子命令，
  # 若它没有实现 flush，这里会失败 —— 按设计**不致命**，继续走"复制后两遍校验 +
  # sqlite3 .backup"这条不依赖应用配合的一致性兜底路径。
  if _have timeout; then
    if timeout 60 "$ctl" flush; then info "刷盘完成"; else warn "whale-ctl flush 失败或超时（不致命，继续备份；若该子命令不存在属预期）"; fi
  else
    if "$ctl" flush; then info "刷盘完成"; else warn "whale-ctl flush 失败（不致命，继续备份；若该子命令不存在属预期）"; fi
  fi
}

# ---------------------------------------------------------------------------
# 暂存：把数据收进 $STAGE
# 归档内布局（恢复脚本按此映射还原）：
#   dsh/...   → $DSH_HOME/...
#   whale/... → $WHALE_ROOT/...
#   _meta/... → 仅供校验，不落盘
# 只复制普通文件与目录骨架；符号链接一律跳过（不跟随 → 不可能经链接读到工程外数据）
# ---------------------------------------------------------------------------
_dest_for() {
  local p="$1"
  case "$p" in
    "$DSH_HOME")    printf '%s/dsh\n' "$STAGE" ;;
    "$DSH_HOME"/*)  printf '%s/dsh/%s\n' "$STAGE" "${p#"$DSH_HOME"/}" ;;
    "$WHALE_ROOT")  printf '%s/whale\n' "$STAGE" ;;
    "$WHALE_ROOT"/*) printf '%s/whale/%s\n' "$STAGE" "${p#"$WHALE_ROOT"/}" ;;
    *) return 1 ;;
  esac
}

stage_all() {
  STAGE=$(mktemp -d "$BACKUP_DIR/.whale-stage.XXXXXX") || die "无法创建暂存目录（${BACKUP_DIR}）" 2
  chmod 700 "$STAGE"
  info "暂存目录：$STAGE"
  local src
  for src in ${SELECTED[@]+"${SELECTED[@]}"}; do
    if [ -d "$src" ]; then
      _stage_tree "$src"
    elif [ -f "$src" ]; then
      _stage_file "$src"
    else
      MISSING+=("$src")
      warn "跳过（不存在）：$src"
    fi
  done
}

_stage_tree() {
  local src="$1" p
  while IFS= read -r -d '' p; do
    _stage_mkdir "$p" || true
  done < <(find "$src" -name node_modules -prune -o -type d -print0 2>"$NULL_DEV")
  while IFS= read -r -d '' p; do
    _stage_file "$p"
  done < <(find "$src" -name node_modules -prune -o -type f -print0 2>"$NULL_DEV")
  while IFS= read -r -d '' p; do
    SKIPPED_LINKS+=("$p")
    warn "跳过符号链接（不跟随，避免读到工程外数据）：$p"
  done < <(find "$src" -name node_modules -prune -o -type l -print0 2>"$NULL_DEV")
}

_stage_mkdir() {
  local dest
  dest=$(_dest_for "$1") || return 0
  mkdir -p "$dest"
}

# 小型元数据文件才做内容哈希（覆盖写最容易在这类文件上产生半写内容）
_maybe_hash() {
  local f="$1" size
  size=$(_st_size "$f" 2>"$NULL_DEV" || printf 0)
  if [ "${size:-0}" -gt "$HASH_LIMIT" ]; then printf ''; return 0; fi
  case "$f" in
    *.json|*.jsonl|*.yaml|*.yml|*.env|*.txt|*.md|*.log)
      _sha256_file "$f" 2>"$NULL_DEV" || printf ''
      return 0 ;;
  esac
  printf ''
  return 0
}

_needs_redact() {
  case "$1" in
    "${DSH_HOME}/profiles"/*|"${DSH_HOME}/qqbot-settings"/*|"${DSH_HOME}/.dsh-qqbot"/*|"${DSH_HOME}/settings.yaml") return 0 ;;
    *) return 1 ;;
  esac
}

_is_sqlite() {
  case "$1" in
    *.db|*.sqlite|*.sqlite3) return 0 ;;
  esac
  # 无扩展名的库文件靠魔数识别：SQLite 文件头前 15 字节固定为 "SQLite format 3"
  local magic
  magic=$(head -c 16 "$1" 2>"$NULL_DEV" | od -An -tx1 | tr -d ' \n')
  [ "$magic" = "53514c69746520666f726d6174203300" ]
}

_stage_file() {
  local f="$1" dest
  if [ -L "$f" ]; then SKIPPED_LINKS+=("$f"); return 0; fi
  case "$f" in *-wal|*-shm) return 0 ;; esac
  dest=$(_dest_for "$f") || { warn "跳过（不在 DSH_HOME / WHALE_ROOT 之下）：$f"; return 0; }
  mkdir -p "$(dirname "$dest")"
  if _is_sqlite "$f"; then _stage_sqlite "$f" "$dest"; return 0; fi
  if [ "$REDACT" = 1 ] && _needs_redact "$f"; then _stage_redacted "$f" "$dest"; return 0; fi
  _stage_plain "$f" "$dest"
}

# 普通文件：复制 + 两遍 stat 比对 + 小型元数据文件哈希比对 + 重试
_stage_plain() {
  local f="$1" dest="$2"
  local tmp="${dest}.part" attempt=1 before after copy hb ha
  while :; do
    before=$(_st_size_mtime "$f")
    hb=$(_maybe_hash "$f")
    if ! cp -p "$f" "$tmp"; then
      warn "复制失败，跳过该文件：$f"
      die "Incomplete backup: failed to copy $f" 3
    fi
    after=$(_st_size_mtime "$f")
    ha=$(_maybe_hash "$f")
    copy=$(_st_size_mtime "$tmp")
    if [ "$before" = "$after" ] && [ "${copy%% *}" = "${after%% *}" ] && [ "$hb" = "$ha" ]; then
      mv -f "$tmp" "$dest"
      return 0
    fi
    if [ "$attempt" -ge "$STABLE_RETRY" ]; then
      mv -f "$tmp" "$dest" 2>"$NULL_DEV" || true
      UNSTABLE+=("$f  （$attempt 次尝试均检测到复制期间被写入：$before → ${after}）")
      warn "文件在备份期间持续被写入，已归档最后读到的副本并记入清单：$f"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep "$STABLE_WAIT"
  done
}

# 脱敏文件：先按普通文件稳定复制，再抹掉疑似凭据的值部分
_stage_redacted() {
  local f="$1" dest="$2" raw="${2}.raw"
  _stage_plain "$f" "$raw"
  if [ ! -f "$raw" ]; then return 0; fi
  # 只替换"键: 值"/"键=值"中的值，保留键名便于恢复后人工补回；
  # 命中疑似凭据键名就抹掉整值 —— 宁可过度脱敏，也不要把密钥带出工程。
  python3 "${WHALE_BACKUP_SOURCE_DIR}/redact-file.py" "$raw" "$dest" || die "凭据字段脱敏失败，拒绝发布不安全的备份" 3
  chmod 600 "$dest"
  rm -f "$raw"
  REDACTED_COUNT=$((REDACTED_COUNT + 1))
}

# SQLite：必须用 .backup 做在线一致性快照；不可用则跳过并告警
_stage_sqlite() {
  local f="$1" dest="$2"
  if [ "$SQLITE_OK" != 1 ]; then
    SKIPPED_SQLITE+=("$f （原因：未找到 sqlite3）")
    warn "跳过 SQLite 文件（sqlite3 不可用，绝不直接 cp 正在写入的库）：$f"
    return 0
  fi
  if sqlite3 "$f" ".backup '$dest'" >"$NULL_DEV" 2>&1 && [ -f "$dest" ]; then
    chmod 600 "$dest"
    SQLITE_COUNT=$((SQLITE_COUNT + 1))
  else
    SKIPPED_SQLITE+=("$f （原因：sqlite3 .backup 失败）")
    warn "sqlite3 .backup 失败，已跳过：$f"
    rm -f "$dest"
  fi
}

# ---------------------------------------------------------------------------
# 归档内元数据：_meta/files.sha256（逐文件校验）+ _meta/manifest.txt
# ---------------------------------------------------------------------------
_count_bytes() {
  local p="$1" n=0 b=0 f s
  if [ -f "$p" ]; then
    n=1; b=$(_st_size "$p")
  elif [ -d "$p" ]; then
    while IFS= read -r -d '' f; do
      n=$((n + 1))
      s=$(_st_size "$f" 2>"$NULL_DEV" || printf 0)
      b=$((b + ${s:-0}))
    done < <(find "$p" -type f -print0 2>"$NULL_DEV")
  fi
  printf '%s %s\n' "$n" "$b"
}

# 某个归档内路径（如 dsh/profiles）的内容摘要：该前缀下所有 "hash  path" 行再哈希
_path_digest() {
  local prefix="$1"
  if [ ! -f "$STAGE/_meta/files.sha256" ]; then printf '(不可用)'; return 0; fi
  awk -v p="$prefix" '
    { line = $0; sub(/^[0-9a-f]+[ \t]+/, "", line);
      if (line == p || index(line, p "/") == 1) print $0 }
  ' "$STAGE/_meta/files.sha256" | _sha256_stdin
}

_pkg_version() {
  local pkg="$1"
  if [ ! -f "$pkg" ]; then return 1; fi
  grep -m1 '"version"' "$pkg" 2>"$NULL_DEV" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' || true
}
_dsh_version() {
  local v
  v=$(_pkg_version "$WHALE_ROOT/app/node_modules/@deepseek-ai/dsh/package.json") || true
  if [ -n "${v:-}" ]; then printf '%s' "$v"; else printf '未安装/未知'; fi
}
_plugin_version() {
  local v
  v=$(_pkg_version "$DSH_HOME/profiles/web/node_modules/@zaofan/dsh-qqbot/package.json") || true
  if [ -n "${v:-}" ]; then printf '@zaofan/dsh-qqbot@%s' "$v"; else printf '未安装/未知'; fi
}

_manifest_body() {
  printf '# 小鲸鱼备份清单（whale-backup.sh 生成）\n'
  printf '备份时间: %s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')"
  printf '主机名: %s\n' "$(hostname 2>"$NULL_DEV" || printf unknown)"
  printf '执行用户: %s (uid=%s)\n' "$(id -un)" "$(id -u)"
  printf '脚本: whale-backup.sh（一致性策略：应用刷盘 + 复制后两遍比对 + sqlite3 .backup）\n'
  printf 'DSH 版本: %s\n' "$(_dsh_version)"
  printf '插件版本: %s\n' "$(_plugin_version)"
  printf 'DSH_HOME: %s\n' "$DSH_HOME"
  printf 'WHALE_ROOT: %s\n' "$WHALE_ROOT"
  if [ "$NO_SECRETS" = 1 ]; then
    printf '含敏感数据: no（--no-secrets：已排除 .credentials.yaml 与 etc/，profiles/settings 中的凭据字段已抹除；注意：sessions/ 会话历史未脱敏）\n'
  else
    printf '含敏感数据: yes（profiles/、.credentials.yaml、etc/ 内含明文凭据，请按 600 权限保管）\n'
  fi
  printf '加密: %s\n' "${ENC_TOOL:-none}"
  printf '每文件校验: _meta/files.sha256（sha256sum 兼容的 "hash  path" 格式）\n'
  printf '\n各路径统计（文件数 / 字节 / 内容 sha256）:\n'
  local src dest rel stats n b d
  for src in ${SELECTED[@]+"${SELECTED[@]}"}; do
    dest=$(_dest_for "$src") || continue
    rel=${dest#"$STAGE"/}
    if [ ! -e "$dest" ]; then
      printf '  %-22s %6s %12s %s\n' "$rel" "-" "-" "(未备份)"
      continue
    fi
    stats=$(_count_bytes "$dest")
    n=${stats%% *}
    b=${stats##* }
    d=$(_path_digest "$rel")
    printf '  %-22s %6s %12s %s\n' "$rel" "$n" "$b" "$d"
  done

  local x
  if [ "${#MISSING[@]}" -gt 0 ]; then
    printf '\n未找到（已跳过）:\n'
    for x in ${MISSING[@]+"${MISSING[@]}"}; do printf '  %s\n' "$x"; done
  fi
  if [ "${#SKIPPED_SQLITE[@]}" -gt 0 ]; then
    printf '\n跳过的 SQLite 文件（未使用 .backup，绝不直接 cp 正在写入的库）:\n'
    for x in ${SKIPPED_SQLITE[@]+"${SKIPPED_SQLITE[@]}"}; do printf '  %s\n' "$x"; done
  fi
  if [ "${#SKIPPED_LINKS[@]}" -gt 0 ]; then
    printf '\n跳过的符号链接（不跟随，避免读到工程外数据）:\n'
    for x in ${SKIPPED_LINKS[@]+"${SKIPPED_LINKS[@]}"}; do printf '  %s\n' "$x"; done
  fi
  if [ "${#UNSTABLE[@]}" -gt 0 ]; then
    printf '\n不稳定文件（复制期间被写入；已归档最后读到的副本，请人工核对）:\n'
    for x in ${UNSTABLE[@]+"${UNSTABLE[@]}"}; do printf '  %s\n' "$x"; done
  fi
  printf '\n统计: SQLite 在线快照 %s 个；脱敏文件 %s 个；跳过符号链接 %s 个\n' \
    "$SQLITE_COUNT" "$REDACTED_COUNT" "${#SKIPPED_LINKS[@]}"
}

write_meta() {
  local roots=()
  if [ -d "$STAGE/dsh" ]; then roots+=("$STAGE/dsh"); fi
  if [ -d "$STAGE/whale" ]; then roots+=("$STAGE/whale"); fi
  if [ "${#roots[@]}" -eq 0 ]; then
    die "没有任何数据被备份：请检查 $DSH_HOME 与 $WHALE_ROOT 是否存在、是否有读权限" 2
  fi
  mkdir -p "$STAGE/_meta"

  : > "$STAGE/_meta/files.sha256"
  local f rel h
  while IFS= read -r -d '' f; do
    rel=${f#"$STAGE"/}
    h=$(_sha256_file "$f" 2>"$NULL_DEV") || h="(哈希失败)"
    printf '%s  %s\n' "$h" "$rel" >> "$STAGE/_meta/files.sha256"
  done < <(find ${roots[@]+"${roots[@]}"} -type f -print0 2>"$NULL_DEV")
  LC_ALL=C sort -o "$STAGE/_meta/files.sha256" "$STAGE/_meta/files.sha256"

  _manifest_body > "$STAGE/_meta/manifest.txt"
}

# ---------------------------------------------------------------------------
# 打包 → （可选）加密 → 落盘 + 写清单
# ---------------------------------------------------------------------------
build_archive() {
  local top=()
  if [ -d "$STAGE/dsh" ]; then top+=(dsh); fi
  if [ -d "$STAGE/whale" ]; then top+=(whale); fi
  top+=(_meta)
  ARCHIVE_TMP="$BACKUP_DIR/.whale-tmp.$$.$RANDOM.tar.gz"
  info "开始打包（tar + gzip）…"
  if ! COPYFILE_DISABLE=1 tar -czf "$ARCHIVE_TMP" -C "$STAGE" ${top[@]+"${top[@]}"}; then
    die "tar 打包失败" 3
  fi
  chmod 600 "$ARCHIVE_TMP"
  info "归档已生成：$(basename "$ARCHIVE_TMP")（$(_human "$(_st_size "$ARCHIVE_TMP")")）"
}

_encrypt_to() {
  local src="$1" out="$2"
  case "$ENC_TOOL" in
    age)
      if [ -n "$AGE_RECIPIENT" ]; then
        info "age 加密（收件人公钥已提供，路径不回显）"
        age -r "$AGE_RECIPIENT" -o "$out" "$src" || die "age 加密失败" 3
      else
        info "age 口令加密（交互式输入，不会写入任何文件）"
        age -p -o "$out" "$src" || die "age 加密失败" 3
      fi
      ;;
    gpg)
      if [ -n "$GPG_PASSPHRASE_FILE" ]; then
        info "gpg 对称加密（口令来自文件，路径不回显）"
        gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
          --passphrase-file "$GPG_PASSPHRASE_FILE" -o "$out" "$src" || die "gpg 加密失败" 3
      else
        info "gpg 对称加密（交互式输入口令）"
        gpg --quiet --symmetric --cipher-algo AES256 -o "$out" "$src" || die "gpg 加密失败" 3
      fi
      ;;
    *) die "内部错误：未选择加密工具" 3 ;;
  esac
  chmod 600 "$out"
}

finalize() {
  local base i=0
  STAMP=$(date '+%Y%m%d-%H%M%S')
  # 同一秒内重复执行时避免覆盖已有归档
  while [ -e "$BACKUP_DIR/whale-$STAMP.tar.gz" ] \
     || [ -e "$BACKUP_DIR/whale-$STAMP.tar.gz.age" ] \
     || [ -e "$BACKUP_DIR/whale-$STAMP.tar.gz.gpg" ]; do
    i=$((i + 1))
    if [ "$i" -gt 5 ]; then die "同一秒内重复备份，文件名冲突，请稍后重试" 3; fi
    sleep 1
    STAMP=$(date '+%Y%m%d-%H%M%S')
  done
  base="whale-$STAMP.tar.gz"

  if [ "$ENCRYPT" = 1 ]; then
    FINAL="$BACKUP_DIR/$base.$ENC_EXT"
    _encrypt_to "$ARCHIVE_TMP" "$FINAL"
    _safe_rm "$ARCHIVE_TMP" || warn "临时明文归档删除失败，请手工删除：$ARCHIVE_TMP"
    ARCHIVE_TMP=""
    info "已加密并删除明文中间文件"
  else
    FINAL="$BACKUP_DIR/$base"
    mv -f "$ARCHIVE_TMP" "$FINAL"
    ARCHIVE_TMP=""
  fi
  chmod 600 "$FINAL"

  MANIFEST="$FINAL.manifest.txt"
  {
    _manifest_body
    printf '\n归档文件: %s\n' "$(basename "$FINAL")"
    printf '归档 sha256: %s\n' "$(_sha256_file "$FINAL")"
    printf '归档字节: %s\n' "$(_st_size "$FINAL")"
    printf '说明: 本清单不含归档自身 sha256 的归档内副本（_meta/manifest.txt 为此版本）\n'
  } > "$MANIFEST"
  chmod 600 "$MANIFEST"
}

# ---------------------------------------------------------------------------
# 保留份数：只删本脚本生成的、位于备份目录下的归档（含配对清单）
# ---------------------------------------------------------------------------
prune_backups() {
  local keep="$KEEP"
  case "$keep" in
    ''|*[!0-9]*) warn "WHALE_BACKUP_KEEP='$keep' 非数字，按 1 处理"; keep=1 ;;
  esac
  if [ "$keep" -eq 0 ]; then info "备份保留：不限份数，不自动删除"; return 0; fi

  local all=() line
  while IFS= read -r line; do
    all+=("$line")
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f \
             \( -name 'whale-*.tar.gz' -o -name 'whale-*.tar.gz.age' -o -name 'whale-*.tar.gz.gpg' \) \
             -print 2>"$NULL_DEV" | LC_ALL=C sort)
  # 文件名内嵌 YYYYmmdd-HHMMSS，按字典序排序即按时间排序（最旧在前）

  local n=${#all[@]}
  if [ "$n" -le "$keep" ]; then
    info "备份份数 $n ≤ 保留上限 ${keep}，无需清理"
    return 0
  fi

  local del=$((n - keep)) i=0 f size
  info "备份份数 $n > 上限 ${keep}：将删除最旧的 $del 份（本次新生成的归档永不删除）"
  info "以下文件即将被删除（删除前先列出，便于人工核对）："
  while [ "$i" -lt "${#all[@]}" ] && [ "$del" -gt 0 ]; do
    f="${all[$i]}"
    i=$((i + 1))
    if [ "$f" = "$FINAL" ]; then continue; fi
    size=$(_human "$(_st_size "$f" 2>"$NULL_DEV" || printf 0)")
    info "  · ${f}（${size}）"
    _safe_rm "$f" || warn "  删除被拒绝：$f"
    if [ -f "$f.manifest.txt" ]; then
      info "  · $f.manifest.txt（配对清单）"
      _safe_rm "$f.manifest.txt" || warn "  删除被拒绝：$f.manifest.txt"
    fi
    del=$((del - 1))
  done
}

print_summary() {
  local sha
  sha=$(_sha256_file "$FINAL") || die "无法计算归档 sha256：$FINAL" 3
  printf '\n=========== 备份完成 ===========\n'
  printf '归档      : %s\n' "$FINAL"
  printf '归档大小  : %s\n' "$(_human "$(_st_size "$FINAL")")"
  printf 'sha256    : %s\n' "$sha"
  printf '清单      : %s\n' "$MANIFEST"
  printf '权限      : 目录 700 / 归档 600 / 清单 600\n'
  if [ "$ENCRYPT" != 1 ]; then
    warn "本次备份未加密：归档内含等价于明文凭据的内容（profiles/ 与 etc/）。"
    warn "  放到低信任位置前请用：bash whale-backup.sh --encrypt（或 --no-secrets）"
  fi
  if [ "${#UNSTABLE[@]}" -gt 0 ]; then
    warn "有 ${#UNSTABLE[@]} 个文件在备份期间持续被写入，已记入清单，请人工核对。"
  fi
  if [ "${#SKIPPED_SQLITE[@]}" -gt 0 ]; then
    warn "有 ${#SKIPPED_SQLITE[@]} 个 SQLite 文件被跳过（详见清单）。"
  fi
  printf '恢复方式  : bash whale-restore.sh %s [--dry-run]\n' "$(basename "$FINAL")"
}

main() {
  umask 077
  parse_args "$@"
  _detect_platform
  build_selection
  checkpoint_memory_db
  prepare
  space_check
  maybe_flush
  stage_all
  if [ "${#SKIPPED_SQLITE[@]}" -gt 0 ] || [ "${#UNSTABLE[@]}" -gt 0 ]; then
    die "备份不完整或仍有写入，拒绝发布成功归档；停止小鲸鱼后重试" 3
  fi
  write_meta
  build_archive
  finalize
  prune_backups
  print_summary
  DONE=1   # 只有全部步骤走完才置位；EXIT trap 依据它识别"异常中途退出"
}

main "$@"
