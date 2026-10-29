#!/usr/bin/env bash
# =============================================================================
# whale-restore.sh —— QQ AI 机器人「小鲸鱼」备份恢复脚本
# =============================================================================
# 用法:
#   bash whale-restore.sh <备份文件> [选项]
#
# 选项:
#   --target DIR    把备份还原到 DIR 下的对应位置（DIR/.dsh 与 DIR/whale），
#                   而不是真实的 $DSH_HOME / ${WHALE_ROOT}。
#                   白名单也随之变成这两个目录 —— 无论哪种模式，脚本都**只写**
#                   这两个前缀之下的路径。
#   --manifest FILE 指定清单文件（默认 <备份文件>.manifest.txt）
#   --decrypt       归档是 age/gpg 加密的，先解密再解包（按后缀 .age/.gpg 自动识别）
#   --dry-run       只列出将要恢复的文件与目标路径，**不写入任何东西**
#   --self-test     在临时目录里演练"备份 → 恢复 → 逐字节比对"，不触碰真实数据
#   -h, --help      显示帮助
#
# 安全设计:
#   1) 防路径穿越：解包前先读取归档条目清单，逐条拒绝
#      · 绝对路径（以 / 开头）
#      · 含 ".." 段或空路径段
#      · 含控制字符（换行/回车等）
#      · 落在白名单前缀（dsh/、whale/、_meta/）之外的条目
#      · 符号链接 / 硬链接 / 设备 / FIFO 等非普通文件条目（防链接逃逸）
#      任何一条不满足即中止，不做部分解包。
#   2) 只写白名单目录：默认 $DSH_HOME 与 ${WHALE_ROOT}；--target 时是 DIR/.dsh 与 DIR/whale。
#   3) 先做只读校验（manifest sha256 + 条目白名单），再做"恢复前快照"，最后才写入。
#      —— 顺序上比"先快照再校验"更保守：任何校验失败都不会产生任何副作用。
#   4) 恢复前若目标已有数据，自动调用 whale-backup.sh 做一次快照；快照失败即中止。
#   5) 恢复后逐文件校验 _meta/files.sha256（归档内清单）；不一致会明确报错并非 0 退出。
#   6) 不自动重启任何服务，只在最后打印需要人工执行的命令。
#
# 退出码: 0 成功；1 参数/归档内容非法；2 前置条件不满足（文件缺失、清单校验失败、
#         快照失败、解密工具缺失）；3 解包/解密失败；4 恢复后内容校验失败。
# =============================================================================
set -euo pipefail
WHALE_RESTORE_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHALE_RESTORE_SOURCE_PATH="${WHALE_RESTORE_SOURCE_DIR}/$(basename "${BASH_SOURCE[0]}")"

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
# 变量契约（与 whale-backup.sh 保持一致，全部可用环境变量覆盖）
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
BACKUP_SCRIPT="${WHALE_BACKUP_SCRIPT:-}"
AGE_IDENTITY="${WHALE_AGE_IDENTITY:-}"
GPG_PASSPHRASE_FILE="${WHALE_GPG_PASSPHRASE_FILE:-}"

# ---------------------------------------------------------------------------
# 内部状态
# ---------------------------------------------------------------------------
ARCHIVE=""
MANIFEST=""
TARGET_DIR=""
DECRYPT=0
DRY_RUN=0
SELF_TEST=0
PLAIN=""                       # 实际用于解包的归档（可能来自解密）
RESTORE_DSH_HOME=""            # 落盘白名单之一
RESTORE_WHALE_ROOT=""          # 落盘白名单之二
META_MARK="(仅校验，不落盘)"
TMP_DIRS=()
SNAP_WHALE_HOME=""
SELF_FAIL=0
DONE=0
STAT_FLAVOR="bsd"
SHA_FLAVOR="none"
SELF_PATH="$WHALE_RESTORE_SOURCE_PATH"
SCRIPT_DIR="$WHALE_RESTORE_SOURCE_DIR"

# ---------------------------------------------------------------------------
# 输出 helper（中文）
# ---------------------------------------------------------------------------
info() { printf '[信息] %s\n' "$*"; }
warn() { printf '[警告] %s\n' "$*" >&2; }
die()  { printf '[错误] %s\n' "$1" >&2; exit "${2:-1}"; }

usage() {
  cat <<'EOF'
whale-restore.sh —— 小鲸鱼备份恢复脚本

用法:
  bash whale-restore.sh <备份文件> [选项]

选项:
  --target DIR    还原到 DIR/.dsh 与 DIR/whale（而不是真实的 DSH_HOME / WHALE_ROOT）
  --manifest FILE 指定清单文件（默认 <备份文件>.manifest.txt）
  --decrypt       归档为 age/gpg 加密格式，先解密再解包
  --dry-run       只列出将要恢复的文件与目标路径，不写入任何东西
  --self-test     在 /tmp 下演练"备份 → 恢复 → 逐字节比对"，不触碰真实数据
  -h, --help      显示本帮助

退出码: 0 成功；1 参数/归档非法；2 前置条件不满足；3 解包/解密失败；4 内容校验失败。
本脚本不会自动重启任何服务。
EOF
}

