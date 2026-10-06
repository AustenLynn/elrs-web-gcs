"""Run FakeTx as a process for the browser end-to-end test.

Prints one JSON line with the pty path, then the latest RC channels every 50 ms.
Reads commands on stdin: 'mode <text>' sets the flight-mode telemetry.
"""
import json
import sys
import threading
import time

from fake_tx import FakeTx

tx = FakeTx()
tx.link_lq = 95
tx.battery_dv = 165
tx.flight_mode = "ACRO*"
print(json.dumps({"path": tx.path}), flush=True)


def commands():
    for line in sys.stdin:
        parts = line.split(maxsplit=1)
        if len(parts) == 2 and parts[0] == "mode":
            tx.flight_mode = parts[1].strip()


threading.Thread(target=commands, daemon=True).start()
while True:
    print(json.dumps({"ch": tx.last_channels()}), flush=True)
    time.sleep(0.05)
