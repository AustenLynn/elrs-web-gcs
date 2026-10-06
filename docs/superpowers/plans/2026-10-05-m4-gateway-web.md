# M4: Gateway and Pilot Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fly from a browser: an HTTPS + WebSocket gateway on the Pi that turns pilot pages into crsf-core commands (one pilot, observers, stale-command filter), and a phone-friendly pilot page with virtual sticks, hold-to-arm, a dead-man rule, link indicators and telemetry, proven end to end in a real browser.

**Architecture:** `gateway/` (Node) talks to crsf-core over the Unix socket of spec §4.1 (`ipc.js`, the JavaScript twin of `ipc_proto.c`) and to browsers over the WebSocket protocol of §4.2 (`hub.js`, pure logic with an injected clock). `server.js` only wires sockets, HTTPS and static files to the hub. `web/` keeps every decision in small pure modules tested in Node; `app.js` only wires them to the DOM. A headless-Firefox test drives the real page against the real crsf-core and the fake module.

**Tech Stack:** Node 22 with its built-in test runner (`node --test`); the only npm dependency is `ws` pinned at 8.22.0. The web app is plain ES modules with no build step and no framework. Browser test: headless Firefox driven over WebDriver BiDi.

**Spec:** `docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md` (read it first; section numbers below refer to it)

**Before you start:** Milestone 3 is done (`make -C core test` and `make -C core integration` pass; crsf-core is installed on the Pi). Read spec §3, §4.1, §4.2, §6.2, §6.3 and §7. Install Firefox (`sudo apt install firefox-esr` if `firefox --version` fails) and check `node --version` prints v22 or later. Tasks 1–9 need no hardware. Task 10 needs the bench of Milestone 3, a PC and an Android phone.

## Global Constraints

- Work in `~/ProyectoTerminal/elrs-web-gcs` on branch `main`; run every command from the repository root.
- Target: Raspberry Pi 4, Debian 13 arm64, gcc 14 (`-std=gnu11`), GNU make, Python 3.13 standard library only.
- Every file below was compiled and tested on that Pi before this plan was written: type it exactly. If a step's output differs from **Expected**, stop and find out why; do not edit a test to make it pass.
- **Propellers off** for every step that touches real hardware.
- Expected output is quoted in English; tools print some messages (compiler, `make`, Python errors) in the system's language.
- Node 22 with its built-in test runner (`node --test`); the only npm dependency is `ws` pinned at 8.22.0. The web app is plain ES modules with no build step and no framework.
- The gateway never decides what the aircraft does. It forwards, filters and reports. Every safety rule stays in crsf-core: if the gateway dies, the core fails safe.
- One pilot at a time; later connections become observers. Each pilot connection gets a new random 32-bit session, so nothing from an old connection is ever accepted again.
- WebSocket limits: frames ≤ 4 KiB (`maxPayload`), ≤ 120 messages/s per client, heartbeat drops dead sockets within 2 s. Control messages older than `maxCommandAgeMs` (200) are dropped once the clock offset is known.
- Dead-man rule: the page sends nothing until the pilot taps «Tomar control», and stops for good (until tapped again) when the page is hidden, loses focus or loses its connection.
- All text the pilot sees is Spanish; code, comments and logs are English.

## Review Focus

Inputs and failure modes most likely to hurt a real user; each is pinned by a test in the task named.

1. Repeated, out-of-order or malformed control messages never reach the core (Task 3, `malformed or repeated control messages never reach the core`).
2. Commands delayed on Wi-Fi are dropped rather than flown late (Tasks 2–3, `stale commands are dropped once the clock offset is known`, `uses the sample with the smallest round trip`).
3. A second browser cannot take over a flying aircraft (Task 3, `a second pilot becomes an observer and cannot send commands`).
4. The pilot's browser disappears → the core hears `PILOT_LOST` at once, not after a timeout (Task 3, `pilot disconnect reports pilot lost and frees the pilot seat`).
5. Hostile or broken clients (huge frames, binary, bad JSON, `../` paths, floods) cannot crash the gateway or read files outside `web/` (Task 5, `an oversized frame closes that socket and the gateway keeps running`, `serves the web app and refuses to escape the web root`; Task 3, `a flooding client is rate limited`).
6. The phone's screen goes off or the pilot switches app → the page stops sending and the aircraft fails safe in < 1 s (Task 7, `hiding the page, losing focus or the connection disengages, and it stays off`; Task 8, the browser end-to-end test).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `gateway/package.json, package-lock.json` | gateway package (`ws` 8.22.0); `npm test` also runs the web tests |
| `gateway/src/ipc.js` | core socket protocol: codec twin of `ipc_proto.c`, reconnecting client |
| `gateway/src/clock.js` | browser ↔ gateway clock offset from `tsync` round trips |
| `gateway/src/hub.js` | ControlHub: roles, sessions, validation, stale filter, rate limit, broadcast |
| `gateway/src/config.js` | gateway settings (JSON over defaults) with validation |
| `gateway/src/static.js` | static files, GET/HEAD only, no path escape |
| `gateway/src/server.js, main.js` | HTTP(S) + WebSocket server wiring; entry point |
| `gateway/test/*.test.js` | unit and socket-level tests |
| `gateway/e2e/helpers.js, pilot.e2e.js` | headless-Firefox end-to-end test |
| `web/index.html, css/app.css, js/app.js` | pilot page and its DOM wiring |
| `web/js/protocol.js, sticks.js, deadman.js, hold.js, view.js` | pure page logic |
| `web/test/*.test.js` | unit tests for the page logic |
| `core/tests/integration/fake_tx_cli.py` | fake module as a process (for the browser test) |
| `deploy/gateway.json, gcs-gateway.service, make-cert.sh, install.sh` | deployment |
| `docs/procedures/m4-pilot-checklist.md` | hands-on checklist on PC and phone |

### Task 1: Gateway package and the core protocol twin

`npm test` also globs `../web/test`; that glob matches nothing until Task 6 and is then picked up automatically.

**Files:**
- Create: `gateway/package.json`
- Create: `gateway/src/ipc.js`
- Test: `gateway/test/ipc.test.js`

**Interfaces:**
- Consumes: the socket protocol of spec §4.1 and the golden bytes of `core/tests/test_ipc_proto.c`
- Produces: `MSG`, `STATES`, `REASONS`, `FC_ARM`, `REFUSALS`, `encodeSessionMsg(type, session)`, `encodeControl({session, seq, roll, pitch, yaw, throttle, mode})`, `decodeStatus`, `decodeLink`, `decodeBattery`, `decodeFlightMode`, `decodeDevice`, `decodeEvent`, `FrameReader.push(buf)` → messages, `CoreClient(path)` (EventEmitter: `status`, `telemetry`, `event`, `up`, `down`; `.connected`, `.start()`, `.stop()`, and the senders `.sessionStart(session)`, `.control(session, seq, sticks)`, `.arm|disarm|ack|pilotLost|failsafe(session)`)

- [ ] **Step 1: Create the package**

Create `gateway/package.json`:

```json
{
  "name": "gcs-gateway",
  "version": "0.1.0",
  "private": true,
  "description": "HTTPS + WebSocket gateway between the pilot web app and crsf-core",
  "type": "module",
  "main": "src/main.js",
  "scripts": {
    "start": "node src/main.js",
    "test": "node --test \"test/*.test.js\" \"../web/test/*.test.js\"",
    "e2e": "node --test \"e2e/*.e2e.js\""
  },
  "engines": {
    "node": ">=22"
  },
  "dependencies": {
    "ws": "8.22.0"
  }
}
```

- [ ] **Step 2: Install the dependency**

Run: `npm --prefix gateway install`

Expected: `added 1 package`; `gateway/package-lock.json` now exists (it is committed, so every install gets exactly `ws` 8.22.0)

- [ ] **Step 3: Write the failing test**

Create `gateway/test/ipc.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CoreClient, FrameReader, MSG, decodeBattery, decodeDevice, decodeEvent, decodeFlightMode,
  decodeLink, decodeStatus, encodeControl, encodeSessionMsg,
} from '../src/ipc.js';

// Same bytes as CONTROL_GOLDEN in core/tests/test_ipc_proto.c
const CONTROL_GOLDEN = Buffer.from([
  0x12, 0x00, 0x02, 0x04, 0x03, 0x02, 0x01, 0x05, 0x00, 0x00, 0x00,
  0x18, 0xfc, 0xfa, 0x00, 0x00, 0x00, 0xe8, 0x03, 0x02,
]);
// Produced by the C encoder (ipc_encode_status) for the sample in core/tests/test_ipc_proto.c
const STATUS_GOLDEN = Buffer.from([
  0x51, 0x00, 0x81, 0x02, 0x01, 0x02, 0x01, 0x04, 0x03, 0x02, 0x01, 0x63,
  0x00, 0x00, 0x00, 0x2d, 0x01, 0x00, 0x00, 0xe8, 0x03, 0x00, 0x00, 0x02,
  0x00, 0x00, 0x00, 0x32, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0xa0,
  0x0f, 0x00, 0x00, 0x2e, 0xfb, 0xff, 0xff, 0x07, 0x00, 0x00, 0x00, 0x55,
  0x00, 0x00, 0x00, 0xac, 0x00, 0xad, 0x00, 0xae, 0x00, 0xaf, 0x00, 0xb0,
  0x00, 0xb1, 0x00, 0xb2, 0x00, 0xb3, 0x00, 0xb4, 0x00, 0xb5, 0x00, 0xb6,
  0x00, 0xb7, 0x00, 0xb8, 0x00, 0xb9, 0x00, 0xba, 0x00, 0xbb, 0x00,
]);

test('control message matches the C encoder byte for byte', () => {
  const buf = encodeControl({ session: 0x01020304, seq: 5, roll: -1000, pitch: 250, yaw: 0, throttle: 1000, mode: 2 });
  assert.deepEqual(buf, CONTROL_GOLDEN);
});

test('session-style messages', () => {
  assert.deepEqual(encodeSessionMsg(MSG.ARM, 77), Buffer.from([0x05, 0x00, 0x03, 77, 0, 0, 0]));
});

test('decodes the STATUS produced by the C encoder', () => {
  const [msg] = new FrameReader().push(STATUS_GOLDEN);
  assert.equal(msg.type, MSG.STATUS);
  const s = decodeStatus(msg.payload);
  assert.equal(s.state, 'FAILSAFE');
  assert.equal(s.reason, 'cmd_timeout');
  assert.equal(s.fcArm, 'armed');
  assert.equal(s.serialOk, true);
  assert.equal(s.session, 0x01020304);
  assert.equal(s.lastSeq, 99);
  assert.equal(s.cmdAgeMs, 301);
  assert.equal(s.framesSent, 1000);
  assert.equal(s.periodUs, 4000);
  assert.equal(s.offsetUs, -123.4);
  assert.equal(s.wakeLateMaxUs, 85);
  assert.deepEqual(s.channels, Array.from({ length: 16 }, (_, i) => 172 + i));
});

test('no-command age decodes as null', () => {
  const p = Buffer.from(STATUS_GOLDEN.subarray(3));
  p.writeUInt32LE(0xffffffff, 12);
  assert.equal(decodeStatus(p).cmdAgeMs, null);
});

test('telemetry decoders', () => {
  assert.deepEqual(decodeLink(Buffer.from([0xbd, 0xba, 100, 9, 1, 7, 100, 0, 0xc9, 98, 0xfc])), {
    upRssi1: -67, upRssi2: -70, upLq: 100, upSnr: 9, antenna: 1, rfMode: 7, txPowerMw: 100, dnRssi: -55, dnLq: 98, dnSnr: -4,
  });
  assert.deepEqual(decodeBattery(Buffer.from([168, 0, 45, 0, 0xd2, 0x04, 0, 0, 87])), {
    voltage: 16.8, current: 4.5, capacityMah: 1234, remainingPct: 87,
  });
  assert.equal(decodeFlightMode(Buffer.from([5, ...Buffer.from('ACRO*')])), 'ACRO*');
  assert.deepEqual(decodeDevice(Buffer.from([0xee, 3, 5, 3, 0x53, 0x52, 0x4c, 0x45, 3, ...Buffer.from('FAK')])), {
    origin: 0xee, version: '3.5.3', serial: 0x454c5253, name: 'FAK',
  });
  assert.deepEqual(decodeEvent(Buffer.from([1, 5, 9, 0, 0, 0])), { what: 'arm', refused: 'throttle_high', session: 9 });
  assert.throws(() => decodeLink(Buffer.alloc(3)), RangeError);
  assert.throws(() => decodeFlightMode(Buffer.from([9, 65])), RangeError);
});

test('frame reader handles split and batched input, rejects bad lengths', () => {
  const r = new FrameReader();
  const both = Buffer.concat([encodeSessionMsg(MSG.SESSION, 1), CONTROL_GOLDEN]);
  const got = [];
  for (const b of both) got.push(...r.push(Buffer.from([b])));
  assert.deepEqual(got.map((m) => m.type), [MSG.SESSION, MSG.CONTROL]);
  assert.equal(new FrameReader().push(both).length, 2);
  assert.throws(() => new FrameReader().push(Buffer.from([0x00, 0x00])), /corrupt/);
  assert.throws(() => new FrameReader().push(Buffer.from([0x00, 0x01])), /corrupt/);
});

test('core client connects, decodes, sends and reconnects', async (t) => {
  const sockPath = path.join(mkdtempSync(path.join(tmpdir(), 'gcs-')), 'core.sock');
  const received = [];
  let serverSide;
  const server = net.createServer((s) => {
    serverSide = s;
    const r = new FrameReader();
    s.on('data', (d) => received.push(...r.push(d)));
  });
  await new Promise((resolve) => server.listen(sockPath, resolve));
  t.after(() => server.close());

  const client = new CoreClient(sockPath, { reconnectMs: 50 });
  t.after(() => client.stop());
  const up = new Promise((resolve) => client.once('up', resolve));
  client.start();
  await up;

  const status = new Promise((resolve) => client.once('status', resolve));
  serverSide.write(STATUS_GOLDEN.subarray(0, 10));
  serverSide.write(STATUS_GOLDEN.subarray(10));
  assert.equal((await status).state, 'FAILSAFE');

  client.control(0x01020304, 5, { roll: -1000, pitch: 250, yaw: 0, throttle: 1000, mode: 2 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].payload, CONTROL_GOLDEN.subarray(3));

  const down = new Promise((resolve) => client.once('down', resolve));
  const upAgain = new Promise((resolve) => client.once('up', resolve));
  serverSide.destroy();
  await down;
  await upAgain;
  assert.equal(client.connected, true);
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `npm --prefix gateway test`

Expected: FAIL: `Cannot find module '…/gateway/src/ipc.js' imported from …/gateway/test/ipc.test.js`, then `# tests 1`, `# pass 0`, `# fail 1`

