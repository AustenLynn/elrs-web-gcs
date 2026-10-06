#!/usr/bin/env bash
# Installs or updates crsf-core and the gateway on the Raspberry Pi. Safe to re-run.
# Usage (from the repository root):  sudo deploy/install.sh
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

echo "== service user"
id gcs >/dev/null 2>&1 || useradd --system --home-dir /var/lib/gcs --create-home --shell /usr/sbin/nologin gcs
usermod -aG dialout,video gcs

echo "== crsf-core"
sudo -u "${SUDO_USER:-root}" make -C "$repo/core" all     # build as you, not as root
make -C "$repo/core" install PREFIX=/usr/local

echo "== gateway and web app -> /opt/gcs"
install -d /opt/gcs
rsync -a --delete --exclude node_modules "$repo/gateway/" /opt/gcs/gateway/
rsync -a --delete "$repo/web/" /opt/gcs/web/
rsync -a --delete "$repo/docs/" /opt/gcs/docs/
(cd /opt/gcs/gateway && npm ci --omit=dev --no-audit --no-fund)

echo "== configuration (existing files are kept)"
install -d -m 0755 /etc/gcs
[[ -f /etc/gcs/crsf-core.conf ]] || install -m 0644 "$repo/deploy/crsf-core.conf" /etc/gcs/
[[ -f /etc/gcs/gateway.json ]] || install -m 0644 "$repo/deploy/gateway.json" /etc/gcs/
[[ -f /etc/gcs/tls/cert.pem ]] || "$repo/deploy/make-cert.sh" /etc/gcs/tls

echo "== systemd units"
install -m 0644 "$repo/deploy/crsf-core.service" "$repo/deploy/gcs-gateway.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable crsf-core.service gcs-gateway.service
echo "installed. start with: sudo systemctl restart crsf-core gcs-gateway"
