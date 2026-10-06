"""Tests for latency_report.py (criterion C2)."""
import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout

import latency_report


class LatencyReportTest(unittest.TestCase):
    def write(self, rows):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        path = os.path.join(d.name, "r.csv")
        with open(path, "w") as f:
            f.write("direct_s,video_s,note\n" + "".join("%s,%s,x\n" % r for r in rows))
        return path

    def run_main(self, path):
        out = io.StringIO()
        with redirect_stdout(out):
            code = latency_report.main([path])
        return code, out.getvalue()

    def test_pass_when_90_percent_within_limit(self):
        rows = [("10.250", "10.050")] * 9 + [("20.900", "20.500")]          # 9 x 200 ms, 1 x 400 ms
        code, out = self.run_main(self.write(rows))
        self.assertEqual(code, 0, out)
        self.assertIn("p50 200 ms, p90 200 ms, max 400 ms; 90% <= 300 ms", out)

    def test_fail_and_clock_wrap(self):
        code, out = self.run_main(self.write([("0.100", "999.700")] * 10))  # wrapped: 400 ms each
        self.assertEqual(code, 1)
        self.assertIn("p50 400 ms", out)

    def test_bad_input(self):
        self.assertEqual(self.run_main(self.write([]))[0], 2)


if __name__ == "__main__":
    unittest.main()