- [ ] **Step 5: Write the implementation**

Create `gateway/src/ipc.js`:

```js
// Twin of core/src/ipc_proto.h: messages between the gateway and crsf-core over a Unix
// stream socket. Each message: u16 little-endian length (type + payload), u8 type, payload.
import { EventEmitter } from 'node:events';
import net from 'node:net';

export const MSG = Object.freeze({
  SESSION: 0x01, CONTROL: 0x02, ARM: 0x03, DISARM: 0x04, ACK: 0x05, PILOT_LOST: 0x06, FAILSAFE: 0x07,
  STATUS: 0x81, LINK: 0x82, BATTERY: 0x83, FLIGHT_MODE: 0x84, DEVICE: 0x85, EVENT: 0x86,
});
export const STATES = ['DISARMED', 'ARMED', 'FAILSAFE'];
export const REASONS = ['none', 'cmd_timeout', 'pilot_lost', 'gateway_lost', 'session_changed', 'manual'];
export const FC_ARM = ['unknown', 'disarmed', 'armed'];
export const REFUSALS = ['none', 'wrong_session', 'not_disarmed', 'not_in_failsafe', 'link_stale',
  'throttle_high', 'fc_still_armed'];

const MAX_MSG = 255;
const NO_CMD_AGE = 0xffffffff;

function frame(type, payload = Buffer.alloc(0)) {
  const out = Buffer.alloc(3 + payload.length);
  out.writeUInt16LE(payload.length + 1, 0);
  out[2] = type;
  payload.copy(out, 3);
  return out;
}

function expectLength(p, n, what) {
  if (p.length !== n) throw new RangeError(`${what} payload must be ${n} bytes, got ${p.length}`);
}

export function encodeSessionMsg(type, session) {
  const p = Buffer.alloc(4);
  p.writeUInt32LE(session >>> 0, 0);
  return frame(type, p);
}

export function encodeControl({ session, seq, roll, pitch, yaw, throttle, mode }) {
  const p = Buffer.alloc(17);
  p.writeUInt32LE(session >>> 0, 0);
  p.writeUInt32LE(seq >>> 0, 4);
  p.writeInt16LE(roll, 8);
  p.writeInt16LE(pitch, 10);
  p.writeInt16LE(yaw, 12);
  p.writeUInt16LE(throttle, 14);
  p.writeUInt8(mode, 16);
  return frame(MSG.CONTROL, p);
}

export function decodeStatus(p) {
  expectLength(p, 80, 'STATUS');
  const cmdAge = p.readUInt32LE(12);
  const channels = [];
  for (let i = 0; i < 16; i++) channels.push(p.readUInt16LE(48 + 2 * i));
  return {
    state: STATES[p[0]] ?? 'UNKNOWN',
    reason: REASONS[p[1]] ?? 'unknown',
    fcArm: FC_ARM[p[2]] ?? 'unknown',
    serialOk: p[3] === 1,
    session: p.readUInt32LE(4),
    lastSeq: p.readUInt32LE(8),
    cmdAgeMs: cmdAge === NO_CMD_AGE ? null : cmdAge,
    framesSent: p.readUInt32LE(16),
    txErrors: p.readUInt32LE(20),
    rxFrames: p.readUInt32LE(24),
    rxCrcErrors: p.readUInt32LE(28),
    periodUs: p.readUInt32LE(32),
    offsetUs: p.readInt32LE(36) / 10,
    timingFrames: p.readUInt32LE(40),
    wakeLateMaxUs: p.readUInt32LE(44),
    channels,
  };
}

export function decodeLink(p) {
  expectLength(p, 11, 'LINK');
  return {
    upRssi1: p.readInt8(0), upRssi2: p.readInt8(1), upLq: p[2], upSnr: p.readInt8(3),
    antenna: p[4], rfMode: p[5], txPowerMw: p.readUInt16LE(6),
    dnRssi: p.readInt8(8), dnLq: p[9], dnSnr: p.readInt8(10),
  };
}

export function decodeBattery(p) {
  expectLength(p, 9, 'BATTERY');
  return {
    voltage: p.readUInt16LE(0) / 10,
    current: p.readUInt16LE(2) / 10,
    capacityMah: p.readUInt32LE(4),
    remainingPct: p[8],
  };
}

export function decodeFlightMode(p) {
  if (p.length < 1 || 1 + p[0] > p.length) throw new RangeError('bad FLIGHT_MODE payload');
  return p.subarray(1, 1 + p[0]).toString('latin1');
}

export function decodeDevice(p) {
  if (p.length < 9 || 9 + p[8] > p.length) throw new RangeError('bad DEVICE payload');
  return {
    origin: p[0],
    version: `${p[1]}.${p[2]}.${p[3]}`,
    serial: p.readUInt32LE(4),
    name: p.subarray(9, 9 + p[8]).toString('latin1'),
  };
}

export function decodeEvent(p) {
  expectLength(p, 6, 'EVENT');
  return { what: p[0] === 1 ? 'arm' : 'ack', refused: REFUSALS[p[1]] ?? 'unknown', session: p.readUInt32LE(2) };
}

/** Splits the byte stream from the core into messages. */
export class FrameReader {
  #buf = Buffer.alloc(0);

  /** Returns the complete messages so far; throws if the stream is corrupt. */
  push(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out = [];
    while (this.#buf.length >= 2) {
      const len = this.#buf.readUInt16LE(0);
      if (len < 1 || len > MAX_MSG) throw new Error(`corrupt core stream (length ${len})`);
      if (this.#buf.length < 2 + len) break;
      out.push({ type: this.#buf[2], payload: this.#buf.subarray(3, 2 + len) });
      this.#buf = this.#buf.subarray(2 + len);
    }
    return out;
  }
}

/**
 * Connection to crsf-core. Reconnects forever.
 * Events: 'up', 'down', 'status' (obj), 'telemetry' (kind, obj), 'event' (obj).
 */
export class CoreClient extends EventEmitter {
  #sock = null;
  #timer = null;
  #stopped = false;

  constructor(path, { reconnectMs = 500 } = {}) {
    super();
    this.path = path;
    this.reconnectMs = reconnectMs;
    this.connected = false;
  }

  start() {
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#sock?.destroy();
  }

  #connect() {
    const sock = net.createConnection(this.path);
    const reader = new FrameReader();
    this.#sock = sock;
    sock.on('connect', () => {
      this.connected = true;
      this.emit('up');
    });
    sock.on('data', (chunk) => {
      let msgs;
      try {
        msgs = reader.push(chunk);
      } catch (err) {
        sock.destroy(err);
        return;
      }
      for (const m of msgs) this.#dispatch(m);
    });
    sock.on('error', () => {}); // 'close' always follows
    sock.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.#sock = null;
      if (wasConnected) this.emit('down');
      if (!this.#stopped) this.#timer = setTimeout(() => this.#connect(), this.reconnectMs);
    });
  }

  #dispatch({ type, payload }) {
    try {
      switch (type) {
        case MSG.STATUS: this.emit('status', decodeStatus(payload)); break;
        case MSG.LINK: this.emit('telemetry', 'link', decodeLink(payload)); break;
        case MSG.BATTERY: this.emit('telemetry', 'battery', decodeBattery(payload)); break;
        case MSG.FLIGHT_MODE: this.emit('telemetry', 'flightMode', decodeFlightMode(payload)); break;
        case MSG.DEVICE: this.emit('telemetry', 'device', decodeDevice(payload)); break;
        case MSG.EVENT: this.emit('event', decodeEvent(payload)); break;
        default: break; // unknown message from a newer core: ignore
      }
    } catch {
      // malformed message: ignore it, the stream itself is still in sync
    }
  }

  #send(buf) {
    if (this.connected) this.#sock.write(buf);
  }

  sessionStart(session) { this.#send(encodeSessionMsg(MSG.SESSION, session)); }
  control(session, seq, sticks) { this.#send(encodeControl({ session, seq, ...sticks })); }
  arm(session) { this.#send(encodeSessionMsg(MSG.ARM, session)); }
  disarm(session) { this.#send(encodeSessionMsg(MSG.DISARM, session)); }
  ack(session) { this.#send(encodeSessionMsg(MSG.ACK, session)); }
  pilotLost(session) { this.#send(encodeSessionMsg(MSG.PILOT_LOST, session)); }
  failsafe(session) { this.#send(encodeSessionMsg(MSG.FAILSAFE, session)); }
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npm --prefix gateway test`

Expected: PASS: `# tests 7`, `# pass 7`, `# fail 0`

- [ ] **Step 7: Commit**

```bash
git add gateway/package-lock.json gateway/package.json gateway/src/ipc.js gateway/test/ipc.test.js
git commit -m "gateway: package and core socket protocol (twin of ipc_proto.c)"
```

### Task 2: Clock sync

**Files:**
- Create: `gateway/src/clock.js`
- Test: `gateway/test/clock.test.js`

**Interfaces:**
- Consumes: `tsync {s0}` / `tsync_r {s0, c1}` exchanges (spec §4.2)
- Produces: `ClockSync(window = 8)` with `.add(s0, c1, s2)`, `.ready`, `.rtt`, `.offset`, `.age(ts, now)` (ms, or null before the first sample)

- [ ] **Step 1: Write the failing test**

Create `gateway/test/clock.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClockSync } from '../src/clock.js';

test('offset and command age with a browser clock 4000 ms ahead', () => {
  const c = new ClockSync();
  assert.equal(c.ready, false);
  c.add(1000, 5050, 1100);          // 50 ms each way
  assert.equal(c.ready, true);
  assert.equal(c.rtt, 100);
  assert.equal(c.offset, 4000);
  // sent at browser time 5060 (= our 1060), arrives at our 1110: 50 ms old
  assert.equal(c.age(5060, 1110), 50);
});

test('uses the sample with the smallest round trip', () => {
  const c = new ClockSync();
  c.add(0, 4100, 200);              // slow sample: offset estimate 4000, rtt 200
  c.add(1000, 5010, 1020);          // fast sample: offset 4000, rtt 20
  c.add(2000, 6300, 2400);          // asymmetric slow sample would say 4100
  assert.equal(c.rtt, 20);
  assert.equal(c.offset, 4000);
});

test('window keeps only recent samples and ignores negative round trips', () => {
  const c = new ClockSync(2);
  c.add(0, 10, 2);                  // rtt 2, will fall out of the window
  c.add(100, 110, 150);
  c.add(200, 210, 260);
  assert.equal(c.rtt, 50);
  c.add(500, 0, 400);               // s2 < s0: ignored
  assert.equal(c.samples.length, 2);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm --prefix gateway test`

Expected: FAIL: `Cannot find module '…/gateway/src/clock.js' imported from …/gateway/test/clock.test.js`, then `# tests 8`, `# pass 7`, `# fail 1`

