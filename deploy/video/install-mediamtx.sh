#!/usr/bin/env bash
# Installs the pinned MediaMTX release after checking its SHA-256.
# Usage: sudo deploy/video/install-mediamtx.sh [/opt/mediamtx]
set -euo pipefail
VERSION=v1.21.1
SHA256=6a3aa635fb60ea9b8d566ec306f0a42ff1b6b52a3942bc2baffbe55880d4c3dd   # mediamtx_v1.21.1_linux_arm64.tar.gz
prefix=${1:-/opt/mediamtx}
url="https://github.com/bluenviron/mediamtx/releases/download/${VERSION}/mediamtx_${VERSION}_linux_arm64.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/mediamtx.tar.gz" "$url"
echo "${SHA256}  $tmp/mediamtx.tar.gz" | sha256sum --check --quiet -
tar -xzf "$tmp/mediamtx.tar.gz" -C "$tmp" mediamtx LICENSE
install -d "$prefix"
install -m 0755 "$tmp/mediamtx" "$prefix/mediamtx"
install -m 0644 "$tmp/LICENSE" "$prefix/LICENSE"
echo "installed MediaMTX $("$prefix/mediamtx" --version) in $prefix"
