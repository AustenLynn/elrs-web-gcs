#!/usr/bin/env python3
"""Criterion C3 (failsafe < 1 s) from crsf-core's event log and the fault log.

    failsafe_report.py events.jsonl [--faults faults.jsonl] [--since 2026-10-20T15:00] [--no-fc]

For every switch to FAILSAFE it reports:
  start      when the link was lost: the injected fault (fault.py) if one happened in the
             10 s before, otherwise the last fresh pilot command (t - cmd_age_ms)
  detect_ms  start -> core switched to FAILSAFE (the FAILSAFE channel goes out in the
             same frame, so add at most one frame period for "on the air")
  fc_ms      start -> Betaflight reported "!FS!" in flight-mode telemetry (upper bound:
             includes telemetry delay); "-" if no telemetry arrived within 5 s
Every injected fault is listed; one with no FAILSAFE within 10 s fails the run. Manual
failsafes are listed but not judged. Use --since (UTC) to analyse one campaign: both logs
keep earlier campaigns and earlier boots.
Exit status: 0 PASS (every fault and link failsafe within budget and confirmed by
Betaflight, or core-only with --no-fc), 1 FAIL, 2 unusable input.
"""
import argparse
import datetime
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


def wall_s(entry):
    """Wall time (seconds) of an entry logged in crsf-core's UTC format, or None."""
    w = entry.get("wall")
    if not w:
        return None
    try:
        return datetime.datetime.strptime(w, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.timezone.utc).timestamp()
    except ValueError:
        return None


def since(entries, start):
    """Keep entries logged at or after `start` (UTC, ISO, e.g. 2026-10-20T15:00)."""
    return [e for e in entries if e.get("wall", "") >= start]


def same_run(fault, transition):
    """Both clocks must agree: CLOCK_MONOTONIC restarts at boot, so a fault from an earlier
    boot can have a nearby t_ns; its wall time gives it away."""
    a, b = wall_s(fault), wall_s(transition)
    return a is None or b is None or -1.0 <= b - a <= FAULT_WINDOW_NS / 1e9 + 1.0


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
            if i not in used and 0 <= t - f["t_ns"] <= FAULT_WINDOW_NS and same_run(f, tr):
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
        manual = tr.get("reason") == "manual"        # the pilot pressed FAILSAFE: not a link failure
        rows.append({
            "t_ns": t, "wall": tr.get("wall", ""), "reason": tr.get("reason"), "cause": cause, "detect_ms": detect,
            "fc_ms": (fc["t_ns"] - start) / 1e6 if fc is not None and start is not None else None,
            "ok": None if manual else detect is not None and detect <= budget_ms,
            "note": "manual: not judged" if manual else "",
        })
    # A fault the core never reacted to is the failure C3 exists to catch: report it.
    for i, f in enumerate(faults):
        if i not in used:
            rows.append({"t_ns": f["t_ns"], "wall": f.get("wall", ""), "reason": "-", "cause": f["action"],
                         "detect_ms": None, "fc_ms": None, "ok": False, "note": "no FAILSAFE within 10 s"})
    rows.sort(key=lambda r: r["t_ns"])
    rows_faults = len(faults)
    for r in rows:
        r["faults_total"], r["faults_matched"] = rows_faults, len(used)
    return rows


def verdict(rows, require_fc=True):
    judged = [r for r in rows if r["ok"] is not None]
    if not judged:
        return "FAIL (no link failures to judge)"
    if not all(r["ok"] for r in judged):
        return "FAIL"
    confirmed = sum(1 for r in judged if r["fc_ms"] is not None)
    if confirmed < len(judged):
        if require_fc:
            return "FAIL (Betaflight did not confirm !FS! for %d of %d)" % (len(judged) - confirmed, len(judged))
        return "PASS (core only: Betaflight confirmed %d of %d)" % (confirmed, len(judged))
    return "PASS"


def format_report(rows, budget_ms, require_fc=True):
    if not rows:
        return "no FAILSAFE transitions found\nRESULT: FAIL"
    lines = ["%-4s %-23s %-16s %-14s %10s %10s  %-4s %s" % ("#", "wall (UTC)", "reason", "lost at", "detect_ms", "fc_ms", "ok", "")]
    for i, r in enumerate(rows, 1):
        lines.append("%-4d %-23s %-16s %-14s %10s %10s  %-4s %s" % (
            i, r["wall"] or "-", r["reason"], r["cause"],
            "-" if r["detect_ms"] is None else "%.0f" % r["detect_ms"],
            "-" if r["fc_ms"] is None else "%.0f" % r["fc_ms"],
            "-" if r["ok"] is None else "yes" if r["ok"] else "NO", r["note"]))
    judged = [r for r in rows if r["ok"] is not None]
    lines.append("faults: %d injected, %d matched" % (rows[0]["faults_total"], rows[0]["faults_matched"]))
    lines.append("FC confirmed %d/%d" % (sum(1 for r in judged if r["fc_ms"] is not None), len(judged)))
    lines.append("by reason:")
    for key in sorted({(r["reason"], r["cause"]) for r in judged}):
        group = [r for r in judged if (r["reason"], r["cause"]) == key and r["detect_ms"] is not None]
        fcs = [r["fc_ms"] for r in group if r["fc_ms"] is not None]
        n = sum(1 for r in judged if (r["reason"], r["cause"]) == key)
        if group:
            d = [r["detect_ms"] for r in group]
            lines.append("  %-16s %-14s n=%-3d detect max %.0f mean %.0f ms, fc max %s ms" % (
                key[0], key[1], n, max(d), sum(d) / len(d), "%.0f" % max(fcs) if fcs else "-"))
        else:
            lines.append("  %-16s %-14s n=%-3d no FAILSAFE" % (key[0], key[1], n))
    lines.append("budget %.0f ms" % budget_ms)
    lines.append("RESULT: %s" % verdict(rows, require_fc))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("events")
    ap.add_argument("--faults")
    ap.add_argument("--budget-ms", type=float, default=1000.0)
    ap.add_argument("--since", help="only entries logged at or after this UTC time, e.g. 2026-10-20T15:00 "
                                    "(both logs keep earlier campaigns and earlier boots)")
    ap.add_argument("--no-fc", action="store_true",
                    help="accept a core-only result when Betaflight's !FS! telemetry is not available")
    args = ap.parse_args(argv)
    try:
        events = load_jsonl(args.events)
        faults = load_jsonl(args.faults) if args.faults else []
    except OSError as err:
        print("failsafe_report: %s" % err, file=sys.stderr)
        return 2
    if args.since:
        events, faults = since(events, args.since), since(faults, args.since)
    rows = analyse(events, faults, args.budget_ms)
    print(format_report(rows, args.budget_ms, require_fc=not args.no_fc))
    return 0 if rows and verdict(rows, not args.no_fc).startswith("PASS") else 1


if __name__ == "__main__":
    sys.exit(main())