- [ ] **Step 3: Write the implementation**

Create `gateway/src/clock.js`:

```js
// Estimates the offset between a browser's clock (performance.now()) and ours, so we can
// tell how old a control command is when it arrives (FMEA #3: never apply stale commands).
//
// We send {s0}; the browser answers with its own time c1; we receive at s2.
// Assuming equal delay both ways: offset = c1 - (s0 + s2) / 2, error <= RTT / 2.
// The sample with the smallest RTT in the recent window is the most trustworthy.
export class ClockSync {
  constructor(window = 8) {
    this.window = window;
    this.samples = [];
  }

  add(s0, c1, s2) {
    const rtt = s2 - s0;
    if (!(rtt >= 0)) return; // reply to a ping we never sent, or a clock glitch
    this.samples.push({ rtt, offset: c1 - (s0 + s2) / 2 });
    if (this.samples.length > this.window) this.samples.shift();
  }

  get ready() {
    return this.samples.length > 0;
  }

  #best() {
    return this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  }

  get rtt() {
    return this.#best().rtt;
  }

  get offset() {
    return this.#best().offset;
  }

  /** Age in ms, on our clock, of a command the browser stamped with `ts`. */
  age(ts, now) {
    return now - (ts - this.offset);
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npm --prefix gateway test`

Expected: PASS: `# tests 10`, `# pass 10`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add gateway/src/clock.js gateway/test/clock.test.js
git commit -m "gateway: clock offset from round trips (minimum-RTT sample)"
```

### Task 3: ControlHub

The hub is pure: sockets, time and session numbers are injected, so every rule of spec §4.2 is tested without a network.

**Files:**
- Create: `gateway/src/hub.js`
- Test: `gateway/test/hub.test.js`

**Interfaces:**
- Consumes: `ClockSync`, the `ipc.js` encoders
- Produces: `ControlHub({core, maxCommandAgeMs = 200, now, newSession})` with `.attach(client)`, `.detach(client)`, `.handle(client, msg)`, `.tick()` (tsync every 2 s), `.onCoreStatus(status)`, `.onCoreDown()`, `.onCoreTelemetry(kind, value)`, `.onCoreEvent(ev)`; a client is `{ send(obj), close(code, reason) }`

- [ ] **Step 1: Write the failing test**

Create `gateway/test/hub.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControlHub } from '../src/hub.js';

function fakeCore() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    sessionStart: rec('sessionStart'), control: rec('control'), arm: rec('arm'), disarm: rec('disarm'),
    ack: rec('ack'), pilotLost: rec('pilotLost'), failsafe: rec('failsafe'),
  };
}

function fakeClient() {
  const sent = [];
  return { sent, send: (m) => sent.push(m), close: () => {}, last: (t) => sent.filter((m) => m.t === t).at(-1) };
}

function setup({ maxCommandAgeMs = 200 } = {}) {
  let now = 1000;
  let nextSession = 41;
  const core = fakeCore();
  const hub = new ControlHub({ core, maxCommandAgeMs, now: () => now, newSession: () => ++nextSession });
  return { hub, core, clock: { get: () => now, set: (v) => { now = v; } } };
}

function join(hub, role = 'pilot') {
  const c = fakeClient();
  hub.attach(c);
  hub.handle(c, { t: 'hello', role });
  return c;
}

const ctl = (seq, extra = {}) => ({ t: 'ctl', seq, ts: 0, r: 0, p: 0, y: 0, th: 0, m: 0, ...extra });

test('first pilot gets a session and the core is told', () => {
  const { hub, core } = setup();
  const p = join(hub);
  assert.deepEqual(p.sent[0], { t: 'welcome', role: 'pilot', session: 42 });
  assert.equal(p.sent[1].t, 'tsync');
  assert.deepEqual(core.calls, [['sessionStart', 42]]);
});

test('a second pilot becomes an observer and cannot send commands', () => {
  const { hub, core } = setup();
  join(hub);
  const o = join(hub);
  assert.deepEqual(o.sent[0], { t: 'welcome', role: 'observer', reason: 'pilot_present' });
  hub.handle(o, { t: 'arm' });
  assert.equal(o.last('error').msg, 'observers cannot send commands');
  assert.equal(core.calls.filter((c) => c[0] === 'arm').length, 0);
});

test('messages before hello are refused', () => {
  const { hub, core } = setup();
  const c = fakeClient();
  hub.attach(c);
  hub.handle(c, ctl(1));
  assert.equal(c.last('error').msg, 'send hello first');
  assert.equal(core.calls.length, 0);
});

test('valid control messages are forwarded with the session', () => {
  const { hub, core } = setup();
  const p = join(hub);
  hub.handle(p, ctl(1, { r: -1000, p: 250, y: 3, th: 1000, m: 2 }));
  assert.deepEqual(core.calls.at(-1), ['control', 42, 1, { roll: -1000, pitch: 250, yaw: 3, throttle: 1000, mode: 2 }]);
});

test('malformed or repeated control messages never reach the core', () => {
  const { hub, core } = setup();
  const p = join(hub);
  hub.handle(p, ctl(5));
  for (const bad of [ctl(5), ctl(4), ctl(6, { r: 1001 }), ctl(6, { th: -1 }), ctl(6, { m: 3 }),
    ctl(6, { p: 0.5 }), ctl(6, { ts: 'x' }), { t: 'ctl', seq: 6 }, ctl(2 ** 32)]) {
    hub.handle(p, bad);
  }
  assert.equal(core.calls.filter((c) => c[0] === 'control').length, 1);
});

test('stale commands are dropped once the clock offset is known', () => {
  const { hub, core, clock } = setup({ maxCommandAgeMs: 200 });
  const p = join(hub);
  const s0 = p.last('tsync').s0;        // 1000
  clock.set(1010);
  hub.handle(p, { t: 'tsync_r', s0, c1: 50005 });   // browser clock ~49000 ahead, rtt 10
  clock.set(2000);
  hub.handle(p, ctl(1, { ts: 50900 }));  // browser 50900 = our 1900: 100 ms old -> ok
  hub.handle(p, ctl(2, { ts: 50700 }));  // our 1700: 300 ms old -> dropped
  const controls = core.calls.filter((c) => c[0] === 'control');
  assert.deepEqual(controls.map((c) => c[2]), [1]);
  hub.onCoreStatus({ state: 'DISARMED' });
  assert.equal(p.last('status').staleDropped, 1);
  assert.equal(p.last('status').rttMs, 10);
});

test('pilot buttons are forwarded with the session', () => {
  const { hub, core } = setup();
  const p = join(hub);
  for (const t of ['arm', 'disarm', 'ack', 'failsafe']) hub.handle(p, { t });
  assert.deepEqual(core.calls.slice(1), [['arm', 42], ['disarm', 42], ['ack', 42], ['failsafe', 42]]);
});

test('pilot disconnect reports pilot lost and frees the pilot seat', () => {
  const { hub, core } = setup();
  const p = join(hub);
  const o = join(hub, 'observer');
  hub.detach(p);
  assert.deepEqual(core.calls.at(-1), ['pilotLost', 42]);
  assert.equal(o.last('status').pilot, false);
  const p2 = join(hub);
  assert.equal(p2.sent[0].session, 43);
});

test('status and telemetry are broadcast, cached and replayed', () => {
  const { hub } = setup();
  const p = join(hub);
  hub.onCoreTelemetry('battery', { voltage: 16.8 });
  hub.onCoreStatus({ state: 'ARMED', reason: 'none' });
  assert.deepEqual(p.last('telem'), { t: 'telem', battery: { voltage: 16.8 } });
  assert.equal(p.last('status').state, 'ARMED');
  assert.equal(p.last('status').core, true);
  const late = join(hub, 'observer');
  assert.deepEqual(late.sent.find((m) => m.t === 'telem'), { t: 'telem', battery: { voltage: 16.8 } });
  assert.equal(late.last('status').state, 'ARMED');
  hub.onCoreDown();
  assert.equal(p.last('status').core, false);
  assert.equal(p.last('status').state, undefined);
});

test('core events reach the browsers', () => {
  const { hub } = setup();
  const p = join(hub);
  hub.onCoreEvent({ what: 'arm', refused: 'throttle_high', session: 42 });
  assert.deepEqual(p.last('event'), { t: 'event', what: 'arm', refused: 'throttle_high' });
});

test('ping is answered with our time', () => {
  const { hub } = setup();
  const p = join(hub, 'observer');
  hub.handle(p, { t: 'ping', id: 7, ts: 123 });
  assert.deepEqual(p.last('pong'), { t: 'pong', id: 7, ts: 123, srv: 1000 });
});

