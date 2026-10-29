#!/bin/bash
set -euo pipefail
[[ "${1:-}" == --apply-after-full-backup ]] || { echo '先完成本批整机恢复点；使用 --apply-after-full-backup 才执行'; exit 1; }
[[ $(id -u) == 0 ]] || exit 1
install -d -m 0755 -o root -g root /var/lib/qq-agent-dev
if [[ ! -e /var/lib/qq-agent-dev/null ]]; then mknod -m 0666 /var/lib/qq-agent-dev/null c 1 3; fi
[[ $(stat -c '%t:%T' /var/lib/qq-agent-dev/null) == 1:3 ]] || exit 1
getent passwd qqagent-qzone >/dev/null || useradd --system --home-dir /var/lib/qq-agent-qzone --shell /usr/sbin/nologin qqagent-qzone
install -d -m 0700 -o qqagent-qzone -g qqagent-qzone /var/lib/qq-agent-qzone
install -d -m 0750 -o root -g qqagent-qzone /etc/qq-agent
if [[ ! -f /etc/qq-agent/qzone-token ]]; then python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > /etc/qq-agent/qzone-token; fi
chown root:qqagent-qzone /etc/qq-agent/qzone-token
chmod 0640 /etc/qq-agent/qzone-token
cd /opt/qq-agent
npm ci --omit=dev --ignore-scripts --prefix vendor/onebot-qzone > /opt/qq-agent/qzone-install.log 2>&1
ln -sfn vendor/onebot-qzone/node_modules node_modules
PLAYWRIGHT_BROWSERS_PATH=/opt/qq-agent/browsers vendor/onebot-qzone/node_modules/.bin/playwright install chromium > /opt/qq-agent/qzone-browser-install.log 2>&1
chmod -R a+rX /opt/qq-agent/browsers
PLAYWRIGHT_BROWSERS_PATH=/opt/qq-agent/browsers node deploy/qzone-browser.mjs --write-lock
# Match the actual login executable; do not confuse full Chrome with headless-shell dependencies.
systemd-run --unit=qq-agent-qzone-preflight --wait --pipe --collect -p User=qqagent-qzone -p Group=qqagent-qzone -p PrivateDevices=yes -p BindPaths=/var/lib/qq-agent-dev/null:/dev/null -p WorkingDirectory=/opt/qq-agent/bridge --setenv=HOME=/var/lib/qq-agent-qzone --setenv=PLAYWRIGHT_BROWSERS_PATH=/opt/qq-agent/browsers /usr/bin/node /opt/qq-agent/deploy/qzone-browser.mjs
# Installation never starts account login, generates QR codes or enables social actions.
install -m 0644 deploy/qq-agent-qzone.service /etc/systemd/system/qq-agent-qzone.service
/opt/qq-agent/.venv/bin/python - <<'PY'
import sys
sys.path.insert(0,'/opt/qq-agent')
from qqagent.store import Store
s=Store('/var/lib/qq-agent');s.put_secret('qzone_token',open('/etc/qq-agent/qzone-token').read().strip())
PY
chown -R qqagent:qqagent /var/lib/qq-agent
systemctl daemon-reload
echo '空间桥接已准备；未自动启动/启用。完成验收后显式启动。'
