#!/bin/bash
# Domain DNS is set through authorized MCP first. Provider recovery points confirmed by owner.
set -euo pipefail
[[ "${1:-}" == --owner-recovery-confirmed && $(id -u) == 0 ]] || exit 2
cd /opt/qq-agent
backup=/root/backups/qq-agent-domain-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$backup"
printf '%s\n' 'Owner confirmed complete provider recovery points and authorized autonomous project changes. This supplemental snapshot is project-only.' > "$backup/BASELINE.txt"
paths=(etc/nginx/conf.d/qq-agent-public.conf etc/systemd/system/qq-agent-console.service.d/public.conf opt/qq-agent/deploy)
for item in etc/nginx/conf.d/qq-agent-acme.conf etc/systemd/system/qq-agent-cert-renew.service etc/systemd/system/qq-agent-cert-renew.timer; do
 [[ ! -e /$item ]] || paths+=("$item")
done
tar --acls --xattrs -czf "$backup/config-before.tar.gz" -C / "${paths[@]}"
sha256sum "$backup/config-before.tar.gz" > "$backup/SHA256SUMS"
tar -tzf "$backup/config-before.tar.gz" >/dev/null
rollback() {
 systemctl stop qq-agent-console || true
 rm -f /etc/nginx/conf.d/qq-agent-acme.conf
 tar --acls --xattrs -xzf "$backup/config-before.tar.gz" -C /
 systemctl daemon-reload
 systemctl start qq-agent-console || true
 nginx -t && systemctl reload nginx || true
}
trap 'echo DOMAIN_APPLY_FAILED; rollback' ERR
install -d -m 0755 /var/lib/qq-agent-acme/.well-known/acme-challenge
cat > /etc/nginx/conf.d/qq-agent-acme.conf <<'NGINX'
server {
 listen 80;
 listen [::]:80;
 server_name qqbot.example.com;
 access_log off;
 location ^~ /.well-known/acme-challenge/ { root /var/lib/qq-agent-acme; }
 location / { return 404; }
}
NGINX
nginx -t
systemctl reload nginx
# Reuse the existing Let's Encrypt account; no new account, purchase or DNS changes.
account=$(python3 -c 'import configparser,pathlib;c=configparser.ConfigParser();c.read_string("[main]\n"+pathlib.Path("/etc/letsencrypt/renewal/whale.example.com.conf").read_text());print(c["renewalparams"]["account"])')
/snap/bin/certbot certonly --no-directory-hooks --webroot --webroot-path /var/lib/qq-agent-acme --cert-name qqbot.example.com -d qqbot.example.com --non-interactive --agree-tos --account "$account" --server https://acme-v02.api.letsencrypt.org/directory
install -m 0644 deploy/qq-agent-public.nginx.conf /etc/nginx/conf.d/qq-agent-public.conf
rm -f /etc/nginx/conf.d/qq-agent-acme.conf
printf '%s\n' '[Service]' 'Environment=QQAGENT_PUBLIC_ORIGIN=https://qqbot.example.com' > /etc/systemd/system/qq-agent-console.service.d/public.conf
systemctl stop qq-agent-console
/opt/qq-agent/.venv/bin/python -c 'import sqlite3;from pathlib import Path;p=Path("/var/lib/qq-agent/state.sqlite3");c=sqlite3.connect(p);c.execute("DELETE FROM sessions");c.commit();c.close()'
chown -R qqagent:qqagent /var/lib/qq-agent
nginx -t
systemctl daemon-reload
systemctl start qq-agent-console
ready=false
for attempt in {1..60}; do
 if curl -fsS http://127.0.0.1:13800/healthz >/dev/null 2>&1; then ready=true;break;fi
 sleep .2
done
[[ "$ready" == true ]]
systemctl reload nginx
ready=false
for attempt in {1..60}; do
 if curl -fsS https://qqbot.example.com/healthz >/dev/null 2>&1; then ready=true;break;fi
 sleep .2
done
[[ "$ready" == true ]]
install -m 0644 deploy/qq-agent-cert-renew.service /etc/systemd/system/qq-agent-cert-renew.service
install -m 0644 deploy/qq-agent-cert-renew.timer /etc/systemd/system/qq-agent-cert-renew.timer
systemctl daemon-reload
systemctl enable --now qq-agent-cert-renew.timer
printf '%s\n' "$backup" > /opt/qq-agent/last-domain-backup.path
trap - ERR
printf 'DOMAIN_APPLY_OK backup=%s\n' "$backup"
