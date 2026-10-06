# M5: Validation Tools and Campaign (C1 Jitter, C3 Failsafe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evidence for criteria C1 (CRSF frame jitter) and C3 (failsafe < 1 s on every link): tested analysis tools for crsf-core's timing and event logs, a timestamped fault injector, and the measurement campaigns.

**Architecture:** crsf-core already logs every frame's deadline and write times (`timing.csv`) and every state change (`events.jsonl`) with CLOCK_MONOTONIC timestamps (spec §5.4). `fault.py` logs each injected fault on the same clock, so `failsafe_report.py` measures detection from the moment the link broke. The tools are standard-library Python, with tests on synthetic logs.

**Tech Stack:** Python 3.13 standard library (`unittest`), `nft` for fault injection, `stress-ng` for CPU load.

**Spec:** `docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md` (read it first; section numbers below refer to it)

**Before you start:** Milestones 3 and 4 are installed on the Pi. Read spec §5.4, §7 and §7.1. Tasks 1–2 need no hardware. Tasks 3–4 need the bench (propellers off), `sudo apt install stress-ng`, and about two hours.

## Global Constraints

- Work in `~/ProyectoTerminal/elrs-web-gcs` on branch `main`; run every command from the repository root.
- Target: Raspberry Pi 4, Debian 13 arm64, gcc 14 (`-std=gnu11`), GNU make, Python 3.13 standard library only.
- Every file below was compiled and tested on that Pi before this plan was written: type it exactly. If a step's output differs from **Expected**, stop and find out why; do not edit a test to make it pass.
- **Propellers off** for every step that touches real hardware.
- Expected output is quoted in English; tools print some messages (compiler, `make`, Python errors) in the system's language.
- C1 target (spec P6, confirm with the mentor): send lateness p99 ≤ 250 µs, max ≤ 1 ms, no missed frame slots, over 10 minutes per condition.
- C3 target: FAILSAFE within 1000 ms of the link breaking, on every link, 10 runs each.
- Reports exit 0 = PASS, 1 = FAIL, 2 = unusable input, so they can be scripted.
- `fault.py` must always remove its firewall rule, even when interrupted (Ctrl-C).

## Review Focus

Inputs and failure modes most likely to hurt a real user; each is pinned by a test in the task named.

1. A skipped frame slot is counted, but a deliberate phase shift requested by the module is not (Task 1, `test_missed_slot_is_counted`, `test_phase_shift_is_not_a_missed_slot`).
2. A few very late frames fail the run even when the average looks fine (Task 1, `test_late_outliers_fail`).
3. Each injected fault is matched to at most one failsafe, and old faults are ignored (Task 2, `test_each_fault_is_used_once_and_old_faults_are_ignored`).
4. A log cut short by a power loss is still readable (Task 2, `test_main_reads_files_and_skips_broken_lines`).
5. Ctrl-C during a Wi-Fi block never leaves the pilot locked out (Task 2, `test_rule_is_removed_even_if_interrupted`).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `tools/analysis/timing_report.py` | C1: lateness/jitter statistics, missed slots, histogram, verdict |
| `tools/analysis/failsafe_report.py` | C3: detection time per FAILSAFE transition, FC confirmation |
| `tools/analysis/fault.py` | C3: timestamped fault injection (Wi-Fi block, gateway kill) |
| `tools/analysis/test_*.py` | tests on synthetic logs |
| `docs/procedures/c1-jitter.md, c3-failsafe.md` | measurement procedures and result tables |

### Task 1: C1 timing report

**Files:**
- Create: `tools/analysis/timing_report.py`
- Test: `tools/analysis/test_timing_report.py`

**Interfaces:**
- Consumes: crsf-core's `timing.csv` (`deadline_ns,wake_ns,write_start_ns,write_end_ns,period_ns,shift_ns`)
- Produces: `timing_report.py timing.csv [--max-p99-us 250] [--max-us 1000] [--hist h.csv]`; functions `load`, `analyse`, `verdict`, `histogram`, `percentile`

- [ ] **Step 1: Write the failing test**

Create `tools/analysis/test_timing_report.py`:

