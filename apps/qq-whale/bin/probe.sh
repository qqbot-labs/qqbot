#!/bin/sh
R=/home/qqwhale/whale/data/probe-result.txt
{
echo "== system 单元沙箱实证 =="
echo "运行身份: $(id -un) uid=$(id -u)"
echo "-- 私有 /tmp --"
awk '$5=="/tmp"{print "  /tmp 是独立挂载 ✓"} /proc/self/mountinfo' /proc/self/mountinfo 2>/dev/null | head -1
grep -q " /tmp " /proc/self/mountinfo && echo "  /tmp 出现在 mountinfo" || echo "  /tmp 未单独挂载"
echo "-- 可写性 --"
for p in /etc/whale-probe /usr/whale-probe /home/qqwhale/probe /home/qqwhale/whale/logs/probe /home/qqwhale/whale/data/probe /home/qqwhale/whale/workspace/probe; do
  if touch "$p" 2>&1; then echo "  可写: $p"; rm -f "$p"; else echo "  只读: $p"; fi
done
echo "-- /dev 内容（PrivateDevices 生效则极少）--"
ls /dev 2>&1 | tr '\n' ' ' | head -c 300; echo
echo "-- capability --"
grep -E "^Cap(Eff|Bnd)" /proc/self/status
} > "$R" 2>&1
