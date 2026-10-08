"""Pretend to be an ELRS TX module on a pseudo-terminal (test double for crsf-core).

Written independently of the C code so the two implementations check each other.
"""
import os
import select
import threading
import time
import tty


def crc8_d5(data):
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0xD5) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def frame(addr, body):
    """addr, len, body..., crc  where body starts with the type byte."""
    return bytes([addr, len(body) + 1]) + bytes(body) + bytes([crc8_d5(body)])


def unpack_channels(payload):
    bits, nbits, out, i = 0, 0, [], 0
    for _ in range(16):
        while nbits < 11:
            bits |= payload[i] << nbits
            nbits += 8
            i += 1
        out.append(bits & 0x7FF)
        bits >>= 11
        nbits -= 11
    return out


# Settings the fake module exposes through the parameter protocol (like the ELRS Lua menu).
# (id, parent, type, name, payload-after-name). Types: 9 text selection, 11 folder, 12 info,
# 13 command (status, timeout in 10 ms units, info text).
def _sel(options, value, unit=""):
    return options.encode() + b"\0" + bytes([value, 0, len(options.split(";")) - 1, value]) + unit.encode() + b"\0"


DEFAULT_PARAMS = [
    [1, 0, 9, "Packet Rate", "50Hz(-115dbm);;150Hz(-112dbm);250Hz(-108dbm);500Hz(-105dbm)", 3, ""],
    [2, 0, 9, "Telem Ratio", "Std;Off;1:128;1:64;1:32", 0, ""],
    [3, 0, 11, "TX Power", None, None, None],
    [4, 3, 9, "Max Power", "10;25;50;100;250;500;1000", 3, "mW"],
    [5, 3, 9, "Dynamic", "Off;Dyn;AUX9", 0, ""],
    [6, 0, 12, "Bad/Good", "0/250", None, None],
    [7, 0, 13, "Bind", 0, 200, ""],
]
CHUNK = 24   # bytes of field data per PARAMETER_ENTRY frame (forces multi-chunk reads)