```python
"""Tests for timing_report.py (criterion C1)."""
import csv
import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout

import timing_report


def write_timing(path, lateness_us, period_us=4000, skip_after=None):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(timing_report.FIELDS)
        deadline = 1_000_000_000
        for i, late in enumerate(lateness_us):
            start = deadline + int(late * 1000)
            w.writerow([deadline, start - 2000, start, start + 30_000, period_us * 1000, 0])
            deadline += period_us * 1000 * (2 if skip_after == i else 1)


class TimingReportTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.csv = os.path.join(self.dir.name, "timing.csv")

    def run_main(self, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            code = timing_report.main([self.csv, *args])
        return code, out.getvalue()

    def test_clean_run_passes(self):
        write_timing(self.csv, [50 + (i % 10) for i in range(1000)])
        code, out = self.run_main()
        self.assertEqual(code, 0, out)
        self.assertIn("frames 1000", out)
        self.assertIn("250.0 Hz", out)
        self.assertIn("RESULT: PASS", out)

    def test_late_outliers_fail(self):
        write_timing(self.csv, [50] * 980 + [600] * 20)     # 2 % of frames 600 us late
        code, out = self.run_main("--max-p99-us", "250")
        self.assertEqual(code, 1)
        self.assertIn("p99 lateness 600.0 us > 250 us", out)

    def test_missed_slot_is_counted(self):
        write_timing(self.csv, [50] * 100, skip_after=10)
        code, out = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("1 missed frame slots", out)

    def test_phase_shift_is_not_a_missed_slot(self):
        rows = []
        deadline = 0
        for i in range(10):
            shift = 1_500_000 if i == 3 else 0           # module asked for +1.5 ms once
            rows.append([deadline, deadline, deadline + 1000, deadline + 2000, 4_000_000, shift])
            deadline += 4_000_000 + shift
        with open(self.csv, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(timing_report.FIELDS)
            w.writerows(rows)
        self.assertEqual(timing_report.analyse(timing_report.load(self.csv))["missed_slots"], 0)

    def test_histogram_and_bad_input(self):
        write_timing(self.csv, [5, 15, 15, 25])
        hist = os.path.join(self.dir.name, "h.csv")
        self.run_main("--hist", hist)
        with open(hist) as f:
            self.assertEqual(f.read().splitlines()[1:], ["0,1", "10,2", "20,1"])
        with open(self.csv, "w") as f:
            f.write("a,b\n1,2\n")
        self.assertEqual(self.run_main()[0], 2)

    def test_percentile_nearest_rank(self):
        values = sorted(range(1, 101))
        self.assertEqual(timing_report.percentile(values, 50), 50)
        self.assertEqual(timing_report.percentile(values, 99), 99)
        self.assertEqual(timing_report.percentile(values, 100), 100)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `python3 -W error -m unittest discover -s tools/analysis -t tools/analysis`

Expected: FAIL: `ModuleNotFoundError: No module named 'timing_report'`, then `Ran 1 tests` and `FAILED (errors=1)`

- [ ] **Step 3: Write the implementation**

Create `tools/analysis/timing_report.py`:

```python
#!/usr/bin/env python3
"""Criterion C1 (CRSF frame jitter) from crsf-core's per-frame timing log.

    timing_report.py timing.csv [--max-p99-us 250] [--max-us 1000] [--hist hist.csv]

Enable the log with `timing_log = /var/log/crsf-core/timing.csv` in crsf-core.conf.
"Send lateness" is how long after its scheduled deadline each frame was written; its
spread is the jitter the frame loop adds. Exit status: 0 within limits, 1 exceeded,
2 unusable input.
"""
import argparse
import csv
import math
import sys

FIELDS = ("deadline_ns", "wake_ns", "write_start_ns", "write_end_ns", "period_ns", "shift_ns")


def percentile(sorted_values, p):
    """Nearest-rank percentile of an already sorted list."""
    k = max(0, min(len(sorted_values) - 1, math.ceil(p / 100 * len(sorted_values)) - 1))
    return sorted_values[k]


def summary(values):
    s = sorted(values)
    return {"mean": sum(s) / len(s), "p50": percentile(s, 50), "p99": percentile(s, 99),
            "p999": percentile(s, 99.9), "max": s[-1]}


def load(path):
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None or tuple(reader.fieldnames) != FIELDS:
            raise ValueError("not a crsf-core timing log (header %r)" % (reader.fieldnames,))
        return [{k: int(v) for k, v in row.items()} for row in reader]


