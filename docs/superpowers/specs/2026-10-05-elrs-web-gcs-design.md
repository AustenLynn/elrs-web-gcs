# ELRS Web Ground Control Station: Design

**Date:** 2026-10-05 · **Project:** Estación de Control Terrestre Web para UAVs sobre
ExpressLRS (Proyecto Terminal, Universidad Iberoamericana, Otoño 2026, Equipo 1)
**Inputs:** Project Charter (24/08/2026), Diagrama de frontera, Diagramas P, Cronograma,
AMEF/DFMEA, and `elrs-joystick-control` (cloned from the AustenLynn fork of
`kaack/elrs-joystick-control`; used as a protocol reference).
**Status:** draft for team review. Section 2 says which decisions the team made and which
were proposed while writing the plans and still need confirmation.

> **Amendment 2026-10-07:** the project drone is a BetaFPV Aquila20 HD running BetaFPV's own
> firmware, not Betaflight. `crsf-core` gained `fc_profile = aquila20 | betaflight` (default
> `aquila20`). Where this document describes Betaflight-specific behaviour (FAILSAFE switch on
> CH7, the `*` disarmed marker, `!FS!` confirmation, Betaflight setup), it now applies to the
> `betaflight` profile only. For the Aquila20, see `2026-10-07-aquila20-profile-design.md` and
> `docs/setup/aquila20.md`.

## 1. Goal

A pilot flies an ExpressLRS drone from a web page on a PC or an Android phone, through a
Raspberry Pi 4 that turns the page's commands into CRSF frames for an ELRS TX module.
The same Pi serves the FPV video to several local viewers, and an optional relay carries
control (not video) over the internet for an architecture test.

| Charter item | Where it is met |
|--------------|-----------------|
| Deliverable 1: CRSF bridge on the Pi, real-time priority | `crsf-core` (M1–M3) |
| Deliverable 2: web control app, WebSocket, PC + Android | gateway + pilot page (M4) |
| Deliverable 3: failsafe on all 3 segments, < 1 s | safety state machine (M2), core timeout (M3), dead-man (M4), C3 procedure (M5) |
| Deliverable 4: multi-device video with MediaMTX | video pipeline + WHEP (M6) |
| Deliverable 5: remote access prototype + report | relay (M7) |
| C1 jitter · C2 video latency · C3 failsafe · C4 concurrency | M5 (C1, C3), M6 (C2, C4) |

Out of scope (charter §5): video over the internet, autonomous flight, voice control,
legal BVLOS operation.

## 2. Decisions

**Made by the team (2026-10-05):**