test('a flooding client is rate limited', () => {
  const { hub, core, clock } = setup();
  const p = join(hub);                 // hello used 1 message of the budget
  for (let seq = 1; seq <= 200; seq++) hub.handle(p, ctl(seq));
  assert.equal(core.calls.filter((c) => c[0] === 'control').length, 119);
  clock.set(2001);
  hub.handle(p, ctl(201));
  assert.equal(core.calls.filter((c) => c[0] === 'control').length, 120);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm --prefix gateway test`

Expected: FAIL: `Cannot find module '…/gateway/src/hub.js' imported from …/gateway/test/hub.test.js`, then `# tests 11`, `# pass 10`, `# fail 1`

- [ ] **Step 3: Write the implementation**

Create `gateway/src/hub.js`:

```js
// ControlHub: decides who the pilot is, what reaches crsf-core, and what every browser sees.
//  - Exactly one pilot; everyone else is an observer. No take-over while a pilot is connected.
//  - Every new pilot gets a fresh random session id; the core treats a session change
//    while armed as a failsafe, and a closed pilot connection as "pilot lost".
//  - Control messages are validated, de-duplicated and dropped when older than
//    maxCommandAgeMs (age estimated with ClockSync).
import { randomInt } from 'node:crypto';
import { ClockSync } from './clock.js';

const MAX_MSGS_PER_SEC = 120; // the pilot page sends 50 control messages per second

const defaultNow = () => performance.now();
const randomSession = () => randomInt(1, 0xffffffff);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const round1 = (v) => Math.round(v * 10) / 10;

export class ControlHub {
  constructor({ core, maxCommandAgeMs = 200, now = defaultNow, newSession = randomSession }) {
    this.core = core;
    this.maxCommandAgeMs = maxCommandAgeMs;
    this.now = now;
    this.newSession = newSession;
    this.clients = new Map();
    this.pilot = null;
    this.telemetry = {};
    this.lastStatus = null;
    this.staleDropped = 0;
  }

  /** client: { send(obj), close() } */
  attach(client) {
    this.clients.set(client, {
      role: null, session: 0, lastSeq: 0, clock: new ClockSync(),
      windowStart: this.now(), windowCount: 0,
    });
  }

  detach(client) {
    const c = this.clients.get(client);
    if (!c) return;
    this.clients.delete(client);
    if (this.pilot === client) {
      this.pilot = null;
      this.core.pilotLost(c.session);
      this.#broadcast(this.#statusMsg());
    }
  }

  handle(client, msg) {
    const c = this.clients.get(client);
    if (!c || typeof msg !== 'object' || msg === null || !this.#allow(c)) return;
    if (c.role === null) {
      if (msg.t === 'hello') this.#hello(client, c, msg);
      else client.send({ t: 'error', msg: 'send hello first' });
      return;
    }
    if (msg.t === 'ping') {
      if (typeof msg.id === 'number') client.send({ t: 'pong', id: msg.id, ts: msg.ts, srv: this.now() });
      return;
    }
    if (msg.t === 'tsync_r') {
      if (typeof msg.s0 === 'number' && typeof msg.c1 === 'number') c.clock.add(msg.s0, msg.c1, this.now());
      return;
    }
    if (client !== this.pilot) {
      client.send({ t: 'error', msg: 'observers cannot send commands' });
      return;
    }
    switch (msg.t) {
      case 'ctl': this.#control(c, msg); break;
      case 'arm': this.core.arm(c.session); break;
      case 'disarm': this.core.disarm(c.session); break;
      case 'ack': this.core.ack(c.session); break;
      case 'failsafe': this.core.failsafe(c.session); break;
      default: client.send({ t: 'error', msg: `unknown message type "${String(msg.t).slice(0, 20)}"` });
    }
  }

  /** Called every 2 s: refresh the pilot's clock estimate. */
  tick() {
    if (this.pilot) this.pilot.send({ t: 'tsync', s0: this.now() });
  }

  onCoreStatus(status) {
    this.lastStatus = status;
    this.#broadcast(this.#statusMsg());
  }

  onCoreDown() {
    this.lastStatus = null;
    this.#broadcast(this.#statusMsg());
  }

  onCoreTelemetry(kind, value) {
    this.telemetry[kind] = value;
    this.#broadcast({ t: 'telem', [kind]: value });
  }

  onCoreEvent(ev) {
    this.#broadcast({ t: 'event', what: ev.what, refused: ev.refused });
  }

  #hello(client, c, msg) {
    if (msg.role === 'pilot' && this.pilot === null) {
      c.role = 'pilot';
      c.session = this.newSession();
      this.pilot = client;
      this.core.sessionStart(c.session);
      client.send({ t: 'welcome', role: 'pilot', session: c.session });
      client.send({ t: 'tsync', s0: this.now() });
    } else {
      c.role = 'observer';
      client.send({ t: 'welcome', role: 'observer', reason: msg.role === 'pilot' ? 'pilot_present' : null });
    }
    for (const [kind, value] of Object.entries(this.telemetry)) client.send({ t: 'telem', [kind]: value });
    client.send(this.#statusMsg());
  }

  #control(c, m) {
    const valid = isInt(m.seq, c.lastSeq + 1, 0xffffffff) && typeof m.ts === 'number' &&
      isInt(m.r, -1000, 1000) && isInt(m.p, -1000, 1000) && isInt(m.y, -1000, 1000) &&
      isInt(m.th, 0, 1000) && isInt(m.m, 0, 2);
    if (!valid) return; // garbage never refreshes the core's failsafe timer
    c.lastSeq = m.seq;
    if (c.clock.ready && c.clock.age(m.ts, this.now()) > this.maxCommandAgeMs) {
      this.staleDropped++;
      return;
    }
    this.core.control(c.session, m.seq, { roll: m.r, pitch: m.p, yaw: m.y, throttle: m.th, mode: m.m });
  }

  #statusMsg() {
    const pc = this.pilot ? this.clients.get(this.pilot) : null;
    const base = { t: 'status', core: this.lastStatus !== null, pilot: this.pilot !== null };
    return {
      ...base,
      ...(this.lastStatus ?? {}),
      rttMs: pc?.clock.ready ? round1(pc.clock.rtt) : null,
      staleDropped: this.staleDropped,
    };
  }

  #broadcast(msg) {
    for (const [client, c] of this.clients) if (c.role !== null) client.send(msg);
  }

  #allow(c) {
    const now = this.now();
    if (now - c.windowStart >= 1000) {
      c.windowStart = now;
      c.windowCount = 0;
    }
    return ++c.windowCount <= MAX_MSGS_PER_SEC;
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npm --prefix gateway test`

Expected: PASS: `# tests 22`, `# pass 22`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add gateway/src/hub.js gateway/test/hub.test.js
git commit -m "gateway: ControlHub (one pilot, sessions, validation, stale filter)"
```

### Task 4: Gateway settings

**Files:**
- Create: `gateway/src/config.js`
- Create: `deploy/gateway.json`
- Test: `gateway/test/config.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `DEFAULTS` (`listen`, `tls`, `coreSocket`, `webRoot`, `maxCommandAgeMs`), `validateConfig(cfg)` (throws one error listing every problem), `loadConfig(file)`; the shipped `deploy/gateway.json`

- [ ] **Step 1: Write the failing test**

Create `gateway/test/config.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DEFAULTS, loadConfig, validateConfig } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('the shipped deploy/gateway.json is valid', async () => {
  const cfg = await loadConfig(path.resolve(here, '../../deploy/gateway.json'));
  assert.equal(cfg.listen.port, 8443);
  assert.equal(cfg.tls.cert, '/etc/gcs/tls/cert.pem');
  assert.equal(cfg.coreSocket, '/run/crsf-core/core.sock');
});

test('missing keys fall back to defaults, listen is merged field by field', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'gcs-cfg-')), 'g.json');
  writeFileSync(file, JSON.stringify({ listen: { port: 9000 } }));
  const cfg = await loadConfig(file);
  assert.equal(cfg.listen.port, 9000);
  assert.equal(cfg.listen.host, DEFAULTS.listen.host);
  assert.equal(cfg.maxCommandAgeMs, 200);
  assert.equal(cfg.tls, null);
});

test('bad values are reported together', () => {
  assert.throws(() => validateConfig({ ...DEFAULTS, listen: { host: 1, port: 70000 }, maxCommandAgeMs: 5000, tls: {} }),
    /listen.port.*listen.host.*tls.*maxCommandAgeMs/);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm --prefix gateway test`

Expected: FAIL: `Cannot find module '…/gateway/src/config.js' imported from …/gateway/test/config.test.js`, then `# tests 23`, `# pass 22`, `# fail 1`

- [ ] **Step 3: Write the implementation**

Create `gateway/src/config.js`:

```js
// Gateway settings: a JSON file merged over these defaults.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = Object.freeze({
  listen: { host: '0.0.0.0', port: 8443 },
  tls: null, // { cert: '/etc/gcs/tls/cert.pem', key: '/etc/gcs/tls/key.pem' }; null = plain HTTP (tests only)
  coreSocket: '/run/crsf-core/core.sock',
  webRoot: path.resolve(here, '../../web'),
  maxCommandAgeMs: 200,
});

export function validateConfig(cfg) {
  const problems = [];
  if (!Number.isInteger(cfg.listen?.port) || cfg.listen.port < 0 || cfg.listen.port > 65535) problems.push('listen.port must be 0..65535');
  if (typeof cfg.listen?.host !== 'string') problems.push('listen.host must be a string');
  if (cfg.tls !== null && (typeof cfg.tls?.cert !== 'string' || typeof cfg.tls?.key !== 'string')) problems.push('tls must be null or { cert, key }');
  if (typeof cfg.coreSocket !== 'string') problems.push('coreSocket must be a path');
  if (typeof cfg.webRoot !== 'string') problems.push('webRoot must be a path');
  if (typeof cfg.maxCommandAgeMs !== 'number' || cfg.maxCommandAgeMs < 20 || cfg.maxCommandAgeMs > 1000) problems.push('maxCommandAgeMs must be 20..1000');
  if (problems.length) throw new Error(`invalid gateway config: ${problems.join('; ')}`);
  return cfg;
}

export async function loadConfig(file) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const cfg = { ...DEFAULTS, ...raw, listen: { ...DEFAULTS.listen, ...raw.listen } };
  return validateConfig(cfg);
}
```

Create `deploy/gateway.json`:

```json
{
  "listen": { "host": "0.0.0.0", "port": 8443 },
  "tls": { "cert": "/etc/gcs/tls/cert.pem", "key": "/etc/gcs/tls/key.pem" },
  "coreSocket": "/run/crsf-core/core.sock",
  "webRoot": "/opt/gcs/web",
  "maxCommandAgeMs": 200
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npm --prefix gateway test`

Expected: PASS: `# tests 25`, `# pass 25`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add deploy/gateway.json gateway/src/config.js gateway/test/config.test.js
git commit -m "gateway: settings file with validation"
```

### Task 5: HTTP(S) and WebSocket server

The tests start the real server on a free port with a fake core socket, then use real HTTP, HTTPS (a throw-away certificate made with `openssl`) and WebSocket clients.

**Files:**
- Create: `gateway/src/static.js`
- Create: `gateway/src/server.js`
- Create: `gateway/src/main.js`
- Test: `gateway/test/server.test.js`

**Interfaces:**
- Consumes: `ControlHub`, `CoreClient`, `loadConfig`
- Produces: `staticHandler(root)`, `startGateway(cfg, {core})` → `{hub, core, server, port, close()}`; `node gateway/src/main.js <gateway.json>`; WebSocket only on `/ws`

- [ ] **Step 1: Write the failing test**

Create `gateway/test/server.test.js`:

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { DEFAULTS } from '../src/config.js';
import { FrameReader, MSG } from '../src/ipc.js';
import { startGateway } from '../src/server.js';

// A stand-in for crsf-core: records what the gateway sends, can push status.
async function fakeCore(dir) {
  const sockPath = path.join(dir, 'core.sock');
  const fake = { received: [], conn: null };
  const server = net.createServer((s) => {
    fake.conn = s;
    const r = new FrameReader();
    s.on('data', (d) => fake.received.push(...r.push(d)));
  });
  await new Promise((resolve) => server.listen(sockPath, resolve));
  fake.path = sockPath;
  fake.close = () => new Promise((resolve) => { fake.conn?.destroy(); server.close(resolve); });
  return fake;
}

async function setup(t, { tls = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gcs-gw-'));
  writeFileSync(path.join(dir, 'index.html'), '<h1>pilot</h1>');
  const core = await fakeCore(dir);
  let tlsCfg = null;
  if (tls) {
    tlsCfg = { cert: path.join(dir, 'cert.pem'), key: path.join(dir, 'key.pem') };
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-days', '1', '-subj', '/CN=localhost', '-keyout', tlsCfg.key, '-out', tlsCfg.cert], { stdio: 'ignore' });
  }
  const cfg = { ...DEFAULTS, listen: { host: '127.0.0.1', port: 0 }, tls: tlsCfg, coreSocket: core.path, webRoot: dir };
  const gw = await startGateway(cfg);
  t.after(async () => { await gw.close(); await core.close(); });
  await waitFor(() => core.conn !== null);
  return { gw, core, base: `${tls ? 'https' : 'http'}://127.0.0.1:${gw.port}`, wsUrl: `${tls ? 'wss' : 'ws'}://127.0.0.1:${gw.port}/ws` };
}

async function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Raw request: unlike fetch(), node:http sends the path exactly as given (no normalisation).
function rawStatus(port, rawPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: rawPath }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
}

function connect(url, opts = {}) {
  const ws = new WebSocket(url, opts);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d)));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', reject);
  });
}

test('serves the web app and refuses to escape the web root', async (t) => {
  const { base, gw } = await setup(t);
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await res.text(), '<h1>pilot</h1>');
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal(await rawStatus(gw.port, '/%2e%2e%2f%2e%2e%2fetc%2fpasswd'), 403);   // encoded slashes
  assert.equal(await rawStatus(gw.port, '/../../etc/passwd'), 404);                  // URL parser drops the dots
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
});

test('pilot session end to end: hello, control, status, disconnect', async (t) => {
  const { core, wsUrl } = await setup(t);
  const pilot = await connect(wsUrl);
  pilot.send({ t: 'hello', role: 'pilot' });
  await waitFor(() => pilot.msgs.some((m) => m.t === 'welcome'));
  const { session } = pilot.msgs.find((m) => m.t === 'welcome');
  await waitFor(() => core.received.some((m) => m.type === MSG.SESSION));
  assert.equal(core.received[0].payload.readUInt32LE(0), session);

  pilot.send({ t: 'ctl', seq: 1, ts: 0, r: 10, p: -20, y: 30, th: 400, m: 1 });
  await waitFor(() => core.received.some((m) => m.type === MSG.CONTROL));
  const c = core.received.find((m) => m.type === MSG.CONTROL).payload;
  assert.deepEqual([c.readUInt32LE(0), c.readUInt32LE(4), c.readInt16LE(8), c.readInt16LE(10), c.readInt16LE(12), c.readUInt16LE(14), c[16]],
    [session, 1, 10, -20, 30, 400, 1]);

  const status = Buffer.alloc(83);
  status.writeUInt16LE(81, 0);
  status[2] = MSG.STATUS;
  status[3] = 1; // ARMED
  core.conn.write(status);
  await waitFor(() => pilot.msgs.some((m) => m.t === 'status' && m.state === 'ARMED'));

  const observer = await connect(wsUrl);
  observer.send({ t: 'hello', role: 'pilot' });
  await waitFor(() => observer.msgs.some((m) => m.t === 'welcome'));
  assert.equal(observer.msgs.find((m) => m.t === 'welcome').role, 'observer');

  pilot.ws.close();
  await waitFor(() => core.received.some((m) => m.type === MSG.PILOT_LOST));
  observer.ws.close();
});

test('HTTPS and secure WebSocket with the configured certificate', async (t) => {
  const { base, wsUrl } = await setup(t, { tls: true });
  assert.match(base, /^https:/);
  const client = await connect(wsUrl, { rejectUnauthorized: false });
  client.send({ t: 'hello', role: 'observer' });
  await waitFor(() => client.msgs.some((m) => m.t === 'welcome'));
  client.ws.close();
});

test('binary frames and invalid JSON are ignored without closing the socket', async (t) => {
  const { core, wsUrl } = await setup(t);
  const c = await connect(wsUrl);
  c.ws.send(Buffer.from([1, 2, 3]));
  c.ws.send('{not json');
  c.send({ t: 'hello', role: 'pilot' });
  await waitFor(() => c.msgs.some((m) => m.t === 'welcome'));
  await waitFor(() => core.received.length === 1);
  assert.equal(core.received[0].type, MSG.SESSION);
  c.ws.close();
});