def analyse(rows):
    if len(rows) < 2:
        raise ValueError("need at least 2 frames")
    lateness = [(r["write_start_ns"] - r["deadline_ns"]) / 1000 for r in rows]
    missed = 0
    for prev, cur in zip(rows, rows[1:]):
        step = cur["deadline_ns"] - prev["deadline_ns"] - prev["shift_ns"]
        missed += max(0, round(step / prev["period_ns"]) - 1)
    duration = (rows[-1]["deadline_ns"] - rows[0]["deadline_ns"]) / 1e9
    return {
        "frames": len(rows),
        "duration_s": duration,
        "rate_hz": (len(rows) - 1) / duration if duration > 0 else 0.0,
        "missed_slots": missed,
        "lateness": summary(lateness),
        "wake": summary([(r["wake_ns"] - r["deadline_ns"]) / 1000 for r in rows]),
        "write": summary([(r["write_end_ns"] - r["write_start_ns"]) / 1000 for r in rows]),
        "jitter": summary([abs(b - a) for a, b in zip(lateness, lateness[1:])]),
        "lateness_values": lateness,
    }


def histogram(values, bin_us=10):
    bins = {}
    for v in values:
        b = int(math.floor(v / bin_us) * bin_us)
        bins[b] = bins.get(b, 0) + 1
    return sorted(bins.items())


def verdict(result, max_p99_us, max_us):
    problems = []
    if result["lateness"]["p99"] > max_p99_us:
        problems.append("p99 lateness %.1f us > %.0f us" % (result["lateness"]["p99"], max_p99_us))
    if result["lateness"]["max"] > max_us:
        problems.append("max lateness %.1f us > %.0f us" % (result["lateness"]["max"], max_us))
    if result["missed_slots"] > 0:
        problems.append("%d missed frame slots" % result["missed_slots"])
    return problems


def format_report(result, problems, max_p99_us, max_us):
    lines = ["frames %d over %.1f s (%.1f Hz), missed slots %d"
             % (result["frames"], result["duration_s"], result["rate_hz"], result["missed_slots"]),
             "%-24s %8s %8s %8s %8s %8s   (us)" % ("", "mean", "p50", "p99", "p99.9", "max")]
    for key, label in (("lateness", "send lateness"), ("wake", "wake-up latency"),
                       ("write", "write() duration"), ("jitter", "frame-to-frame jitter")):
        s = result[key]
        lines.append("%-24s %8.1f %8.1f %8.1f %8.1f %8.1f" % (label, s["mean"], s["p50"], s["p99"], s["p999"], s["max"]))
    if problems:
        lines.append("RESULT: FAIL (" + "; ".join(problems) + ")")
    else:
        lines.append("RESULT: PASS (p99 %.1f <= %.0f us, max %.1f <= %.0f us, no missed slots)"
                     % (result["lateness"]["p99"], max_p99_us, result["lateness"]["max"], max_us))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("timing_csv")
    ap.add_argument("--max-p99-us", type=float, default=250.0)
    ap.add_argument("--max-us", type=float, default=1000.0)
    ap.add_argument("--hist", help="write a 10 us histogram of send lateness (CSV) for plotting")
    args = ap.parse_args(argv)
    try:
        result = analyse(load(args.timing_csv))
    except (OSError, ValueError) as err:
        print("timing_report: %s" % err, file=sys.stderr)
        return 2
    problems = verdict(result, args.max_p99_us, args.max_us)
    print(format_report(result, problems, args.max_p99_us, args.max_us))
    if args.hist:
        with open(args.hist, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["lateness_us_bin_start", "frames"])
            w.writerows(histogram(result["lateness_values"]))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `python3 -W error -m unittest discover -s tools/analysis -t tools/analysis`

Expected: PASS: `Ran 6 tests` … `OK`

- [ ] **Step 5: Commit**

```bash
git add tools/analysis/test_timing_report.py tools/analysis/timing_report.py
git commit -m "tools: C1 timing report"
```

### Task 2: C3 failsafe report and fault injector

**Files:**
- Create: `tools/analysis/failsafe_report.py`
- Create: `tools/analysis/fault.py`
- Test: `tools/analysis/test_failsafe_report.py`
- Test: `tools/analysis/test_fault.py`

**Interfaces:**
- Consumes: crsf-core's `events.jsonl` (`state`, `flight_mode` events with `t_ns`)
- Produces: `failsafe_report.py events.jsonl [--faults faults.jsonl] [--budget-ms 1000]`; `sudo fault.py block-pilot [--seconds 5] [--port 8443]`, `sudo fault.py kill-gateway`, both appending `{"t_ns", "action"}` to `/var/log/crsf-core/faults.jsonl`

