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
