# Aquila20 flight-controller profile: Design

**Date:** 2026-10-07 · **Amends:** `2026-10-05-elrs-web-gcs-design.md` (decision D4, §4.4, §5.3, §7, §7.1)
**Status:** approved in conversation (option b, failsafe approach A); written spec for team review.

## 1. Why

The project's drone is a **BetaFPV Aquila20 HD**. Its AIO board has an HDSC MCU (USB `0493:5740`)
running **BetaFPV's own firmware, not Betaflight**. It is configured only with the BETAFPV
Configurator and does not answer MSP or the CLI. Its receiver is built in: "BFPV AIO 2G4RX",
ExpressLRS 3.5.6.

The original design (D4) relied on Betaflight in three ways, and none of them hold on this drone:
- a FAILSAFE switch on CH7, which on the Aquila20 is the stick-sensitivity switch;
- reading "is the FC armed?" from a `*` at the end of the flight-mode text;
- Betaflight's `!FS!` failsafe confirmation.

The team chose to keep the Aquila20 (option b) and to make the failsafe **disarm over the link**
(approach A).

## 2. What the drone does (bench spike, 2026-10-07, propellers off)

These results come from a throwaway script that sends CRSF channels through the TX module
(not kept in the repo).

| Item | Aquila20 behaviour |
|------|--------------------|
| Arm | **CH5** high (2000 µs) arms. Motors spin. |
| Armed state in telemetry | **Not reported.** The flight-mode text does not change when it arms. |
| Flight mode | **CH6**: low `NORMAL` (N, position hold), mid `SPORT` (S, self-levelling), high `MANUAL` (M) |
| Stick sensitivity | **CH7**: low `S`, mid `M`, high `F` |
| CH8 | no visible effect |
| Flight-mode telemetry format | `<sensitivity>-<mode>`, e.g. `S-NORMAL` |
| Link lost while armed | **Motors stop at once.** This is the drone's own failsafe; in flight it drops. |
| Link returns with CH5 already high | **Stays disarmed.** The arm switch must be cycled. |
| Other telemetry | link statistics, battery voltage (current reads 0.0 A) |

## 3. Design

### 3.1 One setting: `fc_profile`

There is a new crsf-core setting, `fc_profile = aquila20 | betaflight`. The default is `aquila20`,
and `deploy/crsf-core.conf` sets it explicitly.