class FakeTx:
    """ELRS TX stand-in.

    * answers device pings with DEVICE_INFO
    * records every RC_CHANNELS frame as (monotonic_time, [16 channel values])
    * once RC frames arrive, sends timing frames every 200 ms (interval/offset settable)
    * optionally sends link stats, battery and flight mode telemetry
    """

    def __init__(self, interval_us=4000.0, offset_us=0.0, name="FAKE TX"):
        self.master, self.slave = os.openpty()
        tty.setraw(self.slave)
        self.path = os.ttyname(self.slave)
        self.name = name
        self.interval_us = interval_us
        self.offset_us = offset_us
        self.flight_mode = None
        self.link_lq = 100          # a bound drone; None = no link reports (link lost)
        self.battery_dv = None
        self.rc = []
        self.model_selects = 0
        self.pings = 0
        self.params = [list(p) for p in DEFAULT_PARAMS]
        self.commands = []          # names of command parameters the tool started
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._buf = bytearray()
        self._closed = False
        self._threads = [threading.Thread(target=self._reader, daemon=True),
                         threading.Thread(target=self._talker, daemon=True)]
        for t in self._threads:
            t.start()

    # --- helpers for tests -------------------------------------------------
    def frames_since(self, t0):
        with self._lock:
            return [f for f in self.rc if f[0] >= t0]

    def last_channels(self):
        with self._lock:
            return self.rc[-1][1] if self.rc else None

    def wait_for(self, predicate, timeout=2.0):
        """Poll until predicate(last_channels) is true; returns the time it became true."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            ch = self.last_channels()
            if ch is not None and predicate(ch):
                return time.monotonic()
            time.sleep(0.002)
        return None

    def close(self):
        if self._closed:          # tests may unplug the module and then clean up
            return
        self._closed = True
        self._stop.set()
        for t in self._threads:
            t.join(timeout=1)
        os.close(self.master)
        os.close(self.slave)

    # --- internals -----------------------------------------------------------
    def _send(self, data):
        try:
            os.write(self.master, data)
        except OSError:
            pass

    def _device_info(self):
        body = [0x29, 0xEA, 0xEE] + list(self.name.encode()) + [0]
        body += list(b"ELRS") + [0, 0, 0, 0] + [0, 3, 5, 3] + [len(self.params), 0]
        return frame(0xEA, body)

    def param(self, name):
        return next(p for p in self.params if p[3] == name)

    def _param_data(self, p):
        pid, parent, ptype, name, a, b, c = p
        data = bytes([parent, ptype]) + name.encode() + b"\0"
        if ptype == 9:
            data += _sel(a, b, c)
        elif ptype == 11:
            data += bytes([q[0] for q in self.params if q[1] == pid] + [0xFF])
        elif ptype == 12:
            data += a.encode() + b"\0"
        elif ptype == 13:
            data += bytes([a, b]) + c.encode() + b"\0"
        return data

    def _param_entry(self, field, chunk):
        p = next((q for q in self.params if q[0] == field), None)
        if p is None:
            return
        data = self._param_data(p)
        chunks = [data[i:i + CHUNK] for i in range(0, len(data), CHUNK)]
        if chunk >= len(chunks):
            return
        body = [0x2B, 0xEF, 0xEE, field, len(chunks) - 1 - chunk] + list(chunks[chunk])
        self._send(frame(0xEA, body))

    def _handle(self, f):
        ftype = f[2]
        if ftype == 0x16 and len(f) == 26:
            with self._lock:
                self.rc.append((time.monotonic(), unpack_channels(f[3:25])))
        elif ftype == 0x28:
            self.pings += 1
            self._send(self._device_info())
        elif ftype == 0x32 and len(f) >= 8 and f[5] == 0x10 and f[6] == 0x05:
            self.model_selects += 1
        elif ftype == 0x2C and len(f) == 8:
            self._param_entry(f[5], f[6])
        elif ftype == 0x2D and len(f) == 8:
            p = next((q for q in self.params if q[0] == f[5]), None)
            if p is not None and p[2] == 9:
                p[5] = f[6]
            elif p is not None and p[2] == 13 and f[6] == 1:      # 1 = "click" (start the command)
                self.commands.append(p[3])

    def _reader(self):
        while not self._stop.is_set():
            r, _, _ = select.select([self.master], [], [], 0.05)
            if not r:
                continue
            try:
                self._buf += os.read(self.master, 512)
            except OSError:
                return
            while len(self._buf) >= 2:
                if self._buf[0] not in (0xEE, 0xC8, 0xEA):
                    del self._buf[0]
                    continue
                total = self._buf[1] + 2
                if self._buf[1] < 2 or total > 64:
                    del self._buf[0]
                    continue
                if len(self._buf) < total:
                    break
                f = bytes(self._buf[:total])
                if crc8_d5(f[2:-1]) == f[-1]:
                    self._handle(f)
                    del self._buf[:total]
                else:
                    del self._buf[0]

    def _talker(self):
        next_sync = next_tel = time.monotonic()
        while not self._stop.is_set():
            now = time.monotonic()
            with self._lock:
                streaming = bool(self.rc) and now - self.rc[-1][0] < 0.5
            if streaming and now >= next_sync:
                rate = int(self.interval_us * 10)
                off = int(self.offset_us * 10) & 0xFFFFFFFF
                body = [0x3A, 0xEA, 0xEE, 0x10] + list(rate.to_bytes(4, "big")) + list(off.to_bytes(4, "big"))
                self._send(frame(0xEA, body))
                next_sync = now + 0.2
            if now >= next_tel:
                if self.link_lq is not None:
                    self._send(frame(0xEA, [0x14, 0xBD, 0xBA, self.link_lq, 9, 1, 7, 3, 0xC9, 98, 0xFC]))
                if self.battery_dv is not None:
                    v = self.battery_dv
                    self._send(frame(0xEA, [0x08, v >> 8, v & 0xFF, 0, 45, 0, 4, 0xD2, 87]))
                if self.flight_mode is not None:
                    self._send(frame(0xEA, [0x21] + list(self.flight_mode.encode()) + [0]))
                next_tel = now + 0.1
            time.sleep(0.005)
