#!/usr/bin/env python3
"""Inject link faults for the C3 failsafe tests, logging when each one starts.

    sudo fault.py block-pilot [--seconds 5] [--port 8443]   silent Wi-Fi loss, pilot <-> Pi
    sudo fault.py kill-gateway                               gateway process dies

Each fault appends {"t_ns": CLOCK_MONOTONIC ns, "action": ...} to --log. crsf-core's
events.jsonl uses the same clock, so failsafe_report.py --faults measures the real
detection time from the moment of the fault.
"""
import argparse
import json
import subprocess
import sys
import time

TABLE = "gcs_fault"


def run(cmd):
    subprocess.run(cmd, check=True)


def log(path, action, **extra):
    with open(path, "a") as f:
        f.write(json.dumps({"t_ns": time.monotonic_ns(), "action": action, **extra}) + "\n")


def block_pilot(seconds, port, log_path, runner=run, sleep=time.sleep):
    """Drop all incoming packets to the gateway port: the TCP connection stays 'open' but
    nothing arrives, exactly like a phone that walked out of Wi-Fi range."""
    runner(["nft", "add", "table", "inet", TABLE])
    try:
        runner(["nft", "add", "chain", "inet", TABLE, "input", "{ type filter hook input priority -10 ; }"])
        runner(["nft", "add", "rule", "inet", TABLE, "input", "tcp", "dport", str(port), "drop"])
        log(log_path, "block_pilot", seconds=seconds, port=port)
        sleep(seconds)
    finally:
        runner(["nft", "delete", "table", "inet", TABLE])


def kill_gateway(log_path, runner=run):
    log(log_path, "kill_gateway")
    runner(["systemctl", "kill", "--signal=SIGKILL", "gcs-gateway.service"])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--log", default="/var/log/crsf-core/faults.jsonl")
    sub = ap.add_subparsers(dest="cmd", required=True)
    bp = sub.add_parser("block-pilot")
    bp.add_argument("--seconds", type=float, default=5.0)
    bp.add_argument("--port", type=int, default=8443)
    sub.add_parser("kill-gateway")
    args = ap.parse_args(argv)
    if args.cmd == "block-pilot":
        block_pilot(args.seconds, args.port, args.log)
    else:
        kill_gateway(args.log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