- [ ] **Step 1: Write the failing tests**

Create `tools/analysis/test_failsafe_report.py`:

```python
"""Tests for failsafe_report.py (criterion C3)."""
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout

import failsafe_report

MS = 1_000_000


class FailsafeReportTest(unittest.TestCase):
    def test_timeout_measured_from_last_command_and_fc_confirmation(self):
        events = [
            {"t_ns": 10_000 * MS, "ev": "state", "from": "ARMED", "to": "FAILSAFE", "reason": "cmd_timeout", "cmd_age_ms": 302},
            {"t_ns": 10_400 * MS, "ev": "flight_mode", "mode": "!FS!"},
        ]
        rows = failsafe_report.analyse(events, [], 1000)
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]["detect_ms"], 302)
        self.assertAlmostEqual(rows[0]["fc_ms"], 702)
        self.assertTrue(rows[0]["ok"])

    def test_injected_fault_is_the_start_time(self):
        events = [{"t_ns": 5_000 * MS, "ev": "state", "to": "FAILSAFE", "reason": "cmd_timeout", "cmd_age_ms": 300}]
        faults = [{"t_ns": 4_650 * MS, "action": "block_pilot"}]
        rows = failsafe_report.analyse(events, faults, 1000)
        self.assertEqual(rows[0]["cause"], "block_pilot")
        self.assertAlmostEqual(rows[0]["detect_ms"], 350)

    def test_each_fault_is_used_once_and_old_faults_are_ignored(self):
        events = [{"t_ns": 20_000 * MS, "ev": "state", "to": "FAILSAFE", "reason": "gateway_lost", "cmd_age_ms": 5},
                  {"t_ns": 40_000 * MS, "ev": "state", "to": "FAILSAFE", "reason": "cmd_timeout", "cmd_age_ms": 301}]
        faults = [{"t_ns": 19_990 * MS, "action": "kill_gateway"}]
        rows = failsafe_report.analyse(events, faults, 1000)
        self.assertEqual([r["cause"] for r in rows], ["kill_gateway", "last command"])

    def test_over_budget_fails_and_report_text(self):
        events = [{"t_ns": 9_000 * MS, "ev": "state", "to": "FAILSAFE", "reason": "cmd_timeout", "cmd_age_ms": 1200}]
        rows = failsafe_report.analyse(events, [], 1000)
        text = failsafe_report.format_report(rows, 1000)
        self.assertIn("NO", text)
        self.assertIn("RESULT: FAIL", text)
        self.assertIn("RESULT: FAIL", failsafe_report.format_report([], 1000))

    def test_main_reads_files_and_skips_broken_lines(self):
        with tempfile.TemporaryDirectory() as d:
            ev = os.path.join(d, "events.jsonl")
            with open(ev, "w") as f:
                f.write(json.dumps({"t_ns": 1, "ev": "start"}) + "\n")
                f.write(json.dumps({"t_ns": 9_000 * MS, "ev": "state", "to": "FAILSAFE", "reason": "manual", "cmd_age_ms": 12}) + "\n")
                f.write('{"t_ns": 9100, "ev": "sta')        # cut short by power loss
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(failsafe_report.main([ev]), 0)
            self.assertIn("RESULT: PASS", out.getvalue())


if __name__ == "__main__":
    unittest.main()
```

Create `tools/analysis/test_fault.py`:

```python
"""Tests for fault.py (C3 fault injection)."""
import json
import os
import tempfile
import unittest

import fault


class FaultTest(unittest.TestCase):
    def test_block_pilot_adds_and_always_removes_the_rule(self):
        cmds = []
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "faults.jsonl")
            fault.block_pilot(0.0, 8443, log, runner=cmds.append, sleep=lambda s: None)
            with open(log) as f:
                entry = json.loads(f.readline())
        self.assertEqual(entry["action"], "block_pilot")
        self.assertIn("t_ns", entry)
        self.assertEqual(cmds[-1], ["nft", "delete", "table", "inet", "gcs_fault"])
        self.assertIn(["nft", "add", "rule", "inet", "gcs_fault", "input", "tcp", "dport", "8443", "drop"], cmds)

    def test_rule_is_removed_even_if_interrupted(self):
        cmds = []

        def boom(_):
            raise KeyboardInterrupt

        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(KeyboardInterrupt):
                fault.block_pilot(5, 8443, os.path.join(d, "f.jsonl"), runner=cmds.append, sleep=boom)
        self.assertEqual(cmds[-1][:2], ["nft", "delete"])

    def test_kill_gateway_logs_before_killing(self):
        cmds = []
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "f.jsonl")
            fault.kill_gateway(log, runner=cmds.append)
            with open(log) as f:
                self.assertEqual(json.loads(f.readline())["action"], "kill_gateway")
        self.assertEqual(cmds, [["systemctl", "kill", "--signal=SIGKILL", "gcs-gateway.service"]])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `python3 -W error -m unittest discover -s tools/analysis -t tools/analysis`

Expected: FAIL: `ModuleNotFoundError: No module named 'failsafe_report'`, `ModuleNotFoundError: No module named 'fault'`, then `Ran 8 tests` and `FAILED (errors=2)`

- [ ] **Step 3: Write the implementation**

Create `tools/analysis/failsafe_report.py`:

```python
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
```

Create `tools/analysis/fault.py`:

```python
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
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `python3 -W error -m unittest discover -s tools/analysis -t tools/analysis`

Expected: PASS: `Ran 14 tests` … `OK`

- [ ] **Step 5: Commit**

```bash
git add tools/analysis/failsafe_report.py tools/analysis/fault.py tools/analysis/test_failsafe_report.py tools/analysis/test_fault.py
git commit -m "tools: C3 failsafe report and timestamped fault injection"
```

### Task 3: C1 campaign (propellers off)

Hardware task, about 45 minutes. Run D is the comparison that shows what the real-time settings buy: expect it to fail the 1 ms limit.

**Files:**
- Create: `docs/procedures/c1-jitter.md`

**Interfaces:**
- Consumes: `timing_report.py`, crsf-core's timing log
- Produces: C1 evidence for three of the four conditions

- [ ] **Step 1: Add the procedure**

Create `docs/procedures/c1-jitter.md`:

```markdown
# Criterion C1: CRSF frame jitter

**Target (proposed; confirm with the mentor):** over a 10-minute run, frames leave
crsf-core no later than **250 µs** after their scheduled time at the 99th percentile,
never more than **1 ms** late, and no frame slot is skipped. 1 ms is a quarter of the
4 ms frame period at 250 Hz, and our frames are aimed 1 ms ahead of the module's radio
packet (`sync_margin_us`), so frames within these limits never miss their packet.

The Pi-side log measures what we control. USB then adds its own delay, which the
module's timing frames absorb (step 5 shows it).

## Conditions (10 minutes each)

| Run | Condition | How |
|-----|-----------|-----|
| A | idle | only crsf-core and the gateway running |
| B | CPU contention | `stress-ng --cpu 3 --taskset 0-2 --timeout 600s` (install: `sudo apt install stress-ng`) |
| C | video streaming (after M6) | `gcs-video` running with 2 viewers on `watch.html` |
| D | reference, no real-time settings | `rt_priority = 0`, `rt_cpu = -1`, `rt_required = false` in the config |

## Steps

1. In `/etc/gcs/crsf-core.conf` set `timing_log = /var/log/crsf-core/timing.csv`, then
   `sudo systemctl restart crsf-core`. Module connected, RX bound, propellers off.
2. Start the run's condition, wait 10 minutes, then
   `sudo systemctl stop crsf-core && sudo mv /var/log/crsf-core/timing.csv ~/c1-run-A.csv`.
3. `tools/analysis/timing_report.py ~/c1-run-A.csv --hist ~/c1-run-A-hist.csv`
   prints the table and `RESULT: PASS|FAIL`. Plot the histogram CSV for the report.
4. Repeat for B, C, D. Restore the config afterwards (and empty `timing_log`).
5. Module's view: `grep '"ev":"timing"' /var/log/crsf-core/events.jsonl | tail -50` →
   `offset_us` should stay near +1000 (the margin). Large swings mean frames reached the
   module at irregular times even if the Pi-side numbers look good.
6. Optional, if the module's UART test pads are reachable: logic analyzer on the RX line
   of the ESP32 for 60 s, frame-to-frame interval histogram (charter's original method).

## Results

| Run | Frames | p50 µs | p99 µs | max µs | Missed | Result |
|-----|--------|--------|--------|--------|--------|--------|
| A | | | | | | |
| B | | | | | | |
| C | | | | | | |
| D | | | | | | |

Reference from development (no real-time settings, fake module, 6.7 s): p99 111 µs,
max 2177 µs → FAIL on the 1 ms limit. That is the case run D should reproduce.
```