# ---------------------------------------------------------------------------
# 平台兼容 helper
# ---------------------------------------------------------------------------
_have() { command -v "$1" >"$NULL_DEV" 2>&1; }
_detect_platform() {
  if stat -c '%s' / >"$NULL_DEV" 2>&1; then STAT_FLAVOR=gnu; else STAT_FLAVOR=bsd; fi
  if _have sha256sum; then SHA_FLAVOR=sha256sum
  elif _have shasum; then SHA_FLAVOR=shasum
  elif _have openssl; then SHA_FLAVOR=openssl
  else SHA_FLAVOR=none
  fi
}
_st_size() {
  if [ "$STAT_FLAVOR" = gnu ]; then stat -c '%s' "$1"; else stat -f '%z' "$1"; fi
}
# 取权限位（八进制，如 600）——gnu/bsd 语法不同
_st_mode() {
  if [ "$STAT_FLAVOR" = gnu ]; then stat -c '%a' "$1"; else stat -f '%Lp' "$1"; fi
}
_sha256_file() {
  case "$SHA_FLAVOR" in
    sha256sum) sha256sum "$1" | awk '{print $1}' ;;
    shasum)    shasum -a 256 "$1" | awk '{print $1}' ;;
    openssl)   openssl dgst -sha256 "$1" | awk '{print $NF}' ;;
    *) return 1 ;;
  esac
}
_human() {
  awk -v b="${1:-0}" 'BEGIN{ split("B KB MB GB TB", u, " "); i = 1; while (b >= 1024 && i < 5) { b /= 1024; i++ } printf "%.1f%s", b, u[i] }'
}

# ---------------------------------------------------------------------------
# 临时目录：登记 + 退出时按"名字模式 + 规范化父目录"清理（防误删关键保护）
# ---------------------------------------------------------------------------
# 创建临时目录并把路径写入全局 MK_TMP_RESULT。
# 注意：**不能**写成 d=$(_mk_tmp ...) —— 命令替换在子 shell 里执行，
# 登记语句会随子 shell 一起丢失，退出时就清理不掉（这是实测踩到的坑）。
MK_TMP_RESULT=""
_mk_tmp() {
  local prefix="$1" d
  d=$(mktemp -d "${TMPDIR:-/tmp}/${prefix}.XXXXXX") || die "无法创建临时目录（${TMPDIR:-/tmp}）" 2
  d=$(cd "$d" && pwd -P)
  chmod 700 "$d"
  TMP_DIRS+=("$d")
  MK_TMP_RESULT="$d"
}
_cleanup_tmp() {
  local d dir base
  for d in ${TMP_DIRS[@]+"${TMP_DIRS[@]}"}; do
    [ -n "$d" ] || continue
    dir=$(cd "$(dirname "$d")" 2>"$NULL_DEV" && pwd -P) || { warn "跳过临时目录清理（父目录不可解析）：$d"; continue; }
    base=$(basename "$d")
    case "$base" in
      whale-restore.*|whale-selftest.*) rm -rf "${dir:?}/${base:?}" ;;
      *) warn "拒绝清理临时目录（名字不在白名单模式内）：$dir/$base" ;;
    esac
  done
}
on_exit() {
  local rc=$?
  set +e
  _cleanup_tmp
  # 退出码保真：bash 在个别致命错误下会把 rc=0 传给 EXIT trap，会把失败伪装成成功
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
      --target)
        [ $# -ge 2 ] || { printf '[错误] --target 需要一个目录参数\n' >&2; exit 1; }
        TARGET_DIR="$2"; shift ;;
      --manifest)
        [ $# -ge 2 ] || { printf '[错误] --manifest 需要一个文件参数\n' >&2; exit 1; }
        MANIFEST="$2"; shift ;;
      --decrypt)  DECRYPT=1 ;;
      --dry-run)  DRY_RUN=1 ;;
      --self-test) SELF_TEST=1 ;;
      -h|--help)  usage; exit 0 ;;
      -*)         printf '[错误] 未知选项: %s\n' "$1" >&2; usage >&2; exit 1 ;;
      *)
        if [ -z "$ARCHIVE" ]; then ARCHIVE="$1"
        else printf '[错误] 只能指定一个备份文件（多余参数：%s）\n' "$1" >&2; usage >&2; exit 1
        fi
        ;;
    esac
    shift
  done
  if [ "$SELF_TEST" != 1 ] && [ -z "$ARCHIVE" ]; then
    printf '[错误] 缺少备份文件参数\n' >&2; usage >&2; exit 1
  fi
}

