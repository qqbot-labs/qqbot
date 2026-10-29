#!/bin/bash
set -euo pipefail
# Run only after a verified complete recovery point or the owner's explicit backup confirmation.
[[ "${QQAGENT_BASELINE_CONFIRMED:-}" == 20261020-owner-provider-backup ]] || { echo 'Missing full-server recovery baseline'; exit 1; }
[[ $(id -u) == 0 ]] || exit 1
getent passwd qqagent >/dev/null || useradd --system --home-dir /var/lib/qq-agent --shell /usr/sbin/nologin qqagent
install -d -m 0700 -o qqagent -g qqagent /var/lib/qq-agent
python3 -m venv /opt/qq-agent/.venv
/opt/qq-agent/.venv/bin/pip install --disable-pip-version-check -r /opt/qq-agent/requirements.lock.txt
chown -R root:root /opt/qq-agent
chmod 0755 /opt/qq-agent
install -m 0644 /opt/qq-agent/deploy/qq-agent-console.service /etc/systemd/system/qq-agent-console.service
systemctl daemon-reload
systemctl enable --now qq-agent-console.service
