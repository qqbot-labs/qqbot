#!/bin/bash
set -euo pipefail
rm -f /opt/qq-agent/artifacts/runtime-proof.json
image=$(</opt/qq-agent/napcat-image.lock)
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
if docker container inspect qq-agent-napcat >/dev/null 2>&1; then
  # 只删除本服务退出的容器；运行中容器由 docker rm 拒绝，不强制停止。
  docker rm qq-agent-napcat >/dev/null
fi
# v4.6.7 在读取 napcat.json 前就创建日志；只用受限 tmpfs，绝不持久化或采集日志。
exec docker run --name qq-agent-napcat --init \
  --network host --user 19340:19340 --cap-drop ALL --security-opt no-new-privileges \
  --ulimit core=0:0 --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=192m,mode=1777 \
  --tmpfs /runtime/napcat/logs:rw,noexec,nosuid,nodev,size=8m,uid=19340,gid=19340,mode=0700 \
  --mount type=bind,src=/var/lib/qq-agent-napcat/home,dst=/home/qqruntime \
  --mount type=bind,src=/var/lib/qq-agent-napcat/config,dst=/runtime/napcat/config \
  --mount type=bind,src=/var/lib/qq-agent-napcat/cache,dst=/runtime/napcat/cache \
  --log-driver none "$image"
