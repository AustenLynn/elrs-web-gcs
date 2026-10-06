import os
import subprocess
import time
import unittest

from fake_tx import FakeTx

CORE = os.path.join(os.path.dirname(__file__), "..", "..")
PROBE = os.path.join(CORE, "build", "crsf-probe")


class ProbeTest(unittest.TestCase):
    def setUp(self):
        self.tx = FakeTx()

    def tearDown(self):
        self.tx.close()

    def test_reports_device_and_exits_zero(self):
        out = subprocess.run([PROBE, "-t", "1", self.tx.path], capture_output=True, text=True, timeout=10)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn('device 0xEE: "FAKE TX" ExpressLRS 3.5.3', out.stdout)

    def test_rc_mode_streams_disarmed_frames_at_module_rate(self):
        self.tx.interval_us = 5000.0                      # module asks for 200 Hz
        t0 = time.monotonic()
        out = subprocess.run([PROBE, "-t", "2", "--rc", self.tx.path], capture_output=True, text=True, timeout=10)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("timing: interval 5000.0 us (200.0 Hz)", out.stdout)
        self.assertGreaterEqual(self.tx.model_selects, 1)
        frames = self.tx.frames_since(t0 + 1.0)           # after the first timing frames
        self.assertTrue(150 <= len(frames) <= 230, len(frames))
        ch = frames[-1][1]
        self.assertEqual(ch[2], 192)                      # throttle 1000 us
        self.assertEqual(ch[4], 192)                      # AUX1 (arm) low
        self.assertEqual(ch[0], 992)                      # roll centred

    def test_no_answer_exits_one(self):
        master, slave = os.openpty()
        try:
            out = subprocess.run([PROBE, "-t", "1", os.ttyname(slave)], capture_output=True, text=True, timeout=10)
            self.assertEqual(out.returncode, 1)
            self.assertIn("no CRSF device answered", out.stderr)
        finally:
            os.close(master)
            os.close(slave)


if __name__ == "__main__":
    unittest.main()
