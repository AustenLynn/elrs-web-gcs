"""Run FakeTx as a process for the browser end-to-end test.

Prints one JSON line with the pty path, then the latest RC channels every 50 ms.
Reads commands on stdin: 'mode <text>' sets repeated telemetry; 'mode' stops it.
'mode_once <text>' sends one actual mode frame; 'link [lq]' sets/stops RF reports.
"""
import json
import sys
import threading
import time

from fake_tx import FakeTx, frame

tx = FakeTx()
tx.link_lq = 95
tx.battery_dv = 165
tx.flight_mode = "ACRO*"
print(json.dumps({"path": tx.path}), flush=True)


def commands():
    for line in sys.stdin:
        parts = line.split(maxsplit=1)
        if parts and parts[0] == "mode":
            tx.flight_mode = parts[1].strip() if len(parts) == 2 else None
        elif parts and parts[0] == "mode_once" and len(parts) == 2:
            tx._send(frame(0xEA, [0x21] + list(parts[1].strip().encode()) + [0]))
        elif parts and parts[0] == "link":
            tx.link_lq = int(parts[1]) if len(parts) == 2 else None


threading.Thread(target=commands, daemon=True).start()
while True:
    print(json.dumps({"ch": tx.last_channels()}), flush=True)
    time.sleep(0.05)
