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

    def test_a_fault_with_no_failsafe_fails_the_run(self):
        # The core missing a fault is exactly what C3 must catch: it can never vanish.
        events = [{"t_ns": 5_300 * MS, "ev": "state", "to": "FAILSAFE", "reason": "cmd_timeout", "cmd_age_ms": 300},
                  {"t_ns": 5_500 * MS, "ev": "flight_mode", "mode": "!FS!"}]
        faults = [{"t_ns": 5_000 * MS, "action": "block_pilot"}, {"t_ns": 60_000 * MS, "action": "block_pilot"}]
        rows = failsafe_report.analyse(events, faults, 1000)
        self.assertEqual([(r["cause"], r["ok"]) for r in rows], [("block_pilot", True), ("block_pilot", False)])
        self.assertEqual(rows[1]["note"], "no FAILSAFE within 10 s")
        text = failsafe_report.format_report(rows, 1000)
        self.assertIn("faults: 2 injected, 1 matched", text)
        self.assertIn("RESULT: FAIL", text)

    def test_faults_from_another_boot_are_not_matched(self):
        # CLOCK_MONOTONIC restarts at boot; the wall clock tells the two runs apart.
        events = [{"t_ns": 125_200 * MS, "wall": "2026-10-20T15:00:00.000Z", "ev": "state", "to": "FAILSAFE",
                   "reason": "pilot_lost", "cmd_age_ms": 20}]
        faults = [{"t_ns": 124_900 * MS, "wall": "2026-10-18T09:12:00.000Z", "action": "kill_gateway"}]
        rows = failsafe_report.analyse(events, faults, 1000)
        tr = [r for r in rows if r["reason"] == "pilot_lost"][0]
        self.assertEqual(tr["cause"], "last command")

    def test_since_limits_the_report_to_one_campaign(self):
        events = [{"t_ns": 1_000 * MS, "wall": "2026-10-18T09:00:00.000Z", "ev": "state", "to": "FAILSAFE", "reason": "cmd_timeout", "cmd_age_ms": 900},
                  {"t_ns": 9_000 * MS, "wall": "2026-10-20T15:00:00.000Z", "ev": "state", "to": "FAILSAFE", "reason": "cmd_timeout", "cmd_age_ms": 300}]
        events = failsafe_report.since(events, "2026-10-20T00:00")
        self.assertEqual(len(events), 1)

    def test_manual_failsafes_are_listed_but_not_judged(self):
        events = [{"t_ns": 9_000 * MS, "ev": "state", "to": "FAILSAFE", "reason": "manual", "cmd_age_ms": 12}]
        rows = failsafe_report.analyse(events, [], 1000)
        self.assertIsNone(rows[0]["ok"])
        self.assertIn("RESULT: FAIL (no link failures to judge)", failsafe_report.format_report(rows, 1000))

    def test_without_fc_confirmation_the_result_is_core_only(self):
        # The core switching is half the story: Betaflight must confirm !FS! too.
        events = [{"t_ns": 9_000 * MS, "wall": "2026-10-20T15:00:00.000Z", "ev": "state", "to": "FAILSAFE",
                   "reason": "cmd_timeout", "cmd_age_ms": 300}]
        rows = failsafe_report.analyse(events, [], 1000)
        text = failsafe_report.format_report(rows, 1000)
        self.assertIn("FC confirmed 0/1", text)
        self.assertIn("RESULT: FAIL", text)
        self.assertIn("RESULT: PASS (core only", failsafe_report.format_report(rows, 1000, require_fc=False))
        self.assertIn("15:00:00", text)                       # wall time per row
        self.assertIn("cmd_timeout", text.split("by reason:")[1])

    def test_main_reads_files_and_skips_broken_lines(self):
        with tempfile.TemporaryDirectory() as d:
            ev = os.path.join(d, "events.jsonl")
            with open(ev, "w") as f:
                f.write(json.dumps({"t_ns": 1, "ev": "start"}) + "\n")
                f.write(json.dumps({"t_ns": 9_000 * MS, "ev": "state", "to": "FAILSAFE", "reason": "cmd_timeout", "cmd_age_ms": 300}) + "\n")
                f.write(json.dumps({"t_ns": 9_300 * MS, "ev": "flight_mode", "mode": "!FS!"}) + "\n")
                f.write('{"t_ns": 9100, "ev": "sta')        # cut short by power loss
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(failsafe_report.main([ev]), 0)
            self.assertIn("RESULT: PASS", out.getvalue())


if __name__ == "__main__":
    unittest.main()