test('an oversized frame closes that socket and the gateway keeps running', async (t) => {
  const { wsUrl } = await setup(t);
  const bad = await connect(wsUrl);
  const closed = new Promise((resolve) => bad.ws.once('close', resolve));
  bad.ws.send('x'.repeat(5000));
  assert.equal(await closed, 1009);
  const good = await connect(wsUrl);
  good.send({ t: 'hello', role: 'observer' });
  await waitFor(() => good.msgs.some((m) => m.t === 'welcome'));
  good.ws.close();
});

test('only /ws accepts WebSocket upgrades', async (t) => {
  const { gw } = await setup(t);
  await assert.rejects(connect(`ws://127.0.0.1:${gw.port}/other`));
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm --prefix gateway test`

Expected: FAIL: `Cannot find module '…/gateway/src/server.js' imported from …/gateway/test/server.test.js`, then `# tests 26`, `# pass 25`, `# fail 1`

- [ ] **Step 3: Write the implementation**

Create `gateway/src/static.js`:

```js
// Serves the web app's files. GET/HEAD only, no directory listings, no escaping webRoot.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function staticHandler(root) {
  const base = path.resolve(root);
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(base, `.${rel}`);
    if (!file.startsWith(base + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404).end();
    }
  };
}
```

Create `gateway/src/server.js`:

```js
// HTTP(S) server: static web app + WebSocket endpoint /ws, wired to crsf-core.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { ControlHub } from './hub.js';
import { CoreClient } from './ipc.js';
import { staticHandler } from './static.js';

export async function startGateway(cfg, { core = new CoreClient(cfg.coreSocket) } = {}) {
  const hub = new ControlHub({ core, maxCommandAgeMs: cfg.maxCommandAgeMs });
  core.on('status', (s) => hub.onCoreStatus(s));
  core.on('down', () => hub.onCoreDown());
  core.on('telemetry', (kind, value) => hub.onCoreTelemetry(kind, value));
  core.on('event', (ev) => hub.onCoreEvent(ev));
  core.start();

  const files = staticHandler(cfg.webRoot);
  const server = cfg.tls
    ? https.createServer({ cert: readFileSync(cfg.tls.cert), key: readFileSync(cfg.tls.key) }, files)
    : http.createServer(files);

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://local').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    const client = {
      send: (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); },
      close: () => ws.close(),
    };
    ws.isAlive = true;
    hub.attach(client);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      hub.handle(client, msg);
    });
    ws.on('close', () => hub.detach(client));
    // Oversized frames (maxPayload) and protocol errors arrive here; ws then closes the
    // socket itself. Without a listener the error would crash the whole process.
    ws.on('error', () => {});
  });

  // Drop browsers that stopped answering pings (half-open TCP after Wi-Fi loss).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 1000);
  const tsync = setInterval(() => hub.tick(), 2000);

  await new Promise((resolve) => server.listen(cfg.listen.port, cfg.listen.host, resolve));

  return {
    hub,
    core,
    server,
    port: server.address().port,
    async close() {
      clearInterval(heartbeat);
      clearInterval(tsync);
      for (const ws of wss.clients) ws.terminate();
      core.stop();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
```

Create `gateway/src/main.js`:

```js
// gcs-gateway entry point:  node src/main.js [/etc/gcs/gateway.json]
import { loadConfig } from './config.js';
import { startGateway } from './server.js';

const file = process.argv[2] ?? '/etc/gcs/gateway.json';
const cfg = await loadConfig(file);
const gw = await startGateway(cfg);
console.log(`gateway: ${cfg.tls ? 'https' : 'http'}://${cfg.listen.host}:${gw.port}  core: ${cfg.coreSocket}  web: ${cfg.webRoot}`);
gw.core.on('up', () => console.log('gateway: connected to crsf-core'));
gw.core.on('down', () => console.log('gateway: lost crsf-core, reconnecting'));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await gw.close();
    process.exit(0);
  });
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npm --prefix gateway test`

Expected: PASS: `# tests 31`, `# pass 31`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add gateway/src/main.js gateway/src/server.js gateway/src/static.js gateway/test/server.test.js
git commit -m "gateway: HTTPS + WebSocket server, static files, entry point"
```

### Task 6: Page logic: protocol and sticks

`web/package.json` only says `"type": "module"`, so Node loads the page's modules in the tests. `bindStick` touches the DOM and is exercised by the browser test of Task 8.

**Files:**
- Create: `web/package.json`
- Create: `web/js/protocol.js`
- Create: `web/js/sticks.js`
- Test: `web/test/protocol.test.js`
- Test: `web/test/sticks.test.js`

**Interfaces:**
- Consumes: the browser messages of spec §4.2
- Produces: `RATE_HZ`, `helloMessage(role)`, `controlMessage(seq, ts, cmd)`, `tsyncReply(msg, now)`, `STATE_TEXT`, `REASON_TEXT`, `REFUSAL_TEXT`; `StickModel({springX, springY, initial})` with `.move(px, py, r)`, `.release()`; `sticksToCommand(left, right, mode)` → `{roll, pitch, yaw, throttle, mode}`; `bindStick(pad, model)`

- [ ] **Step 1: Create the web package marker**

Create `web/package.json`:

```json
{
  "name": "gcs-web",
  "private": true,
  "type": "module",
  "description": "Pilot web app (static files served by the gateway). No build step."
}
```

- [ ] **Step 2: Write the failing tests**

Create `web/test/protocol.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REFUSAL_TEXT, controlMessage, helloMessage, tsyncReply } from '../js/protocol.js';

test('messages match what the gateway hub expects', () => {
  assert.deepEqual(helloMessage('pilot'), { t: 'hello', role: 'pilot' });
  assert.deepEqual(controlMessage(7, 123.5, { roll: 1, pitch: -2, yaw: 3, throttle: 400, mode: 1 }),
    { t: 'ctl', seq: 7, ts: 123.5, r: 1, p: -2, y: 3, th: 400, m: 1 });
  assert.deepEqual(tsyncReply({ t: 'tsync', s0: 99 }, 5000), { t: 'tsync_r', s0: 99, c1: 5000 });
});

test('every refusal the core can send has a text', () => {
  for (const r of ['wrong_session', 'not_disarmed', 'not_in_failsafe', 'link_stale', 'throttle_high', 'fc_still_armed']) {
    assert.ok(REFUSAL_TEXT[r], r);
  }
});
```

Create `web/test/sticks.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StickModel, sticksToCommand } from '../js/sticks.js';

test('moves are scaled to the pad radius and clamped (square gimbal)', () => {
  const s = new StickModel();
  s.move(50, -25, 100);
  assert.deepEqual([s.x, s.y], [0.5, -0.25]);
  s.move(500, -500, 100);
  assert.deepEqual([s.x, s.y], [1, -1]);
});

test('right stick springs back on both axes; throttle axis holds', () => {
  const right = new StickModel();
  right.move(80, 80, 100);
  right.release();
  assert.deepEqual([right.x, right.y], [0, 0]);
  const left = new StickModel({ springX: true, springY: false, initial: { x: 0, y: 1 } });
  left.move(60, -40, 100);
  left.release();
  assert.deepEqual([left.x, left.y], [0, -0.4]);
});

test('mode 2 mapping: throttle at the bottom is 0, stick up is positive pitch', () => {
  const left = new StickModel({ springY: false, initial: { x: 0, y: 1 } });
  const right = new StickModel();
  assert.deepEqual(sticksToCommand(left, right, 0), { roll: 0, pitch: 0, yaw: 0, throttle: 0, mode: 0 });
  left.move(-100, -100, 100);   // full up-left: throttle max, yaw left
  right.move(100, -100, 100);   // full up-right: pitch forward, roll right
  assert.deepEqual(sticksToCommand(left, right, 2), { roll: 1000, pitch: 1000, yaw: -1000, throttle: 1000, mode: 2 });
  left.move(0, 0, 100);
  assert.equal(sticksToCommand(left, right, 0).throttle, 500);
});