# ---------------------------------------------------------------------------
# 落盘映射：归档内 dsh/... → $RESTORE_DSH_HOME/...，whale/... → $RESTORE_WHALE_ROOT/...
# _meta/... 只用于校验，不落盘。
# ---------------------------------------------------------------------------
_mapped_dest() {
  case "$1" in
    dsh)     printf '%s\n' "$RESTORE_DSH_HOME" ;;
    dsh/*)   printf '%s/%s\n' "$RESTORE_DSH_HOME" "${1#dsh/}" ;;
    whale)   printf '%s\n' "$RESTORE_WHALE_ROOT" ;;
    whale/*) printf '%s/%s\n' "$RESTORE_WHALE_ROOT" "${1#whale/}" ;;
    _meta|_meta/*) printf '%s\n' "$META_MARK" ;;
    *) return 1 ;;
  esac
}

# 逐条校验归档条目（防路径穿越 / 防逃逸 / 防类型逃逸）
_validate_entry() {
  local e="$1" seg
  local segs=()
  case "$e" in ./*) e="${e#./}" ;; esac     # 容忍手工打包产生的 ./ 前缀
  case "$e" in */)  e="${e%/}"  ;; esac      # 目录条目末尾的 /
  if [ -z "$e" ]; then
    die "归档中存在空条目名，拒绝解包" 1
  fi
  case "$e" in
    *[[:cntrl:]]*) die "归档条目含控制字符，拒绝解包（防日志伪造/参数注入）：$(printf '%s' "$e" | tr -d '[:print:]')" 1 ;;
  esac
  case "$e" in
    /*) die "归档条目是绝对路径，拒绝解包：$e" 1 ;;
  esac
  IFS='/' read -r -a segs <<< "$e"
  for seg in ${segs[@]+"${segs[@]}"}; do
    if [ "$seg" = ".." ]; then die "归档条目含 .. 段（路径穿越），拒绝解包：$e" 1; fi
    if [ -z "$seg" ]; then die "归档条目含空路径段，拒绝解包：$e" 1; fi
  done
  case "$e" in
    dsh|dsh/*|whale|whale/*|_meta|_meta/*) : ;;
    *) die "归档条目不在白名单前缀（dsh/、whale/、_meta/）内，拒绝解包：$e" 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# 归档准备：定位清单 → 校验归档 sha256 → 必要时解密
# ---------------------------------------------------------------------------
_prepare_archive() {
  [ -f "$ARCHIVE" ] || die "备份文件不存在或不是普通文件：$ARCHIVE" 2
  [ -r "$ARCHIVE" ] || die "备份文件不可读：$ARCHIVE" 2
  if [ "$(_st_size "$ARCHIVE")" -le 0 ]; then die "备份文件是空文件：$ARCHIVE" 2; fi
  if [ -z "$MANIFEST" ]; then MANIFEST="$ARCHIVE.manifest.txt"; fi

  # 1) 清单校验（若存在）
  if [ -f "$MANIFEST" ]; then
    local want got
    want=$(grep -m1 '^归档 sha256:' "$MANIFEST" | awk '{print $3}') || true
    if [ -n "${want:-}" ]; then
      got=$(_sha256_file "$ARCHIVE") || die "无法计算归档 sha256" 2
      if [ "$want" != "$got" ]; then
        die "归档 sha256 与清单不一致，拒绝恢复（文件可能损坏或被篡改）
     清单记录: $want
     实际计算: $got
     如确认是清单过期，可用 --manifest 指定正确的清单文件。" 2
      fi
      info "清单校验通过：sha256=$got"
    else
      warn "清单里没有 '归档 sha256:' 行，跳过完整性校验：$MANIFEST"
    fi
  else
    warn "未找到清单文件（${MANIFEST}），跳过 sha256 完整性校验"
  fi

  # 2) 解密（或直接使用明文归档）
  PLAIN="$ARCHIVE"
  case "$ARCHIVE" in
    *.age|*.gpg) DECRYPT=1 ;;
  esac
  if [ "$DECRYPT" = 1 ]; then
    _have_age_or_gpg_by_ext
    local td out
    _mk_tmp whale-restore
    td="$MK_TMP_RESULT"
    out="$td/plain.tar.gz"
    case "$ARCHIVE" in
      *.gpg)
        _have gpg || die "归档是 gpg 加密的，但系统里没有 gpg" 2
        if [ -n "$GPG_PASSPHRASE_FILE" ]; then
          gpg --batch --yes --quiet --passphrase-file "$GPG_PASSPHRASE_FILE" -o "$out" -d "$ARCHIVE" \
            || die "gpg 解密失败" 3
        else
          [ -t 0 ] || die "非交互环境用 gpg 解密需要 WHALE_GPG_PASSPHRASE_FILE=<口令文件>" 2
          gpg --quiet -o "$out" -d "$ARCHIVE" || die "gpg 解密失败" 3
        fi
        ;;
      *)
        _have age || die "归档是 age 加密的，但系统里没有 age" 2
        if [ -n "$AGE_IDENTITY" ]; then
          age -d -i "$AGE_IDENTITY" -o "$out" "$ARCHIVE" || die "age 解密失败" 3
        else
          age -d -o "$out" "$ARCHIVE" || die "age 解密失败" 3
        fi
        ;;
    esac
    chmod 600 "$out"
    PLAIN="$out"
    info "解密完成：$(basename "$ARCHIVE") → 临时明文（退出时自动删除）"
  fi
}
_have_age_or_gpg_by_ext() {
  case "$ARCHIVE" in
    *.gpg) _have gpg || die "找不到 gpg（解密 .gpg 需要）" 2 ;;
    *.age) _have age || die "找不到 age（解密 .age 需要）" 2 ;;
  esac
}

# ---------------------------------------------------------------------------
# 读取归档清单并做全部只读校验
# ---------------------------------------------------------------------------
_read_and_validate() {
  local listing vlisting entry t line
  listing=$(tar -tzf "$PLAIN" 2>"$NULL_DEV") || die "无法读取归档（tar -t 失败）：$PLAIN" 3
  if [ -z "$listing" ]; then die "归档内容为空：$PLAIN" 3; fi

  # 1) 逐条路径校验（含白名单、.. 段、绝对路径、控制字符）
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    _validate_entry "$entry"
  done <<< "$listing"

  # 2) 条目类型校验：只接受普通文件与目录（拒绝符号链接/硬链接/设备/FIFO）
  vlisting=$(tar -tvzf "$PLAIN" 2>"$NULL_DEV") || die "无法读取归档详细清单（tar -tv 失败）" 3
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    t=${line%"${line#?}"}     # 取首字符（tar -tv 的第一列是类型位）
    case "$t" in
      l|h) die "归档包含符号链接/硬链接条目，拒绝解包（防链接逃逸）：$line" 1 ;;
      b|c|p) die "归档包含设备/FIFO 等特殊文件条目，拒绝解包：$line" 1 ;;
    esac
  done <<< "$vlisting"
}

# 统计"将要写入"的条目与目标（供 --dry-run 与提示使用）
# 输出: 条目数 覆盖数 新增数；同时把明细写入 stdout（由调用方决定是否打印）
_plan_entries() {
  local listing entry dest n=0 overwrite=0 neww=0 shown=0
  listing=$(tar -tzf "$PLAIN" 2>"$NULL_DEV") || die "无法读取归档" 3
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    case "$entry" in ./*) entry="${entry#./}" ;; esac
    case "$entry" in */)  entry="${entry%/}"  ;; esac
    dest=$(_mapped_dest "$entry") || continue
    [ "$dest" = "$META_MARK" ] && continue
    n=$((n + 1))
    if [ -e "$dest" ]; then
      overwrite=$((overwrite + 1))
      printf '  覆盖  %s\n' "$dest"
    else
      neww=$((neww + 1))
      printf '  新增  %s\n' "$dest"
    fi
    shown=$((shown + 1))
  done <<< "$listing"
  printf '  小计: 将写入 %s 个条目（覆盖 %s，新增 %s）\n' "$n" "$overwrite" "$neww"
}

