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
