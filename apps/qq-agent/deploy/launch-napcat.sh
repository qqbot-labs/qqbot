#!/bin/sh
set -eu
# 验证失败不启动任何 QQ 进程；PYTHONDONTWRITEBYTECODE 保持 rootfs 只读。
export PYTHONDONTWRITEBYTECODE=1
python3 /runtime/setup-qq.py --preflight
ulimit -c 0
# 子进程继承，不改宿主机 core_pattern。
if [ -w /proc/self/coredump_filter ]; then
  printf '0\n' > /proc/self/coredump_filter
fi

xvfb_pid=''
qq_pid=''
cleanup() {
  trap - EXIT INT TERM
  if [ -n "$qq_pid" ]; then
    kill "$qq_pid" 2>/dev/null || :
    wait "$qq_pid" 2>/dev/null || :
  fi
  if [ -n "$xvfb_pid" ]; then
    kill "$xvfb_pid" 2>/dev/null || :
    wait "$xvfb_pid" 2>/dev/null || :
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

Xvfb :99 -screen 0 1280x720x24 -nolisten tcp -ac >/dev/null 2>&1 &
xvfb_pid=$!
export DISPLAY=:99
ready=false
for i in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    printf '%s\n' 'QQAGENT_BOOTSTRAP XVFB_EXITED' >&2
    exit 1
  fi
  if [ -S /tmp/.X11-unix/X99 ]; then
    ready=true
    break
  fi
  sleep 0.2
done
if [ "$ready" != true ]; then
  printf '%s\n' 'QQAGENT_BOOTSTRAP XVFB_NOT_READY' >&2
  exit 1
fi

# 与官方 Shell 启动工作目录一致。禁止把原始 token、二维码或异常输出到日志。
cd /runtime/napcat
/runtime/qq/opt/QQ/qq --no-sandbox >/dev/null 2>&1 &
qq_pid=$!
status=0
wait "$qq_pid" || status=$?
qq_pid=''
if [ "$status" = 0 ]; then
  python3 /runtime/setup-qq.py --supervise-qq
fi
exit "$status"