# ---------------------------------------------------------------------------
# 恢复前快照：目标已有数据时调用 whale-backup.sh；失败即中止
# ---------------------------------------------------------------------------
_resolve_backup_script() {
  if [ -n "$BACKUP_SCRIPT" ]; then
    [ -f "$BACKUP_SCRIPT" ] || die "WHALE_BACKUP_SCRIPT 指向的文件不存在：$BACKUP_SCRIPT" 2
    printf '%s\n' "$BACKUP_SCRIPT"; return 0
  fi
  local c
  for c in "$SCRIPT_DIR/whale-backup.sh" "$WHALE_ROOT/scripts/whale-backup.sh" "$WHALE_ROOT/bin/whale-backup.sh"; do
    if [ -f "$c" ]; then printf '%s\n' "$c"; return 0; fi
  done
  return 1
}

_target_has_data() {
  local d
  for d in "$RESTORE_DSH_HOME" "$RESTORE_WHALE_ROOT"; do
    if [ -d "$d" ] && [ -n "$(ls -A "$d" 2>"$NULL_DEV")" ]; then return 0; fi
  done
  return 1
}

_take_snapshot() {
  local bk
  _target_has_data || { info "目标当前没有数据，无需恢复前快照"; return 0; }
  bk=$(_resolve_backup_script) || die "恢复前快照失败：找不到 whale-backup.sh（可用 WHALE_BACKUP_SCRIPT=<路径> 指定）。
     为保护现有数据，本次恢复已中止，且未写入任何文件。" 2
  info "目标已有数据 → 先做恢复前快照：$bk"
  # 快照只针对本次要覆盖的那套路径（--target 时就是那个目录，而不是线上数据）
  if WHALE_HOME="${SNAP_WHALE_HOME}" WHALE_ROOT="$RESTORE_WHALE_ROOT" DSH_HOME="$RESTORE_DSH_HOME" \
       bash "$bk"; then
    info "恢复前快照完成"
  else
    die "恢复前快照失败，已中止恢复（未写入任何文件）。请先修好备份（磁盘空间/权限）再重试。" 2
  fi
}

