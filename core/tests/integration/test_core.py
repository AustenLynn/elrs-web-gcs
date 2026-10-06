import json
import os
import resource
import struct
import subprocess
import tempfile
import time
import unittest

from core_client import ACK, ARM, CONTROL, FAILSAFE, CoreClient, Pilot, msg
from fake_tx import FakeTx

CORE_DIR = os.path.join(os.path.dirname(__file__), "..", "..")
CORE = os.path.join(CORE_DIR, "build", "crsf-core")
CTL = os.path.join(CORE_DIR, "build", "crsf-ctl")
CH_ARM, CH_FAILSAFE, CH_THROTTLE = 4, 6, 2
HIGH, LOW = 1792, 192


class CoreHarness(unittest.TestCase):
    def setUp(self):
        # addCleanup (not tearDown) so a failure half-way through setUp still stops everything
        self.tx = FakeTx(interval_us=4000.0)
        self.addCleanup(self.tx.close)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.sock = os.path.join(self.tmp.name, "core.sock")
        self.events = os.path.join(self.tmp.name, "events.jsonl")
        conf = os.path.join(self.tmp.name, "crsf-core.conf")
        with open(conf, "w") as f:
            f.write("serial_device = %s\n" % self.tx.path)
            f.write("socket_path = %s\n" % self.sock)
            f.write("event_log = %s\n" % self.events)
            f.write("rt_priority = 0\nrt_cpu = -1\n")
        self.proc = subprocess.Popen([CORE, "-c", conf], stderr=subprocess.DEVNULL)
        self.addCleanup(self.stop_core)
        for _ in range(100):
            if os.path.exists(self.sock):
                break
            time.sleep(0.02)
        self.client = CoreClient(self.sock)
        self.addCleanup(lambda: self.client.close())
        self.assertTrue(self.client.wait(lambda c: c.status is not None), "no status from crsf-core")

    def stop_core(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
            raise

    def read_events(self):
        time.sleep(1.2)                       # the core flushes its log once per second
        with open(self.events) as f:
            return [json.loads(line) for line in f]

    def arm(self, pilot):
        self.assertTrue(self.client.wait(lambda c: c.status["last_seq"] > 0))
        self.client.send(ARM, pilot.session)
        self.assertIsNotNone(self.tx.wait_for(lambda ch: ch[CH_ARM] == HIGH), "ARM channel never went high")


class FrameTimingTest(CoreHarness):
    def test_follows_module_interval(self):
        self.tx.interval_us = 5000.0                       # module asks for 200 Hz
        self.assertTrue(self.client.wait(lambda c: c.status["period_us"] == 5000, timeout=3))
        t0 = time.monotonic()
        time.sleep(1.0)
        n = len(self.tx.frames_since(t0))
        self.assertTrue(180 <= n <= 220, n)

    def test_sends_model_select_and_ping_on_open(self):
        self.assertTrue(self.client.wait(lambda c: c.device is not None))
        self.assertEqual(self.client.device["name"], "FAKE TX")
        self.assertGreaterEqual(self.tx.model_selects, 1)


class CtlTest(CoreHarness):
    def test_status_prints_one_line(self):
        out = subprocess.run([CTL, "-s", self.sock, "status"], capture_output=True, text=True, timeout=10)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertTrue(out.stdout.startswith("DISARMED"), out.stdout)
        self.assertIn("serial=ok", out.stdout)
        self.assertIn("ch5=192 ch7=192", out.stdout)


class SafetyTest(CoreHarness):
    def test_starts_disarmed_with_safe_channels(self):
        ch = self.tx.last_channels()
        self.assertEqual(ch[CH_ARM], LOW)
        self.assertEqual(ch[CH_FAILSAFE], LOW)
        self.assertEqual(ch[CH_THROTTLE], LOW)

    def test_command_timeout_triggers_failsafe_within_budget(self):
        pilot = Pilot(self.client, session=11)
        self.arm(pilot)
        pilot.paused = True                                # pilot freezes (e.g. Wi-Fi drop)
        t_stop = time.monotonic()
        t_fs = self.tx.wait_for(lambda ch: ch[CH_FAILSAFE] == HIGH, timeout=2)
        pilot.stop()
        self.assertIsNotNone(t_fs, "FAILSAFE channel never went high")
        self.assertLess(t_fs - t_stop, 0.45)               # 300 ms timeout + scheduling slack
        ch = self.tx.last_channels()
        self.assertEqual(ch[CH_ARM], HIGH)                 # Betaflight runs its own procedure
        self.assertEqual(ch[CH_THROTTLE], LOW)
        self.assertTrue(self.client.wait(lambda c: c.status["reason_name"] == "cmd_timeout"))
        fs = [e for e in self.read_events() if e["ev"] == "state" and e["to"] == "FAILSAFE"]
        self.assertEqual(len(fs), 1)
        self.assertGreaterEqual(fs[0]["cmd_age_ms"], 300)

    def test_gateway_disconnect_triggers_failsafe(self):
        pilot = Pilot(self.client, session=12)
        self.arm(pilot)
        pilot.stop()
        self.client.close()
        self.assertIsNotNone(self.tx.wait_for(lambda ch: ch[CH_FAILSAFE] == HIGH, timeout=1))
        self.client = CoreClient(self.sock)
        self.assertTrue(self.client.wait(lambda c: c.status is not None and c.status["reason_name"] == "gateway_lost"))

    def test_burst_then_disconnect_fails_safe_at_once(self):
        # A gateway that flushes a backlog and then dies must still be reported as lost at
        # once (gateway_lost), not 300 ms later by the command timeout.
        pilot = Pilot(self.client, session=13)
        self.arm(pilot)
        pilot.stop()
        burst = b"".join(msg(CONTROL, struct.pack("<IIhhhHB", 13, 10000 + i, 0, 0, 0, 0, 0)) for i in range(2000))
        self.client.sock.sendall(burst)
        self.client.close()
        t0 = time.monotonic()
        self.assertIsNotNone(self.tx.wait_for(lambda ch: ch[CH_FAILSAFE] == HIGH, timeout=1))
        self.assertLess(time.monotonic() - t0, 0.15)
        self.client = CoreClient(self.sock)
        self.assertTrue(self.client.wait(lambda c: c.status is not None and c.status["reason_name"] == "gateway_lost"))

    def test_ack_is_refused_while_fc_reports_armed(self):
        pilot = Pilot(self.client, session=13)
        self.arm(pilot)
        self.tx.flight_mode = "!FS!"                       # Betaflight armed, running failsafe
        self.client.send(FAILSAFE, 13)
        self.assertIsNotNone(self.tx.wait_for(lambda ch: ch[CH_FAILSAFE] == HIGH))
        time.sleep(0.3)
        self.client.send(ACK, 13)
        self.assertTrue(self.client.wait(lambda c: ("ack_refused", "fc_still_armed", 13) in c.events))
        self.tx.flight_mode = "!FS!*"                      # Betaflight disarmed (landed)
        time.sleep(0.3)
        self.client.send(ACK, 13)
        self.assertIsNotNone(self.tx.wait_for(lambda ch: ch[CH_FAILSAFE] == LOW and ch[CH_ARM] == LOW))
        pilot.stop()
        self.assertTrue(self.client.wait(lambda c: c.status["state_name"] == "DISARMED"))  # status is 10 Hz

    def test_arm_refused_with_throttle_up(self):
        pilot = Pilot(self.client, session=14, throttle=400)
        self.assertTrue(self.client.wait(lambda c: c.status["last_seq"] > 0))
        self.client.send(ARM, 14)
        self.assertTrue(self.client.wait(lambda c: ("arm_refused", "throttle_high", 14) in c.events))
        pilot.stop()
        self.assertEqual(self.tx.last_channels()[CH_ARM], LOW)


class ResilienceTest(CoreHarness):
    def test_unplugged_module_is_reported(self):
        self.tx.close()                                    # like pulling the USB cable
        self.assertTrue(self.client.wait(lambda c: c.status["serial_ok"] == 0, timeout=2))
        self.assertTrue(any(e["ev"] == "serial" and e["ok"] is False for e in self.read_events()))

    def test_malformed_message_drops_the_gateway_and_fails_safe(self):
        pilot = Pilot(self.client, session=21)
        self.arm(pilot)
        pilot.stop()
        self.client.sock.sendall(struct.pack("<HB", 1, 0x55))   # unknown message type
        self.assertIsNotNone(self.tx.wait_for(lambda ch: ch[CH_FAILSAFE] == HIGH, timeout=1))

    def test_newest_gateway_wins_and_the_old_one_fails_safe(self):
        pilot = Pilot(self.client, session=22)
        self.arm(pilot)
        second = CoreClient(self.sock)
        self.addCleanup(second.close)
        self.assertIsNotNone(self.tx.wait_for(lambda ch: ch[CH_FAILSAFE] == HIGH, timeout=1))
        pilot.stop()
        self.assertTrue(second.wait(lambda c: c.status is not None and c.status["reason_name"] == "gateway_lost"))


class StartupTest(unittest.TestCase):
    def test_missing_config_exits_2(self):
        out = subprocess.run([CORE, "-c", "/nonexistent/crsf-core.conf"], capture_output=True, text=True, timeout=5)
        self.assertEqual(out.returncode, 2)
        self.assertIn("No such file", out.stderr)

    @unittest.skipIf(os.geteuid() == 0 or resource.getrlimit(resource.RLIMIT_RTPRIO)[0] > 0,
                     "this user may use real-time scheduling")
    def test_required_real_time_without_permission_exits_1(self):
        with tempfile.TemporaryDirectory() as d:
            conf = os.path.join(d, "c.conf")
            with open(conf, "w") as f:
                f.write("serial_device = /dev/null\nsocket_path = %s/c.sock\n" % d)
                f.write("rt_priority = 80\nrt_cpu = -1\nrt_required = true\n")
            out = subprocess.run([CORE, "-c", conf], capture_output=True, text=True, timeout=5)
        self.assertEqual(out.returncode, 1)
        self.assertRegex(out.stderr, "mlockall|SCHED_FIFO")


class TelemetryTest(CoreHarness):
    def test_link_battery_and_flight_mode_are_forwarded(self):
        self.tx.link_lq = 87
        self.tx.battery_dv = 151
        self.tx.flight_mode = "ACRO*"
        self.assertTrue(self.client.wait(lambda c: c.link is not None and c.battery is not None
                                         and c.flight_mode == "ACRO*", timeout=3))
        self.assertEqual(self.client.link["up_lq"], 87)
        self.assertEqual(self.client.link["up_rssi1"], -67)
        self.assertEqual(self.client.battery["voltage_dv"], 151)
        self.assertEqual(self.client.status["fc_arm"], 1)   # FC_DISARMED


if __name__ == "__main__":
    unittest.main()
