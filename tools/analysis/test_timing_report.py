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
