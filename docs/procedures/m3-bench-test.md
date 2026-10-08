# Milestone 3 bench test: crsf-core with the real module and the Aquila20

Adapted on 2026-10-07 from the M3 plan's Betaflight version: the drone is a BetaFPV Aquila20 HD
(`fc_profile = aquila20`, see `docs/setup/aquila20.md`).

**Propellers off.** Before you start:
- the drone is on its battery, bound to the TX module (`docs/setup/module.md` §4);
- the module is on its XT30 supply (8.0 V, 1.0 A limit) and on the Pi's USB;
- crsf-core is installed and running (`docs/setup/pi-realtime.md`).

Stop the gateway first: `sudo systemctl stop gcs-gateway`. It holds crsf-core's control socket,
and `crsf-ctl pilot` and the gateway would keep replacing each other. Start it again at the end.

Terminal 1: `crsf-ctl watch`   Terminal 2: `crsf-ctl pilot`

| # | Step | Expected | Result |
|---|------|----------|--------|
| 1 | Start crsf-core, look at `watch` | `module: ... firmware 3.3.0`; `serial=ok`; `period=4000us` | PASS: `module: BFPV 2G4Micro1W firmware 3.3.0`, serial=ok, period=4000us (after the identification-retry fix) |
| 2 | Wait 10 s, watch `offset=` | Settles at about **+1000 µs** (= `sync_margin_us`) ± 500 µs and stays there | PASS: offset +982 … +1033 µs; late_max 25–41 µs |
| 3 | `link:` lines | uplink LQ ≈ 100 %, RSSI plausible | PASS: uplink/downlink LQ 100 %, RSSI −38 … −41 dBm, 100 mW |
| 4 | `watch` channels at rest | `ch5=192 ch7=192`; throttle low; flight mode `S-NORMAL` | PASS: ch5=192 ch7=192, `S-NORMAL` |
| 5 | `pilot`: `w` / `s` | throttle steps of 50 in `pilot`'s line | PASS: 0 → 100 → 0 |
| 6 | throttle up, press `a` | refused: `arm refused: throttle_high`; not armed; motors still | PASS: `arm refused: throttle_high`, motors still |
| 7 | throttle to 0, press `a` | ARMED; `ch5=1792`; **motors spin** | PASS: ARMED, ch5=1792, motors spin |
| 8 | press `x` (pilot stops sending) | within ~0.3 s: FAILSAFE `cmd_timeout`; `ch5=192`, `ch7=192`; **motors stop at once**; link still up | PASS: FAILSAFE `cmd_timeout` at cmd_age 304 ms; ch5=192 ch7=192; motors stopped at once |
| 9 | `x` again, then `k` | DISARMED (no "FC still armed" check in this profile); motors stay off | PASS: DISARMED, motors off |
| 10 | press `f` while disarmed | FAILSAFE `manual`; `k` clears it | PASS: FAILSAFE `manual`, cleared by `k` |
| 11 | arm again (7), then `q` | FAILSAFE `gateway_lost` (the tool was the gateway); motors stop | PASS: FAILSAFE `gateway_lost` at cmd_age 4 ms; ch5=192 |
| 12 | arm again, then switch the module's XT30 supply off **with USB still connected** | the module keeps running on USB power: link stays at LQ 100 %, drone stays armed (no link loss). Keep the XT30 on in normal use (USB alone browns out at higher power) | PASS 2026-10-07: link held, motors kept spinning (expected) |
| 13 | arm again, then unplug the module's USB | motors stop at once; `serial=DOWN` and FAILSAFE `rf_lost` within ~1 s; re-plug → `serial=ok` within 1 s | PASS: serial down at +2.64 s, FAILSAFE `rf_lost` 0.74 s later; motors stopped at once and stayed off; re-plug: serial ok, module identified again |
| 14 | `aquila20.md` §3 step 6: drone battery off, arm (CH5 high), then connect the battery | with no link to the drone, crsf-core fails safe (`rf_lost`) at once, so ARM never stays high; motors **must not** spin when the battery is connected | PASS: arm cancelled in the same frame (`rf_lost`, no link with the unpowered drone); battery connected, motors did not spin |
| 15 | `grep FAILSAFE /var/log/crsf-core/events.jsonl` | one line per failsafe above, `cmd_age_ms` ≈ 300 for step 8 | PASS: one line per failsafe: cmd_timeout (304 ms), manual, gateway_lost, rf_lost ×2 |

**If step 2 fails** (offset keeps growing, or jumps between large positive and negative values):
1. Write down 20 `offset=` readings.
2. Set `sync_margin_us = 0` and repeat.
3. If it still diverges, the sign convention taken from EdgeTX and the reference project is
   reversed for this firmware. Stop, and add a failing test to `core/tests/test_txsched.c` before
   changing `txsched_on_timing()`.

**Rule:** press `d` (disarm) before anyone touches the drone or its battery.

Tested by / date / ELRS versions (TX 3.3.0, RX 3.5.6) / Aquila20 firmware:
bench session 2026-10-07 (operator + Claude Code; keys sent to `crsf-ctl pilot` by script, motors watched by the operator), Pi 4 with heatsink, crsf-core FIFO 80 on isolated CPU 3. Aquila20 firmware version not readable (no Betaflight/MSP).
