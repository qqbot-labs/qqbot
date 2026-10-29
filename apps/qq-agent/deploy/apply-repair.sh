#!/bin/bash
# Applies one bounded project batch after the owner's complete recovery point confirmation.
set -euo pipefail
[[ "${1:-}" == --owner-recovery-confirmed ]] || exit 2
[[ $(id -u) == 0 ]] || exit 2
cd /opt/qq-agent
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir=/root/backups/qq-agent-repair-$stamp
install -d -m 0700 "$backup_dir"
printf '%s\n' 'Owner confirmed complete recovery points on 2026-10-20 Asia/Shanghai and authorized autonomous continuation. Provider restore was not independently tested by agent. This project snapshot supplements that baseline.' > "$backup_dir/BASELINE.txt"
# Stop project control loop only; no airport, firewall, reverse proxy or unrelated service changes.
systemctl stop qq-agent-console.service qq-agent-qzone.service
rollback() {
  systemctl stop qq-agent-console.service qq-agent-qzone.service 2>/dev/null || true
  tar --acls --xattrs -xzf "$backup_dir/project-before.tar.gz" -C /
  systemctl daemon-reload
  systemctl start qq-agent-console.service qq-agent-qzone.service || true
}
trap 'printf "PROJECT_APPLY_FAILED line=%s\n" "$LINENO"; rollback' ERR
items=(opt/qq-agent/qqagent opt/qq-agent/deploy opt/qq-agent/scripts opt/qq-agent/docs opt/qq-agent/tests opt/qq-agent/README.md opt/qq-agent/AGENTS.md opt/qq-agent/bridge opt/qq-agent/requirements.lock.txt opt/qq-agent/pyproject.toml opt/qq-agent/uv.lock var/lib/qq-agent var/lib/qq-agent-qzone etc/systemd/system/qq-agent-console.service etc/systemd/system/qq-agent-qzone.service etc/systemd/system/qq-agent-napcat.service)
existing=()
for item in "${items[@]}"; do [[ ! -e /$item ]] || existing+=("$item"); done
tar --acls --xattrs -czf "$backup_dir/project-before.tar.gz" -C / "${existing[@]}"
sha256sum "$backup_dir/project-before.tar.gz" > "$backup_dir/SHA256SUMS"
tar -tzf "$backup_dir/project-before.tar.gz" > /dev/null
stage=/opt/qq-agent/repair-incoming
# 清除上次残留的暂存副本，避免 pytest 收集到重复测试模块。
rm -rf "$stage"
mkdir -p "$stage"
tar -xzf /opt/qq-agent/repair-source.tar.gz -C "$stage"
cp -a "$stage"/qqagent "$stage"/deploy "$stage"/scripts "$stage"/docs "$stage"/tests "$stage"/bridge /opt/qq-agent/
cp "$stage"/README.md "$stage"/AGENTS.md "$stage"/requirements.lock.txt "$stage"/pyproject.toml "$stage"/uv.lock /opt/qq-agent/
rm -rf "$stage"
chown -R root:root /opt/qq-agent/qqagent /opt/qq-agent/deploy /opt/qq-agent/scripts /opt/qq-agent/docs /opt/qq-agent/tests /opt/qq-agent/bridge
# Source files contain no credentials and must be readable by the service accounts.
chmod -R a+rX /opt/qq-agent/qqagent /opt/qq-agent/deploy /opt/qq-agent/scripts /opt/qq-agent/docs /opt/qq-agent/tests /opt/qq-agent/bridge
# A project-private null device avoids the host's root-only /dev/null without changing it.
install -d -m 0755 -o root -g root /var/lib/qq-agent-dev
if [[ ! -e /var/lib/qq-agent-dev/null ]]; then mknod -m 0666 /var/lib/qq-agent-dev/null c 1 3; fi
[[ $(stat -c '%t:%T' /var/lib/qq-agent-dev/null) == 1:3 ]] || false
chmod 0666 /var/lib/qq-agent-dev/null
# Runtime dependencies unchanged; do not upgrade packages or install host libraries.
PLAYWRIGHT_BROWSERS_PATH=/opt/qq-agent/browsers node deploy/qzone-browser.mjs --write-lock
chmod 0644 /opt/qq-agent/bridge/browser.lock.json
install -m 0644 deploy/qq-agent-qzone.service /etc/systemd/system/qq-agent-qzone.service
install -m 0644 deploy/qq-agent-napcat.service /etc/systemd/system/qq-agent-napcat.service
systemctl daemon-reload
systemctl start qq-agent-console.service qq-agent-qzone.service
ready=false
for attempt in {1..50}; do
  if curl -fsS http://127.0.0.1:13800/healthz > /dev/null 2>&1; then ready=true; break; fi
  sleep 0.2
done
[[ "$ready" == true ]] || false
qzone_ready=false
for attempt in {1..60}; do
  if systemctl is-active --quiet qq-agent-qzone.service && curl -s -o /dev/null http://127.0.0.1:13702/health; then qzone_ready=true; break; fi
  sleep 0.2
done
[[ "$qzone_ready" == true ]] || false
trap - ERR
printf '%s\n' "$backup_dir" > /opt/qq-agent/last-repair-backup.path
printf 'PROJECT_APPLY_OK backup=%s\n' "$backup_dir"