| | `aquila20` (new default) | `betaflight` (today's behaviour, kept) |
|---|---|---|
| FAILSAFE output | **ARM (CH5) low**, sticks centred, throttle minimum. The link keeps running. | FAILSAFE switch (`ch_failsafe`, CH7) high, sticks centred, throttle minimum. ARM unchanged. |
| `ch_failsafe` | not used. CH7 stays low, so sensitivity is fixed at **S** (slowest). | used (default CH7) |
| Flight-mode telemetry | forwarded and logged only; never read as "armed" | `*` at the end means disarmed; any other text means armed (P3 interlock) |
| Clearing failsafe (ack) | session, fresh link, throttle ≤ `throttle_arm_max` | same, plus "FC not reporting armed in the last 3 s" |
| Radio link lost while armed | **FAILSAFE `rf_lost`** after 1 s without a link report with LQ > 0 (added after review: the drone disarms itself silently) | none in the core (Betaflight runs its RX-loss failsafe and reports it) |

**Unchanged in both profiles:**
- the safety state machine (§5.3 of the main spec): when to fail safe, the 300 ms timeout, latching,
  sessions and sequence numbers;
- CH5 = ARM (enforced), CH6 = flight mode (0/1/2 → low/mid/high), sticks 1000–2000 µs;
- timing sync and the socket protocol.

### 3.2 Where it lives in the code

- **`safety.c`: no behaviour change.** It still sets `out.failsafe` and leaves `out.arm` as it was.
  It still decides *when*. In the `aquila20` profile it simply never receives flight-mode
  telemetry, so its FC-armed state stays UNKNOWN and never blocks an ack.
- **`chmap.c`: the profile decides *how* failsafe reaches the channels.**
  - `aquila20`: ARM is high only when `arm && !failsafe`, and nothing is written to a failsafe channel.
  - `betaflight`: as today.
- **`rtloop.c`:** flight-mode telemetry still goes to the mailbox (gateway, logs), but it is passed
  to `safety_fc_flight_mode()` only in the `betaflight` profile.
- **`config.c`:** parses and validates `fc_profile`. In `aquila20`, `ch_failsafe` is ignored and
  validation refuses any stick or switch channel set to CH7, so CH7 always carries the default
  1000 µs (sensitivity S).

### 3.3 Why disarm-over-the-link is safe here

- **The drone cannot land itself.** Stopping the motors is the only failsafe either way, the same as
  the Betaflight "DROP" procedure the original setup chose.
- **Keeping the link up keeps the evidence.** Battery, link quality and mode keep reaching the
  page and the logs during a failsafe.
- **If the Pi or crsf-core dies,** the module stops transmitting and the drone's own link-loss
  failsafe stops the motors (measured: at once).
- **Re-arming needs two separate actions:** clearing the failsafe in the core, then a new arm.
  The drone itself also refuses to arm on link return with CH5 high.

### 3.4 Pilot page

- The mode buttons become **"N · Posición"** (CH6 low, the default), **"S · Estable"** (mid) and
  **"M · Manual"** (high).
- The flight-mode telemetry is shown in Spanish: `X-NORMAL` → "N (mantener posición)",
  `X-SPORT` → "S (estable)", `X-MANUAL` → "M (manual)". Unknown text is shown as it is.
- **Amended 2026-10-09:** the team found the drone's own names easier. The buttons and the
  telemetry line now read **"Normal"**, **"Sport"** and **"Manual"** (same CH6 values).
- The gateway and both protocols are unchanged.

## 4. Verification

- **C unit tests:**
  - `aquila20`: FAILSAFE gives CH5 low and CH7 low; ack is never refused for FC-armed;
    flight-mode text is ignored for arming.
  - `betaflight`: every existing test passes unchanged.
- **Integration tests** (fake TX on a pty):
  - The default profile is `aquila20`, so failsafe expectations move from "CH7 high" to "CH5 low".
  - One test runs `fc_profile = betaflight` to keep CH7 FAILSAFE covered end to end.
- **Browser test:** the page loses focus → **CH5 low within 1 s**.
- **C3 evidence:**
  - Run `failsafe_report.py --no-fc`. The Aquila20 has no failsafe telemetry, so the result is "core only".
  - Each run is backed by the logged FAILSAFE time, ARM low in the next frame, and the link still up
    (which proves the disarm was delivered).
  - A phone video of the motors stopping covers at least 3 of the 10 runs per link.
- **Bench (M3 Task 8, adapted):** with propellers off, confirm with crsf-core what the spike measured:
  arm, mode switch, failsafe disarm, and no re-arm on link return.

## 5. Documentation changes

- **Main spec:**
  - D4 becomes "Aquila20 (BetaFPV firmware); Betaflight kept as a profile".
  - §4.4 channel table per profile.
  - §5.3 FAILSAFE output per profile.
  - §7.1 FMEA rows: failsafe = drop; armed state not reported; CH7 = sensitivity.
- **New `docs/setup/aquila20.md`:** the measurements in §2, how to bind (bind mode, see
  `module.md` §4), and what not to change in the BETAFPV Configurator.
  It replaces `betaflight.md` for this drone; `betaflight.md` stays for the `betaflight` profile.
- **`docs/procedures/m3-bench-test.md` and `m4-pilot-checklist.md`:** rows that mention
  Betaflight become Aquila20 checks.
- **`docs/procedures/c3-failsafe.md`** (written in M5 Task 4): `--no-fc` and the video evidence.

## 6. Plan

A new plan, **M8 "Aquila20 profile"**, implemented before M3 Task 8:
1. config `fc_profile` (+ shipped config);
2. chmap per profile;
3. rtloop: flight mode is fed to safety only in `betaflight`;
4. integration tests (default `aquila20`, one `betaflight`);
5. pilot page (mode labels, mode text) and browser test;
6. docs (spec amendments, `aquila20.md`, procedures).

## 7. Open items

- **Arming with throttle up:** the Aquila20 was not tested for whether it refuses to arm with
  throttle above minimum. crsf-core already refuses that (`throttle_arm_max`), so this is not blocking.
- **Bench time for the failsafe:** the time from link loss to motors stopping was "at once" by
  eye. C3 measures our side, and video covers the drone side.
- **The BETAFPV Configurator** may expose failsafe or arming options. It has not been tried yet
  (it runs on a PC; the Betaflight app does not work with this board). Record its relevant
  values in `aquila20.md` when a teammate connects it.
