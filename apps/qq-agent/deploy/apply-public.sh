#!/bin/bash
# Credential hash JSON is read on stdin; plaintext passwords never enter this script.
set -euo pipefail
[[ "${1:-}" == --owner-recovery-confirmed && $(id -u) == 0 ]] || exit 2
cd /opt/qq-agent
stage=/opt/qq-agent/public-incoming
backup_dir=/root/backups/qq-agent-public-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$backup_dir"
printf '%s\n' 'Owner confirmed complete provider recovery points and authorized autonomous changes. Public HTTPS and password change requested. Project snapshot is supplemental, not full-server backup.' > "$backup_dir/BASELINE.txt"
paths=(opt/qq-agent/qqagent opt/qq-agent/deploy opt/qq-agent/tests opt/qq-agent/docs opt/qq-agent/README.md var/lib/qq-agent)
new_public=/etc/nginx/conf.d/qq-agent-public.conf
new_env=/etc/systemd/system/qq-agent-console.service.d/public.conf
had_public=false;had_env=false
if [[ -e "$new_public" ]]; then had_public=true;paths+=(etc/nginx/conf.d/qq-agent-public.conf);fi
if [[ -e "$new_env" ]]; then had_env=true;paths+=(etc/systemd/system/qq-agent-console.service.d/public.conf);fi
systemctl stop qq-agent-console
# Snapshot SQLite and its WAL together while the sole writer is stopped.
tar --acls --xattrs -czf "$backup_dir/project-before.tar.gz" -C / "${paths[@]}"
sha256sum "$backup_dir/project-before.tar.gz" > "$backup_dir/SHA256SUMS"
tar -tzf "$backup_dir/project-before.tar.gz" >/dev/null
rollback() {
  systemctl stop qq-agent-console || true
  [[ "$had_public" == true ]] || rm -f "$new_public"
  [[ "$had_env" == true ]] || rm -f "$new_env"
  tar --acls --xattrs -xzf "$backup_dir/project-before.tar.gz" -C /
  systemctl daemon-reload
  systemctl start qq-agent-console || true
  nginx -t && systemctl reload nginx || true
}
trap 'echo PUBLIC_APPLY_FAILED; rollback' ERR
install -m 0644 "$stage/app.py" qqagent/app.py
install -m 0644 "$stage/test_public_console.py" tests/test_public_console.py
origin=${QQAGENT_PUBLIC_ORIGIN:-https://YOUR_VPS_IP:13843}
case "$origin" in
 https://YOUR_VPS_IP:13843) nginx_source=qq-agent-public-ip.nginx.conf ;;
 https://qqbot.example.com) nginx_source=qq-agent-public.nginx.conf ;;
 *) false ;;
esac
install -m 0644 "$stage/$nginx_source" "$new_public"
install -d -m 0755 /etc/systemd/system/qq-agent-console.service.d
printf '%s\n' '[Service]' "Environment=QQAGENT_PUBLIC_ORIGIN=$origin" > "$new_env"
chmod 0644 "$new_env"
# 暂存副本只用于本批安装；保留会被 pytest 当作重复测试模块收集。
rm -rf "$stage"
# Only scrypt salt/hash crosses SSH. Invalidate every previous admin session.
/opt/qq-agent/.venv/bin/python -c '
import json,sys,re
from pathlib import Path
from qqagent.store import Store,js
credential=json.load(sys.stdin)
assert set(credential)=={"salt","hash"}
assert re.fullmatch("[a-f0-9]{32}",credential["salt"])
assert re.fullmatch("[a-f0-9]{128}",credential["hash"])
s=Store("/var/lib/qq-agent")
with s.db() as c:
 c.execute("UPDATE meta SET v=? WHERE k=?",(js(credential),"password_hash"))
 c.execute("DELETE FROM sessions")
Path("/var/lib/qq-agent/admin-password.txt").unlink(missing_ok=True)
s.control(stop=True,pause=True,running=False)
print("ADMIN_HASH_UPDATED_SESSIONS_INVALIDATED")
'
chown -R qqagent:qqagent /var/lib/qq-agent
nginx -t
systemctl daemon-reload
systemctl start qq-agent-console
ready=false
for attempt in {1..50}; do
 if curl -fsS http://127.0.0.1:13800/healthz >/dev/null 2>&1; then ready=true;break;fi
 sleep .2
done
[[ "$ready" == true ]]
systemctl reload nginx
case "$origin" in
 https://YOUR_VPS_IP:13843) connect=YOUR_VPS_IP:13843:127.0.0.1:13843 ;;
 https://qqbot.example.com) connect=qqbot.example.com:443:127.0.0.1:443 ;;
esac
public_ready=false
for attempt in {1..50}; do
 if curl -fsS --connect-to "$connect" "$origin/healthz" >/dev/null 2>&1; then public_ready=true;break;fi
 sleep .2
done
[[ "$public_ready" == true ]]
printf '%s\n' "$backup_dir" > /opt/qq-agent/last-public-backup.path
trap - ERR
printf 'PUBLIC_APPLY_OK backup=%s\n' "$backup_dir"
