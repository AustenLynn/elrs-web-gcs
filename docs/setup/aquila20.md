# The drone: BetaFPV Aquila20 HD (fc_profile = aquila20)

The Aquila20's AIO board has an HDSC MCU (USB `0493:5740`) running **BetaFPV's own firmware, not
Betaflight**. The Betaflight Configurator cannot connect to it: it does not answer MSP or the CLI.
Its receiver is built in ("BFPV AIO 2G4RX", ExpressLRS 3.5.6). crsf-core drives it with
`fc_profile = aquila20` (the default; `deploy/crsf-core.conf` sets it explicitly).

## 1. Channels (measured 2026-10-07, propellers off)

| Channel | Function | Values |
|---------|----------|--------|
| CH1–CH4 | roll, pitch, throttle, yaw | 1000–2000 µs |
| **CH5** | **ARM** (high = armed, motors spin) | 1000 / 2000 µs |
| CH6 | flight mode: low `NORMAL` (N, position hold), mid `SPORT` (S, self-levelling), high `MANUAL` (M) | 1000 / 1500 / 2000 µs |
| CH7 | speed (the radio's SC): low SLOW (`S`), mid MID (`M`), high FAST (`F`). Set by the pilot: Slow / Mid / Fast buttons, keys 4/5/6; the page starts at Slow | 1000 / 1500 / 2000 µs |
| CH8 | turtle mode (the radio's SD): high = on. Turtle button, key T. Acts only upside down; latches until the drone is upright (§4) | 1000 / 2000 µs |

Flight-mode telemetry reads `<speed>-<mode>`, for example `S-NORMAL`, or `S-TURTLE` in turtle
mode. **It never says whether the drone is armed.** The pilot page shows it with the names on its
buttons, for example "Normal · Slow", and "TURTLE" in the warning colour.

## 2. Failsafe behaviour

- **crsf-core's FAILSAFE** drops CH5 (ARM) low, centres the sticks and puts the throttle at
  minimum, **while keeping the link up**. The motors stop and telemetry keeps flowing. In flight
  the drone drops, because it has no landing procedure.
- **Link lost while armed** (the Pi, crsf-core or the module goes silent): the drone's own
  failsafe stops the motors **at once** (measured). crsf-core notices too: armed with no radio
  link report with LQ > 0 for 1 s → **FAILSAFE `rf_lost`** (ARM low, latched). Its state then
  matches the disarmed drone instead of showing ARMADO with ARM still high.
- **Link back with CH5 still high:** the drone stays disarmed. The arm switch must be cycled.
- Clearing a failsafe in crsf-core needs the pilot's session, a fresh link and the throttle low.
  It ends disarmed, and flying again needs a new arm. There is no "FC still armed" check: the
  drone does not report it, and the failsafe has already disarmed it.

## 3. Bench checks (replace `betaflight.md` for this drone)

Do these with **propellers off**, the TX module on its XT30 supply, and the drone on its battery.

1. Bind (once): see `docs/setup/module.md` §4.
2. `./core/build/crsf-probe --rc -t 5 /dev/ttyUSB0`: you should see a `link:` line with LQ near
   100 %, `flight mode: S-NORMAL`, and `device 0xEC: "BFPV AIO 2G4RX"`.
3. With crsf-core running and `crsf-ctl pilot`: press `a` (arm). The motors spin. Press `f`
   (failsafe). The motors stop at once, CH5 goes low, and `crsf-ctl status` starts
   with `FAILSAFE reason=manual`. Press `k` (ack): the state goes back to `DISARMED`.
4. Mode switch: from the pilot page, Normal / Sport / Manual should show "Normal", "Sport"
   and "Manual" in the telemetry line.
5. Radio link loss: arm, then switch the TX module's supply off. Within about 1 s
   `crsf-ctl status` must show `FAILSAFE reason=rf_lost`, and the motors must already be stopped.
6. **Power-on with ARM high:** with the drone's battery off, arm from `crsf-ctl pilot`, then
   connect the battery. The motors **must not** spin. Bench 2026-10-07: PASS. With no link to the
   drone, crsf-core fails safe (`rf_lost`) in the same frame, so ARM never stays high. Whether the
   firmware itself would arm at power-on with CH5 high is still unknown (§5), but our core never
   leaves CH5 high without a link.

**Rule for every session:** press **"Desarmar"** (or `d` in `crsf-ctl pilot`) before anyone walks
up to the drone or changes its battery, even after a failsafe.

## 4. Turtle mode (spike 2026-10-14)

Measured with propellers off and ARM held low throughout. A throwaway script drove the TX module
directly and logged every flight-mode report.

| Drone | Channels | Reported |
|---|---|---|
| upright | CH8–CH12 high one at a time | `S-NORMAL` throughout |
| upside down | all spare channels low (15 s) | `S-NORMAL` |
| upside down | CH8 high | **`S-TURTLE` within 0.7 s** |
| upside down | CH8 low again (2 × 15 s) | **still `S-TURTLE`**: latched |
| turned upright by hand | all low | `S-NORMAL` within about 1 s |

So turtle needs the drone **upside down and CH8 high**, and ends when the drone is **upright again**,
not when CH8 drops.

**Not yet tested:** the motors when armed in turtle mode (the manual: they spin in reverse when a
stick moves). Bench check 3 of `docs/superpowers/specs/2026-10-14-speed-turtle-design.md` §6.

## 5. Not yet known

- Whether the Aquila20 arms at power-on if CH5 is already high (bench check 6).
- Whether it refuses to arm when not level, which matters for re-arming after a failsafe.
- Whether the Aquila20 itself refuses to arm with the throttle up. crsf-core refuses that anyway
  (`throttle_arm_max`).
- The settings in the BETAFPV Configurator (PC only). Record any failsafe or arming options here
  when a teammate connects it.
