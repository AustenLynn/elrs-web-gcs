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
        # cur's period is the one the scheduler used to reach cur's deadline: the row's period
        # is read before that tick's telemetry, i.e. after the previous tick's change
        step = cur["deadline_ns"] - prev["deadline_ns"] - prev["shift_ns"]
        missed += max(0, round(step / cur["period_ns"]) - 1)
    duration = (rows[-1]["deadline_ns"] - rows[0]["deadline_ns"]) / 1e9
    return {
        "frames": len(rows),
        "duration_s": duration,
        "rate_hz": (len(rows) - 1) / duration if duration > 0 else 0.0,
        "missed_slots": missed,
        # crsf-core logs every tick; while the port is down nothing is written (end == start)
        "not_sent": sum(1 for r in rows if r["write_end_ns"] == r["write_start_ns"]),
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
    if result["not_sent"] > 0:
        problems.append("%d ticks sent nothing (module port down)" % result["not_sent"])
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