# ---------------------------------------------------------------------------
# 解包 + 内容校验 + 权限收紧
# ---------------------------------------------------------------------------
_extract() {
  local listing
  listing=$(tar -tzf "$PLAIN" 2>"$NULL_DEV") || die "无法读取归档" 3
  local has_dsh=0 has_whale=0 e
  while IFS= read -r e; do
    case "$e" in
      dsh|dsh/*) has_dsh=1 ;;
      whale|whale/*) has_whale=1 ;;
    esac
  done <<< "$listing"

  if [ "$has_dsh" = 1 ]; then
    mkdir -p "$RESTORE_DSH_HOME"
    info "解包 dsh/ → $RESTORE_DSH_HOME"
    tar -xzf "$PLAIN" -C "$RESTORE_DSH_HOME" --strip-components=1 --no-same-owner --no-same-permissions dsh \
      || die "解包 dsh/ 失败" 3
  fi
  if [ "$has_whale" = 1 ]; then
    mkdir -p "$RESTORE_WHALE_ROOT"
    info "解包 whale/ → $RESTORE_WHALE_ROOT"
    tar -xzf "$PLAIN" -C "$RESTORE_WHALE_ROOT" --strip-components=1 --no-same-owner --no-same-permissions whale \
      || die "解包 whale/ 失败" 3
  fi
}

# 用归档内 _meta/files.sha256 逐文件校验（若归档里没有该清单则跳过并告警）
# 清单行格式为 sha256sum 兼容的两段式："<64位hash><空格><空格><归档内相对路径>"
_verify_contents() {
  local inner line h rel dest actual
  local ok=0 bad=0 missing=0 unparsed=0
  inner=$(tar -xzOf "$PLAIN" _meta/files.sha256 2>"$NULL_DEV") || inner=""
  if [ -z "$inner" ]; then
    warn "归档内没有 _meta/files.sha256，跳过逐文件内容校验"
    return 0
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    h=${line%% *}          # 第一个空格之前 = 哈希
    rel=${line#*  }        # 第一个"双空格"之后 = 路径（路径里可能含单个空格）
    [ -n "$rel" ] || continue
    case "$rel" in _meta/*) continue ;; esac
    if [ "$h" = "(哈希失败)" ]; then warn "  归档内该文件未记录哈希，跳过：$rel"; continue; fi
    if ! dest=$(_mapped_dest "$rel"); then
      # 解析不出来绝不能静默放过：否则会出现"校验通过"的假象
      unparsed=$((unparsed + 1))
      warn "  清单条目无法映射到白名单路径（格式异常）：$line"
      continue
    fi
    if [ ! -e "$dest" ]; then
      missing=$((missing + 1))
      warn "  恢复后缺失：$dest"
      continue
    fi
    actual=$(_sha256_file "$dest" 2>"$NULL_DEV") || actual="(读取失败)"
    if [ "$actual" = "$h" ]; then
      ok=$((ok + 1))
    else
      bad=$((bad + 1))
      warn "  内容与备份不一致：$dest"
    fi
  done <<< "$inner"

  printf '[信息] 内容校验：通过 %s 个，不一致 %s 个，缺失 %s 个，无法解析 %s 个\n' \
    "$ok" "$bad" "$missing" "$unparsed"
  if [ "$bad" -gt 0 ] || [ "$missing" -gt 0 ] || [ "$unparsed" -gt 0 ]; then
    warn "恢复结果与备份清单不一致，请人工核查（服务建议暂不启动）。"
    return 4
  fi
  if [ "$ok" -eq 0 ]; then
    warn "清单里没有任何条目被校验（归档可能是空数据或清单异常），请人工确认。"
  fi
  return 0
}

_tighten_permissions() {
  if [ -f "$RESTORE_DSH_HOME/.credentials.yaml" ]; then
    chmod 600 "$RESTORE_DSH_HOME/.credentials.yaml" 2>"$NULL_DEV" || warn "无法设置 .credentials.yaml 权限为 600"
  fi
  if [ -d "$RESTORE_DSH_HOME" ]; then
    chmod 700 "$RESTORE_DSH_HOME" 2>"$NULL_DEV" || true
  fi
  if [ -d "$RESTORE_WHALE_ROOT/etc" ]; then
    chmod 700 "$RESTORE_WHALE_ROOT/etc" 2>"$NULL_DEV" || true
    find "$RESTORE_WHALE_ROOT/etc" -type f -exec chmod 600 {} + 2>"$NULL_DEV" || true
  fi
}

_follow_up_commands() {
  printf '\n后续请**人工**执行（本脚本不会自动重启任何服务）：\n'
  if [ -n "$TARGET_DIR" ]; then
    printf '  1) 这是演练/异地恢复（--target %s），数据不在线上路径上，\n' "$TARGET_DIR"
    printf '     确认无误后再手工搬到 %s 与 %s。\n' "$DSH_HOME" "$WHALE_ROOT"
    return 0
  fi
  printf '  1) 检查关键文件权限：\n'
  printf '       ls -l %s/.credentials.yaml %s/etc/qqbot.env\n' "$RESTORE_DSH_HOME" "$RESTORE_WHALE_ROOT"
  printf '  2) 重启（system 级）服务：\n'
  printf '       systemctl daemon-reload\n'
  printf '       systemctl restart qqwhale.service\n'
  printf '       systemctl status qqwhale.service\n'
  printf '  3) 查看启动日志：\n'
  printf '       tail -n 50 %s/logs/dsh.err.log\n' "$RESTORE_WHALE_ROOT"
  printf '  4) 健康检查（进程/端口/QQ 网关/模型 API 四项）：\n'
  printf '       bash whale-monitor.sh\n'
}

# ---------------------------------------------------------------------------
# 主恢复流程
# ---------------------------------------------------------------------------
run_restore() {
  # 落盘白名单：默认就是真实路径；--target 时是 DIR/.dsh 与 DIR/whale
  if [ -n "$TARGET_DIR" ]; then
    case "$TARGET_DIR" in
      /) die "--target 不能是 /" 1 ;;
    esac
    RESTORE_DSH_HOME="$TARGET_DIR/.dsh"
    RESTORE_WHALE_ROOT="$TARGET_DIR/whale"
    SNAP_WHALE_HOME="$TARGET_DIR"
    info "恢复目标（自定义）：$RESTORE_DSH_HOME 与 $RESTORE_WHALE_ROOT"
  else
    RESTORE_DSH_HOME="$DSH_HOME"
    RESTORE_WHALE_ROOT="$WHALE_ROOT"
    SNAP_WHALE_HOME="$WHALE_HOME"
    info "恢复目标（线上路径）：$RESTORE_DSH_HOME 与 $RESTORE_WHALE_ROOT"
  fi

  _prepare_archive          # 只读：清单 sha256 + 解密
  python3 "$SCRIPT_DIR/verify-archive.py" "$PLAIN" "$RESTORE_DSH_HOME" "$RESTORE_WHALE_ROOT" || die "恢复写入前验证失败，未修改目标" 2
  _read_and_validate        # 只读：条目白名单 / 路径穿越 / 链接类型

  if [ "$DRY_RUN" = 1 ]; then
    printf '\n===== DRY-RUN：只列出计划，不写入任何文件 =====\n'
    printf '归档: %s（%s）\n' "$ARCHIVE" "$(_human "$(_st_size "$ARCHIVE")")"
    printf '清单: %s\n' "$MANIFEST"
    printf '目标: %s\n      %s\n' "$RESTORE_DSH_HOME" "$RESTORE_WHALE_ROOT"
    printf '计划写入的路径：\n'
    _plan_entries
    printf '说明: --dry-run 不创建目录、不写入任何文件；也不会执行恢复前快照。\n'
    return 0
  fi

  if [ -z "$TARGET_DIR" ] && command -v systemctl >"$NULL_DEV" 2>&1; then
    if systemctl is-active --quiet qqwhale.service; then
      die "请先停止小鲸鱼再恢复数据，避免运行进程覆盖恢复结果（whale-ctl stop）" 2
    fi
  fi
  _take_snapshot            # 目标已有数据 → 先快照（失败即中止）
  _extract                  # 解包（已通过白名单校验）
  _tighten_permissions
  if [ -z "$TARGET_DIR" ] && [ "$(id -u)" = 0 ]; then
    # Only whitelisted restored files; do not chown runtime, backups or unrelated state.
    python3 - "$PLAIN" "$RESTORE_DSH_HOME" "$RESTORE_WHALE_ROOT" <<'OWNER'
import os, pwd, sys, tarfile
from pathlib import Path
u=pwd.getpwnam('qqwhale')
with tarfile.open(sys.argv[1]) as t:
    for m in t.getmembers():
        parts=Path(m.name).parts
        root={'dsh':sys.argv[2], 'whale':sys.argv[3]}.get(parts[0])
        if root:
            p=Path(root).joinpath(*parts[1:])
            if m.name in ('whale/etc/admin-routing.json', 'whale/etc/vision-routing.json', 'whale/etc/search-config.json', 'whale/etc/proactive.json'):
                os.chown(p,0,u.pw_gid,follow_symlinks=False)
                os.chmod(p,0o640)
            else:
                os.chown(p,u.pw_uid,u.pw_gid,follow_symlinks=False)
OWNER
  fi

  local vrc=0
  _verify_contents || vrc=$?
  if [ "$vrc" -ne 0 ]; then
    die "恢复已完成但内容校验未通过（见上方列表），请勿直接启动服务。" 4
  fi

  printf '\n[信息] 恢复完成：%s → %s / %s\n' "$ARCHIVE" "$RESTORE_DSH_HOME" "$RESTORE_WHALE_ROOT"
  _follow_up_commands
}

# ===========================================================================
# --self-test：在临时目录里演练「备份 → 恢复 → 逐字节比对」
#   全部动作都在 mktemp -d 出来的临时目录内完成，绝不触碰真实数据；
#   退出码 0 = 全部子测试通过，非 0 = 有子测试失败（会逐条打印 PASS/FAIL）。
# ===========================================================================
_self_assert() {   # $1=名称 $2=条件(0=通过)
  if [ "$2" -eq 0 ]; then printf '  [PASS] %s\n' "$1"; return 0; fi
  printf '  [FAIL] %s\n' "$1"; SELF_FAIL=$((SELF_FAIL + 1)); return 1
}

_selftest_fixture() {   # 在 $1 下造一份"小型真实结构"的数据
  local root="$1"
  mkdir -p "$root/.dsh/profiles/web" "$root/.dsh/sessions" \
           "$root/whale/data/表情包/lib/candidate" "$root/whale/workspace" \
           "$root/whale/etc" "$root/whale/logs" "$root/whale/bin"
  printf '小鲸鱼人设：温柔、话少\n' > "$root/whale/workspace/AGENTS.md"
  # 注意：夹具里刻意使用**明确的占位符**而不是"像真密钥的假值"。
  # 两个原因：① 保留「键: 值」结构，脱敏逻辑（按键名与值形状匹配）仍能被真实验证；
  #           ② 不会被安全扫描规则误判成明文凭据泄漏（曾因此让静态审计持续 FAIL）。
  printf 'appId: "SELFTEST_APPID"\nappSecret: "SELFTEST_SECRET"\npersona: 温柔\n' \
    > "$root/.dsh/profiles/web/cordis.patch.yml"
  printf 'model: deepseek\napiKey: SELFTEST_APIKEY\n' > "$root/.dsh/settings.yaml"
  printf '%s\n' '{"t":"user","text":"你好"}' '{"t":"assistant","text":"在的"}' > "$root/.dsh/sessions/s1.jsonl"
  printf 'deepseek: SELFTEST_CRED\n' > "$root/.dsh/.credentials.yaml"
  printf 'QQBOT_APPID=SELFTEST_APPID\nQQBOT_SECRET=SELFTEST_SECRET\n' > "$root/whale/etc/qqbot.env"
  printf '带空格的 文件名 测试\n' > "$root/whale/data/表情包/lib/candidate/a b.jpg"
  head -c 4096 /dev/urandom > "$root/whale/data/表情包/lib/candidate/b.jpg"
  printf '{"好感度":1}\n' > "$root/whale/data/台账.json"
  if _have sqlite3; then
    sqlite3 "$root/whale/data/ledger.db" 'create table t(x); insert into t values(1),(2),(3);' >"$NULL_DEV" 2>&1 || true
  fi
  ln -s /etc/hosts "$root/whale/data/link-out" 2>"$NULL_DEV" || true   # 应被备份脚本跳过
}

_selftest_compare() {   # $1=源根 $2=恢复根
  local src="$1" dst="$2" rel f r cmp_ok=0 cmp_bad=0
  local paths=(".dsh/profiles" ".dsh/.credentials.yaml" ".dsh/storages" ".dsh/qqbot-settings" ".dsh/.dsh-qqbot" ".dsh/sessions" ".dsh/settings.yaml" \
               "whale/data" "whale/workspace" "whale/etc")
  for rel in ${paths[@]+"${paths[@]}"}; do
    if [ -d "$src/$rel" ]; then
      while IFS= read -r -d '' f; do
        r=${f#"$src"/}
        if [ ! -f "$dst/$r" ]; then
          warn "    缺少文件：$r"; cmp_bad=$((cmp_bad + 1)); continue
        fi
        case "$r" in
          *.db|*.sqlite|*.sqlite3)
            # SQLite 用 .dump 语义比对：.backup 快照与源文件字节可能不同，但内容必须一致
            if _have sqlite3; then
              if [ "$(sqlite3 "$f" .dump 2>"$NULL_DEV" | _sha256_stdin)" = "$(sqlite3 "$dst/$r" .dump 2>"$NULL_DEV" | _sha256_stdin)" ]; then
                cmp_ok=$((cmp_ok + 1))
              else
                warn "    SQLite 内容不一致：$r"; cmp_bad=$((cmp_bad + 1))
              fi
            else
              cmp_ok=$((cmp_ok + 1))
            fi
            ;;
          *)
            if cmp -s "$f" "$dst/$r"; then cmp_ok=$((cmp_ok + 1))
            else warn "    内容不一致：$r"; cmp_bad=$((cmp_bad + 1))
            fi
            ;;
        esac
      done < <(find "$src/$rel" -type f -print0 2>"$NULL_DEV")
    elif [ -f "$src/$rel" ]; then
      if cmp -s "$src/$rel" "$dst/$rel"; then cmp_ok=$((cmp_ok + 1))
      else warn "    内容不一致：$rel"; cmp_bad=$((cmp_bad + 1))
      fi
    fi
  done
  printf '    逐字节比对：一致 %s 个，不一致 %s 个\n' "$cmp_ok" "$cmp_bad"
  [ "$cmp_bad" -eq 0 ]
}
_sha256_stdin() {
  case "$SHA_FLAVOR" in
    sha256sum) sha256sum | awk '{print $1}' ;;
    shasum)    shasum -a 256 | awk '{print $1}' ;;
    openssl)   openssl dgst -sha256 | awk '{print $NF}' ;;
    *) return 1 ;;
  esac
}

self_test() {
  SELF_FAIL=0
  local bk self st root arc arc2
  bk=$(_resolve_backup_script) || die "--self-test 需要 whale-backup.sh 在脚本同目录或 \$WHALE_ROOT/scripts 下" 2
  self="$SELF_PATH"
  [ -f "$self" ] || die "无法定位自身脚本路径：$self" 2
  _mk_tmp whale-selftest
  st="$MK_TMP_RESULT"
  root="$st/data"

  printf '===== whale-restore.sh --self-test =====\n'
  printf '演练目录: %s（退出时自动删除）\n' "$st"
  printf '备份脚本: %s\n' "$bk"
  printf '注意: 全部数据都在临时目录内，真实数据未被读写。\n\n'

  _selftest_fixture "$root"

  printf '[子测试 1] 备份\n'
  if WHALE_HOME="$root" WHALE_ROOT="$root/whale" DSH_HOME="$root/.dsh" WHALE_BACKUP_KEEP=9 \
       bash "$bk" > "$st/backup.log" 2>&1; then
    _self_assert "备份执行成功" 0
  else
    _self_assert "备份执行成功" 1; sed 's/^/      /' "$st/backup.log"
  fi
  arc=$(find "$root/whale/backups" -maxdepth 1 -type f -name 'whale-*.tar.gz' 2>"$NULL_DEV" | LC_ALL=C sort | tail -1) || arc=""
  if [ -n "$arc" ] && [ -f "$arc" ]; then
    _self_assert "生成归档文件（$(basename "$arc")）" 0
    _self_assert "生成清单文件" "$([ -f "$arc.manifest.txt" ] && echo 0 || echo 1)"
  else
    _self_assert "生成归档文件" 1
    printf '测试无法继续（没有归档）。\n'; return 1
  fi

  printf '\n[子测试 2] --dry-run 不写入任何文件\n'
  local drytarget="$st/dry-target"
  if bash "$self" "$arc" --target "$drytarget" --dry-run > "$st/dry.log" 2>&1; then
    _self_assert "--dry-run 正常退出" 0
  else
    _self_assert "--dry-run 正常退出" 1; sed 's/^/      /' "$st/dry.log"
  fi
  _self_assert "dry-run 未创建目标目录" "$([ -e "$drytarget" ] && echo 1 || echo 0)"
  _self_assert "dry-run 输出包含计划明细" "$(grep -q '将写入' "$st/dry.log" && echo 0 || echo 1)"

  printf '\n[子测试 3] 恢复到新目录并逐字节比对\n'
  local rtarget="$st/restore-plain"
  if bash "$self" "$arc" --target "$rtarget" > "$st/restore.log" 2>&1; then
    _self_assert "恢复执行成功" 0
  else
    _self_assert "恢复执行成功" 1; sed 's/^/      /' "$st/restore.log"
  fi
  if _selftest_compare "$root" "$rtarget"; then
    _self_assert "备份/恢复内容逐项一致" 0
  else
    _self_assert "备份/恢复内容逐项一致" 1
  fi
  # 关键：确认"逐文件 sha256 校验"真的校验到了文件（校验数必须 > 0），
  # 防止解析出错时静默跳过、却对外表现为"校验通过"。
  _self_assert "逐个文件的 sha256 校验确实执行（通过数 > 0）" \
    "$(grep -Eq '内容校验：通过 [1-9][0-9]* 个，不一致 0 个，缺失 0 个，无法解析 0 个' "$st/restore.log" && echo 0 || echo 1)"
  _self_assert "敏感文件权限为 600" \
    "$([ "$(_st_mode "$rtarget/.dsh/.credentials.yaml" 2>"$NULL_DEV")" = "600" ] && echo 0 || echo 1)"
  _self_assert "符号链接未被恢复（备份时已跳过）" "$([ -e "$rtarget/whale/data/link-out" ] && echo 1 || echo 0)"

  printf '\n[子测试 4] --no-secrets：凭据不落盘、字段被脱敏\n'
  local nstarget="$st/restore-nosecrets" nsrc="$st/data-ns"
  _selftest_fixture "$nsrc"
  if WHALE_HOME="$nsrc" WHALE_ROOT="$nsrc/whale" DSH_HOME="$nsrc/.dsh" \
       bash "$bk" --no-secrets > "$st/backup-ns.log" 2>&1; then
    _self_assert "脱敏备份执行成功" 0
  else
    _self_assert "脱敏备份执行成功" 1; sed 's/^/      /' "$st/backup-ns.log"
  fi
  arc2=$(find "$nsrc/whale/backups" -maxdepth 1 -type f -name 'whale-*.tar.gz' 2>"$NULL_DEV" | LC_ALL=C sort | tail -1) || arc2=""
  if [ -n "$arc2" ]; then
    if bash "$self" "$arc2" --target "$nstarget" > "$st/restore-ns.log" 2>&1; then
      _self_assert "脱敏备份可以正常恢复" 0
    else
      _self_assert "脱敏备份可以正常恢复" 1; sed 's/^/      /' "$st/restore-ns.log"
    fi
    _self_assert ".credentials.yaml 未被恢复" "$([ -e "$nstarget/.dsh/.credentials.yaml" ] && echo 1 || echo 0)"
    _self_assert "etc/ 目录未被恢复" "$([ -e "$nstarget/whale/etc" ] && echo 1 || echo 0)"
    _self_assert "profiles 中的凭据字段已脱敏" \
      "$(grep -q '已脱敏' "$nstarget/.dsh/profiles/web/cordis.patch.yml" 2>"$NULL_DEV" && echo 0 || echo 1)"
    _self_assert "profiles 中的非凭据字段仍保留" \
      "$(grep -q 'persona' "$nstarget/.dsh/profiles/web/cordis.patch.yml" 2>"$NULL_DEV" && echo 0 || echo 1)"
  else
    _self_assert "生成脱敏归档" 1
  fi

  printf '\n[子测试 5] 归档被篡改 → 清单 sha256 校验必须拦下\n'
  local bad="$st/tampered.tar.gz"
  cp "$arc" "$bad" && cp "$arc.manifest.txt" "$bad.manifest.txt"
  printf 'X' >> "$bad"
  if bash "$self" "$bad" --target "$st/restore-bad" --dry-run > "$st/bad.log" 2>&1; then
    _self_assert "篡改归档被拒绝" 1
  else
    _self_assert "篡改归档被拒绝" 0
    _self_assert "报错信息提到 sha256" "$(grep -qi 'sha256' "$st/bad.log" && echo 0 || echo 1)"
  fi
  _self_assert "被拒绝时未创建目标目录" "$([ -e "$st/restore-bad" ] && echo 1 || echo 0)"

  printf '\n[子测试 6] 路径穿越归档（../）必须被拒绝\n'
  if _have python3; then
    python3 - "$st/evil.tar.gz" <<'PY' >"$NULL_DEV" 2>&1 || true
import sys, tarfile, io, os
p = sys.argv[1]
with tarfile.open(p, "w:gz") as t:
    data = b"pwned\n"
    for name in ("../evil.txt", "/tmp/whale-evil-abs.txt", "dsh/../../evil2.txt"):
        ti = tarfile.TarInfo(name)
        ti.size = len(data)
        t.addfile(ti, io.BytesIO(data))
PY
    if [ -f "$st/evil.tar.gz" ]; then
      if bash "$self" "$st/evil.tar.gz" --target "$st/restore-evil" --dry-run > "$st/evil.log" 2>&1; then
        _self_assert "路径穿越归档被拒绝" 1
      else
        _self_assert "路径穿越归档被拒绝" 0
      fi
      _self_assert "穿越攻击未产生文件（\$TARGET 外）" \
        "$([ -e "$st/data/../evil.txt" ] || [ -e /tmp/whale-evil-abs.txt ] && echo 1 || echo 0)"
    else
      printf '  [跳过] 未能构造测试用恶意归档\n'
    fi
  else
    printf '  [跳过] 本机没有 python3，无法构造恶意归档用例\n'
  fi

  printf '\n===== 自测结果 =====\n'
  if [ "$SELF_FAIL" -eq 0 ]; then
    printf '全部子测试通过（%s）\n' "$st"
    return 0
  fi
  printf '有 %s 个子测试未通过，请检查上面的 FAIL 行。\n' "$SELF_FAIL"
  return 1
}

# ---------------------------------------------------------------------------
main() {
  umask 077
  parse_args "$@"
  _detect_platform
  if [ "$SHA_FLAVOR" = none ]; then die "缺少 sha256 工具：需要 sha256sum / shasum / openssl 之一" 2; fi
  _have tar || die "缺少必需命令：tar" 2

  if [ "$SELF_TEST" = 1 ]; then
    self_test
    DONE=1
    return 0
  fi
  run_restore
  DONE=1
}

main "$@"
