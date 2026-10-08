#!/usr/bin/env bash
# Installs or updates crsf-core and the gateway on the Raspberry Pi. Safe to re-run.
# Usage (from the repository root):  sudo deploy/install.sh
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

echo "== service users"
id gcs >/dev/null 2>&1 || useradd --system --home-dir /var/lib/gcs --create-home --shell /usr/sbin/nologin gcs
usermod -aG dialout gcs
id gcs-video >/dev/null 2>&1 || useradd --system --home-dir /var/lib/gcs-video --create-home --shell /usr/sbin/nologin gcs-video
usermod -aG video gcs-video
# the operator who runs the installer may use crsf-ctl (the sockets belong to group gcs);
# takes effect at their next login
[[ -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]] && usermod -aG gcs "$SUDO_USER"

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

echo "== video: MediaMTX + capture script"
[[ -x /opt/mediamtx/mediamtx ]] || "$repo/deploy/video/install-mediamtx.sh"
install -d /opt/gcs/video
install -m 0755 "$repo/deploy/video/capture.sh" /opt/gcs/video/
[[ -f /etc/gcs/mediamtx.yml ]] || install -m 0644 "$repo/deploy/video/mediamtx.yml" /etc/gcs/
grep -q '^api: true' /etc/gcs/mediamtx.yml && echo "WARNING: /etc/gcs/mediamtx.yml has the MediaMTX API on; set 'api: false' (see deploy/video/mediamtx.yml)" 
[[ -f /etc/gcs/video.env ]] || install -m 0644 "$repo/deploy/video/video.env" /etc/gcs/

echo "== systemd units"
install -m 0644 "$repo/deploy/crsf-core.service" "$repo/deploy/gcs-gateway.service" "$repo/deploy/gcs-video.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable crsf-core.service gcs-gateway.service gcs-video.service
echo "installed. start with: sudo systemctl restart crsf-core gcs-gateway gcs-video"
