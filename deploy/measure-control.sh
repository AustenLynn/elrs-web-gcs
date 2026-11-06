#!/usr/bin/env bash
# Deploy opt-in bench instrumentation. Does not arm or change failsafe settings.
set -euo pipefail

read_core_state() {
  timeout 5 /usr/local/bin/crsf-ctl -s /run/crsf-core/status.sock status
}

stop_disarmed_core() {
  # Prevent new pilot input, then recheck after the possibly lengthy backup.
  systemctl stop gcs-gateway
  local fresh
  if ! fresh=$(read_core_state); then
    systemctl start gcs-gateway
    echo 'Cannot verify core state; core left running.' >&2
    return 1
  fi
  case "$fresh" in
    DISARMED*) systemctl stop crsf-core ;;
    *) systemctl start gcs-gateway
       echo 'Core is no longer disarmed; deployment refused and gateway restored.' >&2
       return 1 ;;
  esac
}

main() {
repo=$(cd "$(dirname "$0")/.." && pwd)
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
state=$(read_core_state)
case "$state" in
  DISARMED*) ;;
  *) echo 'Refusing deployment: clear the failsafe and disarm first.' >&2; exit 1 ;;
esac
run=$(date -u +%Y%m%dT%H%M%SZ)
backup="/var/backups/gcs-measure-$run"
install -d -m 0700 "$backup"
cp -a /etc/gcs "$backup/etc-gcs"
cp -a /opt/gcs "$backup/opt-gcs"
install -d "$backup/bin"
for tool in crsf-core crsf-ctl crsf-probe crsf-param; do
  [[ ! -f "/usr/local/bin/$tool" ]] || cp -a "/usr/local/bin/$tool" "$backup/bin/"
done
echo "Backup: $backup"
stop_disarmed_core
trap 'echo "Deployment stopped. Inspect services before use. Backup: $backup" >&2' ERR
bash "$repo/deploy/install.sh"
core_dir="/var/log/crsf-core/measure-$run"
gateway_dir="/var/log/gcs-gateway/measure-$run"
install -d -o gcs -g gcs -m 0750 "$core_dir" "$gateway_dir"
python3 - "$core_dir" "$gateway_dir" <<'PY'
import json, re, sys
from pathlib import Path
core_dir, gateway_dir = sys.argv[1:]
p = Path('/etc/gcs/crsf-core.conf')
s = p.read_text()
for key, value in {'control_trace':'true', 'event_log':core_dir + '/core.jsonl',
                   'timing_log':core_dir + '/timing.csv'}.items():
    s = re.sub(r'^\s*' + key + r'\s*=.*\n?', '', s, flags=re.M)
    s = s.rstrip() + f'\n{key} = {value}\n'
p.write_text(s)
p = Path('/etc/gcs/gateway.json')
cfg = json.loads(p.read_text())
cfg.update(controlTrace=True, eventLog=gateway_dir + '/gateway.jsonl')
p.write_text(json.dumps(cfg, indent=2) + '\n')
PY
systemctl start crsf-core gcs-gateway
sleep 3
systemctl is-active crsf-core gcs-gateway
cmp "$repo/core/build/crsf-core" /usr/local/bin/crsf-core
cmp "$repo/gateway/src/hub.js" /opt/gcs/gateway/src/hub.js
curl -fk --max-time 10 -s -o /dev/null https://127.0.0.1:8443/
echo "Measurement run: $run"
echo "Core events: $core_dir/core.jsonl"
echo "Frame timing: $core_dir/timing.csv"
echo "Gateway events: $gateway_dir/gateway.jsonl"
echo 'Open the LOCAL pilot URL with ?measure. Use propellers-off bench testing.'
echo 'When finished, disable tracing as described in docs/procedures/software-measurements.md.'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
