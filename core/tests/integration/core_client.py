"""Minimal Python client for the crsf-core socket protocol (src/ipc_proto.h)."""
import socket
import struct
import threading
import time

SESSION, CONTROL, ARM, DISARM, ACK, PILOT_LOST, FAILSAFE = 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07
STATUS, LINK, BATTERY, FLIGHT_MODE, DEVICE, EVENT = 0x81, 0x82, 0x83, 0x84, 0x85, 0x86
STATES = {0: "DISARMED", 1: "ARMED", 2: "FAILSAFE"}
REASONS = {0: "none", 1: "cmd_timeout", 2: "pilot_lost", 3: "gateway_lost", 4: "session_changed", 5: "manual"}
REFUSALS = {0: "none", 1: "wrong_session", 2: "not_disarmed", 3: "not_in_failsafe",
            4: "link_stale", 5: "throttle_high", 6: "fc_still_armed"}

STATUS_FMT = "<BBBB" + "I" * 8 + "i" + "I" * 2 + "16H"   # 80 bytes, see ipc_status_t
STATUS_FIELDS = ("state", "fs_reason", "fc_arm", "serial_ok", "session", "last_seq", "cmd_age_ms",
                 "frames_sent", "tx_errors", "rx_frames", "rx_crc_errors", "period_us",
                 "offset_0p1us", "timing_frames", "wake_late_max_us")


def msg(mtype, payload=b""):
    return struct.pack("<HB", len(payload) + 1, mtype) + payload


class CoreClient:
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)
        self.status = None
        self.link = None
        self.battery = None
        self.flight_mode = None
        self.device = None
        self.events = []
        self._buf = b""
        self._stop = False
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._reader, daemon=True)
        self._thread.start()

    def close(self):
        self._stop = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()

    def send(self, mtype, session):
        self.sock.sendall(msg(mtype, struct.pack("<I", session)))

    def control(self, session, seq, roll=0, pitch=0, yaw=0, throttle=0, mode=0):
        self.sock.sendall(msg(CONTROL, struct.pack("<IIhhhHB", session, seq, roll, pitch, yaw, throttle, mode)))

    def wait(self, predicate, timeout=2.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            with self._lock:
                if predicate(self):
                    return True
            time.sleep(0.01)
        return False

    def _reader(self):
        while not self._stop:
            try:
                data = self.sock.recv(4096)
            except OSError:
                return
            if not data:
                return
            self._buf += data
            while len(self._buf) >= 2:
                (n,) = struct.unpack_from("<H", self._buf)
                if len(self._buf) < 2 + n:
                    break
                mtype, payload = self._buf[2], self._buf[3:2 + n]
                self._buf = self._buf[2 + n:]
                with self._lock:
                    self._handle(mtype, payload)

    def _handle(self, mtype, p):
        if mtype == STATUS:
            values = struct.unpack(STATUS_FMT, p)
            st = dict(zip(STATUS_FIELDS, values[:15]))
            st["channels"] = list(values[15:])
            st["state_name"] = STATES[st["state"]]
            st["reason_name"] = REASONS[st["fs_reason"]]
            self.status = st
        elif mtype == LINK:
            self.link = dict(zip(("up_rssi1", "up_rssi2", "up_lq", "up_snr", "antenna", "rf_mode",
                                  "tx_power_mw", "dn_rssi", "dn_lq", "dn_snr"),
                                 struct.unpack("<bbBbBBHbBb", p)))
        elif mtype == BATTERY:
            self.battery = dict(zip(("voltage_dv", "current_da", "capacity_mah", "remaining"),
                                    struct.unpack("<HHIB", p)))
        elif mtype == FLIGHT_MODE:
            self.flight_mode = p[1:1 + p[0]].decode()
        elif mtype == DEVICE:
            self.device = {"name": p[9:9 + p[8]].decode(), "version": "%d.%d.%d" % (p[1], p[2], p[3])}
        elif mtype == EVENT:
            kind, detail, session = struct.unpack("<BBI", p)
            self.events.append(("arm_refused" if kind == 1 else "ack_refused", REFUSALS[detail], session))


class Pilot:
    """Sends CONTROL at 50 Hz in a background thread, like the web app does."""

    def __init__(self, client, session, throttle=0):
        self.client = client
        self.session = session
        self.throttle = throttle
        self.seq = 0
        self.running = True
        self.paused = False
        client.send(SESSION, session)
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        while self.running:
            if not self.paused:
                self.seq += 1
                try:
                    self.client.control(self.session, self.seq, throttle=self.throttle)
                except OSError:
                    return
            time.sleep(0.02)

    def stop(self):
        self.running = False
        self._thread.join(timeout=1)