test('centred values are plain 0 (never -0)', () => {
  const s = new StickModel();
  s.move(-0.0001, 0.0001, 100);
  const c = sticksToCommand(s, s, 0);
  assert.ok(Object.is(c.roll, 0) && Object.is(c.pitch, 0) && Object.is(c.yaw, 0));
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npm --prefix gateway test`

Expected: FAIL: `Cannot find module '…/web/js/protocol.js' imported from …/web/test/protocol.test.js`; `Cannot find module '…/web/js/sticks.js' imported from …/web/test/sticks.test.js`, then `# tests 33`, `# pass 31`, `# fail 2`

- [ ] **Step 4: Write the implementation**

Create `web/js/protocol.js`:

```js
// Messages exchanged with the gateway (see gateway/src/hub.js) and their Spanish UI texts.
export const RATE_HZ = 50;

export const helloMessage = (role) => ({ t: 'hello', role });

export const controlMessage = (seq, ts, cmd) => ({
  t: 'ctl', seq, ts, r: cmd.roll, p: cmd.pitch, y: cmd.yaw, th: cmd.throttle, m: cmd.mode,
});

export const tsyncReply = (msg, now) => ({ t: 'tsync_r', s0: msg.s0, c1: now });

export const STATE_TEXT = {
  DISARMED: 'DESARMADO',
  ARMED: 'ARMADO',
  FAILSAFE: 'FAILSAFE',
};

export const REASON_TEXT = {
  none: '',
  cmd_timeout: 'dejaron de llegar comandos del piloto',
  pilot_lost: 'el piloto se desconectó',
  gateway_lost: 'el gateway se reinició',
  session_changed: 'cambió el piloto',
  manual: 'activado por el piloto',
};

export const REFUSAL_TEXT = {
  throttle_high: 'Baja el acelerador por completo',
  link_stale: 'Toma el control primero (no llegan comandos)',
  not_disarmed: 'Ya está armado o en failsafe',
  not_in_failsafe: 'No hay failsafe que limpiar',
  fc_still_armed: 'El dron sigue armado: espera a que aterrice y se desarme',
  wrong_session: 'Tu sesión de piloto venció: recarga la página',
};
```

Create `web/js/sticks.js`:

```js
// Virtual sticks. StickModel is pure (tested in Node); bindStick() wires it to the page.
// Axis values are -1..1 with screen coordinates (y grows downwards). Square gimbal.
const clamp1 = (v) => Math.max(-1, Math.min(1, v));

export class StickModel {
  constructor({ springX = true, springY = true, initial = { x: 0, y: 0 } } = {}) {
    this.springX = springX;
    this.springY = springY;
    this.x = initial.x;
    this.y = initial.y;
    this.active = false;
  }

  /** Pointer offset (px, py) from the pad centre; r = pad radius in the same units. */
  move(px, py, r) {
    this.x = clamp1(px / r);
    this.y = clamp1(py / r);
    this.active = true;
  }

  /** Finger lifted: sprung axes return to centre, the throttle axis stays where it is. */
  release() {
    if (this.springX) this.x = 0;
    if (this.springY) this.y = 0;
    this.active = false;
  }
}

/** "Mode 2": left stick = throttle (vertical) + yaw, right stick = pitch + roll. */
export function sticksToCommand(left, right, mode) {
  return {
    roll: Math.round(right.x * 1000) || 0,
    pitch: Math.round(-right.y * 1000) || 0,   // stick up = nose down/forward = higher value
    yaw: Math.round(left.x * 1000) || 0,
    throttle: Math.round(((1 - left.y) / 2) * 1000),
    mode,
  };
}

export function bindStick(pad, model) {
  const knob = pad.querySelector('.knob');
  const draw = () => {
    knob.style.setProperty('--x', model.x);
    knob.style.setProperty('--y', model.y);
  };
  const update = (ev) => {
    const box = pad.getBoundingClientRect();
    const r = Math.min(box.width, box.height) / 2;
    model.move(ev.clientX - (box.left + box.width / 2), ev.clientY - (box.top + box.height / 2), r);
    draw();
  };
  pad.addEventListener('pointerdown', (ev) => {
    pad.setPointerCapture(ev.pointerId);
    update(ev);
  });
  pad.addEventListener('pointermove', (ev) => {
    if (pad.hasPointerCapture(ev.pointerId)) update(ev);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    pad.addEventListener(type, () => {
      model.release();
      draw();
    });
  }
  draw();
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npm --prefix gateway test`

Expected: PASS: `# tests 37`, `# pass 37`, `# fail 0`

- [ ] **Step 6: Commit**

```bash
git add web/js/protocol.js web/js/sticks.js web/package.json web/test/protocol.test.js web/test/sticks.test.js
git commit -m "web: message helpers and virtual sticks (mode 2)"
```

### Task 7: Page logic: dead-man, hold gesture, view

**Files:**
- Create: `web/js/deadman.js`
- Create: `web/js/hold.js`
- Create: `web/js/view.js`
- Test: `web/test/deadman.test.js`
- Test: `web/test/hold.test.js`
- Test: `web/test/view.test.js`

**Interfaces:**
- Consumes: `STATE_TEXT`, `REASON_TEXT`
- Produces: `Deadman` (`.engage()`, `.disengage(reason)`, `.canSend({visible, focused, wsOpen})`), `DEADMAN_TEXT`; `HoldGesture(ms, onComplete)` (`.press(t)`, `.release()`, `.update(t)` → 0..1), `bindHold(button, ms, onComplete)`; `segments(...)` → `{pc, core, tx, drone}` each `ok|warn|down`, `stateLabel`, `failsafeDetail`, `formatBattery`, `formatLink`, `formatMs`

- [ ] **Step 1: Write the failing tests**

Create `web/test/deadman.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Deadman } from '../js/deadman.js';

const ok = { visible: true, focused: true, wsOpen: true };

test('nothing is sent until the pilot takes control', () => {
  const d = new Deadman();
  assert.equal(d.canSend(ok), false);
  assert.equal(d.reason, 'not_engaged');
  d.engage();
  assert.equal(d.canSend(ok), true);
});

test('hiding the page, losing focus or the connection disengages, and it stays off', () => {
  for (const [bad, reason] of [[{ visible: false }, 'hidden'], [{ focused: false }, 'blur'], [{ wsOpen: false }, 'disconnected']]) {
    const d = new Deadman();
    d.engage();
    assert.equal(d.canSend({ ...ok, ...bad }), false);
    assert.equal(d.reason, reason);
    assert.equal(d.canSend(ok), false, 'must not re-engage by itself');
    d.engage();
    assert.equal(d.canSend(ok), true);
  }
});
```

Create `web/test/hold.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HoldGesture } from '../js/hold.js';

test('fires once after the full hold', () => {
  let fired = 0;
  const h = new HoldGesture(1000, () => fired++);
  assert.equal(h.update(0), 0);
  h.press(100);
  assert.equal(h.update(600), 0.5);
  assert.equal(fired, 0);
  assert.equal(h.update(1100), 1);
  h.update(1500);
  assert.equal(fired, 1);
});

test('releasing early cancels', () => {
  let fired = 0;
  const h = new HoldGesture(1000, () => fired++);
  h.press(0);
  h.update(900);
  h.release();
  assert.equal(h.update(2000), 0);
  assert.equal(fired, 0);
});
```

Create `web/test/view.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failsafeDetail, formatBattery, formatLink, formatMs, segments, stateLabel } from '../js/view.js';

const goodStatus = { core: true, serialOk: true, timingFrames: 10, state: 'ARMED', reason: 'none' };
const link = { upLq: 100, upRssi1: -60, txPowerMw: 100 };

test('all links healthy', () => {
  const s = segments({ wsOpen: true, lastMsgAt: 900, status: goodStatus, telem: { link, linkAt: 500 }, now: 1000 });
  assert.deepEqual(s, { pc: 'ok', core: 'ok', tx: 'ok', drone: 'ok' });
});

test('each link degrades independently', () => {
  const now = 10000;
  assert.equal(segments({ wsOpen: true, lastMsgAt: 8000, status: goodStatus, telem: {}, now }).pc, 'warn');
  assert.equal(segments({ wsOpen: false, lastMsgAt: now, status: null, telem: {}, now }).pc, 'down');
  assert.equal(segments({ wsOpen: true, lastMsgAt: now, status: { core: false }, telem: {}, now }).core, 'down');
  assert.equal(segments({ wsOpen: true, lastMsgAt: now, status: { ...goodStatus, timingFrames: 0 }, telem: {}, now }).tx, 'warn');
  assert.equal(segments({ wsOpen: true, lastMsgAt: now, status: { ...goodStatus, serialOk: false }, telem: {}, now }).tx, 'down');
  assert.equal(segments({ wsOpen: true, lastMsgAt: now, status: goodStatus, telem: { link: { ...link, upLq: 40 }, linkAt: now }, now }).drone, 'warn');
  assert.equal(segments({ wsOpen: true, lastMsgAt: now, status: goodStatus, telem: { link, linkAt: now - 2500 }, now }).drone, 'down');
});

test('labels and formatting', () => {
  assert.equal(stateLabel(goodStatus, true), 'ARMADO');
  assert.equal(stateLabel(goodStatus, false), 'SIN CONEXIÓN');
  assert.equal(stateLabel({ core: false }, true), 'NÚCLEO APAGADO');
  assert.equal(failsafeDetail(goodStatus), null);
  assert.equal(failsafeDetail({ state: 'FAILSAFE', reason: 'cmd_timeout' }), 'dejaron de llegar comandos del piloto');
  assert.equal(formatBattery({ voltage: 16.84, remainingPct: 87 }), '16.8 V · 87 %');
  assert.equal(formatBattery(null), '—');
  assert.equal(formatLink(link), 'LQ 100 % · -60 dBm · 100 mW');
  assert.equal(formatMs(12.6), '13 ms');
  assert.equal(formatMs(null), '—');
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm --prefix gateway test`

Expected: FAIL: `Cannot find module '…/web/js/deadman.js' imported from …/web/test/deadman.test.js`; `Cannot find module '…/web/js/hold.js' imported from …/web/test/hold.test.js`; `Cannot find module '…/web/js/view.js' imported from …/web/test/view.test.js`, then `# tests 40`, `# pass 37`, `# fail 3`

- [ ] **Step 3: Write the implementation**

Create `web/js/deadman.js`:

```js
// Dead-man rule: the pilot must deliberately take control, and loses it whenever the page
// is not in front of them (tab hidden, window not focused, connection lost). A page that
// is not engaged sends nothing, so crsf-core fails safe 300 ms later (FMEA #4).
export class Deadman {
  constructor() {
    this.engaged = false;
    this.reason = 'not_engaged';
  }

  engage() {
    this.engaged = true;
    this.reason = null;
  }

  disengage(reason) {
    if (!this.engaged) return;
    this.engaged = false;
    this.reason = reason;
  }

  /** Re-checked before every control message. Disengaging is sticky until engage(). */
  canSend({ visible, focused, wsOpen }) {
    if (!visible) this.disengage('hidden');
    else if (!focused) this.disengage('blur');
    else if (!wsOpen) this.disengage('disconnected');
    return this.engaged;
  }
}

export const DEADMAN_TEXT = {
  not_engaged: 'Pulsa «Tomar control» para pilotar',
  hidden: 'Control perdido: la página dejó de estar visible',
  blur: 'Control perdido: la ventana perdió el foco',
  disconnected: 'Control perdido: se cortó la conexión',
};
```

Create `web/js/hold.js`:

```js
// "Press and hold" for dangerous buttons (arm, clear failsafe). HoldGesture is pure.
export class HoldGesture {
  constructor(durationMs, onComplete) {
    this.durationMs = durationMs;
    this.onComplete = onComplete;
    this.start = null;
    this.fired = false;
  }

  press(now) {
    this.start = now;
    this.fired = false;
  }

  release() {
    this.start = null;
  }

  /** Progress 0..1. Fires onComplete once when the hold reaches the full duration. */
  update(now) {
    if (this.start === null) return 0;
    const progress = Math.min(1, (now - this.start) / this.durationMs);
    if (progress >= 1 && !this.fired) {
      this.fired = true;
      this.onComplete();
    }
    return progress;
  }
}

export function bindHold(button, durationMs, onComplete) {
  const gesture = new HoldGesture(durationMs, onComplete);
  const frame = () => {
    const p = gesture.update(performance.now());
    button.style.setProperty('--progress', p);
    if (gesture.start !== null) requestAnimationFrame(frame);
  };
  button.addEventListener('pointerdown', (ev) => {
    button.setPointerCapture(ev.pointerId);
    gesture.press(performance.now());
    requestAnimationFrame(frame);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, () => {
      gesture.release();
      button.style.setProperty('--progress', 0);
    });
  }
  return gesture;
}
```

Create `web/js/view.js`:

```js
// Pure helpers that turn gateway state into what the page shows.
import { REASON_TEXT, STATE_TEXT } from './protocol.js';

const LINK_STALE_MS = 2000;

/** Health of the four links between the pilot and the drone: 'ok' | 'warn' | 'down'. */
export function segments({ wsOpen, lastMsgAt, status, telem, now }) {
  const pc = !wsOpen ? 'down' : now - lastMsgAt < 1000 ? 'ok' : 'warn';
  const core = status?.core ? 'ok' : 'down';
  const tx = !status?.core || !status.serialOk ? 'down' : status.timingFrames > 0 ? 'ok' : 'warn';
  let drone = 'down';
  if (telem.link && now - telem.linkAt < LINK_STALE_MS && telem.link.upLq > 0) {
    drone = telem.link.upLq >= 70 ? 'ok' : 'warn';
  }
  return { pc, core, tx, drone };
}

export function stateLabel(status, wsOpen) {
  if (!wsOpen) return 'SIN CONEXIÓN';
  if (!status?.core) return 'NÚCLEO APAGADO';
  return STATE_TEXT[status.state] ?? status.state;
}

export function failsafeDetail(status) {
  if (status?.state !== 'FAILSAFE') return null;
  return REASON_TEXT[status.reason] ?? status.reason;
}

export const formatBattery = (b) => (b ? `${b.voltage.toFixed(1)} V · ${b.remainingPct} %` : '—');

export const formatLink = (l) => (l ? `LQ ${l.upLq} % · ${l.upRssi1} dBm · ${l.txPowerMw} mW` : '—');

export const formatMs = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npm --prefix gateway test`

Expected: PASS: `# tests 44`, `# pass 44`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add web/js/deadman.js web/js/hold.js web/js/view.js web/test/deadman.test.js web/test/hold.test.js web/test/view.test.js
git commit -m "web: dead-man rule, hold-to-confirm, link and telemetry view"
```

### Task 8: Pilot page and the browser end-to-end test

The test starts the fake module, the real crsf-core and the gateway, opens the page in headless Firefox, takes control, holds «Armar» for 1.5 s with a real pointer and expects CH5 high and ARMADO. Then the window loses focus and CH7 (FAILSAFE) must go high within 1 s. A headless window never has focus, so the test stubs `document.hasFocus`: it plays the window manager, and the dead-man logic under test is unchanged.

**Files:**
- Create: `web/index.html`
- Create: `web/css/app.css`
- Create: `web/js/app.js`
- Test: `core/tests/integration/fake_tx_cli.py`
- Test: `gateway/e2e/helpers.js`
- Test: `gateway/e2e/pilot.e2e.js`

**Interfaces:**
- Consumes: everything from Tasks 1–7, `crsf-core`, `FakeTx`
- Produces: the pilot page at `/` (`?observe` = read-only); element ids used by tests and the checklist: `state`, `seg-pc|core|tx|drone` (`data-health`), `t-battery`, `t-link`, `t-mode`, `t-rtt`, `t-age`, `deadman`, `toast`, `banner`, `btn-take`, `btn-arm`, `btn-disarm`, `btn-failsafe`, `btn-ack`, `stick-left`, `stick-right`, `[data-mode]`; `python3 fake_tx_cli.py` prints `{"path": pty}` then one JSON line of channels per RC frame

- [ ] **Step 1: Write the fake-module process and the failing browser test**

Create `core/tests/integration/fake_tx_cli.py`:

```python
"""Run FakeTx as a process for the browser end-to-end test.

Prints one JSON line with the pty path, then the latest RC channels every 50 ms.
Reads commands on stdin: 'mode <text>' sets the flight-mode telemetry.
"""
import json
import sys
import threading
import time

from fake_tx import FakeTx

tx = FakeTx()
tx.link_lq = 95
tx.battery_dv = 165
tx.flight_mode = "ACRO*"
print(json.dumps({"path": tx.path}), flush=True)


def commands():
    for line in sys.stdin:
        parts = line.split(maxsplit=1)
        if len(parts) == 2 and parts[0] == "mode":
            tx.flight_mode = parts[1].strip()


threading.Thread(target=commands, daemon=True).start()
while True:
    print(json.dumps({"ch": tx.last_channels()}), flush=True)
    time.sleep(0.05)
```

Create `gateway/e2e/helpers.js`:

```js
// Shared helpers for the browser end-to-end tests: headless Firefox driven over
// WebDriver BiDi (the W3C standard protocol) through a WebSocket.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(pred, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Starts a process and remembers it so the test can kill it afterwards. */
export function start(procs, cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], ...opts });
  procs.push(p);
  return p;
}

