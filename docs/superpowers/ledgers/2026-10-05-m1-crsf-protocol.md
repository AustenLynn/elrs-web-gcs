# SDD ledger — plan: docs/superpowers/plans/2026-10-05-m1-crsf-protocol.md
Spec: docs/superpowers/specs/2026-10-05-elrs-web-gcs-design.md (read; binding authority)
Pre-flight (shared interfaces):
- T1→T2,T3,T6: crc8_d5/crc8_ba produced in T1, consumed with the same signatures — OK
- T2→T3,T6,T7: CRSF constants, crsf_build_ping/model_select/rc_frame — names match T7 consumes — OK
- T3,T4→T7,T8: deframer callback + crsf_decode — OK
- T5→T7,T8: serial_open(path, baud) — OK
- T6→T8: param_reader_* / param_parse / param_option(_index) — OK
- T7→T9, T8→T9: build/crsf-probe, build/crsf-param CLIs — OK
Note: the plan's code was replay-checked against the verified snapshot before execution; no conflicts found.
Ruling: execute on main (user chose "Commit on main" 2026-10-06) — plan says main; skill default is a worktree — cost if wrong: history on main, nothing pushed.
Task 1: complete (commits dc70c4a..535f930, tests: make -C core test → make: se sale del directorio '/home/maikuser/ProyectoTerminal/elrs-web-gcs/core')
Task 2: complete (commits 535f930..b9c29b0, tests: make -s -C core test → ALL TESTS PASSED)
Task 3: complete (commits b9c29b0..58c0b05, tests: make -s -C core test → ALL TESTS PASSED)
Task 4: complete (commits 58c0b05..94aacf7, tests: make -s -C core test → ALL TESTS PASSED)
Task 5: complete (commits 94aacf7..93c8836, tests: make -s -C core test → ALL TESTS PASSED)
Task 6: complete (commits 93c8836..72ace32, tests: make -s -C core test → ALL TESTS PASSED)
Task 7: complete (commits 72ace32..6086016, tests: make -s -C core integration → OK)
Task 8: complete (commits 6086016..d66b5e4, tests: make -s -C core integration → OK)
Task 9: deferred — BetaFPV module not enumerated on USB (no 10c4:ea60, no /dev/ttyUSB0) at 2026-10-06; needs the user with a data cable. Not complete.
Ruling: one whole-range final review (dc70c4a..HEAD) covers M1–M3 together — the three plans are one continuous C codebase and were executed in one run — cost if wrong: a reviewer sees more context than one plan.
Task 9: progress 2026-10-06 — docs/setup/module.md written (uncommitted, part of Task 9). Module enumerates (by-id name matches deploy/crsf-core.conf). Found DIP 3-4 (operating mode) → set 1-2 ON (firmware-update mode): ESP32 boot log seen at 115200; ELRS sends backpack MSP at 460800 on UART0; no CRSF at 115200/400000/921600/1870000 (CRSF still on the JR pin → hardware.html change needed). On USB power alone it browns out (21 USB disconnects) and its Wi-Fi AP never appears. BLOCKED: needs 5–12 V on XT30 (2S recommended, never 3S). Not complete.
Task 9: progress 2026-10-06 19:40 — module powered from a bench supply on XT30 (8.0 V, 1.0 A limit, 230 mA idle); DIP 1-2 ON, 3-7 OFF; heatsink on the Pi (idle 41 °C). Defaults saved by the user as "~/ProyectoTerminal/Welcome to your ExpressLRS System 2.pdf" (hardware.html: CRSF RX/TX pin 13 half-duplex; backpack 460800 on pins 3/1). Changed: CRSF RX=3, TX=1, backpack disabled/cleared.
Task 9: Step 3 (probe) matches Expected — `device 0xEE: "BFPV 2G4Micro1W" ExpressLRS 3.3.0 (30 parameters)`, exit 0, 921600 baud, 0 CRC errors, timing 4000 us (250 Hz). Step 4 (settings) done: Packet Rate 250Hz, Telem Ratio 1:16 (was 1:64), Max Power 100 mW (was 250), Dynamic Off, Model Match Off — read back OK. Remaining: Step 5 `--rc` with the drone bound (props off), Step 6 versions table (TX 3.3.0 ae9df3; RX firmware still to read), Step 7 commit.
Task 9: minor (found on hardware): crsf-param prints ELRS's custom ↑/↓ option bytes raw (shows as � in AUX options).
Task 9: Ruling: added 'crsf-param run <command>' (commit above; tests test_run_starts_a_command / test_run_refuses_a_setting RED→GREEN; fake list test now expects 7 settings) — the module's on-screen menu is locked while it shows 'No handset', so Bind had to be sent over CRSF — cost if wrong: none; existing list/set behaviour unchanged.
Task 9: Step 5 matches Expected — crsf-probe --rc: timing 250 Hz, uplink LQ 100 % (RSSI ≈ −37 dBm), downlink LQ 100 %, 100 mW, battery 8.4 V; RX answered as device 0xEC "BFPV AIO 2G4RX" ExpressLRS 3.5.6. First bind attempt failed: a 5.8 GHz antenna was on the module (now 2.4G). Step 6: versions recorded in docs/setup/module.md §2, plus §4 bench findings and the default hardware.html PDF.
Task 9: Ruling: the drone (Aquila20 HD) does not run Betaflight (HDSC MCU, BetaFPV firmware; no MSP/CLI) — this breaks spec D4 and the Betaflight-specific safety design (CH7 FAILSAFE mode, '*' disarmed marker: "S-NORMAL" would read as armed → ack refused forever, !FS! confirmation). Not something to rule on alone: recorded as a BLOCKING team decision in docs/HANDOFF.md §6; M3 Task 8 must wait for it — cost if wrong: n/a (escalated).
Task 9: note — one more USB disconnect at 6534 s (uptime) even on XT30 power, mid-probe; the module came back within 0.4 s and answers normally. Watch for it during M3 (crsf-core reports serial_ok=0 and reopens).
Task 9: complete (commits 477e547..375a59a, tests: ./core/build/crsf-probe -t 3 /dev/ttyUSB0 → received 18 valid frames, 0 CRC errors)
Task 9: correction — the USB disconnect at 6534 s happened with the XT30 supply OFF (user, 2026-10-07): USB-only brown-out as already known, not a new fault.