- [ ] **Step 2: Run conditions A, B and D**

Follow `docs/procedures/c1-jitter.md` for runs A (idle), B (CPU contention) and D (no real-time settings). Run C (video) comes after Milestone 6. Fill in the results table and keep the CSVs and histograms for the report.

- [ ] **Step 3: Commit**

```bash
git add docs/procedures/c1-jitter.md
git commit -m "docs: C1 jitter procedure and results (A, B, D)"
```

### Task 4: C3 campaign (propellers off)

Hardware task, about an hour.

**Files:**
- Create: `docs/procedures/c3-failsafe.md`

**Interfaces:**
- Consumes: `fault.py`, `failsafe_report.py`, crsf-core's event log
- Produces: C3 evidence for every local link

- [ ] **Step 1: Add the procedure**

Create `docs/procedures/c3-failsafe.md`:

````markdown
# Criterion C3: failsafe response < 1 s on every link

**Propellers off**, Betaflight procedure DROP, bench as in the M3 test, gateway running,
pilot connected from the phone. Repeat each row **10 times**: arm, wait 5 s, break the
link, wait for Betaflight to disarm, restore, clear the failsafe.

| Link | How to break it | Who detects it | Measured with |
|------|-----------------|----------------|---------------|
| Pilot ↔ Pi, silent Wi-Fi loss | `sudo tools/analysis/fault.py block-pilot --seconds 5` | crsf-core timeout (`cmd_timeout`) | `failsafe_report.py --faults` |
| Pilot ↔ Pi, browser goes away | close the tab; phone Home button | gateway (`pilot_lost`) / dead-man (`cmd_timeout`) | `failsafe_report.py` |
| Inside the Pi: gateway dies | `sudo tools/analysis/fault.py kill-gateway` | crsf-core (`gateway_lost`) | `failsafe_report.py --faults` |
| Pi ↔ aircraft: radio | unplug the TX module's USB | Betaflight RX loss (guard time) | video of the OSD at 30 fps |

## Analysis

```bash
tools/analysis/failsafe_report.py /var/log/crsf-core/events.jsonl \
    --faults /var/log/crsf-core/faults.jsonl --budget-ms 1000
```

`detect_ms` is from the fault (or the last pilot command) to crsf-core switching to
FAILSAFE. The FAILSAFE channel goes out in the same frame: add at most 4 ms for "on the
air". `fc_ms` is when Betaflight's `!FS!` telemetry arrived, an upper bound that includes
telemetry delay.

For the radio row, film the OSD (goggles' HDMI output or the capture page) together with
the module, unplug, and count frames between the module's LED going dark and the OSD
failsafe warning (frames ÷ 30 = seconds).

## Results (10 runs each)

| Link | max detect ms | mean detect ms | max fc ms | Pass (< 1000 ms) |
|------|---------------|----------------|-----------|------------------|
| silent Wi-Fi loss | | | | |
| tab closed | | | | |
| phone Home | | | | |
| gateway killed | | | | |
| radio (video) | | | | |
````

- [ ] **Step 2: Run every link 10 times**

Follow `docs/procedures/c3-failsafe.md` for each link in its table (Wi-Fi block, browser gone, gateway killed, radio), 10 runs each, armed with propellers off. Analyse with `failsafe_report.py` and fill in the results.

- [ ] **Step 3: Calibrate the timeout**

If any link's worst detection is under 400 ms with no spurious failsafes, keep `cmd_timeout_ms = 300`. If spurious failsafes happened on good Wi-Fi, raise it in steps of 100 ms (max 900) and repeat the Wi-Fi rows. Write the decision under the table (FMEA #5).

- [ ] **Step 4: Commit**

```bash
git add docs/procedures/c3-failsafe.md
git commit -m "docs: C3 failsafe procedure and results"
```

## Done when

- `python3 -W error -m unittest discover -s tools/analysis -t tools/analysis` passes (14 tests); every earlier suite
  still passes.
- C1 runs A, B and D and every C3 row are measured and recorded, each with PASS, or with FAIL and a written cause.