/** Launches headless Firefox with a fresh profile in `dir` and returns a page handle. */
export async function firefox(procs, dir) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = path.join(dir, 'firefox');
  mkdirSync(profile, { recursive: true });
  start(procs, 'firefox', ['--headless', '--profile', profile, '--remote-debugging-port', String(port), 'about:blank']);
  let ws;
  await waitFor(async () => {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      return true;
    } catch {
      return false;
    }
  }, 30000, 'firefox remote agent');
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === 'log.entryAdded' && m.params.level === 'error') {
      errors.push(m.params.text);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, (m) => (m.type === 'error' ? reject(new Error(`${method}: ${m.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  await call('session.new', { capabilities: {} });
  await call('session.subscribe', { events: ['log.entryAdded'] });
  const { contexts } = await call('browsingContext.getTree');
  const context = contexts[0].context;
  const evaluate = async (expression) => {
    const r = await call('script.evaluate', { expression, target: { context }, awaitPromise: true, userActivation: true });
    if (r.type !== 'success') throw new Error(`script failed: ${JSON.stringify(r.exceptionDetails?.text)}`);
    return r.result.value;
  };
  const open = (url) => call('browsingContext.navigate', { context, url, wait: 'complete' });
  return { call, evaluate, open, context, errors, close: () => ws.close() };
}
```

Create `gateway/e2e/pilot.e2e.js`:

```js
// End-to-end: the real pilot page in headless Firefox -> gateway -> crsf-core -> fake TX
// module. Needs: core built (make -C core), python3, firefox.   Run: npm run e2e
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { startGateway } from '../src/server.js';
import { firefox, start, waitFor } from './helpers.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'gcs-e2e-'));
const procs = [];
const ARM = 4;
const FAILSAFE = 6;
const HIGH = 1792;
const LOW = 192;

after(() => { for (const p of procs) p.kill('SIGKILL'); });

test('pilot page arms the aircraft and fails safe when the page loses control', { timeout: 90000 }, async () => {
  // 1. fake TX module on a pseudo-terminal
  const fake = start(procs, 'python3', ['-u', 'fake_tx_cli.py'], { cwd: path.join(repo, 'core/tests/integration') });
  let channels = null;
  const lines = readline.createInterface({ input: fake.stdout });
  const ptyPath = await new Promise((resolve) => lines.once('line', (l) => resolve(JSON.parse(l).path)));
  lines.on('line', (l) => { const m = JSON.parse(l); if (m.ch) channels = m.ch; });

  // 2. crsf-core on that pty (no real-time settings needed for the test)
  const sock = path.join(tmp, 'core.sock');
  writeFileSync(path.join(tmp, 'core.conf'), `serial_device = ${ptyPath}\nsocket_path = ${sock}\nrt_priority = 0\nrt_cpu = -1\n`);
  start(procs, path.join(repo, 'core/build/crsf-core'), ['-c', path.join(tmp, 'core.conf')]);
  await waitFor(() => channels !== null, 5000, 'RC frames from crsf-core');

  // 3. gateway serving the real web app
  const gw = await startGateway({ ...DEFAULTS, listen: { host: '127.0.0.1', port: 0 }, coreSocket: sock, webRoot: path.join(repo, 'web') });
  after(() => gw.close());
  await waitFor(() => gw.core.connected, 5000, 'gateway -> core');

  // 4. headless Firefox
  const page = await firefox(procs, tmp);
  after(() => page.close());
  await page.open(`http://127.0.0.1:${gw.port}/`);

  // the page connects and shows state and telemetry from the (fake) aircraft
  await waitFor(() => page.evaluate("document.getElementById('state').textContent === 'DESARMADO'"), 10000, 'DESARMADO on the page');
  await waitFor(() => page.evaluate("document.getElementById('t-battery').textContent.startsWith('16.5 V')"), 5000, 'battery telemetry');
  assert.equal(await page.evaluate("document.getElementById('seg-tx').dataset.health"), 'ok');

  // A headless window never has focus, and the dead-man (correctly) refuses to fly without
  // it, so the test stands in for the window manager: focused now, unfocused later.
  await page.evaluate('document.hasFocus = () => true');

  // take control, then press and hold ARM for 1.5 s with a real pointer
  await page.evaluate("document.getElementById('btn-take').click()");
  const box = JSON.parse(await page.evaluate("JSON.stringify(document.getElementById('btn-arm').getBoundingClientRect())"));
  await page.call('input.performActions', {
    context: page.context,
    actions: [{
      type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 1500 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  });
  await waitFor(() => channels[ARM] === HIGH, 3000, 'ARM channel high');
  assert.equal(channels[FAILSAFE], LOW, 'FAILSAFE must be low while flying');
  await waitFor(() => page.evaluate("document.getElementById('state').textContent === 'ARMADO'"), 3000, 'ARMADO on the page');

  // dead-man: the page loses focus -> it stops sending -> crsf-core fails safe
  const t0 = Date.now();
  await page.evaluate("document.hasFocus = () => false; window.dispatchEvent(new Event('blur'))");
  await waitFor(() => channels[FAILSAFE] === HIGH, 3000, 'FAILSAFE channel high');
  assert.ok(Date.now() - t0 < 1000, `failsafe took ${Date.now() - t0} ms`);
  await waitFor(() => page.evaluate("!document.getElementById('banner').hidden"), 3000, 'failsafe banner');

  assert.deepEqual(page.errors, [], 'no JavaScript errors on the page');
});
```

- [ ] **Step 2: Run the browser test to see it fail**

Run: `make -C core && npm --prefix gateway run e2e`

Expected: FAIL: `not ok 1 - pilot page arms the aircraft and fails safe when the page loses control` with `script failed: "TypeError: can't access property \"textContent\", document.getElementById(...) is null"` (there is no page yet), then `# tests 1`, `# pass 0`, `# fail 1`

- [ ] **Step 3: Write the page**

Create `web/index.html`:

```html
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
  <meta name="theme-color" content="#111418">
  <title>GCS ELRS · Piloto</title>
  <link rel="stylesheet" href="css/app.css">
</head>
<body>
  <header class="bar">
    <nav class="links" aria-label="Estado de los enlaces">
      <span class="seg" id="seg-pc" title="Navegador ↔ Raspberry Pi">Navegador</span>
      <span class="seg" id="seg-core" title="Gateway ↔ crsf-core">Núcleo</span>
      <span class="seg" id="seg-tx" title="crsf-core ↔ módulo TX">TX</span>
      <span class="seg" id="seg-drone" title="Módulo TX ↔ dron (radio)">Dron</span>
    </nav>
    <div id="state" class="state">SIN CONEXIÓN</div>
  </header>

  <main class="cockpit">
    <div class="stick" id="stick-left"><div class="knob"></div><span class="label">Acelerador · Guiñada</span></div>
    <section class="center">
      <div class="video"><video id="video" autoplay muted playsinline></video></div>
      <dl class="telemetry">
        <dt>Batería</dt><dd id="t-battery">—</dd>
        <dt>Enlace</dt><dd id="t-link">—</dd>
        <dt>Modo FC</dt><dd id="t-mode">—</dd>
        <dt>Latencia</dt><dd id="t-rtt">—</dd>
        <dt>Comando</dt><dd id="t-age">—</dd>
      </dl>
      <p id="deadman" class="deadman"></p>
      <div id="toast" class="toast" hidden></div>
    </section>
    <div class="stick" id="stick-right"><div class="knob"></div><span class="label">Cabeceo · Alabeo</span></div>
  </main>

  <footer class="controls pilot-only">
    <button id="btn-take">Tomar control</button>
    <button id="btn-arm" class="hold danger">Armar (mantener 1 s)</button>
    <button id="btn-disarm" class="disarm">Desarmar</button>
    <button id="btn-failsafe" class="warn">FAILSAFE</button>
    <div class="modes">
      <button data-mode="0" class="on">Modo 1</button>
      <button data-mode="1">Modo 2</button>
      <button data-mode="2">Modo 3</button>
    </div>
  </footer>

  <div id="banner" class="banner" hidden>
    <strong>FAILSAFE</strong> <span id="banner-detail"></span>
    <button id="btn-ack" class="hold pilot-only">Limpiar failsafe (mantener 2 s)</button>
  </div>

  <script type="module" src="js/app.js"></script>
</body>
</html>
```

Create `web/css/app.css`:

```css
:root {
  --bg: #111418; --panel: #1b2027; --text: #e8edf2; --muted: #8a96a3;
  --ok: #2fbf71; --warn: #f2b134; --down: #e5484d; --accent: #3e8ed0;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
  font: 15px/1.3 system-ui, sans-serif; touch-action: none; user-select: none; overflow: hidden; }
.bar { display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; background: var(--panel); }
.links { display: flex; gap: 6px; }
.seg { padding: 3px 8px; border-radius: 10px; font-size: 13px; background: #2a313a; }
.seg::before { content: "●"; margin-right: 4px; color: var(--muted); }
.seg[data-health="ok"]::before { color: var(--ok); }
.seg[data-health="warn"]::before { color: var(--warn); }
.seg[data-health="down"]::before { color: var(--down); }
.state { font-weight: 700; letter-spacing: .05em; }
.state[data-state="ARMED"] { color: var(--warn); }
.state[data-state="FAILSAFE"] { color: var(--down); }
.cockpit { display: grid; grid-template-columns: 1fr minmax(220px, 1.2fr) 1fr; gap: 12px;
  height: calc(100% - 44px - 64px); padding: 12px; }
.stick { position: relative; align-self: center; justify-self: center; width: min(40vh, 28vw); aspect-ratio: 1;
  border-radius: 16px; background: radial-gradient(circle, #232a33 0 60%, #1b2027 61%); border: 1px solid #2f3843; }
.knob { --x: 0; --y: 0; position: absolute; width: 22%; aspect-ratio: 1; border-radius: 50%; background: var(--accent);
  left: calc(39% + var(--x) * 39%); top: calc(39% + var(--y) * 39%); pointer-events: none; }
.stick .label { position: absolute; bottom: -22px; width: 100%; text-align: center; color: var(--muted); font-size: 12px; }
.center { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.video { flex: 1; border-radius: 10px; background: #000; min-height: 80px; overflow: hidden; }
.video video { width: 100%; height: 100%; object-fit: contain; }
.telemetry { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; padding: 8px 10px;
  background: var(--panel); border-radius: 10px; }
.telemetry dt { color: var(--muted); }
.telemetry dd { margin: 0; font-variant-numeric: tabular-nums; }
.deadman { min-height: 1.3em; margin: 0; color: var(--warn); text-align: center; }
.toast { padding: 8px; border-radius: 8px; background: #3a2a10; color: #ffd58a; text-align: center; }
.controls { display: flex; gap: 8px; align-items: center; justify-content: center; height: 64px; padding: 8px; background: var(--panel); }
button { font: inherit; color: var(--text); background: #2a313a; border: 1px solid #3a4450; border-radius: 10px;
  padding: 10px 14px; touch-action: none; }
button:disabled { opacity: .4; }
button.hold { --progress: 0; background: linear-gradient(90deg, #6b4a12 calc(var(--progress) * 100%), #2a313a 0); }
button.danger { border-color: var(--warn); }
button.disarm { border-color: var(--ok); font-weight: 700; }
button.warn { border-color: var(--down); color: #ffb3b5; font-weight: 700; }
.modes button.on { background: var(--accent); }
.banner { position: fixed; left: 50%; top: 56px; transform: translateX(-50%); padding: 12px 16px; border-radius: 12px;
  background: #4a1416; border: 2px solid var(--down); display: flex; gap: 12px; align-items: center; }
body.observer .pilot-only, body.observer .stick { visibility: hidden; }
@media (orientation: portrait) {
  .cockpit::before { content: "Gira el teléfono (horizontal)"; position: fixed; inset: 40% 0 auto; text-align: center; color: var(--warn); }
}
```

Create `web/js/app.js`:

```js
// Pilot page: wires the pure modules to the DOM and the gateway WebSocket.
// ?observe in the URL opens a read-only view.
import { Deadman, DEADMAN_TEXT } from './deadman.js';
import { bindHold } from './hold.js';
import { REFUSAL_TEXT, RATE_HZ, controlMessage, helloMessage, tsyncReply } from './protocol.js';
import { StickModel, bindStick, sticksToCommand } from './sticks.js';
import { failsafeDetail, formatBattery, formatLink, formatMs, segments, stateLabel } from './view.js';

const $ = (id) => document.getElementById(id);
const wantRole = new URLSearchParams(location.search).has('observe') ? 'observer' : 'pilot';

const left = new StickModel({ springX: true, springY: false, initial: { x: 0, y: 1 } }); // throttle starts at 0
const right = new StickModel();
const deadman = new Deadman();
const telem = { link: null, linkAt: 0, battery: null, flightMode: null, device: null };
let ws = null;
let role = null;
let status = null;
let seq = 0;
let mode = 0;
let lastMsgAt = 0;
let wakeLock = null;

const wsOpen = () => ws?.readyState === WebSocket.OPEN;
const send = (msg) => { if (wsOpen()) ws.send(JSON.stringify(msg)); };

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 4000);
}

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    seq = 0;                       // a new connection is a new session: never resend old commands
    send(helloMessage(wantRole));
  };
  ws.onmessage = (ev) => {
    lastMsgAt = performance.now();
    handle(JSON.parse(ev.data));
  };
  ws.onclose = () => {
    role = null;
    status = null;
    deadman.disengage('disconnected');
    setTimeout(connect, 1000);
  };
}

function handle(msg) {
  switch (msg.t) {
    case 'welcome':
      role = msg.role;
      document.body.classList.toggle('observer', role !== 'pilot');
      if (wantRole === 'pilot' && role !== 'pilot') toast('Ya hay un piloto conectado: modo observador');
      break;
    case 'status':
      status = msg;
      break;
    case 'telem':
      if (msg.link) telem.linkAt = performance.now();
      Object.assign(telem, msg);
      delete telem.t;
      break;
    case 'event':
      toast(REFUSAL_TEXT[msg.refused] ?? `${msg.what}: ${msg.refused}`);
      break;
    case 'tsync':
      send(tsyncReply(msg, performance.now()));
      break;
    case 'error':
      toast(msg.msg);
      break;
    default:
      break;
  }
}

// 50 Hz control loop. Nothing is queued while disconnected or disengaged.
setInterval(() => {
  const canSend = deadman.canSend({
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
    wsOpen: wsOpen() && role === 'pilot',
  });
  if (canSend) send(controlMessage(++seq, performance.now(), sticksToCommand(left, right, mode)));
}, 1000 / RATE_HZ);

async function takeControl() {
  if (role !== 'pilot') return;
  deadman.engage();
  try {
    await document.documentElement.requestFullscreen?.();
    await screen.orientation?.lock?.('landscape');
  } catch { /* not supported (desktop browsers): fine */ }
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* needs HTTPS; the screen may sleep, which disengages the dead-man */ }
}

function render() {
  const now = performance.now();
  const seg = segments({ wsOpen: wsOpen(), lastMsgAt, status, telem, now });
  for (const [name, health] of Object.entries(seg)) $(`seg-${name}`).dataset.health = health;
  $('state').textContent = stateLabel(status, wsOpen());
  $('state').dataset.state = status?.state ?? 'none';
  $('t-battery').textContent = formatBattery(telem.battery);
  $('t-link').textContent = formatLink(telem.link);
  $('t-mode').textContent = telem.flightMode ?? '—';
  $('t-rtt').textContent = formatMs(status?.rttMs);
  $('t-age').textContent = formatMs(status?.cmdAgeMs);
  $('deadman').textContent = deadman.engaged ? '' : DEADMAN_TEXT[deadman.reason] ?? '';
  $('btn-take').disabled = role !== 'pilot' || deadman.engaged;
  const detail = failsafeDetail(status);
  $('banner').hidden = detail === null;
  if (detail !== null) $('banner-detail').textContent = detail;
  requestAnimationFrame(render);
}

bindStick($('stick-left'), left);
bindStick($('stick-right'), right);
bindHold($('btn-arm'), 1000, () => send({ t: 'arm' }));
bindHold($('btn-ack'), 2000, () => send({ t: 'ack' }));
$('btn-take').addEventListener('click', takeControl);
$('btn-disarm').addEventListener('click', () => send({ t: 'disarm' }));
$('btn-failsafe').addEventListener('click', () => send({ t: 'failsafe' }));
for (const b of document.querySelectorAll('[data-mode]')) {
  b.addEventListener('click', () => {
    mode = Number(b.dataset.mode);
    for (const o of document.querySelectorAll('[data-mode]')) o.classList.toggle('on', o === b);
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') deadman.disengage('hidden');
});
window.addEventListener('blur', () => deadman.disengage('blur'));

connect();
requestAnimationFrame(render);
```

- [ ] **Step 4: Run the browser test to see it pass**

Run: `npm --prefix gateway run e2e`

Expected: PASS: `ok 1 - pilot page arms the aircraft and fails safe when the page loses control`, then `# tests 1`, `# pass 1`, `# fail 0` (about 20 s)

- [ ] **Step 5: Run the unit tests again**

Run: `npm --prefix gateway test`

Expected: PASS: `# tests 44`, `# pass 44`, `# fail 0`

- [ ] **Step 6: Commit**

```bash
git add core/tests/integration/fake_tx_cli.py gateway/e2e/helpers.js gateway/e2e/pilot.e2e.js web/css/app.css web/index.html web/js/app.js
git commit -m "web: pilot page; browser end-to-end test through crsf-core"
```

### Task 9: Deployment

**Files:**
- Create: `deploy/gcs-gateway.service`
- Create: `deploy/make-cert.sh`
- Modify: `deploy/install.sh`

**Interfaces:**
- Consumes: `gateway/src/main.js`, `deploy/gateway.json`
- Produces: `gcs-gateway.service` (user `gcs`, restarts on failure: safe because the core fails safe meanwhile), `/etc/gcs/tls/{cert,key}.pem`, `install.sh` copies gateway, web and docs to `/opt/gcs`

- [ ] **Step 1: Write the unit and the certificate script**

Create `deploy/gcs-gateway.service`:

```ini
[Unit]
Description=GCS gateway: pilot web app and WebSocket control for crsf-core
After=crsf-core.service
Wants=crsf-core.service

[Service]
Type=simple
User=gcs
Group=gcs
WorkingDirectory=/opt/gcs/gateway
ExecStart=/usr/bin/node /opt/gcs/gateway/src/main.js /etc/gcs/gateway.json
# Safe to restart: while the gateway is down the core sees "gateway lost" and fails safe;
# the pilot reconnects with a new session and must clear the failsafe and re-arm.
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

Create `deploy/make-cert.sh`:

```bash
#!/usr/bin/env bash
# Self-signed TLS certificate for the gateway. Each browser asks once to trust it.
# Usage: sudo deploy/make-cert.sh [/etc/gcs/tls]
set -euo pipefail
dir=${1:-/etc/gcs/tls}
mkdir -p "$dir"
host=$(hostname)
san="DNS:${host},DNS:${host}.local,DNS:localhost,IP:127.0.0.1"
for ip in $(hostname -I); do
  san+=",IP:${ip}"
done
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 825 \
  -subj "/CN=${host}.local" -addext "subjectAltName=${san}" \
  -keyout "$dir/key.pem" -out "$dir/cert.pem" 2>/dev/null
chmod 644 "$dir/cert.pem"
chmod 640 "$dir/key.pem"
chgrp gcs "$dir/key.pem" 2>/dev/null || echo "note: group gcs does not exist yet; run install.sh first"
echo "certificate valid for: ${san}"
```

- [ ] **Step 2: Install the gateway and the web app too**

In `deploy/install.sh` (change 1 of 2), replace:

```bash
#!/usr/bin/env bash
# Installs or updates crsf-core on the Raspberry Pi. Safe to re-run.
# Usage (from the repository root):  sudo deploy/install.sh
set -euo pipefail
```

with:

```bash
#!/usr/bin/env bash
# Installs or updates crsf-core and the gateway on the Raspberry Pi. Safe to re-run.
# Usage (from the repository root):  sudo deploy/install.sh
set -euo pipefail
```

In `deploy/install.sh` (change 2 of 2), replace:

```bash
make -C "$repo/core" install PREFIX=/usr/local

echo "== configuration (existing files are kept)"
install -d -m 0755 /etc/gcs
[[ -f /etc/gcs/crsf-core.conf ]] || install -m 0644 "$repo/deploy/crsf-core.conf" /etc/gcs/

echo "== systemd units"
install -m 0644 "$repo/deploy/crsf-core.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable crsf-core.service
echo "installed. start with: sudo systemctl restart crsf-core"
```

with:

```bash
make -C "$repo/core" install PREFIX=/usr/local

echo "== gateway and web app -> /opt/gcs"
install -d /opt/gcs
rsync -a --delete --exclude node_modules "$repo/gateway/" /opt/gcs/gateway/
rsync -a --delete "$repo/web/" /opt/gcs/web/
rsync -a --delete "$repo/docs/" /opt/gcs/docs/
(cd /opt/gcs/gateway && npm ci --omit=dev --no-audit --no-fund)

echo "== configuration (existing files are kept)"
install -d -m 0755 /etc/gcs
[[ -f /etc/gcs/crsf-core.conf ]] || install -m 0644 "$repo/deploy/crsf-core.conf" /etc/gcs/
[[ -f /etc/gcs/gateway.json ]] || install -m 0644 "$repo/deploy/gateway.json" /etc/gcs/
[[ -f /etc/gcs/tls/cert.pem ]] || "$repo/deploy/make-cert.sh" /etc/gcs/tls

echo "== systemd units"
install -m 0644 "$repo/deploy/crsf-core.service" "$repo/deploy/gcs-gateway.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable crsf-core.service gcs-gateway.service
echo "installed. start with: sudo systemctl restart crsf-core gcs-gateway"
```

- [ ] **Step 3: Check the files**

Run: `chmod +x deploy/make-cert.sh && bash -n deploy/install.sh deploy/make-cert.sh && systemd-analyze verify deploy/gcs-gateway.service && deploy/make-cert.sh "$(mktemp -d)"`

Expected: PASS: `bash -n` and `systemd-analyze` print nothing; `make-cert.sh` prints `note: group gcs does not exist yet; run install.sh first` (only on a machine without the `gcs` user) and `certificate valid for: DNS:<hostname>,DNS:<hostname>.local,DNS:localhost,IP:127.0.0.1,IP:<each address>`

- [ ] **Step 4: Commit**

```bash
git add deploy/gcs-gateway.service deploy/install.sh deploy/make-cert.sh
git commit -m "deploy: gateway service, self-signed certificate, installer"
```

### Task 10: Install on the Pi and fly the checklist (propellers off)

Hardware task. Same bench as the Milestone 3 test: drone on its battery, module on the Pi's USB.

**Files:**
- Create: `docs/procedures/m4-pilot-checklist.md`

**Interfaces:**
- Consumes: everything above
- Produces: the pilot page working on real devices against the real aircraft (propellers off)

- [ ] **Step 1: Install and start**

```bash
sudo deploy/install.sh
sudo systemctl restart crsf-core gcs-gateway
systemctl --no-pager status gcs-gateway | head -5
journalctl -u gcs-gateway -n 5 --no-pager
```
Expected: `active (running)`, and the log shows `gateway: https://0.0.0.0:8443  core: /run/crsf-core/core.sock  web: /opt/gcs/web`
followed by `gateway: connected to crsf-core`.

- [ ] **Step 2: Add the checklist**

Create `docs/procedures/m4-pilot-checklist.md`:

```markdown
# Milestone 4 checklist: pilot web app on a PC and an Android phone

**Propellers off.** Bench as in the M3 test, plus `gcs-gateway` running. PC and phone on
the Pi's Wi-Fi.

| # | Step | Expected | PC | Phone |
|---|------|----------|----|-------|
| 1 | Open `https://<pi>:8443` | certificate warning once; accept ("Advanced → continue") | | |
| 2 | Wait 2 s | Navegador, Núcleo, TX green; Dron green (RX bound) | | |
| 3 | "Tomar control" | phone: full screen landscape; the dead-man text disappears | | |
| 4 | Left stick to the bottom, hold "Armar" 1 s | ARMADO; Betaflight armed | | |
| 5 | Move both sticks | Receiver tab bars follow; sticks spring back (not throttle) | | |
| 6 | Phone: press Home; come back | FAILSAFE banner within ~0.3 s ("dejaron de llegar comandos") | — | |
| 7 | PC: click another window | FAILSAFE banner (dead-man: window lost focus) | | — |
| 8 | Hold "Limpiar failsafe" 2 s with throttle at 0 | DESARMADO once Betaflight has disarmed | | |
| 9 | Open the page on the second device | "Ya hay un piloto conectado: modo observador"; no controls | | |
| 10 | Arm, then close the pilot tab | FAILSAFE `pilot_lost` | | |
| 11 | Arm, then turn off Wi-Fi on the pilot device | FAILSAFE within 1 s (`cmd_timeout`) | | |

Tested by / date / browser versions:
```

- [ ] **Step 3: Run the checklist**

Do every row of `docs/procedures/m4-pilot-checklist.md` on a PC (Firefox or Chrome) and on an Android phone (Chrome), both on the Pi's Wi-Fi, and fill in both result columns. Row 11 (Wi-Fi off on the pilot device while armed) must reach FAILSAFE within 1 s.

- [ ] **Step 4: Commit**

```bash
git add docs/procedures/m4-pilot-checklist.md
git commit -m "docs: M4 pilot checklist results"
```

## Done when

- `npm --prefix gateway test` passes (44 tests) and `npm --prefix gateway run e2e` passes (1 test). The core suites
  still pass.
- Every row of the M4 checklist passed on a PC and on an Android phone, or its failure is written up with the team.
- Milestone 5 can start: it measures what this milestone built.
