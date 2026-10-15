import json
import os
import resource
import struct
import subprocess
import tempfile
import time
import unittest

from core_client import ACK, ARM, CONTROL, DISARM, FAILSAFE, CoreClient, Pilot, msg
from fake_tx import FakeTx

CORE_DIR = os.path.join(os.path.dirname(__file__), "..", "..")
CORE = os.path.join(CORE_DIR, "build", "crsf-core")
CTL = os.path.join(CORE_DIR, "build", "crsf-ctl")
CH_ARM, CH_FAILSAFE, CH_THROTTLE = 4, 6, 2   # CH_FAILSAFE: betaflight profile only
CH_SPEED, CH_TURTLE = 6, 7                   # aquila20 profile
CH_SENSITIVITY = 6                            # aquila20: CH7 is the drone's sensitivity switch
HIGH, LOW = 1792, 192


class CoreHarness(unittest.TestCase):
    PROFILE = "aquila20"          # fc_profile; subclasses may choose "betaflight"

    def failsafe_on(self, ch):
        """What FAILSAFE looks like on the air in this profile."""
        if self.PROFILE == "betaflight":
            return ch[CH_FAILSAFE] == HIGH                       # FAILSAFE switch high
        return ch[CH_ARM] == LOW and ch[CH_SENSITIVITY] == LOW   # disarmed, sensitivity still S

    IGNORE_PINGS = 0

    def setUp(self):
        # addCleanup (not tearDown) so a failure half-way through setUp still stops everything
        self.tx = FakeTx(interval_us=4000.0)
        self.tx.ignore_pings = self.IGNORE_PINGS
        self.addCleanup(self.tx.close)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.sock = os.path.join(self.tmp.name, "core.sock")
        self.status_sock = os.path.join(self.tmp.name, "status.sock")
        self.events = os.path.join(self.tmp.name, "events.jsonl")
        conf = os.path.join(self.tmp.name, "crsf-core.conf")
        with open(conf, "w") as f:
            f.write("serial_device = %s\n" % self.tx.path)
            f.write("socket_path = %s\n" % self.sock)
            f.write("status_socket_path = %s\n" % self.status_sock)
            f.write("event_log = %s\n" % self.events)
            f.write("rt_priority = 0\nrt_cpu = -1\n")
            f.write("fc_profile = %s\n" % self.PROFILE)
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


class SlowModuleTest(CoreHarness):
    IGNORE_PINGS = 1               # the module misses the first ping (still booting)

    def test_module_is_identified_even_if_it_missed_the_first_ping(self):
        # On the bench the module boots while crsf-core opens the port; it then sends timing
        # frames non-stop, so it never looks silent. The core must keep asking until it answers.
        self.assertTrue(self.client.wait(lambda c: c.device is not None, timeout=3))
        self.assertEqual(self.client.device["name"], "FAKE TX")


class CtlTest(CoreHarness):
    def test_status_prints_one_line(self):
        out = subprocess.run([CTL, "-s", self.status_sock, "status"], capture_output=True, text=True, timeout=10)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertTrue(out.stdout.startswith("DISARMED"), out.stdout)
        self.assertIn("serial=ok", out.stdout)
        self.assertIn("ch5=192 ch7=192", out.stdout)

    def test_status_while_flying_does_not_take_over_the_gateway(self):
        # crsf-ctl status/watch connect to the read-only status socket: checking on a flying
        # drone must never look like a new gateway (which would fail safe).
        pilot = Pilot(self.client, session=31)
        self.addCleanup(pilot.stop)
        self.arm(pilot)
        for _ in range(3):
            out = subprocess.run([CTL, "-s", self.status_sock, "status"], capture_output=True, text=True, timeout=10)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertTrue(out.stdout.startswith("ARMED"), out.stdout)
        time.sleep(0.3)
        self.assertEqual(self.tx.last_channels()[CH_FAILSAFE], LOW)
        self.assertEqual(self.tx.last_channels()[CH_ARM], HIGH)
        self.assertTrue(self.client.wait(lambda c: c.status["state_name"] == "ARMED"))

    def test_observers_cannot_send_commands(self):
        observer = CoreClient(self.status_sock)
        self.addCleanup(observer.close)
        self.assertTrue(observer.wait(lambda c: c.status is not None), "observers get status")
        observer.send(ARM, 1)                              # ignored, never reaches the core
        observer.control(1, 1)
        time.sleep(0.3)
        self.assertEqual(self.tx.last_channels()[CH_ARM], LOW)
        self.assertTrue(self.client.wait(lambda c: c.status["state_name"] == "DISARMED"))
        self.assertTrue(observer.wait(lambda c: c.status["state_name"] == "DISARMED"))


