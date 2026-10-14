# Flight tests, 2026-10-09 (evening): first flights with the web controller

The first real flights of the Aquila20 with the web ground control station. The page was
reached through a Cloudflare quick tunnel (no login, see `docs/HANDOFF.md` §6). The drone
reported `S-NORMAL` the whole evening: Normal mode (position hold), sensitivity S.

Times are local (CST, UTC−6). The log lines come from `journalctl -u crsf-core`.

## 1. What the pilot saw

1. **Prueba mode (5 % steps), over the tunnel, in Normal mode:** not smooth.
2. **Táctil (touch) mode:** smoother than Prueba, but not as smooth as the drone's own
   physical controller.
3. **Normal mode with the physical controller:** the drone never hits the ground. It stays a
   few centimetres up until the throttle is held at minimum for a few seconds, then it lands.
4. **Normal mode with the web controller:** after the pilot let go of the throttle, the drone
   came down to the ground, **with the motors still running**. The pilot had not pressed
   Desarmar. The physical controller's throttle stick does not spring back either, so on that
   point the touch throttle behaves the same.

## 2. What the core's log shows

| Time | Event | Meaning |
|------|-------|---------|
| 19:39 | `flight_mode S-NORMAL` | the drone was in Normal mode; no change was reported after this |
| 20:05–20:11 | 8 arms; 7 ended ARMED → DISARMED, `reason: none` | ended by Desarmar/Space on the page (the only path to that transition) |
| 20:07:49 | ARMED → FAILSAFE, `cmd_timeout`, `cmd_age_ms: 303` | the 8th, **in flight**, 20 s after arming (20:07:29): no command from the page for more than 300 ms, so the motors were stopped |
| 20:43:48 | `serial ok`, then `device BFPV 2G4Micro1W` | the TX module reconnected over USB |
| 20:44:30, 20:45:51, 20:46:07 | DISARMED → ARMED → FAILSAFE `rf_lost` **in the same instant** | arming while the radio link to the drone was not back up yet (no link report with LQ > 0 in the last second). On the ground. |
| 20:47:24–27 | a 3 s arm, ended with Desarmar | |
| 20:48–20:49 | 2 flights ending with Desarmar | |

- The ground contact in §1 item 4 was **not** a failsafe: a failsafe stops the motors, and they
  were running. The drone was armed and following the stick values it received.
- The log does not record stick values, so it cannot show the throttle at that moment.
- It is not known whether the 20:07:49 failsafe was the page releasing control (focus loss,
  rotation, layout change, screen lock) or the tunnel delaying commands.

## 3. Why the web controller feels less smooth (analysis, not yet measured)

It was never meant to copy the physical controller. It sends the same channels: CH1–4 sticks,
CH5 arm, CH6 flight mode. The difference is how the values are produced:

| | Physical controller | Web controller |
|---|---|---|
| Sticks | analog gimbals, continuous, about 0.1 % resolution | touch pads about 140 px wide on a phone (about **1.4 % per pixel**), on/off keys, or 5 % steps |
| Update rate | read at the packet rate (250 Hz or more) | **50 Hz** from the page (`web/js/app.js`); the core repeats each value about 5 times at 250 Hz, a staircase of 20 ms steps |
| Path | radio only | browser → Wi-Fi/internet (tunnel) → Pi → TX module → radio: delay and uneven timing; the core keeps only the newest command |
| Sensitivity CH7 | a switch (S / M / F) | fixed at S (Aquila20 profile) |
| Expo | usually on the radio | none |

**Prueba mode specifically** (`web/js/ramp.js`, shared with the keyboard mode):
- Values ramp **away from neutral** at 20 %/s, so +5 % takes 250 ms.
- They **jump towards neutral at once**. This is a safety rule: a command can always be cut instantly.
- In Normal mode the sticks ask for a speed, so every press back towards centre is an abrupt
  brake. Prueba was built for bench values, not for flying.

## 4. Why the drone came down (two hypotheses, to be tested)

1. **The throttle was left close to the bottom.** Flight controllers usually treat a band near
   the bottom as "minimum". With about 1.4 % per pixel, the touch throttle can easily be left
   there. The drone then lands itself and idles on the ground until disarmed, which matches
   what was seen.
2. **In Normal mode the throttle sets the climb rate.** With height hold, the stick centre
   usually means "hold this height" and anything below it means "descend". Then a throttle
   left below centre descends all the way. Where the Aquila20 hovers has never been measured.

## 5. Open items and proposals (none implemented)

| # | Item | Kind |
|---|------|------|
| 1 | **Refuse to arm while there is no radio link with the drone** (new refusal, e.g. `rf_down`, with a clear message), instead of arming and failing safe at once as at 20:44–20:46 | fix, safe to make |
| 2 | **Log stick values** in the core's event log during flight (for example every 100 ms), so the next flight shows the throttle at each moment. Also useful for C1/C3. | tooling |
| 3 | **Prueba: ramp both ways** for pitch, roll and yaw. NEUTRO, Space and F stay instant. **Open question:** should the throttle also come down gradually? | team decision |
| 4 | **A failsafe that lands in Normal mode:** sticks centred, throttle at minimum, ARM kept high for a few seconds while the drone lands itself, then disarm. Softer than today's instant disarm (approach A), but the motors run for those seconds after the core has lost the page. | safety decision for the team (changes spec §5.3 / Aquila20 spec §3) |
| 5 | **Command timeout (P1, 300 ms)** over the internet: the 20:07:49 failsafe may have been a tunnel delay. A longer timeout cuts fewer flights short but reacts more slowly. | team decision (P1 still unconfirmed) |
| 6 | Smoother input: send faster (100–125 Hz), or blend in the core (+about 20 ms delay); expo and a small deadband on the touch sticks; **gamepad support** (Gamepad API: real analog sticks) | features |
| 7 | Let the pilot choose sensitivity CH7 (S / M / F), as the physical controller can | team decision (the Aquila20 spec fixed it at S) |

## 6. Next flight test

Propellers on only in a safe, open space, with the physical controller at hand.

1. **On the local Wi-Fi first** (`https://<pi address>:8443`), then through the tunnel, the same
   manoeuvres: this separates the tunnel's effect from the page's.
2. **In Normal mode, touch mode, read "Acel. … %" under the left pad:**
   - the throttle % at which the drone hovers, climbs and descends;
   - the % when the throttle is let go;
   - how long at what % before it lands itself.
3. **If a FAILSAFE banner appears,** note its reason text.
4. **To land, hold the throttle at the bottom** until the drone lands itself. Disarm only on the
   ground: Desarmar and every failsafe stop the motors at any height.
