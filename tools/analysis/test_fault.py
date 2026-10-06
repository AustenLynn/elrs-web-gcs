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