class SafetyTest(CoreHarness):
    def test_starts_disarmed_with_safe_channels(self):
        ch = self.tx.last_channels()
        self.assertEqual(ch[CH_ARM], LOW)
        self.assertEqual(ch[CH_SENSITIVITY], LOW)
        self.assertEqual(ch[CH_THROTTLE], LOW)

    def test_command_timeout_triggers_failsafe_within_budget(self):
        pilot = Pilot(self.client, session=11)
        self.arm(pilot)
        pilot.paused = True                                # pilot freezes (e.g. Wi-Fi drop)
        t_stop = time.monotonic()
        t_fs = self.tx.wait_for(self.failsafe_on, timeout=2)
        pilot.stop()
        self.assertIsNotNone(t_fs, "failsafe never reached the channels")
        self.assertLess(t_fs - t_stop, 0.45)               # 300 ms timeout + scheduling slack
        ch = self.tx.last_channels()
        self.assertEqual(ch[CH_ARM], LOW)                  # aquila20: failsafe disarms the drone
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
        self.assertIsNotNone(self.tx.wait_for(self.failsafe_on, timeout=1))
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
        self.assertIsNotNone(self.tx.wait_for(self.failsafe_on, timeout=1))
        self.assertLess(time.monotonic() - t0, 0.15)
        self.client = CoreClient(self.sock)
        self.assertTrue(self.client.wait(lambda c: c.status is not None and c.status["reason_name"] == "gateway_lost"))

    def test_flight_mode_text_never_blocks_clearing_failsafe(self):
        # The Aquila20's flight-mode text ("S-NORMAL") never says whether it is armed. Read the
        # Betaflight way (no '*' = armed) it would refuse every ack.
        pilot = Pilot(self.client, session=15)
        self.arm(pilot)
        self.tx.flight_mode = "S-NORMAL"
        time.sleep(0.3)                                    # telemetry reaches the core
        self.client.send(FAILSAFE, 15)
        self.assertIsNotNone(self.tx.wait_for(self.failsafe_on))
        self.client.send(ACK, 15)
        self.assertTrue(self.client.wait(lambda c: c.status["state_name"] == "DISARMED"))
        self.assertNotIn(("ack_refused", "fc_still_armed", 15), self.client.events)
        pilot.stop()

    def test_radio_link_loss_disarms_and_says_so(self):
        # The drone disarms itself when its radio link drops and never says so: the core must
        # follow within about 1 s (FAILSAFE rf_lost, ARM low), not show ARMED with ARM high.
        pilot = Pilot(self.client, session=16)
        self.arm(pilot)
        t0 = time.monotonic()
        self.tx.link_lq = None                             # link reports stop
        self.assertTrue(self.client.wait(lambda c: c.status["reason_name"] == "rf_lost", timeout=3))
        self.assertLess(time.monotonic() - t0, 1.6)        # 1 s + report interval + slack
        self.assertTrue(self.failsafe_on(self.tx.last_channels()))
        pilot.stop()

    def test_arm_refused_while_the_drone_is_not_linked(self):
        # Flight test 2026-10-09: right after the module reconnected, arming armed and failed
        # safe (rf_lost) at once. With the module up but the drone not linked (LQ 0), arming
        # must be refused (rf_down) and ARM must stay low; once the drone links, it arms.
        self.tx.link_lq = 0
        time.sleep(1.3)                                    # the last LQ > 0 report ages out
        pilot = Pilot(self.client, session=17)
        self.assertTrue(self.client.wait(lambda c: c.status["last_seq"] > 0))
        self.client.send(ARM, 17)
        self.assertTrue(self.client.wait(lambda c: ("arm_refused", "rf_down", 17) in c.events))
        self.assertEqual(self.client.status["state_name"], "DISARMED")
        self.assertEqual(self.tx.last_channels()[CH_ARM], LOW)
        self.tx.link_lq = 100
        time.sleep(0.5)
        self.arm(pilot)
        pilot.stop()

    def test_arm_refused_with_throttle_up(self):
        pilot = Pilot(self.client, session=14, throttle=400)
        self.assertTrue(self.client.wait(lambda c: c.status["last_seq"] > 0))
        self.client.send(ARM, 14)
        self.assertTrue(self.client.wait(lambda c: ("arm_refused", "throttle_high", 14) in c.events))
        pilot.stop()
        self.assertEqual(self.tx.last_channels()[CH_ARM], LOW)


