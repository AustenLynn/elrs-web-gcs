#!/usr/bin/env bash
# Self-signed TLS certificate for the gateway. Each browser asks once to trust it.
# Usage: sudo deploy/make-cert.sh [/etc/gcs/tls]
set -euo pipefail
dir=${1:-/etc/gcs/tls}
mkdir -p "$dir"
host=$(hostname)
san="DNS:${host},DNS:${host}.local,DNS:localhost,IP:127.0.0.1"
for ip in $(hostname -I); do
  san+=",IP:${ip}"
done
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 825 \
  -subj "/CN=${host}.local" -addext "subjectAltName=${san}" \
  -keyout "$dir/key.pem" -out "$dir/cert.pem" 2>/dev/null
chmod 644 "$dir/cert.pem"
chmod 640 "$dir/key.pem"
chgrp gcs "$dir/key.pem" 2>/dev/null || echo "note: group gcs does not exist yet; run install.sh first"
echo "certificate valid for: ${san}"
