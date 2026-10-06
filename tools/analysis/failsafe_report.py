#!/usr/bin/env python3
"""Criterion C3 (failsafe < 1 s) from crsf-core's event log and the fault log.

    failsafe_report.py events.jsonl [--faults faults.jsonl] [--budget-ms 1000]

For every switch to FAILSAFE it reports:
  start      when the link was lost: the injected fault (fault.py) if one happened in the
             10 s before, otherwise the last fresh pilot command (t - cmd_age_ms)
  detect_ms  start -> core switched to FAILSAFE (the FAILSAFE channel goes out in the
             same frame, so add at most one frame period for "on the air")
  fc_ms      start -> Betaflight reported "!FS!" in flight-mode telemetry (upper bound:
             includes telemetry delay); "-" if no telemetry arrived within 5 s
Exit status: 0 all within budget, 1 some over budget or none found, 2 unusable input.
"""
import argparse
import json
import sys

FAULT_WINDOW_NS = 10_000_000_000
FC_WINDOW_NS = 5_000_000_000


def load_jsonl(path):
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue          # a line cut short by a crash or power loss
    return out


def analyse(events, faults, budget_ms):
    transitions = [e for e in events if e.get("ev") == "state" and e.get("to") == "FAILSAFE"]
    modes = sorted((e for e in events if e.get("ev") == "flight_mode"), key=lambda e: e["t_ns"])
    faults = sorted(faults, key=lambda f: f["t_ns"])
    used = set()
    rows = []
    for tr in sorted(transitions, key=lambda e: e["t_ns"]):
        t = tr["t_ns"]
        fault = None
        for i, f in enumerate(faults):
            if i not in used and 0 <= t - f["t_ns"] <= FAULT_WINDOW_NS:
                fault = (i, f)
        if fault is not None:
            used.add(fault[0])
            start, cause = fault[1]["t_ns"], fault[1]["action"]
        elif tr.get("cmd_age_ms", -1) >= 0:
            start, cause = t - tr["cmd_age_ms"] * 1_000_000, "last command"
        else:
            start, cause = None, "unknown"
        fc = next((m for m in modes if 0 <= m["t_ns"] - t <= FC_WINDOW_NS and "!FS!" in m.get("mode", "")), None)
        detect = (t - start) / 1e6 if start is not None else None
        rows.append({
            "t_ns": t, "reason": tr.get("reason"), "cause": cause, "detect_ms": detect,
            "fc_ms": (fc["t_ns"] - start) / 1e6 if fc is not None and start is not None else None,
            "ok": detect is not None and detect <= budget_ms,
        })
    return rows


def format_report(rows, budget_ms):
    if not rows:
        return "no FAILSAFE transitions found\nRESULT: FAIL"
    lines = ["%-4s %-16s %-14s %10s %10s  %s" % ("#", "reason", "lost at", "detect_ms", "fc_ms", "ok")]
    for i, r in enumerate(rows, 1):
        lines.append("%-4d %-16s %-14s %10s %10s  %s" % (
            i, r["reason"], r["cause"],
            "-" if r["detect_ms"] is None else "%.0f" % r["detect_ms"],
            "-" if r["fc_ms"] is None else "%.0f" % r["fc_ms"],
            "yes" if r["ok"] else "NO"))
    known = [r["detect_ms"] for r in rows if r["detect_ms"] is not None]
    if known:
        lines.append("detection: max %.0f ms, mean %.0f ms over %d events (budget %.0f ms)"
                     % (max(known), sum(known) / len(known), len(known), budget_ms))
    lines.append("RESULT: %s" % ("PASS" if all(r["ok"] for r in rows) else "FAIL"))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("events")
    ap.add_argument("--faults")
    ap.add_argument("--budget-ms", type=float, default=1000.0)
    args = ap.parse_args(argv)
    try:
        events = load_jsonl(args.events)
        faults = load_jsonl(args.faults) if args.faults else []
    except OSError as err:
        print("failsafe_report: %s" % err, file=sys.stderr)
        return 2
    rows = analyse(events, faults, args.budget_ms)
    print(format_report(rows, args.budget_ms))
    return 0 if rows and all(r["ok"] for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
