#!/usr/bin/env python3
"""Criterion C2 (video latency) from glass-to-glass photo readings.

    latency_report.py readings.csv [--limit-ms 300] [--fraction 0.9]

readings.csv columns: direct_s,video_s[,note]  - the clock page (web/clock.html) as read
directly on its screen and as read inside the video, both in seconds from the same photo.
PASS when at least --fraction of the readings are <= --limit-ms. Exit 0 pass, 1 fail, 2 bad input.
"""
import argparse
import csv
import math
import sys


def latencies(path):
    out = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            d, v = float(row["direct_s"]), float(row["video_s"])
            if d < v:
                d += 1000.0          # the clock page wraps every 1000 s
            out.append((d - v) * 1000.0)
    return out


def summarise(values, limit_ms, fraction):
    s = sorted(values)
    p = lambda q: s[max(0, math.ceil(q * len(s)) - 1)]
    within = sum(1 for v in s if v <= limit_ms) / len(s)
    return {"n": len(s), "p50": p(0.5), "p90": p(0.9), "max": s[-1], "within": within, "pass": within >= fraction}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("readings")
    ap.add_argument("--limit-ms", type=float, default=300.0)
    ap.add_argument("--fraction", type=float, default=0.9)
    args = ap.parse_args(argv)
    try:
        values = latencies(args.readings)
        if not values:
            raise ValueError("no readings")
    except (OSError, KeyError, ValueError) as err:
        print("latency_report: %s" % err, file=sys.stderr)
        return 2
    r = summarise(values, args.limit_ms, args.fraction)
    print("readings %d: p50 %.0f ms, p90 %.0f ms, max %.0f ms; %.0f%% <= %.0f ms"
          % (r["n"], r["p50"], r["p90"], r["max"], 100 * r["within"], args.limit_ms))
    print("RESULT: %s" % ("PASS" if r["pass"] else "FAIL"))
    return 0 if r["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