| # | Decision | Consequence |
|---|----------|-------------|
| D1 | TX module: **BetaFPV Micro 1W 2.4 GHz over its USB-C port** (CP2102 → `/dev/ttyUSB0`) | No inverter circuit. The module's CRSF pins must be remapped to the USB UART. The charter's "hardware UART" wording is outdated. USB adds latency noise (§6.1). |
| D2 | **Write the bridge from scratch**; `elrs-joystick-control` is a protocol reference only | Byte layouts were checked against the reference (identical RC frames) and against EdgeTX's conventions. |
| D3 | Real-time core in **C** | gcc 14 + make on the Pi; no extra toolchain. |
| D4 | Flight controller: **BetaFPV Aquila20 HD, BetaFPV's own firmware** (amended 2026-10-07; was Betaflight). Betaflight is kept as a profile (`fc_profile`). | Aquila20: FAILSAFE drops ARM over a live link; armed state is not in telemetry. See `2026-10-07-aquila20-profile-design.md`. |
| D5 | **Two processes: C core + Node.js gateway** over a Unix socket | Matches the Gantt (WebSocket server is the web developer's task). Gateway crashes fail safe. HTTPS/relay stay out of C. |

**Proposed while writing the plans; please confirm or change:**

| # | Proposal | Why | Where to change it |
|---|----------|-----|--------------------|
| P1 | Failsafe action, **`betaflight` profile**: raise **FAILSAFE (CH7/AUX3)**, centre sticks, throttle low, **keep ARM** as it is; Betaflight `failsafe_switch_mode = STAGE2` runs its procedure. **`aquila20` profile (default): ARM low**, sticks centred, throttle low, link kept up | Betaflight's procedure (drop / land / GPS rescue) is tested and configurable; the bridge only has to detect the loss quickly | `safety.c`, `docs/setup/betaflight.md` |
| P2 | Command timeout **300 ms**; gateway drops commands older than **200 ms** | Leaves > 600 ms of the 1 s budget for propagation; tolerates normal Wi-Fi hiccups (FMEA #5) | `cmd_timeout_ms`, `maxCommandAgeMs` |
| P3 | Failsafe is **latched**. Clearing needs an explicit hold-to-confirm, a fresh link, throttle low, and the FC **not** reporting itself armed (Betaflight's `*` flight-mode suffix). Clearing always ends disarmed; flying again needs a new arm. | FMEA #14 (no revival of old commands); stops the pilot from disarming a drone mid-landing by accident | `safety_ack()` |
| P4 | **Dead-man** = the page sends only after "Tomar control" and only while visible, focused and connected; any lapse disengages until tapped again | Deterministic behaviour when Android backgrounds the browser (FMEA #4). A touch-and-hold dead-man was rejected because pilots lift their thumbs in hold modes, which would cause spurious failsafes (FMEA #5). | `web/js/deadman.js` |
| P5 | crsf-core starts **disarmed** and is **not auto-restarted** by systemd | A restart would send ARM low (= disarm in flight). Without a restart, Betaflight's own RX-loss failsafe runs. | `deploy/crsf-core.service` |
| P6 | C1 numeric target: send lateness **p99 ≤ 250 µs, max ≤ 1 ms, no missed slot** over 10 min | Charter left it "por medir"; justified in `docs/procedures/c1-jitter.md` | procedure + `timing_report.py` flags |
| P7 | ELRS settings: **250 Hz, telemetry 1:16, 100 mW, dynamic power off** | USB noise makes faster rates useless; telemetry often enough to confirm failsafe; USB power cannot feed 1 W | `docs/setup/module.md` |
| P8 | Video: **H.264 on the Pi 4 hardware encoder**, MediaMTX **v1.21.1** (pinned, SHA-256 checked), WebRTC/WHEP through the gateway at `/video/whep` | Tested on this Pi: ~9 % CPU at 720p30; one HTTPS origin for the whole app | `deploy/video/` |
| P9 | Relay: Pi dials out; the relay multiplexes remote browsers; **hex tokens ≥ 32 chars**, TLS by Caddy | No inbound ports; every local safety rule applies unchanged (FMEA #13) | `relay/`, `docs/setup/relay.md` |
| P10 | Pilot UI text in **Spanish**; code and docs in English | Users and evaluators are Spanish speakers | `web/` |
| P11 | One git repository `~/ProyectoTerminal/elrs-web-gcs` (monorepo) | Two developers, shared contracts and tests | — |

## 3. Architecture

```
 Pilot browser (PC / Android)                   Viewers (watch.html)
        │ HTTPS + WebSocket /ws (JSON)                │ HTTPS /video/whep + WebRTC (UDP 8189)
        ▼                                             ▼
 ┌──────────────── Raspberry Pi 4 (Debian 13, arm64, PREEMPT kernel) ─────────────────┐
 │ gcs-gateway (Node.js, user gcs)          gcs-video: MediaMTX + ffmpeg (CPUs 0-2)    │
 │   static web app, hub, WHEP proxy,         USB dongle MJPEG → h264_v4l2m2m → RTSP   │
 │   relay client                                                                      │
 │        │ Unix socket /run/crsf-core/core.sock (binary, length-prefixed)             │
 │        ▼                                                                            │
 │ crsf-core (C, user gcs): frame loop SCHED_FIFO 80 on isolated CPU 3 + IPC thread    │
 └────────┬────────────────────────────────────────────────────────────────────────────┘
          │ USB-C CDC (CP2102), CRSF at 921600 baud
   BetaFPV ELRS TX ── 2.4 GHz ──▶ ELRS RX ── CRSF ──▶ Betaflight FC ──▶ motors
                                                                         │ VTX ─▶ goggles + HDMI dongle
 Internet (M7, optional): pilot ──wss──▶ relay (VPS, Caddy) ◀──wss── gateway
```

### 3.1 Responsibilities

| Component | Owns | Trusts |
|-----------|------|--------|
| crsf-core | serial port, frame timing, channel layout, **all arming and failsafe rules**, telemetry decoding, evidence logs | nothing upstream: no fresh command → failsafe |
| gateway | who the pilot is, sessions, input validation, stale-command filter, TLS, static files, WHEP proxy, relay client | the core for safety |
| web app | sticks, buttons, dead-man, showing state | the gateway |
| MediaMTX | video fan-out | — |
| relay | authentication, multiplexing, no buffering | nothing; never parses control messages |
| Betaflight | flight, its failsafe procedure, radio-link loss | — |

### 3.2 Failure handling per segment (Deliverable 3, criterion C3)

| Segment (charter) | Failure | Detected by | Response | Time budget |
|-------------------|---------|-------------|----------|-------------|
| Operator ↔ Pi (local) | Wi-Fi loss, tab hidden, browser crash | core: no fresh command for 300 ms; gateway: WebSocket close → `PILOT_LOST`; page: dead-man stops sending | FAILSAFE switch high in the next frame (≤ 4 ms) | ≤ 300 ms + 4 ms |
| Operator ↔ Relay ↔ Pi (M7) | internet loss, relay down | same timer; relay close → `pilot_lost` | same | same |
| Inside the Pi | gateway crash | core: socket closed → `GATEWAY_LOST` | same | immediate |
| Inside the Pi | crsf-core crash | module stops getting frames | Betaflight RX-loss failsafe | Betaflight guard time (set ≤ 0.5 s) |
| Pi ↔ aircraft | RF loss, module unplugged | Betaflight (no valid RX data) | Betaflight failsafe procedure | guard time ≤ 0.5 s |

## 4. Interfaces

### 4.1 Core ↔ gateway (Unix stream socket)

Message = `u16 length (LE, type+payload) | u8 type | payload`, little-endian integers,
max 255 bytes. Twins: `core/src/ipc_proto.h` and `gateway/src/ipc.js`, pinned by shared
golden bytes in both test suites.

| Type | Direction | Payload |
|------|-----------|---------|
| 0x01 SESSION | gw → core | u32 session (new pilot) |
| 0x02 CONTROL | gw → core | u32 session, u32 seq, i16 roll, i16 pitch, i16 yaw (−1000..1000), u16 throttle (0..1000), u8 mode (0..2) |
| 0x03 ARM / 0x04 DISARM / 0x05 ACK / 0x06 PILOT_LOST / 0x07 FAILSAFE | gw → core | u32 session |
| 0x81 STATUS (10 Hz) | core → gw | 80 bytes: state, reason, fc_arm, serial_ok, session, last_seq, cmd_age_ms, frames, errors, rx stats, period_us, ELRS offset, timing frames, worst wake-up, 16 channels |
| 0x82 LINK / 0x83 BATTERY / 0x84 FLIGHT_MODE / 0x85 DEVICE | core → gw | decoded telemetry |
| 0x86 EVENT | core → gw | u8 kind (1 arm refused, 2 ack refused), u8 refusal, u32 session |

One gateway at a time; a new connection replaces the old one (= gateway lost).
Read-only tools use a second socket (`status_socket_path`, `/run/crsf-core/status.sock` in
the shipped config): up to 4 observers receive the same core → gw messages, anything they
send is ignored, and they never replace the gateway. So `crsf-ctl status`/`watch` are safe
while flying; only `crsf-ctl pilot` takes the control socket.

### 4.2 Browser ↔ gateway (WebSocket `/ws`, JSON, ≤ 4 KiB, ≤ 120 msg/s)

| Browser → gateway | Gateway → browser |
|-------------------|-------------------|
| `hello {role: pilot\|observer}` (first) | `welcome {role, session?, reason?}` |
| `ctl {seq, ts, r, p, y, th, m}` 50 Hz | `status {...core status, core, pilot, rttMs, staleDropped}` 10 Hz |
| `arm`, `disarm`, `ack`, `failsafe` | `telem {link\|battery\|flightMode\|device}` |
| `tsync_r {s0, c1}` (reply) | `tsync {s0}` every 2 s, `event {what, refused}`, `pong`, `error` |
| `ping {id, ts}` | |

`ts` is the browser's `performance.now()`. The gateway estimates the clock offset from the
`tsync` exchange (minimum-RTT sample of the last 8) and drops `ctl` older than 200 ms.

### 4.3 Relay (WebSocket `/relay`)

First message `hello {role: bridge|pilot|observer, room, token}`. To the bridge the relay sends
`{t:'relay', ev:'open'|'msg'|'close', id, msg}`. The bridge answers with
`{t:'relay', ev:'send'|'kick', id, msg}`. Close codes: 4000 bad hello, 4001 Pi not
connected or lost, 4002 replaced bridge, 4003 denied, 4004 room full (4 remote clients).

### 4.4 CRSF (USB serial, 921600 8N1)

Sent: RC_CHANNELS_PACKED `EE 18 16 <22 bytes> <crc>` once per period; model select
(`C8 08 32 EE EA 10 05 <id> <crc BA> <crc D5>`) and device ping (`EE 04 28 00 EA <crc>`)
after opening the port and when the module goes silent for 1 s; parameter read/write
(0x2C/0x2D) in `crsf-param` only. Received: timing (0x3A/0x10), link statistics (0x14),
battery (0x08), flight mode (0x21), device info (0x29), parameter entries (0x2B).
Channel values 172–1811, centre 992; sticks map onto 1000–2000 µs.

| Channel | Function | Values |
|---------|----------|--------|
| CH1–CH4 | roll, pitch, throttle, yaw (AETR) | 1000–2000 µs |
| CH5 AUX1 | ARM (ELRS sends AUX1 every packet; enforced) | 1000 / 2000 µs |
| CH6 AUX2 | flight-mode switch | 1000 / 1500 / 2000 µs |
| CH7 AUX3 | `betaflight`: FAILSAFE (Betaflight mode). `aquila20`: the drone's stick sensitivity, always 1000 µs (S) | 1000 / 2000 µs |
| CH8–CH16 | unused | 1000 µs |

## 5. crsf-core

### 5.1 Threads
- **Frame loop** (SCHED_FIFO 80, pinned to CPU 3, `mlockall`, 256 KiB pre-faulted stack):
  sleeps with `clock_nanosleep(TIMER_ABSTIME)` until the deadline. Each tick it applies
  queued commands, checks timeouts, writes one RC frame (non-blocking), reads up to
  4 × 256 bytes of telemetry, publishes status, then computes the next deadline. It owns
  the serial port alone (no fd sharing). It never does file or socket I/O.
- **IPC thread** (normal priority): Unix-socket server, 10 Hz status, telemetry
  forwarding, JSON event log, timing CSV.
- The two share only the **mailbox**: a priority-inheritance mutex around command, event
  and timing rings plus snapshots, held for copies only.

### 5.2 Timing (ELRS handset sync)
The module sends a timing frame about every 200 ms: the interval it wants and an offset
(0.1 µs units; positive = send later). The scheduler adopts the interval (clamped to
0.5–50 ms) and applies **offset − sync_margin** once to the next deadline, clamped to ±½
period. This follows EdgeTX's approach and the sign used by the reference project. At
equilibrium the module reports offset ≈ +`sync_margin_us` (default 1000 µs): frames
arrive ~1 ms before the radio packet, which is headroom for USB timing noise. Missed
slots are skipped on the same phase grid (no frame bursts). **To verify on hardware**
(M3 bench step 2).

### 5.3 Safety state machine (pure logic, `core/src/safety.c`)

```
            arm (session ok, link fresh, throttle ≤ 5 %)
 DISARMED ─────────────────────────────────────────────▶ ARMED
    ▲  ◀──────────────────── disarm ──────────────────────  │
    │                                                       │ no fresh cmd 300 ms │ pilot lost │
    │ ack (session ok, link fresh, throttle low,            │ gateway lost │ new session │ manual
    │      FC not reporting armed in the last 3 s)          ▼
    └──────────────────────────────────────────────────  FAILSAFE (latched)
                         manual FAILSAFE also allowed from DISARMED (bench tests)
```

Fresh command = current session and a sequence number higher than the last. Repeats,
reordering and late messages never refresh the timer. Outputs in FAILSAFE: FAILSAFE
switch high, sticks centred, throttle 0, ARM unchanged. Disarm is always accepted; in
FAILSAFE it lowers ARM but stays latched. Refusals go back to the pilot as events.

### 5.4 Evidence logs
- `events.jsonl` (always on): state changes with `cmd_age_ms`, refusals, Betaflight
  flight-mode changes, serial up/down, module name and firmware, ELRS timing samples,
  gateway connects. Monotonic `t_ns` plus wall time.
- `timing.csv` (only while measuring C1): deadline, wake-up, write start/end, period,
  shift for every frame.

## 6. Other components

### 6.1 Tools (`core/tools`)
`crsf-probe` (does the module answer? which firmware? timing frames with `--rc`),
`crsf-param` (ELRS settings without a radio: list / set text selections, chunked
parameter protocol), `crsf-ctl` (status and watch on the read-only status socket; keyboard pilot for bench
tests on the control socket).

### 6.2 Gateway (`gateway/`, Node 22, one dependency: `ws` 8.22.0)
HTTPS with a self-signed certificate (`deploy/make-cert.sh`; browsers accept it once).
Static files limited to GET/HEAD with no path escape. WebSocket heartbeat (dead sockets
dropped within 2 s). ControlHub: one pilot, random 32-bit session per pilot connection,
validation, stale filter, rate limit, telemetry cache replayed to new clients. Restarted
by systemd on failure (safe: the core fails safe meanwhile).

### 6.3 Pilot page (`web/`, no build step)
Mode-2 virtual sticks (left: throttle holds + yaw springs; right: pitch/roll spring),
hold-to-arm 1 s, tap-to-disarm, FAILSAFE button, hold-to-clear 2 s, 3-position mode
switch, four link indicators (browser, core, TX, drone), telemetry, dead-man message,
Android full screen + landscape + wake lock. `?observe` gives a read-only view;
`?room=` connects through the relay (M7). `watch.html` is video only, with the C4
recorder; `clock.html` is for C2.

### 6.4 Video (`deploy/video`)
`capture.sh` (ffmpeg: v4l2 MJPEG → yuv420p → `h264_v4l2m2m` 2.5 Mbit/s, GOP 1 s,
no B-frames → RTSP) started by MediaMTX `runOnInit`. MediaMTX listens on localhost
except WebRTC media (UDP 8189). The MoQ server that v1.21 adds is disabled. `gcs-video` is
limited to CPUs 0–2, CPUWeight 50, Nice 10. Firefox needs its OpenH264 plugin once; the
player retries every 2 s by itself.

### 6.5 Relay (`relay/`)
Stateless multiplexer with constant-time token checks, 4 KiB frames, 120 msg/s per
client, 5 s hello timeout, and no buffering. Deployed behind Caddy (automatic TLS) on a
small VPS. Video is not relayed.

## 7. Verification

| Level | What | Where |
|-------|------|-------|
| Unit | CRC, frames, deframer, telemetry, parameters, serial (pty), config, channel map, safety (21 scenarios), scheduler, IPC codec, mailbox, logs; hub, clock, IPC twin, static, config, WHEP proxy; sticks, dead-man, hold, view, video stats; analysis tools; relay | `make -C core test`, `npm test`, `unittest` |
| Integration | real binaries against an **independent Python fake TX module** on a pseudo-terminal (timing follow, arming, timeouts, refusals, telemetry, parameters); gateway over real sockets with a fake core; relay → gateway → core | `make -C core integration`, `npm test` |
| Browser E2E | headless Firefox drives the real pilot page → gateway → crsf-core → fake module: hold-to-arm raises CH5; losing focus raises CH7 in < 1 s. A second test plays the hardware-encoded test pattern through MediaMTX and the WHEP proxy | `npm run e2e` |
| Bench | real module, RX, Betaflight, propellers off | `docs/procedures/m3-bench-test.md`, `m4-pilot-checklist.md` |
| Criteria | C1 jitter, C3 failsafe (with timestamped fault injection), C2 latency (photos), C4 concurrency (in-page recorder), relay latency and failsafe | `docs/procedures/` |

Golden bytes: the RC frames are identical to those from the reference project's
`PackChannels()`, and every other frame was computed by an independent Python
implementation. The core↔gateway messages are pinned by golden bytes shared between
the C and JavaScript tests.

### 7.1 FMEA coverage

| FMEA # | Failure mode | Design response | Test |
|--------|--------------|-----------------|------|
| 1, 9, 16 | jitter from CPU contention, video encoding, heat | SCHED_FIFO on isolated CPU 3, mlockall, hardware encoder, video cgroup on CPUs 0–2 | C1 runs A–D |
| 2 | lost or corrupt frames | CRC-checked deframer, counters in status, LQ telemetry | unit + bench |
| 3 | stale commands | sequence numbers, 200 ms age filter, latest-only | hub tests |
| 4, 12 | failsafe not detected / relay segment unmonitored | one core timer covers every upstream segment; dead-man | C3, relay test |
| 5 | spurious failsafe | 300 ms timeout (15 missed messages); calibrate with C3 data | C3 |
| 6 | lost bind / version mismatch | firmware recorded via `crsf-probe` | M1 hardware task |
| 7, 8, 10 | video capture/viewers/topology | test-pattern mode, C4 recorder | C4 |
| 11, 13 | relay latency / unauthorised access | RTT tool, tokens + TLS, no exposure without auth | relay test |
| 14 | reconnection replays commands | no buffering anywhere, new session per connection, latched failsafe + explicit re-arm | safety + relay tests |
| 15 | Pi power loss | dedicated supply (charter) | — |

**New rows to add to the FMEA:**
(a) module brown-out on USB power (keep ≤ 100 mW, P7);
(b) shared USB bus: module, Wi-Fi dongle and capture dongle sit on the same hub (move
the capture dongle to another port; C1 run C);
(c) crsf-core crash in flight (P5: no restart; Betaflight failsafe);
(d) operator clears failsafe mid-landing (P3 interlock).

## 8. Milestones

Each plan produces working, tested software on its own. Owners follow the Gantt
(MAAH firmware, FJM web).

| M | Plan | Delivers | Owner | Target week |
|---|------|----------|-------|-------------|
| 1 | `2026-10-05-m1-crsf-protocol.md` | CRSF library, crsf-probe, crsf-param, module verified | MAAH | S7 (Oct 5–11) |
| 2 | `2026-10-05-m2-safety-logic.md` | config, channel map, safety state machine | MAAH | S7 |
| 3 | `2026-10-05-m3-crsf-core.md` | real-time daemon, crsf-ctl, systemd, bench test | MAAH | S8 (Oct 12–18) |
| 4 | `2026-10-05-m4-gateway-web.md` | gateway, pilot page, HTTPS, browser E2E | FJM | S8–S9 |
| 5 | `2026-10-05-m5-validation.md` | C1/C3 tools and measurement campaign | MAAH | S9–S10 |
| 6 | `2026-10-05-m6-video.md` | MediaMTX pipeline, WHEP, watch page, C2/C4 | FJM | S10–S11 |
| 7 | `2026-10-05-m7-relay.md` | relay, relay mode, RTT tool, remote test (cuttable) | FJM | S12 (Nov 9–15) |
| — | integration and final report | all procedures re-run end to end | both | S13–S14, delivery Nov 23 |

M4 needs only M3's socket protocol (pinned by golden bytes), so it can start in
parallel with M3 against the fake core in its tests.

## 9. Open items to check on hardware (blocking marked ●)

- ● CRSF over the BetaFPV USB port: pins 3/1, Backpack off, DIP switches, baud (M1 task 9).
- ● Timing sign convention: offset settles near +1000 µs (M3 bench step 2).
- Betaflight value names for `failsafe_switch_mode`, `failsafe_procedure`,
  `failsafe_delay` in your firmware version (`get failsafe`).
- ELRS setting names in your firmware (`crsf-param list`).
- Capture dongle formats (`v4l2-ctl --list-formats-ext`) and the dual-RX assumption
  (charter §8).
- Charter text to update: "UART de hardware" → USB CDC; C1 numeric target (P6).
- Licences: the reference project is GPL-3.0 / Fair Source. This code was written
  independently (no files copied), but protocol knowledge came from it. Credit it in the
  final report and confirm the project's own licence with the mentor.