class StickLogTest(CoreHarness):
    def test_values_on_the_air_are_logged_while_armed(self):
        # Flight test 2026-10-09: the log could not show the throttle when the drone came
        # down. While armed, the core logs the values on the air every 100 ms, plus one line
        # after leaving ARMED; nothing while disarmed.
        pilot = Pilot(self.client, session=18)
        time.sleep(0.5)                                    # disarmed: no lines
        self.arm(pilot)
        pilot.throttle = 235
        time.sleep(1.0)
        self.client.send(DISARM, 18)
        self.assertIsNotNone(self.tx.wait_for(lambda ch: ch[CH_ARM] == LOW), "ARM never went low")
        time.sleep(0.3)
        pilot.stop()
        sticks = [e for e in self.read_events() if e["ev"] == "sticks"]
        armed = [e for e in sticks if e["arm"]]
        self.assertTrue(8 <= len(armed) <= 14, len(armed))  # about 10 per second for about 1 s
        self.assertEqual(armed[-1]["thr"], 23.5)
        self.assertEqual(armed[-1]["mode"], 0)
        self.assertLess(armed[-1]["cmd_age_ms"], 100)
        gaps = [(b["t_ns"] - a["t_ns"]) / 1e6 for a, b in zip(armed, armed[1:])]
        self.assertTrue(all(95 <= g <= 150 for g in gaps), gaps)
        self.assertFalse(sticks[-1]["arm"])                 # the line that shows how it ended
        self.assertEqual(len(sticks), len(armed) + 1)       # and nothing after it

    def test_speed_and_turtle_reach_ch7_and_ch8_and_failsafe_drops_turtle(self):
        pilot = Pilot(self.client, session=19)
        self.arm(pilot)
        pilot.speed, pilot.turtle = 2, 1
        self.assertIsNotNone(self.tx.wait_for(lambda ch: ch[CH_SPEED] == HIGH and ch[CH_TURTLE] == HIGH),
                             "speed/turtle never reached CH7/CH8")
        pilot.paused = True                                # the page stops sending
        self.assertTrue(self.client.wait(lambda c: c.status["reason_name"] == "cmd_timeout", timeout=2))
        ch = self.tx.last_channels()
        self.assertEqual((ch[CH_ARM], ch[CH_TURTLE], ch[CH_SPEED]), (LOW, LOW, HIGH))
        pilot.stop()
        sticks = [e for e in self.read_events() if e["ev"] == "sticks"]
        self.assertTrue(any(e["speed"] == 2 and e["turtle"] for e in sticks))
        self.assertFalse(sticks[-1]["turtle"])             # the line after FAILSAFE


class BetaflightTest(CoreHarness):
    PROFILE = "betaflight"

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


    def test_flight_mode_star_means_disarmed(self):
        self.tx.flight_mode = "ACRO*"
        self.assertTrue(self.client.wait(lambda c: c.flight_mode == "ACRO*", timeout=3))
        self.assertTrue(self.client.wait(lambda c: c.status["fc_arm"] == 1))   # FC_DISARMED


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
        self.assertIsNotNone(self.tx.wait_for(self.failsafe_on, timeout=1))

    def test_newest_gateway_wins_and_the_old_one_fails_safe(self):
        pilot = Pilot(self.client, session=22)
        self.arm(pilot)
        second = CoreClient(self.sock)
        self.addCleanup(second.close)
        self.assertIsNotNone(self.tx.wait_for(self.failsafe_on, timeout=1))
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
        self.assertEqual(self.client.status["fc_arm"], 0)   # aquila20: armed state unknown


if __name__ == "__main__":
    unittest.main()
